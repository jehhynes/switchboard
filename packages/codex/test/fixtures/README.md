# Codex fixtures

Recorded on 2026-10-10 with Codex CLI 0.160.0 on Windows 11 in a scratch repository (mechanics M31); paths under the user profile are replaced by `C:/Users/operator`.

| File | What |
|---|---|
| `exec-completed.jsonl` | `codex exec --json` stdout of a turn that completed, with the hook-timeout warning items Codex adds before the turn |
| `exec-failed.jsonl` | stdout of a turn that failed on an API error (an unsupported model) |
| `exec-norepo.err` | stderr of a start outside a git repository |
| `rollout-failed.jsonl` | the `task_started` and `task_complete` records of the failed turn's rollout, with the error |
| `cim-tagged.json` | the CIM query's answer for a detached run found by its `switchboard_run` tag, in the fields `queryProcesses` selects |
| `proc/` | `/proc/<pid>/stat` and `cmdline` of a `codex app-server` started with `-c switchboard_run="sbtest42-1"`, recorded on 2026-10-17 with Codex CLI 0.163.0 on Ubuntu 26.04: npm's Node launcher (1223833, whose name is `MainThread`) and its native `codex` child (1223843), with `/home/operator` replaced by `/home/operator`. `1223850` is the child's entry edited into an exited child (state `Z`, no arguments) |
| `rollout-panel.jsonl` | the turn records and user messages of a thread started by `codex exec`, resumed twice by `exec resume` and once in the VS Code panel, whose turns carry the context Codex adds as user messages |
