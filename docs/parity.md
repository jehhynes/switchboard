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

Evidence names the file and line as of `main` at `a1323bc`; the symbol named beside a line is the lasting reference. `MainWindow.axaml`, `MainWindow.axaml.cs`, `ViewModels.cs` and `PillLine.cs` are in `apps/dock/src/Switchboard.Dock/Views/`; `rows.ts`, `dock.ts`, `page.ts` and `app.ts` in `packages/hub/src/`; `render.ts`, `main.ts`, `model.ts` and `page.css` in `packages/web/src/`.

## Open gaps, by value

1. Row controls the page lacks (C8, C9, R12): Open in Claude or Codex and Answer in terminal, History (the page has no History view), and Enter on a pill.
2. More Actions' dock windows (H2): Held sessions, Ticket volume report, Show hub log and Open Settings only say to use the dock, and New ad-hoc session and New conversation in a folder cannot choose a folder the hub does not know.
3. Problems the page never shows (H3, H4, H5): settings, source and voice errors, orphan held sessions, and the needs-you message.
4. Done's date bands and group state (G5, G6, G8): Done is one flat list, Snoozed starts open, and open or closed choices do not survive a reload.
5. Mark colours (M3): the dock and the web page colour marks by different rules; one of them should change.
6. Keyboard (K2, K4, K5, O3, O4): no arrow-key walk, F8, menu key, drag or Alt+arrow reordering.
7. Voice mark (R3): the page does not show which row the voice speaks for.
8. Web-only behaviours the dock lacks (R8, C13, G10, H7): a hosted conversation's host on line 2, Stop asking first, the selected row kept in a collapsed group.

## Groups

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| G1 | Groups in the hub's order: Ready for review, Blocked on you (only with rows), In progress, Unstarted, Snoozed (only with rows), Done | `dockView` dock.ts:287 | Present | `pageList` page.ts:310 keeps the dock's groups and order |
| G2 | Group heading: chevron, group codicon, title, row count badge; a zero count muted | MainWindow.axaml:468-476, `IsZero` ViewModels.cs:913 | Present | `renderList` render.ts:274-277, page.css:30-31 |
| G3 | Heading is a tinted bar of the focus blue, lighter on hover | MainWindow.axaml:137-144 | Present | page.css:26-27 |
| G4 | Click on a heading opens or closes the group; quick second clicks toggle each time | `OnGroupTapped` MainWindow.axaml.cs:1282 | Present | `case 'group'` main.ts:984 |
| G5 | Blocked on you, Ready for review, In progress and Unstarted start open; Done and Snoozed start closed | `OpenByDefault` ViewModels.cs:42 | Partly | Only Done starts collapsed (`COLLAPSED_GROUPS` render.ts:210); Snoozed starts open |
| G6 | The operator's open or closed choice per group is kept across runs (`dock.json` `groups`) | `Toggled` ViewModels.cs:622 | Missing | `view.collapsed` lives only in memory (render.ts:64); a reload resets it |
| G7 | Empty group text in italics, muted, aligned with a row's text (Ready for review, In progress, Unstarted), also when every group is empty | MainWindow.axaml:479, `GROUP_EMPTY` rows.ts:797 | Partly | render.ts:273, page.css:32; with no rows at all the page shows one message instead of the groups (G11) |
| G8 | Done's date bands (Today, Yesterday, Earlier this week, Last week, Two weeks ago), each a muted label with count and rule that opens or closes; Today and Yesterday open, the others closed each run | `BandViewModel` ViewModels.cs:740, MainWindow.axaml:485-492, `doneBand` rows.ts:475 | Missing | `listRow` ignores `band`; Done shows one flat list |
| G9 | Done draws only the rows in view, so hundreds of rows stay fast | MainWindow.axaml:18-24 | Missing | Not needed until G8 and search bring older rows |
| G10 | A collapsed group still shows the selected row | none: a closed group hides every row | Web only | `renderList` render.ts:272 |
| G11 | A list with no rows at all says so | none: each group shows its empty text | Web only | "No work items yet…" render.ts:267 |
| G12 | The heading of the group at the list's top stays pinned there, on an opaque bar and keeping its toggle and count, while the group's rows scroll under it, until the next group's heading pushes it up; a row scrolled into view by the keyboard or a selection lands below it | `PinGroupHeads`, `Reveal` MainWindow.axaml.cs | Present | `.group-head` `position: sticky` page.css, the gap after a group inside its section (`.group::after`), `scroll-margin-top` on rows and the pool row menu |

## Order

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| O1 | Blocked on you oldest wait first; Ready for review by the operator's position, else `readyAt`; In progress oldest run first; Done newest first | `listGroups` rows.ts:812 | Present | Same hub order through `pageList` |
| O2 | Unstarted work items and pool tickets together, by importance rank then oldest | `unstartedOrder` rows.ts:755 | Present | Same hub order through `pageList`, pool rows included |
| O3 | Drag a Ready for review row to a new place, with a drop line; Escape or lost capture cancels | `OnListPressed`…`ShowDrop` MainWindow.axaml.cs:1121-1269 | Missing | |
| O4 | Alt+Up and Alt+Down move the selected Ready for review row | `OnKey` MainWindow.axaml.cs:1010 | Missing | |
| O5 | Move to top, Move up, Move down and Reset position in the row's menu | `moveControls` rows.ts:272, `OrderActions` MainWindow.axaml.cs:1431 | Present | `pageActions` page.ts puts them in the order group; `row-action` names each by its label |
| O6 | A Ready for review row on the agent's turn is dimmed to 60% | MainWindow.axaml:201, `dim` dock.ts:396 | Present | page.css:44 |

## Rows

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| R1 | Line 1: priority dot (with immediacy and severity tooltip) only on a priority ticket | MainWindow.axaml:502, `priorityTitle` rows.ts:533 | Present | render.ts:239, page.css:47 |
| R2 | Line 1: title in semibold, cut with an ellipsis, whole title in its tooltip | MainWindow.axaml:504 | Present | render.ts:253-254 (tooltip on the row button) |
| R3 | Line 1: the voice target's mic mark before the time | MainWindow.axaml:506, app.ts:589 | Missing | `PageRow` page.ts:205 carries no voice mark |
| R4 | Line 1: time at the end, muted, with what it counts and since when in its tooltip; Done rows show the done time | MainWindow.axaml:508, `rowTime` rows.ts:511 | Present | render.ts:240 |
| R5 | Times refresh at least every minute | hub `tick` (architecture.md § Rows) | Present | the hub sends `list` on each rebuild (conversation.ts:536) |
| R6 | Line 2: comment icon first, muted, with every comment and its time in the tooltip | MainWindow.axaml:513, `commentOf` dock.ts:503 | Present | render.ts:241 |
| R7 | Line 2: playbook with its namespace muted, full name in its tooltip, taking the width the pills leave | MainWindow.axaml:514-515 | Present | render.ts:232-237, page.css:58-59 |
| R8 | Line 2: a hosted conversation shows its host instead of the playbook | none: shows the ad hoc label | Web only | render.ts:233 |
| R9 | Line 2: ticket key pill in its source's colour (GitHub, Zoho, Forum), key and URL in its tooltip | MainWindow.axaml:517-529, `TicketTip` ViewModels.cs:1155 | Present | render.ts:242, page.css:67-69 |
| R10 | Line 2: link pills after the key: a pull request purple with its icon and number, an issue by its key, a link by its label, a link the ticket's text names grey and last | MainWindow.axaml:530-547, `linksOf` dock.ts:452 | Present | render.ts:243-246, page.css:70-71 |
| R11 | Line 2: Returned pill in the warning colour with the return icon and count, its meaning in its tooltip | MainWindow.axaml:548-553, `ReturnedTitle` ViewModels.cs:1161 | Present | render.ts:247, page.css:72 |
| R12 | A pill with a link opens it on click or Enter instead of the row's click | `OnPillTapped` MainWindow.axaml.cs:1301, `ListKey` :1027 | Partly | A click or tap opens it in a new tab without selecting the row (`open-link` in main.ts, `tabUrl` model.ts), and in the installed app in the default browser through the hub (`row-open`); pills stay text inside the row button and take no focus, so Enter does not (see K1); the menu's Open items reach each link by keyboard |
| R13 | Pills shrink to their icon rather than being cut: longest first while the playbook keeps its width, the rest once the playbook is 60 px, Returned last; a pill of 56 px or less keeps its text until then | `PillLine` PillLine.cs:8-187 | Present | `fitPills` fit.ts, applied to every row once a frame after a list redraw or a change of its width (`fitLines` main.ts) |
| R14 | A compact key pill shows the source's logo (or a tag for a source without one); a compact link pill its PR, issue or link icon | MainWindow.axaml:521-526, `IconGlyph` DockView.cs:125 | Present | A compact key pill shows codicon `github` or `tag` (`pill` render.ts); a link pill keeps its glyph; Zoho and Forum have no logo on the page |
| R15 | Pills that do not fit even as icons are left out whole, the last first, Returned only when it alone does not fit; they show again when the line widens | PillLine.cs:162-172 | Present | `fitPills` fit.ts: the playbook gives way entirely first, then pills are left out the last first, Returned only when alone it does not fit |
| R16 | Line 3: the mark, then the details with a muted `·` between them, each in its tone, the last cut with an ellipsis; tooltips hold whole texts | MainWindow.axaml:556-574, `DetailViewModel` ViewModels.cs:1214 | Present | render.ts:248-256, page.css:73-79 |
| R17 | Line 3 shows the mark's title when the row has no details, and is absent with neither | `orMarkTitle` dock.ts:411, `HasThirdLine` ViewModels.cs:1133 | Present | render.ts:256 |
| R18 | Line 3 texts from the hub: wait reasons, rate limit (`Rate limited · resumes…`), blockers in the warning tone, wake time and snooze comment, warning and error, `From <key>`, approval summary or stage with its age, stale stage in the warning tone | `itemRow` dock.ts:386-393, `limitTexts` rows.ts:666, `wake` dock.ts:487 | Present | Same `details` through `pageList` |
| R19 | Row separator rule above each row but the first in its band | MainWindow.axaml:169-177 | Partly | page.css:34-35: the first in its group, since Done has no bands (G8) |
| R20 | Pool tickets (Unstarted, Snoozed) show as rows with Start or Triage again | `poolRow` dock.ts:415 | Differs | Listed with the dock's three lines by `pageList` page.ts (`ticketId`, no `workItemId`); a pool ticket has no conversation, so a click opens its menu under the row (Start, Triage again …), 8 px inside the row's left edge, and against its right edge or above it only where the page has no room (architecture.md § Menus), where the dock's click opens its triage focus in the browser; operator approved 2026-11-21 |
| R21 | No unread count on rows: no work item list shows unread (architecture.md § Unread) | (dropped in `a7274f7`) | Present | `PageRow` page.ts:205 carries none and `listRow` render.ts:225 draws none |
| R22 | The selected row's buttons beside lines 2 and 3: main control (Approve in the accent colour, its prompt in the tooltip), Copy, Open report; hidden on other rows and on rows with none | MainWindow.axaml:577-591, 126-134, `mainTitle` rows.ts:139 | Partly | The main control is a button in the conversation header, not on the row (`renderActions` render.ts:94-95); Copy and Open report are in the actions menu |

## Marks, stripes and colours

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| M1 | Mark codicon per kind from `MARK_GLYPHS`/`MARK_ICONS`, its meaning as tooltip | MainWindow.axaml:557, group.ts:143-203 | Present | render.ts:227-230 |
| M2 | Running and Triaging marks spin | `MarkSpins` ViewModels.cs:1123, MainWindow.axaml:357-369 | Present | `SPINNING_MARKS` render.ts:230 |
| M3 | Mark colour: the dock draws every mark in the foreground colour and only Failed in the error colour; the web page follows `MARK_TONES` (muted, warning for question, permission, send, blocked and limited, error for failed) | MainWindow.axaml:557 (`failed` class only) | Partly | render.ts:230; architecture.md § Conversation view names `MARK_TONES` as the rule for the web page and the view, not the dock |
| M4 | Left stripe 3 px, inset 8 px top and bottom: error (failed), warning (blocked or asking), turn in the focus blue (operator's turn in review); none on the agent's turn or snoozed | MainWindow.axaml:185-199, `stripeOf` rows.ts:720 | Present | page.css:36-39 |
| M5 | The selected row's stripe is full height | MainWindow.axaml:188-190 | Present | page.css:43 |
| M6 | Selected row in the selection colour | MainWindow.axaml:181-183 | Present | `.row.selected` page.css; the focus ring shows only on a keyboard focus (`button:focus-visible`), as the dock's |
| M7 | Row hover background | MainWindow.axaml:178-180 | Present | page.css:40 |
| M8 | Colours from VS Code's Light Modern or Dark Modern, chosen by the dock theme setting (system, VS Code, light, dark) | `ApplyTheme` MainWindow.axaml.cs:1938 | Partly | Dark Modern only (theme.css) |
| M9 | The list's scroll bar shows only while the pointer is over the list | MainWindow.axaml:69-74 | Differs | The operator's decision: the browser's own scrollbar, always shown, thin and in the theme's slider colours (page.css), since a page-drawn overlay thumb dragged and resized badly |

## Selection and click

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| S1 | A click selects the row and runs its click: the item window and session, a question's Open in Claude or Codex, a terminal, or the focus URL | `Open` MainWindow.axaml.cs:1322, `openOf` dock.ts:603 | Differs | A click selects the work item and opens its conversation in the page (`select` main.ts:837); the operator's design decision 19 (`.wip/voice-design.md` § 11). The dock's click on the item window is the actions menu's Open in VS Code, which opens or brings forward the row's window through the hub without opening its session |
| S2 | A second click on the row being switched to is ignored; a click on another row replaces it | MainWindow.axaml.cs:1331-1337 | Present | The latest work item clicked wins (`reconcile` main.ts:862) |
| S3 | A failed click says why in the status toast | `ShowFailure` MainWindow.axaml.cs:1369 | Partly | A refused select shows over the composer, or over the list with no conversation (main.ts:880-893) |
| S4 | The row of the VS Code window or session terminal that comes to the front is selected, its group opened and scrolled into view | `SelectWindow` ViewModels.cs:649, `ShowItemWindow` MainWindow.axaml.cs:968 | Differs | The page selects only on its own clicks, as decision 19 has it; the selection is kept in the URL (`#w=`, main.ts:87, 847) |
| S7 | The selection clears when the selected row's item window closes | `WindowClosed` ViewModels.cs:674 | Differs | The page keeps its selection, which is its open conversation, until another is clicked (decision 19) |
| S5 | Selecting a row hidden by the search clears the search; a closed group or band opens | `Reveal` ViewModels.cs:713 | Partly | The page selects only rows it shows, so none is hidden by the search; with no search a closed group shows the selected row (G10) |
| S6 | A focus refresh between press and release does not lose the click | `HoldView` ViewModels.cs:513 | Partly | `morph` keeps unchanged nodes, but no test covers a list redraw between press and release |

## Controls, menus and confirmations

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| C1 | Right-click or Menu key opens the row's menu, at the pointer or the row's corner | `OnRowContext` MainWindow.axaml.cs:1379 | Partly | The selected work item's controls are under an ellipsis in the conversation header (`renderActions` render.ts:75); no menu on the row itself |
| C2 | Menu groups, separated: main action; work; state; notes; order; opens; controls that ask first | `MenuOf` MainWindow.axaml.cs:1438 | Partly | Main, work, state, notes (Add comment…), order, opens and asking, separated (`pageActions` page.ts, `menuRows` render.ts); no Persona submenu, whose pin is the header's persona button (C7) |
| C3 | Start, Approve, Retry, Stop, Mark done, Snooze…, Unsnooze, Delete | `controlsOf` rows.ts:148 | Present | `PAGE_ACTIONS` page.ts:237 |
| C4 | Reopen on a done row | rows.ts:186 | Present | `PAGE_ACTIONS` page.ts, with the state controls |
| C5 | Start with guidance… and Start with prompt… (text, playbook choice) | `guidedStart`, `promptedStart` rows.ts:82-94, `InputDialog` | Present | `pageActions` page.ts sends `input`; the input sheet (`renderSheet` render.ts) asks as `InputDialog` does, and the hub fills the fields (`pageActionEvent`) |
| C6 | Add comment… | `commentControl` rows.ts:97 | Present | in the notes group, through the input sheet |
| C7 | Persona submenu with the session's persona checked and Clear pin | `personaControls` app.ts:601, MainWindow.axaml.cs:1477 | Partly | Persona button and roster in the conversation header (render.ts:327-333) |
| C8 | Open in Claude or Codex, Answer in terminal, Open in terminal | rows.ts:168-205, MainWindow.axaml.cs:1450-1500 | Partly | Open in terminal is in the actions menu's opens group after Copy whenever the dock's menu has it (`terminal` in `pageList` page.ts), and opens the Console tab, or the Console tab of the Status and Artifacts column on a wide screen, which shows a held Claude Code Mode session's terminal and types into it once clicked (`drawConsole` main.ts, `console.ts`; architecture.md § Web page); a Codex session's Console says why it has none; a terminal prompt card answers some waits; Open in Claude or Codex and Answer in terminal are not on the page |
| C9 | Open changes, History, Open report (VS Code commands) | `windowCommands` dock.ts:771 | Partly | Open changes and Open report in the actions menu: the hub leaves the dock's command for the row's window and starts VS Code on it (`row-command`, `pageCommandOf` page.ts); History is missing, as the page has no History view and does not send it to VS Code |
| C10 | Open ticket and an Open item per link, more than two in an Open link submenu, labels cut at 48 characters | MainWindow.axaml.cs:1502-1560 | Partly | `renderActions` render.ts, in the actions menu after Copy; the submenu opens in place under Open link rather than beside it, which works at a phone's width |
| C11 | Copy: one draft copies at once, several open a Copy submenu of labels; `Copied <label>.` in the neutral toast; an unreadable draft says why | `Copy` MainWindow.axaml.cs:1715, menu :1482-1489, `OnCopyClicked` :1762 | Partly | `copyPaste` main.ts:1447: each draft is its own item in the actions menu (render.ts:90), nothing confirms the copy, and a refused clipboard shows the text to copy |
| C12 | Delete asks first with the hub's question and detail; the focus starts on Cancel and Enter never deletes | `Act` MainWindow.axaml.cs:1630, `ConfirmDialog`, `deleteConfirm` rows.ts:218 | Partly | the sheet asks (render.ts:155-157) but does not put the focus on Cancel |
| C13 | Stop asks first | none: Stop runs at once | Web only | `pageActions` page.ts:258 |
| C14 | Snooze… dialog: the hub's choices, a date from the earliest timed choice waking at its time of day, a comment; Cancel posts nothing | `Snooze` MainWindow.axaml.cs:1610, `SnoozeDialog` | Present | `renderSheet` render.ts:163-170, `snoozeDateUntil` :131 |
| C15 | Triage again and Start on a pool row | `poolControls` rows.ts:301 | Present | In the pool row's menu with Start with guidance… and Snooze… or Unsnooze, run through `pool-action` |
| C16 | A control acts only on the hub's current view; with no hub the dock refuses it | `Act` MainWindow.axaml.cs:1662 | Present | the hub checks the row still offers it (`pageActionEvent` page.ts:275) |
| C17 | A refusal or failure shows in the toast in the warning colours | `Status` ViewModels.cs:438 | Partly | shows over the composer (`runAction` main.ts:1416) |
| C18 | The open work item's ticket and links in a Chrome window over the installed page's right column, behind `web.chromePane` on Windows (PRD R113) | none: the dock opens links in the browser's Switchboard tab group (R74) | Web only | `reportPane` main.ts, `PaneState` pane.ts; the hub's pane helper glues the window, with or without the dock (architecture.md § Pane helper). The operator approved the pane as a page feature in R113 |

## Search

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| F1 | Search button shows or hides the search box; hiding clears the search and its range; Escape closes it | `OnSearchClicked` MainWindow.axaml.cs:2176, `SearchOpen` ViewModels.cs:403 | Present | `setOpen` listHeader.ts |
| F2 | Matches title, key, linked PRs and issues, playbook, group and branch; every word, any case | `Matches` ViewModels.cs:986, `searchText` dock.ts:313 | Present | `matches` listHeader.ts on `PageRow.search`, the dock row's `search` (`pageRow` page.ts) |
| F3 | Searches 250 ms after the last key from 3 characters; at once for a ticket or link key (`18941`, `gh 18941`, `PR #19002`, `#107`) | `Query` ViewModels.cs:193, `IsKey` :240 | Present | `typed`, `isKey` listHeader.ts |
| F4 | Groups with matches show open; groups without are hidden; bands open while filtering | `IsShown` ViewModels.cs:890, `ShowsRows` :762 | Present | `filterGroups` listHeader.ts, `renderList` render.ts with `filtering`; the page has no bands (G8) |
| F5 | Range menu: Last 2 weeks, Last month, Last 3 months, All time; older Done rows from the hub under their month | `Ranges` ViewModels.cs:36, `SearchOlder` :319 | Partly | `page-search` (conversation.ts) answers the dock's `DoneSearch` rows; the page adds them after Done's own rows, not under month bands (G8) |
| F6 | Search further back, and All time when nothing matched; "No matches for … in the …"; Clear search; Searching…; "Showing the newest N matches…"; the hub's refusal | MainWindow.axaml:608-617, ViewModels.cs:379-389 | Present | `renderSearchEnd` listHeader.ts |
| F7 | A newer search or range drops an older answer | ViewModels.cs:334 | Present | `searchRun` in `listHeader` listHeader.ts |

## Header, notes and messages

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| H1 | Source icons per kind, grey when off; click toggles one source, or opens a check menu for several | `OnSourceClicked` MainWindow.axaml.cs:1787 | Present | `sourceButton` listHeader.ts, `page-source` in conversation.ts; a kind without a logo shows the `tag` codicon where the dock's button is blank; a refusal shows under the header (no toast, H6) |
| H2 | More Actions: New ad-hoc session…, New conversation in a folder…, Held sessions, Ticket volume report, Refresh sources, Show hub log, Open Settings | `HeaderMenu` MainWindow.axaml.cs:1903 | Partly | `renderMoreMenu` listHeader.ts has the dock's items and groups. New ad-hoc session…, New conversation in a folder… and Refresh sources work, but offer only the folders the hub knows (repo roots and conversation hosts), with no Choose a folder…; Held sessions, Ticket volume report, Show hub log and Open Settings say to use the dock. Under 768 px the source icons are check rows at the top of the menu |
| H3 | Settings, playbook, hook, source and voice errors and setup notes above the groups, in the warning colour | MainWindow.axaml:450-456, `snapshotErrors` rows.ts:844 | Missing | |
| H4 | "N held sessions without a work item" above the groups, opening the held sessions window | MainWindow.axaml:458-462 | Missing | |
| H9 | Terminal holder from an older build: the notice above the groups with Restart and resume, which asks first naming the sessions it interrupts, "Restarting…" while it runs, and the result until dismissed | `HolderNotice`, `HolderResult` MainWindow.axaml; `OnHolderRestartClicked` MainWindow.axaml.cs; `holderNotices` dock.ts | Present | `holderNotices` and the `holder` sheet listHeader.ts: the notice and result show under the list header, and Restart and resume asks in a sheet and posts `page-holder-restart` |
| H5 | Needs-you message in the toast when a work item starts needing the operator; a click on it runs that row's click | `ShowNeedsYou` MainWindow.axaml.cs:267 | Missing | The tab title counts Blocked on you instead (`pageTitle` model.ts:107) |
| H6 | The toast hides after 10 seconds shown with the pointer off it; Dismiss clears it | `CheckStatus` MainWindow.axaml.cs:544 | Missing | no toast |
| H8 | Title row: Close, More Actions, Auto-hide, Search and the source icons keep their width from the right, the title takes the rest with an ellipsis, and a control that does not fit whole is hidden | `HeaderPanel`, MainWindow.axaml:378-418 | Partly | `renderListHeader` listHeader.ts: the icons keep their width at the right; nothing is hidden for want of room. The page has no "Switchboard" title, which the tab or app title already shows (operator's decision). Close and Auto-hide are Dock only (D3, D6) |
| H7 | Page title counts Blocked on you, "(2) Switchboard" | none | Web only | `pageTitle` model.ts:107 |

## Connection

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| N1 | "Connecting to Switchboard…" until the first view | `Show` ViewModels.cs:503-510 | Partly | shown in the conversation pane, not over the list (main.ts:689) |
| N2 | Without the hub the last rows stay, dimmed to half and disabled; a row menu closes | MainWindow.axaml:210-212, 464; MainWindow.axaml.cs:128 | Partly | the last rows stay but are not dimmed; the page reconnects and reloads by itself (`reconnector` main.ts:1610) and shows an offline page when the hub is down at load |
| N3 | "Switchboard is not running…" with Start hub | MainWindow.axaml:447-449, `OnStartHubClicked` MainWindow.axaml.cs:2141 | Differs | the hub serves the page (decision 20), so a page cannot start it |
| N4 | An expired sign-in says how to get a new link | none | Web only | main.ts:671 |

## Keyboard, focus and tooltips

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| K1 | Rows, group and band headings and link pills take the focus, shown as a focus-blue ring | MainWindow.axaml:344-356 | Partly | rows and group headings are buttons with a 1 px outline (page.css:13); pills do not take the focus |
| K2 | Up and Down move the focus along rows and headings; a row reached by keyboard is selected and scrolled into view | `ListKey`, `MoveFocus`, `OnRowGotFocus` MainWindow.axaml.cs:1023-1107 | Missing | Tab moves between rows; focusing does not select |
| K3 | Enter on a row runs its click; Enter or Space on a heading toggles it | `ListKey` MainWindow.axaml.cs:1050-1078 | Present | native button keys |
| K4 | Menu key or Shift+F10 opens a row's menu | MainWindow.axaml.cs:1057 | Missing | |
| K5 | F8 and Shift+F8 select the next or previous operator's-turn row in Blocked on you and Ready for review, open its group, clear a hiding search and run its click | `SelectNextTurn` ViewModels.cs:686, `NextTurn` MainWindow.axaml.cs:1110 | Missing | |
| K6 | Tab from the selected row reaches its buttons | MainWindow.axaml:129-131 | Missing | follows R22 |
| K7 | A view that moves the focused row keeps the focus on it, or on its closed group's heading | `RestoreFocus` MainWindow.axaml.cs:291 | Partly | `morph` keeps a row's node when it stays in place |
| K8 | Every mark, pill, time, comment, priority and detail has its meaning in a tooltip | MainWindow.axaml:502-569 | Present | `title` attributes in `listRow` render.ts:225-258 |
| K10 | Header icon buttons have accessible names; marks and the priority dot have an image role and label | MainWindow.axaml:392-416 | Present | render.ts:230, 239, 241 |

## Dock only

Window management with no counterpart in a browser page. These rows are outside the parity rule; a change to one updates its row only.

| # | Behaviour | Dock evidence |
|---|---|---|
| D1 | Docks at a monitor's left or right edge, as an app bar on Windows or an X11 dock window on Linux, and moves there by dragging the title | `Dock`, `DockAtPointer` MainWindow.axaml.cs:387, 819 |
| D2 | The inner-edge grip sets the width, 200 to 800 | `OnGripMoved` MainWindow.axaml.cs:2193 |
| D3 | Auto-hide pin, and the hidden dock's sliver of row stripes | `OnAutoHideClicked`, `SliverBars` MainWindow.axaml.cs:766, 717 |
| D4 | Stays above windows except a full-screen one on its monitor | `UpdateTopmost` MainWindow.axaml.cs:600 |
| D6 | Close the dock | `OnCloseClicked` MainWindow.axaml.cs:1272 |
| D7 | Held sessions, Ticket volume report and Settings open in windows of their own | `OpenHeld`, `OpenVolume`, `OpenSettings` MainWindow.axaml.cs:1918, 2105, 2063 |
| D8 | Tooltips and menus open at the pointer or button, away from the dock's edge and kept on its monitor | `PlaceTip`, `MenuPlacement` MainWindow.axaml.cs:1397, 1409 |
