# Testing

Use automated checks for behavior and integration, and visual inspection for presentation. A passing suite does not replace review against [prd.md](prd.md).

## Required checks

| Change | Verification |
|---|---|
| Executable code | `npm run verify` |
| VS Code host wiring or UI-visible behavior | Also `npm run test:integration` in a real VS Code |
| Extension packaging | `vsce package --no-dependencies` succeeds |
| Markdown only | Accuracy, links, and consistency across documents |

`npm run verify` builds, typechecks, and runs workspace tests with coverage thresholds. Build first: spawn tests run built bundles.

## What earns a test

Test behavior that types cannot establish:

- Parsing source data and CLI output, malformed payloads, and clipping.
- Assigned-state transitions: first run, entering, leaving, and reassignment creating a new work item.
- The one-active-session rule, approval gates, and `requiresWorktree` handling.
- Playbook loading, front-matter errors, and template rendering.
- Classifier output validation, including an unknown playbook name.
- Report command handling, including unknown session IDs and worktree paths `git worktree list` does not show.
- Required CLI arguments for `claude --bg`, `claude -p`, `claude attach` and `claude stop`.

Do not test type declarations, pass-through property bags, or simple settings reads.

## Test layers

| Layer | Harness | Proves |
|---|---|---|
| Package logic | Vitest with injected clocks, stores, sources and runners | Decisions and failures |
| Hub server | Vitest with test-owned loopback listeners | Report endpoint, panel protocol, refusals |
| Built hub | Spawn the built hub under a temporary home | Startup, single instance, shutdown |
| Webview | Vitest/jsdom with an `acquireVsCodeApi` stub | Rendering, controls and messages |
| Extension host | Mocha inside real VS Code | Registration, hub process wiring, terminal and editor calls |

Keep decisions in packages that do not import `vscode`.

## Fixtures and isolation

- Record and scrub source payloads and Claude CLI output (`claude agents --json`, `--bg` output, classifier JSON). Never call GitHub, Zoho, the Forum database or a real Claude session from a test.
- Inject the Switchboard home, clock and process spawner.
- Use literal expected values. Do not derive an expectation by calling the code under test.
- Assert counts where an empty result would pass a contents check.
- Make fakes fail on unexpected calls.
