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

1. Row controls the page lacks (C8): Open in Claude or Codex and Answer in terminal.
2. More Actions' dock windows (H2): Held sessions and Show hub log only say to use the dock, and New ad-hoc session and New conversation in a folder cannot choose a folder the hub does not know.
3. Held sessions (H4): the held-session note shows, but the page has no Held sessions window to open.
4. Keyboard (K2, K4, K5, O3, O4): no arrow-key walk, F8, menu key, drag or Alt+arrow reordering.
5. Web-only behaviours the dock lacks (R8, C13, G10, H7): a hosted conversation's host on line 2, Stop asking first, the selected row kept in a collapsed group.

## Groups

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| G1 | Groups in the hub's order: Ready for review, Blocked on you (only with rows), In progress, Unstarted, Snoozed (only with rows), Done | `dockView` dock.ts:287 | Present | `pageList` page.ts:310 keeps the dock's groups and order |
| G2 | Group heading: chevron, group codicon, title, row count badge; a zero count muted | MainWindow.axaml:468-476, `IsZero` ViewModels.cs:913 | Present | `renderList` render.ts:274-277, page.css:30-31 |
| G3 | Heading is a tinted bar of the focus blue, lighter on hover | MainWindow.axaml:137-144 | Present | page.css:26-27 |
| G4 | Click on a heading opens or closes the group; quick second clicks toggle each time | `OnGroupTapped` MainWindow.axaml.cs:1282 | Present | `case 'group'` main.ts:984 |
| G5 | Blocked on you, Ready for review, In progress and Unstarted start open; Done and Snoozed start closed | `OpenByDefault` ViewModels.cs:42 | Present | `COLLAPSED_GROUPS` render.ts: Done and Snoozed start collapsed until the operator's choice (G6) |
| G6 | The operator's open or closed choice per group is kept across runs (`dock.json` `groups`) | `Toggled` ViewModels.cs:622 | Present | Kept in local storage under `switchboard.groups`, `{<group>: open}`, for the groups the operator toggled (`collapsedGroups` render.ts, `keepGroup` main.ts) |
| G7 | Empty group text in italics, muted, aligned with a row's text (Ready for review, In progress, Unstarted), also when every group is empty | MainWindow.axaml:479, `GROUP_EMPTY` rows.ts:797 | Partly | render.ts:273, page.css:32; with no rows at all the page shows one message instead of the groups (G11) |
| G8 | Done's date bands (Today, Yesterday, Earlier this week, Last week, Two weeks ago), each a muted label with count and rule that opens or closes; Today and Yesterday open, the others closed each run | `BandViewModel` ViewModels.cs:740, MainWindow.axaml:485-492, `doneBand` rows.ts:475 | Present | `PageRow.band` (`pageRow` page.ts); `renderList` list.tsx draws each run of a band under its heading (`band-head`), Today and Yesterday open, the others closed until the page reloads (`OPEN_BANDS`, `view.bands`); a closed band still shows the selected row, which the dock's hides (G10, Web only) |
| G9 | Done draws only the rows in view, so hundreds of rows stay fast | MainWindow.axaml:18-24 | Missing | The page draws every row of an open band; older bands start closed (G8) |
| G10 | A collapsed group or closed Done band still shows the selected row | none: a closed group or band hides every row | Web only | `renderList` list.tsx |
| G11 | A list with no rows at all says so | none: each group shows its empty text | Web only | "No work items yet…" render.ts:267 |
| G12 | The heading of the group at the list's top stays pinned there, on an opaque bar and keeping its toggle and count, while the group's rows scroll under it, until the next group's heading pushes it up; a row scrolled into view by the keyboard or a selection lands below it | `PinGroupHeads`, `Reveal` MainWindow.axaml.cs | Present | `.group-head` `position: sticky` page.css, the gap after a group inside its section (`.group::after`), `scroll-margin-top` on rows and the pool row menu; it spans the list's full width, and `#list`'s `isolation: isolate` keeps iOS's scroll indicator over it |

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
| R3 | Line 1: the voice target's mic mark before the time | MainWindow.axaml:506, app.ts:589 | Present | `PageRow.voice` on the voice target's row (`pageList` page.ts, `voiceRow` app.ts), drawn before the time in `Row` list.tsx; the hub sends the list again when the voice target moves (`pageListChanged`) |
| R4 | Line 1: time at the end, muted, with what it counts and since when in its tooltip; Done rows show the done time | MainWindow.axaml:508, `rowTime` rows.ts:511 | Present | render.ts:240 |
| R5 | Times refresh at least every minute | hub `tick` (architecture.md § Rows) | Present | the hub sends `list` on each rebuild (conversation.ts:536) |
| R6 | Line 2: comment icon first, muted, with every comment and its time in the tooltip | MainWindow.axaml:513, `commentOf` dock.ts:503 | Present | render.ts:241 |
| R7 | Line 2: playbook with its namespace muted, full name in its tooltip, taking the width the pills leave | MainWindow.axaml:514-515 | Present | render.ts:232-237, page.css:58-59 |
| R8 | Line 2: a hosted conversation shows its host instead of the playbook | none: shows the ad hoc label | Web only | render.ts:233 |
| R9 | Line 2: ticket key pill in its source's colour (GitHub, Zoho, Forum), key and URL in its tooltip | MainWindow.axaml:517-529, `TicketTip` ViewModels.cs:1155 | Present | `Row` list.tsx; page.css `.pill.ticket`, GitHub's in the dock's `DockKeyGithub` (`--sb-github`) |
| R10 | Line 2: link pills after the key: a pull request purple with its icon and number, an issue by its key, a link by its label, a link the ticket's text names grey and last | MainWindow.axaml:530-547, `linksOf` dock.ts:452 | Present | render.ts:243-246, page.css:70-71 |
| R11 | Line 2: Returned pill in the warning colour with the return icon and count, its meaning in its tooltip | MainWindow.axaml:548-553, `ReturnedTitle` ViewModels.cs:1161 | Present | render.ts:247, page.css:72 |
| R12 | A pill with a link opens it on click or Enter instead of the row's click | `OnPillTapped` MainWindow.axaml.cs:1301, `ListKey` :1027 | Differs | The operator's decision, 2026-11-21: the page's pills are labels (`Pill` list.tsx), their name and URL in the tooltip, a click or tap on one selecting the row as the row's click does; the links open from the Browser tab and the header's and a pool row's menu (Open ticket, Open PR, Open link). The dock's pills still open their links |
| R13 | Pills shrink to their icon rather than being cut: longest first while the playbook keeps its width, the rest once the playbook is 60 px, Returned last; a pill of 56 px or less keeps its text until then | `PillLine` PillLine.cs:8-187 | Present | `fitPills` fit.ts, applied to every row once a frame after a list redraw or a change of its width (`fitLines` main.ts) |
| R14 | A compact key pill shows the source's logo (or a tag for a source without one); a compact link pill its PR, issue or link icon | MainWindow.axaml:521-526, `IconGlyph` DockView.cs:125 | Present | A compact key pill shows the dock's GitHub, Zoho or Forum logo at 12 px, or a tag (`SourceLogo` listHeader.tsx, `Row` list.tsx); a compact link pill its glyph, or the dock's `issues` or `link-external` codicon |
| R15 | Pills that do not fit even as icons are left out whole, the last first, Returned only when it alone does not fit; they show again when the line widens | PillLine.cs:162-172 | Present | `fitPills` fit.ts: the playbook gives way entirely first, then pills are left out the last first, Returned only when alone it does not fit |
| R16 | Line 3: the mark, then the details with a muted `·` between them, each in its tone, the last cut with an ellipsis; tooltips hold whole texts | MainWindow.axaml:556-574, `DetailViewModel` ViewModels.cs:1214 | Present | render.ts:248-256, page.css:73-79 |
| R17 | Line 3 shows the mark's title when the row has no details, and is absent with neither | `orMarkTitle` dock.ts:411, `HasThirdLine` ViewModels.cs:1133 | Present | render.ts:256 |
| R18 | Line 3 texts from the hub: wait reasons, rate limit (`Rate limited · resumes…`), blockers in the warning tone, wake time and snooze comment, warning and error, `From <key>`, approval summary or stage with its age, stale stage in the warning tone | `itemRow` dock.ts:386-393, `limitTexts` rows.ts:666, `wake` dock.ts:487 | Present | Same `details` through `pageList` |
| R19 | Row separator rule above each row but the first in its band | MainWindow.axaml:169-177 | Present | Each band's rows are a list of their own, so `.rows > li:first-child` has no rule (page.css) |
| R20 | Pool tickets (Unstarted, Snoozed) show as rows with Start or Triage again | `poolRow` dock.ts:415 | Differs | Listed with the dock's three lines by `pageList` page.ts (`ticketId`, no `workItemId`); a pool ticket has no conversation, so a click opens its menu under the row (Start, Triage again …), 8 px inside the row's left edge, and against its right edge or above it only where the page has no room (architecture.md § Menus), where the dock's click opens its triage focus in the browser; operator approved 2026-11-21 |
| R21 | No unread count on rows: no work item list shows unread (architecture.md § Unread) | (dropped in `a7274f7`) | Present | `PageRow` page.ts:205 carries none and `listRow` render.ts:225 draws none |
| R22 | The selected row's buttons beside lines 2 and 3: main control (Approve in the accent colour, its prompt in the tooltip), Copy, Open report; hidden on other rows and on rows with none | MainWindow.axaml:577-591, 126-134, `mainTitle` rows.ts:139 | Partly | The main control is a button in the conversation header, not on the row (`renderActions` render.ts:94-95), and under 768 px only the first row of the actions menu, as the header has no room for it (the operator's decision); Copy and Open report are in the actions menu |
| R23 | Row sizes: 3 px stripe, padding 5, 8 and 6 px, lines 18 px tall and 3 px apart in 13 px Segoe UI, the title semibold, the first row of a band without the rule's pixel; pills 18 px tall, 1 px border, 6 px padding, 14 px icons, 12 px text; the muted texts in `DockMuted` (`#9D9D9D`, `#717171` light) | MainWindow.axaml `Border.row`, `Border.pill`, `TextBlock.icon`, App.axaml | Present | page.css `.row`, `.row-head`, `.row-line`, `.pill`, `--sb-row-muted`; checked against the dock by a headless render of one fixture in dark and light at 380 and 235 px; text and pill positions can differ by under a pixel, since the dock rounds each width up to a whole pixel |

## Marks, stripes and colours

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| M1 | Mark codicon per kind from `MARK_GLYPHS`/`MARK_ICONS`, its meaning as tooltip | MainWindow.axaml:557, group.ts:143-203 | Present | render.ts:227-230 |
| M2 | Running and Triaging marks spin | `MarkSpins` ViewModels.cs:1123, MainWindow.axaml:357-369 | Present | `SPINNING_MARKS` render.ts:230 |
| M3 | Mark colour: every mark in the foreground colour and only Failed in the error colour | MainWindow.axaml (`failed` class only) | Present | `Row` list.tsx, page.css `.row-details .mark`; the conversation header's and dropdown's state icons keep `MARK_TONES` (architecture.md § Conversation view) |
| M4 | Left stripe 3 px, inset 8 px top and bottom: error (failed), warning (blocked or asking), turn in the focus blue (operator's turn in review); none on the agent's turn or snoozed | MainWindow.axaml:185-199, `stripeOf` rows.ts:720 | Present | page.css:36-39 |
| M5 | The selected row's stripe is full height | MainWindow.axaml:188-190 | Present | page.css:43 |
| M6 | Selected row in the selection colour, its texts keeping their colours | MainWindow.axaml:181-183 | Present | `.row.selected` page.css, in the dock's `DockSelected` colours (`--sb-row-selected`: `#04395E` dark, `#E4E6F1` light); the focus ring shows only on a keyboard focus (`button:focus-visible`), as the dock's; its texts keep their colours (no `list.activeSelectionForeground`) |
| M7 | Row hover background | MainWindow.axaml:178-180 | Present | page.css:40 |
| M8 | Colours from VS Code's Light Modern or Dark Modern, chosen by the dock theme setting (system, VS Code, light, dark) | `ApplyTheme` MainWindow.axaml.cs:1938 | Differs | The operator's decision: the page follows the operating system's light or dark setting live (`prefers-color-scheme` in theme.css), with no theme setting and no VS Code choice; its light error, warning and passed colours are VS Code's Light High Contrast values for contrast, darker than the dock's Light Modern ones |
| M9 | The list's scroll bar shows only while the pointer is over the list | MainWindow.axaml:69-74 | Differs | The operator's decision: the browser's own scrollbar, always shown, thin and in the theme's slider colours (page.css), since a page-drawn overlay thumb dragged and resized badly |

## Selection and click

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| S1 | A click selects the row and runs its click: the item window and session, a question's Open in Claude or Codex, a terminal, or the focus URL | `Open` MainWindow.axaml.cs:1322, `openOf` dock.ts:603 | Differs | A click selects the work item and opens its conversation in the page (`select` main.ts:837); the operator's design decision 19 (`.wip/voice-design.md` § 11). The dock's click on the item window is the actions menu's Open in VS Code, which opens or brings forward the row's window through the hub without opening its session |
| S2 | A second click on the row being switched to is ignored; a click on another row replaces it | MainWindow.axaml.cs:1331-1337 | Present | The latest work item clicked wins (`reconcile` main.ts:862) |
| S3 | A failed click says why in the status toast | `ShowFailure` MainWindow.axaml.cs:1369 | Partly | A refused select shows over the composer, or over the list with no conversation (main.ts:880-893) |
| S4 | The row of the VS Code window or session terminal that comes to the front is selected, its group opened and scrolled into view | `SelectWindow` ViewModels.cs:649, `ShowItemWindow` MainWindow.axaml.cs:968 | Differs | The page selects only on its own clicks, as decision 19 has it; the selection is kept in the URL (`#w=`, main.ts:87, 847) |
| S8 | `dock.openIn: web` opens a clicked row's work item in the installed web page, bringing its window forward on Windows, or the page at it in the browser with none open; an Alt-click opens the other of VS Code and the page | `Open`, `OnRowTapped` MainWindow.axaml.cs, `Switcher.OpenInPage` | Partly | The page's click always opens the work item in the page and its actions menu's Open in VS Code opens VS Code; it has no setting and no Alt-click. A `show` event selects the work item the dock sent (`main.ts`) |
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
| C8 | Open in Claude or Codex, Answer in terminal, Open in terminal | rows.ts:168-205, MainWindow.axaml.cs:1450-1500 | Partly | Open in terminal is in the actions menu's opens group after Copy whenever the dock's menu has it (`terminal` in `pageList` page.ts), and opens the Console tab, or the Console tab of the Status and Artifacts column on a wide screen, which shows a held Claude Code Mode session's terminal, or a Codex app-server session's Codex terminal the hub holds for it, and types into it once clicked (`drawConsole` main.ts, `console.ts`; architecture.md § Web page, § Codex runner); a terminal prompt card answers some waits; Open in Claude or Codex and Answer in terminal are not on the page |
| C9 | Open changes, History, Open report (VS Code commands) | `windowCommands` dock.ts:771 | Partly | Open changes and Open report in the actions menu: the hub leaves the dock's command for the row's window and starts VS Code on it (`row-command`, `pageCommandOf` page.ts). History, in the actions menu and a pool ticket's menu, opens the page's own History in the conversation's place, with the VS Code History tab's content (`page-history`, `history.tsx`); of its links the page opens only http and https URLs, while a session, worktree or file opens only from VS Code or the dock |
| C10 | Open ticket and an Open item per link, more than two in an Open link submenu, labels cut at 48 characters | MainWindow.axaml.cs:1502-1560 | Partly | `renderActions` render.ts, in the actions menu after Copy; the submenu opens in place under Open link rather than beside it, which works at a phone's width |
| C11 | Copy: one draft copies at once, several open a Copy submenu of labels; `Copied <label>.` in the neutral toast; an unreadable draft says why | `Copy` MainWindow.axaml.cs:1715, menu :1482-1489, `OnCopyClicked` :1762 | Partly | `copyPaste` main.ts:1447: each draft is its own item in the actions menu (render.ts:90), nothing confirms the copy, and a refused clipboard shows the text to copy |
| C12 | Delete asks first with the hub's question and detail; the focus starts on Cancel and Enter never deletes | `Act` MainWindow.axaml.cs:1630, `ConfirmDialog`, `deleteConfirm` rows.ts:218 | Partly | the sheet asks (render.ts:155-157) but does not put the focus on Cancel |
| C13 | Stop asks first | none: Stop runs at once | Web only | `pageActions` page.ts:258 |
| C14 | Snooze… dialog: the hub's choices, a date from the earliest timed choice waking at its time of day, a comment; Cancel posts nothing | `Snooze` MainWindow.axaml.cs:1610, `SnoozeDialog` | Present | `renderSheet` render.ts:163-170, `snoozeDateUntil` :131 |
| C15 | Triage again and Start on a pool row | `poolControls` rows.ts:301 | Present | In the pool row's menu with Start with guidance… and Snooze… or Unsnooze, run through `pool-action` |
| C16 | A control acts only on the hub's current view; with no hub the dock refuses it | `Act` MainWindow.axaml.cs:1662 | Present | the hub checks the row still offers it (`pageActionEvent` page.ts:275) |
| C17 | A refusal or failure shows in the toast in the warning colours | `Status` ViewModels.cs:438 | Partly | shows over the composer (`runAction` main.ts:1416) |
| C18 | The open work item's ticket and links in a Chrome window over the installed page's Browser tab, behind `web.chromePane` on Windows (PRD R113) | none: the dock opens links as new browser tabs (R74) | Web only | `reportPane` main.ts, `PaneState` pane.ts; the hub's pane helper glues the window, with or without the dock (architecture.md § Pane helper). The operator approved the pane as a page feature in R113 |

## Search

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| F1 | Search button shows or hides the search box; hiding clears the search and its range; Escape closes it | `OnSearchClicked` MainWindow.axaml.cs:2176, `SearchOpen` ViewModels.cs:403 | Present | `setOpen` listHeader.ts |
| F2 | Matches title, key, linked PRs and issues, playbook, group and branch; every word, any case | `Matches` ViewModels.cs:986, `searchText` dock.ts:313 | Present | `matches` listHeader.ts on `PageRow.search`, the dock row's `search` (`pageRow` page.ts) |
| F3 | Searches 250 ms after the last key from 3 characters; at once for a ticket or link key (`18941`, `gh 18941`, `PR #19002`, `#107`) | `Query` ViewModels.cs:193, `IsKey` :240 | Present | `typed`, `isKey` listHeader.ts |
| F4 | Groups with matches show open; groups without are hidden; bands open while filtering | `IsShown` ViewModels.cs:890, `ShowsRows` :762 | Present | `filterGroups` listHeader.ts, `renderList` list.tsx with `filtering`, which opens every band |
| F5 | Range menu: Last 2 weeks, Last month, Last 3 months, All time; older Done rows from the hub under their month | `Ranges` ViewModels.cs:36, `SearchOlder` :319 | Present | `page-search` (conversation.ts) answers the dock's `DoneSearch` rows with their month as `band`; the page adds them after Done's own rows, under their month's band heading |
| F6 | Search further back, and All time when nothing matched; "No matches for … in the …"; Clear search; Searching…; "Showing the newest N matches…"; the hub's refusal | MainWindow.axaml:608-617, ViewModels.cs:379-389 | Present | `renderSearchEnd` listHeader.ts |
| F7 | A newer search or range drops an older answer | ViewModels.cs:334 | Present | `searchRun` in `listHeader` listHeader.ts |

## Header, notes and messages

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| H1 | Source icons per kind, grey when off; click toggles one source, or opens a check menu for several | `OnSourceClicked` MainWindow.axaml.cs:1787 | Present | `sourceButton` listHeader.ts, `page-source` in conversation.ts; a kind without a logo shows the `tag` codicon where the dock's button is blank; a refusal shows under the header (no toast, H6) |
| H2 | More Actions: New ad-hoc session…, New conversation in a folder…, Held sessions, Refresh sources, Show hub log, Open Settings | `HeaderMenu` MainWindow.axaml.cs:1903 | Partly | `renderMoreMenu` listHeader.ts has the dock's items and groups, and Reload after Refresh sources, page only: an installed app on a phone has no browser reload (the operator's request). New ad-hoc session…, New conversation in a folder… and Refresh sources work, but offer only the folders the hub knows (repo roots and conversation hosts), with no Choose a folder…; Held sessions and Show hub log say to use the dock, and Open Settings opens the page's Settings (S1). Under 768 px the source icons are check rows at the top of the menu. Pair a device… (R115), before Open Settings, is page only: the operator asked for it in the web app, the dock only if simple. On a paired device the page leaves out Pair a device… and Open Settings, with their separator (R115: the operator's decision that Settings stay on the computer), and ends with Voice on this phone, page only, since the dock has no microphone of a phone to offer (R119) |
| H3 | Settings, playbook, hook, source and voice errors and setup notes above the groups, in the warning colour | MainWindow.axaml:450-456, `snapshotErrors` rows.ts:844 | Present | `HeaderNotes` listHeader.tsx under the list header, from the header's `notes` (`pageHeader` page.ts, with the voice's note added as the dock's view adds it, `withVoiceNote` app.ts) |
| H4 | "N held sessions without a work item" above the groups, opening the held sessions window | MainWindow.axaml:458-462 | Partly | `HeaderNotes` listHeader.tsx shows the header's `heldNote`; the page has no Held sessions window, so its click opens the sheet More Actions' Held sessions opens, which says to use the dock (H2) |
| H9 | Terminal holder from an older build: the notice above the groups with Restart and resume, which asks first naming the sessions it interrupts, "Restarting…" while it runs, and the result until dismissed | `HolderNotice`, `HolderResult` MainWindow.axaml; `OnHolderRestartClicked` MainWindow.axaml.cs; `holderNotices` dock.ts | Differs | `holderNotices` and the `holder` sheet listHeader.ts: the notice and result show under the list header, and Restart and resume asks in a sheet and posts `page-holder-restart`; a paired device's page shows the notice without Restart and resume, and the hub refuses its `page-holder-restart` (R115, the operator's decision) |
| H5 | Needs-you message in the toast when a work item starts needing the operator; a click on it runs that row's click | `ShowNeedsYou` MainWindow.axaml.cs:267 | Present | One surface announces each event (`alerts.surface`, the operator's plan decision 5 in `plan-web-primary.md`): the hub sends `needs {items, sound}` with the dock's message to the page that raises alerts (`pageNeeds` conversation.ts) and then nothing to the dock, or the dock's `needs` and nothing to any page. That page shows the last message under the list header (`NeedsYou` listHeader.tsx), a click on it running the page's row click, selecting its work item (S1); it also shows a browser notification per work item whose click selects it, and plays the needs-you chime when the voice does not (`notifyNeeds`, `playChime` alerts.ts) |
| H6 | The toast hides after 10 seconds shown with the pointer off it; Dismiss clears it | `CheckStatus` MainWindow.axaml.cs:544 | Partly | The needs-you message hides after 10 seconds shown on a visible page with the pointer off it, and Dismiss clears it (`NEEDS_SHOWN_MS` listHeader.tsx); refusals show where their action was taken instead (C17) |
| H8 | Title row: Close, More Actions, Auto-hide, Search and the source icons keep their width from the right, the title takes the rest with an ellipsis, and a control that does not fit whole is hidden | `HeaderPanel`, MainWindow.axaml:378-418 | Partly | `renderListHeader` listHeader.ts: the icons keep their width at the right; nothing is hidden for want of room. From 768 px the page has no "Switchboard" title, which the tab or app title already shows; under 768 px, where the list is its own view, the app's icon and "Switchboard" start the row and take the rest with an ellipsis (operator's decisions). Close and Auto-hide are Dock only (D3, D6) |
| H7 | Page title counts Blocked on you, "(2) Switchboard" | none | Web only | `pageTitle` model.ts:107 |
| H10 | Auto-hide: hidden, a 3 px sliver at the edge shows each row's stripe at its height, cut to the list's view and left out under a pinned heading; the pointer resting on it for 0.5 s shows the list over other content; it hides at once 0.4 s after nothing keeps it open (the pointer over it, an open menu or dialog, typing in its search box), and a row's click hides it | `SliverBars`, `HideDelay`, `Collapse`, `Expand` MainWindow.axaml.cs | Partly | the drawer, `openDrawer` and `fitSliver` main.ts, `.sliver` page.css: the same sliver, 500 ms reveal, 400 ms hide checked every 100 ms and hide on choosing a work item. It hides by the page's width, from 768 px with a work item open while the list, the conversation and the Status and Artifacts column do not all fit (`fitLayout` layout.ts), with no pin, as the operator decided that the page's columns follow its width and the room they need; the header's Work items button also shows it, staying until a work item is chosen, Escape or a click outside, and it slides in over 0.15 s where the dock shows at once, as the operator asked |

## Settings

The dock's Settings window (PRD R54, [architecture.md § Settings window](architecture.md#settings-window)) and the web page's Settings ([§ Web page](architecture.md#web-page)). The dock's logic is in `apps/dock/src/Switchboard.Dock/Settings/`, its drawing in `Views/SettingsWindow.cs`; the page's in `settingsModel.ts` and `settings.tsx` in `packages/web/src/`.

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| S1 | Opened from More Actions' Open Settings; reads settings.json through the hub's config routes | `OpenSettings` MainWindow.axaml.cs, `/config/read` app.ts | Differs | `list-settings` listHeader.tsx opens `settings`; the page posts the same routes as the page commands `page-settings-read`, `page-settings-check`, `page-settings-save` and `page-voice-enroll` (app.ts, `PAGE_COMMANDS` server.ts); on this computer's page only: a paired device has no Open Settings and the hub refuses these commands from it (`LOCAL_PAGE_COMMANDS`, R115, the operator's decision) |
| S2 | Navigation in a ticket's order: General; Sources; Playbooks by namespace; Schedules; Voice settings and personas; each with its New entries | `SettingsPages.Nav` | Present | `nav` settingsModel.ts |
| S3 | A page with unsaved changes shows a dot in the navigation, and one with errors an error mark | `SettingsPages.PageDirty`, `PageHasErrors` | Present | `pageDirty`, `pageHasErrors` settingsModel.ts |
| S4 | General: Sessions, Claude sessions, Codex sessions, Triage, Dock (with Row click opens), Alerts (Needs-you alerts from), Web page (Chrome pane), Remote access (Tailscale, Allowed hosts, Allowed logins), and a collapsed Advanced section with the executable paths | `SettingsFields.GeneralFields` | Present | `generalFields` settingsModel.ts, with the dock's labels, help, defaults and choices |
| S5 | General's Dock section starts with Theme, the dock's own theme kept in `dock.json` | `SettingsWindow.DrawPage` | Dock only | the theme colours the dock; the page keeps VS Code's Dark Modern |
| S6 | A field's help in its info icon's tooltip | `SettingsWindow.Info` | Present | the info button's `title`; a tap also shows the help under the field, for a phone |
| S7 | An Advanced section starts collapsed, stays open across redraws once opened, and opens when a check places a new error in it | `SettingsWindow.DrawPage`, `Update` | Present | `SectionBlock` settings.tsx |
| S8 | The draft is checked 250 ms after the last edit and after each read; each error shows on its field, one that names no field at the top of the page | `SettingsEditor.CheckSoon`, `SettingsPages.SettingsPage` | Present | `checkSoon`, `settingsPage`, `fieldOfError` |
| S9 | The bar: Saved, Unsaved changes or Saving…, with the error count; the changed-on-disk warning; a refused or blocked save's errors; Save and Discard | `SettingsPages.Bar`, `SettingsWindow.Bar` | Present | `bar` settingsModel.ts, `renderSettings` settings.tsx |
| S10 | Save closes once the file holds the draft; Ctrl+S saves and stays open; Discard drops the draft and closes; a save waits for a due check and refuses while an error stands | `SettingsWindow.Bar`, `SettingsEditor.Save` | Present | `save` settings.tsx |
| S11 | Closing with unsaved changes asks Save, Discard or Keep editing | `SettingsWindow.OnClosing` | Present | `AskSheet` settings.tsx, from Close or Escape |
| S12 | The hub's `config` event reads the file again; a draft over a file changed on disk cannot be saved; another config folder drops the draft and says so | `SettingsEditor.Load`, `EditorState.Refresh` | Present | the hub sends every page `config` too (`configChanged` app.ts), on which `settings.reload` reads the file again (main.ts); the page also reads it when it gets the focus or becomes visible, for an event missed while its stream was down |
| S13 | The settings.json path under the title opens the file in VS Code | `SettingsWindow.DrawPage` (`openUrl`) | Partly | the page shows the path as text, since a page cannot open a file in VS Code |
| S14 | On a phone the navigation is a list that drills into each page, with Back to it | none: a desktop window | Web only | `data-drill` in settings.tsx, settings.css under 768 px |
| S15 | Sources: a page per source with Kind, the common fields, its kind's own and Advanced; a source that is off noted in the navigation; changing the kind keeping only the common keys; New <kind> source, New source (kind and name) and Remove source | `SettingsFields.SourceFields`, `SettingsEditor.Edit`, `AddSource`, `Create` | Present | `sourceFields`, `nav` settingsModel.ts; `addSource`, `create`, `button` settings.tsx |
| S16 | Playbooks: a page per playbook whose fields follow its kind, reports and agent, an entry it cannot read shown with its error and Delete, a table page per namespace, New playbook and Delete, which asks naming the open work items; an edit undone restores the entry as the file has it | `SettingsFields.PlaybookFieldsOf`, `SettingsPages.NamespacePage`, `SettingsEditor.SetPlaybook`, `Delete` | Present | `playbookFields`, `namespacePage`, `playbookEntry` settingsModel.ts; `setPlaybook`, `editCell`, `askDelete`, `Table` settings.tsx; the table scrolls sideways on a phone |
| S17 | Schedules: a page per schedule whose day and time show only for the period that uses them, a new period dropping the old day and Only by hand the time; New schedule and Remove schedule | `SettingsFields.ScheduleFields`, `SettingsEditor.Edit`, `RemoveSchedule` | Present | `scheduleFields` settingsModel.ts; `edit`, `create`, `button` settings.tsx |
| S18 | Voice settings with Playbook personas and Assign, Your voice's enrolment, a page per persona, New persona and Remove persona | `SettingsFields.VoiceFields`, `PersonaFields`, `SettingsPages.EnrollmentRow` | Present | `voiceFields`, `personaFields`, `enrollmentRow` settingsModel.ts; `removePersona`, `assignPersona`, `enroll`, `tidy` settings.tsx; enrolment posts `page-voice-enroll` |
| S19 | General's Remote access lists the paired devices (name, where from, last used, voice allowed) with Allow voice or Forbid voice on a paired device and Sign out, and Pair a device… shows a new link and code, through the hub's device routes | `SettingsWindow.DevicesBlock`, `SettingsEditor.ListDevices`, `SettingsPages.DeviceDetail` | Present | `DevicesBlock` and `devices` settings.tsx, posting `page-devices`, `page-pair`, `page-device-revoke` and `page-device-voice`; the page also draws the link as a QR code and marks its own browser, which the dock, with no QR encoder and no browser of its own, leaves out |

## Connection

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| N1 | "Connecting to Switchboard…" until the first view | `Show` ViewModels.cs:503-510 | Partly | shown in the conversation pane, not over the list (main.ts:689) |
| N2 | Without the hub the last rows stay, dimmed to half and disabled; a row menu closes | MainWindow.axaml:210-212, 464; MainWindow.axaml.cs:128 | Partly | the last rows stay but are not dimmed; the page reconnects and reloads by itself (`reconnector` main.ts:1610) and shows an offline page when the hub is down at load |
| N3 | "Switchboard is not running…" with Start hub | MainWindow.axaml:447-449, `OnStartHubClicked` MainWindow.axaml.cs:2141 | Partly | the hub serves the page (decision 20), so the offline page's Start Switchboard opens the `switchboard:` link `hub.js autostart on` registers, which runs `hub.js start` (PRD R117); with no link registered it does nothing, and the page names the command |
| N4 | An expired sign-in says how to get a new link | none | Web only | main.ts:671 |

## Keyboard, focus and tooltips

| # | Behaviour | Dock evidence | Web | Web evidence and note |
|---|---|---|---|---|
| K1 | Rows, group and band headings and link pills take the focus, shown as a focus-blue ring | MainWindow.axaml:344-356 | Partly | rows, group and band headings are buttons with a 1 px outline (page.css:13); pills do not take the focus |
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
| D3 | Auto-hide pin, and the app bar and window region that hide the dock; the page's list auto-hides by width (H10) | `OnAutoHideClicked` MainWindow.axaml.cs:766 |
| D4 | Stays above windows except a full-screen one on its monitor | `UpdateTopmost` MainWindow.axaml.cs:600 |
| D6 | Close the dock | `OnCloseClicked` MainWindow.axaml.cs:1272 |
| D7 | Held sessions and Settings open in windows of their own; the page's Settings is a dialog over the page, full screen on a phone | `OpenHeld`, `OpenSettings` MainWindow.axaml.cs:1918, 2063 |
| D8 | Tooltips and menus open at the pointer or button, away from the dock's edge and kept on its monitor | `PlaceTip`, `MenuPlacement` MainWindow.axaml.cs:1397, 1409 |
