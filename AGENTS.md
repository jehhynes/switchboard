# Switchboard

Switchboard is a local software factory for one developer. It ingests tickets assigned to the operator from GitHub, Zoho Desk, Forum and ad-hoc prompts, triages each into a playbook, runs the playbook in a background Claude Code session, and shows the work in the dock, a native app beside VS Code that switches to each work item's VS Code window. See [prd.md](docs/prd.md).

Switchboard replaces Ground Control (`D:\git\ground-control`), which no longer runs. Its session and triage mechanics come from there: read its code and [mechanics.md](../ground-control/docs/mechanics.md) before re-deriving a mechanism it already verified.

## Workflow

1. Read the relevant docs and implementation. Write a plan, including verification, before coding.
2. Implement the change and update affected docs in the same task. Test new behavior according to [testing.md](docs/testing.md).
3. Review the change with the `cross-check` skill, so the other provider reviews it, before you report the task as done or ask for acceptance. Cover requirements, correctness, regressions, and UI behavior where applicable. Fix or answer each finding before you report the task as done.
4. Complete the required checks. For executable changes to the extension or hub, [rebuild and reinstall](#reinstalling-after-a-change).
5. Commit each self-contained story or task after review, verification, and acceptance by the operator or the product manager session.

Settle product questions with the Goals, Non-goals and Design rules in [prd.md](docs/prd.md#goals), and record each new decision in the document that owns it. Escalate only what those rules do not settle.

### Roles

When the operator appoints a product manager session:

- The product manager session owns product decisions and the docs, accepts work against the PRD, and writes no code and runs no tests.
- The developer session builds and tests, itself or through subagents, and asks the product manager session the product questions that the Goals, Non-goals and Design rules do not settle.
- The developer session sends the product manager session readable evidence when it asks for acceptance: the `cross-check` findings and the fix or answer for each, test names and counts, check output or its file path, integration and live acceptance results, and the R IDs implemented.

Continue until the task is complete or blocked. Ask for clarification when required intent is unresolved, credentials are missing, the work would deviate from the PRD, or verification is inadequate.

## Wording

Use concise, direct wording everywhere in this repository, including code, identifiers, comments, prompts, documentation, tests, settings, logs, user-facing copy, and generated output.

- Use familiar words and concrete names. State the action, fact, or constraint directly.
- Remove filler, repetition, boilerplate, metaphors, personification, and unnecessary detail. Avoid invented jargon and vague or cryptic names.
- Use the terms defined in [prd.md](docs/prd.md#terms) — ticket, work item, playbook, triage, session — with one word per concept in code, settings and UI.
- Keep code simple. Comments should explain non-obvious behavior or constraints, not restate the code or narrate change history.
- Preserve meaning, technical precision, uncertainty, diagnostic details, and recovery steps. Brevity must not hide relevant information or change behavior, required syntax, or external contracts.

## Documentation

Read and update the document responsible for the decision:

| Document | Owns |
|---|---|
| [prd.md](docs/prd.md) | Product behavior, scope, requirements (R IDs), delivery order, and implementation gaps |
| [architecture.md](docs/architecture.md) | Packages, component responsibilities, dependencies, state, and protocols |
| [mechanics.md](docs/mechanics.md) | Dated experiments and source inspections, versions, limitations, and current use (M IDs) |
| [testing.md](docs/testing.md) | Required checks, test layers, fixture rules, and isolation |
| [parity.md](docs/parity.md) | Each dock list and row behaviour and whether the web page matches it |

State only Switchboard's own behavior and constraints. Skills that sessions run are outside Switchboard and may change independently: name one only as an example, such as a prompt in a sample setting, and never describe how it works.

Replace superseded text in place. Record the decision and its constraint; omit discussion history, discarded proposals, and changelog prose. Distinguish current implementation, future requirements, and experimental evidence. An experiment does not imply product support. Re-verify version-fragile mechanisms after upgrading Claude Code, its VS Code extension, or VS Code.

## Verification

[testing.md](docs/testing.md) is the full contract.

- For executable changes, run only the checks the change affects while working: the pre-commit hook does, through `npm run verify:staged`, so commit without `--no-verify`. Run `npm run verify` (build, typecheck, tests, and coverage thresholds) before merging a branch into `main`.
- Run `npm run test:integration` for VS Code host wiring or UI-visible behavior. It uses a real extension host with isolated settings and home. Verify behavior directly instead of asking the developer to click through it.
- Choose the test layer by API dependencies. Package logic and webview DOM belong in Vitest; `vscode` wiring belongs in the real-host suite.
- Use recorded, scrubbed fixtures and injected homes. No external network traffic, real Claude sessions, or developer services in tests; test-owned loopback listeners are allowed.
- Assert failures and refusals as well as success. Each assertion must detect a possible implementation defect.
- For documentation, check accuracy and links.

Run commands from the repository root:

| Command | Purpose |
|---|---|
| `npm run verify:staged` | Build, typecheck and test the workspaces the staged files touch and their dependents; the pre-commit hook runs it |
| `npm run verify` | Build, typecheck, tests, coverage, and the dock's and the pane helper's `dotnet build` and `dotnet test`; run before merging into `main` |
| `npm run verify:full` | Verify plus VS Code integration tests |
| `npm run test:integration` | Build and run VS Code integration tests |

### Reinstalling after a change

For executable changes to the VS Code extension, hub, or bundled packages:

```bash
npm run build
npm run package --workspace switchboard
code --install-extension extensions/switchboard/switchboard-0.0.0.vsix --force
node ~/.vscode/extensions/switchboard.switchboard-0.0.0/dist/hub.js install
```

Package with `vsce package --no-dependencies`; the workspace script includes the flag. Build first, because packaging does not build. A repository build alone does not update the installed VSIX.

Confirm the installed bundle under `%USERPROFILE%/.vscode/extensions/switchboard.switchboard-0.0.0/dist/` (`~/.vscode/extensions/…` on Linux) contains the change. `hub.js install` copies the hub, holder, voice and pane helper builds into the Switchboard home, as a window's activation does, and the running hub restarts onto the new hub build once it is quiet, so a change to the hub or a bundled package needs no reload; `node ~/.switchboard/hub.js restart` waits for the restart and prints the new build. For a change to the extension's own UI, report that the developer can reload when ready. Do not reload their window.

The Chrome pane helper (`apps/pane-helper`) ships in the VS Code extension, not with the dock: for changes to it, rebuild, package and install the extension as above.

For changes to the dock, close the running dock (it holds its files open), then run `npm run publish --workspace @switchboard/dock`, which publishes it to `~/.switchboard/dock/` (`%USERPROFILE%` on Windows), and report that the operator can start `Switchboard.Dock.exe`, or `Switchboard.Dock` on Linux, there.

For changes to the browser extension (`extensions/chrome` or `extensions/firefox`), run `npm run build` and `npm run lint --workspace @switchboard/firefox`, which must report no errors. Report that the operator can reload `extensions/chrome/dist` in `chrome://extensions` and load `extensions/firefox/dist/manifest.json` in `about:debugging`. `npm run sign --workspace @switchboard/firefox` signs and releases the Firefox build only from a pushed commit, so run it after the change is pushed when `~/.switchboard/amo.env` holds the operator's keys, without reading that file, and otherwise report that the operator can; they then install `extensions/firefox/switchboard-firefox-signed.xpi` from `about:addons`.

For changes to the GNOME Shell extension, run `npm run publish --workspace @switchboard/gnome-shell`, which installs it to `~/.local/share/gnome-shell/extensions/switchboard@switchboard/` and enables it, and report that GNOME Shell loads the change at the operator's next login.

## Dock and web parity

[parity.md](docs/parity.md) lists every behaviour of the dock's work item list and rows, and whether the web page matches it.

- Make a change to a behaviour parity.md lists on both the dock and the web page in the same branch, or mark its row Differs with the operator's approval, or the design decision the operator took, named in its note.
- Update the behaviour's row in parity.md in the commit that changes it, and add a row for a new list or row behaviour of either side.
- Review a change to the dock's list or rows, the web page's list, or the hub's row data (`rows.ts`, `dock.ts`, `page.ts`) against parity.md, and report a missing counterpart or row update as a finding.
- Rows marked Dock only are outside this rule.

## Commit messages

Use `type(scope): summary`.

- End the subject of every commit for a GitHub issue with `#<issue>`, as in `fix(dock): keep the auto-hidden status strip visible #123`.
- Use a conventional type such as `feat`, `fix`, `docs`, `refactor`, `test`, or `chore`, and an area such as `core`, `hub`, `dock`, `vscode`, `github`, `claude` or `docs` as scope.
- Write an imperative, lowercase summary under about 70 characters, without a final period.
- Name the changed identifier and behavior. Use exact settings, flags, message types, and measurements.
- A trivial change needs only the summary. Otherwise use two to five single-line bullets for non-obvious constraints, measurements, or defects. Omit diff narration, review history, and routine check results.
