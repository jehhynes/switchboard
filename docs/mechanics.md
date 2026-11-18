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
- **Settings env (2026-10-21, Claude Code CLI 2.1.304):** `--setting-sources ""` also skips the `env` block of `~/.claude/settings.json`. With `ANTHROPIC_BASE_URL` only in that block, the run sent no request to the configured local endpoint and used the stored claude.ai login against `api.anthropic.com`; with `ANTHROPIC_BASE_URL` in the process environment, the same run went to the endpoint and answered.
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
- **Current use:** the runner matches the short ID and treats a session as alive only while its entry has a pid. A start is confirmed only once the entry has a pid, so a roster read during the first seconds does not end a new session. A session waiting on a prompt before it starts is the exception (M41).

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
  - `claude attach` drew its terminal UI ("Attaching…") and exited 0 when stdin closed. The session stayed listed with its pid. Interactive answering through attach is verified on Linux in M47.
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
  - 2026-11-16: `GET /tickets/{id}` on a ticket in the trash returns 200 with its last status, such as `Open`, and `isTrashed` and `isDeleted` true; `/tickets/search` omits it, and `/tickets/{id}/history` answers 404 `URL_NOT_FOUND`.
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
  - A `--bg` session in `.wip/mech` under `auto` wrote and then edited a file in a sibling folder outside its working directory, with no prompt.
- **Ground Control:** GC never entered a worktree inside a session. A worktree run went first, and the action then started as a new session in the worktree it reported (GC R46).
- **Current use:** Switchboard does not move a session into another directory. A playbook that requires a worktree gets it from a setup session, and its task session starts inside it, as in GC. Because resuming a live session starts a copy, Open in terminal never resumes a session that is still live (architecture.md § Claude Code runner); a session live in a VS Code tab was not tested.

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
- **Not covered:** a prompt that starts with `/` and also holds a URL is rewritten further (`https://` becomes `https;\\`), and a `--summary`, stage or link label starting with `/` is rewritten too; the CLI restores neither. A prompt holding `pr:123` is not rewritten at all. Prompts such as `/sb-ship <issue>`, `/<skill> <issue> publish` and `/review-pr pr:<pr> publish` are restored or left intact.
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
- **Current use:** Open in Switchboard (architecture.md § VS Code extension, § Browser extension). The operator can avoid VS Code's prompt with `"extensions.confirmedUriHandlerExtensionIds": ["switchboard.switchboard"]`.

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
- **Current use:** the hub's `POST /snooze` checks (architecture.md § Hub lifecycle) and the extension's snooze request (architecture.md § Browser extension).

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
  - 2026-10-14, the operator's hub, Claude Code CLI and extension 2.1.299, VS Code 1.141.1: the tab's process wrote a `SessionStart` marker with `source: resume`, and `claude agents --json` listed it `status: busy` while it loaded and `idle` 24 seconds later, while the tab showed the unanswered question. The answer is saved as a prompt (with a `promptId`), and an earlier answer on 2026-10-09 gave a `running` marker. Source inspection of extension 2.1.299: the tab sends the answer as a prompt, so `UserPromptSubmit` fires.
- **Limits:** the hooks run asynchronously, so a resume given its prompt at once, such as `claude -p --resume`, can write its `SessionStart` marker after `UserPromptSubmit`; the session then shows `idle` until its next marker. Switchboard starts no such resume.
- **Current use:** Open in Claude (PRD R70); a resumed interactive session with only its `SessionStart` marker is `idle`.

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

- **Date:** 2026-10-09; the glob matching and the Zoho Desk redirect on 2026-10-20.
- **Versions:** VS Code 1.141.0 (`2a59476c`), installed and in the integration suite; VS Code 1.142.0 (`6d62b1d5`) on 2026-10-20.
- **Inspection:** `workbench.desktop.main.js` registers `workbench.action.browser.open` ("Open Integrated Browser"). It takes a URL string or `{url, openToSide, reuseUrlFilter}`. With `reuseUrlFilter`, it looks for an open browser tab whose URL matches the filter's scheme, authority and path, the authority and path as globs, and whose query holds the filter's parameters; the bookmark is not compared; it navigates that tab to `url` and shows it instead of opening another. Otherwise it opens a browser editor in the group the integrated browser prefers (`workbench.browser.newTabPlacement`, `activeGroup` by default). The command is not part of the extension API. `workbench.action.browser.openFile` opens a local `.html` file.
- **Experiment:** [tabs.test.cjs](../extensions/switchboard/test-integration/tabs.test.cjs) opened two pages of a test-owned loopback server, the first again, then two Markdown files and the first again with `vscode.openWith(uri, 'vscode.markdown.preview.editor', {preview: false})`, and a text file with `showTextDocument` and `preview: false`. VS Code showed two browser tabs, both loaded, neither in preview mode, so the next open did not replace them, one Markdown preview editor tab (`TabInputCustom`, view type `vscode.markdown.preview.editor`) per file, not in preview mode, and the text file in a pinned editor. `markdown.togglePreview` on a preview editor tab turned it into the file's text editor in the same tab, leaving one tab. `markdown.showPreview` opens a separate webview panel instead, so editing the file adds a text editor tab, and an unlocked one is reused for the next Markdown file. Without `reuseUrlFilter` the third open added a third browser tab. A browser tab's `Tab.input` is undefined in the extension API. A loopback page at `/support/acme/ShowHomePage.do#Cases/dv/1019` that replaced itself with `/agent/acme/acme-inc/tickets/details/1019`, as Zoho Desk does, got a second tab when opened again with the link as its own filter, and one tab with the filter `/agent/*/*/tickets/details/1019`. On 2026-10-20 the operator's item windows held Zoho tabs at `desk.zoho.com/agent/acme/acme-inc/tickets/details/<id>`, read from their saved editor state, for tickets whose links are `ShowHomePage.do#Cases/dv/<id>`, with the same ID.
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
- **Current use:** the Switchboard tab group (PRD R74; architecture.md § Browser extension).

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

## M36. Forked Claude sessions

- **Date:** 2026-10-13.
- **Versions:** Claude Code CLI 2.1.296, Claude Code extension 2.1.296, VS Code 1.141.1.
- **Source inspection:** the extension's Fork conversation (`fork_conversation` → `Sessions.forkSession`) writes `<new uuid>.jsonl` in the project directory of the window's workspace, then copies the source's permission mode. It copies the message chain `getTranscript` returns: from the last compaction boundary for a plain fork, and back through boundaries by `logicalParentUuid` for a fork from a message; progress records are dropped. Each copied message gets a new `uuid`, `parentUuid` and `sessionId`, loses `sessionKind`, and the last one takes the current time; `requestId` and the other fields are copied, and the title becomes `<title> (fork)`. Nothing in the fork names its source.
- **Experiment:** `packages/claude/test/fixtures/fork-fixtures.mjs` ran the installed extension's own `forkSession` and `getTranscript` on synthetic transcripts: a plain fork, a fork from the first reply, and a fork after a compaction boundary, whose first `requestId` (`req_after`) is not the source's first (`req_first`). A CLI copy, which `claude --resume` of a live background session starts (M18), kept the source's uuids and `requestId`s. `CLAUDE_CODE_SESSION_ID` holds the native session ID in a Claude session's Bash tool environment.
- **Live acceptance:** an isolated hub (`.wip/acceptance-home`) ran an ad-hoc session in `.wip/mech`, which ended its turn and was released. In a separate VS Code instance with the extension under development, driven over its debugging port, the session was opened in a Claude tab and given a second prompt, then forked with Fork conversation from here on that prompt. The fork's transcript `9273f594…` had new uuids and the source's first `requestId`. After a prompt in the fork, the next roster read continued session `d6b775e2` as fork `9273f594`, with `aa2285b2` in `retiredIds`; History logged the change of `nativeSessionId` and `shortId` alone, because both copies were idle. Asked in the original tab, the original ran `report stage` and the CLI exited 3 with "Refused: Session aa2285b2 was replaced by fork 9273f594, so the report was not recorded."; the session stayed on the fork. The same report from the fork set the stage. The acceptance hub's hook entries were removed afterwards, leaving `~/.claude/settings.json` identical to its copy from before the run. Screenshots are in `.wip/fork-acceptance/`.
- **Limits:** the recordings pass messages to the methods directly, without the extension's transcript loading. Live, a fork of a session waiting in its background process, a fork after compaction and the contract restore for an unadopted fork were not run.
- **Current use:** fork detection by the first `requestId`, and the report command's `nativeSessionId` (PRD R78, architecture.md § Claude Code runner).

## M37. Registering a VS Code Claude session

- **Date:** 2026-10-14.
- **Versions:** Claude Code extension and CLI in use on the operator's machine that day, VS Code 1.141.1.
- **Experiment:** an isolated hub (`.wip/acc` in the worktree, `sessions.installHooks` off, no browser port) ran the built bundle. From the Bash tool of a Claude session in a VS Code tab on `d:\git\switchboard`, `node <home>/hub.js register --title "Register skill live check"`, then `report stage <id> "checking the roster"`, a wait of 40 seconds for a roster read, and a second `register`.
- **Result:**
  - `CLAUDE_CODE_SESSION_ID` held the tab's session ID, and `claude agents --json` listed it with a pid and no short ID, so the session's short ID became the first 8 characters of its ID.
  - The command printed `Registered as adhoc 1.` and the ad-hoc report contract. The store held a `running` work item with the stage, and the session `running`, released and external, with the roster's `cwd` (`d:\git\switchboard`, in the case the roster gives it) as its directory and the ticket's repo, after the roster read.
  - The second `register` exited 0 with `Already registered as adhoc 1.` and the same contract, and added no work item.
- **Limits:** the end of a registered session, its turn end, a compaction and the row's click were not run.
- **Current use:** the register command and `ClaudeRunner.live` (PRD R81, architecture.md § Session reports).

## M38. Running on Linux under GNOME on Wayland

- **Date:** 2026-10-17.
- **Versions:** Ubuntu 26.04.1 LTS, kernel 7.0.0, GNOME Shell 50.1 on Wayland; the operator's VS Code 1.139.1 (`/usr/share/code/code`) and the integration suite's VS Code 1.142.0 (`.vscode-test/vscode-linux-x64-1.142.0`); Codex CLI 0.163.0 installed with npm under nvm; Node 24.18.0; Claude Code CLI 2.1.300.
- **Codex processes.** `codex` on PATH is npm's `@openai/codex/bin/codex.js`, run by Node. A `codex app-server -c switchboard_run="sbtest42-1"` started with open stdin, which makes no model call, ran as two processes whose command lines both carry the tag: the launcher, whose `/proc/<pid>/stat` name is `MainThread` because Node renames its main thread, and its child, the native `vendor/x86_64-unknown-linux-musl/bin/codex`, named `codex`, whose parent is the launcher. Field 22 of `stat`, the start time in clock ticks since boot, differed between them (52195984 and 52195987). Recorded in `packages/codex/test/fixtures/proc/`.
- **Windows.** The operator's VS Code runs with `--ozone-platform=wayland`, as a Wayland client. `xprop -root _NET_CLIENT_LIST` listed no windows, so an X11 app, such as an Avalonia app under XWayland, cannot see VS Code's windows. Wayland gives an app no way to list, raise or watch another app's windows, or to reserve a screen edge; under GNOME only GNOME Shell, or a GNOME Shell extension, can, except that an XWayland dock window can reserve an edge (M39).
- **Item windows, 2026-10-17.** With the dock (Avalonia under XWayland) and an isolated hub, two item windows opened with `code <workspace file>` in an isolated VS Code 1.142.0 connected their `/events` streams; each new window came to the front and reported focus, and the dock view's `windows` followed (`front` moved from the first to the second). `code <first file>` run from a shell, with no input to that window, changed no focus within 4 seconds: GNOME kept the open window behind. Closing VS Code emptied `open`. The dock window, undecorated, took the primary monitor's work area (320 × 1152 at x = 0, matching `_NET_WORKAREA` above the bottom panel).
- **Wayland start hang, 2026-10-17.** Later the same afternoon every new VS Code main process started as a Wayland client, the operator's 1.139.1 and the test build alike, even with a fresh profile, `--disable-extensions` and `--disable-gpu`, hung before its first window: its main thread sent `wl_display.sync` to the compositor about 26,000 times a second. The screen was not locked and the display was on. With `--ozone-platform=x11` it started, and the integration suite passed. About an hour later the same launch started its window as a Wayland client, in the same session, without logging out. The cause is unknown.
- **Checks.** Every workspace's Vitest suite passed, with the Windows-only paste test skipped and a POSIX one run in its place; `npm run test:integration --workspace switchboard` passed 56 tests in VS Code 1.142.0, including the hub outliving its window (PRD R33), with the hub run by VS Code's executable in Node mode. The dock built and its 372 xUnit tests passed with .NET SDK 10.0.112.
- **Not verified:** a `codex exec` run through a hub, and the hook script's walk from a real Codex hook; Claude's hooks on Linux (`claude --bg`, the roster and `claude attach` on Linux are verified in M47); the installed extension and a hub in the operator's VS Code.
- **Current use:** the Codex process table on Linux (architecture.md § Codex runner, § Hub lifecycle) and the dock on Linux (architecture.md § Dock).

## M39. Docking and raising windows through GNOME Shell

- **Date:** 2026-10-17.
- **Versions:** GNOME Shell and Mutter 50.1 run with `gnome-shell --headless --wayland --virtual-monitor 1920x1080` in `dbus-run-session`, with `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_RUNTIME_DIR` set to scratch folders before the bus starts, so services the private bus starts, such as dconf, stay isolated too; a Wayland socket path over 108 bytes stops Mutter, so the runtime folder needs a short path. The operator's VS Code 1.139.1 with its own `--user-data-dir`, `--password-store=basic` (else GNOME's keyring asks for a new password in a modal dialog that takes every click) and `--ozone-platform=wayland`; the dock built from this tree under XWayland; a test-only extension that runs JS in the shell, and Mutter's virtual pointer for clicks and drags.
- **Window class.** VS Code as a Wayland client has the class `com.microsoft.VSCode`. VS Code also had a window that is never shown, 0 × 0 and `is_hidden()`, beside its workspace windows. Mutter also marks hidden a minimized window, once its minimize has finished, and a window on another workspace; both keep their size. VS Code under XWayland was not tried; `Code`, its desktop file's `StartupWMClass`, is taken as its class.
- **Raising.** `Main.activateWindow` brought a window behind another to the front with the keyboard focus, restored a minimized one and switched to the workspace of a window on another; `maximize()` then sized it to the work area beside the dock. A second window opened with `code <file>` from outside the shell opened behind the first without focus, as in M38.
- **Struts.** A chrome actor added with `affectsStruts` reserves its strip (GNOME Shell 50's `addChrome` takes only `trackFullscreen` and `affectsStruts`), but Mutter moved a normal window out of it, whether moved with `move_resize_frame` as a user operation or not. An XWayland window whose `_NET_WM_WINDOW_TYPE` is `_NET_WM_WINDOW_TYPE_DOCK` stayed where it was placed inside the strut, above other windows and on every workspace, and its `_NET_WM_STRUT_PARTIAL` reserved the strip: the work area went from 1920 to 1600 pixels wide for a 320-pixel strip and back when the dock closed, and maximized windows filled the rest.
- **Focus.** Mutter did not focus the dock window on a click. When the window called `XSetInputFocus` on itself, Mutter's focus window became the dock. On the operator's desktop, calling it on the press lost that click: the first click on a row only focused the dock and the second ran it. Calling it after the release, and not for a press on a row, ran the row on the first click. The cause is not known. The operator's session runs IBus, and the dock logged `[IME]` errors at each of its focus changes there; the isolated shell, where IBus did not start, never lost the click.
- **Full screen.** A full-screen window stayed in Mutter's normal layer (2) and the dock window in the dock layer (4), above it. With `_NET_WM_STATE_BELOW` the dock window went to the bottom layer (1) and the full-screen window covered it; `get_monitor_in_fullscreen` and `in-fullscreen-changed` report it. With a window full screen, turning the extension off brought the dock above it again, and turning it on again put the dock below it.
- **The dock.** With the extension, the dock took the strip at x = 0, 320 × 1048 below the 32-pixel top bar, and a click on a row of a served fixture view brought its item window forward and maximized it. A drag of its title past the middle moved it to the right edge and kept `edge: right`, its grip widened it to 420 pixels with the right edge kept, and a full-screen window covered it and released it. Without the extension it still docked.
- **Operator's desktop, 2026-10-17.** After a new login loaded the extension, a row click brought its open item window forward and maximized it beside the dock, on the first click once the focus change above was fixed.
- **Two monitors, 2026-10-18.** The same isolated shell with `--virtual-monitor 1920x1080` twice, side by side (connectors `Meta-0`, `Meta-1`, which XWayland and Avalonia's `Screen.DisplayName` also use). Dragging the dock's title with Mutter's virtual pointer moved it to whichever edge of either monitor was under the pointer and kept `monitor: Meta-1` or null; a strut at the right edge of `Meta-1` reserved it (work area 1600 wide), and at the edges the monitors share the dock reserved nothing and the work areas stayed whole. `_NET_WORKAREA` held one rectangle for all monitors (y = 32 from the top bar on `Meta-0`, also applied to `Meta-1`); `_GTK_WORKAREAS_D0` held each monitor's, and with it the dock on `Meta-1` filled 0 to 1080. On the operator's desktop (HDMI-2 5120 × 2880 above HDMI-1 3840 × 2160, scale 2 with `xwayland-native-scaling`, X coordinates in physical pixels) `_NET_WORKAREA` was 0 to 5040 high, while `_GTK_WORKAREAS_D0` gave HDMI-2 a 96-pixel panel at its bottom. A full-screen window on the dock's monitor put the dock in the bottom layer; on the other monitor it stayed in the dock layer. With VS Code 1.139.1 (`--ozone-platform=wayland`, its own `--user-data-dir`) in the shell, `move_to_monitor` then `maximize()` put its window on `Meta-1` at full width, and back on `Meta-0` at x = 320, 1600 wide, beside the dock; `get_monitor_for_connector` returned -1 for an unknown connector.
- **Not verified:** a scale other than 1 in the isolated shell; monitors stacked vertically in the isolated shell; VS Code under XWayland.
- **Current use:** the dock on Linux and the GNOME Shell extension (architecture.md § Dock).

## M40. Quick clicks on a dock header

- **Date:** 2026-10-16.
- **Versions:** Avalonia 12.1.3, headless test platform.
- **Source inspection:** `Avalonia.Input.Gestures` handles presses and releases after their routes finish. A left press with an even click count, on the element the previous press hit, raises `DoubleTapped`, and the release then raises no `Tapped`. Movement beyond the tap distance during that press clears the suppression, so a release back within the tap distance of the press point raises `Tapped` as well.
- **Experiment:** four quick clicks on a group header and on a Done date band toggled only on the first and third while the headers handled `Tapped` alone. With `DoubleTapped` also handled, a second press that moved 8 pixels away and back raised `DoubleTapped` and `Tapped` and toggled twice; mouse and touch behaved alike.
- **Limits:** pen input and a real double-click time on Windows were not run.
- **Current use:** the dock's group and band headers toggle on `Tapped` and `DoubleTapped`, once per press (`MainWindow.OnHeaderPressed`).

## M41. A background session waiting on a prompt before it starts

- **Date:** 2026-10-18.
- **Versions:** Claude Code CLI 2.1.300, and 2.1.302 for the killed process and the second blocked start, Linux.
- **Experiment:** M5's start, `claude --bg --permission-mode auto --settings <json> -n <name> <prompt>`, polling `claude agents --json` every 3–4 seconds, in two trusted directories: one with no `.mcp.json`, and one whose `.mcp.json` lists a server the operator had neither approved nor rejected. `claude logs <id>` for the second, then `claude stop <id>`.
- **Result:**
  - Without `.mcp.json`, as in M5: no pid at first, then a pid within 6 seconds, then `state: done`.
  - With the unanswered server, the entry was `state: blocked` with no pid at 4 seconds and still at 24. `claude logs` showed Claude's "New MCP server found in this project" prompt with the choices to use the server, to use it and all future servers in the project, or to continue without it. `claude stop` ended it.
  - The operator's two ad-hoc sessions in a repository whose `.mcp.json` lists 7 unanswered servers were still listed `blocked` with no pid a day after their starts failed. One's process was alive at the prompt; the other's was gone. The roster does not tell them apart.
  - On 2.1.302 a new start was again `blocked` with no pid. It ran in a spare process the daemon had started earlier, whose arguments do not name the session. Killing that process left the entry unchanged; `claude stop` exited 0 and removed it.
  - Switchboard's hooks were installed, and neither the live session at the prompt nor the probes wrote a hook marker while they waited.
- **Not verified:** that answering the prompt in an interactive `claude` lets a later `--bg` start skip it; Claude Code saves each project's MCP choices, which `claude mcp reset-project-choices` clears. Other prompts before the start may block the same way.
- **Current use:** a start whose entry is `blocked` with no pid on two reads in a row starts the session waiting on the operator, who answers through Open in terminal; only a session that started so is kept alive by such an entry, and one whose process died there waits until the operator stops it (architecture.md § Claude Code runner).

## M52. The browser extension in Firefox

- **Date:** 2026-10-18.
- **Versions:** Firefox 158.0 (build ID 20261009003443, snap revision 9057), headless, Linux.
- **Experiment:** a throwaway profile ran in a separate instance with `--headless --new-instance --remote-debugging-port --remote-allow-system-access`, driven through WebDriver BiDi: `webExtension.install` loaded a copy of `extensions/firefox/dist` temporarily, with the endpoint port changed to a test port and a test-owned loopback board page added to the content script and `web_accessible_resources` matches. The test port served the built `listenBrowser` with fakes for the snoozed URLs, cards, snooze and unsnooze, logging every request's method, path, `Origin`, `Content-Type` and `Access-Control-Request-*` headers. The board page served the recorded column and card menu with a GitHub-like content security policy (`default-src 'none'`, `font-src https://github.githubassets.com`, no `moz-extension:`). Chrome-scope script read the tabs, groups, session history and `storage.session`. A link opened as an external link does, through the command line handler with `STATE_REMOTE_AUTO`, which calls `browserDOMWindow.openURI` with `OPEN_EXTERNAL`, because headless Firefox does not accept a second `firefox <url>`. Every proxy pointed at a test-owned listener that refused all requests, so nothing reached the network.
- **Result:**
  - The temporary install reported no warnings or errors and granted the host permissions without a prompt, although Firefox lists MV3 host permissions as optional.
  - A match pattern with a port, such as `http://127.0.0.1:47615/*`, is accepted without a warning but matches nothing, even a URL on that port. With it, `GET /snoozed` and `GET /cards` reached the hub with `Origin: moz-extension://<UUID>` and Firefox blocked the replies for a missing `Access-Control-Allow-Origin`; the content script did not run on a page matched with a port, and the font was refused for a `web_accessible_resources` match with a port. A pattern without a port matches every port of the host. With `http://127.0.0.1/*` the GETs carried no `Origin` and succeeded.
  - `POST /snooze` and `POST /unsnooze` from the card menu went out with no preflight, `Origin: moz-extension://<UUID>` and `Content-Type: application/json`, and got 200; the board read `/snoozed` and `/cards` again and hid or showed the card. An unknown card's popup showed the hub's 404 text. The UUID changes on every install.
  - The snoozed card hid, the column link showed and hid it, the pills showed their marks and playbooks, the card menu got its separator and items, and the snooze popup listed 7 choices with focus on the first. Firefox also ran the content script in a matching tab that was open before the install.
  - The page's `font-src` did not block the extension's font: the face loaded and the glyph drew at its own width, while a page `FontFace` from the page's origin was blocked. Both `moz-extension://__MSG_@@extension_id__/codicon.ttf` and a relative `codicon.ttf` loaded.
  - The tab group behaved as in Chrome (M28): a cyan group titled Switchboard was created, a link of the same kind took the old tab's place and closed it, another kind added a tab, the bookmark was removed to a bare `#` with one page request and one added history entry, and a query mark was removed with the link's own bookmark unchanged. A reload of an entry with the bookmark removed it again and placed nothing. After the background script was terminated, and after it stopped when idle, new links were placed and `storage.session` kept the kinds. Moving a tab out of the group fired `tabs.onUpdated` with `groupId` -1 and removed its kind, even with the background stopped.
  - Differences from Chrome: a new tab's `tab.url` is `about:blank` during its first `onBeforeNavigate`, and Firefox has no `pendingUrl`; a new tab commits `about:blank` first without `onBeforeNavigate`. With a plain `tabs.update`, the query-marked URL from a loopback server answering in under 5 ms committed before the load restarted, leaving an extra history entry with the mark. With `loadReplace: true`, in four runs against that server and one whose reply to the marked URL took 1 second, the marked load was aborted 6–15 ms after it started, and the tab's history held only the unmarked URL with its own bookmark; whether `loadReplace` or the timing prevented the marked entry was not determined. Back skips the `#switchboard-tab` entry, because `browser.navigation.requireUserInteraction` is on by default.
  - A rerun with the built manifest's `http://127.0.0.1/*` and only the port changed in the scripts read `/snoozed` and `/cards`, snoozed a card, removed a bookmark mark and replaced a tab of the same kind as above.
- **Not verified:** a link from the dock through the desktop's URL handler to a running Firefox; a permanent install of the `.xpi` in Developer Edition or Nightly and whether it prompts for or withholds the host permissions; github.com and its live content security policy; a `vscode://` link from Firefox; Duplicate, Reopen closed tab, session restore and several windows; a mouse drag out of the group.
- **Current use:** the Firefox build's manifest (architecture.md § Browser extension) and the hub's `moz-extension://` Origin check (architecture.md § Hub lifecycle).

## M56. GitHub issue dependencies through `gh api graphql`

- **Date:** 2026-11-03.
- **Versions:** gh 2.103.3, signed in as `personal-login`.
- **Experiment:** introspected `Issue` and `IssueDependenciesSummary`, then read `issueDependenciesSummary { blockedBy totalBlockedBy }` and `blockedBy(first:N) { nodes { number state url repository { nameWithOwner } } }` on public issues found with `is:issue is:blocked`, and on the open issues of `work-login/switchboard`.
- **Result:** `Issue.blockedBy` is a connection of the issues blocking it, with the usual paging arguments; `Issue.blocking` is its reverse. `blockedBy` lists closed blockers too: `jimmie-potts/agent-device-hub#24` listed two `CLOSED` blockers, with summary `blockedBy: 0` (open only) and `totalBlockedBy: 2`. An issue with only open blockers had equal counts. The fields need no preview header, and a repository with no dependencies returns empty connections. Search's `is:blocked` returned some issues whose blockers had all been removed. The poll's `ISSUES_QUERY` with `blockedBy(first:50)` read a 75-issue search page of `arturmiller/specbound`, most with two or three blockers, in one request without a complexity error.
- **Not verified:** a blocker in a repository the token cannot read; the schema allows a null node.
- **Current use:** the GitHub source's poll keeps only the `OPEN` blockers (architecture.md § Settings, PRD R90).

## Pending verification

These mechanisms are planned but not yet verified for Switchboard:

- A real pick whose task session claims the pool ticket. By the operator's rule no test claims a case; the operator makes the first real pick.

## M53. The Firefox dev loop and addons.mozilla.org's checks

- **Date:** 2026-11-03.
- **Versions:** web-ext 10.8.0, snap Firefox 158.0.1 (build ID 20261020045838, snap revision 9113), Ubuntu with AppArmor.
- **Experiment:** `web-ext lint` ran on the built `extensions/firefox/dist`. `npm run dev --workspace @switchboard/firefox -- --arg=--headless --no-input` ran with a throwaway profile under `~/snap/firefox/common/`, from Claude Code's shell inside VS Code; the script then touched `content.css`, added a comment to a source file, and added a `console.debug` call to one, reverting it; a later run replaced `content.css` twice and an icon once by moving a copy over it, as editors save. The script was stopped with SIGINT to its process group, as Ctrl+C sends, in a second run by quitting Firefox through its debugger port, as closing its window does, and in later runs with SIGTERM to the script alone.
- **Result:**
  - `web-ext lint` refused a manifest `description` over 250 characters, and warned about `innerHTML` set from a variable, though the value was a constant SVG, and that `data_collection_permissions` needs Firefox for Android 142, which the desktop-only add-on does not target.
  - `web-ext run` installed `dist/` as a temporary add-on in release Firefox. A rewritten manifest and a code change each reloaded it within seconds; a comment, which leaves the bundle unchanged, rebuilt without a reload. With the folders of the copied files watched, each replacing save reloaded it.
  - The operator's `web-ext sign --channel unlisted` was accepted with the ID `switchboard@switchboard` and returned version 0.0.1.441353 signed, under the slug `2170cace57234e8a8e3f`.
  - In a throwaway headless profile, offline, WebDriver BiDi's `webExtension.install` with `moz:permanent` installed the signed `.xpi`: active, `signedState` 2 with `xpinstall.signatures.required` on, both host permissions granted with no prompt, and all of it, with `storage.local`, kept across a restart. A temporary install of `dist/` with the same ID was accepted and ran alone, its version in the background script, with the signed copy installed but inactive; the UUID, host permissions and `storage.local` carried over, and `storage.session` was emptied. `addon.reload()`, as `about:debugging`'s Reload, loaded a changed build and kept the same. A restart dropped the temporary copy and brought back the signed one with its UUID, permissions and `storage.local`. `addon.uninstall()` of the temporary copy, as `about:debugging`'s Remove, brought back the signed one at once but with a new UUID, no host permissions and an empty `storage.local`, also after a restart and after installing the same `.xpi` again; uninstalling the signed copy and installing it again restored the permissions. Both runs of the Remove case did the same.
  - SIGINT made `web-ext` exit with `kill EACCES`, leaving Firefox running: the shell had VS Code's AppArmor label `vscode`, and the snap's profile takes signals only from `unconfined` and `snap.*` peers. The same label refused the shell's own `kill` of the Firefox process. Quitting Firefox ended `web-ext` and the dev script. SIGTERM passed on to `web-ext` ended it without closing Firefox; passed on as SIGINT, `web-ext` tried to close Firefox, failing with the same `kill EACCES`.
- **Not verified:** installing the signed `.xpi` from `about:addons` by hand, and any permission prompt it shows; granting the host permissions again by hand in `about:addons` after Remove; the add-on's own `browser.permissions.getAll()`; requests to a hub from the signed copy; Ctrl+C from a terminal outside VS Code, whose label snap Firefox accepts.
- **Current use:** `npm run dev`, `npm run lint`, `npm run sign`, loading `dist/` over the signed copy, and the manifest's description (architecture.md § Browser extension).

## M41. Observed Support volume retention

- **Date:** 2026-10-18.
- **Versions:** Node 24.14.0, VS Code 1.142.0 (`6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1`), Claude CLI 2.1.301. No agent session or hook was used for these source/volume checks.
- **Live source acceptance:** built Zoho and Forum adapters polled read-only into `.wip/support-live-home/switchboard.db`, isolated from the operator's database. Flow applied the polls without executing any returned actions. Zoho returned 17 active Support tickets: 16 pool, 0 assigned to the operator, 1 held by another engineer. Forum returned 3: 2 pool, 0 assigned to the operator, 1 held by another engineer. Forum's first attempt failed because the VPN was disconnected; after the operator connected it, the poll passed. No ticket was picked, claimed or written to, and no triage or task session ran.
- **Results:** the two queue-only tickets had no work items. Each source's initial poll produced zero arrivals and retained every returned ticket. An isolated loopback hub serving `/volume` returned 401 without authorization and 200 with its token, with 12 weekly rows. Zoho and Forum logs are `.wip/support-live.log` and `.wip/support-live-forum.log`.
- **Presentation:** an isolated native preview of the production `VolumeWindow`, using the scratch hub and database, displayed 20 tickets in the current partial week and unavailable previous weeks. Visual inspection found and corrected unwrapped help text; the corrected table and coverage text were inspected again. Count clicks, drill-down links, source filters, delayed refreshes and failure states are covered by Avalonia headless tests; the native preview was used for visual inspection.
- **Automated checks:** `npm run verify` and `npm run test:integration`; final outputs are kept in `.wip/support-verify.log` and `.wip/support-integration.log`. Core tests cover retention, baseline and DST counts; source fixtures assert no additional scope-history/audit reads for other engineers. Integration uses the isolated real VS Code host.
- **Current use:** R84; the existing source polls and ticket history provide observed weekly volume. These checks do not establish complete historical source coverage or activity while the hub is off.

## M42. Codex triage

- **Date:** 2026-10-19.
- **Versions:** Codex CLI 0.160.0, Node 24.14.0, VS Code 1.142.0.
- **Mechanism:** `codex exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check`, with `approval_policy="never"`, `sandbox_mode="read-only"`, `project_doc_max_bytes=0`, `web_search="disabled"`, and `shell_tool`, `apps` and `hooks` disabled. The prompt goes on stdin; `--output-schema` names a strict JSON schema with every property required and `--output-last-message` names the result file. Temporary files are removed after the process ends. Authentication still comes from `CODEX_HOME` when user config is ignored. On 2026-10-21 (Codex CLI 0.163.0), `--ignore-user-config` also dropped `config.toml`'s `model_provider` and `openai_base_url`, and `-c openai_base_url="http://127.0.0.1:8319/v1"` with `--ignore-user-config` sent the turn to that endpoint.
- **Live acceptance:** an isolated `CODEX_HOME` containing a copy of the operator's auth and a synthetic typo ticket returned `dev:develop`, `NON-BLOCKING`, `LOW` and focus `ticket`. A second run through the built hub runtime and an isolated SQLite store used `sessions.provider: codex` with `triage.model: claude-sonnet-5-5`; it logged the model fallback, recorded a successful triage with model null and the expected focus URL, and left the work item unstarted. No task session or external ticket read/write ran. Evidence: `.wip/triage-acceptance/result.json`, `stdout.jsonl` and `hub-result.json`; the scrubbed event stream is `packages/codex/test/fixtures/classifier-output.jsonl`.
- **Limits:** this verifies Codex triage and the runtime path with a synthetic source. Claude live acceptance was unavailable because its usage was exhausted; the existing Claude classifier tests cover regression behavior. Native UI interaction was not used for this classifier check.
- **Current use:** R22. Triage follows the default session provider; recognized model/provider mismatches use that provider's default without changing the stored setting. Unknown model names pass through.

## M43. Codex sidebar session navigation

- **Date:** 2026-10-19.
- **Versions:** VS Code 1.142.0 (`6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1`), Codex extension `openai.chatgpt` 26.1007.21434, Windows 11.
- **Mechanism:** in the intended window, resolve `vscode.Uri.parse(vscode.env.uriScheme + '://openai.chatgpt/local/' + threadId)` with `vscode.env.asExternalUri`, then pass the returned URI to `vscode.commands.executeCommand('vscode.open', uri)`. VS Code adds its window ID. Codex's URI handler reveals its sidebar and sends the path to its sidebar router. `chatgpt.openSidebar` alone only reveals the sidebar and ignores a thread argument.
- **Window targeting:** an unqualified URI sent from the first of two windows opened in the second window. With `asExternalUri`, each window displayed its requested thread and logged the matching URI in its own Codex log. Do not construct or cache the window ID yourself.
- **Live probe:** a scratch extension, isolated VS Code settings and extensions directory, and a copied scratch Codex home with empty hooks opened two previously recorded threads. DOM reads of the `purpose=webviewView` frame confirmed each thread's distinct history. Switching threads and reopening a hidden secondary sidebar worked without creating editor tabs. A thread already open in an editor also loaded in the sidebar; its existing editor remained open. No prompt was submitted. Evidence is in `.wip/codex-sidebar/`: `first-dom.jsonl`, `second-dom.jsonl`, `alreadytab-dom.jsonl`, `hidden-dom.jsonl`, `two-settled.jsonl` (untargeted failure), `targeted-settled.jsonl`, probe replies under `box/` and `box2/`, and per-window Codex logs under `data/logs/20261019T084008/`.
- **Confirmation:** without prior URI-handler authorization, VS Code displayed “Allow 'Codex – OpenAI’s coding agent' extension to open this URI?” with Open, Cancel and “Do not ask me again for this extension”. The opening call remained pending. The successful routing probes used `extensions.confirmedUriHandlerExtensionIds: ["openai.chatgpt"]` only in the isolated profile; Switchboard must not write that authorization for the operator. `confirmation-dom.jsonl` records the prompt. This demonstrates a possible cause of the older GC M43 hangs, not their proven cause.
- **Implementation check:** the new `showSession` implementation, bundled from `extensions/switchboard/src/open.ts` into the scratch probe, opened the two recorded threads in their respective windows with no editor tabs. `production-dom.jsonl`, `box/outbox-production1b.json` and `box2/outbox-production2b.json` record the displayed histories and requesting folders.
- **Limits:** resolving the open command is not proof that the requested history loaded; a tab-based success check cannot verify a sidebar. Invalid IDs, missing extensions, rejection of the confirmation, and resuming a running thread were not tested live. The isolated sidebar displayed a Windows setup prompt, so this probe proves navigation and history display, not sending a follow-up. The Codex route is implementation-specific and needs rechecking after extension upgrades.
- **Current use:** R29 and R70. Switchboard activates the Codex extension and uses the window-targeted sidebar URI. The real-host suite covers request ordering, window-targeted URI forwarding, missing extensions and activation, resolution and open failures; it does not infer history loading from command completion.

## M44. Windows auto-hide timing and native topmost state

- **Date:** 2026-10-19.
- **Environment:** Windows, Avalonia 12.1.3, 200% display scaling. A separate test application constructed the real dock with the recorded dock view, fake actions and no hub connection, on the right edge. A second test window supplied ordinary and full-screen foreground states. Evidence: `.wip/autohide-check/before.txt` and `final.txt`.
- **Timing:** repeatedly calling `Dock` while expanded restarted the hide countdown and kept the old dock open; it hid after the calls stopped. With `WatchHide` leaving an enabled timer alone, it hid during those calls.
- **Z-order:** lowering the test dock with `SetWindowPos(HWND_NOTOPMOST)` left Avalonia's `Topmost` true but the native flag false. The old hidden dock did not recover. The new native-state check restored the flag without activation, yielded while the foreground test window was full-screen and restored it after that window returned to normal.
- **Width:** the old region was 2 physical pixels; the new region was 6 physical pixels at 200%, matching 3 device-independent pixels. After publishing and restarting the installed dock, moving focus and the pointer to a read-only VS Code editor left the dock collapsed with its native topmost flag set and a 3-logical-pixel region in a DPI-unaware read.
- **Limits:** the initiating event that lowered the operator's dock and the frequency of placement callbacks on their desktop were not captured. The test confirms both failure paths and their repairs, not a Linux commit as their cause. Full-screen behavior was exercised on one monitor with the test window, not with a game or a video player.
- **Current use:** Windows auto-hide and topmost reconciliation (PRD R71, architecture.md § Dock).

## M45. Handled assignment registration

- **Date:** 2026-10-19.
- **Versions:** Node 24.14.0, GitHub CLI 2.100.0, VS Code 1.142.0.
- **Assignment identity:** read-only GitHub GraphQL queries returned the issue ID, current assignees and assignment events for issues #20618 and #20765. The adapter identified an unassigned issue and the operator's current assignment. The scrubbed response is `packages/github/test/fixtures/assignment.json`. Pagination, multiple operator logins, incomplete reads and between-poll reassignment are covered by fixtures and unit tests.
- **Publication ordering:** read-only inspection of project 3's enabled Item added workflow showed that it sets Status to New. The repository's add-issues workflow adds the issue to that project. An issue therefore stays outside scope until it moves to Dev, so a `handled` report sent after its creation and before that move reaches Switchboard first. Evidence: `.wip/handled-project-workflow.txt`. Recheck this ordering if the project automation changes.
- **Live acceptance:** the built report CLI called an isolated hub with a synthetic originating session and real read-only GitHub assignment lookup. Registration, idempotent retry, targeted polling outside search results, zero duplicate work items, retained target audit and stale-key release refusal passed. Evidence: `.wip/handled-acceptance-result.txt`. No GitHub writes or real agent sessions ran.
- **Automated checks:** `npm run verify` passed, including coverage and 436 dock tests; the isolated real-host integration suite passed all 62 tests. Logs: `.wip/handled-verify-final.log` and `.wip/handled-integration-focused.log`. Two earlier integration runs failed the existing dock-theme focus assertion; the final run passed without a code change.
- **Limits and current use:** R85. This verifies the generic report and source reconciliation path. The Support publication instructions were reviewed and compiled, but no customer case was published for this check. Status or project membership changes alone do not end an assignment.

## M46. Zoho search filtered by escalation

- **Date:** 2026-10-20.
- **Versions:** Zoho Desk REST API v1, the operator's `desk-token.sh` runner, Node 24.14.0.
- **Trigger:** zoho 444953 went to Done at 12:51:03 UTC on 2026-10-20 although it stayed Open, Support and assigned to the operator: the 12:51:00 poll, which paged through all 835 Open tickets by `from`, did not return it, and the 12:56:00 poll did. The raw pages were not kept, so a list that shifted between pages and a search index that lagged an edit at 12:50:03 are both possible causes.
- **Experiment:** read-only GETs of `/tickets/search` with `status=Open`, `customField1=cf_queue:Support` (the colon encoded or not), `sortBy=createdTime`, `limit` and `from`; `/tickets/search` with the field filter alone; and `/tickets/{id}` for a ticket that does not exist.
- **Result:**
  - `status=Open` with the field filter returned 17 tickets in one request in 0.8 seconds. The unfiltered walk took 9 requests and about 5 seconds, and its client-side Support filter found the same 17 tickets; the filter matches the value exactly.
  - The field filter without `status=Open` returned 2,358 tickets. Every row of the unfiltered `status=Open` walk had status and status type `Open`.
  - Filtered rows carry the same fields as unfiltered ones, including `cf`, `assigneeId`, `status`, `modifiedTime`, `createdTime` and `customerResponseTime`. `sortBy=createdTime` with `from` pages the filtered list.
  - Search `from` counts from 0, unlike history's (M14): with 8 matches, `from=0&limit=4` and `from=4&limit=4` returned all 8 oldest first, and `from=1&limit=100` returned 7, without the oldest, zoho 420923.
  - One filtered read reported `count` 17 with 16 rows, minutes after a ticket closed; it may have used `from=1`, which drops a row. The poll pages by row count, not `count`.
  - `/tickets/{id}` for a missing ticket answers HTTP 404.
- **Current use:** the Zoho poll filters by the escalation field and sorts by creation, and reads by ID each current ticket the search omits (architecture.md § Sources).

## M47. Terminal windows on Linux: Ptyxis, `claude attach`, `claude --resume` and `codex resume`

- **Date:** 2026-10-20.
- **Versions:** Ptyxis 50.1 (`/usr/bin/ptyxis`), GNOME Shell and Mutter 50.1, Claude Code CLI 2.1.305 (its background service updated itself to 2.1.306 during the run), Codex CLI 0.163.0.
- **Setup:** the isolated headless shell of M39 in `dbus-run-session`, with a test-only extension that runs JS in the shell to list windows (`get_wm_class`, `get_title`), activate them, type through a Clutter virtual keyboard and take screenshots. Ptyxis ran with `-s` (standalone), drawing on the isolated compositor through `WAYLAND_DISPLAY` and connected to the real session bus. A newly started shell shows the Activities overview, where no window has the focus, so a test that needs a focused window, such as the integration suite's dock theme test, fails until the overview is hidden (`Main.overview.hide()`). Commands ran in the trusted scratch repo `.wip/mech` with a desktop-like environment (`env -i` with `HOME`, `USER`, `PATH`, `LANG`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`).
- **Spawning.** Ptyxis starts each command in a `systemd-run --user --scope` unit named `ptyxis-spawn-<uuid>.scope`. On the isolated private bus, which has no systemd user manager, every command failed and the window title gained ` (Failed)`; with the real session bus they ran. A command that fails to start leaves its window open, titled `<title> (Failed)`.
- **Flags.** `ptyxis --new-window -T <title> -d <dir> -- <argv>` opened one window running `<argv>` in `<dir>`. `-T` is documented as "Set title for new tab"; the window title was exactly that text.
- **Window class.** `org.gnome.Ptyxis` (WM class and GTK application ID), one PID per Ptyxis instance for all its windows, so a PID does not identify a window.
- **Title.** The `-T` title stayed unchanged through Claude's trust prompt, an interactive turn, `claude attach`, `claude --resume` and `codex resume` with a finished turn, without `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`: Ptyxis's tab title wins over the title the program sets. A title `<text> · sb:<name>` matches the dock's `sb:` pattern (`DockView.cs`), including with ` (Failed)` after it.
- **Exit.** A window closes when its command exits: a `bash -c '…; sleep 30'` window closed after 30 seconds, and the attach window closed when `claude stop` ended the session. Closing a window running `claude attach` (`delete`) asked nothing and left the session listed with its pid as `kind: background`.
- **`claude attach`.** On a background session (`claude --bg --permission-mode default`) waiting on `AskUserQuestion`, the attach window showed the question; Down and Enter answered it ("User answered Claude's questions: Pick red or blue? → Blue"), and the roster went from `status: waiting` to `idle`. A prompt typed into the attach window ran as a turn. Its Bash permission prompt showed in the window; Enter (Yes) ran the command and the roster went from `waiting` to `idle`.
- **`claude --resume <sessionId>`** after `claude stop` opened the session's history in the window; a typed prompt ran, and the roster listed it as `kind: interactive` with a pid and no short ID, as M7 found.
- **`codex resume <thread>`** after a `codex exec --json` turn that ended with a question showed the question and its choices as the last message, after Codex's own folder-trust prompt ("Trust and continue", the default) for a folder it had not seen. A typed answer ran as a turn. `/quit` did not close it.
- **Trust prompts.** Interactive `claude` in an untrusted folder defaulted to "No, exit", and then asked about external `CLAUDE.md` imports; a trusted parent folder (`/home/operator/projects`) did not make `.wip/mech` trusted for `claude --bg`, which refused it with R41's message.
- **Environment.** A terminal started from a Claude Code session inherited its `CLAUDE_CODE_*` variables; with `CLAUDE_CODE_CHILD_SESSION` set, Claude turned transcript saving off. A terminal the dock starts needs the session's markers removed; other `CLAUDE_CODE_*` variables, such as `CLAUDE_CODE_USE_BEDROCK`, are the operator's settings and stay.
- **Background write.** In the background session `Write(answer.txt)` failed, and worktree creation then failed because the scratch repo had no commits. Claude attributed the write failure to background isolation in Claude Code 2.1.306 and suggested `"worktree": {"bgIsolation": "none"}`; that was not verified. A Bash command ran after its permission prompt was approved.
- **Extension, same day.** The Switchboard extension with `Terminals`, `Activate` for terminals and `TerminalFocused`, installed in the isolated shell's data folder: with two Ptyxis windows open, `Terminals` listed both by ID and title, front first, and `Windows` listed none; `Activate` on a Ptyxis ID returned true and raised, focused and maximized it, three times in a row, and returned false for an unknown ID; `TerminalFocused` carried the focused window's title. In the first run, focus went back to the other Ptyxis window about a second after `Activate`, once; it did not happen again.
- **Windows Terminal, 2026-10-21.** Windows Terminal 1.24.12741.0 on Windows 11 in the operator's session: `wt.exe -w new --title "Switchboard · probe · sb:wt-probe-1" --suppressApplicationTitle -d D:\ -- pwsh -NoExit -Command <set the console title>`, run through PowerShell's `Start-Process` with joined string arguments rather than the dock's `ProcessStartInfo.ArgumentList`, opened one new window whose title stayed the `--title` text after the program set its own. `EnumWindows` found it as a visible, unowned top-level window of process `WindowsTerminal`, as `Win32Windows.FindTerminal` looks for it, and `WM_CLOSE` closed it. `claude` and `codex` resolve to `claude.exe` and `codex.exe` first on the operator's PATH.
- **Not verified:** Switchboard's `open-question` handoff before `codex resume`: the experiment resumed a `codex exec` turn that had already exited, which is the state the handoff waits for; the dock's own `wt.exe` launch, a session opened in Windows Terminal, and `claude attach` or `codex resume` running in it; Ptyxis under the operator's own GNOME session, as opposed to the isolated compositor; Ptyxis and the extension in the operator's own GNOME session.
- **Current use:** `dock.openVSCode: review` (PRD R71, architecture.md § Dock): `ptyxis --new-window -T`, the `org.gnome.Ptyxis` class in the GNOME Shell extension, and the dock's environment without Claude Code's session markers, keeping the operator's other `CLAUDE_CODE_*` settings.

## M48. GitHub issue search during an outage

- **Date:** 2026-10-22.
- **Versions:** GitHub CLI 2.100.0, GitHub GraphQL API.
- **Observation:** during GitHub's incident "Errors loading Issues, Pull Requests, and search results" (from 15:28 UTC), the hub's GitHub polls at 15:39:36 and 16:14:35 UTC completed without an error and reported all 9 of the operator's assigned issues as not assigned; the polls 5 minutes later listed all 9 again. `gh` exits non-zero on a GraphQL error and the poll checks the response's shape, so each response was a well-formed search result. Whether it listed no issues or listed them without their project Status is unknown, because the store records only the changed `assigned` fields. Evidence: the `changes` rows of events 6079, 6080, 6095 and 6096 in the operator's store.
- **Afterward:** at 17:21 UTC, during the same incident, three runs of the poll's query each returned the 15 issues with their Status values.
- **Current use:** PRD R88. The GitHub source reads each dropped issue with the single-issue assignment query before it reports the issue as not assigned. Not verified: whether the single-issue query also succeeds with incomplete data during such an outage.

## M49. Auto-hiding the dock on Linux with X Shape

- **Date:** 2026-10-25.
- **Versions:** GNOME Shell and Mutter 50.1 run headless as in M39 (`--virtual-monitor 1920x1080`, one monitor, scale 1), Xwayland 24.1.10, Avalonia 12.1.3, the dock built from this tree with `autoHide` on, against a test-owned loopback hub that served the recorded dock view and sent a `show` event on request. Input came from Mutter's virtual pointer, through a test-only extension that ran JS in the shell; the window's shape came from `xwininfo -shape`, the focus from `XGetInputFocus`, and screenshots from `Shell.Screenshot`.
- **Shape.** A bounding and input shape cut to the outer 3 pixels left only that sliver drawn, with the row stripes, and `_GTK_WORKAREAS_D0` stayed 1920 wide with the struts at zeros. Mutter picked the background under the hidden part (`get_actor_at_pos`) and the dock's surface at the sliver. Removing both shapes (`XShapeCombineMask` with `None`) left the X server reporting no shape, the dock receiving pointer moves across its whole width, and Mutter still drawing only the sliver, also after hovering rows; setting the bounding shape to the whole window, or to a 32767-pixel square, drew the whole dock at once.
- **Timing.** A move into the sliver showed the dock; it stayed shown with the pointer 150 pixels in, and hid between 0.3 and 0.7 seconds after the pointer left, over three cycles. On the right edge the sliver was cut at x = 317 of the 320-pixel window and showed and hid the same way. A `show` event showed it. Turning the pin off reserved the strip (`_NET_WM_STRUT_PARTIAL` 320 on the left, work area from x = 320) and kept `autoHide: false`; turning it on released it.
- **Ownership.** Avalonia's menus are override-redirect windows that carry the process's `_NET_WM_PID` but no `WM_TRANSIENT_FOR`; its owned dialog ("Add comment", from a row's menu) had `WM_TRANSIENT_FOR` the dock and took the X focus. With the focus moved off the dock (`XSetInputFocus` to `None`), the pointer over the part of a row's menu outside the dock kept it shown; away from both, it hid and the menu stayed open over the sliver. With the dialog focused, the dock stayed shown with the pointer away. A modal dialog blocks the dock's input, so a dock that hid before its dialog opened, from a row's menu that stayed open, did not show on a move into the sliver until the dialog closed. Once the dock showed itself before opening a dialog, the same steps showed it as "Add comment" opened, and it stayed shown with the pointer away while the dialog had the focus. A press on the header gives the dock the focus (M39), which keeps it shown until another window takes the focus.
- **X errors.** Avalonia 12.1.3 installs a process-wide Xlib error handler that records the error and returns, so a `BadWindow` from the dock's own connection, as when a menu closes during `KeptOpen`, does not end the process; not provoked live.
- **Not verified:** a second monitor; a scale other than 1; a resize while hidden; the operator's desktop, where IBus changed focus behaviour in M39; a native Wayland window receiving a click through the hidden part.
- **Current use:** Linux auto-hide (PRD R71, architecture.md § Dock).

## M50. Extension recommendation prompts in item windows

- **Date:** 2026-10-26.
- **Versions:** VS Code 1.143.1 on Linux.
- **Source inspection of `workbench.desktop.main.js`:** on opening a workspace, VS Code prompts to install the recommended extensions of its folders' `.vscode/extensions.json`. Its "Don't Show Again" stores `extensionsAssistant/workspaceRecommendationsIgnore` in workspace storage, which is per workspace file, so every new item window prompts again. Every recommendation prompt first returns when `extensions.ignoreRecommendations` or `extensions.showRecommendationsOnlyOnDemand` is set; `extensions.ignoreRecommendations` declares no scope, so it is a window setting that a `.code-workspace` file's `settings` applies. It turns off every recommendation notification, such as those for a file type, not only the repository's; the Extensions view's Recommended section depends on `showRecommendationsOnlyOnDemand`, not on it, so it stays.
- **Not verified:** a live item window with the setting.
- **Current use:** item windows' workspace files (PRD R71, architecture.md § Dock).

## M51. Resizing an X11 dock after auto-hide

- **Date:** 2026-10-30.
- **Versions:** GNOME Shell and Mutter 50.1, Xwayland 24.1.10, Avalonia 12.1.3; one isolated headless 1920 × 1080 monitor at scale 1, as in M39.
- **Reproduction:** a native preview of the production MainWindow served the recorded dock view without a hub. After hiding and showing it, a virtual-pointer drag widened the left dock from 320 to 420 pixels. Avalonia's Width, Bounds and ClientSize and the X11 window reached 420, but a shell screenshot showed only the original 320 pixels of the content.
- **Shapes:** reapplying the 32767-pixel shape restored the drawing, but the pin in the added area did not respond to clicks. Setting both bounding and input shapes to the current XGetGeometry width and height restored that click. MainWindow now refreshes the shape after each native resize once auto-hide has applied one: the sliver while hidden, the current window rectangle while shown, including after pinning.
- **Verification:** virtual-pointer drags and screenshots checked widening with auto-hide on, pinning and widening again on the left, moving to the right, and widening and narrowing there. Clicking the pin in the added area turned auto-hide off. The window, layout and drawing agreed at 420, 520 and 620 pixels. Headless tests check refreshes after growing and shrinking on both edges with auto-hide on and after turning it off; the existing test checks recutting the hidden sliver.
- **Limits:** this run did not cover multiple monitors or scale factors other than 1.
- **Current use:** Linux dock resize and auto-hide (PRD R71, architecture.md § Dock).

## M54. Bringing the browser forward for a link the dock opens on Linux

- **Date:** 2026-11-03.
- **Versions:** GNOME Shell and Mutter 50.1 in the isolated headless shell of M39; Firefox 158.0.1 from the Snap, whose desktop file has `StartupNotify=true`.
- **Problem:** on the operator's desktop a link the dock opened with `xdg-open` loaded in Firefox's existing window, but GNOME showed a "Firefox is ready" notification and left the window behind, because the launch carried no activation token.
- **Setup:** a single-instance GTK 4 app (GJS, `Gtk.Application` with `HANDLES_OPEN`) stood in for a running browser: each later run forwards its URL to the first instance, which presents its one window. Its desktop file was the default `x-scheme-handler/https` handler, with `StartupNotify=true`. Before each launch another window was activated and given a key press through a Clutter virtual keyboard, so it held the focus with a recent user time.
- **Without the shell:** `gio open <url>` from outside the shell gave the handler no `XDG_ACTIVATION_TOKEN`; the app's window took the URL but stayed behind, and the message tray gained the app's "is ready" source.
- **Through the shell:** the extension's `OpenUrl`, which runs `Gio.AppInfo.launch_default_for_uri_async` with `global.create_app_launch_context(global.display.get_current_time_roundtrip(), -1)`, gave the handler `XDG_ACTIVATION_TOKEN` and `DESKTOP_STARTUP_ID` with the same value, and the app's window took the focus, three times of three, with no notification. Without `StartupNotify=true` in the handler's desktop file, GIO set neither variable and the window stayed behind without a notification.
- **Operator's desktop, 2026-11-03.** After a new login loaded the extension, a link the dock opened came forward in the running Firefox.
- **Not verified:** Chrome.
- **Current use:** the dock's links on Linux with the GNOME Shell extension (PRD R74, architecture.md § Dock).

## M55. Closing a Claude tab or its VS Code window, and resuming the session in the background

- **Date:** 2026-11-03.
- **Versions:** Claude Code CLI 2.1.317, Claude Code extension 2.1.317, VS Code 1.144.0, on Linux.
- **Setup:** an isolated VS Code (`--ozone-platform=headless`, its own `--user-data-dir` and `--extensions-dir` holding the Claude Code extension and a test-only extension that ran commands sent to a loopback port, `--remote-debugging-port` for clicks and screenshots) on the trusted `.wip/mech`, started without the calling session's `CLAUDE_*` variables. A Haiku session started with `claude --bg --permission-mode auto -n <name> --model haiku` and was stopped, then opened with `claude-vscode.editor.open(<session ID>, <prompt>)`. The window was closed with `workbench.action.closeWindow`.
- **Sidebar, same day:** with `claudeCode.preferredLocation: "sidebar"`, `claude-vscode.editor.open(<session ID>, <prompt>, …, {programmatic: "honor-preferred-location"})` opened a released session in the Claude sidebar. Its process was a child of the window's extension host and the roster listed it `interactive` under its `-n` name. Hiding the sidebar (`workbench.action.closeAuxiliaryBar`) left the process and its running command alive; closing the window ended them within 4.4 seconds, and the no-flag resume with a prompt then ran the command to completion under the same IDs.
- **Roster while in the tab:** `claude agents --json` listed the session once, `kind: interactive` with a pid and no short ID; `--all` also listed the stopped background job under the same `sessionId`, `kind: background`, with its short ID, `state: done` and no pid. After the window close `--all` kept only the background entry.
- **Window close:**
  - The tab's `claude` process, its Bash shell and the command it ran were gone 2 to 4 seconds after the close, with the turn mid-tool and with a `run_in_background` Bash task after the turn ended. The killed foreground command was recorded as a `tool_result` with `Exit code 137` and no assistant reply after it; the background task's file was never written.
  - The roster dropped the tab's `interactive` entry about 0.16 seconds after the close, while the process still ran for about 4 more seconds. A `claude --bg --resume` in that gap printed "session … is open in another Claude Code process, so this started a copy as <id>". After the pid had exited, the same command did not.
  - The extension's `deactivate` ran within 15 milliseconds of the close command.
- **Tab close:** `workbench.action.closeActiveEditor` on the Claude tab, mid-tool, asked nothing and ended the tab's process, its shell and the command within 4 seconds, as the window close did; the resume below then worked the same. The tab's process was a child of the window's extension host, whose pid the test-only extension logged. The tab's label was the session's `-n` name, before and after turns; in live acceptance the same day a longer name, `switchboard · ad-hoc · adhoc 1`, showed as `switchboard · ad-hoc · a…`, and `tabGroups` reports its input as a webview of view type `claudeVSCodePanel`.
- **Background resume, after the tab's process exited:**
  - `claude --bg --resume <session ID>` with no flags printed "woke session <short> with its saved options (--permission-mode, -n, --model)" and kept the session ID and short ID; the roster listed it `kind: background` with a pid. With no prompt it stayed idle ("send a prompt to start") and did not continue the killed turn.
  - With a prompt and no flags it kept the IDs, ran the prompt with the conversation from the tab, in the mode the session started in (`auto`, not the tab's), and re-ran the killed command to completion. After a background task was killed, the resumed session was told "Background shell command didn't finish before the previous session ended".
  - The same resume while the session was live in its background process started a copy with a new ID, as in M18.
  - A session started with Switchboard's flags (`--permission-mode auto --settings {"worktree":{"bgIsolation":"none"}} -n --model --append-system-prompt <contract>`), stopped and resumed with a prompt and no flags, reported "saved options (--permission-mode, --settings, -n, --append-system-prompt, --model)", knew the contract's code word, and wrote a file in its working directory.
- **Live acceptance, same day:** the built VSIX in the isolated VS Code with `SWITCHBOARD_HOME` at a scratch home, whose hub ran with `sessions.installHooks` off and `sessions.model` `haiku`. An ad-hoc session in `.wip/mech` replied, ended its turn and was released. Opened in its Claude tab, labelled `switchboard · ad-hoc · a…`, with the title bar showing Continue in Background beside the `+`, it was given a 40-second foreground command; the next roster read showed it `running`. Continue in Background, run through the extension's command logic with the work item's ID, closed the tab and the window within 0.2 seconds; the hub stored the move with the tab's pid, resumed the session 3 seconds later under the same short ID as `kind: background`, and the row stayed `running`. The session got the resume prompt, ran the command again to completion and replied; its turn end released it again, and History logged `background` and `session-resumed`. A second run, after the hub kept only the candidates whose process is a child of the window's extension host, passed the same way. Live acceptance steps 3 (controls) and 4 (forks) of testing.md were not run.
- **Live acceptance from the sidebar, same day:** the built VSIX in the isolated VS Code with `claudeCode.preferredLocation: "sidebar"` and the scratch hub: the released ad-hoc session opened in the Claude sidebar and ran a 40-second command; Continue in Background for the sidebar (`label: null`) passed the hub's last check, closed the window, and the session resumed under the same short ID as `kind: background`, completed the command and was released at its turn end.
- **Not verified:** Windows, including the parent of a tab's process there and the CIM query for it; VS Code quitting with several windows; the command run from the item window's own workspace file, whose work item IDs come from `windowItems`; a tab session waiting on a permission prompt or a question at the close; a session that was compacted in its tab.
- **Current use:** Continue in Background (PRD R89, architecture.md § Claude Code runner): the session is found by its tab's label and its background job in `--all`, the hub waits for the tab's pid to exit, and resumes it with the prompt and no flags.

## M57. A background session waiting on a permission prompt, and telling it from a question

- **Date:** 2026-11-04.
- **Versions:** Claude Code CLI 2.1.318, on Windows 11.
- **Incident:** two `dev:develop` sessions in `auto` mode, for gh 16858 and gh 14158, each ran one large shell command that rewrote the session's `.wip/<issue>/plan.md` (a PowerShell `.Replace` chain, and a `python - <<'EOF'` script) whose text held the operator's account email. The hook marker went to `waiting` one second after the tool call, the call never returned, and the row showed Answer a question. Open in Claude stopped each session (6 and 1 minutes later); the resumed tab recorded "Tool call interrupted: the session ended before this call's result was recorded" and did nothing until the operator typed `continue`.
- **Cause:** the built-in `cc-plugin-privacy`, new in Claude Code 2.1.317 (2.1.316 lacks it), behind the flag `tengu_wise_newt`, on by default. Its `tool.check` hook, read from the 2.1.318 bundle, asks before a `Bash`, `Monitor`, `PowerShell` or `Tmux` call whose input holds the signed-in account's email address and, with the address removed, any of the words `curl`, `wget`, `http`, `https`, `httpie`, `xh`, `nc`, `ncat`, `socat`, `telnet`, `ssh`, `scp`, `sftp`, `rsync`, `ftp`, `lftp`, `rclone`, `iwr`, `irm`, `invoke-webrequest` or `invoke-restmethod`; and before a `WebBrowser`, `WebFetch` or `WebSearch` call that holds the address at all. Its reason is "This call's input holds your account email address, which may leave this machine. If nobody asked to send it, go on without it." Both stalled commands matched on `http` in plan prose ("every HTTP entry point", "the http context accessor"). `claude -p` reports the ask as a denial by `cc-plugin-sec-default, cc-plugin-privacy`, in `auto` and in `bypassPermissions`; commands and edits holding the address without such a word ran without one, and `Edit`, `Write` and `Agent` are not checked.
- **Background repro:** that command started with `claude --bg --permission-mode auto --settings {"worktree":{"bgIsolation":"none"}} -n … --model sonnet` in a trusted folder. The markers were `PermissionRequest` with `toolName: "PowerShell"`, then, 6 seconds later, `Notification` with `notificationType: "permission_prompt"`. `claude agents --json` listed it `status: "waiting", state: "blocked", waitingFor: "permission prompt"` with a pid, until `claude stop`.
- **A question, for comparison:** a Haiku background session asked with `AskUserQuestion`. The markers seen were `PermissionRequest` with `toolName: "AskUserQuestion"`, then `Notification` `permission_prompt` 5.5 seconds later; the roster listed `status: "waiting", state: "blocked", waitingFor: "input needed"`.
- **Findings:** the `permission_prompt` notification follows both kinds of wait and names no tool, and each marker replaces the last, so the notification alone cannot tell them apart. The permission request's tool name and the roster's `waitingFor` can. Stopping the session drops the prompt; `claude attach` shows it and answers it (M47).
- **Not verified:** turning the plugin off; `ExitPlanMode` and MCP elicitation `waitingFor` values; Linux.
- **Current use:** the hook writer copies the permission request's tool to the notification's marker as `promptTool`; `markerState` and the roster read's `stateOf` give such a wait the detail `PERMISSION_PROMPT`, and its row offers Open in terminal in place of Open in Claude (PRD R70, architecture.md § Claude Code runner).

## M58. Bot reviewers and submitted reviews through `gh api graphql`

- **Date:** 2026-11-05.
- **Incident:** triage chose `dev:review-pr-followup` for gh 21157 (PR #21163) and gh 21150 (PR #21151), which the operator had never reviewed. Each pull request's only reviews were the Claude GitHub app's, listed in the context as `claude: COMMENTED`, followed by the author's "Fixed in …" replies. About 23 other `dev:review-pr` triages with the same app reviews were classified correctly, so the classifier (`claude-sonnet-5-5`) misjudged now and then rather than every time.
- **Probe:** `pullRequest(number:21163){ author{ __typename login } reviews(last:20){ nodes{ state author{ __typename login } } } submitted: reviews(last:100, states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){ totalCount nodes{ submittedAt author{ __typename login } } } }`.
- **Result:** the app's review author is `{"__typename":"Bot","login":"claude"}`: the login has no `[bot]` suffix, so only `__typename` tells a bot from a person. The `states` filter accepts the list and returned both submitted reviews.
- **Not verified:** that the filter leaves out the operator's own pending review, which only the operator's token sees; GitHub documents `PENDING` as a separate state.
- **Current use:** the context query reads `__typename` on authors and actors, and the context shows bots as `<login> (bot)`. On somebody else's pull request, the source counts the operator's submitted reviews and pull request comments in code and writes them on one line for triage (architecture.md § Settings, GitHub reads).

## M59. Board-wide issue search across repositories

Checked 2026-11-05 with `gh` 2.100.0 against project `acme/3`, through `gh api graphql` with `ISSUES_QUERY` (which reads `repository { nameWithOwner }`).

- `is:issue is:open project:acme/3`, with no `repo:` qualifier, returns the open issues of every repository on the board in one result set: the first page of 100 held 96 `acme/widgets`, 1 `acme/widgets-dashboard` and 3 `acme/widgets-infra` issues, and `endCursor` continued into the next page. The same query with `-repo:acme/widgets` returned 56 issues from six other repositories in one page.
- With `assignee:work-login assignee:work-ai-login`, the qualifiers are ORed and the search returned 10 issues on one page.
- Current use: a GitHub source searches its board without `repo:` and keys each issue by `repository.nameWithOwner` (PRD R44). With `requireAssignee` off, the board's whole open issue count is paged and counts against `maxPages` (16 pages for `acme/3`), so that setting suits a small board.

## M60. Closed issues in a board search

Checked 2026-11-09 with `gh` against project `acme/3`, through `gh api graphql` `search(type:ISSUE)`.

- `is:issue assignee:work-login assignee:work-ai-login project:acme/3`, with no state qualifier, returned 19 issues: the 8 open ones and the 11 that `is:closed` returns, so a search without `is:open` reads both states.
- Of the 11 closed issues, 7 were in `⚒️ Dev`, closed between 2026-11-07 and 2026-11-09 as `COMPLETED`, and 4 were in `🚀 Releasable`, which is not an assigned status.
- `is:issue is:closed project:acme/3` without assignees counted 5,826 issues, 59 pages of 100.
- Current use: with `includeClosed` on, a GitHub source searches without `is:open` (PRD R44). With `requireAssignee` also off, every closed issue on the board is paged against `maxPages`, so that pair suits only a small board.

## M61. VS Code side bar widths

Checked 2026-11-14 to 2026-11-17 on Windows 11 with VS Code 1.145.2 and 1.146.0 (the `.vscode-test` archives, own user data folders), by reading the minified `workbench.desktop.main.js` and running commands from a probe extension while reading `offsetWidth` and `getBoundingClientRect` of `#workbench.parts.sidebar`, `#workbench.parts.editor` and `#workbench.parts.auxiliarybar` over the debugging port.

- **Defect:** with the side bars at 410 and 462 pixels in an 1800-pixel window, a resize to 600 pixels and back left them at 170 and 162. The editor gives up width first; the side bars narrow once it is at its minimum and get nothing back. VS Code tracks this as microsoft/vscode#224933, open since 2024-08.
- **A webview view measures its side bar.** A visible webview view's `innerWidth` and `documentElement.clientWidth` are its side bar's width less 2 pixels (298 for 300, 167 for 170, 418 for 420, 358 for 360), in the Explorer, in Source Control and in a secondary side bar container, at every window width and after a command resize (1.146.0, 125% display scale). Its `outerWidth` is the workbench's `outerWidth`, `innerWidth` + 14 at zoom level 0, and zoom leaves it unscaled: at zoom level 1 it stayed 1800 while the workbench's `innerWidth` went from 1786 to 1489. The side bars kept their CSS widths across the zoom. A hidden or collapsed view, or one whose container is not active, still answers messages with `retainContextWhenHidden` but reports the sizes of when it was last visible (`innerWidth` 300, `outerWidth` 1800 in a 1300-pixel window). A window resize that leaves the side bar's width alone fires no `resize` or `ResizeObserver` event in the view, so `outerWidth` is polled. The workbench's `innerWidth` is the activity bar (44), the primary, the editor and the secondary plus 16 with both side bars visible, and plus 12 with both hidden.
- **Editor width:** `vscode.getEditorLayout` returns each group's `size` along its parent's orientation. With side-by-side groups, or one group laid out in a row, the sizes are widths and their sum is the editor part's width less 2/`devicePixelRatio` pixels; a fresh single group reports its height. `workbench.action.toggleEditorGroupLayout` lays one group in a row and moves the focus to the editor; `vscode.setEditorLayout {orientation: 0, groups: [{}]}` does the same and left the focus in a webview (checked 2026-11-17). A group's minimum width is 220: in a 600-pixel window the editor part was 192 pixels wide and the layout still said 220. With the secondary side bar maximized the layout says 220; in a centered layout the size is the centered width.
- **Hiding and showing:** `workbench.action.closeSidebar` and `workbench.action.closeAuxiliaryBar` hide a visible side bar and do nothing to a hidden one. `workbench.action.toggleSidebarVisibility` and `workbench.action.toggleAuxiliaryBar` show it again at the same width. The editor's width grows by the primary's width exactly and by the secondary's stored size less 4 pixels. Hiding and showing both took 35 to 65 ms and painted at most one frame without the side bar. Hiding a visible side bar moves the focus to the editor from wherever it was, also from a webview in the other side bar; hiding a hidden one and showing one leave the focus where it is.
- **Resize commands:** `workbench.action.increaseViewSize` and `decreaseViewSize` resize the focused part by 60 pixels (`RESIZE_INCREMENT`), stop at the side bar's minimum of 170, and change nothing with the focus in a webview. `increaseViewWidth` and `decreaseViewWidth` resize the editor by 60 pixels whatever has the focus and leave the focus there; the primary takes or gives the pixels, the secondary while the primary is hidden, and a step that would take the primary under 170 takes the rest from the secondary. No command grows the secondary while the primary is visible and a webview in the secondary has the focus. `focusSideBar` and `focusAuxiliaryBar` show a hidden side bar.
- **Found by review, 2026-11-17** (isolated VS Code 1.146.0): with two editor groups, `increaseViewWidth` and `decreaseViewWidth` resize the active group, so a restore after 600 → 1800 pixels left the primary at 167 and the groups at 423 and 970. In a centered layout of fixed width, hiding the secondary does not widen the editor. A 300-pixel panel beside the editor reads as 300 more pixels of secondary. The zoom commands change one window's zoom without `window.zoomLevel` while `window.zoomPerWindow` is on, its default, and a 125% display at zoom level 1 and a 150% display at level 0 both report a `devicePixelRatio` of 1.5.
- **Not available to an extension:** no command sets a part's size, and none of the 3330 registered commands returns a part's size or visibility. `window.nativeHandle` and `onDidChangeTerminalDimensions` are proposed APIs. A webview view pane is at least 148 pixels tall expanded.
- **Other routes that worked, not used:** script run over `remote-debugging-port`, which `argv.json` accepts, set exact widths with synthetic mouse events on the sash; any local process can then control VS Code. `WM_MOUSEMOVE`, `WM_LBUTTONDOWN` and `WM_LBUTTONUP` posted to the window's `Chrome_RenderWidgetHostHWND` dragged the primary sash to an exact width.
- **Live check, 2026-11-17:** the built extension in VS Code 1.146.0 with its pane in the Explorer and a probe extension's webview in the secondary side bar holding the focus, resized with `SetWindowPos` (`.wip/sidebar-probe/live.mjs`, not committed). Six unfocused polls through `pollSideBars(false)` calibrated (`decreaseViewSize`, `increaseViewSize`, `closeAuxiliaryBar`, `toggleAuxiliaryBar`, `focusAuxiliaryBar`) and kept both side bars' widths as caps; the focus was back in the webview's frame. At 700 pixels the side bars were squeezed to 170 and 241, and set to their shares; back at 1800 they were set to 290 and 301 with the primary hidden for the secondary's two steps, and the focus was in the webview's frame. A primary 120 pixels wider by command was kept, and back at 1800 after 900 it was set to 430. A resize to 1300 and back ran nothing. A squeeze while Search was the primary's view ran nothing, and the Explorer's return set the side bars, with the focus returned to the primary side bar.
- **Live check after review, 2026-11-17:** the same run, repeated eight times after the review's fixes: each time the side bars came back after 700 → 1800, the primary's drag was kept and set again after 900 → 1800, a resize to 1300 and back ran nothing, and the Explorer's return set the side bars. A pane report that arrived before the layout caught up with a resize once read as a pane wider than the room, until the check waited for held readings. A drag made at once after a restore became the base and was not kept. At 700 pixels, where the editor leaves no room for the focus test, the focus once stayed out of the webview after the secondary was set. With the fixed offset in place of the measurement, two more runs gave the same widths and ran no `closeAuxiliaryBar`.
- **Current use:** PRD R91 (architecture.md § VS Code extension), with the frame, activity bar and sashes taken as 14, 44 and 16 pixels instead of measured. In the probe the measured offset was 73.6 pixels against the 74 those give. The command IDs, the 60-pixel step, the 170 and 220-pixel minimums, the layout's sizes and the webview's `outerWidth` are VS Code internals; re-check after an upgrade.

## M62. Leaked hook entries, and Codex state from the rollout alone

Checked 2026-11-18 on Windows 11 with Codex CLI 0.167.0.

- **Leak:** `.wip/sidebar-probe/live.mjs` started VS Code with `SWITCHBOARD_HOME` set to a new temporary folder but with the operator's Claude and Codex homes. Each run's hub added its hook entries to `~/.claude/settings.json` and `~/.codex/hooks.json`, and nothing removed them: 46 runs left 644 entries in Claude's settings and 368 in Codex's hooks.json, so every Claude hook event started 47 `hook.mjs` processes and every Codex hook event 47 `codex-hook.mjs` hooks.
- **Cost of a Codex hook on Windows:** Codex runs each command through `pwsh -NoProfile -Command`, and the hook script's walk to its Codex process starts `powershell` with up to three `Get-CimInstance Win32_Process` queries. With five Codex sessions running, the 47 hooks per event kept WmiPrvSE at about 11 cores and Defender (MsMpEng) at about 2 of 24, and Claude's `node` hooks then exceeded their 5-second timeouts. Removing the 1,012 entries brought total CPU from 93% to 12%.
- **Rollout records**, tallied over the 400 newest rollouts in `~/.codex/sessions`: `event_msg` records of type `task_started` (763), `task_complete` (707) and `turn_aborted` (55) carry the turn ID, so the rollout shows when a turn runs and how it ended; a question shows as a `request_user_input_async` function call until its output. No record type marks a pending permission prompt, and the rollout names no process. The file grows while its turn runs, but its modification time can stay at the session's start: a reviewer's rollout written until 12:28 UTC listed 12:08, so a reader must check its size, not its time.
- **Not verified:** whether a permission prompt leaves any record in the rollout under `on-request` approval.
- **Current use:** at each install the hub removes the hook entries of another Switchboard home whose hub lock no one holds, except the profile's own `~/.switchboard`, and the Codex hook writes markers only for threads its run records name (architecture.md § Claude Code runner, § Codex runner). Markers still decide a resumed Codex session's state (PRD R36).

## M63. Code Mode in a hidden pseudo-terminal, and how to tell it is on

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300; Node.js 24.14.0, node-pty 1.1.0, @xterm/headless 6.0.0; VS Code 1.146.0 (Electron 43.8.6, Node 24.22.1).
- **Experiment:** a stand-in for the hub ran under VS Code's `Code.exe` with `ELECTRON_RUN_AS_NODE=1`, `VSCODE_PID` and `NODE_OPTIONS` set, and started a prototype terminal holder on system Node.js, detached. The holder removed `ELECTRON_*`, `VSCODE_*`, `NODE_OPTIONS`, `ANTHROPIC_*` and Claude's session markers (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`) from its environment and spawned, in a node-pty pseudo-terminal of 120×40, `claude --session-id <uuid> -n <name> --permission-mode auto --model haiku --append-system-prompt <contract with a code word> --settings <json> <prompt>` with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` and `SWITCHBOARD_LAUNCH=<uuid>`, in a scratch git repository under `.wip/`. The `--settings` JSON set `env.ANTHROPIC_BASE_URL` to `https://api.anthropic.com` and added a hook on every event that logged the payload and the hook's environment.
- **Result:** after the trust dialog (M70), the session printed `⚠ Code Mode (experimental) is on · this session can be resumed only with Code Mode on` under the banner, and `/status` showed `Code Mode: on (experimental) · CLAUDE_CODE_EXPERIMENTAL_CODE_MODE in the shell environment`. The prompt ran as the first turn; the transcript's tool uses were `REPL`, `PowerShell`, `REPL`, `Poll`, and the answer named the contract's code word. Every hook carried the given session ID, and the transcript was `<session id>.jsonl`. `claude agents --json` listed the process as `kind: "interactive"` with its pid, the given `sessionId` and the `-n` name. Each hook process saw `SWITCHBOARD_LAUNCH`, `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` and `ANTHROPIC_BASE_URL` set by `--settings`.
- **Hook order of one turn:** `SessionStart` (`startup`), `UserPromptSubmit`, `PreToolUse` `REPL`, `PreToolUse` of each tool the code calls under its own name, `PostToolBatch`, `PostToolUse` of each, `PostToolUse` `REPL`, `UserPromptSubmit` with `source: "poll_event"`, `Stop`. A `SubagentStop` with an `agent_id` followed some `Stop`s, and `Notification` `idle_prompt` came 60 seconds after a `Stop`. Async hooks finish out of order: `PostToolBatch` was sometimes logged before the `PreToolUse` it follows, and several events shared one millisecond.
- **Pass criteria (plan E1):** Code Mode on, shown by a fixed screen line readable by a program; prompt as first turn; transcript with the given session ID; the `-n` name in the roster; the contract's code word known. **Passed.**
- **Not verified:** Linux; the holder started by a real hub.
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work. Re-run M63, M65, M70 and M71 after a Claude Code upgrade, since Code Mode is experimental and may change in any release.

## M64. Skipping the gateway for a Code Mode session

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300. The operator's `~/.claude/settings.json` `env` sets `ANTHROPIC_BASE_URL` to a local gateway and `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`; it has no `apiKeyHelper`.
- **Experiment:** promptless starts through the M63 holder with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` and the process environment's `ANTHROPIC_*` variables removed, varying the overrides; then `/status`. Credential cases put the variable in the scratch repository's `.claude/settings.local.json`, which ranks above user settings and below `--settings`.
- **Result:**

  | Overrides | Code Mode |
  |---|---|
  | none | off: `isn't available: for now it only works directly with the Anthropic API (not through a cloud provider such as Bedrock, a gateway or another address in ANTHROPIC_BASE_URL). Starting with the ordinary tools.`; `/status` shows the gateway address |
  | `ANTHROPIC_BASE_URL` in the process environment only | off, the same line: user settings `env` wins |
  | `--settings {"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}` | on; `/status`: login by the Claude account, base URL `https://api.anthropic.com` |
  | that, with `ANTHROPIC_API_KEY` in settings | on, but a start prompt "Detected a custom API key in your environment. Do you want to use this API key?" |
  | that, with `ANTHROPIC_AUTH_TOKEN` in settings | off: `isn't available: for now it doesn't work with an API key helper, ANTHROPIC_AUTH_TOKEN or custom auth headers.` |
  | that, with `ANTHROPIC_CUSTOM_HEADERS: "X-Api-Key: …"` in settings | off: `isn't available: Claude Code couldn't read your organization's settings or policy (starting Claude Code again may help).` |
  | that, with `"ANTHROPIC_API_KEY": ""`, `"ANTHROPIC_AUTH_TOKEN": ""` and `"ANTHROPIC_CUSTOM_HEADERS": ""` added to `--settings` `env`, against each of the three above | on; `/status`: login by the Claude account, base URL `https://api.anthropic.com` |
  | `apiKeyHelper` in settings, `--settings` `"apiKeyHelper": ""` | off, the API key helper line |
  | `apiKeyHelper` in settings, `--settings` `"apiKeyHelper": null` | settings error dialog: `apiKeyHelper: Expected string, but received null` |

  `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` from user settings did not stop Code Mode once the base URL was overridden.
- **Pass criteria (plan E2):** one combination starts Code Mode with `/status` showing the direct API and the subscription sign-in, also when settings set `ANTHROPIC_API_KEY`. **Passed:** `--settings` `env` with the base URL and the three credential variables as empty strings. The process environment needs no override.
- **Not verified:** `ANTHROPIC_API_KEY` in user settings themselves (local settings stood in); an `Authorization` header; a managed-settings gateway. An `apiKeyHelper` in user settings cannot be overridden by `--settings`, so it keeps Code Mode off.
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M65. Hook events in a Code Mode session

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300.
- **Experiment:** an M63 session with an extra synchronous `PreToolUse` hook on `Bash|PowerShell` (timeout 3 s) that exits 1 with stderr for one command, sleeps 10 s for another and returns `updatedInput` for a third; an async `PreToolUse` hook that always exits 1; and a synchronous `SessionStart` hook on `compact` that returns `additionalContext` with a second code word. Turns: four Bash calls from code; `AskUserQuestion`; a permission prompt in manual mode (reached with Shift+Tab); long-running code; `/compact`; two concurrent `REPL` calls in auto mode.
- **Result:**
  - A synchronous `PreToolUse` hook that exited 1 did not stop the call: the command ran. One that ran past its timeout refused it with `Permission denied for Bash: PreToolUse:Bash hook error: [node]: the hook did not finish, so this call was not run.`, and the refused call had no `PostToolUse` or `PostToolUseFailure`. `updatedInput` replaced the command. The failing async hook never refused a call.
  - `AskUserQuestion` exists in Code Mode and waits as in M57: `PreToolUse` `REPL`, `PermissionRequest` with `tool_name: "AskUserQuestion"`, then `Notification` `permission_prompt` 6 s later; the roster said `status: "waiting", waitingFor: "input needed"`. After the answer: `PostToolUse` `AskUserQuestion`, `poll_event`, `Stop`.
  - A permission prompt for `Bash` from code: `PreToolUse` `Bash`, `PermissionRequest` with `tool_name: "Bash"`, `Notification` `permission_prompt` 6 s later; roster `waitingFor: "permission prompt"`.
  - Code does not outlive its turn. While a `REPL` script runs, the turn stays running (`esc to interrupt`, `1 background task` on the status line, roster `busy`), and `Stop` follows the script's end; every `Stop` had `background_tasks: []`. A script's own time is capped at 30 s, so a 45-second `sleep()` in code ended at 30 s; an un-awaited timer dies when its script ends; `Bash` with `run_in_background: true` is refused with `run_in_background is not available in the async REPL`. A 50-second shell command awaited in code ran to its end inside the turn. In auto mode each code result reached the model as `UserPromptSubmit` `poll_event` before the turn's `Stop`. In the manual-mode turn whose `Bash` call waited on a permission prompt, `PostToolUse` `REPL` and `PostToolBatch` were followed by `Stop` with no `poll_event`.
  - `/compact` gave `PreCompact`, `SubagentStop`, then `SessionStart` `compact` and no `Stop`. The `compact` hook's `additionalContext` reached the model: after compaction it named both code words.
  - Two `REPL` calls in one reply both started, but their `Bash` calls ran one after the other: the second call's `PreToolUse` came 60 ms after the first call's 25-second command ended. No prompt was raised; this run did not exercise tool calls that overlap.
- **States:** running is `UserPromptSubmit` (either source), `PreToolUse`, `PostToolUse` or `PostToolBatch`; a question or permission wait is `PermissionRequest` and its `Notification`, told apart by the request's tool (M57); idle is `Stop`, or `SessionStart` `compact` after `/compact`; ended is `SessionEnd` (M68). A turn can end without a `poll_event`.
- **Pass criteria (plan E3):** each state has an identifying marker sequence; background code is visible so idle is not reported while code runs; a `poll_event` turn ends with `Stop`; Switchboard's async `PreToolUse` entry never refuses a call; the contract survives compaction. **Partial.** Passed: running, a question or permission wait, idle and ended each have an identifying sequence; the turn stays open until code ends, so idle is not reported while code runs; each `poll_event` turn ended with `Stop`; the async `PreToolUse` entry never refused a call; the contract survived compaction. Outstanding: the failed state, since no `StopFailure` was produced.
- **Not verified:** `StopFailure` (an unknown model in `/model` was refused before any request); the auto-mode prompt with a two-minute countdown, which needs tool calls that overlap; `Elicitation`; whether output can arrive after `Stop` by another route, such as `Monitor`.
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M66. Reports from a Code Mode session

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300; the installed `hub.js` bundle copied to a scratch home with a stand-in hub that answered `GET /status` and recorded requests.
- **Experiment:** the M63 session ran `node <home>/.switchboard/hub.js report stage …` with the `Bash` tool and `report worktree … /d/git/x` with the `PowerShell` tool, both from code, and printed `CLAUDE_CODE_SESSION_ID` and `SWITCHBOARD_LAUNCH`.
- **Result:** both commands printed `recorded`; each `POST /report` carried the session's ID as `nativeSessionId`. Both shells saw `CLAUDE_CODE_SESSION_ID` and `SWITCHBOARD_LAUNCH`, and Bash also `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` and the overridden base URL. From PowerShell, `/d/git/x` arrived as `D:\d\git\x`, as for any PowerShell call (M20 concerns Git Bash only).
- **Pass criteria (plan E4):** the stand-in receives the report with the right session ID. **Passed.**
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M67. The roster, `claude stop` and `claude attach` for a held session

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300.
- **Result:** `claude agents --json` and `--all` list a held interactive session as `{pid, cwd, kind: "interactive", startedAt, sessionId, name, status}` with `status` `busy`, `idle` or `waiting` and, when waiting, `waitingFor` `input needed` or `permission prompt`; it has no short `id`. `claude stop` and `claude attach` with the first 8 characters, the full ID or the name print `No session matching '<arg>'. Run 'claude agents' to list running sessions.` and exit 1, and leave the session running. After `/clear`, `/branch` or `/resume` the entry keeps the pid and shows the new session ID and name (M73).
- **Pass criteria (plan E5):** recorded either way. **Passed.**
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M68. Resuming a Code Mode session after its process ends

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300.
- **Experiment:** the M65 session was killed with `taskkill /T /F` 8 s into a turn running `sleep 30`, then resumed in a new pseudo-terminal with `claude --resume <id> --permission-mode auto --model haiku --settings <same>`, a new `SWITCHBOARD_LAUNCH`, with no prompt and then with one; then once without `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`.
- **Result:**
  - The kill left no `SessionEnd` and no `Stop`: Switchboard's marker stayed at `PostToolBatch`, which reads as running. The hook payloads logged with the killed launch's `SWITCHBOARD_LAUNCH` tell it from later launches.
  - A promptless resume showed the Code Mode line, the conversation and the `-n` name; its only hook was `SessionStart` `resume` with the same session ID and the new launch, and the roster said `idle`. Model and permission mode were as passed. The interrupted turn did not continue.
  - A resume with a prompt ran it as a turn: `SessionStart` `resume`, `UserPromptSubmit`, `Stop`. The model knew both code words and that the killed command's result was lost.
  - Without the variable Claude printed `This session was started in Code Mode (experimental), which is off, so it can't be resumed. To resume it, set the environment variable CLAUDE_CODE_EXPERIMENTAL_CODE_MODE to 1, then run claude --resume <id>.` and exited 1.
- **Pass criteria (plan E6):** same session ID, conversation and contract; Code Mode on; model and permission mode settable; a promptless resume reads as idle; the stale marker of a killed process distinguishable by its launch ID; the refusal recorded. **Passed**, with the launch ID taken from the hook's environment, which the hook writer does not record yet. The resume passed no `--append-system-prompt`, so the contract seen came from the conversation.
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M69. Held sessions when the holder dies

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300.
- **Experiment:** the holder held three Code Mode sessions: two idle and one running the Bash command `sleep 40; echo e7done > e7done.txt` from code. The holder process alone was killed with `taskkill /PID <holder> /F` 25 s into the command.
- **Result:** every `claude` and the members of its process tree seen before the kill were gone within 5 s. Each session logged `SessionEnd` with `reason: "other"` 1 to 2 s after the kill, so Switchboard's hook writer removed its marker, and the roster no longer listed it. The shell command did not stop: `e7done.txt` was written 15 s after its `claude` had exited. Its `sleep` was not under `claude.exe` in the process table, so neither the tree nor the roster shows it.
- **Pass criteria (plan E7):** each `claude` exits within 30 s, or a survivor is detectable. **Passed** for `claude`. A tool's shell command can outlive its session unseen.
- **Not verified:** Linux and `SIGKILL`; whether `taskkill /T` on `claude` (M68) also leaves such a command running.
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M70. Prompts before a Code Mode session starts

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300.
- **Experiment:** a start in a new folder with a project `.mcp.json` server, on a scratch `CLAUDE_CONFIG_DIR` holding copies of the operator's sign-in, `.claude.json` without `codeModeCaveatsAcceptedV1` and `codeModeAutoModeCaveatAcceptedV1`, and settings without hooks, with `--session-id` and a prompt.
- **Result:** the dialogs came one after another, each answered by keys sent to the pseudo-terminal:
  1. Folder trust ("Accessing workspace: … Quick safety check: Is this a project you created or one you trust?"), with `❯ No, exit` selected, naming `.mcp.json` when there is one.
  2. "New MCP server found in this project: e8dummy", `❯ Continue without using this MCP server` selected.
  3. "Allow external CLAUDE.md file imports?", because the folder's parent `CLAUDE.md` imports `AGENTS.md`; `❯ No, disable external imports` selected.
  4. "Code Mode (experimental)", with `❯ No, start without it` selected, so Enter starts without Code Mode.

  No hook fired until all four were answered; then `SessionStart` `startup` with the given session ID, the prompt as the first turn, and `Stop`. The pseudo-terminal's process kept its pid; a second `claude`-level process appeared under it. One answer saved both caveats to `.claude.json`. M63's scratch repository asked for trust and imports at its first start only. An API key in settings adds its own dialog (M64).
- **Pass criteria (plan E8):** a start prompt is detectable without a marker; the confirmation keeps the session ID and prompt. **Passed:** a live process with no marker of its launch is waiting on a dialog, and the prompt and session ID survived.
- **Side effect:** killing a session while its dialogs showed made the next Claude start on the machine print `Claude Code's fullscreen renderer didn't finish starting last time on this machine, so this launch is using the classic renderer.`; that start used the classic renderer once.
- **Not verified:** the name of the second process; what the operator's terminal shows after an attach mid-dialog.
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M71. Starts that Claude makes without Code Mode

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300.
- **Result:** with the M64 overrides, `--model claude-sonnet-5` started without Code Mode, printing `⚠ Code Mode (experimental) isn't available: for now it only works with Opus 5.5, Sonnet 5.5 and later models. Starting with the ordinary tools.` `DISABLE_TELEMETRY=1` printed `⚠ Code Mode (experimental) isn't available: it needs settings that Claude Code downloads from Anthropic, and this session doesn't download them (DISABLE_TELEMETRY, DO_NOT_TRACK, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC or CLAUDE_CODE_DISABLE_FEATURE_FLAGS turns that off). Starting with the ordinary tools.` In both, `/status` showed `Code Mode: off · <reason>` and the `is on` line was absent. Haiku 5.5 runs Code Mode though the message names only Opus and Sonnet. Every refusal line in M64 and here starts `⚠ Code Mode (experimental) isn't available:` and wraps at the terminal's width.
- **Pass criteria (plan E9):** both lines recorded. **Passed.**
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M72. Replaying and attaching to a held session

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300; @xterm/addon-serialize 0.14.0.
- **Experiment:** the holder kept each session in `@xterm/headless` (10,000 lines of scrollback) with `SerializeAddon`, and a raw output buffer. Replays of each were written into fresh headless terminals and compared with the holder's screen. Attach clients connected over loopback TCP, sent their size, received the replay and the output stream, and sent keys: a headless client, and a raw-mode Node.js client (`process.stdin.setRawMode`) running inside a second ConPTY, standing in for Windows Terminal and VS Code's terminal.
- **Result:**
  - At the session's size both replays reproduced the visible screen and scrollback exactly, and re-serializing the replay gave the same bytes. Replayed at another size without a resize, both were garbled.
  - The holder resizing the pseudo-terminal to the client's size before the replay made Claude redraw at that size, so a 90-column client showed a clean screen. The raw-mode client's terminal resize reached Claude.
  - Through both clients, a bracketed paste appeared in the input box, Shift+Tab cycled the mode (manual, accept edits, plan, auto), Ctrl+O opened the detailed transcript and Esc closed it; Ctrl+U cleared the box.
  - Attaching mid-turn showed the spinner and `esc to interrupt`; detaching left the turn running, and attaching after it showed the result.
  - With two clients of 120 and 80 columns, the later one set the size and the wider client showed lines drawn for 80 columns until it resized.
  - A serialized replay of 10,040 lines of 106 characters was 1,094,259 bytes, and the raw buffer 2,180,075.
- **Pass criteria (plan E10):** one replay method shows the screen as Claude drew it in both terminals, and keys reach Claude unchanged. **Partial.** Passed with the headless client and the raw-mode client in a second ConPTY: serialization after a resize to the client's size reproduced the screen, and keys reached Claude. Outstanding: the replay and keys in Windows Terminal and in VS Code's terminal, checked by eye, which the criteria name.
- **Not verified:** Linux; mouse input; a raw buffer that has dropped its start.
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M73. Session ID changes inside a held session

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300.
- **Result:** in a held session started with `--session-id`:
  - `/clear`: `SessionEnd` of the old ID, then `SessionStart` with `source: "clear"` and a new ID, from the same process and the same `SWITCHBOARD_LAUNCH`. A report afterwards sent the new ID; the roster showed the same pid with the new ID.
  - `/fork` is refused: `This session is in Code Mode (experimental), which background sessions can't use yet, so it can't be moved or copied to the background.` No hook fired.
  - `/branch` printed `Branched session. You're now in the new one (<id>)`: `SessionEnd` of the old ID, `SessionStart` `source: "fork"` with the new one.
  - `/resume <other id>`: `SessionEnd`, `SessionStart` `source: "resume"` with the other ID; the roster then showed the other session's ID and name for the same pid.

  Since Switchboard's hook writer removes a marker on `SessionEnd`, each change removes the old ID's marker and writes one for the new ID.
- **Pass criteria (plan E12):** each ID change is detectable from markers carrying the launch ID. **Passed**, given a hook writer that records `SWITCHBOARD_LAUNCH`; nested `claude -p` markers also carry the launch ID, so the source of the change must be kept (M77).
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M74. Debrief forks of a Code Mode session

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300.
- **Result:** `claude -p --resume <Code Mode session> --fork-session` with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` printed `Warning: Code Mode (experimental) isn't available: for now it only works in the interactive terminal.` and, with or without the variable, `Failed to resume session: This session was started in Code Mode (experimental), which isn't available because for now it only works in the interactive terminal, so it can't be resumed here.` and exited 1.
- **Pass criteria (plan E13):** recorded. **Passed:** refused.
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M75. Memory of held sessions and how to read it

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300; 643 processes on the machine.
- **Result:**
  - A Code Mode `claude.exe`: 395 to 399 MB working set and 741 to 757 MB private while idle for 7 minutes, 433 and 839 MB in a turn. Its tree also runs the operator's stdio MCP servers from user settings (two here, about 300 MB), about 700 MB working set and 950 MB private in all.
  - The prototype holder: about 100 MB working set with one or two sessions; one session's 10,000-line scrollback added about 110 MB working set and 140 MB private.
  - An idle session wrote nothing to its pseudo-terminal for 450 s.
  - Reading memory: `tasklist /FO CSV` 1.3 s; `pwsh -NoProfile -Command` with `Get-CimInstance Win32_Process` 1.4 s (0.5 s in a running PowerShell); `Get-Process` with `.Parent` 22.6 s; `wmic` absent. In a running PowerShell, `Get-Process` of every process took 16 ms and `Get-Process -Id` of 20 pids 190 ms. PowerShell started in 450 ms.
- **Pass criteria (plan E14):** a method under 100 ms per list of 20 sessions; numbers for the idle limit. **Partial.** Measured: every one-shot command took over a second; inside a running PowerShell each command was timed on its own (`.wip/code-mode-exp/memtime.ps1`). Proposed, not measured: a long-lived PowerShell that answers `Get-Process` for all processes, joined with process trees from `Win32_Process` read less often; the combined lookup, sum and reply for 20 sessions was not timed. Outstanding: that measurement and an hour-long run; the memory numbers cover 7 minutes.
- **Not verified:** Linux `/proc`; growth over an hour.
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M76. node-pty from a packaged extension

- **Date:** 2026-11-18.
- **Versions:** node-pty 1.1.0, @vscode/vsce from the repository; Node.js 24.14.0 and VS Code 1.146.0's Electron 43.8.6 in Node mode; Windows 11 x64.
- **Experiment:** a probe extension whose `holder/` folder held the holder script, `@xterm/headless`, `@xterm/addon-serialize` and node-pty's `package.json`, `lib/**/*.js` without tests (including `worker/conoutSocketWorker.js` and `conpty_console_list_agent.js`) and `prebuilds/win32-x64` without `.pdb` files (`conpty.node`, `conpty_console_list.node`, `pty.node`, `winpty.dll`, `winpty-agent.exe`, `conpty/conpty.dll`, `conpty/OpenConsole.exe`). `vsce package --no-dependencies` included the nested `node_modules` (42 files, 1.78 MB). The VSIX was unzipped under the temp folder, away from any checkout, and a script spawned a pseudo-terminal from it, resized it from 80×24 to 132×40 and killed it.
- **Result:**
  - Spawn, resize (the child read 132×40) and kill worked under Node.js 24 (ABI 137) and under Electron 43 (ABI 148), since node-pty's prebuilds use N-API.
  - The kill printed `Error: AttachConsole failed` from `conpty_console_list_agent.js` on stderr and still ended the child.
  - With `conpty.node` removed, the holder started and listened, and only a spawn failed: `Failed to load native module: conpty.node, checked: build/Release, build/Debug, prebuilds/win32-x64: …`.
  - While a process had `.node` files loaded, Node.js `writeFileSync` and `copyFileSync` over one failed with `EBUSY`, and `rmSync` and `renameSync` over one with `EPERM`. A second copy of the build in another folder ran beside the first.
- **Pass criteria (plan E11):** spawn, resize and kill from the extracted folder on each platform; a running holder survives a new build installed beside it; a missing binary fails only a Code Mode start. **Partial.** Passed on Windows x64: spawn, resize and kill from the extracted folder under Node.js 24 and Electron 43; a second build in its own folder ran beside a running one, whose loaded `.node` files cannot be replaced; with `conpty.node` missing the holder started and only a spawn failed. Outstanding: Node.js 22, and the hub started with the binary missing. Linux x64 is deferred (plan Q8).
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.

## M77. Claude runs nested in a Code Mode session

- **Date:** 2026-11-18.
- **Versions:** Claude Code CLI 2.1.327 (native build), Haiku 5.5, on Windows 11 Pro 10.0.26300.
- **Experiment:** a held session's `Bash` tool printed its environment and ran `claude -p` and `claude --bg`, each with `--settings` naming a hook that logs its environment.
- **Result:**
  - The shell had `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`, `SWITCHBOARD_LAUNCH`, `CLAUDE_CODE_SESSION_ID` and `ANTHROPIC_BASE_URL=https://api.anthropic.com`.
  - `claude -p` printed `Warning: Code Mode (experimental) isn't available: for now it only works in the interactive terminal.` and answered. Its hooks had a new session ID, `SessionStart` `startup`, the parent's `SWITCHBOARD_LAUNCH` and the variable, and `ANTHROPIC_BASE_URL` set to the gateway: user settings `env` replaced the inherited direct address.
  - `claude --bg` started a background session (stopped with `claude stop`) whose hooks had no `SWITCHBOARD_LAUNCH`, no variable and the gateway address, since the background service starts it.
- **Pass criteria (plan E15):** nested runs work, and their markers cannot be read as the held session's or as its ID change. **Partial.** Nested runs work and their session IDs differ from the held session's. A `claude -p` run's hooks carry the held session's launch ID, and only its first event is `SessionStart` `startup`; the hook writer replaces the marker on each event, so its later markers look like those of a held process whose ID changed (M73). Telling them apart needs evidence that outlives the next event, such as a `SessionStart` source the marker keeps, or the roster listing the held pid with the new ID (M67).
- **Not verified:** whether the roster lists a nested `claude -p` run.
- **Current use:** none. Code Mode sessions are planned, not implemented; this entry gates that work.
