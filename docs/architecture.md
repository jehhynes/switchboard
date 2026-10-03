# Switchboard architecture

Requirements live in [prd.md](prd.md). This document describes components, state and protocols. Nothing is implemented yet.

Session and triage mechanics come from Ground Control (`D:\git\ground-control`), where they are verified. M IDs below refer to its [mechanics.md](../../ground-control/docs/mechanics.md). Re-verify them in Switchboard's own mechanics.md before relying on a version-fragile one.

## Packages

npm workspaces, TypeScript strict, Node ≥ 20, Vitest, esbuild and vsce, following Ground Control's layout. Only `extensions/switchboard` imports `vscode`.

| Package | Contents | Depends on |
|---|---|---|
| `packages/core` | Domain types, source and runner interfaces, store, playbook loader and renderer, flow rules | — |
| `packages/claude` | Claude Code runner and classifier | core |
| `packages/github` | GitHub source: assigned state, triage context | core |
| `packages/zoho` | Zoho Desk source | core |
| `packages/forum` | Forum source over the forum database | core |
| `packages/hub` | Polling scheduler, flow execution, loopback HTTP/SSE server, report endpoint | core, sources, claude |
| `apps/hub` | Hub entry point and the `switchboard report` CLI, bundled as one file | hub |
| `extensions/switchboard` | Hub process lifecycle, panel webview, attach, open in Claude Code tab | hub protocol types from core |

The ad-hoc source is local and lives in `packages/hub`. State, playbooks and the hub bundle live in the Switchboard home, `~/.switchboard`.

## Components

| Component | Responsibility |
|---|---|
| Hub | Separate Node process that runs the core: polls sources, creates work items, runs triage, starts setup and task sessions, enforces one active session per work item, serves the panel and the report command. |
| Source plugins | Supply tickets, decide whether each is in the assigned state, and build each ticket's triage context: GitHub, Zoho Desk, Forum, ad-hoc. |
| Playbook loader | Reads playbook files and renders their templates. |
| Classifier | Runs one-shot triage and returns structured output. |
| Runner | Starts, stops and tracks agent sessions for one provider. Claude Code first. |
| Worktree linker | Links worktrees to tickets from session reports, falling back to branch-name convention. |
| Store | Local SQLite database holding tickets, work items, triage results, sessions and worktrees. |
| VS Code extension | Starts the hub, hosts the panel webview, attaches consoles, opens sessions in Claude Code tabs. |

## Data model

```
Ticket     id, source, sourceKey, title, url, assigned, lastSeenState, lastPolledAt
WorkItem   id, ticketId, playbook, status, stage, taskPrompt, warning, createdAt, doneAt, doneReason
Triage     workItemId, context, playbook, summary, model, startedAt, endedAt, error
Worktree   id, ticketId, repo, path, branch, linkedBy (report | convention)
Session    id, workItemId, kind (setup | task), provider, nativeSessionId, cwd, status, startedAt, endedAt
```

- `Triage.context` is the clipped text the classifier received. Keeping it shows why a playbook was chosen.
- `WorkItem.taskPrompt` is the rendered prompt the task session ran, or the typed prompt for an ad-hoc work item.
- `WorkItem.doneReason` is `session`, `operator` or `unassigned`.
- `WorkItem.warning` is set when the ticket leaves the assigned state before the session reports done.
- A session's `cwd` is the ticket's worktree when one exists, otherwise the source's repo root.

## Store

- One SQLite database, `~/.switchboard/switchboard.db`, opened through Node's built-in `node:sqlite` (M1). No native module, so VS Code's Electron upgrades do not require rebuilds.
- The hub is the only process that opens the database. The extension and the `switchboard report` CLI go through the hub's HTTP server, so there is no cross-process locking.
- WAL mode; one write transaction per flow step, so a crash leaves each work item in its last committed state.
- Core accesses the database only through a store interface, which isolates changes to the `node:sqlite` API. Tests use `:memory:`.
- Schema changes are numbered migrations applied by the hub at startup, recorded in `PRAGMA user_version`.
- Not in the database: playbooks and settings, which are files the operator edits and can keep in git, and session transcripts, which Claude Code stores. Sessions keep `nativeSessionId` to find them.

## Playbooks

A playbook is a Markdown file whose body is the prompt template and whose front matter holds its settings. `support:defect` lives at `playbooks/support/defect.md` under the Switchboard home. Switchboard has no built-in namespaces or playbooks; the playbook directory defines them.

```markdown
---
description: Zoho ticket reporting behavior that may be a defect
autoStart: false
requiresWorktree: false
---
Research Zoho ticket {{ticket.sourceKey}}.
{{triage.summary}}
Report progress with `switchboard report stage {{session.id}} <stage>`.
```

- Template variables: the ticket's fields, `{{ticket.context}}`, `{{triage.summary}}` and `{{session.id}}`.
- `description` tells the classifier when to choose the playbook.
- A source's triage playbook is a playbook whose body is the classifier's system prompt.

## Triage

Triage follows Ground Control's classifier (GC R38, M31).

1. The source plugin builds the triage context: it fetches the ticket's text, clips each field at a word boundary to a size limit, and formats it with authors, status changes and assignees. Ground Control clips the issue body and each comment to 2,000 characters.
2. The classifier runs `claude -p --output-format json --json-schema <schema> --no-session-persistence --setting-sources "" --tools "" --strict-mcp-config --system-prompt <triage playbook + playbook descriptions>`, with the context on stdin. Stdin avoids the Windows 32,767-character command-line limit (M31).
3. The schema is `{playbook: enum of loaded playbook names, summary: string}`. The classifier reads `structured_output`.

Triage has no tools, settings, MCP servers or saved transcript, so it is not a session and does not count toward the one-active-session rule. The hub runs at most one triage per work item at a time.

## Flow

1. Poll a source. For each ticket, compare its assigned state with `lastSeenState`.
2. When a ticket enters the assigned state, create a work item and run triage.
3. Store the triage result. If the playbook's `autoStart` is false, wait for operator approval.
4. If the playbook's `requiresWorktree` is true and the ticket has none, start a setup session.
5. Render the playbook and start the task session. It reports stages, a worktree link if it creates one, and done.
6. When a ticket leaves the assigned state, mark its work item done with reason `unassigned`, and set a warning if the session had not reported done.

An ad-hoc prompt creates a ticket and work item and goes straight to step 4 with the typed prompt as the task prompt.

Steps 4 and 5 start a session only when no session for the work item is running.

## Claude Code runner

- Start: `claude --bg --permission-mode <mode> -n <name> <prompt>`. Claude's background service owns the process, so sessions survive VS Code and the hub. `--bg` ignores `--session-id`; the runner matches the printed short ID against `claude agents --json` (M1, M33).
- Background sessions inherit the service's environment, not the caller's, so per-run values such as the Switchboard session ID travel in the prompt (M33).
- State: poll `claude agents --json` for status, and read hook markers for running, waiting, idle and failed (M2, M20).
- Stop: `claude stop <id>`. Never `claude rm`, which can delete the worktree.
- Attach: a VS Code terminal running `claude attach <id>`. Leaving it keeps the session running (M33, M45).
- Open in VS Code: `claude-vscode.primaryEditor.open(sessionId)`. Focus an open tab first; resume only after confirming the session is not running in the background (M5–M7, M21, M22, M33).

## Session reports

Sessions report through a CLI command bundled with the hub, which posts to the hub's loopback HTTP server. The prompt carries the Switchboard session ID.

```
switchboard report stage <sessionId> <stage>
switchboard report worktree <sessionId> <path>
switchboard report done <sessionId> [--summary <text>]
```

The hub checks a reported worktree path against `git worktree list` before linking it.

## Settings

Per source: `enabled`, `pollIntervalSeconds`, `repoRoot`, `triagePlaybook`, `setupPlaybook` (the prompt a setup session runs, such as `/init-worktree {{ticket.sourceKey}}`), plus plugin-specific settings such as clip limits, the GitHub assigned-state rule and the Forum database connection.

Per playbook: `description`, `autoStart` and `requiresWorktree`, in the playbook file's front matter.

Triage: `model`.
