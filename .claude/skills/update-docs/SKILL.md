---
name: update-docs
description: Create, revise or retire Switchboard's documentation under docs/, or assess whether a change needs a documentation update; not for skills or agent rules.
---

# Maintain project documentation

## Establish purpose

- Write durable design documents to explain intended behavior, boundaries and rationale without mirroring the implementation.
- Identify each document's reader and task before deciding its level of detail, using the purpose table below for mixed-purpose documents as well as whole files.
- Apply the same inclusion tests to existing and new content; presence in the original document is not evidence that a passage belongs.
- For a whole-document review or replacement, select the knowledge that serves the reader before choosing files or sections; use existing documents as evidence rather than a required outline.
- Keep a document only when it supports a distinct reader task not adequately served by another maintained source; remove it within the assigned scope when no such task remains.
- Skills, agent rules, runtime prompts and test fixtures are outside this skill's scope.

| Purpose | Content the reader needs |
|---|---|
| Durable requirements, architecture and UX direction | Intended outcomes, precise contracts, component responsibilities, ownership, boundaries and decision rationale. |
| Current reference, procedures and troubleshooting | Detail needed to use, configure, operate, diagnose or interpret the supported system, including examples and result limitations. |
| Proposals and exploratory research | Options, hypotheses, examples, open questions, evidence and limitations, with their uncommitted status. |
| Historical research and decision records | Dated findings, methods, alternatives and rationale, with later supersession identified. |
| Help, marketing and legal prose | Self-contained explanations, necessary wording and precise commitments for the audience, consistent with the governing decisions. |
| Work plans and progress records | Tasks, dependencies, acceptance and rollout status. |

## Switchboard's documents

Each document under `docs/` has one recorded purpose from the table in [Establish purpose](#establish-purpose); test its passages against that purpose.

| Document | Purpose | Reader and task |
|---|---|---|
| [prd.md](../../../docs/prd.md) | Durable requirements, architecture and UX direction | The operator and sessions deciding what Switchboard must do: scope, goals, non-goals, design rules, terms and requirements (R IDs). |
| [architecture.md](../../../docs/architecture.md) | Durable requirements, architecture and UX direction | A developer changing Switchboard: packages and components, their responsibilities, boundaries, data ownership, protocol contracts and the rationale for core decisions. |
| [mechanics.md](../../../docs/mechanics.md) | Historical research and decision records | A developer relying on or re-verifying a behavior of Claude Code, Codex, VS Code, an operating system or a ticket source: dated experiments and source inspections (M IDs) with versions, method, limitations and later supersession. |
| [testing.md](../../../docs/testing.md) | Current reference, procedures and troubleshooting | A developer adding or running tests: required checks, what earns a test, test layers, fixture and isolation rules and live acceptance. |
| [install-linux.md](../../../docs/install-linux.md) | Current reference, procedures and troubleshooting | The operator installing, checking and troubleshooting Switchboard on Linux. |
| [install-browser-extension.md](../../../docs/install-browser-extension.md) | Current reference, procedures and troubleshooting | The operator installing the browser extension on another computer from the web page, and troubleshooting it. |

### Switchboard conventions

- Keep each feature requirement in prd.md as an R ID stated as its required outcome, because prd.md is Switchboard's authoritative requirements catalog; this overrides the feature requirement catalog row of [Exclude from durable design documents](#exclude-from-durable-design-documents).
- Keep each R ID and M ID with its meaning, and never renumber or reuse one, because code, tests, commits and other documents cite them.
- Mark a withdrawn or replaced requirement with what replaced it instead of deleting its ID, so its citations still resolve.
- Keep a heading that code comments or other documents cite, such as `architecture.md § Voice`, or update every citation in the same commit; find them with `git grep -n "<document>.md"`.
- State only Switchboard's own behavior and constraints; skills that sessions run are outside Switchboard and change independently, so name one only as an example, such as a prompt in a sample setting, and never describe how it works.
- In prd.md and architecture.md, replace a superseded decision in place and omit discussion history, discarded proposals and changelog prose; in mechanics.md, keep the dated finding and mark it superseded.
- Distinguish current behavior, future requirements and experimental evidence, because an experiment does not imply product support.

## Decide whether to edit

- Update project documentation when an agreed decision adds or changes product purpose, scope, enduring requirements or shared UX conventions.
- Update project documentation when an agreed design adds or changes component responsibilities, dependency boundaries, data ownership or architectural constraints.
- Update project documentation when a security requirement, account-isolation rule or external contract changes.
- Update reference, procedures and troubleshooting when supported behavior changes how readers use, operate or interpret the system.
- Update proposals and research when new evidence or decisions change their conclusions, options or status, preserving dated findings as historical evidence.
- Update audience-facing prose when the supported experience, offer or governing commitment changes.
- Correct documentation when evidence shows that it misstates or omits content needed for its recorded purpose.
- Revise documentation when the operator requests a correction or cleanup.
- When durable design prose becomes stale because it describes implementation details, replace those details with the enduring design or a reference to the authoritative code instead of updating the implementation narrative.
- Leave documentation unchanged when none of these conditions applies; a code commit alone is not a reason to edit it.

## Test each passage for inclusion

Retain a passage only when it serves the recorded purpose and passes the applicable tests below.

| Test | Decision |
|---|---|
| Reader task | Name the decision, action or understanding the passage enables; remove content with no such use. |
| Authority | Identify the source that owns the requirement or establishes the fact; use a source link when it supplies what the reader needs without a maintained prose copy. |
| Stability of durable design | Ask whether a different implementation could satisfy the same requirement while making the statement false; if so, retain the requirement and remove the mechanism unless evidence establishes that mechanism as a required constraint. |
| Detail for other purposes | Retain implementation-dependent detail only when the reference, procedure, proposal, evidence or audience-facing purpose needs it; identify that use rather than exempting the whole document. |

- For disputed passages, report the reader task, authoritative source and an example change that would invalidate the statement.

## Exclude from durable design documents

Apply these exclusions unless evidence establishes a required constraint or the assigned scope includes another purpose that needs the detail under [Establish purpose](#establish-purpose).

| Content | Treatment |
|---|---|
| Function, file, endpoint and component inventories | Keep only the orientation needed to locate architectural responsibilities or authoritative sources. |
| Step-by-step implementation narratives | State the behavior, boundary or failure contract rather than the execution sequence. |
| Current models, providers, tuning values, schedules and configuration choices | Link to configuration unless the choice itself is an agreed constraint. |
| Feature-by-feature UI descriptions, field lists and exact copy | Preserve the intended interaction contract and link to the owning requirements or interface sources. |
| Implementation status, completed work and rollout details | Keep tracking in the relevant issue or work plan. |
| Statements that only describe current code | Remove them or replace them with the supported requirement and rationale. |
| Feature requirement catalogs in product-direction documents | Keep audience, purpose, scope boundaries and shared commitments; put feature requirements in issues or work plans, and update direction only when those shared decisions change. |

## Verify retained claims

- Verify each retained factual claim within the assigned scope against the appropriate evidence below, recording the source and result for a whole-document rework or a disputed claim.

| Claim type | Verification |
|---|---|
| Requirement or commitment | Find the supporting decision or owning specification; distinguish its required outcome from the mechanism currently used to satisfy it. |
| Current implementation or operational fact | Check authoritative code, configuration, tests or observed behavior; source code alone does not establish deployment state. |
| Historical or research finding | Check the dated source, method and stated limitations without substituting current behavior for historical results. |
| Proposal or hypothesis | Check its source and status without presenting it as an accepted requirement or established result. |

- Treat existing prose as a claim to check rather than independent proof of its accuracy or authority.
- Record unavailable evidence and unresolved claims as uncertainty rather than presenting them as verified facts.
- Report conflicting requirements or commitments with their sources and obtain the operator's decision before changing their meaning unless that decision is already supplied.

## Revise the document

- Preserve the requirements and rationale needed for the selected reader tasks when removing implementation detail; do not preserve a passage solely because the original calls it a requirement.
- Keep one authoritative definition while allowing consistent summaries required by different audiences.
- Remove unnecessary implementation detail rather than moving it into another maintained document.
- Keep a requested cleanup within the documents and topics assigned by the operator.
- Mark a retained historical decision as superseded when a replacement decision changes it.
- When retiring or replacing documents, update incoming links and agent routing, and remove obsolete citations from live comments without changing the behavior they explain.

## Check the result

- Check that durable design prose survives ordinary feature changes, bug fixes, refactoring and tuning that leave its requirements and architecture unchanged.
- Check that the reader can complete the recorded task without reconstructing documentation-owned meaning from code.
- Review the resulting document set for duplicated ownership, missing decision context and broken references; evaluate the assembled result after parallel edits.
- Report the reason for the documentation change and unresolved verification limits, or state that no documentation change was needed when assessing a proposed update.
