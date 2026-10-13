# Mechanics

Dated experiments and source inspections that Switchboard relies on. Each entry records the version tested, the result, its limits, and where Switchboard uses it. An entry here does not imply product support.

Ground Control's [mechanics.md](../../ground-control/docs/mechanics.md) holds the verified session mechanics Switchboard reuses. Copy an entry here, re-verified, when Switchboard first depends on it.

## M1. `node:sqlite` in the hub runtimes

- **Date:** 2026-10-02.
- **Versions:** VS Code's `Code.exe` with `ELECTRON_RUN_AS_NODE=1` (Electron 43.7.3, Node 24.21.0); system Node 24.14.0.
- **Experiment:** `require('node:sqlite')`, open `DatabaseSync(':memory:')`, create a table, insert with a prepared statement, select.
- **Result:** works in both runtimes with no native module. System Node prints `ExperimentalWarning: SQLite is an experimental feature`; the module's API may still change between Node versions.
- **Current use:** the store (architecture.md § Store). Re-run after a VS Code or Node upgrade.

## M2. GitHub issue search through `gh api graphql`

- **Date:** 2026-10-03.
- **Versions:** gh 2.100.0, signed in as `work-ai-login`; repository `acme/widgets`, project `acme/3`.
- **Experiment:** `search(type:ISSUE)` with `repo:acme/widgets is:issue is:open project:acme/3` plus `assignee:work-login`, `assignee:work-ai-login`, or both. Then `GithubSource.poll` and `context` against the same repository.
- **Result:** 10, 1 and 11 issues: repeated `assignee:` qualifiers are ORed, as GC found. The poll listed 11 issues, 9 of them in an assigned status. The context of issue 19504 (a 41,253-character body, 5 comments, 32 timeline events, and one open closing PR with 5 comments, one of them 52,900 characters, and 5 review threads) formatted to 28,996 characters with each text clipped to 2,000.
- **Fixtures:** `packages/github/test/fixtures` are these responses, scrubbed: titles, bodies and comments are replaced by filler of the same length, and logins other than the operator's and `acme` by `user-a`, `user-b`, ….
- **Current use:** the GitHub source (architecture.md § Settings).

## M3. One-shot classifier

- **Date:** 2026-10-03.
- **Versions:** Claude Code CLI 2.1.288.
- **Experiment:** `claude -p --output-format json --json-schema <{playbook: enum, summary}> --no-session-persistence --setting-sources "" --tools "" --strict-mcp-config --system-prompt <prompt> --model claude-sonnet-5`, with the ticket text on stdin, in an untrusted directory.
- **Result:** exit 0 with one JSON object: `type: result`, `subtype: success`, `is_error: false`, and `structured_output` holding `{playbook, summary}` with `playbook` from the enum. `result` repeats it as a string. The untrusted directory did not block print mode.
- **Fixture:** `packages/claude/test/fixtures/classifier-output.json` is this output.
- **Current use:** the classifier (architecture.md § Triage).

## M4. Background start refused in an untrusted directory

- **Date:** 2026-10-03.
- **Versions:** Claude Code CLI 2.1.288.
- **Experiment:** `claude --bg --permission-mode auto --settings '{"worktree":{"bgIsolation":"none"}}' -n <name> <prompt>` in `D:\git\switchboard\.wip\mech` and in `D:\git\switchboard`, neither trusted.
- **Result:** exit 1, nothing on stdout, and on stderr: ``Workspace not trusted. Run `claude` in <dir> once and accept the trust prompt, then retry.`` The message names the directory and the recovery, so a failed start shows it as is (PRD R41). Trust is per directory: a session the VS Code extension runs in a directory does not make it trusted for `--bg`.
- **Current use:** the runner's start failure.

## M5. Background sessions: start output, roster and stop

- **Date:** 2026-10-03.
- **Versions:** Claude Code CLI 2.1.288.
- **Experiment:** in the trusted scratch repo `.wip/mech`, `claude --bg --permission-mode auto --settings <json> -n <name> <one-word prompt>`, then `claude agents --json` every 4 seconds, `claude stop <id>`, and `claude agents --json [--all]`.
- **Result:**
  - `--bg` exits 0 and prints `backgrounded · 45bc9f1a · <name>`, then help lines for `agents`, `attach`, `logs` and `stop`.
  - The roster lists the new entry at once with `id` (the short ID), `sessionId`, `kind: background`, `state: working` and **no pid**; the pid appeared 1–4 seconds after launch. After the turn, the entry shows the pid with `status: idle` and `state: done`.
  - After `claude stop`, the entry leaves the roster; `--all` still lists it with `state: done` and no pid.
  - A Ground Control session started four days earlier is still listed with `state: blocked` and no pid: an entry without a pid can be a process that is gone.
- **Current use:** the runner matches the short ID and treats a session as alive only while its entry has a pid. A start is confirmed only once the entry has a pid, so a roster read during the first seconds does not end a new session.

## M6. Hooks inside background sessions

- **Date:** 2026-10-03.
- **Versions:** Claude Code CLI 2.1.288.
- **Experiment:** the hook writer and Switchboard's hook entries passed inline in `--settings` for one `--bg` session, so `~/.claude/settings.json` was not changed.
- **Result:** the hooks ran inside the background session. Within 4 seconds `activity/<sessionId>.json` held `event: "Stop"`, `backgroundTasks: 0`, keyed by the full session ID. `claude stop` ran `SessionEnd`, which deleted the marker.
- **Current use:** hook markers set the state of live sessions.

## M7. Resume after release, and attach

- **Date:** 2026-10-03.
- **Versions:** Claude Code CLI 2.1.288.
- **Experiment:** after `claude stop`, `claude -p <prompt> --resume <sessionId>` with a 15-second Bash step, polling `claude agents --json`. Separately, `claude attach <id>` with stdin closed against a live background session.
- **Result:**
  - The resumed session is listed under the same `sessionId` with `kind: interactive`, a pid, `status: busy` and no short `id` until it ends. VS Code tab sessions are listed the same way, as `kind: interactive` with a pid. Matching by session ID prefix therefore sees a resumed session.
  - `claude attach` drew its terminal UI ("Attaching…") and exited 0 when stdin closed. The session stayed listed with its pid. Interactive use was not driven; live acceptance checks it.
- **Current use:** the roster read covers every started session so a resume is seen (PRD R17); Open in terminal and Open in VS Code (architecture.md § Claude Code runner).

## M8. Writing Claude's settings.json on Windows

- **Date:** 2026-10-03.
- **Versions:** Windows 11, Node 24, Claude Code CLI 2.1.288.
- **Observation:** during live acceptance, a hub's first start failed renaming its temporary file over `~/.claude/settings.json` with `EPERM`, because another process had the file open; the next start succeeded. Two hook processes of one session writing the same marker hit the same refusal and left a temporary file.
- **Current use:** hook installation retries the rename 10 times, 100 ms apart, removes its temporary file when it gives up, and shows the error in the dock instead of stopping the hub. The hook writer removes its temporary file when the rename fails.

## M9. Live acceptance, 2026-10-03

- **Versions:** Claude Code CLI 2.1.288, VS Code 1.140.0, Claude Code extension 2.1.288, gh 2.100.0.
- **Setup:** isolated home `.wip/acceptance-home` with the operator's GitHub settings and minimal playbooks, all `autoStart: false`. The panel ran in a separate VS Code instance (its own user-data-dir, `SWITCHBOARD_HOME`, the Switchboard extension under development), driven over its debugging port. The acceptance hub's hook entries were removed afterwards, leaving `~/.claude/settings.json` identical to its copy from before the run. Screenshots are in `.wip/acceptance/`.
- **1. GitHub read: pass.** 9 work items, one for each issue assigned to `work-login` or `work-ai-login` in 🎁 Assigned, ⚒️ Dev or 🔍 Review. The 2 issues in 🆕 New were left out. Each was triaged with `claude-sonnet-5` into a `dev:*` playbook, and the issues with a branch-named worktree showed it. No work item was approved.
- **2. Ad-hoc session: pass.** A prompt in the scratch repo wrote `hello2.txt`, reported the stage "Wrote hello2.txt", reported the worktree and reported done. The panel showed Running, then the stage, then Done. The session was released (`claude stop`) after its turn ended, and the worktree was linked by report.
- **3. Controls: pass.**
  - Attach opened a terminal on the running session; closing the terminal left the session running with its pid.
  - Stop made the work item Blocked with "Stopped by you."; Retry started a new session.
  - Open in VS Code resumed the ended session in a Claude tab with its history, and a second Open focused that tab without adding one.
  - A prompt using AskUserQuestion showed "Waiting on you".
  - An ad-hoc start in an untrusted repo failed with Claude's message: ``Workspace not trusted. Run `claude` in D:\git\switchboard\.wip\untrusted once and accept the trust prompt, then retry.``
- **Defects found and fixed:**
  - A session reopened in VS Code is listed as `kind: interactive` with only `status`, and was read as running. Its `status` now decides (`idle`, `busy`, `waiting`).
  - A session that had ended without a release stop could be released after the operator reopened it, which would have run `claude stop` on the operator's tab. A session is now marked released whenever its process ends or the roster lists it as interactive, so a resumed session is never stopped by Switchboard.
  - The settings.json and marker writes described in M8.
- **Not covered:** Open in VS Code for a session from another folder, which M13 covers.

## M10. Zoho Desk reads and the Support pool

- **Date:** 2026-10-03.
- **Versions:** Zoho Desk REST API v1, the operator's `desk-token.sh` runner, Claude Code CLI 2.1.288.
- **Experiment:** read-only GETs: `/tickets/search?status=Open` paged by 100, `/teams`, and one ticket's detail, conversations, threads and history. Then the Zoho source and a hub in an isolated home with the draft `triage:zoho` and `support:case` playbooks, which triaged the pool and started no session.
- **Result:**
  - The desk had 707 Open tickets: 8 search requests, about 5.5 seconds a poll. 5 had escalation `Support`. 3 were held by support agents and went to the pool; 2 were held by an engineer and were left out.
  - `/tickets/search` returns `cf` and `createdTime`. The conversation list and the history come newest first. The list omits thread bodies, so each thread is read on its own.
  - A history `Case Owner` change carries agent IDs, and a `Team` change carries team IDs.
  - One ticket's triage context came to 26,209 characters over 20 conversation entries.
  - The pool listed the 3 tickets oldest first. Each was triaged into `support:case` with a summary in the `<ask> — <intake type>, <immediacy>/<severity>` form; one was rated NON-BLOCKING and two BLOCKING. No work item or session was created, and nothing was written to Zoho.
- **Fixtures:** `packages/zoho/test/fixtures`, built from these responses by whitelist: synthetic IDs, ticket numbers, names and text (synthetic 19-digit IDs except the operator's own and the two automations, ticket numbers from 900001, "Customer N" and "Agent N", same-length filler for every text, and only cf_queue kept as recorded).
- **Current use:** the Zoho source and the pool (architecture.md § Settings, § Flow).

## M11. Forum reads and the Support pool

- **Date:** 2026-10-03.
- **Versions:** the operator's `run-forum-sql.sh` runner (mysqlsh) over the VPN, Claude Code CLI 2.1.288.
- **Experiment:** read-only SELECTs: the open-topic count, then the Forum source's poll and one topic's posts. Then a hub in an isolated home with the draft `triage:forum` and `support:case` playbooks, which triaged the pool and started no session.
- **Result:**
  - The forum had 7 open, unlocked, undeleted topics, all unassigned, so all 7 were in the pool and none was assigned. A poll takes about 5 seconds, most of it the runner's mysqlsh start.
  - `--result-format=json/raw` prints one JSON object per row, and the SQL reads from stdin with `-`.
  - The pool listed the 7 topics oldest first by their last public post. Each was triaged into `support:case`: six defects and one data-fix-request, with immediacy and severity in the summary. No work item or session was created, and nothing was written.
- **Fixtures:** `packages/forum/test/fixtures`: the recorded rows with topic IDs from 90001, titles "Topic <n>", keys "topic-<n>", authors "Person <k>" and same-length filler bodies; timestamps are kept. Two synthetic rows add a topic assigned to the operator and one assigned to someone else, because the live forum had neither.
- **Current use:** the Forum source (architecture.md § Settings).

## M12. Which bash runs source commands

- **Date:** 2026-10-03.
- **Versions:** VS Code with Code.exe as the hub's Node, Git for Windows at `C:\Program Files\Git`, Windows 11.
- **Experiment:** the operator's hub, started by the extension, polled Zoho and Forum with the installed settings. Then a read-only poll of both sources from PowerShell, where `bash` resolves as it does for the hub.
- **Result:**
  - Under Code.exe, and from PowerShell, `bash` resolves to WSL's `C:\Windows\System32\bash.exe`. The runner scripts ran under `/home/operator` and failed: `jq: command not found` for Zoho, `mysqlsh: No such file or directory` for Forum.
  - M10 and M11 passed only because they ran from Git Bash, where `bash` is Git Bash.
  - With `findBash`, which picked `C:\Program Files\Git\bin\bash.exe` beside `git.exe` in `Git\cmd`, the PowerShell poll read Zoho pool 6 and Forum pool 7.
- **Lesson:** run live source checks the way the hub runs them, under Code.exe's environment, not from a shell.
- **Current use:** `findBash` in the hub (architecture.md § Settings).

## M13. Live acceptance round 2, 2026-10-03

- **Versions:** Claude Code CLI 2.1.288, VS Code 1.140.0, hub build 9ecae83cf81bd0a3.
- **Setup:** as M9, with a fresh database in `.wip/acceptance-home/.switchboard`, the GitHub source disabled, ad-hoc in `.wip/mech`, and the operator's Zoho and Forum settings, read-only. The instance's window had `.wip/mech/other` open, so sessions in `.wip/mech` came from another folder. The acceptance hook entries were removed afterwards, leaving `~/.claude/settings.json` byte-identical to its copy from before the run. Screenshots are in `.wip/acceptance2/`.
- **Launch:** a shell inside VS Code carries `ELECTRON_RUN_AS_NODE` and `VSCODE_*` variables; `Code.exe` started with them runs as Node and exits. Clear them before starting the acceptance instance.
- **Trust:** Claude trusts a folder only by its own entry, not a trusted parent. A session in the untrusted `.wip/mech/other` failed with the trust message, so the sessions ran in the trusted `.wip/mech`.
- **1. Open in VS Code from another folder: pass.** Open on a done ad-hoc item opened a `.wip/mech` window in the acceptance instance; the operator's instance kept its own three windows. That window claimed the pending open and showed the item's last session in a Claude tab with its history. A second Open added no window and no tab.
- **2. Approval report: pass.** The session wrote `approval.txt` (`draft`) and reported approval with a prompt and a summary. The item showed Awaiting approval with the summary and an Approve control. Approve started a second session with the stored prompt; it appended `approved` and reported done, and the item ended Done.
- **3. Pool and icebox: pass.** The pool listed Zoho 6 and Forum 7, each triaged into `support:case` with a summary, oldest first by `sortAt`, in the same order as the hub's snapshot. Icebox moved a ticket to a collapsed Icebox group (Pool 12, Icebox 1); Restore returned it to its place by `sortAt` (Pool 13). No pick, approval or start ran on a pool ticket.
- **Current use:** the open and claim path, approval reports, and the pool display (architecture.md § Flow, § Rows).

## M14. Zoho scope entry from ticket history

- **Date:** 2026-10-04.
- **Versions:** Zoho Desk REST API v1, the operator's `desk-token.sh` runner.
- **Experiment:** read-only GETs: one page of `/tickets/search?status=Open`, then `/tickets/{id}/history?limit=100` for its 3 Support tickets.
- **Result:**
  - Search rows carry `modifiedTime` and `status`; every row on the page had status and status type `Open`.
  - History changes name the field `Escalation` (not `cf_queue`) and `Status`, with `oldValue` and `newValue` as labels, such as `General -> Support` and `Deferred -> Open`.
  - Deferred returns to Open on its own at 08:00 UTC. One ticket moved Open → Deferred → Open 3 minutes apart, 6 hours after its escalation, so its scope entry is the return to Open.
  - History pages with `from`, counting from 1: `from=1` returns the same page as no `from`, and `from=101` the next 100. One ticket had 121 events.
- **Current use:** the Zoho source's scope entry (architecture.md § Settings).

## M15. Forum scope entry from the change-history store

- **Date:** 2026-10-04.
- **Versions:** the production forum database through the operator's `run-forum-sql.sh`, database `audit`.
- **Experiment:** read-only queries on the 9 open Forum topics: each topic's `AuditEntity` rows (`EntityType = 1`) joined to `AuditScope`, then the source's scope-entry query and its `EXPLAIN`.
- **Result:**
  - The database connection reads `audit` by qualified name, so no second connection is needed.
  - `FieldNames` is comma-separated with no spaces. The insert row (`ChangeType = 1`) lists every field, `Status` included. Later rows name only the fields that changed: `Status` when a topic was resolved (`/setstatus?status=Resolved`) or reopened by a post, and `DevStatus` and `Milestone` from the GitHub webhook.
  - One topic created on 2026-09-28 was resolved on 2026-10-01 and reopened by a post on 2026-10-02 17:27; its scope entry is the reopening. One created on 2026-09-18 reached its current status on 2026-10-01.
  - The query in the source matches `Status` only, by the operator's definition of Forum scope.
  - `EXPLAIN`: a range scan on `an index on EntityType` (23 rows) and an `eq_ref` join on `AuditScope`'s primary key. The query took about 5 seconds, mostly the runner's start.
- **Current use:** the Forum source's scope entry (architecture.md § Settings).

## M16. Webview anchor clicks open twice

- **Date:** 2026-10-04.
- **Versions:** VS Code 1.140.0 (`07f806f9`), `resources/app/out/vs/workbench/contrib/webview/browser/pre/index.html`.
- **Inspection:** the webview host adds a `click` listener on the webview's window (`handleInnerClick`). For any trusted click whose composed path holds an `<a>` with an `href` that is not a fragment, it posts `did-click-link` with the resolved `href` and VS Code opens it. It does not check `event.defaultPrevented`, so a panel handler that calls `preventDefault` and opens the link itself opens it twice: two identical browser tabs.
- **Result:** `event.stopPropagation()` in the panel's root `click` handler keeps the event from the window, so only the panel's `openUrl` message opens the link. The panel keeps its own handler because a local file path in `href` resolves against the webview origin, which the host's open would get wrong.
- **Current use:** none since the panel was removed; the History page opens links from buttons, not anchors.

## M17. A missing or mistyped project status field

- **Date:** 2026-10-06.
- **Versions:** gh 2.100.0; project `acme/3`.
- **Experiment:** `fieldValueByName(name:"NoSuchField")` on a project item, and `repositoryOwner(login:"acme"){ ... on ProjectV2Owner{ projectV2(number:3){ field(name:$status){ __typename } } } }` with `Status`, `NoSuchField` and `Title`. Then `GithubSource.poll` with each name.
- **Result:** `fieldValueByName` with an unknown name returns null and gh exits 0, so every issue read as unassigned. `field(name:)` returns `ProjectV2SingleSelectField` for `Status` and `ProjectV2Field` for `Title`; for `NoSuchField` gh exits 1 with `Could not resolve to a Unions::ProjectV2FieldConfiguration with the name NoSuchField`. Asking for `field(name:)` on every project an issue belongs to would fail the whole search when any other project lacks the field, so the poll asks the configured project once. The poll listed 10 issues, 8 assigned, with `Status`, and failed with the missing-field and wrong-type messages for the other two.
- **Current use:** the GitHub source's field check (architecture.md § Settings).

## M18. Entering a worktree: EnterWorktree versus resume

- **Date:** 2026-10-06.
- **Versions:** Claude Code CLI 2.1.291, updated to 2.1.292 during the run.
- **Experiment:**
  - `claude -p --model haiku` in a scratch repo, calling EnterWorktree on a linked worktree outside `.claude/worktrees/` under `--permission-mode bypassPermissions`, `auto`, and `auto` with `--allowedTools EnterWorktree`.
  - In the trusted `.wip/mech`, a `--bg` session told a code word, then stopped. From a linked worktree `.wip/mech-wt`, which had no trust entry of its own, `claude --bg --resume <sessionId> --permission-mode auto --settings <json>` asked for the code word, `pwd` and a Write in the worktree. This was done once after `claude stop` alone and once after `claude stop` and `claude rm`.
- **Result:**
  - EnterWorktree on a path outside `.claude/worktrees/` ran without a prompt under `bypassPermissions`. Under `auto`, with or without the allow rule, it asked: "Enter the worktree at …? This moves the session's working directory and write access there, and loads project configuration (CLAUDE.md, settings) from that location." An unattended session in auto mode waits at that prompt.
  - The resumed session kept the conversation, ran in the worktree (`pwd`, roster `cwd`) and wrote there in auto mode with no prompt. The worktree inherited the main checkout's trust, as GC found.
  - After `claude stop` alone, the resume printed ``note: session 68838687 is already running in the background, so this started a copy as 4df6b678`` and ran under a new session ID, with its transcript in the worktree's project directory.
  - After `claude stop` and `claude rm`, the resume kept the session ID and short ID. The roster listed it with the worktree as `cwd` and `kind: background`. The transcript stayed in the original directory's project directory, with each entry's `cwd` set to the directory it ran in.
  - A `--bg` session in `.wip/mech` under `auto` wrote and then edited a file in a sibling folder outside its working directory, with no prompt. Support relies on this: its sessions stay in `D:\git\support` and `/support-fix` works in its widgets worktree by absolute path.
- **Ground Control:** GC never entered a worktree inside a session. A worktree run went first, and the action then started as a new session in the worktree it reported (GC R46).
- **Current use:** Switchboard sessions do not call EnterWorktree or resume in another directory. `dev:develop`, `dev:qa-failure` and `dev:qa-question` require a worktree, so a setup session creates it and the skill starts inside it, as in GC. `/sb-route` creates a worktree when its own work changes code and edits it by absolute path, as `/support-fix` does. Because resuming a live session starts a copy, Open in terminal never resumes a session that is still live (architecture.md § Claude Code runner); a session live in a VS Code tab was not tested.

## M19. Forking a session for a friction debrief

- **Date:** 2026-10-06.
- **Versions:** Claude Code CLI 2.1.292.
- **Experiment:** in the trusted `.wip/mech`, a `--bg --model haiku` session ran two Bash calls and ended its turn (roster `state: done`, with a pid). It was forked with `claude -p --resume <sessionId> --fork-session --session-id <uuid> --no-session-persistence --output-format json`, the prompt on stdin and `FRICTION_DEBRIEF=1`, once while its process was listed and once after `claude stop`. Then `runDebrief` from the built `packages/claude` forked the stopped session with the operator's friction-review prompt.
- **Result:**
  - Both forks exited 0. Ground Control found a live `--bg` job refusing `-p --resume` (GC M64); on this version a background session that has ended its turn can be forked while its process is listed.
  - Output is an array of stream events (`system`, `assistant`, `rate_limit_event`, `result`). The `result` text came wrapped in a `json` code fence. Cache reads were 45,789 and 48,955 tokens; costs $0.013 and $0.11.
  - No transcript was written for the fork's ID, the original transcript was unchanged, and Switchboard's activity directory had no marker for it. After `claude stop` the roster no longer listed the session.
  - `runDebrief` returned `{"friction": [], "cache": {"read": 48955, "created": 2353, "costUsd": 0.115}, "subagents": []}`.
  - From the hub (an isolated home with `sessions.debriefs` on): an ad-hoc session in `.wip/mech` made 16 tool calls, delegated one Codex task through agent-delegate and reported done. The next scan, 2 minutes after the start, forked it with no wait because its work item was done: one friction report, $0.72, cache read 69,695 tokens. The Codex thread was asked right after through `debrief.mjs` and answered with no friction. The log got a `claude` line naming the thread in `delegated` and a `codex` line with the session as parent; `store.mjs input analysis` read both. A restarted hub ran a scan and asked neither again. An unknown thread made `debrief.mjs` exit 3.
- **Not verified:** a fork that messages subagents (GC M64 verified it on CLI 2.1.286).
- **Current use:** friction debriefs (architecture.md § Friction debriefs). The hub skips a session the roster lists with a pid only when it is not idle.

## M20. Git Bash rewriting report arguments

- **Date:** 2026-10-07.
- **Versions:** Claude Code CLI 2.1.292, Git for Windows 2.53 at `C:\Program Files\Git`, Windows 11.
- **Observation:** the approval prompts of two widgets work items were stored as `C:/Program Files/Git/legacy-ship 16416` and `C:/Program Files/Git/address-feedback 19703 publish`. The sessions ran the report command with Claude Code's Bash tool, which is Git Bash.
- **Experiment:** in Git Bash, `node -e … -- --prompt "/legacy-ship 16416" ~/x.ps1` printed `["--prompt","C:/Program Files/Git/legacy-ship 16416","C:/Users/operator/x.ps1"]`; with `MSYS_NO_PATHCONV=1` it printed `["--prompt","/legacy-ship 16416","/c/Users/operator/x.ps1"]`. The `--prompt=/…` form is rewritten too. In Git Bash `MSYSTEM` is `MINGW64` and `cygpath -m /` prints `C:/Program Files/Git/`.
- **Not covered:** a prompt that starts with `/` and also holds a URL is rewritten further (`https://` becomes `https;\\`), and a `--summary`, stage or link label starting with `/` is rewritten too; the CLI restores neither. A prompt holding `pr:123` is not rewritten at all. The skills' prompts (`/sb-ship <issue>`, `/<skill> <issue> publish`, `/review-pr pr:<pr> publish`) are restored or left intact. The `sb-session-reports` skill already tells sessions to report through `pwsh`; the two sessions above did not.
- **Limitation:** `MSYS_NO_PATHCONV=1` for a whole session would also stop the rewrite of paths such as `~/…` that sessions pass to native programs like `pwsh -File`, so it is not set.
- **Current use:** under Git Bash (`MSYSTEM` set), the report CLI asks `cygpath -m /` for the root and turns an approval prompt that starts with `<root>/` back into `/…` (architecture.md § Session reports).

## M21. VS Code Git API and the multi-diff editor

- **Date:** 2026-10-07.
- **Versions:** VS Code 1.141.0 (`2a59476c`), the version installed and the one the integration suite runs. Copied from GC M30 (VS Code 1.136.1).
- **Source (GC M30):** no built-in command combines a branch's commits with uncommitted work, so the caller combines merge base to HEAD, the index and the working tree. `_workbench.openMultiDiffEditor` takes `{multiDiffSourceUri, title, resources}`, each resource an `originalUri` and `modifiedUri` with a missing side undefined; it is a private command. A revision is a `git:` URI whose query is `JSON.stringify({path, ref})`. `git.openRepository` takes a path string and keeps the repository in Source Control for the window's lifetime, with no matching close. A newly opened repository's resource groups are empty until `await repository.status()`. Repository lookup falls back to a prefix match or the window's only repository. `getBranchBase` writes `branch.<name>.vscode-merge-base` to the git config. `Change.originalUri` differs for copies as well as renames. The editor appends the file count to the title, and `TabInputTextMultiDiff.textDiffs` lists only two-sided rows.
- **Experiment:** [changes.test.cjs](../extensions/switchboard/test-integration/changes.test.cjs) builds a clone with `origin/main` and a worktree holding a committed edit, addition and deletion, an untracked file, a staged edit deleted on disk, and a staged rename. Show in Source Control added the worktree to the Git API's repositories. Open Changes opened one editor titled `gh 18941 Inbox badge — since <base> (5 files)`, whose one two-sided row ran from `kept.txt` at the base (`git:`) to `renamed.txt` on disk (`file:`), both inside the worktree. A plain folder got the no-repository warning and no editor. A second `_workbench.openMultiDiffEditor` call with the same source URI and more resources kept the open editor's title and resources (a Codex probe on this version), so each open uses a new source URI after closing the ticket's earlier tab; reopening after adding a file and changing the title showed one tab with 6 files, and reopening on a worktree with no changes closed it. Conflicted files are in the repository's `mergeChanges` group, not the working-tree group.
- **Current use:** Open Changes (architecture.md § VS Code extension). Re-verify after a VS Code upgrade by running the integration suite.

## M22. Opening a `vscode://` link from Chrome

- **Date:** 2026-10-07.
- **Versions:** VS Code 1.141.0 (`2a59476c`), `resources/app/out/mainImpl.js` and `out/vs/workbench/workbench.desktop.main.js`. Chrome was not inspected.
- **Inspection, VS Code:**
  - The main process registers itself for the product's `urlProtocol` (`vscode`) with `app.setAsDefaultProtocolClient` only when it is not portable, which is why the integration suite's portable VS Code leaves the operator's registration alone. A launch with `--open-url` and no window opens an empty window first, then handles the URI.
  - `URLHandlerRouter.routeCall` sends a URI whose query has `windowId=<n>` to that window; any other goes to the active window, which the main process tracks as the last focused main window. Switchboard's URIs carry no `windowId`, so the last focused window gets them, whatever folder it has open.
  - In that window, `ExtensionUrlHandler.handleURL` asks "Allow '<extension>' extension to open this URI?", with a "Do not ask me again for this extension" checkbox, unless the extension is in the product's trusted handlers, in the user's `extensions.confirmedUriHandlerExtensionIds` setting, or was trusted through that checkbox, which the profile's storage keeps. It then activates the extension with `onUri:<id>` and passes the URI once the extension registers its handler, buffering it for up to 5 minutes.
  - `URI.parse` percent-decodes each component, so the handler's `uri.query` is decoded once.
- **Integration suite:** calling the handler through the extension API with an encoded GitHub issue URL in another case and with `/files`, and with a URL holding `?id=5&x=1`, revealed the matching rows and ran their click actions (`open.test.cjs`).
- **Not verified:** no `vscode://` link was opened from Chrome, because that would open the operator's own VS Code. Chrome's own documentation and behavior, not checked here, describe an "Open Visual Studio Code?" prompt for an external protocol with an "Always allow github.com to open links of this type" checkbox for an https page; whether it appears every time for the operator is unknown. Whether VS Code brings the receiving window to the front was not observed.
- **Current use:** Open in Switchboard (architecture.md § VS Code extension, § Chrome extension). The operator can avoid VS Code's prompt with `"extensions.confirmedUriHandlerExtensionIds": ["switchboard.switchboard"]`.

## M23. Requests from an extension service worker and from a web page to the browser endpoint

- **Date:** 2026-10-07.
- **Versions:** Playwright's Chromium 151.0.7922.34 (`ms-playwright/chromium-1234`), headless, through playwright-core from `@playwright/cli`; Node 24.14.0 for the endpoint.
- **Experiment:** the built extension (`extensions/chrome/dist`) was copied with its host permission and endpoint port changed to a test port and its content script also matched on a test-owned page server, then loaded with `--load-extension`. The test port served the built `listenBrowser` with a fake snooze that knew one URL; `diagnostics_channel` `http.server.request.start` logged every request's method, path, `Origin`, `Content-Type` and `Access-Control-Request-*` headers. A page on `http://localhost:<other port>` served the recorded column. The script hovered a card, clicked the bell and a choice, then a choice on a card the fake did not know. A second page on the same other origin then called the endpoint with `fetch` in `cors` mode with `Content-Type: application/json`, in `no-cors` mode with JSON and with `text/plain`, a `cors` `GET /snoozed`, and `navigator.sendBeacon` with an `application/json` Blob.
- **Result:**
  - The service worker's `POST /snooze` went out with no preflight, `Origin: chrome-extension://<extension id>` and `Content-Type: application/json`. Its `GET /snoozed` carried no `Origin`. After the 200 the board read `/snoozed` again and hid the card (`display: none`). The unknown card's menu showed the hub's 404 text.
  - The page's `cors` JSON POST sent only an `OPTIONS` preflight (`Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: content-type`), and `fetch` rejected with `TypeError: Failed to fetch`; no POST reached the endpoint. `sendBeacon` with a JSON Blob returned true and likewise sent only the preflight.
  - The page's `no-cors` POSTs reached the endpoint with the page's `Origin` and `Content-Type: text/plain;charset=UTF-8` (the JSON type is dropped) or `text/plain`, and the page got an opaque response. The hub's Origin and content-type checks refuse both.
  - The page's `cors` `GET /snoozed` reached the endpoint and `fetch` rejected, because the reply has no CORS header.
- **Not verified:** the operator's branded Chrome (154), which no longer accepts `--load-extension`, so the extension was not loaded there; a page on a public origin such as `https://github.com`, because the experiment's page was on a loopback origin, to which Chrome's local network access rules for public pages do not apply; and GitHub's live board DOM. The experiment ran before the button was limited to cards that `GET /cards` lists; that limit is tested in jsdom only.
- **Current use:** the hub's `POST /snooze` checks (architecture.md § Hub lifecycle) and the extension's snooze request (architecture.md § Chrome extension).

## M24. The background service's job state and `reply` request

- **Date:** 2026-10-09.
- **Versions:** Claude Code CLI 2.1.295 (07e8f67), Windows 11.
- **Inspection:** `claude.exe daemon run` owns every `--bg` session; each runs as an interactive session in a PTY host (`claude.exe --bg-pty-host \\.\pipe\cc-daemon-<hash>-pty-<short> …`). `claude attach` relays that terminal's bytes. The service listens on `\\.\pipe\cc-daemon-<hash>-control` for newline-delimited JSON `{proto: 1, op, …}` (ops include ping, list, reply, kill), authenticated by the text of `<Claude config dir>/daemon/control.key`. Each session also has an authenticated, single-client worker pipe `-rv-<short>` between the service and the session; connecting to it would evict the service.
- **Experiment:** `haiku` sessions in `.wip/mech`, started with Switchboard's start arguments, each asked an `AskUserQuestion`. While one waited, its roster entry was `kind: background`, `status: waiting`, `state: blocked`, and `<config dir>/jobs/<short>/state.json` held `tempo: "blocked"`, `needs` (a one-line summary of the first question) and `block.questions[]`, each with `question` and `options[{label, description}]`; no `header` or `multiSelect`, which only the transcript's `tool_use` input has. Then `{"proto":1,"op":"reply","short":"<short>","text":"<answer>","auth":"<control.key>"}` on the control pipe.
- **Result:**
  - The reply returned `{"ok":true,"op":"reply"}`. The transcript recorded a real `tool_result` (`Your questions have been answered: "<q>"="<label>"`), and the session continued in its background process with the same pid and its earlier context.
  - A label matches case-insensitively; text matching no option is accepted as free text.
  - With two questions in one call, the reply answered only the first; the tool returned at once and the second question was lost.
  - A reply while the session is idle runs as its next prompt; a reply during a running tool is queued and absorbed into that turn.
- **Limits:** the pipe name, the frame, the key, the job state's shape and how a reply resolves to an answer are undocumented and can change with any CLI update. Only one control pipe was listed; how its hash is derived was not inspected.
- **Current use:** none. Switchboard does not read the job state or send `reply`; the operator answers in Claude (PRD R70).

## M25. Opening a waiting session in a Claude tab

- **Date:** 2026-10-09.
- **Versions:** Claude Code CLI 2.1.295, Claude Code extension 2.1.295, VS Code 1.141.0, an isolated VS Code instance driven over its debugging port. The operator's Claude settings had `permissions.defaultMode: "auto"`.
- **Experiment:** a `--bg` session in `.wip/mech` remembered a code word and waited on an `AskUserQuestion`. `claude stop <short>`, then `claude-vscode.primaryEditor.open(<session ID>)` in a window on `.wip/mech`. Repeated with a session started in `--permission-mode default`.
- **Result:**
  - After the stop the roster no longer listed the session; `--all` showed `state: "stopped"` with no pid (M5 recorded `done` on 2.1.288). The transcript ended with the unanswered `tool_use`.
  - The tab showed the history and asked the question again with its options and Other. The roster listed the same session ID as `kind: interactive` with a new pid and no short ID.
  - On the answer, the CLI recorded a synthetic error `tool_result` ("Tool call interrupted…"), an assistant "No response requested.", then the answer as the user message `Answering your earlier question "<q>": <answer>`. The session used its earlier context and kept its session ID. The hook markers ran in the tab's process.
  - The tab ran in the operator's default mode (`auto`) both times, not the mode the session started with.
- **Current use:** Open in Claude (PRD R70).

## M26. Finding, docking beside and switching to VS Code windows

- **Date:** 2026-10-09.
- **Versions:** Windows 11 Pro 10.0.26200, VS Code 1.141.0, Claude Code extension 2.1.295; a C# .NET 10 probe using Win32 (`.wip/spike-switcher/`), first on one 1920×1200 monitor at 96 DPI, then at the console with three monitors.
- **Experiment:** isolated VS Code windows opened from `.code-workspace` files, a probe that docked itself as an app bar and brought windows forward 20 times per method, with and without a click on the probe and with another app in front.
- **Result:**
  - A `window.title` setting in a `.code-workspace` file applies to that window and is the Win32 title, such as `sb:gh-1001 · <file> - gh-1001 (Workspace)`; without `${dirty}` nothing comes before it, and the active editor changes only the text after it. A new window shows `Visual Studio Code` for about 0.5 s first. All windows of a VS Code instance share one process, so only the title tells item windows apart.
  - Two workspace files on one folder open as two windows; opening either file again, with `code <file>` or with `vscode.openFolder` and `forceNewWindow` from an extension, focuses its window. The Claude extension lists the same folder's sessions in both.
  - After a click on the probe, `SetForegroundWindow` brought a window to the front 20/20 within 15 ms, after `ShowWindow(SW_RESTORE)` for a minimized one; `code <workspace>` worked 20/20 in about 300 ms. While another app had the last input, `SetForegroundWindow` failed 60/60 and only flashed the taskbar button, and VS Code's own focus flag still read true, so the result is checked with `GetForegroundWindow`. `code <workspace>` from the background worked 20/20 at the console with no one typing.
  - A 300 px `ABE_LEFT` app bar set the work area to start at x = 300 within 0.9 s, moved a window that overlapped it, and a maximized VS Code window filled the rest exactly. `ABM_REMOVE` restored the work area. A placed window needs the DWM frame correction of 7 px.
  - Source inspection of `workbench.desktop.main.js`: the title template reads every `$` as the start of a variable and drops the text from it to the next `}`, or to the end without one; it has no escape. `${separator}` (`window.titleSeparator`) shows only between two non-empty parts. The full title adds `🔴 ` before the template while a paused debugger's window is unfocused, ` [Administrator]` after it when elevated, and `${separator}${activeEditorState}` after it when screen-reader optimization is on and the template lacks it; Restricted Mode does not change it.
  - 2026-10-10, VS Code 1.141.0: `WM_CLOSE` to a VS Code window, which closes it as its close button does while other windows stay open, raised `EVENT_OBJECT_HIDE` then `EVENT_OBJECT_DESTROY` for its top-level handle with `OBJID_WINDOW` and `CHILDID_SELF`, both within 1 ms, to an out-of-context `SetWinEventHook`. The title cannot be read after the destroy. A new window raised `EVENT_OBJECT_NAMECHANGE` with `OBJID_WINDOW` when its title changed to the folder's.
  - Source inspection: a workspace is trusted only when each folder and the `.code-workspace` file are trusted, each by its own entry or a trusted parent folder. Trusting a window from its prompt adds an entry for each, so a new item window prompts again unless the folders that hold the worktrees and `<Switchboard home>/windows` are trusted. Trusted folders are VS Code application state (`content.trust.model.key`), with no extension API to add one.
  - 2026-10-11, Avalonia 12.1.3, monitors at 96, 120 and 144 DPI: moving the dock with `SetWindowPos` to a monitor at another scale sends `WM_DPICHANGED` after its `WM_SIZE`. Avalonia takes the new scale there and calls `SetWindowPos` with Windows' suggested size, which the dock holds to its strip, so no `WM_SIZE` follows; Avalonia updates its client size only on `WM_SIZE`, so it kept the size computed at the old scale and drew a smaller or clipped list until the next resize. Sending `WM_SIZE` with the current client size after Avalonia handles `WM_DPICHANGED` fixed it: started from the 120 DPI primary, the dock filled its strip at the left edge at 96 DPI (320×1392) and the right edge at 144 DPI (480×1368).
- **Limits:** display scaling other than 100% (the dock's own resize was seen at 175% in use, where Avalonia sized it one pixel short) is untested beyond the result above, and live docking during a drag of the header has not been observed, as is `vscode.openFolder` focusing a window while another app has the last input, the destroy event when closing the last window ends the VS Code process, and the name change when an open window opens another workspace.
- **Current use:** the dock and item windows, and the extension's row click for a notification or Open in Switchboard (PRD R65, R69, R71; architecture.md § Dock, § VS Code extension).

## M27. Opening a URL in VS Code's integrated browser

- **Date:** 2026-10-09.
- **Versions:** VS Code 1.141.0 (`2a59476c`), installed and in the integration suite.
- **Inspection:** `workbench.desktop.main.js` registers `workbench.action.browser.open` ("Open Integrated Browser"). It takes a URL string or `{url, openToSide, reuseUrlFilter}`. With `reuseUrlFilter`, it looks for an open browser tab whose URL matches the filter's scheme, authority and path, and whose query holds the filter's parameters; it navigates that tab to `url` and shows it instead of opening another. Otherwise it opens a browser editor in the group the integrated browser prefers (`workbench.browser.newTabPlacement`, `activeGroup` by default). The command is not part of the extension API. `workbench.action.browser.openFile` opens a local `.html` file.
- **Experiment:** [tabs.test.cjs](../extensions/switchboard/test-integration/tabs.test.cjs) opened two pages of a test-owned loopback server, the first again, then two Markdown files and the first again with `vscode.openWith(uri, 'vscode.markdown.preview.editor', {preview: false})`, and a text file with `showTextDocument` and `preview: false`. VS Code showed two browser tabs, both loaded, neither in preview mode, so the next open did not replace them, one Markdown preview editor tab (`TabInputCustom`, view type `vscode.markdown.preview.editor`) per file, not in preview mode, and the text file in a pinned editor. `markdown.togglePreview` on a preview editor tab turned it into the file's text editor in the same tab, leaving one tab. `markdown.showPreview` opens a separate webview panel instead, so editing the file adds a text editor tab, and an unlocked one is reused for the next Markdown file. Without `reuseUrlFilter` the third open added a third browser tab. A browser tab's `Tab.input` is undefined in the extension API.
- **Not verified:** pages that need the operator's sign-in, such as GitHub and Zoho Desk, in the integrated browser's own storage (`workbench.browser.dataStorage`); the first VS Code version with the command.
- **Current use:** item window tabs (PRD R72; architecture.md § VS Code extension).

## M28. The Switchboard tab group for links the dock opens

- **Date:** 2026-10-10.
- **Versions:** Playwright's Chromium 151.0.7922.34 (`ms-playwright/chromium-1234`), headless, through playwright-core from `@playwright/cli`.
- **Experiment:** the built extension (`extensions/chrome/dist`) was loaded with `--load-extension`, and the context routed every request to a stub page, counting requests, so nothing reached the network. From an unmarked pull request tab, a page's `window.open` opened each link in a new tab, as Chrome creates one for a link from Windows: a pull request with `#switchboard-tab`, an issue with `?switchboard-tab=1#issuecomment-1`, then, after `ServiceWorker.stopAllWorkers`, a second pull request with `#switchboard-tab`. The script then went back in the second pull request's tab, opened an issue with `#switchboard-tab`, and reloaded the pull request tab, reading every tab's index, group and URL from the service worker after each step. Earlier scripts read the group's title and colour, `history.length` after the bookmark's removal, and loaded `https://x.test/a` from `https://x.test/a#b` with `tabs.update`.
- **Result:**
  - The first marked link created a group titled Switchboard, coloured cyan, after the unmarked tab, with the tab at `…/pull/2#`; its page was requested once and got a `hashchange` to the bare `#`.
  - The query-marked issue joined the group as `…/issues/3#issuecomment-1`; it was requested twice, with and then without the parameter, because removing the parameter restarts the load.
  - After the worker was stopped, the second pull request woke it, joined the group, took the first pull request's index, and the first closed. The unmarked pull request tab stayed outside the group throughout.
  - Removing the bookmark adds a history entry: Back showed `…/pull/4#switchboard-tab`. The reload there removed the bookmark again and placed nothing, and the marked issue replaced the grouped issue.
  - Loading `https://x.test/a` from `https://x.test/a#b` requested the page again, so removing the bookmark keeps a bare `#`.
  - With the network on and no Zoho sign-in, a marked `desk.zoho.com/agent/acme/acme-inc/tickets/details/<id>` link was redirected to `desk.zoho.com/support/login.sas?serviceurl=…`, so a kind read from the tab's address no longer matched the next Zoho link, and the operator saw a second Zoho tab in their Chrome. With the kind recorded in `chrome.storage.session`, a second link opened after `ServiceWorker.stopAllWorkers` replaced the first tab, and session storage held only the new tab's `placedKind:<id>` key.
  - A link opened in the first moments after the extension was installed, before its worker had started, was not placed.
- **Not verified:** a link from the dock through Windows' URL handler to Chrome; the operator's branded Chrome, which no longer accepts `--load-extension` (M23); how GitHub, Zoho Desk and Forum treat the marks when the extension is missing; whether Chrome warns before an extension closes a tab with unsaved changes; where Zoho Desk takes a signed-in agent's link; Duplicate, Reopen closed tab or session restore of a tab whose current entry still has the bookmark, as after Back to it, which would be placed again.
- **Current use:** the Switchboard tab group (PRD R74; architecture.md § Chrome extension).

## M29. Opening a new Claude session in a tab without changing the preferred location

- **Date:** 2026-10-10.
- **Versions:** Claude Code extension 2.1.296 (`extension.js`); Ground Control M63 inspected the same argument on 2.1.284.
- **Inspection:** the extension contributes `claude-vscode.editor.open` and registers it as `(sessionId?, initialPrompt?, viewColumn?, newSessionGroupId?, fullEditor?, {programmatic}?)`. With any `programmatic` value it never writes `claudeCode.preferredLocation` and does not focus the input box; with no session ID, `pin-to-panel` opens an editor tab, and `honor-preferred-location` uses the sidebar when the setting is `sidebar` and no tab holds the session; `createPanel` shows a session the sidebar already holds there. Without `programmatic` it opens a tab, focuses the input, and sets the preference to `panel` unless `fullEditor` is true or the session is shown in the sidebar. With no session ID it starts a new session; an open session's tab is revealed instead. The extension activates `onStartupFinished`, and executing its contributed command activates it earlier.
- **Experiment:** the operator's Support bridge extension (`D:\git\support\extensions\session-launcher`) made the same `pin-to-panel` call from a title-bar button until it moved here; its README (support commit `e543213`) recorded that on 2.1.286 the call opened a tab and left the setting alone. The operator's `preferredLocation` is `sidebar`.
- **Not verified:** the call from Switchboard's installed extension; the argument order is undocumented and can change with any Claude Code extension update.
- **Current use:** New Claude Session in Editor Tab (PRD R75; architecture.md § VS Code extension).

## M30. The report contract in the system prompt, across resume and compaction

- **Date:** 2026-10-10.
- **Versions:** Claude Code 2.1.296.
- **Experiment:** in the trusted `.wip/mech`, Haiku sessions started with `claude --bg --append-system-prompt "<contract with a code word>" "Reply with exactly: ready"`, stopped, then asked for the code word through `claude -p --resume <id>` with no append flag:
  - Before any compaction, the session knew the code word and quoted the line from its system prompt; the transcript holds a `prompt_snapshot` entry.
  - After `/compact` in a `-p --resume` process without the flag, it did not.
  - After `/compact` in the background process woken by `claude --bg --resume <id>`, which reported "woke session … with its saved options (--permission-mode, -n, --append-system-prompt, --model)", a later `-p --resume` without the flag did not know it either.
  - With a project `SessionStart` hook, matcher `compact`, printing `{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: <contract>}}`, a `/compact` saved a `hook_additional_context` entry after the compaction boundary, and a later `-p --resume` without the hook knew the code word, citing the hook's context.
  - The built `contract.mjs`, registered as `{command: "node", args: [<path>], timeout: 10}` and pointed at a stand-in hub through `hub.json`, posted the session ID with the token on `/compact`, and a later resume without the hook knew the code word the stand-in returned.
- **Result:** Claude records the rendered system prompt, `--append-system-prompt` text included, on the first request and resends it on every later request and resume, as `--system-prompt-snapshot on` (the default) describes, until a compaction. After a compaction the next process renders it again from its own flags. `claude --bg --resume <id>` with any flag starts a copy of a background session; without flags it reuses the saved ones. Git Bash rewrites a `/compact` argument into a Windows path (M20).
- **Not verified:** a resume or compaction in a VS Code Claude tab; an automatic compaction.
- **Current use:** the start command and the contract hook (architecture.md § Claude Code runner, § Playbooks).

## M31. Codex sessions: `codex exec`, resume, hooks and the VS Code panel

- **Date:** 2026-10-10.
- **Versions:** Codex CLI 0.160.0 (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`), VS Code 1.141.0, Codex extension `openai.chatgpt` 26.1007.21434, Windows 11. Ground Control verified the same mechanisms on CLI 0.153.4 and extension 26.901 (GC M39–M55). Scripts and outputs are in `.wip/codex-spike/` (`report.md` lists each experiment); experiments that changed hooks used an isolated `CODEX_HOME` with a copy of `auth.json`.
- **Start.** `codex exec --json <options> -C <cwd> -- <prompt>`, spawned without a shell and stdin ignored, prints JSONL: `thread.started {thread_id}`, `turn.started`, `item.completed` items (an `error` item is a warning, such as a clamped hook timeout or an unknown config key), then `turn.completed` or `turn.failed {error: {message}}`, and exits 0 or 1. A failed API call's message is the API's error JSON. The thread ID is a UUIDv7 whose first 8 hex digits cover about 65 seconds, so no abbreviation is unique. One rollout per thread under `<CODEX_HOME>/sessions/YYYY/MM/DD/`; resume appends to it. A detached spawn with its output in files keeps running after its parent exits. Outside a git repository Codex refuses at once with exit 1 and `Not inside a trusted directory and --skip-git-repo-check was not specified.`, but not with `--dangerously-bypass-approvals-and-sandbox` (M32); in a fresh untrusted repository it ran, so Codex has no counterpart of Claude's directory trust refusal.
- **Contract.** `-c developer_instructions="<text>"` (a TOML string) becomes the thread's first developer message; the prompt is the only user message. Resume replays it, and passing it again with the same text adds no second message. A compaction rebuilds the developer instructions from the config, so a process resumed without the flag loses them (the model recalled them only through the encrypted compaction summary). A `SessionStart` hook printing `{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext}}` adds a developer message; with a hook that printed only for `source: "compact"`, the text was added once after a forced compaction (`-c model_auto_compact_token_limit=12000`), and a later resume without it still followed it.
- **Permission modes**, through `modeArgs` in `packages/codex/src/args.ts`, each fresh start and its resume running a workspace write and an HTTPS call, recorded in `out/gate-modes-*.json` with the rollout's turn context: `auto` → `on-request`, reviewer `auto_review`, `workspace-write`, network on (`--approve-for-me` plus network), the writes succeeded; `plan` → `never`, `read-only`, the writes were denied; `dontAsk` → `never`, `workspace-write`, network on, the writes succeeded; `bypassPermissions` → `danger-full-access`, the writes and calls succeeded. The resumed turns had the start's turn context. Resume keeps the sandbox but takes the approval policy from the config unless the run passes it again, and takes `-c`, `-m` and `--dangerously-bypass-approvals-and-sandbox` but not `-s` or `--approve-for-me`, so every run passes the mode as `-c` overrides.
- **Credentials in the sandbox.** Under `auto` and `dontAsk`, with the network on, DNS and unauthenticated HTTPS worked but `gh api user` answered 401 and `curl` failed TLS with `SEC_E_NO_CREDENTIALS`: commands in the Windows sandbox cannot use the operator's credential store. Under `auto` the model asked to escalate a refused network call in one run, which the reviewer approved, and not in two others. Under `bypassPermissions` both worked (`gh` as `work-login`). So a playbook whose skills call `gh` or other signed-in tools runs only in `bypassPermissions`.
- **Skills.** Codex lists `~/.claude/skills` among its skill roots, so the operator's skills need no linking. A prompt starting `$<skill>` injects the skill; a literal `/<skill>` made the model try to read the SKILL.md, which the read-only sandbox refused.
- **Hooks.** `<CODEX_HOME>/hooks.json`; payloads carry `session_id` (the thread ID), `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, and `source`, `prompt`, `trigger`, `last_assistant_message` by event, no PID. A hook runs only once trusted: `codex app-server` over stdio, `initialize`, `hooks/list` (`key`, `command`, `trustStatus` of `untrusted`, `modified` or `trusted`, `currentHash`), then `config/batchWrite` of `hooks.state` with each hash; a changed command reads `modified`. An `async: true` Stop hook did not run before an `exec` process exited; a synchronous one did. Switchboard's hook script, run synchronously from an `exec` run, recorded the PID and creation time of the run's own `codex.exe`, the same values a separate CIM query read while the run lived (`out/w2-marker.json`, `out/w2-cim.json`).
- **Process identity.** An unknown key such as `-c switchboard_run="<tag>"` is ignored with a warning item. `Get-CimInstance Win32_Process -Filter "Name='codex.exe' AND CommandLine LIKE '%switchboard_run=%<tag>%'"` found a detached run as exactly one process with its PID and creation time.
- **VS Code panel.** In an isolated VS Code with a copy of the extension, `vscode.open(Uri.parse('openai-codex://route/local/<thread>'))` opened one tab (`chatgpt.conversationEditor`, label `Codex`) showing an `exec` thread's whole history, and opening it again kept one tab. A follow-up typed there ran as the same thread's next turn, with SessionStart `resume`, UserPromptSubmit and Stop hooks from the extension's own `codex.exe app-server`, which lives as long as the window. Opened while an `exec` run still held the thread, the panel showed "This is open in another app. Close it there to continue here." with Retry, which loaded the thread once the run exited. The extension has no command that opens a thread by ID.
- **Fork.** `codex exec fork <thread> --ephemeral --json -- <prompt>` answered from the thread's history in a new thread and wrote no rollout; the original rollout was unchanged. `codex exec fork --json --ephemeral -c approval_policy="never" -c sandbox_mode="read-only" <thread> -` read its prompt from stdin and answered it (`out/f2-fork.jsonl`).
- **Questions.** A background run cannot wait on the operator: `request_user_input` is behind the `default_mode_request_user_input` feature, under development and off.
- **Not verified:** the panel's hook PID walk; the panel's `PermissionRequest`; a panel thread's markers when its window closes without SessionEnd.
- **Current use:** the Codex runner (architecture.md § Codex runner).

## M32. Live acceptance of Codex sessions, 2026-10-11

- **Versions:** Codex CLI 0.160.0, VS Code 1.141.0, Codex extension `openai.chatgpt` 26.1007.21434, Windows 11, model `gpt-6-astra`.
- **Setup:** an isolated hub (`.wip/codex-accept/home`) with `sessions.provider: codex`, `installHooks` and `debriefs` on, the default `bypassPermissions`, ad-hoc prompts in a scratch git repository; an isolated `CODEX_HOME` (a copy of `auth.json` and a two-line config) and `CLAUDE_CONFIG_DIR`, so neither the operator's Codex nor Claude settings changed. The hub was driven over its HTTP routes, with states read from its database and rows from its dock stream; an isolated VS Code ran the built Switchboard extension and a copy of the Codex extension.
- **Hooks:** at startup the hub wrote Switchboard's entries to the isolated hooks.json and the app-server trust exchange trusted all 8 of them.
- **Ad-hoc session:** the session ran, reported its stage and done, and its work item became done; the release let the exec process end and the session ended.
- **Answer on the row:** a session reported "Which color should I use?" with Red and Blue and ended its turn; the row showed Open in Codex as its main control and the two choices with the question's ID. Blue resumed the thread, a second click on Red was refused ("The answer to that question was already sent."), the session wrote `Blue` and reported done.
- **Open in Codex:** on a second question, Open in Codex blocked the work item with "Opened in Codex to answer." and ended the session, and a second open was refused. The item window claimed the session and opened it in a Codex tab (`chatgpt.conversationEditor`, `openai-codex://route/local/<thread>`) showing the question as its last message. The answer typed there ran in the panel's own process: the hub took the session as the operator's, `waiting` while the panel asked to approve each command, then running; its stage and done reports were accepted and the work item became done, and the session stayed `idle` while the window was open.
- **Contract after compaction:** a resume of a finished session's thread from a terminal with `-c model_auto_compact_token_limit=12000` compacted it; `contract.mjs` fetched the contract from the hub ("restored the report contract … after compaction"), and the rollout holds it as a developer message after the compaction.
- **Stop:** Stop on a session running `Start-Sleep -Seconds 120` ended its `codex.exe` and blocked the work item with "Stopped by you.".
- **Hub restart:** during a run, the hub process was killed; the extension started another hub, the run went on and its done report reached the new hub.
- **Outside a git repository:** in `bypassPermissions` Codex ran in a folder outside any git repository; its repository check (M31) applies only in the sandboxed modes. A folder under the Switchboard checkout counts as inside its repository.
- **Debrief:** a done session with 14 tool calls was forked at the next debrief pass after it ended; the log line has `provider: "codex"`, the turn as `throughMessageUuid` and one friction report, the state records the turn, and the fork wrote no hook marker.
- **Not verified:** a Claude and a Codex session of one ticket held by R17 (the flow rule is provider-neutral and tested in core); `plan`, `auto` and `dontAsk` through a hub; the operator's own Codex home. The hub runs for these were not exercised and rest on unit tests and M31 probes: a failed stop (`stop-failed`); a resume typed in the panel before the hub's next read; Open in Codex while the asking process is still exiting (the open ran 11 seconds after `task_complete`); the panel's writer-lock refusal and recovery (M31 probed it outside a hub). After acceptance the extension was rebuilt and reinstalled into the operator's VS Code, and the dock was published to the operator's home and restarted.

## M33. Auto-hiding the dock with a window region

- **Date:** 2026-10-13.
- **Versions:** Windows 11 Pro 10.0.26200, Avalonia 12.1.3, the published dock on one monitor at 1392 × 996 pixels, left edge.
- **Experiment:** a dock on a scratch home with `autoHide` on, driven by `SetCursorPos` and `mouse_event` from PowerShell; after each step the work area (`SPI_GETWORKAREA`), the window's rectangle and region (`GetWindowRgnBox`), the foreground window and a screenshot of the corner were read. Also a 2-pixel region set and cleared on a docked window from another process.
- **Result:** with auto-hide on the work area started at x = 0 and maximized windows filled the strip; the pin reserved it again (x = 320) and released it, over three toggles. With Notepad in front the window kept its 320-pixel rectangle with a 2-pixel region, and the screenshot showed the window behind it. `SetCursorPos` alone did not show it; a `mouse_event` move into the sliver did, and `WindowFromPoint` then returned the dock. It stayed shown with the pointer 150 pixels in, and hid 0.4 to 0.7 seconds after the pointer left. The dock's window has `WS_EX_NOREDIRECTIONBITMAP`. Before the dock called `InvalidateVisual` after clearing its region, two screenshots after a move into the sliver showed the window behind it although its region was cleared; with the call, each showed the dock. A region cleared from another process showed the dock at once, so the call's need is not settled. While the dock was active it stayed shown with the pointer away, as intended. Without a cover, the sliver showed whatever the dock drew at its outer edge: on the left the row stripes, on the right the row rules and group headings. With `SliverView`, the operator's dock on the right edge showed only the background and the focus-blue stripes of its Ready for review rows, 55 pixels each at the rows' heights.
- **Limits:** one monitor; the input-driven runs were on the left edge only, and the right edge was checked only by reading the sliver's pixels; no second auto-hide bar on the same edge, so the `ABM_SETAUTOHIDEBAREX` refusal was not seen. Showing it with Alt+Tab or a status bar click, and keeping it shown over a dialog or a tooltip, were not run. Once, during a run that also had the operator's own input, the reserved dock drew black and ignored two clicks until the operator closed it; the same toggles, clicks and Search repeated three times did not reproduce it, and the cause is unknown.
- **Current use:** auto-hide (architecture.md § Dock).

## M34. GitHub issue search lags an unassignment

- **Date:** 2026-10-13.
- **Versions:** GitHub GraphQL API through gh.
- **Source inspection:** two hand-offs whose done check polled with issue search (`assignee:` qualifiers). #18137: the operator was unassigned at 16:14:12 UTC and the done report, whose poll still listed the issue, was applied at 16:14:22. #19953: unassigned at 16:25:04, report applied at 16:25:13. Both issues' Status was a configured assigned status, so only the search's assignee match could list them, and the next scheduled polls, 88 and 38 seconds after the reports, no longer did. A direct `repository.issue` read afterwards showed no assignees.
- **Limits:** inferred from timestamps; the lag was not measured, and a direct read made within those seconds was not run.
- **Current use:** a done report whose poll still lists the ticket as assigned waits for a second poll 30 seconds later (architecture.md § Session reports).

## M35. Opening a GitHub comment as the focus

- **Date:** 2026-10-13.
- **Versions:** GitHub GraphQL API through gh; VS Code 1.141.1 test host; Playwright's Chromium through `playwright-cli` 0.1.22, headless and signed out.
- **Experiment:**
  - The GraphQL `url` of `IssueComment` and `PullRequestReviewComment` on acme/widgets issue 19504 and pull request 19515 is `…/issues/19504#issuecomment-<id>`, `…/pull/19515#issuecomment-<id>` for a pull request comment, and `…/pull/19515#discussion_r<id>` for a review-thread comment.
  - In the VS Code test host, `openTab` opened a test-owned loopback page at `…/focus#issuecomment-5` in the integrated browser; the page's script read `location.hash` as `#issuecomment-5`, and opening the same URL again reused the tab without loading the page again.
  - In Chromium, `https://github.com/cli/cli/issues/14090#issuecomment-5382045207`, the 46th of 99 comments on a page that folds comments behind two Load more buttons, loaded with that comment 77 pixels below the top of a 720-pixel viewport. `https://github.com/cli/cli/pull/14181#discussion_r3801438940`, the first comment of a resolved review thread, loaded with that comment at the top of the viewport.
- **Not verified:** scrolling inside VS Code's integrated browser on a signed-in GitHub page; an outdated review thread; a comment of a private repository.
- **Current use:** the focus URLs that triage chooses (PRD R79; architecture.md § Triage).

## Pending verification

These mechanisms are planned but not yet verified for Switchboard:

- A real pick whose `/support-process` task session claims the pool ticket through `support-bind`. By the operator's rule no test claims a case; the operator makes the first real pick.
