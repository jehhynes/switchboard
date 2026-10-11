# Codex fixtures

Recorded on 2026-10-10 with Codex CLI 0.160.0 on Windows 11 in a scratch repository (mechanics M31); paths under the user profile are replaced by `C:/Users/operator`.

| File | What |
|---|---|
| `exec-completed.jsonl` | `codex exec --json` stdout of a turn that completed, with the hook-timeout warning items Codex adds before the turn |
| `exec-failed.jsonl` | stdout of a turn that failed on an API error (an unsupported model) |
| `exec-norepo.err` | stderr of a start outside a git repository |
| `rollout-failed.jsonl` | the `task_started` and `task_complete` records of the failed turn's rollout, with the error |
| `cim-tagged.json` | the CIM query's answer for a detached run found by its `switchboard_run` tag, in the fields `queryProcesses` selects |
| `rollout-panel.jsonl` | the turn records and user messages of a thread started by `codex exec`, resumed twice by `exec resume` and once in the VS Code panel, whose turns carry the context Codex adds as user messages |
