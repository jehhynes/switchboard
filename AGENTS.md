# Switchboard

Switchboard is a local software factory for one developer. It ingests tickets assigned to the operator from GitHub, Zoho Desk, Forum and ad-hoc prompts, triages each into a playbook, runs the playbook in a background Claude Code session, and shows the work in a VS Code panel. See [prd.md](docs/prd.md).

Session and triage mechanics come from Ground Control (`D:\git\ground-control`). Read its code and [mechanics.md](../ground-control/docs/mechanics.md) before re-deriving a mechanism it already verified.

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

Replace superseded text in place. Record the decision and its constraint; omit discussion history, discarded proposals, and changelog prose. Distinguish current implementation, future requirements, and experimental evidence. An experiment does not imply product support. Re-verify version-fragile mechanisms after upgrading Claude Code, its VS Code extension, or VS Code.

## Verification

[testing.md](docs/testing.md) is the full contract. The npm scripts below are created by the first delivery step in [prd.md](docs/prd.md#delivery).

- Run `npm run verify` for executable changes: build, typecheck, tests, and coverage thresholds.
- Run `npm run test:integration` for VS Code host wiring or UI-visible behavior. It uses a real extension host with isolated settings and home. Verify behavior directly instead of asking the developer to click through it.
- Choose the test layer by API dependencies. Package logic and webview DOM belong in Vitest; `vscode` wiring belongs in the real-host suite.
- Use recorded, scrubbed fixtures and injected homes. No external network traffic, real Claude sessions, or developer services in tests; test-owned loopback listeners are allowed.
- Assert failures and refusals as well as success. Each assertion must detect a possible implementation defect.
- For documentation, check accuracy and links.

Run commands from the repository root:

| Command | Purpose |
|---|---|
| `npm run verify` | Build, typecheck, tests, coverage, and the dock's `dotnet build` and `dotnet test` |
| `npm run verify:full` | Verify plus VS Code integration tests |
| `npm run test:integration` | Build and run VS Code integration tests |
| `npm run build` | Build workspace packages, hub and extension bundles |
| `npm run watch` | Incremental builds |
| `npm test` | Workspace tests with configured coverage |
| `npm run typecheck` | Source and test typechecking |

### Reinstalling after a change

For executable changes to the VS Code extension, hub, or bundled packages:

```bash
npm run build
npm run package --workspace switchboard
code --install-extension extensions/switchboard/switchboard-0.0.0.vsix --force
```

Package with `vsce package --no-dependencies`; the workspace script includes the flag. Build first, because packaging does not build. A repository build alone does not update the installed VSIX.

Confirm the installed bundle under `%USERPROFILE%/.vscode/extensions/switchboard.switchboard-0.0.0/dist/` contains the change, then report that the developer can reload when ready. Do not reload their window. Activation copies the hub bundle to the Switchboard home and can replace a running hub.

For changes to the dock, close the running dock (it holds its files open), then run `npm run publish --workspace @switchboard/dock`, which publishes it to `%USERPROFILE%/.switchboard/dock/`, and report that the operator can start `Switchboard.Dock.exe` there.

## Commit messages

Use `type(scope): summary`, adding `(fixes #123)` on the same line when closing an issue.

- Use a conventional type such as `feat`, `fix`, `docs`, `refactor`, `test`, or `chore`, and an area such as `core`, `hub`, `panel`, `github`, `claude` or `docs` as scope.
- Write an imperative, lowercase summary under about 70 characters, without a final period.
- Name the changed identifier and behavior. Use exact settings, flags, message types, and measurements.
- A trivial change needs only the summary. Otherwise use two to five single-line bullets for non-obvious constraints, measurements, or defects. Omit diff narration, review history, and routine check results.
