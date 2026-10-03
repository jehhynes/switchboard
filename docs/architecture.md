# Switchboard architecture

Requirements live in [prd.md](prd.md). This document describes components, state and protocols. Implemented: the hub lifecycle, the core's store, settings, playbooks and [flow decisions](#core-decisions), and the GitHub source's reads. Every other section is planned.

Session and triage mechanics come from Ground Control (`D:\git\ground-control`), where they are verified. M IDs below refer to its [mechanics.md](../../ground-control/docs/mechanics.md). Re-verify them in Switchboard's own mechanics.md before relying on a version-fragile one.

## Packages

npm workspaces, TypeScript strict, Node ≥ 22.13, Vitest, esbuild and vsce, following Ground Control's layout. Only `extensions/switchboard` imports `vscode`. Implemented so far: `packages/core` (store, settings, playbooks, flow decisions), `packages/github` (poll and triage context), and `packages/hub`, `apps/hub` and `extensions/switchboard` for the hub lifecycle.

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
Ticket     id, source, sourceKey, sourceId, title, url, assigned, lastPolledAt, repoRoot
WorkItem   id, ticketId, playbook, status, stage, stageAt, taskPrompt, warning, error, failedStep, unassignedAt, queuedAt, createdAt, doneAt, doneReason
Triage     id, workItemId, context, playbook, summary, model, startedAt, endedAt, error
Worktree   id, ticketId, path, branch, linkedBy (report | convention)
Session    id, workItemId, kind (setup | task), provider, nativeSessionId, shortId, cwd, state, stateAt, stateDetail, outcome, outcomeDetail, startedAt, endedAt, released
```

- `Ticket.assigned` is the assigned state the last complete poll saw. `Ticket.repoRoot` is the repo an ad-hoc prompt chose; it is empty for other sources, which use their `repoRoot` setting.
- `Ticket.sourceKey` is the key people use, such as a GitHub issue number or a Zoho ticket number. `Ticket.sourceId` is the source's internal ID when API calls need a different one, such as Zoho's internal ticket ID.
- `Triage.context` is the clipped text the classifier received. Keeping it shows why a playbook was chosen.
- `WorkItem.status` takes the values in PRD R34. `WorkItem.error` holds the cause shown for `failed` or `blocked`, and `WorkItem.failedStep` (`triage`, `setup` or `task`) is the step Retry repeats (PRD R45).
- `WorkItem.unassignedAt` records that the ticket left the assigned state while a session was active (PRD R10). `WorkItem.queuedAt` orders queued starts.
- `WorkItem.taskPrompt` is the rendered prompt the task session ran, or the typed prompt for an ad-hoc work item.
- `WorkItem.doneReason` is `session`, `operator` or `unassigned`.
- `WorkItem.warning` is set when the work item ends because its ticket left the assigned state with no done report (PRD R10, R11).
- `Session.state` is the observed state, `Session.stateDetail` the error kind of a `failed` turn, and `Session.outcome` the reported or decided outcome (PRD R36). `Session.released` records that the release stop was sent, so it is sent once (PRD R39).
- A session's `cwd` follows its playbook's `workdir`: the ticket's worktree when one exists, otherwise the source's repo root.

## Hub lifecycle

Implemented. Follows Ground Control's hub (GC R35, M25).

- **Start:** extension activation copies `dist/hub.js` to `~/.switchboard/hub.js` when it differs. It accepts a running hub only when the hub's `build`, a hash of its bundle, matches the bundle installed at that moment. It asks a hub of another build to stop and starts a new one only after the old one has gone; if the old hub refuses, the window reports it. Otherwise it starts one detached with VS Code's executable and `ELECTRON_RUN_AS_NODE=1`, with `ELECTRON_*`, `VSCODE_*` and `NODE_OPTIONS` removed from its environment. Output goes to `~/.switchboard/hub.log`.
- **Record:** the hub listens on `127.0.0.1` on an ephemeral port and writes `~/.switchboard/hub.json` with `protocol`, `version`, `build`, `port`, `token`, `pid` and `startedAt`. The hub holds a lock for its lifetime: a named pipe `\\.\pipe\switchboard-<hash of home>` on Windows, `~/.switchboard/hub.sock` elsewhere. Only the lock holder writes or removes the record, so concurrent starts leave one hub, and the OS releases the pipe when the hub dies. A hub that cannot take the lock waits up to 5 seconds for the holder's record and otherwise exits. A forced exit on Windows leaves the record behind, so clients accept it only when `GET /status` with the token returns the recorded pid.
- **Endpoints:** `GET /hub` returns identity without a token. `GET /status`, `GET /events` and `POST /shutdown` require `Authorization: Bearer <token>`.
- **Clients:** each window holds one `/events` stream. The hub exits 30 minutes after its last stream closes, but not while any session is active (PRD R43, planned). A stream that sends no response headers within 5 seconds counts as refused. When a stream ends, the window finds or starts a hub and reconnects. It gives up and shows an error after three consecutive failures; a connection that lasts under 10 seconds counts as a failure.
- **Entry point:** `hub.js [--home=<dir>] [--idle-ms=<ms>]` serves; `hub.js --stop` stops the running hub.
- **Home override:** when `SWITCHBOARD_HOME` is set in VS Code's environment, the extension uses it as the Switchboard home and passes it to the hub as `--home`. It does not change the user profile that Claude and `gh` see. Live acceptance depends on it (planned).

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

- Template variables: the ticket's fields, `{{ticket.context}}`, `{{triage.summary}}`, `{{session.id}}` and `{{report}}`. `{{report}}` is the report command prefix, `node "<home>/hub.js" report`. Rendering fails on an unknown variable.
- Front matter: `description` (required), `autoStart` (default false), `requiresWorktree` (default false), `permissionMode` and `model` (defaults from `sessions` settings), `kind` (`task` by default, or `triage`), and `workdir` (`worktree` by default: the ticket's worktree when one exists, otherwise the repo root; or `repoRoot`: always the source's repo root, for playbooks whose skills belong to that repository).
- `description` tells the classifier when to choose the playbook.
- A source's triage playbook has `kind: triage`. Its body is the classifier's system prompt. Triage playbooks are never offered to the classifier as choices.
- Every session prompt ends with the report contract: the session ID and the `stage`, `worktree`, `done` and `blocked` commands. Skills written for Ground Control do not know Switchboard. `{{report}}` lets a template add its own report calls.

## Triage

Triage follows Ground Control's classifier (GC R38, M31).

1. The source plugin builds the triage context: it fetches the ticket's text, clips each field at a word boundary to a size limit, and formats it with authors, status changes and assignees. Ground Control clips the issue body and each comment to 2,000 characters.
2. The classifier runs `claude -p --output-format json --json-schema <schema> --no-session-persistence --setting-sources "" --tools "" --strict-mcp-config --system-prompt <triage playbook + playbook descriptions>`, with the context on stdin. Stdin avoids the Windows 32,767-character command-line limit (M31).
3. The schema is `{playbook: enum of loaded playbook names, summary: string}`. The classifier reads `structured_output`.

Triage has no tools, settings, MCP servers or saved transcript, so it is not a session and does not count toward the one-active-session rule. The hub runs at most one triage per work item at a time, at most `triage.concurrency` at once (default 2), with a `triage.timeoutSeconds` limit (default 180).

A classifier error, an unparsable result, a timeout, or a playbook name outside the enum fails the work item with that error (PRD R37). A triage interrupted by a hub shutdown is not a failure: the work item stays `triaging`, and triage runs again when the hub starts.

## Flow

1. Poll a source. For each ticket, compare its assigned state with `lastSeenState`. A poll that fails or is incomplete, such as one that hits the page limit, updates nothing.
2. When a ticket enters the assigned state, create a work item (`triaging`) and run triage.
3. Store the triage result. If the playbook's `autoStart` is false, the work item is `awaiting-approval`.
4. If the playbook's `requiresWorktree` is true and the ticket has none, start a setup session (`setup`) running the source's `setupPrompt`. The setup session succeeds when a worktree is linked, by report or by the branch convention, and the session reports done or ends. If it ends with no worktree linked, the work item fails with "Setup ended without a worktree."
5. Render the playbook and start the task session (`running`). It reports stages, a worktree link if it creates one, and done or blocked.
6. When the task session reports done, the work item is done with reason `session`. When it reports blocked, or its turn ends with no report, the work item is `blocked`. A turn that ends `failed` blocks it with the error kind, because the session can still be resumed.
7. When a ticket leaves the assigned state with no active session, its work item is done with reason `unassigned` and a warning. With an active session, that is deferred until the session reports or ends (PRD R10).

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
| `report` | The report command: `stage`, `worktree`, `done` or `blocked`. |
| `stop-succeeded`, `stop-failed` | The runner's `stop-session`, for an operator stop or a release. |
| `worktree-found` | The branch convention. It links a worktree only to a ticket that has none. |
| `adhoc`, `approve`, `retry`, `mark-done`, `retriage`, `change-playbook`, `stop`, `tick` | The panel; `tick` re-runs scheduling after settings or playbooks change. |

Actions are `triage`, `start-session` and `stop-session`. After every event the core starts triage for `triaging` work items up to `triage.concurrency`, then starts `queued` work items in queue order while fewer than `sessions.concurrency` sessions are active, skipping a ticket that already has an active session. A task that follows a setup session starts when the setup session ends, without waiting for a slot.

## Claude Code runner

- Start: `claude --bg --permission-mode <mode> --settings '{"worktree":{"bgIsolation":"none"}}' -n <name> [--model <model>] <prompt>`, with no shell, so a leading slash command survives. The name is `switchboard · <playbook> · <source> <key>`. Claude's background service owns the process, so sessions survive VS Code and the hub. `--bg` ignores `--session-id`; the runner parses the short ID from `backgrounded · <id> · <name>` and matches it as a prefix against `claude agents --json` (M1, M33). A session not on the roster within 60 seconds fails the start.
- Environment: pass `CLAUDE_CONFIG_DIR` through exactly as the hub inherited it, and never set it. Setting it, even to `~/.claude`, moves where Claude reads folder trust (GC M62). Strip `ELECTRON_*`, `VSCODE_*` and `NODE_OPTIONS`.
- Trust: `--bg` exits 1 with `Workspace not trusted` in a directory Claude has not trusted; a linked worktree inherits its main checkout's trust (GC M62). The failed start shows that message (PRD R41).
- Background sessions inherit the service's environment, not the caller's, so per-run values such as the Switchboard session ID travel in the prompt (M33).
- Liveness: poll `claude agents --json` (without `--all`) every 30 seconds while the hub runs, and again just before each start (PRD R17). The roster alone decides liveness: a session is active while the last successful roster read lists it, and `ended` once a successful read does not. A failed read changes no session. Hook markers only set the state of a live session, because a killed process leaves its last marker behind (GC M20). The roster `state` is the fallback when no hook marker exists: `working` maps to `running`, `blocked` to `waiting`, and `done` or `stopped` to `idle`.
- State: hook markers decide the observed state, following GC's mapping (GC M2, M20):
  - `UserPromptSubmit`, `PostToolBatch` and `PermissionDenied` mean `running`, as does `SessionStart` with `source=compact`.
  - `PermissionRequest`, `Elicitation`, `PreToolUse` for `AskUserQuestion` or `ExitPlanMode`, and `Notification` of type `permission_prompt`, `worker_permission_prompt` or `agent_needs_input` mean `waiting`.
  - `Stop` means `idle`, or `running` while background tasks remain.
  - `StopFailure` means `failed`, with its error kind and message.
- Hooks:
  - The hub installs async command hooks for those events plus `SessionEnd` in `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`. It preserves other entries, refuses to edit malformed JSON, and adds missing entries at startup. The `sessions.installHooks` setting is on by default; when it is off, the roster alone decides state.
  - The hook runs `node "<home>/hook.mjs"`. It skips subagent events, always exits 0 and prints nothing, and writes `<home>/activity/<nativeSessionId>.json` atomically: `{v, sessionId, event, at, cwd, notificationType, source, toolName, backgroundTasks, error, errorMessage}`, with `errorMessage` capped at 500 characters. `SessionEnd` deletes the marker.
  - Ground Control's hooks stay separate; the two do not share markers.
- Release: after a done or blocked report, or an `idle` or `failed` turn, run `claude stop <id>` once when the session is no longer `running` (PRD R39).
- Stop: `claude stop <id>`, 15-second timeout. A failed stop leaves the session stoppable. Never `claude rm`, which can delete the worktree.
- Attach: a VS Code terminal running `claude attach <id>`. Leaving it keeps the session running (M33, M45).
- Open in VS Code: `claude-vscode.primaryEditor.open(sessionId)`. Focus an open tab first; resume only after confirming the session is not running in the background (M5–M7, M21, M22, M33).

## Session reports

Sessions report through the hub bundle, which posts to the hub's loopback HTTP server. The prompt carries the Switchboard session ID and the bundle's absolute path, because a background session has no Switchboard environment and `switchboard` is not on PATH.

```
node "<home>/hub.js" report stage <sessionId> <stage>
node "<home>/hub.js" report worktree <sessionId> <path>
node "<home>/hub.js" report done <sessionId> [--summary <text>]
node "<home>/hub.js" report blocked <sessionId> --reason <text>
```

- The CLI's home is the directory that holds the `hub.js` it runs from, so a session started by a hub with `--home` reports to that home.
- The CLI finds the hub through `hub.json` and never starts one. Timeout: 10 seconds. Repeating a report is safe, because each report sets a value.
- When no hub answers, the CLI exits 2 and prints that the hub is not running. The hub stays up while sessions are active, so this is rare; the work item then ends `blocked`, and the operator marks it done.
- Exit codes: 0 recorded, 2 no hub, 1 usage, 3 refused (unknown session, or a path that `git worktree list` run in that path does not show as a worktree). A worktree can belong to a different repository than the source's repo root, as when a Support session in `D:\git\support` reports an widgets worktree.
- A report for a session of a work item that is already done is recorded on the session and does not reopen the work item.

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
      "credentialsPath": "~/.claude/secrets/zoho-selfclient.json",
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
      "databaseEnvPath": "~/.claude/secrets/read-database.env",
      "forumId": 1,
      "userId": 7
    }
  }
}
```

- The values shown are the operator's, taken from their Ground Control configuration. Defaults are empty for `repo`, `logins`, `project` and `assignedStatuses`, and the GitHub source refuses to poll until they are set.
- Per playbook: `description`, `autoStart`, `requiresWorktree`, `permissionMode`, `model` and `kind`, in the playbook file's front matter.
- A source implements core's `Source`: `poll()` returns a complete read or an error, `context(ticket)` returns the triage context or an error, and `keyOfBranch(branch)` reads a ticket key from a worktree branch.
- GitHub reads go through `gh api graphql`. The issue query is GC's: `repo:<repo> is:issue is:open assignee:<login>… project:<owner>/<number>`, then a filter on project status; an issue on another status is listed as not assigned (mechanics M2). A poll that needs more than `maxPages` pages of 100 fails. Triage context ports GC's card context: the issue body, the last 5 comments, the last 100 assignment and status events, and a linked pull request's author, review requests, state, checks, last 5 comments, reviews and last 5 review threads, with each text clipped to 2,000 characters keeping the start and end.
- GitHub errors: offline, timeout and rate limits are temporary. The poll changes nothing and runs again at the next interval. Missing `gh` or failed authentication shows in the panel.
- Zoho Desk and Forum port the operator's Support board, `D:\git\support\extensions\support-kanban\lib\zoho.js` and `forum.js`. Read those and the `support-*` skills before building either source.
- Zoho reads go through the Desk REST API at `https://desk.zoho.com/api/v1`. They use an access token refreshed from the self-client credentials file, plus the `orgId` header. Keep 19-digit IDs as strings.
  - Each poll pages through every Open ticket with `GET /tickets/search?status=Open` and filters on the escalation field after the fetch, because only `/tickets/search` returns custom fields. A ticket missing from a complete read has left the assigned state.
  - Assignee classes follow the board's `classifyAssignee`, with the team map from `GET /teams` cached for 6 hours. The operator is `mine`; a missing assignee is `none`; an automation or a team member is `support`; anyone else is `engineer`. Only `engineer` is outside the assigned state. A poll whose team map cannot be read is incomplete and changes nothing.
  - Triage context: the subject, the custom fields `cf_queue`, `cf_user_id`, `cf_account_id` and `cf_page_url`, the thread bodies, the comments (internal notes), and the history of tier and assignee changes.
- Forum reads run read-only SQL on the production forum database, with the connection from the database env file. They need the VPN, so a connection failure is temporary.
  - Assigned state: `Thread.CommunityId = <forumId> AND DeletedUtc IS NULL AND IsLocked = 0 AND Status = 0` (`ThreadStatus.Open`), with `AssigneeId` equal to `userId` or null.
  - Triage context: the topic title and posts in order. Deleted posts (`DeletedUtc` set), posts with `Status = 2` (private notes) and posts by `UserId = 2` (the automatic AI analysis) are left out. The source key is `Thread.Id`, and the URL is `https://forum.example.com/t/forum/<Thread.Key>`.
- A Forum topic and a Zoho ticket about the same case are separate tickets (PRD R26).

The operator's first playbooks mirror their Ground Control action table: `dev:develop` (`/gc-plan`), `dev:review-others` (`/review-pr`), `dev:review-followup` (`/review-pr-followup`), `dev:address-review` (`/address-pr-review`), `dev:qa-failure` and `dev:qa-question` (`/address-feedback`). The Support playbooks follow the intake types of the board's classifier (`support-classify`): `support:defect`, `support:how-to`, `support:partner-inquiry`, `support:feature-request` and `support:data-fix-request`, each running `/support-process #<ticket number>` or `/support-process T<topic id>` with `requiresWorktree: false` and `workdir: repoRoot`. The Support skills are project skills of `D:\git\support`, so Support sources use it as their repo root; `/support-fix` makes the widgets worktree when a case needs code. All playbooks live in the operator's home, not in this repository.
