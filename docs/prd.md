# Switchboard PRD

Switchboard is a local software factory for one developer. It ingests work assigned to the operator, triages each assignment to a playbook, runs the playbook's prompt in a background agent session, and shows what each session is doing in a VS Code panel.

## Scope

- Switchboard runs on the operator's machine and handles only the operator's work: tickets assigned to them, and the pool of unclaimed tickets in a queue they work, such as support escalations, from which they pick. It has no shared state, accounts or server.
- All Switchboard state is local. Switchboard reads sources and never writes to them; only the skills its sessions invoke change external state.
- Switchboard manages only sessions it starts. It does not discover or adopt sessions started elsewhere.
- Switchboard tracks worktrees but never creates or deletes them. Skills create worktrees; the operator removes them.
- Switchboard overlaps with Ground Control but does not replace it. Ground Control began as an observability layer linking sessions to GitHub cards; Switchboard is a modular, source-agnostic factory. Switchboard reuses Ground Control's session mechanics (see [architecture.md](architecture.md)).
- Switchboard does not coordinate with Ground Control. Where both could act on the same GitHub issue, the operator disables Ground Control's automatic card actions for that work.

## Goals

- Turn each assignment into running work: with no click when the operator trusts the playbook, and with one click when they do not.
- Show at a glance which work needs the operator: waiting for approval, waiting on a question, blocked, or failed.
- Keep sources, playbooks and agent providers pluggable. Adding a source does not change the core.
- Reuse what Ground Control and the operator's skills already do. Switchboard schedules and observes; skills do the work.

## Non-goals

- Writing to sources: no status moves, comments, assignments or labels. Only the skills that sessions run write, including the claim when the operator picks a pool ticket (R48).
- Other people's work, team views, reporting, accounts or shared state.
- Remote, cloud or multi-machine operation. One hub runs per machine.
- Changing git state: no commits, branches, or creating, cleaning up or removing worktrees. Read-only git queries that validate and link worktrees are allowed.
- Answering a session's permission prompts or questions for the operator.
- Inferring state it did not observe: no stuck-session detection, and no check that a session's done report is true.
- Reproducing the source's ticket view or conversation. The panel shows the clipped triage context Switchboard recorded and links to the source.
- Replacing Ground Control's board, lanes or review workflow.
- Built-in playbooks or namespaces.
- Unattended overnight operation as a committed goal.
- Complex error handling or support for rare edge cases. A failure shows its cause, and the operator recovers with Retry, Mark done, or a fix to their configuration.

## Design rules

- **Existing tools are context, not requirements.** Ground Control, the Support board and the operator's skills show how the work is done today. Switchboard adopts a behavior from them only when it serves this PRD's goals, and states its own reason.
- **Skills drive the work; Switchboard is the harness.** Switchboard finds tickets, triages them, starts and observes sessions, and shows their state. Every change to a source, a repository or a worktree is made by a skill a session runs. When a feature needs a write, add a session that runs a skill, not Switchboard code that writes.
- **Least authority.** An unattended session gets the least permission mode under which it can finish. The default is `auto`; a playbook can override it.
- **Simple first.** Choose the simplest behavior that keeps common work correct. Handle a rare case by showing it, not with special machinery.
- **Visible failure.** Every failure shows on its work item with the cause. Switchboard does not retry work automatically; Retry is the operator's. A failed source poll is tried again at the next interval.
- **Observed state only.** The panel shows what the roster and session reports say, and how old that observation is. A session's report is its claim and is shown as such.
- **Never cut off work.** Switchboard stops a session only when the operator asks, or to release a session that has finished its turn so the operator can resume it in VS Code (R39).
- **Start automatically unless it writes.** A playbook whose session makes no external change without the operator's approval gets `autoStart: true`. Local work, such as reading, drafting, local commits and worktrees, is not an external change. A playbook that pushes, posts, assigns or moves a card before an approval report waits for Approve. A skill's own documented gate, such as `/or-merge` pushing only clean or high-confidence merges and halting otherwise, is the operator's approval policy and counts as approval. A concurrency limit caps running sessions (R38).
- **A failed read changes nothing.** A failed or incomplete source poll never moves a ticket out of the assigned state.
- **Files for configuration, the store for state.** Settings and playbooks are files the operator edits and can keep in git. Work items, sessions and history live in the store.

## Terms

| Term | Meaning |
|---|---|
| Source | A plugin that supplies tickets: GitHub, Zoho Desk, Forum, or ad-hoc prompts. |
| Ticket | Switchboard's local copy of a source record, identified by source and source key. |
| Assigned state | A source-defined condition meaning the ticket is the operator's to work, such as assignee plus status. |
| Work item | One assignment of one ticket to the operator. The primitive Switchboard schedules and displays. |
| Pool | A source's open, unclaimed tickets that the operator may pick, such as support cases assigned to no one or still held by the escalating General agent. Pool tickets are triaged but are not work items. |
| Pick | The operator's choice of a pool ticket. It creates a work item and runs a pick session, whose skill assigns the ticket to the operator. |
| Playbook | A named prompt template and its settings, such as `support:defect` or `dev:qa-failure`. A source's triage playbook holds the classifier's instructions. |
| Triage | A one-shot classification of a new work item, or of a ticket entering the pool, that chooses its playbook and writes a ticket summary. Triage is not a session. |
| Session | One agent conversation for a work item. Kinds: `pick`, `setup`, `task`. |
| Active session | A session whose process is running, in the background or in a VS Code tab. |
| Stage | A free-text label a session reports about its progress. Switchboard displays it and does not act on it. |

## Requirements

### Sources

- R1. Each source is a plugin behind one interface that lists the operator's tickets and reports whether each is in the assigned state. The plugin defines the assigned state and builds the triage context: the ticket's text, clipped to size limits and formatted with authors, status changes and assignees.
- R2. Switchboard polls each enabled polling source and stores each ticket's last-seen state locally.
- R3. Each source has its own settings: enabled, poll interval, repo root, and its triage playbook.
- R4. GitHub is the first source. Zoho Desk and Forum follow.
- R44. A GitHub ticket is in the assigned state when it is an open issue in the configured repository, it is assigned to one of the configured logins, and its project item's status is one of the configured statuses. All of these are settings. The operator's values for `acme/widgets` are in [architecture.md](architecture.md#settings). GitHub is read through the `gh` CLI with `gh`'s own authentication.
- R5. The Forum source reads forum topics from the production forum database. A topic is in the assigned state when it is open in the Forum forum and assigned to the operator. An open topic assigned to no one is in the pool (R47). A topic another person has claimed is neither.
- R46. The Zoho Desk source reads tickets through the Desk API. A ticket is in the assigned state when its status type is Open, its escalation field is `Support`, and it is assigned to the operator. Such a ticket assigned to no one, or to a support agent or team, is in the pool (R47): General escalations stay assigned to the escalating General agent, so a support assignee counts as unclaimed. A ticket assigned to another engineer is neither.
- R47. A source can have a pool. Switchboard triages each ticket when it enters the pool, keeps the result with the ticket, and shows the pool with each ticket's summary and chosen playbook. A failed pool triage shows its error on the pool row with Triage again; Pick works with or without a triage result, and a work item picked without one is triaged as a new work item. A ticket that leaves the pool without a pick, because someone else claimed it or it closed, disappears from it. GitHub has no pool.
- R48. The operator picks a pool ticket in the panel. Switchboard creates a work item that reuses the pool triage and starts a pick session running the source's `pickPrompt`, which has a skill claim the ticket for the operator and stop. While it runs, the work item is `setup`. When the pick session reports done, the task session starts without Approve, because the pick is the operator's approval; with no pool triage result, the work item is triaged first. A ticket that returns to the assigned state on its own, such as a case reopened after On Hold, follows its playbook's `autoStart` like any other new work item. A pick session that reports blocked, or ends without done, blocks the work item with its reason, such as the ticket having been claimed by someone else.
- R6. The ad-hoc source creates a ticket and a work item from a prompt the operator types in the panel. The typed prompt replaces the playbook template: triage does not run, and the task session runs the typed prompt.
  - The operator picks the repository from the configured repo roots; the first one is the default. The session runs there with no worktree requirement and no playbook, using the `sessions` permission mode and model.
  - It starts at once, subject to the concurrency limit.
  - The ticket key is a local sequence number, and its title is the prompt's first line.

### Work items

- R7. Switchboard creates a work item each time a ticket enters the assigned state. A ticket assigned again later gets a new work item.
- R8. On first run, every ticket already in the assigned state gets a work item.
- R9. Work item status is local and never mirrored to the source.
- R10. A work item is done when its task session reports done, when the operator marks it done, or when its ticket leaves the assigned state while no session is active. If the ticket leaves while a session is active, the work item stays open until that session reports done or ends, because skills such as `/finalize-issue` unassign the operator before the session finishes.
- R11. A work item that ends because its ticket left the assigned state, without a done report, stays listed with a warning.
- R34. Work item statuses are `triaging`, `awaiting-approval`, `queued`, `setup`, `running`, `blocked`, `failed` and `done`.
  - `queued` waits for a session slot (R38), or for an earlier work item of the same ticket to finish its active session (R17).
  - `blocked` means a session ended its turn without reporting done, or reported blocked. The operator resumes it, retries, or marks it done.
  - `failed` means a Switchboard step failed: triage, a session start, or a setup session that ended without a worktree. The panel shows the cause and offers Retry.
- R35. The operator can change a work item's playbook, or triage it again, while it has no active session. A changed playbook puts the work item in `awaiting-approval`, so the operator approves the new choice.
- R45. Retry repeats the step that stopped:
  - After failed triage, triage runs again.
  - After a failed setup or setup start, a new setup session starts, unless a worktree is now linked; then the task starts.
  - After a failed or blocked pick, a new pick session starts.
  - After a failed task start, or a blocked task, a new task session starts from the same playbook, ticket and triage result, rendered again with the new session's ID and report contract, in the directory its `workdir` names. It is a new conversation; Open in VS Code is how to continue the old one.
  - Only reports from a work item's latest session change the work item. Reports from earlier sessions are recorded on those sessions.

### Playbooks

- R12. A playbook name is `<namespace>:<name>`, such as `support:defect`, `support:question`, `dev:qa-question`, `dev:qa-failure` or `dev:new-dev`. A namespace is the role the operator works the ticket in, such as `support` for support support or `dev` for development.
- R13. Namespaces and playbooks are not built into Switchboard. Any playbook defined in configuration is valid, and triage chooses among them.
- R14. A playbook owns a prompt template. Switchboard renders it with the ticket's fields, the triage summary and the Switchboard session ID.
- R15. Each playbook is configured to start its task session automatically after triage or to wait for operator approval.
- R16. Each playbook states whether it requires a worktree to start. A playbook that does not, such as every `support` playbook, starts in the source's repo root and creates a worktree only if the work turns out to need code.

### Sessions

- R17. A ticket has at most one active session across all its work items, because its work items share one worktree. Switchboard refuses to start a session while the store shows another session for the same ticket as active. A work item of a reassigned ticket waits as `queued` while the earlier work item's session is still active. Ended sessions are kept as history.
- R18. A new work item is triaged first. Triage is a one-shot classifier with no tools: it receives the source's triage context and triage playbook, and returns the playbook that handles the work item and a summary of the ticket.
- R19. When the chosen playbook requires a worktree and the ticket has none, a setup session runs after triage to create one.
- R20. The task session runs the rendered playbook prompt and handles the work item from start to finish.
- R21. A session without a worktree runs in the source's repo root. A skill creates the worktree when coding begins and reports it.
- R22. All sessions use Claude Code for now. The provider is stored per session so Codex can be added later.
- R23. A session can report its stage, a worktree link, that it is done, that it is blocked with a reason, or that its work is ready for the operator's approval with the prompt that finishes it, such as `/review-pr pr:123 publish`. An approval report puts the work item in `awaiting-approval`; Approve starts a new task session with that prompt. Reports are accepted from the session after it is resumed in VS Code.
- R36. A session's observed state is `starting`, `running`, `waiting` (needs the operator: a permission prompt or a question), `idle` (its turn ended), `failed` (the turn stopped on an error, with its kind) or `ended`. Hook markers that Switchboard installs in the operator's Claude settings decide the state. The Claude roster decides whether the session is alive, and supplies the state when no marker exists. A session's outcome is `done`, `blocked`, `failed` or `stopped`.
- R37. A triage or session start that fails makes the work item `failed`, with the error. Switchboard does not retry it automatically.
- R38. At most `sessions.concurrency` sessions run at once (default 2, range 1–4). A start that has no free slot waits as `queued`. A setup session and the task session that follows it hold one slot.
- R39. After a session reports done or blocked, or its turn ends, Switchboard stops its background process once the turn is no longer running, so that the session can resume in VS Code. This never deletes the session or its worktree.
- R40. The operator can stop an active session. The work item becomes `blocked` with the reason "Stopped by you." once `claude stop` succeeds. A failed stop shows its error and leaves the session stoppable.
- R41. A failed start shows Claude's own message, which for an untrusted directory says how to trust it. Switchboard never writes Claude's trust settings.

### Worktrees

- R24. A worktree belongs to a ticket, and every work item for that ticket reuses it.
- R25. Switchboard links a worktree from a session report, or by branch-name convention when no report exists, such as branch `15619-fix-foo` for GitHub issue 15619.
- R26. Tickets from different sources do not share work items. A Zoho ticket gets its own worktree when coding begins.

### Observation and control

- R27. A VS Code panel lists work items with ticket, playbook, status, stage, worktree, active session and warnings.
  - An **Icebox** group, collapsed at the bottom, holds iceboxed tickets (R49).
  - A **Pool** group, below the work items, lists pool tickets oldest first by the source's sort time (Zoho's customer response time, Forum's last public post), so the longest-waiting customer comes first, with the source and key, the title, the triage summary, the chosen playbook and a Pick control.
  - It groups work items, checking in this order: **Done** when the work item is `done` (the last 7 days, collapsed; an active session still shows its mark); **Needs you** when the status is `awaiting-approval`, `blocked` or `failed`, or the active session is `waiting`; **Working** otherwise.
  - Each row shows the source and key linked to the source, the title, the playbook, a status mark, the stage and its age, and any warning.
  - Expanding a row shows the triage summary, the triage context, the task prompt and the session history.
  - Controls appear only when they apply: Approve, Change playbook, Triage again, Retry, Stop, Mark done, Attach and Open in VS Code.
  - The panel uses VS Code's theme and codicons. It is not a kanban board.
- R28. The operator can attach to a background session in a console. Attaching does not create a session, and detaching does not end it.
- R29. The operator can open a work item's session in a VS Code Claude Code tab. A session that is not running resumes in a new tab; a session already open in VS Code gets focus.
- R30. Resuming an ended session always opens it in VS Code.
- R31. The operator can approve a work item waiting for approval, which starts its task session, or the session with the prompt an approval report named (R23). The panel shows the report's summary next to Approve.
- R49. The operator can move a pool ticket or a work item to the Icebox, and restore it. An iceboxed ticket shows only in a collapsed Icebox group, gets no automatic triage or start, and returns to its group when restored. The Icebox is local and never written to the source.
- R32. The operator can mark a work item done.

### Runtime

- R33. Switchboard's core runs in a separate process from VS Code and keeps running when the window reloads or closes.
- R42. Settings and playbooks are files in the Switchboard home. The hub reloads them when they change. An invalid settings file leaves the last valid settings in force; an invalid playbook is left out. Either error shows in the panel.
- R43. On startup the hub reconciles sessions recorded as active against the Claude roster. The hub stays running while any session is active, so sessions can always report.

## Delivery

Each step ends with `npm run verify` passing and the PRD's affected requirements marked as implemented.

1. **Scaffold.** Workspaces, TypeScript, Vitest, esbuild, `verify` and `test:integration` scripts, an empty extension that starts and stops the hub.
2. **Core.** Store, data model, settings and playbook loading and rendering, assigned-state transitions, work item statuses, the one-active-session rule, approval, `requiresWorktree`, retry and limit decisions. Tested with fake sources and runners.
3. **GitHub source.** Assigned state and triage context, ported from Ground Control's fetch and clip.
4. **Claude runner and classifier.** `claude -p --json-schema` triage, `claude --bg` sessions, roster polling, hook installation and markers, stop, and the trust refusal.
5. **Hub.** Polling, flow execution, the report endpoint, the `switchboard report` CLI, startup reconciliation, the panel protocol.
6. **Panel and ad-hoc source.** Work item list and every R27 control, plus the ad-hoc prompt box. The ad-hoc source comes here because it exercises the whole session path without touching a real ticket.
7. **Live acceptance.** Run the procedure in [testing.md](testing.md#live-acceptance) and record the results.

8. **Operator configuration.** Write the operator's `~/.switchboard/settings.json` for GitHub, a `triage:github` playbook ported from Ground Control's triage prompt (`packages/board/src/triagePrompt.ts`) and the deterministic rules it applies before the model, and `dev:*` playbooks from their Ground Control action table, all with `autoStart: false`. The operator reviews them before use. In first use, verify Open in VS Code for a session from another folder.
9. **Zoho Desk source** (R4, R26, R46) and `support:*` playbooks.
10. **Forum source** (R5).

Steps 1–7 deliver GitHub and ad-hoc end to end: R1–R4, R6–R25, R27–R45. Zoho Desk and Forum port the operator's Support board in `D:\git\support`.

## Implementation gaps

Steps 1–7 are delivered: R1–R4 for GitHub, R6–R25 and R27–R45 work end to end, verified by live acceptance on 2026-10-03 ([mechanics.md](mechanics.md) M9). Not yet verified live: Open in VS Code for a session from another folder. Step 8 is delivered: the operator's home has the GitHub settings and playbooks, and their hub triaged their 9 assigned issues to the same actions Ground Control chose, all awaiting approval. Steps 9 and 10 are delivered in code: the Zoho Desk source (R46), the Forum source (R5), the pool and its triage (R47), pick sessions (R48), approval reports (R23, R31) and the Icebox (R49) are implemented and tested, pick sessions with fake runners only. Both pools were triaged live, read-only ([mechanics.md](mechanics.md) M10, M11). The operator's Support setup is installed: on 2026-10-03 their hub triaged 6 Zoho and 7 Forum pool tickets into `support:case` with no errors, after the Git Bash fix ([mechanics.md](mechanics.md) M12).

- Open in VS Code for a session from another folder is not yet verified live.
- No pick has run against a real ticket; the first real pick is the operator's.
- Only Windows is supported and tested. On other platforms the hub lock is a socket file, and two hubs starting at the same moment over a socket left by a crashed hub can both take it.
## Open questions

None.
