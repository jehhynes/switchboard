# Dock and web parity

A living checklist of what the dock's work item list and rows do (PRD R27, R71; [architecture.md § Dock](architecture.md#dock) and [§ Rows](architecture.md#rows)) and whether the web page's list does the same ([architecture.md § Web page](architecture.md#web-page)). One row per behaviour.

A change to a listed behaviour follows the rule in [AGENTS.md](../AGENTS.md#dock-and-web-parity).

Statuses:

- **Present**: the web page does it as the dock does.
- **Partly**: the web page does some of it, or does it differently; the note says what differs.
- **Missing**: the web page does not do it.
- **Web only**: the web page does it and the dock does not.
- **Differs**: intentionally different, with the operator's approval, or the design decision the operator took, named in the note.
- **Dock only**: window management that has no counterpart in a browser page; listed so a change to it is not mistaken for a list behaviour.

The dock's list is in `apps/dock/src/Switchboard.Dock/Views/`, the page's in `packages/web/src/`, and the row data both draw comes from the hub's `rows.ts`, `dock.ts` and `page.ts` in `packages/hub/src/`.

## Open gaps, by value

1. Row controls the page lacks (C8): Open in Claude or Codex and Answer in terminal.
2. More Actions' dock windows (H2): Held sessions and Show hub log only say to use the dock, and New ad-hoc session and New conversation in a folder cannot choose a folder the hub does not know.
3. Held sessions (H4): the held-session note shows, but the page has no Held sessions window to open.
4. Keyboard (K2, K4, K5, O3, O4): no arrow-key walk, F8, menu key, drag or Alt+arrow reordering.
5. Web-only behaviours the dock lacks (R8, C13, G10, H7): a hosted conversation's host on line 2, Stop asking first, the selected row kept in a collapsed group.

## Groups

| # | Behaviour | Web | Note |
|---|---|---|---|
| G1 | Groups in the hub's order: Ready for review, Blocked on you (only with rows), In progress, Unstarted, Snoozed (only with rows), Done | Present | |
| G2 | Group heading: chevron, group codicon, title, row count badge; a zero count muted | Present | |
| G3 | Heading is a tinted bar of the focus blue, lighter on hover | Present | |
| G4 | Click on a heading opens or closes the group; quick second clicks toggle each time | Present | |
| G5 | Blocked on you, Ready for review, In progress and Unstarted start open; Done and Snoozed start closed | Present | Until the operator's choice (G6) |
| G6 | The operator's open or closed choice per group is kept across runs | Present | The page keeps it in its browser's local storage, the dock in `dock.json` |
| G7 | Empty group text in italics, muted, aligned with a row's text (Ready for review, In progress, Unstarted), also when every group is empty | Partly | With no rows at all the page shows one message instead of the groups (G11) |
| G8 | Done's date bands (Today, Yesterday, Earlier this week, Last week, Two weeks ago), each a muted label with count and rule that opens or closes; Today and Yesterday open, the others closed each run | Present | The page resets the bands when it reloads; a closed band still shows the selected row (G10, Web only) |
| G9 | Done draws only the rows in view, so hundreds of rows stay fast | Missing | The page draws every row of an open band; older bands start closed (G8) |
| G10 | A collapsed group or closed Done band still shows the selected row | Web only | The dock's closed group or band hides every row |
| G11 | A list with no rows at all says so | Web only | The dock shows each group's empty text |
| G12 | The heading of the group at the list's top stays pinned there, on an opaque bar and keeping its toggle and count, while the group's rows scroll under it, until the next group's heading pushes it up; a row scrolled into view by the keyboard or a selection lands below it | Present | On the page it spans the list's full width, under iOS's scroll indicator ([architecture.md § Web page](architecture.md#web-page), iPhone and iPad) |
| G13 | The list runs to the bottom edge of a phone's screen, under the home indicator, and its last row scrolls clear of it | Web only | A desktop window has no home indicator |

## Order

| # | Behaviour | Web | Note |
|---|---|---|---|
| O1 | Blocked on you oldest wait first; Ready for review by the operator's position, else `readyAt`; In progress oldest run first; Done newest first | Present | Both take the hub's order |
| O2 | Unstarted work items and pool tickets together, by importance rank then oldest | Present | Both take the hub's order |
| O3 | Drag a Ready for review row to a new place, with a drop line; Escape or lost capture cancels | Missing | |
| O4 | Alt+Up and Alt+Down move the selected Ready for review row | Missing | |
| O5 | Move to top, Move up, Move down and Reset position in the row's menu | Present | In the actions menu's order group |
| O6 | A Ready for review row on the agent's turn is dimmed to 60% | Present | |

## Rows

| # | Behaviour | Web | Note |
|---|---|---|---|
| R1 | Line 1: priority dot (with immediacy and severity tooltip) only on a priority ticket | Present | |
| R2 | Line 1: title in semibold, cut with an ellipsis, whole title in its tooltip | Present | The page's tooltip is on the whole row |
| R3 | Line 1: the voice target's mark before the time, the mic while the mic is on, else the speaker | Present | Both take the glyph and tooltip from the hub |
| R4 | Line 1: time at the end, muted, with what it counts and since when in its tooltip; Done rows show the done time | Present | |
| R5 | Times refresh at least every minute | Present | Both redraw from the hub's rebuilt rows |
| R6 | Line 2: comment icon first, muted, with every comment and its time in the tooltip | Present | |
| R7 | Line 2: playbook with its namespace muted, full name in its tooltip, taking the width the pills leave | Present | |
| R8 | Line 2: a hosted conversation shows its host instead of the playbook | Web only | The dock shows the ad hoc label |
| R9 | Line 2: ticket key pill in its source's colour (GitHub, Zoho, Forum), key and URL in its tooltip | Present | |
| R10 | Line 2: link pills after the key: a pull request purple with its icon and number, an issue by its key, a link by its label, a link the ticket's text names grey and last | Present | |
| R11 | Line 2: Returned pill in the warning colour with the return icon and count, its meaning in its tooltip | Present | |
| R12 | A pill with a link opens it on click or Enter instead of the row's click | Differs | The operator's decision, 2026-11-21: the page's pills are labels, their name and URL in the tooltip, and a click or tap on one is the row's click; the links open from the Browser tab and the header's and a pool row's menu (Open ticket, Open PR, Open link). The dock's pills still open their links |
| R13 | Pills shrink to their icon rather than being cut: longest first while the playbook keeps its width, the rest once the playbook is 60 px, Returned last; a pill of 56 px or less keeps its text until then | Present | |
| R14 | A compact key pill shows the source's logo (or a tag for a source without one); a compact link pill its PR, issue or link icon | Present | |
| R15 | Pills that do not fit even as icons are left out whole, the last first, Returned only when it alone does not fit; they show again when the line widens | Present | |
| R16 | Line 3: the mark, then the details with a muted `·` between them, each in its tone, the last cut with an ellipsis; tooltips hold whole texts | Present | |
| R17 | Line 3 shows the mark's title when the row has no details, and is absent with neither | Present | |
| R18 | Line 3 texts from the hub: wait reasons, rate limit (`Rate limited · resumes…`), blockers in the warning tone, wake time and snooze comment, warning and error, `From <key>`, approval summary or stage with its age, stale stage in the warning tone | Present | Both draw the hub's details |
| R19 | Row separator rule above each row but the first in its band | Present | |
| R20 | Pool tickets (Unstarted, Snoozed) show as rows with Start or Triage again | Differs | Operator approved 2026-11-21: a pool ticket has no conversation, so the page's click opens its menu under the row (Start, Triage again …), placed as the page's other menus are ([architecture.md § Conversation view](architecture.md#conversation-view), Menus); the dock's click opens its triage focus in the browser |
| R21 | No unread count on rows: no work item list shows unread ([architecture.md § Unread](architecture.md#unread)) | Present | |
| R22 | The selected row's buttons beside lines 2 and 3: main control (Approve in the accent colour, its prompt in the tooltip), Copy, Open report; hidden on other rows and on rows with none | Partly | The main control is a button in the conversation header, not on the row, and under 768 px only the first row of the actions menu, as the header has no room for it (the operator's decision); Copy and Open report are in the actions menu |
| R23 | Row sizes: 3 px stripe, padding 5, 8 and 6 px, lines 18 px tall and 3 px apart in 13 px Segoe UI, the title semibold, the first row of a band without the rule's pixel; pills 18 px tall, 1 px border, 6 px padding, 14 px icons, 12 px text; the muted texts in `DockMuted` (`#9D9D9D`, `#717171` light) | Present | Text and pill positions can differ by under a pixel, since the dock rounds each width up to a whole pixel |

## Marks, stripes and colours

| # | Behaviour | Web | Note |
|---|---|---|---|
| M1 | Mark codicon per kind from `MARK_GLYPHS`/`MARK_ICONS`, its meaning as tooltip | Present | |
| M2 | Running and Triaging marks spin | Present | |
| M3 | Mark colour: every mark in the foreground colour and only Failed in the error colour | Present | The conversation header's and dropdown's state icons keep their tones ([architecture.md § Conversation view](architecture.md#conversation-view)) |
| M4 | Left stripe 3 px, inset 8 px top and bottom: error (failed), warning (blocked or asking), turn in the focus blue (operator's turn in review); none on the agent's turn or snoozed | Present | |
| M5 | The selected row's stripe is full height | Present | |
| M6 | Selected row in the selection colour, its texts keeping their colours | Present | In the dock's `DockSelected` colours; the focus ring shows only on a keyboard focus, as the dock's |
| M7 | Row hover background | Present | |
| M8 | Colours from VS Code's Light Modern or Dark Modern, chosen by the dock theme setting (system, VS Code, light, dark) | Differs | The operator's decision: the page follows the operating system's light or dark setting live, with no theme setting and no VS Code choice; its light error, warning and passed colours are VS Code's Light High Contrast values for contrast, darker than the dock's Light Modern ones |
| M9 | The list's scroll bar shows only while the pointer is over the list | Differs | The operator's decision: the browser's own scrollbar, always shown, thin and in the theme's slider colours, since a page-drawn overlay thumb dragged and resized badly |

## Selection and click

| # | Behaviour | Web | Note |
|---|---|---|---|
| S1 | A click selects the row and runs its click: the item window and session, a question's Open in Claude or Codex, a terminal, or the focus URL | Differs | A click selects the work item and opens its conversation in the page, the operator's design decision 19 (`.wip/voice-design.md` § 11). The dock's click on the item window is the actions menu's Open in VS Code, which opens or brings forward the row's window without opening its session |
| S2 | A second click on the row being switched to is ignored; a click on another row replaces it | Present | |
| S3 | A failed click says why in the status toast | Partly | A refused select shows over the composer, or over the list with no conversation |
| S4 | The row of the VS Code window or session terminal that comes to the front is selected, its group opened and scrolled into view | Differs | The page selects only on its own clicks, as decision 19 has it; its selection is kept in the URL |
| S8 | `dock.openIn: web` opens a clicked row's work item in the installed web page, bringing its window forward on Windows, or the page at it in the browser with none open; an Alt-click opens the other of VS Code and the page | Partly | The page's click always opens the work item in the page and its actions menu's Open in VS Code opens VS Code; it has no setting and no Alt-click. The page selects the work item the dock sends it |
| S7 | The selection clears when the selected row's item window closes | Differs | The page keeps its selection, which is its open conversation, until another is clicked (decision 19) |
| S5 | Selecting a row hidden by the search clears the search; a closed group or band opens | Partly | The page selects only rows it shows, so none is hidden by the search; with no search a closed group shows the selected row (G10) |
| S6 | A focus refresh between press and release does not lose the click | Partly | The page keeps unchanged nodes across a redraw, but no test covers a list redraw between press and release |

## Controls, menus and confirmations

| # | Behaviour | Web | Note |
|---|---|---|---|
| C1 | Right-click or Menu key opens the row's menu, at the pointer or the row's corner | Partly | The selected work item's controls are under an ellipsis in the conversation header; no menu on the row itself |
| C2 | Menu groups, separated: main action; work; state; notes; order; opens; controls that ask first | Partly | The same groups, in the same order; no Persona submenu, whose pin is the header's persona button (C7) |
| C3 | Start, Approve, Retry, Stop, Mark done, Snooze…, Unsnooze, Delete | Present | |
| C4 | Reopen on a done row | Present | With the state controls |
| C5 | Start with guidance… and Start with prompt… (text, playbook choice) | Present | The page's input sheet asks as the dock's dialog does |
| C6 | Add comment… | Present | In the notes group |
| C7 | Persona submenu with the session's persona checked and Clear pin | Partly | The page has the persona button and roster in the conversation header |
| C8 | Open in Claude or Codex, Answer in terminal, Open in terminal | Partly | Open in terminal is in the actions menu whenever the dock's menu has it, and opens the page's Console tab, which shows and types into a held Claude Code Mode session's terminal or the Codex terminal the hub holds for a Codex session ([architecture.md § Web page](architecture.md#web-page), [§ Codex runner](architecture.md#codex-runner)); a terminal prompt card answers some waits; on both, an ended registered Claude session is offered as an ended held session, which Open in terminal and the row's click resume (PRD R81). Open in Claude or Codex and Answer in terminal are not on the page |
| C9 | Open changes, History, Open report (VS Code commands) | Partly | Open changes and Open report in the actions menu start VS Code on the row's window. History, in the actions menu and a pool ticket's menu, opens the page's own History with the VS Code History tab's content; of its links the page opens only http and https URLs, while a session, worktree or file opens only from VS Code or the dock |
| C10 | Open ticket and an Open item per link, more than two in an Open link submenu, labels cut at 48 characters | Partly | In the actions menu; the submenu opens in place under Open link rather than beside it, which works at a phone's width |
| C11 | Copy: one draft copies at once, several open a Copy submenu of labels; `Copied <label>.` in the neutral toast; an unreadable draft says why | Partly | Each draft is its own item in the actions menu, nothing confirms the copy, and a refused clipboard shows the text to copy |
| C12 | Delete asks first with the hub's question and detail; the focus starts on Cancel and Enter never deletes | Partly | The page's sheet asks but does not put the focus on Cancel |
| C13 | Stop asks first | Web only | The dock's Stop runs at once |
| C14 | Snooze… dialog: the hub's choices, a date from the earliest timed choice waking at its time of day, a comment; Cancel posts nothing | Present | |
| C15 | Triage again and Start on a pool row | Present | In the pool row's menu, with Start with guidance… and Snooze… or Unsnooze |
| C16 | A control acts only on the hub's current view; with no hub the dock refuses it | Present | The hub checks the row still offers it |
| C17 | A refusal or failure shows in the toast in the warning colours | Partly | The page shows it over the composer |
| C18 | The open work item's ticket and links in a Chrome window over the installed page's Browser tab, behind `web.chromePane` on Windows (PRD R113) | Web only | The dock opens links as new browser tabs (R74); the operator approved the pane as a page feature in R113 ([architecture.md § Pane helper](architecture.md#pane-helper)) |

## Search

| # | Behaviour | Web | Note |
|---|---|---|---|
| F1 | Search button shows or hides the search box; hiding clears the search and its range; Escape closes it | Present | |
| F2 | Matches title, key, linked PRs and issues, playbook, group and branch; every word, any case | Present | Both match the hub's search text |
| F3 | Searches 250 ms after the last key from 3 characters; at once for a ticket or link key (`18941`, `gh 18941`, `PR #19002`, `#107`) | Present | |
| F4 | Groups with matches show open; groups without are hidden; bands open while filtering | Present | |
| F5 | Range menu: Last 2 weeks, Last month, Last 3 months, All time; older Done rows from the hub under their month | Present | |
| F6 | Search further back, and All time when nothing matched; "No matches for … in the …"; Clear search; Searching…; "Showing the newest N matches…"; the hub's refusal | Present | |
| F7 | A newer search or range drops an older answer | Present | |

## Header, notes and messages

| # | Behaviour | Web | Note |
|---|---|---|---|
| H1 | Source icons per kind, grey when off; click toggles one source, or opens a check menu for several | Present | A kind without a logo shows a tag where the dock's button is blank; a refusal shows under the header (H6) |
| H2 | More Actions: New ad-hoc session…, New conversation in a folder…, Held sessions, Refresh sources, Show hub log, Open Settings | Partly | The page has the dock's items and groups. New ad-hoc session…, New conversation in a folder… and Refresh sources work, but offer only the folders the hub knows (repo roots and conversation hosts), with no folder picker; Held sessions and Show hub log say to use the dock, and Open Settings opens the page's Settings (Settings S1). Page only: Reload after Refresh sources, since an installed app on a phone has no browser reload (the operator's request); Pair a device… before Open Settings (R115; the operator asked for it in the web app, the dock only if simple); on a paired device, Voice on this phone (R119), as the dock has no phone microphone to offer; and on this computer's page, Voice on the computer while the voice is on a phone or none has it (R119), as the dock has no voice controls. Under 768 px the source icons are check rows at the top of the menu. On a paired device the page leaves out Pair a device… and Open Settings (R115: the operator's decision that Settings stay on the computer) |
| H3 | Settings, playbook, hook, source and voice errors and setup notes above the groups, in the warning colour | Present | Under the page's list header |
| H4 | "N held sessions without a work item" above the groups, opening the held sessions window | Partly | The page shows the note, but has no Held sessions window, so its click opens the sheet that says to use the dock (H2) |
| H9 | Terminal holder from an older build: the notice above the groups with Restart and resume, which asks first naming the sessions it interrupts, "Restarting…" while it runs, and the result until dismissed | Differs | The page shows the notice and result under the list header and asks in a sheet; a paired device's page shows the notice without Restart and resume, and the hub refuses the restart from it (R115, the operator's decision) |
| H5 | Needs-you message in the toast when a work item starts needing the operator; a click on it runs that row's click | Present | One surface announces each event, the dock or the page that raises alerts, as the `alerts.surface` setting chooses (PRD R65). That page shows the message under the list header, a click on it selecting its work item (S1), and also shows a browser notification per work item, whose click selects it, and plays the needs-you chime when the voice does not |
| H6 | The toast hides after 10 seconds shown with the pointer off it; Dismiss clears it | Partly | The needs-you message hides after 10 seconds shown on a visible page with the pointer off it, and Dismiss clears it; refusals show where their action was taken instead (C17) |
| H8 | Title row: Close, More Actions, Auto-hide, Search and the source icons keep their width from the right, the title takes the rest with an ellipsis, and a control that does not fit whole is hidden | Partly | The page's icons keep their width at the right; nothing is hidden for want of room. From 768 px the page has no "Switchboard" title, which the tab or app title already shows; under 768 px, where the list is its own view, the app's icon and "Switchboard" start the row and take the rest with an ellipsis (operator's decisions). Close and Auto-hide are Dock only (D3, D6) |
| H7 | Page title counts Blocked on you, "(2) Switchboard" | Web only | |
| H10 | Auto-hide: hidden, a 3 px sliver at the edge shows each row's stripe at its height, cut to the list's view and left out under a pinned heading; the pointer resting on it for 0.5 s shows the list over other content; it hides at once 0.4 s after nothing keeps it open (the pointer over it, an open menu or dialog, typing in its search box), and a row's click hides it | Partly | The page's list drawer has the same sliver, reveal and hide delays, and hides on choosing a work item. It hides by the page's width, from 768 px with a work item open while the list, the conversation and the Status and Artifacts column do not all fit, with no pin, as the operator decided that the page's columns follow its width and the room they need; the header's Work items button also shows it, staying until a work item is chosen, Escape or a click outside, and it slides in over 0.15 s where the dock shows at once, as the operator asked |

## Settings

The dock's Settings window (PRD R54, [architecture.md § Settings window](architecture.md#settings-window)) and the web page's Settings ([§ Web page](architecture.md#web-page)). The dock's is in `apps/dock/src/Switchboard.Dock/Settings/` and `Views/SettingsWindow.cs`, the page's in `settingsModel.ts` and `settings.tsx` in `packages/web/src/`.

| # | Behaviour | Web | Note |
|---|---|---|---|
| S1 | Opened from More Actions' Open Settings; reads settings.json through the hub's config routes | Differs | The page reads and saves through the hub's page commands, on this computer's page only: a paired device has no Open Settings and the hub refuses these commands from it (R115, the operator's decision) |
| S2 | Navigation in a ticket's order: General; Sources; Playbooks by namespace; Schedules; Voice settings and personas; each with its New entries | Present | |
| S3 | A page with unsaved changes shows a dot in the navigation, and one with errors an error mark | Present | |
| S4 | General: Sessions, Claude sessions, Codex sessions, Triage, Dock (with Row click opens), Alerts (Needs-you alerts from), Web page (Chrome pane), Remote access (Tailscale, Allowed hosts, Allowed logins), and a collapsed Advanced section with the executable paths | Present | With the dock's labels, help, defaults and choices |
| S5 | General's Dock section starts with Theme, the dock's own theme kept in `dock.json` | Dock only | The theme colours the dock; the page follows the operating system's light or dark setting (M8) |
| S6 | A field's help in its info icon's tooltip | Present | On the page a tap also shows the help under the field, for a phone |
| S7 | An Advanced section starts collapsed, stays open across redraws once opened, and opens when a check places a new error in it | Present | |
| S8 | The draft is checked 250 ms after the last edit and after each read; each error shows on its field, one that names no field at the top of the page | Present | |
| S9 | The bar: Saved, Unsaved changes or Saving…, with the error count; the changed-on-disk warning; a refused or blocked save's errors; Save and Discard | Present | |
| S10 | Save closes once the file holds the draft; Ctrl+S saves and stays open; Discard drops the draft and closes; a save waits for a due check and refuses while an error stands | Present | |
| S11 | Closing with unsaved changes asks Save, Discard or Keep editing | Present | From Close or Escape |
| S12 | The hub's `config` event reads the file again; a draft over a file changed on disk cannot be saved; another config folder drops the draft and says so | Present | The page also reads the file when it gets the focus or becomes visible, for an event missed while its stream was down |
| S13 | The settings.json path under the title opens the file in VS Code | Partly | The page shows the path as text, since a page cannot open a file in VS Code |
| S14 | On a phone the navigation is a list that drills into each page, with Back to it | Web only | A desktop window has no phone layout |
| S15 | Sources: a page per source with Kind, the common fields, its kind's own and Advanced; a source that is off noted in the navigation; changing the kind keeping only the common keys; New <kind> source, New source (kind and name) and Remove source | Present | |
| S16 | Playbooks: a page per playbook whose fields follow its kind, reports and agent, an entry it cannot read shown with its error and Delete, a table page per namespace, New playbook and Delete, which asks naming the open work items; an edit undone restores the entry as the file has it | Present | On a phone the table scrolls sideways |
| S17 | Schedules: a page per schedule whose day and time show only for the period that uses them, a new period dropping the old day and Only by hand the time; New schedule and Remove schedule | Present | |
| S18 | Voice settings with Playbook personas and Assign, Your voice's enrolment, a page per persona, New persona and Remove persona | Present | |
| S19 | General's Remote access lists the paired devices (name, where from, last used, voice allowed) with Allow voice or Forbid voice on a paired device and Sign out, and Pair a device… shows a new link and code, through the hub's device routes | Present | The page also draws the link as a QR code and marks its own browser, which the dock, with no QR encoder and no browser of its own, leaves out |

## Connection

| # | Behaviour | Web | Note |
|---|---|---|---|
| N1 | "Connecting to Switchboard…" until the first view | Partly | Shown in the conversation pane, not over the list |
| N2 | Without the hub the last rows stay, dimmed to half and disabled; a row menu closes | Partly | The last rows stay but are not dimmed; the page reconnects and reloads by itself, and shows an offline page when the hub is down at load |
| N3 | "Switchboard is not running…" with Start hub | Partly | The hub serves the page (decision 20), so the offline page's Start Switchboard opens the `switchboard:` link that `hub.js autostart on` registers, which starts the hub (PRD R117); with no link registered it does nothing, and the page names the command |
| N4 | An expired sign-in says how to get a new link | Web only | |

## Keyboard, focus and tooltips

| # | Behaviour | Web | Note |
|---|---|---|---|
| K1 | Rows, group and band headings and link pills take the focus, shown as a focus-blue ring | Partly | Rows and group and band headings take the focus, with a 1 px outline; pills do not |
| K2 | Up and Down move the focus along rows and headings; a row reached by keyboard is selected and scrolled into view | Missing | Tab moves between rows; focusing does not select |
| K3 | Enter on a row runs its click; Enter or Space on a heading toggles it | Present | |
| K4 | Menu key or Shift+F10 opens a row's menu | Missing | |
| K5 | F8 and Shift+F8 select the next or previous operator's-turn row in Blocked on you and Ready for review, open its group, clear a hiding search and run its click | Missing | |
| K6 | Tab from the selected row reaches its buttons | Missing | Follows R22 |
| K7 | A view that moves the focused row keeps the focus on it, or on its closed group's heading | Partly | The page keeps a row's focus only when the row stays in place |
| K8 | Every mark, pill, time, comment, priority and detail has its meaning in a tooltip | Present | |
| K10 | Header icon buttons have accessible names; marks and the priority dot have an image role and label | Present | |

## Dock only

Window management with no counterpart in a browser page. These rows are outside the parity rule; a change to one updates its row only.

| # | Behaviour |
|---|---|
| D1 | Docks at a monitor's left or right edge, as an app bar on Windows or an X11 dock window on Linux, and moves there by dragging the title |
| D2 | The inner-edge grip sets the width, 200 to 800 |
| D3 | Auto-hide pin, and the app bar and window region that hide the dock; the page's list auto-hides by width (H10) |
| D4 | Stays above windows except a full-screen one on its monitor |
| D6 | Close the dock |
| D7 | Held sessions and Settings open in windows of their own; the page's Settings is a dialog over the page, full screen on a phone |
| D8 | Tooltips and menus open at the pointer or button, away from the dock's edge and kept on its monitor |
