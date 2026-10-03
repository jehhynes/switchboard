# Mechanics

Dated experiments and source inspections that Switchboard relies on. Each entry records the version tested, the result, its limits, and where Switchboard uses it. An entry here does not imply product support.

Ground Control's [mechanics.md](../../ground-control/docs/mechanics.md) holds the verified session mechanics Switchboard reuses. Copy an entry here, re-verified, when Switchboard first depends on it.

## M1. `node:sqlite` in the hub runtimes

- **Date:** 2026-10-02.
- **Versions:** VS Code's `Code.exe` with `ELECTRON_RUN_AS_NODE=1` (Electron 43.7.3, Node 24.21.0); system Node 24.14.0.
- **Experiment:** `require('node:sqlite')`, open `DatabaseSync(':memory:')`, create a table, insert with a prepared statement, select.
- **Result:** works in both runtimes with no native module. System Node prints `ExperimentalWarning: SQLite is an experimental feature`; the module's API may still change between Node versions.
- **Current use:** the store (architecture.md § Store). Re-run after a VS Code or Node upgrade.

## Pending verification

These mechanisms are planned but not yet verified for Switchboard:

- `claude --bg` output and short-ID matching against `claude agents --json` (GC M1, M33) on the installed CLI version.
- `claude -p --json-schema` classifier flags and stdin input (GC M31).
- `claude attach` and `claude-vscode.primaryEditor.open` behavior (GC M5–M7, M33, M45).
