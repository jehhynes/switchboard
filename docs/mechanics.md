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
- **Current use:** the roster read covers every started session so a resume is seen (PRD R17); Attach and Open in VS Code (architecture.md § Claude Code runner).

## M8. Writing Claude's settings.json on Windows

- **Date:** 2026-10-03.
- **Versions:** Windows 11, Node 24, Claude Code CLI 2.1.288.
- **Observation:** during live acceptance, a hub's first start failed renaming its temporary file over `~/.claude/settings.json` with `EPERM`, because another process had the file open; the next start succeeded. Two hook processes of one session writing the same marker hit the same refusal and left a temporary file.
- **Current use:** hook installation retries the rename 10 times, 100 ms apart, removes its temporary file when it gives up, and shows the error in the panel instead of stopping the hub. The hook writer removes its temporary file when the rename fails.

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
- **Current use:** the open and claim path, approval reports, and the pool display (architecture.md § Flow, § Panel).

## Pending verification

These mechanisms are planned but not yet verified for Switchboard:

- A real pick session claiming a pool ticket through `support-bind`. By the operator's rule no test claims a case; the operator makes the first real pick.
