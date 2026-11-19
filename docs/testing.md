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

The dock's build and tests need the .NET 10 SDK, on Linux as on Windows. node-pty, the terminal holder's optional native dependency, has prebuilt binaries for Windows; on Linux npm builds it from source, which needs Python and a C++ toolchain, and without them the holder builds with no pseudo-terminals and its spawn tests fail.

## What earns a test

Test behavior that types cannot establish:

- Parsing source data and CLI output, malformed payloads, and clipping.
- Assigned-state transitions: first run, entering, leaving, and reassignment creating a new work item.
- The one-session-in-a-turn-per-ticket rule (R17), approval gates, and `requiresWorktree` handling.
- A failed or incomplete poll leaving every ticket's assigned state unchanged.
- Unassignment during an active session deferring the done decision, and unassignment deleting a work item that never had a session.
- Work item status transitions, the concurrency limit, and `queued`.
- Hook installation: entries preserved, malformed settings refused, missing entries added. The event-to-state mapping from recorded markers, and the roster fallback.
- Playbook loading from settings.json, playbook errors, and template rendering.
- Classifier output validation, including an unknown playbook name; default-provider routing and reload, model/provider fallback, Codex schema and temporary-file cleanup, and CLI failures.
- Report command handling, including unknown session IDs and worktree paths `git worktree list` does not show.
- Required CLI arguments for `claude --bg`, `claude -p`, `claude attach`, `claude stop`, `codex exec` and `codex exec fork`.
- Code Mode sessions (prd.md R93–R95):
  - The setting: `sessions.codeMode` off by default and refused when not a boolean; a start with it off, a Claude start with it on storing the Claude session ID and launch before the `start-session` action and routed to the Code Mode runner, a Codex start with it on, and a session keeping its mode after the setting changes; the Settings window's field and its save.
  - Arguments and environment: the gateway and credential variables removed and overridden in `--settings`, `viewMode: "focus"` in `--settings`, the contract followed by the panel's two prompt sections in `--append-system-prompt` at start and those sections alone at resume, the prompt as one argument, `--session-id`, the launch ID, and the start refused with `sessions.installHooks` off.
  - The start check: the `is on` line, an `isn't available` line with and without its `⚠`, a line wrapped at the terminal's width, an overwritten `SessionStart` marker, a marker of an older launch, a marker without the `is on` line, an early exit, a start prompt, and a hub restart during the start.
  - The end rule: a setup session's turn end, done, deleted, a newer session, and the 4-hour idle limit; a decided end deferred while a terminal is attached and applied at the last detach, without holding back the next session's start; an unobserved session ended by the idle limit without a turn end; and no automatic release while the turn has not ended (code still running) or the session waits on a question or permission; its serialization with attach and resume, with each operation paused at its boundary.
  - Delete of a held session (idle, attached, running, failed stop), of a starting Code Mode session killed in the holder by its Switchboard session ID, and of a session resumed through Open in terminal; the resume guard (a live process of the last tree, a reused pid, Stop offered on the ended session).
  - Holder loss: a session running, waiting, idle, starting, a setup session and a held approval; never `finished`.
  - Identity: a report from another native ID, the contract restore, an ID change by `/clear`, `/branch` and `/resume`, a nested `claude -p` marker that changes nothing, registration of a held ID, and an attach by Switchboard session ID that reuses its terminal after an ID change.
  - Held sessions (R94): orphan detection (an unknown session, an ended one still live, not an older session whose end waits), each orphan logged once, the list read with no active Code Mode session, a failed read keeping the last list and a gone holder emptying it; `hub.js holder list` and `stop` with the hub up and down, by each ID form, with an ambiguous prefix, an unknown ID, an exited session and a failed stop, and their exit codes; a stop that an attach waits for.
  - Holder protocol refusals: the token, the hello deadline, the line size, a malformed message, another protocol, `shutdown` with live sessions, and a slow client; `list`, `kill` and `shutdown` from a client of another protocol.

Do not test type declarations, pass-through property bags, or simple settings reads.

## Test layers

| Layer | Harness | Proves |
|---|---|---|
| Package logic | Vitest with injected clocks, stores, sources and runners | Decisions and failures |
| Hub server | Vitest with test-owned loopback listeners | Report endpoint, the window and dock streams, the config routes, refusals |
| Built hub | Spawn the built hub under a temporary home | Startup, single instance, shutdown |
| History webview | Vitest/jsdom with an `acquireVsCodeApi` stub | Rendering, filters and messages |
| Switchboard pane webview | Vitest/jsdom with a `postMessage` stub | Model from a snapshot, rendering, escaping, click messages and size reports |
| Side bar widths | Vitest with a fake workbench that squeezes side bars, runs the resize and hide commands, moves the focus and reports the pane's sizes | Kept drags, restores after a squeeze, the minimum window, the focus put back, and what is not kept; in a real VS Code host, the pane's sizes, a point kept at the first look, and a pane that has not loaded expanded once per workspace and not with the widths off |
| Chrome extension | Vitest/jsdom with a recorded board column, a recorded card and its More actions menu, and an injected hub read, snooze and unsnooze | Card marks, the column link, card pills, the card menu's items, the snooze popup, pill clicks, reads, requests and refusals, and the Switchboard tab group for the dock's links with fake Chrome calls |
| Firefox extension | Vitest on the Chrome manifest and `content.css` | The Firefox manifest and CSS changes, the build number in the version, the release tags, signing and releasing with fake git, `gh` and `web-ext` steps (refusals before signing, including an unreleased signed version, the signed file kept on a failed copy, record or release, a draft replaced), the refusal to sign a version already released or lower than a released one, and refusal of a Chrome manifest, version, build number or CSS the build no longer recognises |
| Extension host | Mocha inside real VS Code | Registration, hub process wiring, claims, the row click from VS Code, editor calls, the status bar item |
| Terminal holder | Vitest with an injected pseudo-terminal factory and test-owned loopback listeners | Spawn, list, kill by closing the terminal with the tree kill after the grace time or a failed close, replay in chunks, resize, several clients, exit retention, the retained output head, the handshake across protocols, limits and idle exit; the close's checks of node-pty's fields with fake terminals |
| Built holder | Spawn the built `holder.js` from an extracted package folder under a temporary home, with a real pseudo-terminal running `node -e`, per platform with `it.runIf` | Single instance, the record after a forced exit, surviving its clients and the hub, a kill that closes the terminal so the program's hang-up handler runs, killing a tree, and `shutdown` refused with a live session |
| GNOME Shell extension | Vitest | The choice of VS Code's and Ptyxis's windows (`windows.js`) |
| Dock | xUnit v3 with Avalonia.Headless, fakes of the hub, windows, VS Code and the terminal app, a test-owned loopback hub, and the recorded dock view in `apps/dock/test/fixtures/dock.json` | Parsing the hub's stream and view, the click's requests and switch, terminal clicks and the terminal apps' arguments and environment, refusals, the list, its groups, clicks, menus, drag reordering and keys, placement arithmetic, and the Settings window's pages, checks and writes |

A runtime test with ordinary Claude, Code Mode and Codex fake runners shows that a failed holder read does not stop the other runners' observations from applying.

Keep decisions in packages that do not import `vscode`, and the dock's rules in the hub's dock view, so the dock only draws them and moves windows. Win32 calls, the app bar, moving it between edges and monitors, and on Linux the X11 calls, how GNOME places and sizes the dock, the terminal apps themselves, and the GNOME Shell extension's `extension.js`, including its `Terminals` and `TerminalFocused`, and its D-Bus client are not covered by automated tests (the placement, strut and resize arithmetic, auto-hide against a fake of the X11 calls, and `ShellWindows` with a fake shell are, headless); the operator's live use checks them, and a change to them is checked in an isolated headless GNOME Shell as in [mechanics.md](mechanics.md) M39. Name each C# test `Subject_Action_Assertion`.

## Live acceptance

Automated tests prove decisions against recorded fixtures. Live acceptance proves that the recorded mechanisms still hold and that the parts work together. The developing agent runs it, not the operator, at delivery step 7 and again after any change to the runner, a source's fetch, or the report path.

Run it with an isolated home (`hub.js --home=<repo>/.wip/acceptance-home`, so the Switchboard home is `.wip/acceptance-home/.switchboard`) and its own hub. Drive it from the dock started with `--home <repo>/.wip/acceptance-home` and an extension development host launched with `SWITCHBOARD_HOME` set to that directory, never from the operator's installed extension. The extension and hub use that directory in place of `~/.switchboard`, for settings and playbooks too, since `SWITCHBOARD_HOME` makes the extension ignore `switchboard.configDir`, while Claude keeps the operator's profile, its sign-in and its trust. Start the acceptance hub with `CODEX_HOME` set to `.wip/acceptance-home/.codex`, holding a copy of `~/.codex/auth.json`, so its Codex hooks and their `hooks.state` trust entries stay out of `~/.codex`. Reports reach the isolated hub because the CLI takes its home from the `hub.js` it runs from. The acceptance hub's hook entries point at its own home; remove them when the run ends. Use real Claude and read-only GitHub, Zoho Desk and Forum reads only; never a pick or any source write.

1. **GitHub read.** Configure the GitHub source with the operator's settings and every playbook set to `autoStart: false`. Confirm that the work items match the issues currently assigned to the operator in the configured statuses, and that each has a triage result. Never approve a GitHub work item during acceptance, because its playbook would run the operator's skills against a real issue.
2. **Ad-hoc session.** Use a scratch git repository under `.wip/`, trusted by running `claude` there once. Run an ad-hoc prompt that writes a file, reports a stage, reports a worktree, and reports done. Observe `running`, the stage, `done` and the release stop in the dock.
3. **Controls.** Click an ended session's row; its item window comes forward and the session opens in its Claude view. Stop a session; it should end up `blocked` with "Stopped by you." Click the row to resume its session. Reach `waiting` with a prompt that asks an `AskUserQuestion`; the row shows the Answer a question mark and no option buttons. Use Open in Claude; the row keeps its status and the Answer a question mark, the session opens in the item window's Claude view, which asks the question again, and answering there returns the row to In progress. Get the trust refusal from an untrusted directory.
4. **Forks.** Release an ad-hoc session, open it in the item window's Claude view, and fork it with Fork conversation. Continue the fork; the row follows it, History shows that the session continues in the fork, a report run from the original is refused with the fork's ID, and resuming the original changes nothing.
5. **Code Mode** (prd.md R93–R95). Turn `sessions.codeMode` on in the acceptance home's `settings.json`, or with **Code Mode (experimental)** under General → Sessions in the dock's Settings window, and start its hub with `--code-mode-idle-ms` set to a few minutes. Run an ad-hoc session that reports a stage and done. Run one that asks an `AskUserQuestion`, and answer it through Open in terminal, once in the item window and once in the terminal app. Leave a session idle after its turn with no terminal attached until the short idle limit ends it, then resume it with Open in terminal. Attach to a session live, Stop it, and resume it with Enter in the terminal still open. Delete a work item while its terminal is attached. Restart the hub while a session runs; it keeps running and its reports land. Kill the holder; the running session's work item is blocked with "The terminal holder stopped.", and Open in terminal resumes it in a new holder. Show an orphan in `hub.js holder list` and the dock's held sessions window, and stop it there. Check the gateway: the session's `/status` shows the direct API and the subscription sign-in. Steps 1–4 run too, to show that background Claude and Codex sessions are unchanged.

Record each run in [mechanics.md](mechanics.md) with the date, the Claude CLI, VS Code and Claude extension versions, and the result of each step. A failed step is a defect or a new mechanics finding, not a skipped check.

## Fixtures and isolation

- Record and scrub source payloads and Claude and Codex CLI output (`claude agents --json`, `--bg` output, classifier JSON, `codex exec --json` output and stderr, rollout records, the process query's answer). Never call GitHub, Zoho, the Forum database or a real Claude session from a test.
- Record and scrub Code Mode screens and markers (the `is on` line, `isn't available` lines, the trust dialog, the first Code Mode confirmation, a session ID change, a nested `claude -p`) from the runs in [mechanics.md](mechanics.md) M63–M77 for the start check and the identity rule. Never run a real Claude or a real pseudo-terminal holding Claude in a test.
- Inject the Switchboard home, clock and process spawner.
- Test each platform's process table and path rules on any platform by passing the platform and recorded fixtures, such as `packages/codex/test/fixtures/proc/`. A test that needs real processes or the platform's own path rules runs only on that platform (`it.runIf`, `it.skipIf`), and the other platform's code has a test of its own, against a recorded answer such as `cim-tagged.json` where it cannot run here. The Windows hook's process walk was verified by hand (mechanics M31), and `taskkill` through the hub's Stop in live acceptance (mechanics M32).
- Give a spawned hub its own `CLAUDE_CONFIG_DIR` and `CODEX_HOME`; it installs hooks in both. Every vitest config's `testTemp()` ([vitest-temp.ts](../tools/vitest-temp.ts)) points both at the shared test temp folder, so a test that forgets cannot reach the operator's.
- Use literal expected values. Do not derive an expectation by calling the code under test.
- Assert counts where an empty result would pass a contents check.
- Make fakes fail on unexpected calls.
- Never run a skill that claims or writes to Zoho Desk or Forum, such as `/support-process`, in a test or a live check, and never Pick or Approve a Support work item. Test picks with fake runners. The operator makes the first real pick.

## Handled assignments

R85 tests cover registration before queue entry, unchanged assignments across status changes, unassignment and reassignment between polls, multiple operator logins, pagination and incomplete history, direct reads outside project search, failed reads, serialized polling/reporting, conditional release with fresh eligibility, retries after release, the end of the registration when the originating work item is done or deleted, with and without the assignment, and its triage's earlier work, identity consolidation, and refusal after a session start is emitted. Core uses arbitrary source/playbook names; GitHub event interpretation is tested in the adapter. History tests verify readable registration and clearing, including clearing by another ticket's work item ending, and report tests cover CLI parsing and HTTP validation. Live acceptance uses isolated storage, real read-only GitHub assignment queries and the report CLI; it changes no source assignments or project status.

## Support volume

Core tests verify observed queue retention, initial baseline, assignment transfers, work-item deletion, identity consolidation, failed polls, coverage gaps, distinct-ticket counts and timezone/DST boundaries. Source fixtures verify all fetched Support tickets are retained with no additional history/audit reads for other engineers. Hub tests cover filter validation and bounded detail responses; dock headless tests cover counts, unavailable weeks, source filtering, ticket links and failed refreshes. Live acceptance uses isolated storage and read-only source polling; it must not pick or start any Support ticket.

Support classification tests cover priority and shared concurrency, other-assignee isolation, failure and cancellation, departure while waiting, assignment changes, durable classifications after deletion, migration from existing triages, and classifications in volume details.
