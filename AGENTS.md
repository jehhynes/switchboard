# Switchboard

Switchboard is a local software factory for one developer. It ingests tickets assigned to the operator from GitHub, Zoho Desk, Forum and ad-hoc prompts, triages each into a playbook, runs the playbook in a background Claude Code session, and shows the work on the web page the hub serves, its only interface (PRD R109). See [prd.md](docs/prd.md).

Switchboard replaces Ground Control (`D:\git\ground-control`), which no longer runs. Its session and triage mechanics come from there: read its code and [mechanics.md](../ground-control/docs/mechanics.md) before re-deriving a mechanism it already verified.

## Workflow

1. Read the relevant docs and implementation. Write a plan, including verification, before coding.
2. Implement the change and, in the same task, update the documents it affects as [Documentation](#documentation) directs. Test new behavior according to [testing.md](docs/testing.md).
3. Review the change with the `cross-check` skill, so the other provider reviews it, before you report the task as done or ask for acceptance. Cover requirements, correctness, regressions, and UI behavior where applicable. Fix or answer each finding before you report the task as done.
4. Complete the required checks. For executable changes to the hub or the packages it carries, [rebuild and reinstall](#reinstalling-after-a-change).
5. Commit each self-contained story or task after review, verification, and acceptance by the operator or the product manager session.

Settle product questions with the Goals, Non-goals and Design rules in [prd.md](docs/prd.md#goals), and record each new decision in the document that owns it. Escalate only what those rules do not settle.

### Roles

When the operator appoints a product manager session:

- The product manager session owns product decisions and the docs, accepts work against the PRD, and writes no code and runs no tests.
- The developer session builds and tests, itself or through subagents, and asks the product manager session the product questions that the Goals, Non-goals and Design rules do not settle.
- The developer session sends the product manager session readable evidence when it asks for acceptance: the `cross-check` findings and the fix or answer for each, test names and counts, check output or its file path, live acceptance results, and the R IDs implemented.

Continue until the task is complete or blocked. Ask for clarification when required intent is unresolved, credentials are missing, the work would deviate from the PRD, or verification is inadequate.

## Wording

Use concise, direct wording everywhere in this repository, including code, identifiers, comments, prompts, documentation, tests, settings, logs, user-facing copy, and generated output.

- Use familiar words and concrete names. State the action, fact, or constraint directly.
- Remove filler, repetition, boilerplate, metaphors, personification, and unnecessary detail. Avoid invented jargon and vague or cryptic names.
- Use the terms defined in [prd.md](docs/prd.md#terms) — ticket, work item, playbook, triage, session — with one word per concept in code, settings and UI.
- Keep code simple. Comments should explain non-obvious behavior or constraints, not restate the code or narrate change history.
- Preserve meaning, technical precision, uncertainty, diagnostic details, and recovery steps. Brevity must not hide relevant information or change behavior, required syntax, or external contracts.

## Documentation

Read the document that covers the decision:

| Document | Covers |
|---|---|
| [prd.md](docs/prd.md) | Product scope, goals, design rules, terms and requirements (R IDs) |
| [architecture.md](docs/architecture.md) | Components, their responsibilities, boundaries, data ownership, protocols and the rationale for core decisions |
| [mechanics.md](docs/mechanics.md) | Dated experiments and source inspections (M IDs) |
| [parity.md](docs/parity.md) | Each dock list and row behaviour and whether the web page matches it |
| [testing.md](docs/testing.md) | Required checks, test layers, fixture rules, isolation and live acceptance |
| [install-linux.md](docs/install-linux.md) | Installing Switchboard on Linux |
| [install-browser-extension.md](docs/install-browser-extension.md) | Installing the browser extension on another computer from the web page |

- Invoke the `update-docs` skill ([.claude/skills/update-docs/SKILL.md](.claude/skills/update-docs/SKILL.md)) to create, revise or retire a document under `docs/`, or to decide whether a change needs a documentation update; it owns what each document holds and leaves out.
- Re-verify the version-fragile mechanisms in mechanics.md after upgrading Claude Code or the Codex CLI.

## Verification

[testing.md](docs/testing.md) is the full contract.

- For executable changes, run only the checks the change affects while working: the pre-commit hook does, through `npm run verify:staged`, so commit without `--no-verify`. Run `npm run verify` (build, typecheck, tests, and coverage thresholds) before merging a branch into `main`.
- Verify behavior directly instead of asking the developer to click through it.
- Package logic and the web page's DOM belong in Vitest.
- Use recorded, scrubbed fixtures and injected homes. No external network traffic, real Claude sessions, or developer services in tests; test-owned loopback listeners are allowed.
- Assert failures and refusals as well as success. Each assertion must detect a possible implementation defect.
- For documentation, check accuracy and links.

Run commands from the repository root:

| Command | Purpose |
|---|---|
| `npm run verify:staged` | Build, typecheck and test the workspaces the staged files touch and their dependents; the pre-commit hook runs it |
| `npm run verify` | Build, typecheck, tests and coverage; run before merging into `main` |

### Reinstalling after a change

For executable changes to the hub or the packages it carries (the holder, the voice process, the web page and the browser extension):

```bash
npm run install-local
```

It builds every workspace and runs `hub.js install --wait` from apps/hub's standalone build, `apps/hub/dist/install`. That copies the hub bundle, the holder and voice builds with their native modules, Mermaid, the diff viewer and the browser extension into the Switchboard home, and waits while the running hub restarts onto the new hub build once it is quiet, printing the new build. `npm run install-local -- --home=<dir>` installs into another home instead.

For changes to the browser extension (`extensions/chrome` or `extensions/firefox`), run `npm run build` and `npm run lint --workspace @switchboard/firefox`, which must report no errors. Report that the operator can reload `extensions/chrome/dist` in `chrome://extensions` and load `extensions/firefox/dist/manifest.json` in `about:debugging`. `npm run sign --workspace @switchboard/firefox` signs and releases the Firefox build only from a pushed commit, so run it after the change is pushed when `~/.switchboard/amo.env` holds the operator's keys, without reading that file, and otherwise report that the operator can; they then install `extensions/firefox/switchboard-firefox-signed.xpi` from `about:addons`.

## Commit messages

Use `type(scope): summary`.

- End the subject of every commit for a GitHub issue with `#<issue>`, as in `fix(web): keep the list's status strip visible #123`.
- Use a conventional type such as `feat`, `fix`, `docs`, `refactor`, `test`, or `chore`, and an area such as `core`, `hub`, `web`, `github`, `claude` or `docs` as scope.
- Write an imperative, lowercase summary under about 70 characters, without a final period.
- Name the changed identifier and behavior. Use exact settings, flags, message types, and measurements.
- A trivial change needs only the summary. Otherwise use two to five single-line bullets for non-obvious constraints, measurements, or defects. Omit diff narration, review history, and routine check results.
