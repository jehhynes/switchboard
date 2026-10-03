# Switchboard architecture

Requirements live in [prd.md](prd.md). This document describes components, state and protocols. Implemented: the hub lifecycle, the core's store, settings, playbooks and [flow decisions](#core-decisions), the GitHub source, the Claude Code runner and classifier, the hub runtime, the report command, the panel with the ad-hoc prompt box, the Zoho Desk and Forum sources, and the pool with pick sessions.

Session and triage mechanics come from Ground Control (`D:\git\ground-control`), where they are verified. M IDs below refer to its [mechanics.md](../../ground-control/docs/mechanics.md). Re-verify them in Switchboard's own mechanics.md before relying on a version-fragile one.

## Packages

npm workspaces, TypeScript strict, Node ≥ 22.13, Vitest, esbuild and vsce, following Ground Control's layout. Only `extensions/switchboard` imports `vscode`. Implemented so far: `packages/core`, `packages/github`, `packages/zoho`, `packages/forum`, `packages/claude`, `packages/hub`, `apps/hub`, and `extensions/switchboard`.

| Package | Contents | Depends on |
|---|---|---|
| `packages/core` | Domain types, source and runner interfaces, store, playbook loader and renderer, flow rules | — |
| `packages/claude` | Claude Code runner and classifier | core |
| `packages/github` | GitHub source: assigned state, triage context | core |
| `packages/zoho` | Zoho Desk source | core |
| `packages/forum` | Forum source over the forum database | core |
| `packages/hub` | Polling scheduler, flow execution, loopback HTTP/SSE server, report endpoint | core, sources, claude |
| `apps/hub` | Hub entry point and the `switchboard report` CLI, bundled as one file | hub |
| `extensions/switchboard` | Hub process lifecycle, panel webview, attach, open in Claude Code tab | core, hub client |

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
Ticket     id, source, sourceKey, sourceId, title, url, assigned, pool, iceboxed, sortAt, lastPolledAt, repoRoot
WorkItem   id, ticketId, playbook, status, stage, stageAt, taskPrompt, warning, error, failedStep, unassignedAt, queuedAt, needsPick, createdAt, doneAt, doneReason, approvalPrompt, approvalSummary
Triage     id, ticketId, workItemId, context, playbook, summary, immediacy, severity, model, startedAt, endedAt, error
Worktree   id, ticketId, path, branch, linkedBy (report | convention)
Link       id, ticketId, label, target, reportedAt
Session    id, workItemId, kind (pick | setup | task), provider, nativeSessionId, shortId, cwd, state, stateAt, stateDetail, outcome, outcomeDetail, startedAt, endedAt, released
```

- `Ticket.assigned` is the assigned state the last complete poll saw, and `Ticket.pool` whether it saw the ticket in the pool. `Ticket.sortAt` is the source's sort time, which orders the pool: Zoho's `customerResponseTime`, Forum's last public post. A pool triage has a `ticketId` and no `workItemId` until a pick creates the work item and attaches it. `Ticket.repoRoot` is the repo an ad-hoc prompt chose; it is empty for other sources, which use their `repoRoot` setting.
- `Ticket.sourceKey` is the key people use, such as a GitHub issue number or a Zoho ticket number. `Ticket.sourceId` is the source's internal ID when API calls need a different one, such as Zoho's internal ticket ID.
- `Triage.context` is the clipped text the classifier received. Keeping it shows why a playbook was chosen.
- `WorkItem.status` takes the values in PRD R34. `WorkItem.error` holds the cause shown for `failed` or `blocked`, and `WorkItem.failedStep` (`triage`, `pick`, `setup` or `task`) is the step Retry repeats (PRD R45).
- `WorkItem.unassignedAt` records that the ticket left the assigned state while a session was active (PRD R10). `WorkItem.queuedAt` orders queued starts. `WorkItem.needsPick` marks a picked work item whose claim has not succeeded: its next session is a pick session.
- `WorkItem.taskPrompt` is the rendered prompt the task session ran, or the typed prompt for an ad-hoc work item.
- `WorkItem.doneReason` is `session`, `operator` or `unassigned`.
- `WorkItem.warning` is set when the work item ends because its ticket left the assigned state with no done report (PRD R10, R11).
- `Session.state` is the observed state, `Session.stateDetail` the error kind of a `failed` turn, and `Session.outcome` the reported or decided outcome (PRD R36). `Session.released` records that the release stop was sent, so it is sent once (PRD R39).
- A session's `cwd` follows its playbook's `workdir`: the ticket's worktree when one exists, otherwise the source's repo root.

## Hub lifecycle

Implemented. Follows Ground Control's hub (GC R35, M25).

- **Start:** extension activation copies `dist/hub.js` to `~/.switchboard/hub.js` when it differs. It accepts a running hub only when the hub's `build`, a hash of its bundle, matches the bundle installed at that moment. It asks a hub of another build to stop and starts a new one only after the old one has gone; if the old hub refuses, the window reports it. Otherwise it starts one detached with VS Code's executable and `ELECTRON_RUN_AS_NODE=1`, with `ELECTRON_*`, `VSCODE_*` and `NODE_OPTIONS` removed from its environment. Output goes to `~/.switchboard/hub.log`.
- **Record:** the hub listens on `127.0.0.1` on an ephemeral port and writes `~/.switchboard/hub.json` with `protocol`, `version`, `build`, `port`, `token`, `pid` and `startedAt`. The hub holds a lock for its lifetime: a named pipe `\\.\pipe\switchboard-<hash of home>` on Windows, `~/.switchboard/hub.sock` elsewhere. Only the lock holder writes or removes the record, so concurrent starts leave one hub, and the OS releases the pipe when the hub dies. A hub that cannot take the lock waits up to 5 seconds for the holder's record and otherwise exits. A forced exit on Windows leaves the record behind, so clients accept it only when `GET /status` with the token returns the recorded pid.
- **Endpoints:** `GET /hub` returns identity without a token. `GET /status`, `GET /events`, `POST /shutdown`, `POST /report`, `POST /action`, `POST /open` and `POST /claim` require `Authorization: Bearer <token>`. `/events` sends a `state` event with the whole panel snapshot when it opens and after every change. `/action` takes an operator event (`adhoc`, `approve`, `retry`, `mark-done`, `retriage`, `change-playbook`, `stop`) and answers 409 with the core's refusal.
- **Clients:** each window holds one `/events` stream. The hub exits 30 minutes after its last stream closes, but not while any session is active (PRD R43). A stream that sends no response headers within 5 seconds counts as refused. When a stream ends, the window finds or starts a hub and reconnects. It gives up and shows an error after three consecutive failures; a connection that lasts under 10 seconds counts as a failure.
- **Entry point:** `hub.js [--home=<dir>] [--idle-ms=<ms>]` serves; `hub.js --stop` stops the running hub; `hub.js report …` sends a session report.
- **Runtime:** the hub opens the store, loads settings and playbooks and reloads them on change, polls each enabled source every `pollIntervalSeconds`, then reads `git worktree list` in its repo root for the branch convention. While any session has started, it reads the roster every 30 seconds and hook markers every 5 seconds. Before a roster read or a release stop can end a setup session, it reads the convention again, so an unreported worktree still counts.
- **Startup:** the hub installs hooks when `sessions.installHooks` is on, runs again any triage it abandoned, fails any session still `starting` with "The hub stopped while the session was starting.", and reads the roster (PRD R43).
- **Home override:** when `SWITCHBOARD_HOME` is set in VS Code's environment, the extension passes it to the hub as `--home`. Both the variable and `--home` name the directory that holds `.switchboard`, in place of the user home, so the Switchboard home is `<override>/.switchboard`. It does not change the user profile that Claude and `gh` see. Live acceptance depends on it.

## Panel

- The extension contributes a **Switchboard** view container in the activity bar with one webview view, **Work items**. The webview renders each `state` event the window's `/events` stream delivers; it keeps the rows the operator expanded and a half-typed ad-hoc prompt across redraws.
- Groups and controls follow PRD R27. Controls run the extension's `switchboard.action`, `switchboard.attach` and `switchboard.open` commands. An operator event goes to `POST /action`, and a refusal shows as a warning. Attach and Stop apply to a session running in the background; Attach opens a terminal running `claude attach <shortId>`. Open in VS Code applies to a session that is not running, or that was released and is active again because the operator resumed it. It follows [Open in VS Code](#claude-code-runner) below. A ticket link opens in the browser.
- Each row shows the ticket, title, playbook, status, stage and its age, the worktree's branch, and any warning or error; a done work item with an active session shows the session's state.
- The ad-hoc box takes a prompt and a repo from the configured repo roots, the first by default, and sends `adhoc`.
- The Pool group lists pool tickets with no open work item, oldest first: source and key, title, the pool triage's summary and playbook, and Pick (`pick`). A failed pool triage shows its error with Triage again (`retriage-pool`) beside Pick; a running one shows "Triaging…". A picked work item shows the status "Claiming" while its pick session runs.
- Endpoint additions for the pool: `/action` also takes `pick` and `retriage-pool` with a `ticketId`.
- Styles use VS Code's theme variables and codicons from `@vscode/codicons`, copied into `dist/`. The script runs under a nonce content security policy.

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
permissionMode: auto
---
Research Zoho ticket {{ticket.sourceKey}}.
{{triage.summary}}
Report progress with `{{report}} stage {{session.id}} <stage>`.
```

- Template variables: `{{ticket.source}}`, `{{ticket.sourceKey}}`, `{{ticket.title}}`, `{{ticket.url}}`, `{{ticket.context}}`, `{{triage.summary}}`, `{{session.id}}` and `{{report}}`. `{{report}}` is the report command prefix, `node "<home>/hub.js" report`. Rendering fails on an unknown variable.
- Front matter: `description` (required), `autoStart` (default false), `requiresWorktree` (default false), `permissionMode` and `model` (defaults from `sessions` settings), `kind` (`task` by default, or `triage`), and `workdir` (`worktree` by default: the ticket's worktree when one exists, otherwise the repo root; or `repoRoot`: always the source's repo root, for playbooks whose skills belong to that repository).
- `description` tells the classifier when to choose the playbook. Adding a playbook is adding its file: the hub reloads it, and the classifier sees its description. Edit the triage playbook only for a rule that must take precedence over the descriptions.
- A source's triage playbook has `kind: triage`. Its body is the classifier's system prompt. Triage playbooks are never offered to the classifier as choices.
- Each source's `namespace` setting limits the classifier's choices to that namespace's task playbooks, such as `dev` for GitHub and `support` for Zoho Desk and Forum. With one playbook in the namespace, triage still writes the summary.
- Every session prompt ends with the report contract: the session ID and the `stage`, `worktree`, `done`, `blocked`, `approval` and `link` commands, and three rules. It reports a `link` for each GitHub issue or pull request it creates or finds for the work, and for a case file such as Support's `case.md`. When the session needs the operator for a question or a choice, it reports `blocked` with the question and ends its turn instead of waiting, so it does not hold a session slot. When its work is ready but posting or publishing it needs the operator's approval, it reports `approval` with the prompt that would do it, such as `/review-pr pr:123 publish`, and ends its turn. Skills written for Ground Control do not know Switchboard. `{{report}}` lets a template add its own report calls.

## Triage

Triage follows Ground Control's classifier (GC R38, M31).

1. The source plugin builds the triage context: it fetches the ticket's text, clips each field at a word boundary to a size limit, and formats it with authors, status changes and assignees. Ground Control clips the issue body and each comment to 2,000 characters.
2. The classifier runs `claude -p --output-format json --json-schema <schema> --no-session-persistence --setting-sources "" --tools "" --strict-mcp-config --system-prompt <triage playbook + playbook descriptions>`, with the context on stdin. Stdin avoids the Windows 32,767-character command-line limit (M31).
3. The schema is `{playbook: enum of the source namespace's task playbook names, summary: string, immediacy?: URGENT | BLOCKING | NON-BLOCKING, severity?: HIGH | MED | LOW}` (PRD R50). The classifier reads `structured_output`.

Triage has no tools, settings, MCP servers or saved transcript, so it is not a session and does not count toward the one-active-session rule. The hub runs at most one triage per work item at a time, at most `triage.concurrency` at once (default 2), with a `triage.timeoutSeconds` limit (default 180).

A classifier error, an unparsable result, a timeout, or a playbook name outside the enum fails the work item with that error (PRD R37). A triage interrupted by a hub shutdown is not a failure: the work item stays `triaging`, and triage runs again when the hub starts.

## Flow

1. Poll a source. For each ticket, compare its assigned state with `Ticket.assigned`. A poll that fails or is incomplete, such as one that hits the page limit, updates nothing.
2. When a ticket enters the assigned state, create a work item (`triaging`) and run triage.
3. Store the triage result. If the playbook's `autoStart` is false, the work item is `awaiting-approval`.
4. If the playbook's `requiresWorktree` is true and the ticket has none, start a setup session (`setup`) running the source's `setupPrompt`. The setup session succeeds when a worktree is linked, by report or by the branch convention, and the session reports done or ends. If it ends with no worktree linked, the work item fails with "Setup ended without a worktree."
5. Render the playbook and start the task session (`running`). It reports stages, a worktree link if it creates one, and done or blocked.
6. When the task session reports done, the work item is done with reason `session`. When it reports blocked, or its turn ends with no report, the work item is `blocked`. A turn that ends `failed` blocks it with the error kind, because the session can still be resumed.
7. When a ticket leaves the assigned state with no active session, its work item is done with reason `unassigned` and a warning. With an active session, that is deferred until the session reports or ends (PRD R10).

Pool tickets (PRD R47, R48):

- When a poll shows a ticket newly in the pool, the core starts a pool triage for the ticket; its result or error stays on the ticket.
- A pick creates the work item, attaches the pool triage, and starts a `pick` session (status `setup`) running the source's `pickPrompt` in its repo root, under the concurrency limit. When the pick session reports done, the task session starts as an operator start, skipping the approval in step 3; with no pool triage result, the existing work item is triaged first (`triaging`). When it reports blocked or ends without done, the work item is `blocked`.
- A ticket that enters the assigned state while it has an open work item gets no second work item; the claim made by the pick session is seen this way.

An ad-hoc prompt creates a ticket and work item and goes straight to step 5, with the typed prompt as the task prompt and the chosen repo root as the working directory (PRD R6).

Steps 4 and 5 start a session only when no session for the ticket is active and a slot is free; otherwise the work item is `queued` (PRD R38).

## Core decisions

`packages/core` decides; the hub acts. `handle(store, event, context)` runs inside one store transaction, applies one event, and returns the actions for the hub to run, or a refusal for an operator action or report that does not apply. The context carries the clock, settings, loaded playbooks, the report command prefix and a session ID generator. The hub runs each action and sends its result back as an event, so every failure reaches the work item.

| Events | From |
|---|---|
| `poll`, `poll-failed` | A source read. `poll` lists the source's tickets from a complete read; a ticket missing from it has left the assigned state. `poll-failed` changes nothing. |
| `triage-succeeded`, `triage-failed`, `triage-cancelled` | The classifier. A cancelled triage runs again. |
| `session-started`, `session-start-failed` | The runner's `start-session`. |
| `roster`, `marker` | A successful roster read, with each listed session's state; a hook marker for a live session. |
| `report` | The report command: `stage`, `worktree`, `done`, `blocked` or `approval`. |
| `stop-succeeded`, `stop-failed` | The runner's `stop-session`, for an operator stop or a release. |
| `worktree-found` | The branch convention. It links a worktree only to a ticket that has none. |
| `adhoc`, `approve`, `retry`, `mark-done`, `retriage`, `change-playbook`, `stop`, `pick`, `retriage-pool`, `icebox`, `restore`, `tick` | The panel; `tick` re-runs scheduling after settings or playbooks change. |

Actions are `triage`, `start-session` and `stop-session`. After every event the core starts triage for `triaging` work items, then pool triage for pool tickets without a result, up to `triage.concurrency` in all; then it starts `queued` work items in queue order while fewer than `sessions.concurrency` sessions are active, skipping a ticket that already has an active session. A task that follows a setup session starts when the setup session ends, without waiting for a slot.

## Claude Code runner

- Start: `claude --bg --permission-mode <mode> --settings '{"worktree":{"bgIsolation":"none"}}' -n <name> [--model <model>] <prompt>`, with no shell, so a leading slash command survives. The name is `switchboard · <playbook> · <source> <key>`. Claude's background service owns the process, so sessions survive VS Code and the hub. `--bg` ignores `--session-id`; the runner parses the short ID from `backgrounded · <id> · <name>` and matches it as a prefix against `claude agents --json` (GC M1, M33; mechanics M5). The start is confirmed when the roster lists it with a pid; a new entry has no pid for its first seconds. A session not listed with a pid within 60 seconds fails the start.
- Permission mode: `auto` by default. In 101 Ground Control runs to 2026-10-03, the 95 in `auto` never waited for or were refused a permission; the only permission stall was in manual mode. Questions (`AskUserQuestion`) stall in every mode and show as `waiting`. The operator answers them, so Switchboard neither disallows the tool nor keeps a Bash allowlist.
- Environment: pass `CLAUDE_CONFIG_DIR` through exactly as the hub inherited it, and never set it. Setting it, even to `~/.claude`, moves where Claude reads folder trust (GC M62). Strip `ELECTRON_*`, `VSCODE_*` and `NODE_OPTIONS`.
- Trust: `--bg` exits 1 with `Workspace not trusted` in a directory Claude has not trusted; a linked worktree inherits its main checkout's trust (GC M62). The failed start shows that message (PRD R41).
- Background sessions inherit the service's environment, not the caller's, so per-run values such as the Switchboard session ID travel in the prompt (M33).
- Liveness: poll `claude agents --json` (without `--all`) every 30 seconds for every session a start confirmed, so a session resumed after its release is seen again. The roster alone decides liveness: a session is active while the last successful roster read lists it with a pid, and `ended` once a successful read does not. An entry without a pid is a process that is gone (GC M33). A failed read changes no session. Hook markers only set the state of a live session, because a killed process leaves its last marker behind (GC M20). The roster `state` is the fallback when no hook marker exists: `working` maps to `running`, `blocked` to `waiting`, and `done` or `stopped` to `idle`.
- State: hook markers decide the observed state, following GC's mapping (GC M2, M20):
  - `UserPromptSubmit`, `PostToolBatch` and `PermissionDenied` mean `running`, as does `SessionStart` with `source=compact`.
  - `PermissionRequest`, `Elicitation`, `PreToolUse` for `AskUserQuestion` or `ExitPlanMode`, and `Notification` of type `permission_prompt`, `worker_permission_prompt` or `agent_needs_input` mean `waiting`.
  - `Stop` means `idle`, or `running` while background tasks remain.
  - `StopFailure` means `failed`, with its error kind and message.
- Hooks:
  - The hub installs async command hooks for those events plus `SessionEnd` in `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`. It preserves other entries, refuses to edit malformed JSON, and adds missing entries at startup. The `sessions.installHooks` setting is on by default; when it is off, the roster alone decides state.
  - The hook runs `node "<home>/hook.mjs"`. It skips subagent events, always exits 0 and prints nothing, and writes `<home>/activity/<nativeSessionId>.json` atomically: `{v, sessionId, event, at, notificationType, source, toolName, backgroundTasks, error, errorMessage}`, with `errorMessage` capped at 500 characters. `SessionEnd` deletes the marker.
  - Ground Control's hooks stay separate; the two do not share markers.
- Release: after a done or blocked report, or an `idle` or `failed` turn, run `claude stop <id>` once when the session is no longer `running` (PRD R39). A session whose background process has ended, by release, stop, failed start or leaving the roster, is never released again, and neither is a session the roster lists as interactive, so a session the operator resumed in a VS Code tab is never stopped by Switchboard. Before a release stop, the hub also reads the roster and skips the stop unless the session is listed as a background process. An interactive roster entry, such as a VS Code tab, has no `state`; its `status` (`idle`, `busy` or `waiting`) gives `idle`, `running` or `waiting`.
- Stop: `claude stop <id>`, 15-second timeout. A failed stop leaves the session stoppable. Never `claude rm`, which can delete the worktree.
- Attach: a VS Code terminal running `claude attach <id>`. Leaving it keeps the session running (M33, M45).
- Open in VS Code: `claude-vscode.primaryEditor.open(<native session ID>)`, which resumes the session or focuses its tab. Claude's tab lists only the sessions of its window's first folder, and opening another session there starts an empty one (GC M6, M7, M52). So when the session's directory is the window's first folder, the window opens it directly. Otherwise the window posts `{sessionId, cwd}` to the hub's `POST /open` and opens that folder with `vscode.openFolder` and `forceNewWindow`, which focuses a window already on it. A window claims a pending open for its folder with `POST /claim` when it connects to the hub and whenever it gains focus, and opens it. A pending open expires after 2 minutes and lives only in the hub's memory.

## Session reports

Sessions report through the hub bundle, which posts to the hub's loopback HTTP server. The prompt carries the Switchboard session ID and the bundle's absolute path, because a background session has no Switchboard environment and `switchboard` is not on PATH.

```
node "<home>/hub.js" report stage <sessionId> <stage>
node "<home>/hub.js" report worktree <sessionId> <path>
node "<home>/hub.js" report done <sessionId> [--summary <text>]
node "<home>/hub.js" report blocked <sessionId> --reason <text>
node "<home>/hub.js" report approval <sessionId> --prompt <prompt> [--summary <text>]
node "<home>/hub.js" report link <sessionId> --label <text> --target <url or absolute path>
```

- The CLI's home is the directory that holds the `hub.js` it runs from, so a session started by a hub with `--home` reports to that home.
- The CLI finds the hub through `hub.json` and never starts one. Timeout: 10 seconds. Repeating a report is safe, because each report sets a value.
- When no hub answers, the CLI exits 2 and prints that the hub is not running. The hub stays up while sessions are active, so this is rare; the work item then ends `blocked`, and the operator marks it done.
- Exit codes: 0 recorded, 2 no hub, 1 usage, 3 refused (unknown session, or a path that `git worktree list` run in that path does not show as a worktree). A worktree can belong to a different repository than the source's repo root, as when a Support session in `D:\git\support` reports an widgets worktree.
- A report for a work item that is already done does not reopen it: `done` and `blocked` set the session's outcome, `worktree` links the ticket's worktree, and `stage` and `approval` are ignored.

## Settings

`<home>/settings.json`, plain JSON. The hub validates it on load and on change (PRD R42).

```json
{
  "sessions": { "concurrency": 2, "permissionMode": "auto", "model": "", "installHooks": true },
  "triage": { "model": "claude-sonnet-5", "concurrency": 2, "timeoutSeconds": 180 },
  "sources": {
    "github": {
      "enabled": true,
      "pollIntervalSeconds": 300,
      "repoRoot": "D:/git/widgets",
      "triagePlaybook": "triage:github",
      "namespace": "dev",
      "setupPrompt": "/init-worktree {{ticket.sourceKey}}",
      "ghPath": "gh",
      "repo": "acme/widgets",
      "logins": ["work-login", "work-ai-login"],
      "project": { "owner": "acme", "number": 3, "statusField": "Status" },
      "assignedStatuses": ["🎁 Assigned", "⚒️ Dev", "🔍 Review"],
      "branchPattern": "^(\\d+)-",
      "maxPages": 5
    },
    "zoho": {
      "enabled": true,
      "pollIntervalSeconds": 300,
      "repoRoot": "D:/git/support",
      "triagePlaybook": "triage:zoho",
      "namespace": "support",
      "pickPrompt": "Use the support-bind skill to bind and claim Support case #{{ticket.sourceKey}}, then stop: do not investigate. Report blocked with the reason if the claim fails or someone else holds the case; otherwise report done.",
      "tokenCommand": "bash ~/.claude/scripts/desk-token.sh",
      "automationAgentIds": ["8000000000000000002", "8000000000000000003"],
      "orgId": "700000001",
      "agentId": "8000000000000000001",
      "escalationField": "cf_queue",
      "escalationValue": "Support"
    },
    "forum": {
      "enabled": true,
      "pollIntervalSeconds": 300,
      "repoRoot": "D:/git/support",
      "triagePlaybook": "triage:forum",
      "namespace": "support",
      "queryCommand": "bash ~/.claude/scripts/run-forum-sql.sh",
      "pickPrompt": "Use the support-bind skill to bind and claim Support case T{{ticket.sourceKey}}, then stop: do not investigate. Report blocked with the reason if the claim fails or someone else holds the case; otherwise report done.",
      "forumId": 1,
      "userId": "7"
    }
  }
}
```

- The values shown are the operator's, taken from their Ground Control configuration. Defaults are empty for `repo`, `logins`, `project` and `assignedStatuses`, and the GitHub source refuses to poll until they are set.
- Per playbook: `description`, `autoStart`, `requiresWorktree`, `permissionMode`, `model` and `kind`, in the playbook file's front matter.
- A source implements core's `Source`: `poll()` returns a complete read or an error, `context(ticket)` returns the triage context or an error, and `keyOfBranch(branch)` reads a ticket key from a worktree branch. A source with a pool marks each polled ticket `assigned`, `pool` or neither.
- Pick (PRD R48): the Support sources' `pickPrompt` asks for the `support-bind` skill on the case and an early stop, because `/support-bind` on its own continues into investigation and carries on after a failed claim. The skill binds the case journal and claims the case through the Support skills and their guards. The `support:case` task session then resumes the bound case with `/support-process`.
- GitHub reads go through `gh api graphql`. The issue query is GC's: `repo:<repo> is:issue is:open assignee:<login>… project:<owner>/<number>`, then a filter on project status; an issue on another status is listed as not assigned (mechanics M2). A poll that needs more than `maxPages` pages of 100 fails. Triage context ports GC's card context: the issue body, the last 5 comments, the last 100 assignment and status events, and a linked pull request's author, review requests, state, checks, last 5 comments, reviews and last 5 review threads, with each text clipped to 2,000 characters keeping the start and end.
- GitHub errors: offline, timeout and rate limits are temporary. The poll changes nothing and runs again at the next interval. Missing `gh` or failed authentication shows in the panel.
- Zoho Desk and Forum port the operator's Support board, `D:\git\support\extensions\support-kanban\lib\zoho.js` and `forum.js`. Read those and the `support-*` skills before building either source.
- Zoho reads go through the Desk REST API at `https://desk.zoho.com/api/v1`. They use the access token that `tokenCommand` prints, cached for 50 minutes and fetched again on a 401, plus the `orgId` header. Switchboard reads no secrets file; the operator's runner scripts do. Keep 19-digit IDs as strings.
  - Each poll pages through every Open ticket with `GET /tickets/search?status=Open` and filters on the escalation field after the fetch, because only `/tickets/search` returns custom fields. A ticket missing from a complete read has left the assigned state.
  - Assignee classes follow the board's `classifyAssignee`, with the team map from `GET /teams` cached for 6 hours. The operator is `mine`; a missing assignee is `none`; an automation or a team member is `support`; anyone else is `engineer`. `mine` is the assigned state; `none` and `support` are the pool; `engineer` is neither. A poll whose team map cannot be read is incomplete and changes nothing.
  - Triage context: the subject, the custom fields `cf_queue`, `cf_user_id`, `cf_account_id` and `cf_page_url`, the thread bodies, the comments (internal notes), and the history of tier and assignee changes.
- Forum reads run read-only SQL on the production forum database, through `queryCommand`, the operator's runner script, which holds the connection. The SQL goes to its stdin and rows come back one JSON object per line (`--result-format=json/raw`). Runner exit code 7 means the database is unreachable, usually the VPN, and the poll fails without changing anything. A line that looks like a row but does not parse, or `maxRows` (500) rows, makes the poll incomplete.
  - A topic assigned to anyone else is left out. The pool sorts by the last public post (`Thread.LastPublicEntryId`), else the topic's creation; DATETIME values are UTC.
  - Assigned state: `Thread.CommunityId = <forumId> AND DeletedUtc IS NULL AND IsLocked = 0 AND Status = 0` (`ThreadStatus.Open`), with `AssigneeId` equal to `userId` for the assigned state, or null for the pool.
  - Triage context: the topic title and posts in order. Deleted posts (`DeletedUtc` set), posts with `Status = 2` (private notes) and posts by `UserId = 2` (the automatic AI analysis) are left out. The source key is `Thread.Id`, and the URL is `https://forum.example.com/t/forum/<Thread.Key>`.
- `tokenCommand` and `queryCommand` run through `bash -c`. On Windows the hub uses Git Bash, from `CLAUDE_CODE_GIT_BASH_PATH` or found beside `git.exe` on PATH, because `bash` on a VS Code-started hub's PATH is WSL's `System32\bash.exe`, which lacks the runner scripts' tools (`jq`, `mysqlsh`).
- A Forum topic and a Zoho ticket about the same case are separate tickets (PRD R26).

The operator's first playbooks mirror their Ground Control action table: `dev:develop` (`/gc-plan`), `dev:review-others` (`/review-pr`), `dev:review-followup` (`/review-pr-followup`), `dev:address-review` (`/address-pr-review`), `dev:qa-failure` and `dev:qa-question` (`/address-feedback`). Support has one playbook, `support:case`, because `/support-process` routes every case type itself. It runs `/support-process #<ticket number>` for Zoho or `/support-process T<topic id>` for Forum, with `autoStart: false`, `requiresWorktree: false` and `workdir: repoRoot`. A pick starts the case as soon as its pick session has claimed it (PRD R48); `autoStart: false` makes a case that reopens on its own, such as after On Hold, wait for Approve. The skills reuse the case's folder and journal, so `/support-process` resumes where the case stopped. Support sessions stop early, often at a request for a local reproduction, and end with a draft reply handed back to the operator. No playbook or Switchboard prompt ever sends `/support-release`: the Support hooks treat that literal prompt as the operator's own release.

The operator's Support board (`support-kanban`) starts no sessions itself, but its hooks register any Claude session in `D:\git\support` on the case's card. Switchboard does not coordinate with it: the operator does not press Investigate on a card whose case Switchboard is running. The Support skills are project skills of `D:\git\support`, so Support sources use it as their repo root; `/support-fix` makes the widgets worktree when a case needs code. All playbooks live in the operator's home, not in this repository.
