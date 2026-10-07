# Testing

Use automated checks for behavior and integration, and visual inspection for presentation. A passing suite does not replace review against [prd.md](prd.md).

## Required checks

| Change | Verification |
|---|---|
| Executable code | `npm run verify` |
| VS Code host wiring or UI-visible behavior | Also `npm run test:integration` in a real VS Code |
| Extension packaging | `vsce package --no-dependencies` succeeds |
| Runner, source fetch or report path | Also [live acceptance](#live-acceptance) from step 7 on |
| Markdown only | Accuracy, links, and consistency across documents |

`npm run verify` builds, typechecks, and runs workspace tests with coverage thresholds. Build first: spawn tests run built bundles.

## What earns a test

Test behavior that types cannot establish:

- Parsing source data and CLI output, malformed payloads, and clipping.
- Assigned-state transitions: first run, entering, leaving, and reassignment creating a new work item.
- The one-active-session rule, approval gates, and `requiresWorktree` handling.
- A failed or incomplete poll leaving every ticket's assigned state unchanged.
- Unassignment during an active session deferring the done decision.
- Work item status transitions, the concurrency limit, and `queued`.
- Hook installation: entries preserved, malformed settings refused, missing entries added. The event-to-state mapping from recorded markers, and the roster fallback.
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
| Chrome extension | Vitest/jsdom with a recorded board column and an injected hub read | Card marks, the column link, reads and refusals |
| Extension host | Mocha inside real VS Code | Registration, hub process wiring, terminal and editor calls |

Keep decisions in packages that do not import `vscode`.

## Live acceptance

Automated tests prove decisions against recorded fixtures. Live acceptance proves that the recorded mechanisms still hold and that the parts work together. The developing agent runs it, not the operator, at delivery step 7 and again after any change to the runner, a source's fetch, or the report path.

Run it with an isolated home (`hub.js --home=<repo>/.wip/acceptance-home`, so the Switchboard home is `.wip/acceptance-home/.switchboard`) and its own hub. Drive the panel from an extension development host launched with `SWITCHBOARD_HOME` set to that directory, never from the operator's installed extension. The extension and hub use that directory in place of `~/.switchboard`, for settings and playbooks too, since `SWITCHBOARD_HOME` makes the extension ignore `switchboard.configDir`, while Claude keeps the operator's profile, its sign-in and its trust. Reports reach the isolated hub because the CLI takes its home from the `hub.js` it runs from. The acceptance hub's hook entries point at its own home; remove them when the run ends. Use real Claude and read-only GitHub, Zoho Desk and Forum reads only; never a pick or any source write.

1. **GitHub read.** Configure the GitHub source with the operator's settings and every playbook set to `autoStart: false`. Confirm that the work items match the issues currently assigned to the operator in the configured statuses, and that each has a triage result. Never approve a GitHub work item during acceptance, because its playbook would run the operator's skills against a real issue.
2. **Ad-hoc session.** Use a scratch git repository under `.wip/`, trusted by running `claude` there once. Run an ad-hoc prompt that writes a file, reports a stage, reports a worktree, and reports done. Observe `running`, the stage, `done` and the release stop in the panel.
3. **Controls.** Attach to a running ad-hoc session and detach. Click an ended session to resume it in a console, and Ctrl+click it to open it in VS Code. Stop a session; it should end up `blocked` with "Stopped by you." Retry it. Reach `waiting` with a prompt that asks a question, and answer it in the attached console. Get the trust refusal from an untrusted directory.

Record each run in [mechanics.md](mechanics.md) with the date, the Claude CLI, VS Code and Claude extension versions, and the result of each step. A failed step is a defect or a new mechanics finding, not a skipped check.

## Fixtures and isolation

- Record and scrub source payloads and Claude CLI output (`claude agents --json`, `--bg` output, classifier JSON). Never call GitHub, Zoho, the Forum database or a real Claude session from a test.
- Inject the Switchboard home, clock and process spawner.
- Use literal expected values. Do not derive an expectation by calling the code under test.
- Assert counts where an empty result would pass a contents check.
- Make fakes fail on unexpected calls.
- Never run a skill that claims or writes to Zoho Desk or Forum in a test or a live check: no `/support-bind`, `/support-claim`, `/support-process`, Pick, or Approve on a Support work item. Test pick sessions with fake runners. The operator makes the first real pick.
