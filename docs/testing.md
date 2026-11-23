# Testing

Use automated checks for behavior and integration, and visual inspection for presentation. A passing suite does not replace review against [prd.md](prd.md).

## Required checks

| Change | Verification |
|---|---|
| Executable code, while working | The pre-commit hook, or `npm run verify:staged` |
| Executable code, before merging into `main` | `npm run verify` |
| VS Code host wiring or UI-visible behavior | Also `npm run test:integration` in a real VS Code |
| Extension packaging | `npm run package --workspace switchboard` (`vsce package --no-dependencies`) succeeds |
| Runner, source fetch or report path | Also [live acceptance](#live-acceptance) |
| The web page console's layout: `console.ts`, its rules in `page.css`, or an xterm.js upgrade | Also `npm run build`, then `npm run check:console --workspace @switchboard/web` |
| The web page's shell on a phone: the page's height, safe areas, top bars, scrollers, overscroll or touch-action in `page.css` or `settings.css`, or the layout of a list row's line 2 | Also `npm run build`, then `npm run check:shell --workspace @switchboard/web` |
| The web page's connection, requests, opening a work item, service worker, boot screen or route: `connection.ts`, `request.ts`, `opening.tsx`, `sw.ts`, `boot.js`, `index.html` or `route.ts` | Also `npm run build`, then `npm run check:offline --workspace @switchboard/web`, which drives the page in a headless Chrome or Edge against its own fake hub on a loopback port, with faults, latency and restarts, never a running hub; `--shots <dir>` saves a screenshot of each scenario and `--assets` runs another build |
| A behaviour listed in [parity.md](parity.md) | The same change on the dock and the web page, or a Differs row the operator approved or decided, and parity.md updated in the same commit ([AGENTS.md](../AGENTS.md#dock-and-web-parity)) |
| Markdown only | Accuracy, links, and consistency across documents |

`npm run verify` ([tools/verify.mjs](../tools/verify.mjs)) builds, typechecks and runs every workspace's tests with their coverage thresholds, including the dock's `dotnet build` and `dotnet test`. To run a workspace's tests on their own, build first, because spawn tests run built bundles.

While working, run only the tests the change affects. No git hook runs `npm run verify` at a merge, because merges into `main` fast-forward, so the merging session runs it.

The pre-commit hook (`.githooks/pre-commit`, enabled through `core.hooksPath` by `npm install`) runs [tools/precommit.mjs](../tools/precommit.mjs), as `npm run verify:staged` does. It builds, typechecks and tests the workspaces the staged files touch and every workspace that depends on them, building their dependencies first. A dependency the manifests do not declare, or a file another workspace's tests read, must be added to the lists in that script. A staged file outside every workspace, such as `package.json` or a file in `tools/`, runs the full `npm run verify`, as `SWITCHBOARD_VERIFY=full` does. Markdown and text files, and the hook's own files, run no checks.

`npm run verify`, the pre-commit hook and the integration tests that `npm run test:integration` starts after its build run their checks without the caller's `GIT_*` variables and fail when a check changed `core.bare`, `core.worktree`, `core.hooksPath` or a `user`, `author` or `committer` key in the repository's shared git config ([tools/git-guard.mjs](../tools/git-guard.mjs)); the failure names each change and how to undo a config change, and the guard changes nothing itself. The pre-commit hook also fails when the checkout's HEAD, branch or index changed, because staging during the hook can change what the commit holds; `npm run verify` does not watch them, because a session can stage, commit or rebase in that checkout while it runs. Shared refs and other config keys are not watched, because work in another worktree changes them during a run. The guard exists because a commit hook runs with `GIT_DIR` and `GIT_INDEX_FILE` set to the checkout being committed to, and in a worktree that `GIT_DIR`'s config is the main repository's `.git/config`: a test's `git init` with it reinitializes that repository as bare, `git config user.name` sets the author of every later commit, and `git add`, `git commit` or `git update-ref` change the commit being made or the shared refs.

The dock's build and tests need the .NET 10 SDK, on Linux as on Windows. node-pty, the terminal holder's optional native dependency, has prebuilt binaries for Windows; on Linux npm builds it from source, which needs Python and a C++ toolchain, and without them the holder builds with no pseudo-terminals and its spawn tests fail.

## What earns a test

Test behavior that types cannot establish, such as:

- Parsing source data, CLI output, transcripts and screens, including malformed and partial input and clipping.
- State transitions of tickets, work items and sessions, including first runs, reassignment, unassignment during a session, and a failed or incomplete poll leaving every ticket's assigned state unchanged.
- Rules that hold work back: the one-session-in-a-turn-per-ticket rule (R17), approval gates, the concurrency limit, input guards and reservations.
- Every refusal a protocol, route or command makes, such as a stale `scopeGen`, another window's key, a forged session ID or a malformed body, and the idempotence of a repeated `opId`.
- Delivery to the right recipients only: events and streams to the windows or pages showing a session, and nothing to the others.
- Ordering and settlement under restarts, reconnects and lost answers: nothing delivered twice or lost, and a pending operation settled once.
- Settings and playbook loading, with their defaults, refusals and template rendering; hook installation that preserves entries and refuses malformed settings.
- The required arguments and environment of each agent CLI Switchboard starts, such as `claude --bg`, `claude -p` and `codex exec`.
- Path and file access limits: real paths, junctions and `..` refused where the design keeps access inside a folder, such as a paired device's folders in the New session form, tested with junctions the test makes under its temp folder.
- Cleanup: temporary files, processes and stored data removed with what owns them.

Do not test type declarations, pass-through property bags, or simple settings reads.

## Test layers

| Layer | Harness | Proves |
|---|---|---|
| Package logic | Vitest with injected clocks, stores, sources and runners | Decisions and failures |
| Hub server | Vitest with test-owned loopback listeners | Routes, streams and their refusals |
| Built hub | Spawn the built hub under a temporary home | Startup, single instance, shutdown |
| History webview | Vitest/jsdom with a stubbed webview API | Rendering, filters and messages |
| Conversation view | Vitest/jsdom with a `postMessage` stub | State from stream events, rendering, keys, the composer and message delivery |
| Switchboard pane webview | Vitest/jsdom with a `postMessage` stub | Model from a snapshot, rendering, escaping, click messages and size reports |
| Side bar widths | Vitest with a fake workbench, and the real VS Code host | Kept and restored widths and focus |
| Web page | Vitest/jsdom (`packages/web`) | The page's model, rendering, escaping, keys and requests |
| Chrome extension | Vitest/jsdom with recorded board markup and an injected hub | Card marks, menus, popups, requests and refusals; the Switchboard tab group and the page's link requests, with fake Chrome calls |
| Firefox extension | Vitest on the Chrome manifest and `content.css`, with fake git, `gh` and `web-ext` steps | The Firefox build, versioning, signing and release, and refusal of Chrome inputs the build no longer recognises |
| Extension host | Mocha inside real VS Code | Registration, hub process wiring, claims, editor calls, the status bar item |
| Terminal holder | Vitest with an injected pseudo-terminal factory and test-owned loopback listeners | Spawn, list, kill, replay, resize, clients, the handshake, limits and idle exit |
| Built holder | Spawn the built `holder.js` from an extracted package folder under a temporary home, with a real pseudo-terminal running `node -e`, per platform with `it.runIf` | Single instance, recovery after a forced exit, surviving its clients and the hub, tree kills, `shutdown` refused with a live session |
| Voice process | Vitest with fake speech, playback, capture, recogniser, turn model and socket, hand-run timers, test-owned loopback listeners and temporary folders | The protocol, routing, speech, dictation, the voice check and alerts |
| Built voice process | Start the packaged `voice.js` from an extracted package folder under a temporary home | Native modules load and the packaged build carries its files |
| Web page console in a browser | [packages/web/check-console.mjs](../packages/web/check-console.mjs) in headless Chrome or Edge (`SWITCHBOARD_CHROME`, else where they install); not part of `npm test` | The console's layout: the screen stays inside its pane and xterm.js's scrollbar is its only scroller |
| Web page shell in a browser | [packages/web/check-shell.mjs](../packages/web/check-shell.mjs) in headless Chrome or Edge at an iPhone's portrait and landscape sizes and an iPad's landscape size, light and dark, with the installed app's rules, touch and safe-area insets; not part of `npm test`, and no browser draws iOS's top blur or pans a page as iOS does | The document is exactly the viewport, nothing outside a scroller reaches past it or moves under a drag, every scroller keeps a drag to itself or inside a scroller that does, a drag still scrolls a long conversation, also from a table in a reply, the iPhone draws the phone's layout in both orientations and the iPad the tablet's, each view's top bar starts at the top with no band above it, and in portrait WebKit's top-edge test finds that bar in the bars' colour (a sheet's backdrop for a sheet); on the list, also at 200 px, line 2's playbook or host is never cut, its pills are whole or left out whole, the ticket key always whole, and line 2 paints the same while the hub sends the same list again |
| GNOME Shell extension | Vitest | The choice of VS Code's and the terminal's windows (`windows.js`) |
| Dock | xUnit v3 with Avalonia.Headless, fakes of the hub, windows, VS Code and the terminal app, a test-owned loopback hub, and the recorded dock view in `apps/dock/test/fixtures/dock.json` | Parsing the hub's stream and view, clicks, menus, keys, placement arithmetic and the Settings window; turn `TestApp.Options.OverlayPopups` off where popups must be windows of their own |

Keep decisions in packages that do not import `vscode`, and the dock's rules in the hub's dock view, so the dock only draws them and moves windows. Platform window calls (Win32, the app bar, X11), how GNOME places the dock, the terminal apps themselves, and the GNOME Shell extension's `extension.js` and its D-Bus client are not covered by automated tests; the arithmetic around them is, headless, against fakes. The operator's live use checks them, and a change to them is checked in an isolated headless GNOME Shell as in [mechanics.md](mechanics.md) M39. Name each C# test `Subject_Action_Assertion`.

The Linux integration profile uses `--password-store=basic` so a private GNOME session cannot block tests on a new-keyring dialog. It stores no real credentials.

## Live acceptance

Automated tests prove decisions against recorded fixtures. Live acceptance proves that the recorded mechanisms still hold and that the parts work together. The developing agent runs it, not the operator, after any change to the runner, a source's fetch, or the report path.

Run it with an isolated home (`hub.js --home=<repo>/.wip/acceptance-home`, so the Switchboard home is `.wip/acceptance-home/.switchboard`) and its own hub. Drive it from the dock started with `--home <repo>/.wip/acceptance-home` and an extension development host launched with `SWITCHBOARD_HOME` set to that directory, never from the operator's installed extension. The extension and hub use that directory in place of `~/.switchboard`, for settings and playbooks too, since `SWITCHBOARD_HOME` makes the extension ignore `switchboard.configDir`, while Claude keeps the operator's profile, its sign-in and its trust. Start the acceptance hub with `CODEX_HOME` set to `.wip/acceptance-home/.codex`, holding a copy of `~/.codex/auth.json`, so its Codex hooks and their `hooks.state` trust entries stay out of `~/.codex`. Reports reach the isolated hub because the CLI takes its home from the `hub.js` it runs from. The acceptance hub's hook entries point at its own home; remove them when the run ends. Use real Claude and read-only GitHub, Zoho Desk and Forum reads only; never a pick or any source write.

1. **GitHub read.** Configure the GitHub source with the operator's settings and every playbook set to `autoStart: false`. Confirm that the work items match the issues currently assigned to the operator in the configured statuses, and that each has a triage result. Never approve a GitHub work item during acceptance, because its playbook would run the operator's skills against a real issue.
2. **Ad-hoc session.** Use a scratch git repository under `.wip/`, trusted by running `claude` there once. Run an ad-hoc prompt that writes a file, reports a stage, reports a worktree, and reports done. Observe `running`, the stage, `done` and the release stop in the dock.
3. **Controls.** Click an ended session's row; its item window comes forward and the session opens in its Claude view. Stop a session with Stop session; it should end up `blocked` with "Stopped by you." Click the row to resume its session. Reach `waiting` with a prompt that asks an `AskUserQuestion`; the row shows the Answer a question mark and no option buttons. Use Open in Claude; the row keeps its status and the Answer a question mark, the session opens in the item window's Claude view, which asks the question again, and answering there returns the row to In progress. Get the trust refusal from an untrusted directory.
4. **Forks.** Release an ad-hoc session, open it in the item window's Claude view, and fork it with Fork conversation. Continue the fork; the row follows it, History shows that the session continues in the fork, a report run from the original is refused with the fork's ID, and resuming the original changes nothing.
5. **Code Mode** (prd.md R93–R95). Turn `sessions.codeMode` on in the acceptance home's `settings.json`, or with **Code Mode (experimental)** under General → Sessions in the dock's Settings window, and start its hub with `--code-mode-idle-ms` set to a few minutes. Run an ad-hoc session that reports a stage and done. Run one that asks an `AskUserQuestion`, and answer it through Open in terminal, once in the item window and once in the terminal app. Leave a session idle after its turn with no terminal attached until the short idle limit ends it, then resume it with Open in terminal. Attach to a session live, stop it with Stop session, and resume it with Enter in the terminal still open. Delete a work item while its terminal is attached. Restart the hub while a session runs; it keeps running and its reports land. Kill the holder; the running session's work item is blocked with "The terminal holder stopped.", and Open in terminal resumes it in a new holder. In Windows Terminal and in VS Code's terminal, close an attached terminal and open it again; check by eye that the replay shows the screen as Claude drew it and that typing, a paste, Shift+Tab, Ctrl+O and Esc reach Claude ([mechanics.md](mechanics.md) M72, M84). Show an orphan in `hub.js holder list` and the dock's held sessions window, and stop it there. Check the gateway: the session's `/status` shows the direct API and the subscription sign-in. Have a session ask question cards in the rules' shape (PRD R103): answer one from the web page on a phone, by touch and by voice, leave one open across an unrelated message, dismiss one, and check that the session receives the `[answers]` text and that the work item waits until no question is open. Steps 1–4 run too, to show that background Claude and Codex sessions are unchanged.

Record each run in [mechanics.md](mechanics.md) with the date, the Claude CLI, VS Code and Claude extension versions, and the result of each step. A failed step is a defect or a new mechanics finding, not a skipped check.

## Codex app-server

Codex app-server tests (R107) inject an app-server transport or a recorded-protocol peer; they never start the operator's daemon or call a live model. Record fixtures under an isolated Codex home and scrub their paths and IDs. Test sidebar requests in jsdom and focus and terminal wiring in the real VS Code host.

For live acceptance, use a scratch repository and a separate `CODEX_HOME` with a temporary copy of the sign-in, removed afterwards. Start threads through the built hub and send follow-ups through its conversation route. Restart the hub during a tool call and confirm the replay has no duplicate messages. Answer a native request before and after a reconnect. Connect the same thread in the native terminal. Stop one of two threads and confirm the other continues. Verify a report and an artifact. Never stop or update the operator's daemon; stop only the isolated acceptance daemon afterwards. Record the CLI versions and results in mechanics.md.

## Session provider choice

No provider-choice test starts a real agent: hub and package tests use fake runners, the real VS Code host test talks to an isolated loopback peer, and headless dock tests check the HTTP payloads they send.

## Fixtures and isolation

- Record and scrub source payloads and Claude and Codex CLI output (`claude agents --json`, `--bg` output, classifier JSON, `codex exec --json` output and stderr, rollout records, the process query's answer). Never call GitHub, Zoho, the Forum database or a real Claude session from a test.
- Record and scrub Code Mode screens and markers from the runs in [mechanics.md](mechanics.md) M63–M77. Never run a real Claude or a real pseudo-terminal holding Claude in a test.
- Inject the Switchboard home, clock and process spawner.
- Test each platform's process table and path rules on any platform by passing the platform and recorded fixtures, such as `packages/codex/test/fixtures/proc/`. A test that needs real processes or the platform's own path rules runs only on that platform (`it.runIf`, `it.skipIf`), and the other platform's code has a test of its own, against a recorded answer such as `cim-tagged.json` where it cannot run here. Write expected path keys literally, with a fixed mixed-case name where case rules differ by platform.
- Give a spawned hub its own `CLAUDE_CONFIG_DIR` and `CODEX_HOME`; it installs hooks in both. Every vitest config's `testTemp()` ([vitest-temp.ts](../tools/vitest-temp.ts)) points both at the shared test temp folder, so a test that forgets cannot reach the operator's.
- Run git in a test only against a scratch repository the test made under the OS temp folder: pass `-C <repo>` or `--file` to every command, drop every `GIT_*` variable from the child's environment, set `GIT_CEILING_DIRECTORIES` to the temp folder, and check after `git init` that `git rev-parse --absolute-git-dir` names the scratch repository's `.git`. Never run `git config` without them. Every vitest config's `testTemp()` drops the `GIT_*` variables its workers inherit and sets `GIT_CEILING_DIRECTORIES` to the shared test temp folder; a script outside vitest that starts git or a test run uses `cleanGitEnv()` from [tools/git-guard.mjs](../tools/git-guard.mjs).
- Make a test's waits independent of machine load. Wait for a condition, such as a process's exit, a stored delivery, a replay or backpressure, never for a fixed time; give a wait on work that runs real timers, such as a screen replayed in xterm, the test's own timeout as its limit; give a fake clock's `sleep` a macrotask (`setImmediate`) so a polling loop never starves the test's timers. Count `taskkill` failing on a process that then turns out gone as success, await a worker's or process's end before removing its folder, and remove temp folders with `maxRetries`, since Windows can hold a file just closed for a moment longer.
- Use literal expected values. Do not derive an expectation by calling the code under test.
- Assert counts where an empty result would pass a contents check.
- Make fakes fail on unexpected calls.
- Never run a skill that claims or writes to Zoho Desk or Forum, such as `/support-process`, in a test or a live check, and never Pick or Approve a Support work item. Test picks with fake runners.

## Handled assignments

Test handled-assignment rules (R85) in core with arbitrary source and playbook names, and GitHub's event interpretation in the GitHub adapter. Live acceptance uses isolated storage, real read-only GitHub assignment queries and the report CLI; it changes no source assignments or project status.

## Support volume

R84 is removed ([prd.md](prd.md)); test the rules that replaced it (R5, R46, R18, R47) as any other requirement.
