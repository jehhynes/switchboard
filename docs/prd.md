# Switchboard PRD

Switchboard is a local software factory for one developer. It ingests work assigned to the operator, triages each assignment to a playbook, runs the playbook's prompt in a background agent session, and shows what each session is doing in a VS Code panel.

## Scope

- Switchboard runs on the operator's machine and handles only the operator's work: tickets assigned to them, and the pool of unclaimed tickets in a queue they work, such as support escalations, from which they pick. It has no shared state, accounts or server.
- All Switchboard state is local. Switchboard reads sources and never writes to them; only the skills its sessions invoke change external state.
- Switchboard manages only sessions it starts. It does not discover or adopt sessions started elsewhere.
- Switchboard tracks worktrees but never creates or deletes them. Skills create worktrees; the operator removes them.
- Switchboard replaces Ground Control and the Support board. Ground Control began as an observability layer linking sessions to GitHub cards; Switchboard is a modular, source-agnostic factory that reuses Ground Control's session mechanics (see [architecture.md](architecture.md)).

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
- Inferring state it did not observe: no stuck-session detection, and no check of a session's work beyond whether its ticket is still assigned when it reports done (R10).
- Reproducing the source's ticket view or conversation. The panel links to the source.
- Reproducing Ground Control's board, lanes or review views, or the Support board.
- Built-in playbooks or namespaces.
- Unattended overnight operation as a committed goal.
- Complex error handling or support for rare edge cases. A failure shows its cause, and the operator recovers with Retry, Mark done, or a fix to their configuration.

## Design rules

- **Existing tools are context, not requirements.** Ground Control, the former Support board and the operator's skills show how the work was done before Switchboard. Switchboard adopts a behavior from them only when it serves this PRD's goals, and states its own reason.
- **Skills drive the work; Switchboard is the harness.** Switchboard finds tickets, triages them, starts and observes sessions, and shows their state. Every change to a source, a repository or a worktree is made by a skill a session runs. When a feature needs a write, add a session that runs a skill, not Switchboard code that writes.
- **Least authority.** An unattended session gets the least permission mode under which it can finish. The default is `auto`; a playbook can override it.
- **The work item first, sessions second.** The operator manages work items; a session is how one runs, and the panel shows it as one control, not as content.
- **Show each fact once.** The panel follows four rules:
  - What the row's group already says is not repeated on the row.
  - What an icon says is not repeated in text; a button whose icon makes its action clear shows the icon, with the verb in its tooltip.
  - An indicator that is the same on every row it can appear on, or that means nothing, is not shown.
  - A label carries the most specific fact available: a playbook name that also names the kind of work, such as `support:defect`, rather than a generic one.
- **Simple first.** Choose the simplest behavior that keeps common work correct. Handle a rare case by showing it, not with special machinery.
- **Visible failure.** Every failure shows on its work item with the cause. Switchboard does not retry work automatically; Retry is the operator's. A failed source poll is tried again at the next interval.
- **Observed state only.** The panel shows what the roster and session reports say, and how old that observation is. A session's report is its claim and is shown as such.
- **Never cut off work.** Switchboard stops a session only when the operator asks, or to release a session that has finished its turn so the operator can resume it in VS Code (R39).
- **Start automatically unless it writes.** A playbook whose session makes no external change without the operator's approval gets `autoStart: true`. Local work, such as reading, drafting, local commits and worktrees, is not an external change. A playbook that pushes, posts, assigns or moves a card before an approval report waits, `unstarted`, for the operator to start it. A skill's own documented gate, such as `/or-merge` pushing only clean or high-confidence merges and halting otherwise, is the operator's approval policy and counts as approval. A playbook for a ticket whose requested action is unclear also waits, because an action read from older activity is more likely wrong. A concurrency limit caps running sessions (R38).
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
| Pick | Starting a pool ticket: the operator presses Start on it. It creates a work item and starts its task session, whose skill assigns the ticket to the operator before it works the ticket. |
| Playbook | A named prompt template and its settings, such as `support:defect` or `dev:qa-failure`. A source's triage playbook holds the classifier's instructions. |
| Triage | A one-shot classification of a new work item, or of a ticket entering the pool, that chooses its playbook. Triage is not a session. |
| Session | One agent conversation for a work item. Kinds: `setup`, `task`. |
| Active session | A session whose process is running, in the background or in a VS Code tab. |
| Stage | A free-text label a session reports about its progress. Switchboard displays it and does not act on it. |

## Requirements

### Sources

- R1. Each source is a plugin behind one interface that lists the operator's tickets and reports whether each is in the assigned state. The plugin defines the assigned state and builds the triage context: the ticket's text, clipped to size limits and formatted with authors, status changes and assignees. The GitHub source can show each comment author's roles, such as tester, from a file the operator names, so triage can tell a tester's report from a developer's question.
- R2. Switchboard polls each enabled polling source and stores each ticket's last-seen state locally.
- R3. Each source has its own settings: enabled, poll interval, repo root, and its triage playbook. The operator turns sources on and off with an on/off icon per source in the panel's title bar, because some work, such as Support, is done only some weeks; a disabled source is not polled and its pool is hidden, while its work items stay.
- R4. GitHub is the first source. Zoho Desk and Forum follow.
- R44. A GitHub ticket is in the assigned state when it is an open issue in the configured repository, it is assigned to one of the configured logins, and its project item's status is one of the configured statuses. All of these are settings. The operator's values for `acme/widgets` are in [architecture.md](architecture.md#settings). GitHub is read through the `gh` CLI with `gh`'s own authentication. A poll fails, changing nothing, when the project has no single-select field with the configured status name, because every issue would otherwise read as unassigned.
- R5. The Forum source reads forum topics from the production forum database. A topic is in the assigned state when it is open in the Forum forum and assigned to the operator. An open topic assigned to no one is in the pool (R47). A topic another person has claimed is neither.
- R46. The Zoho Desk source reads tickets through the Desk API. A ticket is in the assigned state when its status type is Open, its escalation field is `Support`, and it is assigned to the operator. Such a ticket assigned to no one, or to a support agent or team, is in the pool (R47): General escalations stay assigned to the escalating General agent, so a support assignee counts as unclaimed. A ticket assigned to another engineer is neither.
- R47. A source can have a pool. Switchboard triages each ticket when it enters the pool, keeps the result with the ticket, and shows the pool with each ticket's chosen playbook. A failed pool triage shows its error on the pool row with Triage again; a pool ticket offers Start only once its triage has a result. A ticket that leaves the pool without a pick, because someone else claimed it or it closed, disappears from it. GitHub has no pool.
- R48. The operator picks a triaged pool ticket by pressing Start on it in the panel. Switchboard creates a work item that reuses the pool triage and starts its playbook's task session, because the pick is the operator's start, whatever the playbook's `autoStart`. The playbook's skill claims the ticket for the operator as its first step, as `/support-process` does through `support-bind`, then works the ticket; when anyone else holds the ticket or the claim fails, the skill reports it and stops, so the work item is `blocked`. Switchboard does not claim and does not check the claim. A ticket that returns to the assigned state on its own, such as a case reopened after On Hold, follows its playbook's `autoStart` like any other new work item.
- R6. The ad-hoc source creates a ticket and a work item from a prompt the operator enters through the panel's New Ad-hoc Session command, choosing the repository when more than one is configured. The typed prompt replaces the playbook template: triage does not run, and the task session runs the typed prompt.
  - The operator picks the repository from the configured repo roots; the first one is the default. The session runs there with no worktree requirement and no playbook, using the `sessions` permission mode and model.
  - It starts at once, subject to the concurrency limit.
  - The ticket key is a local sequence number, and its title is the prompt's first line.

### Work items

- R7. Switchboard creates a work item each time a ticket enters the assigned state with no open work item. A ticket assigned again after its work item is done gets a new work item; one that returns while its work item is still open, such as during that item's active session, continues that work item.
- R8. On first run, every ticket already in the assigned state gets a work item.
- R9. Work item status is local and never mirrored to the source.
- R10. A work item is done when its task session reports done, when the operator marks it done, or when its ticket leaves the assigned state while no session is active. If the ticket leaves while a session is active, the work item stays open until that session reports done or ends, because skills such as `/finalize-issue` unassign the operator before the session finishes. When a task session reports done, the hub reads the ticket's source again; if the ticket is still in the assigned state, the session did not hand it off, which is a skill defect, so the work item becomes `blocked` for the operator instead of done, and the session is not told. The blocked work item is done when its ticket leaves the assigned state. A read that fails or takes over 6 seconds accepts the report.
- R11. A work item that ends because its ticket left the assigned state, without a done report, stays listed in Done with no warning; leaving the assigned state is routine.
- R34. Work item statuses are `triaging`, `unstarted`, `queued`, `setup`, `running`, `awaiting-approval`, `blocked`, `failed` and `done`.
  - `unstarted` waits for the operator to start it, because its playbook does not start automatically.
  - `awaiting-approval` means a session's work is finished and waits for the operator to approve the prompt that publishes it (R23).
  - `queued` waits for a session slot (R38), or for an earlier work item of the same ticket to finish its active session (R17).
  - `blocked` means a session ended its turn or its process without reporting done or approval, or the operator stopped it, or a task session reported done while its ticket was still in the assigned state (R10). Its reason names only a report the session was offered: "The session finished its turn." when it was offered neither. The operator resumes it, retries, or marks it done.
  - `failed` means a Switchboard step failed: triage, a session start, or a setup session that ended without a worktree. The panel shows the cause and offers Retry.
- R35. The operator can triage a work item again while it has no active session. There is no control to choose a playbook by hand; the operator handles that rare case outside Switchboard, for example with Mark done and an ad-hoc session.
- R45. Retry repeats the step that stopped:
  - After failed triage, triage runs again.
  - After a failed setup or setup start, a new setup session starts, unless a worktree is now linked; then the task starts.
  - After a failed task start, or a blocked task, a new task session starts from the same playbook, ticket and triage result, rendered again with the new session's ID and report contract, in the directory its `workdir` names. It is a new conversation; resuming the old session is how to continue it.
  - Only reports from a work item's latest session change the work item. Reports from earlier sessions are recorded on those sessions.

### Playbooks

- R12. A playbook name is `<namespace>:<name>`, such as `support:defect`, `support:question`, `dev:qa-question`, `dev:qa-failure` or `dev:new-dev`. A namespace is the role the operator works the ticket in, such as `support` for support support or `dev` for development.
- R13. Namespaces and playbooks are not built into Switchboard. Any playbook defined in configuration is valid, and triage chooses among them.
- R14. A playbook owns a prompt template. Switchboard renders it with the ticket's fields, the triage context and the Switchboard session ID.
- R15. Each playbook is configured to start its task session automatically after triage or to wait, `unstarted`, for the operator to start it.
- R16. Each playbook states whether it requires a worktree to start, and where its session runs (`workdir`): in the ticket's worktree when one exists, or always in the source's repo root. A playbook that requires no worktree and has no worktree yet starts in the repo root, and its skill creates a worktree only if the work turns out to need code. Every `support` playbook runs in the repo root.

### Sessions

- R17. A ticket has at most one active session across all its work items, because its work items share one worktree. Switchboard refuses to start a session while the store shows another session for the same ticket as active. Ended sessions are kept as history.
- R18. A new work item is triaged first. Triage is a one-shot classifier with no tools: it receives the source's triage context, led by the current time, and triage playbook, and returns the playbook that handles the work item. A triage playbook chooses a specific playbook only when the context states the requested action by the source's rules, and otherwise its playbook for an unclear ticket, such as `dev:other` for GitHub, where an assignment alone states no action.
- R19. When the chosen playbook requires a worktree and the ticket has none, a setup session runs after triage to create one.
- R20. The task session runs the rendered playbook prompt and handles the work item from start to finish.
- R21. A session without a worktree runs in the source's repo root. A skill creates the worktree when coding begins and reports it.
- R22. All sessions use Claude Code for now. The provider is stored per session so Codex can be added later.
- R23. A session can report its stage, a worktree link, that it is done, or that its work is ready for the operator's approval with the prompt that finishes it, such as `/review-pr pr:123 publish`, a summary of what that prompt publishes, and the file holding the drafted text it publishes, if any. An approval report puts the work item in `awaiting-approval`; Approve starts a new task session with that prompt. `awaiting-approval` is used only for this. A session can also hand its work item to another task playbook in the work item's namespace, whose skill it then runs, so the row names the work being done and Retry starts that playbook; a playbook such as `dev:other`, whose session researches what an unclear ticket needs, offers it. Each task playbook lists the reports its sessions may send besides stage and links, from done, approval, worktree and playbook, and lists none by default; a session whose playbook lists neither done nor approval ends its turn in Needs you for the operator to review. The prompt lists only the reports the session may send, and the hub refuses any other. A setup or approved-prompt session may report its stage, a worktree, done and links; an ad-hoc prompt may send every report but playbook, because it has no playbook to change. A report is only for work ready to publish: a session that needs the operator's answer or choice, or cannot continue without them, asks with `AskUserQuestion` and waits, so its context stays live, and writes no report for the question. Reports are accepted from the session after it is resumed in VS Code.
  - The reported texts are short, because a row shows about 8 to 10 words: the stage is an -ing phrase of at most four words stating the work now running and what it acts on, such as `fixing tests`, with no ending punctuation because the panel adds `…` on a Working row, optionally after a step count such as `2/5`, and the approval summary one phrase of at most 8 words without counts. The contract appended to every prompt states these word caps; the panel cuts a longer text at a character cap, 24 for the stage, 60 for the approval summary and 80 for a warning or error, on a word boundary, and keeps the whole text in the tooltip. A done report carries no summary, because nothing shows it.
- R36. A session's observed state is `starting`, `running`, `waiting` (needs the operator: a permission prompt or a question), `idle` (its turn ended), `failed` (the turn stopped on an error, with its kind) or `ended`. Hook markers that Switchboard installs in the operator's Claude settings decide the state. The Claude roster decides whether the session is alive, and supplies the state when no marker exists. A session's outcome is `done`, `failed` or `stopped`.
- R37. A triage or session start that fails makes the work item `failed`, with the error. Switchboard does not retry it automatically.
- R38. At most `sessions.concurrency` sessions run at once (default 2, range 1–4). A start that has no free slot waits as `queued`. A setup session and the task session that follows it hold one slot. A `waiting` session holds no slot, so open questions do not stall the queue; after the operator answers, more than `sessions.concurrency` sessions can run until enough end.
- R39. When a session's turn ends, Switchboard stops its background process, so that the session can resume in VS Code. A session waiting on the operator is not stopped. This never deletes the session or its worktree.
- R40. The operator can stop an active background session; a session the operator resumed in VS Code is stopped there. The work item becomes `blocked` with the reason "Stopped by you." once `claude stop` succeeds. A failed stop shows its error and leaves the session stoppable.
- R41. A failed start shows Claude's own message, which for an untrusted directory says how to trust it. Switchboard never writes Claude's trust settings.

### Worktrees

- R24. A worktree belongs to a ticket, and every work item for that ticket reuses it.
- R25. Switchboard links a worktree from a session report, or by branch-name convention when no report exists, such as branch `15619-fix-foo` for GitHub issue 15619. A worktree that git marks prunable, such as one whose directory was deleted, is never linked.
- R26. Tickets from different sources do not share work items. A Zoho ticket gets its own worktree when coding begins.

### Observation and control

- R27. A VS Code panel lists work items. The panel centres on the work item; sessions are secondary: a click on a row opens its session.
  - Rows do not expand. The first line is the title, led by the priority dot on a priority ticket (R50), and the time in the queue. No space is reserved for the dot, so every line starts at the left edge. The second line is the playbook name, the source and key linked to the source, outlined in the source's colour over a muted fill and with `github` shown as `gh`, any pull request links, any GitHub issue links when the ticket is not from GitHub (R52), and "Returned ×N" (R51), with the controls at the right. A third line, shown only when it has something, holds the mark, any warning or error beside it, the stage and its age, the approval summary, and the other link badges. Every row has at least two lines, with room between rows; the list stays easy to scan rather than as dense as possible.
  - The title is bold, because it says what the ticket is. The playbook name shows its namespace muted and its name in the foreground colour, such as `dev:review-pr-followup` with `dev:` muted, because the name says what the work is and the namespace follows from the source.
  - There is no status text: the group and the mark already say it, and the mark's tooltip names it.
  - The triage context and the task prompt are not shown; Switchboard keeps them in the store. An approval report's summary is shown, because it says what Approve publishes, and Approve's tooltip names the prompt it runs.
  - Every group can be collapsed; Needs you, Working and Unstarted start open, Done and Snoozed start closed, and the operator's choice is kept.
  - Groups, in this order: **Needs you** when the status is `awaiting-approval`, `blocked` or `failed`, or the active session is `waiting`; **Working** otherwise, while not done, unstarted or triaging; **Unstarted**; **Done** when the work item is `done` (the last 7 days); **Snoozed** for snoozed tickets (R49).
  - The **Unstarted** group holds everything waiting for the operator to start it, from every source: `unstarted` and `triaging` work items and pool tickets. A ticket being triaged shows `<namespace>:triage` in place of the playbook name, with the source's namespace, such as `dev:triage` or `support:triage`, or `triage` when the source has none. It sorts by importance (R50), counting an unrated ticket as rank 2, then oldest first by the source's sort time (Zoho's customer response time, Forum's last public post) or the work item's creation, so the most urgent and then the longest-waiting come first. Pool tickets carry no claim tag: the sources leave out tickets another developer has claimed, and a ticket the operator has claimed is a work item, not a pool ticket.
  - The mark shows what differs between rows of the same group, because the group header already says what they share; its tooltip names it in words:
    - **Unstarted:** no mark, except a spinning Triaging mark on a work item or pool ticket being triaged; the priority dot on the first line is what differs.
    - **Needs you:** what the operator must do: approve a publish (an approval report), answer a question (`waiting`), look at a block, or deal with a failure (red).
    - **Working:** the phase: queued, setting up, running.
    - **Done:** how it ended: the session reported done, the operator marked it done, or the ticket left the assigned state.
    - **Snoozed:** the mark the item would have in the group it returns to, and the wake time on line 3 unless the snooze is indefinite.
  - In Needs you, a `failed` row has a left stripe in the error colour, and a `blocked` row or one whose session asks a question (`waiting`) one in the warning colour, so what needs an answer or a fix stands out from approvals. No other row has a stripe, including in Snoozed.
  - Controls appear only when they apply: Start, Approve, Retry, Stop, Mark done, Triage again, Snooze and Restore. Each row shows only its main control (Start, Approve, Retry, or Triage again for a failed triage), at the right of lines 2 and 3, and only while the row is hovered, selected or focused, so other rows give their text the full width. The panel shows no separate session state: the group and the mark say what the work item needs. The main control is a large button with its icon and verb; a narrow panel shows only the icon, with the verb in the tooltip. Approve takes the primary button colour, Retry the error colour on a failed row and the warning colour on a blocked one, and Start and Triage again a muted fill. An `awaiting-approval` row whose approval report named a draft also shows a Report icon button before Approve, with the draft's filename as its tooltip, which opens the draft; no other row shows Report. A click elsewhere on the row, or Enter on it, opens the work in a console: the background session attached while its process runs, otherwise the latest session resumed, otherwise the worktree in VS Code, otherwise, when the row has no session, the ticket in the browser. Ctrl+click, or Ctrl+Enter, opens a session that is not running in its background process in VS Code instead, and otherwise the worktree in VS Code when there is one; a row with neither runs its click action. Right-clicking a row opens a VS Code context menu with every control that applies to it. A control's verb matches the status it acts on: Start for `unstarted` and pool tickets, Approve only for `awaiting-approval`.
  - The time in the queue is in whole minutes, hours, days or weeks, and depends on the group (R53): **Needs you** counts from when the work item entered its status, or its session began to wait; **Working** from when the run started; **Unstarted**, **Snoozed** and **Done** from when the ticket entered the source's scope, stopping at done. The tooltip names what it counts.
  - The panel uses VS Code's theme and codicons. It is not a kanban board.
- R28. The operator can attach to a background session in a console, or resume an ended or released one there. Attaching does not create a session, and detaching does not end it. A session already open elsewhere, such as in a VS Code tab, opens there instead, because a live session cannot be resumed twice.
- R29. The operator can open a work item's session in a VS Code Claude Code tab. A session that is not running resumes in a new tab; a session already open in VS Code gets focus.
- R30. A row click resumes an ended session in a console (R28); Ctrl+click opens it in VS Code (R29).
- R31. The operator can start an `unstarted` work item, which starts its task session, and approve an `awaiting-approval` work item, which starts a session with the prompt its approval report named (R23). The panel shows the report's summary next to Approve.
- R49. The operator can snooze a pool ticket or a work item, as in Gmail, and restore it early. Snooze asks how long: Tomorrow, In 2 days, In 3 days, Next week, In 2 weeks, In 4 weeks or Indefinitely. A day starts at 6am local time, so a day choice wakes at 6am that many days after the current day, and a week choice wakes at 6am on a Monday: Next week is the first Monday after the current day. Indefinitely has no wake time: the snooze ends when the operator restores the ticket or it leaves scope. A snoozed ticket shows only in a collapsed Snoozed group, as one row with its wake time: its pool entry, otherwise its open work item, otherwise its latest one. It gets no automatic triage or start, and returns to its group when it wakes or is restored; a queued start then runs. A snoozed ticket that leaves the assigned state and the pool stops being snoozed, so it leaves the Snoozed group; its done work item shows in Done. A snoozed ticket still offers Snooze, and a new snooze replaces the earlier one without waking it. Snoozing is local and never written to the source.
- R56. A Chrome extension hides the cards of snoozed GitHub tickets (R49) on GitHub project boards, so the board shows the same work as the panel. It reads the snoozed tickets from the running hub. Each column with hidden cards has a centred **Show N snoozed cards** link after its last card, which shows them, dimmed, and becomes **Hide N snoozed cards**. N counts only cards GitHub has loaded, because a column loads more as it scrolls. When no hub answers, every card shows. The extension changes only the page, never the project.
- R50. Triage can rate a ticket's importance as immediacy (`URGENT`, `BLOCKING` or `NON-BLOCKING`) and severity (`HIGH`, `MED` or `LOW`), when the source's triage playbook is marked as rating and defines the levels; triage under any other playbook stores neither, whatever the model returns. A ticket is priority when its immediacy is `URGENT` or `BLOCKING`, or its severity is `HIGH`, as on the Support board. The panel shows one orange dot on a priority ticket, with the rating in its tooltip, and no priority dot on any other. Importance rank is the immediacy rank plus the severity rank, lowest first; an unrated ticket counts as rank 2.
- R51. A ticket that returns after an earlier started work item for it with the same playbook was done is marked **Returned**, with the number of those earlier work items, on its pool row or its new work item, so the count is how many times the same work came back, such as a PR back from dev review. A work item that never started a session or ran another playbook does not count. A pool row compares its latest triage's playbook, and a pool row or work item with no playbook yet is not marked.
- R52. A session can report links for its work item: a label and a URL, such as the GitHub issue and pull request it created or found. A successful triage also adds the links its source finds: the GitHub source adds the pull request it gives triage, the most recently updated open one that closes the issue, else the most recently updated one. Added links keep the earlier ones. Local files are not links; a draft reaches the operator only through an approval report (R23). The panel shows links as badges on the work item that open the URL in the browser. A GitHub issue shows as `gh <number>`, like a GitHub ticket's key. A pull request shows its icon and number, as an outlined pill with a muted fill in GitHub's purple; any other URL has its own icon, so the badges read apart without their labels. Ticket pills and the source icons take each source's brand colour. Links stay with the ticket, so a returned ticket keeps them.
- R53. Switchboard records when each ticket entered its source's scope, the assigned state or the pool, and when it last did after leaving it. Only a move from out of scope into scope restarts it; a status change within scope does not. A done work item keeps the time its ticket entered scope, so the time from entering scope to done can serve as a service-level measure.
  - GitHub: when the operator's current assignment began, by Ground Control's rule: the start of the unbroken span in which one of the configured logins was assigned. A status change, including one outside the configured statuses and back, does not restart it.
  - Zoho Desk: the later of the last escalation to `Support` and the last change to Open, so a ticket back from Deferred or On Hold re-enters scope. Who holds it does not matter, including an engineer who held it and let it go.
  - Forum: when the topic last became Open, from the change-history store, whether or not it is assigned to the operator.
  - When the source records no change, the ticket's creation. When the source cannot tell, such as a GitHub issue whose assignment began before the last 100 assignment events, Switchboard keeps the time it has, or the time it first saw the ticket.
- R32. The operator can mark a work item done.

### Runtime

- R33. Switchboard's core runs in a separate process from VS Code and keeps running when the window reloads or closes.
- R42. Settings and playbooks are files in a config folder the operator chooses, so they can be kept in git; by default it is the Switchboard home. The hub reloads them when they change. An invalid settings file leaves the last valid settings in force; a source with invalid settings is disabled; an invalid playbook is left out. Either error shows in the panel.
- R54. The operator edits settings and playbooks in a Settings editor, opened from a gear in the panel's title bar or from the Command Palette. It shows every setting and playbook front matter key as a field with its default and a one-line explanation, and each playbook's template. It checks changes as the operator types and shows each error on its field. Save writes the current page's file, and Save all writes every changed file. Each save refuses what the hub would reject, disable or leave out: an invalid settings file, an enabled source with invalid settings, or an invalid playbook. It also refuses an unknown template variable, which would otherwise fail the session start. It also refuses to overwrite a file that changed on disk after the editor read it. The editor adds and removes sources and creates and deletes playbooks. It does not rename a playbook, because work items store the playbook's name. The files remain the configuration: the operator can still edit them by hand, and the hub reloads them either way.
- R43. On startup the hub reconciles sessions recorded as active against the Claude roster. The hub stays running while any session is active, so sessions can always report, and while a debrief runs (R55).
- R55. Friction debriefs. With the `sessions.debriefs` setting on (it is off by default), the hub asks each of its Claude sessions what slowed it down, for the operator's friction-review skill. It asks as soon as the session's work item is done, otherwise 45 minutes after the session's last turn, in case the operator resumes it; it does not ask 60 minutes or more after that turn, when the prompt cache has expired. It asks only when the session did at least 10 tool calls since its last debrief, and in a fork that leaves the session unchanged. After each session's debrief it asks each Codex thread the session delegated to through agent-delegate in that work, about the thread's turns since its own last debrief. The answers and the record of what was asked are the files Ground Control wrote, so a session Ground Control asked is not asked again about the same work. A failed debrief is reported in the hub log, not on a work item, and is not tried again; the session's later work is asked about with it. The hub does not stay up for a debrief that is not yet due.

## Delivery

Each step ends with `npm run verify` passing and the PRD's affected requirements marked as implemented.

1. **Scaffold.** Workspaces, TypeScript, Vitest, esbuild, `verify` and `test:integration` scripts, an empty extension that starts and stops the hub.
2. **Core.** Store, data model, settings and playbook loading and rendering, assigned-state transitions, work item statuses, the one-active-session rule, approval, `requiresWorktree`, retry and limit decisions. Tested with fake sources and runners.
3. **GitHub source.** Assigned state and triage context, ported from Ground Control's fetch and clip.
4. **Claude runner and classifier.** `claude -p --json-schema` triage, `claude --bg` sessions, roster polling, hook installation and markers, stop, and the trust refusal.
5. **Hub.** Polling, flow execution, the report endpoint, the `switchboard report` CLI, startup reconciliation, the panel protocol.
6. **Panel and ad-hoc source.** Work item list and every R27 control, plus the ad-hoc prompt box. The ad-hoc source comes here because it exercises the whole session path without touching a real ticket.
7. **Live acceptance.** Run the procedure in [testing.md](testing.md#live-acceptance) and record the results.

8. **Operator configuration.** Write the operator's `~/.switchboard/settings.json` for GitHub, a `triage:github` playbook ported from Ground Control's triage prompt (`packages/board/src/triagePrompt.ts`) and the deterministic rules it applies before the model, and `dev:*` playbooks from their Ground Control action table, with `autoStart` set by the design rule "Start automatically unless it writes". The operator reviews them before use.
9. **Zoho Desk source** (R4, R26, R46) and `support:*` playbooks.
10. **Forum source** (R5).

Steps 1–7 deliver GitHub and ad-hoc end to end: R1–R4, R6–R25, R27–R45. Zoho Desk and Forum port the operator's Support board in `D:\git\support`.

## Implementation gaps

Steps 1–7 are delivered: R1–R4 for GitHub, R6–R25 and R27–R45 work end to end, verified by live acceptance on 2026-10-03 ([mechanics.md](mechanics.md) M9). Open in VS Code for a session from another folder and approval reports were verified live in a second round ([mechanics.md](mechanics.md) M13). Step 8 is delivered: the operator's home has the GitHub settings and playbooks, and their hub triaged their 9 assigned issues to the same actions Ground Control chose, all awaiting approval. Steps 9 and 10 are delivered in code: the Zoho Desk source (R46), the Forum source (R5), the pool and its triage (R47), picks (R48), approval reports (R23, R31) and Snoozed (R49) are implemented and tested, picks with fake runners only. Both pools were triaged live, read-only ([mechanics.md](mechanics.md) M10, M11). The operator's Support setup is installed: on 2026-10-03 their hub triaged 6 Zoho and 7 Forum pool tickets into `support:case` with no errors, after the Git Bash fix ([mechanics.md](mechanics.md) M12).

- No pick has run against a real ticket; the first real pick is the operator's.
- Friction debriefs (R55) are tested with a recorded transcript and a fake CLI, and ran live from an isolated hub on an ad-hoc session and its Codex thread ([mechanics.md](mechanics.md) M19). A fork that messages subagents has not run on this CLI version.
- The Settings editor (R54) is tested in jsdom and in a real VS Code host. No save has been made through it to the operator's home.
- The Chrome extension (R56) is tested in jsdom against a recorded board column, and ran unpacked in Chromium against a test-owned hub endpoint on the public board `github.com/orgs/github/projects/4247` on 2026-10-07: snoozed cards hid, the column link showed and hid them, and an unsnooze showed them again. It has not run on the operator's signed-in project board.
- Only Windows is supported and tested. On other platforms the hub lock is a socket file, and two hubs starting at the same moment over a socket left by a crashed hub can both take it.
## Open questions

None.
