# Switchboard PRD

Switchboard is a local software factory for one developer. It ingests work assigned to the operator, triages each assignment to a playbook, runs the playbook's prompt in a background agent session, and shows what each session is doing in a VS Code panel.

## Scope

- Switchboard runs on the operator's machine and handles only work assigned to the operator. It has no shared state, accounts or server.
- All Switchboard state is local. Switchboard reads sources and never writes to them; only the skills its sessions invoke change external state.
- Switchboard manages only sessions it starts. It does not discover or adopt sessions started elsewhere.
- Switchboard tracks worktrees but never creates or deletes them. Skills create worktrees; the operator removes them.
- Switchboard overlaps with Ground Control but does not replace it. Ground Control began as an observability layer linking sessions to GitHub cards; Switchboard is a modular, source-agnostic factory. Switchboard reuses Ground Control's session mechanics (see [architecture.md](architecture.md)).

## Terms

| Term | Meaning |
|---|---|
| Source | A plugin that supplies tickets: GitHub, Zoho Desk, Forum, or ad-hoc prompts. |
| Ticket | Switchboard's local copy of a source record, identified by source and source key. |
| Assigned state | A source-defined condition meaning the ticket is the operator's to work, such as assignee plus status. |
| Work item | One assignment of one ticket to the operator. The primitive Switchboard schedules and displays. |
| Playbook | A named prompt template and its settings, such as `support:defect` or `dev:qa-failure`. A source's triage playbook holds the classifier's instructions. |
| Triage | A one-shot classification of a new work item that chooses its playbook and writes a ticket summary. Triage is not a session. |
| Session | One agent conversation for a work item. Kinds: `setup`, `task`. |
| Active session | A session whose process is running, in the background or in a VS Code tab. |
| Stage | A free-text label a session reports about its progress. Switchboard displays it and does not act on it. |

## Requirements

### Sources

- R1. Each source is a plugin behind one interface that lists the operator's tickets and reports whether each is in the assigned state. The plugin defines the assigned state and builds the triage context: the ticket's text, clipped to size limits and formatted with authors, status changes and assignees.
- R2. Switchboard polls each enabled polling source and stores each ticket's last-seen state locally.
- R3. Each source has its own settings: enabled, poll interval, repo root, and its triage playbook.
- R4. GitHub is the first source. Zoho Desk and Forum follow.
- R5. The Forum source reads forum topics from the production forum database. A topic is in the assigned state when its assignment field names the operator and its status is Open.
- R6. The ad-hoc source creates a ticket and a work item from a prompt the operator types in the panel. The typed prompt replaces the playbook template: triage does not run, and the task session runs the typed prompt.

### Work items

- R7. Switchboard creates a work item each time a ticket enters the assigned state. A ticket assigned again later gets a new work item.
- R8. On first run, every ticket already in the assigned state gets a work item.
- R9. Work item status is local and never mirrored to the source.
- R10. A work item is done when its session reports done, when the operator marks it done, or when its ticket leaves the assigned state.
- R11. A work item whose ticket leaves the assigned state before its session reports done stays listed with a warning.

### Playbooks

- R12. A playbook name is `<namespace>:<name>`, such as `support:defect`, `support:question`, `dev:qa-question`, `dev:qa-failure` or `dev:new-dev`. A namespace is the role the operator works the ticket in, such as `support` for support support or `dev` for development.
- R13. Namespaces and playbooks are not built into Switchboard. Any playbook defined in configuration is valid, and triage chooses among them.
- R14. A playbook owns a prompt template. Switchboard renders it with the ticket's fields, the triage summary and the Switchboard session ID.
- R15. Each playbook is configured to start its task session automatically after triage or to wait for operator approval.
- R16. Each playbook states whether it requires a worktree to start. A playbook that does not, such as every `support` playbook, starts in the source's repo root and creates a worktree only if the work turns out to need code.

### Sessions

- R17. A work item has at most one active session. Switchboard refuses to start a session while another session for the same work item is running. Ended sessions are kept as history.
- R18. A new work item is triaged first. Triage is a one-shot classifier with no tools: it receives the source's triage context and triage playbook, and returns the playbook that handles the work item and a summary of the ticket.
- R19. When the chosen playbook requires a worktree and the ticket has none, a setup session runs after triage to create one.
- R20. The task session runs the rendered playbook prompt and handles the work item from start to finish.
- R21. A session without a worktree runs in the source's repo root. A skill creates the worktree when coding begins and reports it.
- R22. All sessions use Claude Code for now. The provider is stored per session so Codex can be added later.
- R23. A session can report its stage, a worktree link, and that it is done.

### Worktrees

- R24. A worktree belongs to a ticket, and every work item for that ticket reuses it.
- R25. Switchboard links a worktree from a session report, or by branch-name convention when no report exists, such as branch `15619-fix-foo` for GitHub issue 15619.
- R26. Tickets from different sources do not share work items. A Zoho ticket gets its own worktree when coding begins.

### Observation and control

- R27. A VS Code panel lists work items with ticket, playbook, status, stage, worktree, active session and warnings.
- R28. The operator can attach to a background session in a console. Attaching does not create a session, and detaching does not end it.
- R29. The operator can open a work item's session in a VS Code Claude Code tab. A session that is not running resumes in a new tab; a session already open in VS Code gets focus.
- R30. Resuming an ended session always opens it in VS Code.
- R31. The operator can approve a work item waiting for approval, which starts its task session.
- R32. The operator can mark a work item done.

### Runtime

- R33. Switchboard's core runs in a separate process from VS Code and keeps running when the window reloads or closes.

## Delivery

Each step ends with `npm run verify` passing and the PRD's affected requirements marked as implemented.

1. **Scaffold.** Workspaces, TypeScript, Vitest, esbuild, `verify` and `test:integration` scripts, an empty extension that starts and stops the hub.
2. **Core.** Store, data model, playbook loading and rendering, assigned-state transitions, the one-active-session rule, approval and `requiresWorktree` decisions. Tested with fake sources and runners.
3. **GitHub source.** Assigned state and triage context, ported from Ground Control's fetch and clip.
4. **Claude runner and classifier.** `claude -p --json-schema` triage, `claude --bg` sessions, roster polling, stop.
5. **Hub.** Polling, flow execution, report endpoint and `switchboard report` CLI, panel protocol.
6. **Panel.** Work item list, approve, mark done, attach, open in Claude Code tab.

Steps 1–6 deliver GitHub end to end: R1–R4, R7–R25, R27–R33. Later steps add the ad-hoc source (R6), Zoho Desk (R4, R26) and Forum (R5).

## Implementation gaps

Nothing is implemented.

## Open questions

None.
