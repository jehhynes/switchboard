import { providerMark } from '@switchboard/conversation/providerIcons';
import { renderMicButton, renderVoiceControls } from '@switchboard/conversation/voiceControls';
import { fullTime, metaLine, stamped, stampTime, toneMark, voiceMark } from '@switchboard/conversation/messageMeta';
import { hasUnspokenText, spokenBody } from '@switchboard/conversation/spokenBubble';
import { artifactIcon, awaitingReply, selectedEntry, selectedRow, stateIcon, timeline } from './model.js';
import type { PageState } from './model.js';
import { copyButton, escape, renderInline, renderMarkdown } from './markdown.js';
import { answers, answersIn, answerText, cardOutcome, complete, parseQuestions, questionSegments } from '@switchboard/conversation/questions';
import type { Question, QuestionChoice } from '@switchboard/conversation/questions';
import type { ArtifactView, MessageView, NativeRequest, PageAction, PageGroup, PageRow, ReplyView, ScreenPrompt, StatusView, VoiceView } from './types.js';
import type { SnoozeChoice } from '@switchboard/core/snooze';
import { MARK_ICONS, MARK_TONES, SPINNING_MARKS } from '@switchboard/core/group';

export type Tab = 'conversation' | 'status' | 'artifacts' | 'console';
export const TABS: Array<{ tab: Tab; label: string }> = [
  { tab: 'conversation', label: 'Conversation' },
  { tab: 'status', label: 'Status' },
  { tab: 'artifacts', label: 'Artifacts' },
  { tab: 'console', label: 'Console' },
];

/** What the column right of the conversation shows on a wide screen. */
export type SideTab = 'status' | 'artifacts' | 'console';
export const SIDE_TABS: readonly SideTab[] = ['status', 'artifacts', 'console'];

/**
 * Why the Console tab shows no console for the session (architecture.md § Web page), or null when the terminal holder may hold it: a Codex
 * session runs in Codex's app-server, and a session the page cannot talk to runs outside the holder.
 */
export function consoleNote(session: PageState['session']): string | null {
  if (session === null) {
    return 'No session has started yet.';
  }

  if (session.provider === 'codex') {
    return "This Codex session runs in Codex's app-server, not in Switchboard's terminal holder, so it has no console here. Open it in a terminal from VS Code or the dock.";
  }

  return session.conversation === 'none' ? "This session does not run in Switchboard's terminal holder, so it has no console here." : null;
}

/** A question card's choices and the answer on its way, kept by the page until the answer shows in the conversation. */
export interface CardDraft {
  choices: Map<number, QuestionChoice>;
  sent: string | null;
  /** The message the answer became, once the hub took it. */
  sentId?: string | null;
  sending: boolean;
  error: string | null;
}

/** What the page keeps beside the hub's state: the tab shown, open folds, the open dropdown, the cards and the open artifact. */
export interface View {
  tab: Tab;
  open: Set<string>;
  picker: boolean;
  cards: Map<string, CardDraft>;
  artifact: string | null;
  /** What the operator picked or typed for a Codex request's questions, by `<request ID>:<question ID>`. */
  requestValues: Map<string, string>;
  /** The header's persona menu while open: the roster, null while it loads, or why it could not. */
  personas: { items: Array<{ id: string; name: string }> | null; error: string | null } | null;
  /** The list's collapsed groups, by key. */
  collapsed: Set<string>;
  /** Whether a narrow screen shows the list rather than the conversation: after Back, or before a work item is opened. */
  list: boolean;
  /** Whether the header's actions menu is open, and in it the Open link submenu. */
  actions: boolean;
  linkMenu: boolean;
  /** The sheet over the page that asks before an action, picks a snooze, or shows a draft to copy by hand. */
  sheet: Sheet | null;
  /** A row action is running, so its controls wait. */
  acting: boolean;
  /** What the Status and Artifacts column shows on a wide screen. */
  side: SideTab;
  /** The conversation's text size, a share of the theme's, and whether its menu is open. */
  textScale: number;
  textMenu: boolean;
  /** Whether each message's line shows its time and its optional marks (dictated, tone), kept in local storage. */
  details: boolean;
  /** New conversation…'s provider menu under the dropdown: the providers, null while they load, or why not. */
  providers: { items: Array<{ provider: string; name: string; default: boolean }> | null; error: string | null } | null;
  /** The prompt the session waits on in its terminal, as last read, for the session it was read for; a key being sent waits. */
  prompt: { sessionId: string; prompt: ScreenPrompt | null; sending: boolean } | null;
}

/** A sheet: Delete's or Stop's question, Snooze…'s choices, a control's text (and choice) as the dock's input dialog asks for it, or a drafted text the clipboard refused. */
export type Sheet =
  | { kind: 'input'; workItemId: number; label: string; input: NonNullable<PageAction['input']>; text: string; picked: string }
  | { kind: 'confirm'; workItemId: number; action: PageAction }
  | { kind: 'snooze'; workItemId: number; label: string; title: string; choices: SnoozeChoice[]; picked: string; date: string; comment: string }
  | { kind: 'text'; title: string; text: string };

export const newView = (): View => ({ tab: 'conversation', open: new Set(), picker: false, cards: new Map(), artifact: null, requestValues: new Map(), personas: null, collapsed: new Set(COLLAPSED_GROUPS), list: false, actions: false, linkMenu: false, sheet: null, acting: false, prompt: null, providers: null, side: 'status', textScale: 1, textMenu: false, details: false });

/** The most links the menu lists by themselves; more go in its Open link submenu, as the dock's `MenuLinks`. */
const MENU_LINKS = 2;
/** The longest menu label for a link, as the dock's `LinkLabelMax`; a longer one is cut with an ellipsis and shown whole in its tooltip. */
export const LINK_LABEL_MAX = 48;

/** A link's menu label, cut to `LINK_LABEL_MAX` with an ellipsis. */
function clipLabel(label: string): string {
  return label.length > LINK_LABEL_MAX ? `${label.slice(0, LINK_LABEL_MAX - 1).trimEnd()}…` : label;
}

/**
 * The header's row actions (architecture.md § Web page): the dock's main control as a button, then every control in a menu under an
 * ellipsis, grouped as the dock's row menu is: the main control, the work controls, the state controls, Add comment…, the order controls, what the row opens
 * (Copy, Open in VS Code, Open changes and Open report, Open ticket and its links, more than two of them in an Open link submenu), then the controls that ask first; empty when the row offers
 * none.
 */
export function renderActions(row: PageRow | null, view: View): string {
  const actions = row?.actions ?? [];
  const pastes = row?.pastes ?? [];
  const commands = row?.opens ?? [];

  if (row === null || (actions.length === 0 && pastes.length === 0 && commands.length === 0 && row.url === '' && row.links.length === 0)) {
    return '';
  }

  const disabled = view.acting ? ' disabled' : '';
  const item = (attrs: string, icon: string | null, label: string, after = '', classes = ''): string =>
    `<li role="none"><button type="button" class="menu-row${classes === '' ? '' : ` ${classes}`}" role="menuitem" ${attrs}${disabled}><span class="menu-gutter" aria-hidden="true">${icon === null ? '' : `<span class="codicon codicon-${icon}"></span>`}</span><span class="title">${escape(label)}</span>${after}</button></li>`;
  const act = (action: PageAction): string => item(`data-action="row-action" data-label="${escape(action.label)}"`, action.icon, action.label);
  const grouped = (group: PageAction['group']): string[] => actions.filter((one) => one.group === group).map(act);
  // A link's label can be free text a session reported, so a long one is cut, whole in its tooltip, as in the dock's menu.
  const link = (which: string, label: string, icon: string | null, classes = ''): string =>
    item(`data-action="open-link" data-work-item="${row.workItemId}" data-link="${which}"${label.length > LINK_LABEL_MAX ? ` title="${escape(label)}"` : ''}`, icon, clipLabel(label), '', classes);
  const submenu =
    item(`data-action="link-menu" aria-haspopup="true" aria-expanded="${view.linkMenu}"`, 'link-external', 'Open link', `<span class="codicon codicon-chevron-${view.linkMenu ? 'down' : 'right'}" aria-hidden="true"></span>`) +
    (view.linkMenu ? row.links.map((one, index) => link(String(index), one.label, null, 'submenu-row')).join('') : '');
  const opens = [
    ...pastes.map((label) => item(`data-action="row-paste" data-label="${escape(label)}"`, 'copy', `Copy ${label}`)),
    ...commands.map((one) => item(`data-action="row-command" data-label="${escape(one.label)}"`, one.icon, one.label)),
    ...(row.url === '' ? [] : [link('ticket', 'Open ticket', 'link-external')]),
    ...(row.links.length > MENU_LINKS ? [submenu] : row.links.map((one, index) => link(String(index), `Open ${one.label}`, 'link-external'))),
  ];
  const groups = [grouped('main'), grouped('work'), grouped('state'), grouped('notes'), grouped('order'), opens, grouped('asking')].filter((group) => group.length > 0);
  const rows = groups.map((group) => group.join('')).join('<li class="menu-separator" role="separator"></li>');
  const main = actions.find((one) => one.group === 'main');
  const mainButton = main === undefined ? '' : `<button type="button" class="row-main" data-action="row-action" data-label="${escape(main.label)}"${disabled}><span class="codicon codicon-${escape(main.icon)}" aria-hidden="true"></span><span>${escape(main.label)}</span></button>`;
  const menu = view.actions ? `<ul class="glass menu actions-menu align-right" role="menu" aria-label="Actions">${rows}</ul>` : '';

  return `${mainButton}<div class="menu-anchor actions-anchor"><button type="button" class="actions" data-action="actions" aria-haspopup="menu" aria-expanded="${view.actions}" title="Actions" aria-label="Actions"><span class="codicon codicon-ellipsis" aria-hidden="true"></span></button>${menu}</div>`;
}

/**
 * The note above the composer while the session has ended, with Resume, as the Conversation view's; a session the page cannot talk to at all
 * (`none`) gets only its reason.
 */
export function renderEndedNote(session: PageState['session'], resuming: boolean): string {
  if (session?.state !== 'ended') {
    return '';
  }

  const resumable = session.conversation !== 'none';
  const text = resumable ? 'The session has ended. Resume continues it.' : (session.reason ?? 'The session has ended.');
  const button = resumable ? `<button type="button" class="session-resume" data-action="resume"${resuming ? ' disabled' : ''}>${resuming ? 'Resuming…' : 'Resume'}</button>` : '';

  return `<div class="session-note" role="status"><span class="codicon codicon-stop-circle state-icon tone-muted" aria-hidden="true"></span><span class="session-note-text">${escape(text)}</span>${button}</div>`;
}

/** The first day a snooze date can wake on: the day of the earliest timed choice, as `yyyy-mm-dd`; null with none. */
export function firstSnoozeDay(choices: readonly SnoozeChoice[]): string | null {
  const times = choices.flatMap((choice) => (choice.until === null ? [] : [choice.until]));

  if (times.length === 0) {
    return null;
  }

  const day = new Date(Math.min(...times));

  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/** A snooze date's wake time: that day at the time of day the timed choices wake at, which is when a day starts (PRD R49). */
export function snoozeDateUntil(date: string, choices: readonly SnoozeChoice[]): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timed = choices.find((choice) => choice.until !== null);

  if (match === null || timed === undefined) {
    return null;
  }

  const wake = new Date(timed.until!);

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), wake.getHours(), wake.getMinutes()).getTime();
}

/** Whether an input sheet can go ahead: with a text, or with a choice changed from the one chosen at first, as the dock's dialog. */
export function inputReady(sheet: Extract<Sheet, { kind: 'input' }>): boolean {
  return sheet.text.trim() !== '' || (sheet.input.choice !== null && sheet.picked !== sheet.input.choice.value);
}

/** The sheet over the page, or empty: a question with Cancel and its action, Snooze…'s choices, date and comment, or a text to copy. */
export function renderSheet(sheet: Sheet | null, acting: boolean): string {
  if (sheet === null) {
    return '';
  }

  const busy = acting ? ' disabled' : '';
  const frame = (title: string, body: string, buttons: string): string =>
    `<div class="sheet-backdrop" data-action="sheet-cancel"><div class="sheet glass" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><h2 id="sheet-title" class="sheet-title">${escape(title)}</h2>${body}<div class="sheet-buttons">${buttons}</div></div></div>`;
  const cancel = '<button type="button" class="sheet-button secondary" data-action="sheet-cancel">Cancel</button>';

  if (sheet.kind === 'confirm') {
    return frame(sheet.action.confirm?.question ?? sheet.action.label, `<p class="sheet-detail">${escape(sheet.action.confirm?.detail ?? '')}</p>`, `${cancel}<button type="button" class="sheet-button primary" data-action="sheet-go"${busy}>${escape(sheet.action.confirm?.action ?? sheet.action.label)}</button>`);
  }

  if (sheet.kind === 'input') {
    const { input } = sheet;
    const choice =
      input.choice === null
        ? ''
        : `<label class="sheet-field"><span class="sheet-label">${escape(input.choice.label)}</span><select class="sheet-select">${input.choice.values.map((value) => `<option value="${escape(value)}"${value === sheet.picked ? ' selected' : ''}>${escape(value)}</option>`).join('')}</select></label>`;
    const box = `<textarea class="sheet-input${input.text === null ? '' : ' tall'}" aria-label="${escape(input.question)}">${escape(sheet.text)}</textarea>`;
    const note = `<p class="sheet-note">Ctrl+Enter to ${escape(input.action.toLowerCase().replace(/…$/, ''))}.</p>`;
    const go = `<button type="button" class="sheet-button primary" data-action="sheet-go"${acting || !inputReady(sheet) ? ' disabled' : ''}>${escape(input.action)}</button>`;

    return frame(input.question, `<p class="sheet-detail">${escape(input.detail)}</p>${choice}${box}${note}`, `${cancel}${go}`);
  }

  if (sheet.kind === 'text') {
    return frame(sheet.title, `<p class="sheet-detail">The browser did not allow the clipboard. Select the text and copy it.</p><textarea class="sheet-text" readonly>${escape(sheet.text)}</textarea>`, '<button type="button" class="sheet-button primary" data-action="sheet-cancel">Close</button>');
  }

  const first = firstSnoozeDay(sheet.choices);
  const radios = sheet.choices
    .map((choice, index) => `<label class="sheet-choice"><input type="radio" name="snooze" value="${index}"${sheet.picked === String(index) ? ' checked' : ''}><span>${escape(choice.description === '' ? choice.label : `${choice.label} · ${choice.description}`)}</span></label>`)
    .join('');
  const onDate = `<label class="sheet-choice"><input type="radio" name="snooze" value="date"${first === null ? ' disabled' : ''}${sheet.picked === 'date' ? ' checked' : ''}><span>On</span><input type="date" class="snooze-date"${first === null ? ' disabled' : ` min="${first}"`} value="${escape(sheet.date)}" aria-label="Wake date"></label>`;
  const body = `<fieldset class="sheet-field"><legend>Wake it</legend>${radios}${onDate}</fieldset><label class="sheet-field"><span class="sheet-label">Comment</span><textarea class="snooze-comment" rows="3" placeholder="Comment (optional)">${escape(sheet.comment)}</textarea></label>`;

  return frame(`Snooze ${sheet.title}`, body, `${cancel}<button type="button" class="sheet-button primary" data-action="sheet-go"${busy}>Snooze</button>`);
}

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const DAY_WITH_YEAR = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** A day as its divider names it: "Today", "Yesterday", the weekday and date this year, or the full date with the year. */
export function dayLabel(at: number, now: number): string {
  const midnight = (time: number): number => new Date(new Date(time).getFullYear(), new Date(time).getMonth(), new Date(time).getDate()).getTime();
  // Rounded, since a day with a daylight saving change is 23 or 25 hours long.
  const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);

  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : (new Date(at).getFullYear() === new Date(now).getFullYear() ? DAY : DAY_WITH_YEAR).format(at);
}

/** A codicon with its words as tooltip and name; a session state's, with its tone, is drawn small and muted unless it needs attention. */
function codicon({ icon, text, tone }: { icon: string; text: string; tone?: string }): string {
  const [name, modifier] = icon.split('~');

  return `<span class="codicon codicon-${name}${modifier === undefined ? '' : ` codicon-modifier-${modifier}`}${tone === undefined ? '' : ` state-icon tone-${tone}`}" title="${escape(text)}" role="img" aria-label="${escape(text)}"></span>`;
}

/** How long ago, in the largest whole unit: "just now", "4 min ago", "2 h ago", "3 d ago". */
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);

  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
}

/** The groups the list shows collapsed until the operator opens them, as the dock does. */
export const COLLAPSED_GROUPS: readonly string[] = ['done'];

/** The codicon Returned shows, as the dock's pill does. */
const RETURNED_GLYPH = '\u{eae2}';

/**
 * A pill on line 2: its codicon glyph, if any, then its text, the full name in its tooltip. `icon` names a codicon shown only when the pill
 * shrinks to its icon (`fitPills`), for a pill that has no glyph whole: the ticket key's source, GitHub's mark or a tag. `attrs` makes a pill with
 * a link open it.
 */
function pill(classes: string, glyph: string | null, text: string, title: string, icon?: string, attrs = ''): string {
  const shown = glyph === null ? (icon === undefined ? '' : `<span class="codicon codicon-${icon} pill-icon" aria-hidden="true"></span>`) : `<span class="codicon" aria-hidden="true">${escape(glyph)}</span>`;

  return `<span class="pill ${classes}" title="${escape(title)}"${attrs}>${shown}<span class="pill-text">${escape(text)}</span></span>`;
}

/**
 * A row of the list, drawn as the dock's three lines from the hub's dock row: line 1 the priority dot, the title and the time; line 2 the
 * comment icon, the playbook with its namespace muted (or a hosted conversation's host), the ticket key as a pill in its source's colour, the
 * link pills and Returned, which shrink to their icons when the line is too narrow (`fitPills`, applied by the page); line 3 the mark and the details, a muted " · " between them, in their tones. The dock's stripe is on its left edge.
 */
function listRow(row: PageRow, selected: boolean): string {
  const kind = row.mark?.kind;
  const mark =
    row.mark === null || kind === undefined
      ? ''
      : `<span class="codicon codicon-${MARK_ICONS[kind]} mark state-icon tone-${MARK_TONES[kind]}${SPINNING_MARKS.has(kind) ? ' codicon-modifier-spin' : ''}${kind === 'failed' ? ' failed' : ''}" role="img" title="${escape(row.mark.title)}" aria-label="${escape(row.mark.title)}"></span>`;
  const colon = row.playbook.indexOf(':');
  const playbook =
    row.host !== null
      ? `<span class="playbook host" title="${escape(`Hosted by ${row.host}`)}">${escape(row.host)}</span>`
      : row.playbook === ''
        ? ''
        : `<span class="playbook" title="${escape(row.playbook)}">${colon === -1 ? '' : `<span class="namespace">${escape(row.playbook.slice(0, colon + 1))}</span>`}${escape(row.playbook.slice(colon + 1))}</span>`;
  const classes = ['row', ...(row.stripe === null ? [] : [`stripe-${row.stripe}`]), ...(row.dim ? ['dim'] : []), ...(selected ? ['selected'] : [])].join(' ');
  const priority = row.priority === null ? '' : `<span class="priority" role="img" title="${escape(row.priority)}" aria-label="${escape(row.priority)}"></span>`;
  const time = row.time === null ? '' : `<span class="row-time" title="${escape(row.time.title)}">${escape(row.time.text)}</span>`;
  const comment = row.comment === null ? '' : `<span class="codicon comment" role="img" title="${escape(row.comment.title)}" aria-label="Comments">${escape(row.comment.glyph)}</span>`;
  // A pill with a link opens it instead of the row's click, as the dock's `OnPillTapped` (PRD R52).
  const opens = (which: string): string => ` data-action="open-link" data-work-item="${row.workItemId}" data-link="${which}"`;
  const ticket = pill(`ticket source-${escape(row.sourceKind)}`, null, row.ticket, row.url === '' ? row.ticket : `${row.ticket}\n${row.url}`, row.sourceKind === 'github' ? 'github' : 'tag', row.url === '' ? '' : opens('ticket'));
  const links = row.links
    .map((link, index) => pill(`link ${link.kind}${link.mentioned ? ' mentioned' : ''}`, link.glyph, link.badge, `${link.label}${link.mentioned ? ', named in the ticket' : ''}\n${link.url}`, undefined, opens(String(index))))
    .join('');
  const linkPills = links === '' ? '' : `<span class="row-links">${links}</span>`;
  const returned = row.returned > 0 ? pill('returned', RETURNED_GLYPH, String(row.returned), `Returned ${row.returned}: earlier work items with this playbook, or one it is a return of, were done for this ticket`) : '';
  const details = row.details
    .map((detail, index) => `${index > 0 ? '<span class="row-detail-separator" aria-hidden="true">·</span>' : ''}<span class="row-detail${detail.tone === null ? '' : ` ${detail.tone}`}"${detail.title === null ? '' : ` title="${escape(detail.title)}"`}>${escape(detail.text)}</span>`)
    .join('');

  return (
    `<li><button type="button" class="${classes}" data-action="select" data-work-item="${row.workItemId}" aria-current="${selected}" title="${escape(row.title)}">` +
    `<span class="row-head">${priority}<span class="row-title">${escape(row.title)}</span>${time}</span>` +
    `<span class="row-line">${comment}${playbook}${ticket}${linkPills}${returned}</span>` +
    (mark === '' && details === '' ? '' : `<span class="row-line row-details">${mark}${details}</span>`) +
    '</button></li>'
  );
}

/**
 * The page's list (architecture.md § Web page): the dock's groups in its order, each a header with its codicon, title and count that opens or
 * collapses it, then its rows; a collapsed group still shows the selected row, so the selection is never hidden. While a search `filtering` it,
 * only the groups with rows show, every one open, and the search's end says when none matched.
 */
export function renderList(groups: readonly PageGroup[], selected: number | null, collapsed: ReadonlySet<string>, filtering = false): string {
  if (groups.every((group) => group.rows.length === 0)) {
    return filtering ? '' : '<p class="empty">No work items yet. They appear here when Switchboard starts one.</p>';
  }

  const html = groups.map((group) => {
    const open = filtering || !collapsed.has(group.key);
    const rows = (open ? group.rows : group.rows.filter((row) => row.workItemId === selected)).map((row) => listRow(row, row.workItemId === selected)).join('');
    const empty = open && group.rows.length === 0 && group.empty !== null ? `<p class="group-empty">${escape(group.empty)}</p>` : '';
    const head =
      `<button type="button" class="group-head" data-action="group" data-group="${escape(group.key)}" aria-expanded="${open}">` +
      `<span class="codicon codicon-chevron-${open ? 'down' : 'right'}" aria-hidden="true"></span><span class="codicon group-icon" aria-hidden="true">${escape(group.glyph)}</span>` +
      `<span class="group-title">${escape(group.title)}</span><span class="group-count${group.rows.length === 0 ? ' zero' : ''}" aria-label="${group.rows.length} work items">${group.rows.length}</span></button>`;

    return `<section class="group" data-group="${escape(group.key)}">${head}${rows === '' ? '' : `<ul class="rows">${rows}</ul>`}${empty}</section>`;
  });

  return `<nav class="work-list" aria-label="Work items">${html.join('')}</nav>`;
}

/** A menu row's left gutter: a check mark for the chosen row, or nothing, so every row's text starts in one column. */
function gutter(checked: boolean): string {
  return `<span class="menu-gutter" aria-hidden="true">${checked ? '<span class="codicon codicon-check"></span>' : ''}</span>`;
}

/**
 * A conversation as the dropdown's button and each of its rows draw it, from this one renderer so they never differ: its session's state
 * codicon, title and provider's mark. The page shows no unread counts.
 */
export function conversationLabel(entry: PageState['scope'] extends infer S ? (S extends { conversations: Array<infer E> } ? E : never) : never, state: PageState): string {
  const selected = entry.workItemId === state.scope?.workItemId;
  const icon = selected ? stateIcon(state.session?.state, state.session?.waitingFor, state.session?.limit) : stateIcon(entry.state);

  return `${codicon(icon)}<span class="title">${escape(entry.title)}</span>${providerMark(selected ? (state.session?.provider ?? entry.provider) : entry.provider)}`;
}

/**
 * The header's view options button and its menu: the conversation's text size (smaller, the size, larger, and Reset) and Show message
 * details.
 */
function textSize(view: View): string {
  const percent = `${Math.round(view.textScale * 100)}%`;
  const menu = view.textMenu
    ? `<div class="glass menu text-size-menu align-right" role="menu" aria-label="View options"><div class="text-size-row"><button type="button" class="icon menu-row" role="menuitem" data-action="text-smaller" title="Smaller (Ctrl+-)" aria-label="Smaller text">A−</button><span class="text-size-value" aria-live="polite">${percent}</span><button type="button" class="icon menu-row" role="menuitem" data-action="text-larger" title="Larger (Ctrl+=)" aria-label="Larger text">A+</button></div><button type="button" class="menu-row" role="menuitem" data-action="text-reset"><span class="menu-gutter" aria-hidden="true"></span><span class="title">Reset text size (Ctrl+0)</span></button><div class="menu-separator" role="separator"></div><button type="button" class="menu-row" role="menuitemcheckbox" aria-checked="${view.details}" data-action="toggle-details"><span class="menu-gutter" aria-hidden="true">${view.details ? '<span class="codicon codicon-check"></span>' : ''}</span><span class="title">Show message details</span></button></div>`
    : '';

  return `<div class="menu-anchor text-size-anchor"><button type="button" class="icon text-size" data-action="text-menu" aria-haspopup="menu" aria-expanded="${view.textMenu}" title="View options: text size ${percent}" aria-label="View options"><span class="codicon codicon-settings" aria-hidden="true"></span></button>${menu}</div>`;
}

/** The header: the dropdown of the selected work item's conversations, its button drawn as its rows are, and the persona as an icon. */
export function renderHeader(state: PageState, view: View): string {
  const scope = state.scope!;
  const selected = selectedEntry(state);
  const title = selected?.title ?? scope.title;
  const options = scope.conversations
    .map((entry) => {
      const chosen = entry.workItemId === scope.workItemId;

      return `<li role="none"><button type="button" class="menu-row conversation-row" role="menuitemradio" aria-checked="${chosen}" data-action="select" data-work-item="${entry.workItemId}">${conversationLabel(entry, state)}</button></li>`;
    })
    .join('');
  const persona = state.session?.persona;
  const personaButton =
    persona == null
      ? state.session?.canPin === true
        ? `<button type="button" class="persona" data-action="persona" aria-haspopup="menu" aria-expanded="${view.personas !== null}" title="No persona. Click to choose one." aria-label="No persona. Click to choose one."><span class="codicon codicon-person" aria-hidden="true"></span></button>`
        : ''
      : `<button type="button" class="persona${persona.tonePending ? ' pending' : ''}" data-action="persona" aria-haspopup="menu" aria-expanded="${view.personas !== null}" title="${escape(`Persona: ${persona.name}${persona.pinned ? ', pinned' : ''}. Click to choose another.`)}" aria-label="${escape(`Persona: ${persona.name}${persona.pinned ? ', pinned' : ''}`)}"><span class="codicon codicon-${persona.pinned ? 'pinned' : 'person'}" aria-hidden="true"></span></button>`;
  const label = selected === null ? `${codicon(stateIcon(state.session?.state, state.session?.waitingFor, state.session?.limit))}<span class="title">${escape(title)}</span>` : conversationLabel(selected, state);
  // After a separator, New conversation… as in the Conversation view; it opens the providers under the same button when there is a choice.
  const providers = view.providers;
  const newRow = `<li class="menu-separator" role="separator"></li><li role="none"><button type="button" class="menu-row new-row" role="menuitem" data-action="new-conversation">${'<span class="menu-gutter" aria-hidden="true"><span class="codicon codicon-add"></span></span>'}<span class="title">New conversation…</span></button></li>`;
  const providerRows =
    providers === null
      ? ''
      : providers.error !== null
        ? `<li class="menu-message" role="none">${escape(providers.error)}</li>`
        : providers.items === null
          ? '<li class="menu-message" role="none">Loading…</li>'
          : providers.items.map((one) => `<li role="none"><button type="button" class="menu-row" role="menuitem" data-action="new-provider" data-provider="${escape(one.provider)}">${gutter(false)}<span class="title">${escape(one.name)}</span>${one.default ? '<span class="menu-note">Default</span>' : ''}</button></li>`).join('');
  const pickerMenu = providers !== null ? `<ul class="glass menu conversation-menu" role="menu" aria-label="Provider">${providerRows}</ul>` : view.picker ? `<ul class="glass menu conversation-menu" role="menu" aria-label="Conversations">${options}${newRow}</ul>` : '';
  const picker = `<div class="menu-anchor picker-anchor"><button type="button" class="picker" data-action="picker" aria-haspopup="menu" aria-expanded="${view.picker || providers !== null}" title="${escape(title)}">${label}<span class="codicon codicon-chevron-down" aria-hidden="true"></span></button>${pickerMenu}</div>`;

  const menu = view.personas;
  const rows =
    menu === null
      ? ''
      : menu.error !== null
        ? `<li class="menu-message" role="none">${escape(menu.error)}</li>`
        : menu.items === null
          ? '<li class="menu-message" role="none">Loading…</li>'
          : [
              ...menu.items.map((one) => `<li role="none"><button type="button" class="menu-row" role="menuitemradio" aria-checked="${persona?.id === one.id}" data-action="persona-pick" data-persona="${escape(one.id)}">${gutter(persona?.id === one.id)}<span class="title">${escape(one.name)}</span></button></li>`),
              persona?.pinned === true ? `<li class="menu-separator" role="separator"></li><li role="none"><button type="button" class="menu-row" role="menuitem" data-action="persona-pick" data-persona="">${gutter(false)}<span class="title">Clear pin</span></button></li>` : '',
            ].join('');
  const personaMenu = menu === null ? '' : `<ul class="glass menu persona-menu align-right" role="menu" aria-label="Persona">${rows}</ul>`;
  const personaPart = personaButton === '' ? '' : `<div class="menu-anchor persona-anchor">${personaButton}${personaMenu}</div>`;

  return `<header class="header"><button type="button" class="icon back-toggle" data-action="back" title="Back to work items" aria-label="Back to work items"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>${picker}${renderActions(selectedRow(state), view)}${personaPart}${textSize(view)}</header>`;
}

/**
 * The switch at the top of the Status and Artifacts column on a wide screen, drawn as the tabs are, with the same badges; the conversation keeps
 * its own pane beside it.
 */
export function renderSideSwitch(side: SideTab, state: PageState): string {
  const fresh = state.status?.unread === true;
  const button = (tab: SideTab, label: string, badge: string): string =>
    `<button class="tab${tab === side ? ' selected' : ''}" type="button" role="tab" data-side="${tab}" aria-selected="${tab === side}" tabindex="${tab === side ? 0 : -1}">${label}${badge === '' ? '' : `<span class="tab-badge">${badge}</span>`}</button>`;

  return `<nav class="tabs side-switch" role="tablist" aria-label="Status, artifacts and console">${button('status', 'Status', fresh ? 'New' : '')}${button('artifacts', 'Artifacts', '')}${button('console', 'Console', '')}</nav>`;
}

export function renderTabs(view: View, state: PageState): string {
  const fresh = state.status?.unread === true;
  // As in the VS Code view: Status has its New badge; the page shows no unread counts.
  const badges: Record<Tab, string> = { conversation: '', status: fresh ? 'New' : '', artifacts: '', console: '' };

  return `<nav class="tabs" role="tablist">${TABS.map(({ tab, label }) => `<button class="tab${tab === view.tab ? ' selected' : ''}" type="button" role="tab" data-tab="${tab}" aria-selected="${tab === view.tab}" tabindex="${tab === view.tab ? 0 : -1}">${label}${badges[tab] === '' ? '' : `<span class="tab-badge">${badges[tab]}</span>`}</button>`).join('')}</nav>`;
}

/**
 * One of our messages: its bubble over its meta line (`metaLine`, shared with the Conversation view). A failed delivery always shows; with
 * message details on, a dictated message's mark too. A message with no meta line has its time as the bubble's tooltip.
 */
function message(item: MessageView, stamped: boolean, details: boolean): string {
  const failed = item.delivery === 'uncertain' ? `<span class="delivery uncertain" title="${escape(item.error ?? '')}">uncertain</span>` : '';
  const meta = metaLine([voiceMark(item, details), failed], item.at, stamped);

  return `<li class="message${item.provisional ? ' provisional' : ''}" data-id="${escape(item.id)}"><div class="bubble"${meta === '' ? ` title="${escape(fullTime(item.at))}"` : ''}><div class="box${/^\/[\w:.-]+(\s|$)/.test(item.text) ? ' command' : ''}">${escape(item.text)}</div>${meta}</div></li>`;
}

/** The mark of a reply whose speech failed; empty otherwise, since routine speech states show nothing. */
function spokenMark(item: ReplyView): string {
  return item.spoken.state === 'failed'
    ? '<span class="spoken failed" title="Speaking this reply failed; see the voice log."><span class="codicon codicon-mute" aria-hidden="true"></span><span>Not spoken</span></span>'
    : '';
}

function reply(item: ReplyView, earlier: ReplyView | null, view: View, stamped: boolean, card: string, expandReplies: boolean): string {
  if (item.kind === 'note') {
    return `<li class="note" data-id="${escape(item.id)}">${escape(item.opening)}</li>`;
  }

  // Focused mode, as in the Conversation view: a reply with a [speak] passage shows the passage first and the whole reply behind Show more. The
  // passage is a bubble on the left, in its place when the whole reply shows; after the operator spoke over it, the part not heard is dimmed.
  const passage = item.kind === 'reply' && item.speak !== null && item.speak.trim() !== '' ? item.speak : null;
  const folded = passage !== null && hasUnspokenText(item.opening, passage);
  const expanded = !folded || expandReplies !== view.open.has(`more:${item.id}`);
  // Only the text that ends the reply can end in the card's questions, which it leaves out; questions before a passage fold into one line.
  const markdownPart = (text: string, last: boolean): string => (card === '' ? renderMarkdown(text) : withoutQuestions(text, last ? `reply:${item.id}` : `reply:${item.id}:before`, view.open, last));
  const said = item.spoken.state === 'interrupted' ? item.spoken.saidChars : null;
  const body = passage === null ? markdownPart(item.opening, true) : spokenBody(item.opening, passage, said, !expanded, { markdown: markdownPart, escape });
  const more = !folded ? '' : `<button class="show-more" type="button" data-action="more" data-reply="${escape(item.id)}" aria-expanded="${expanded}">${expanded ? 'Show less' : 'Show more'}</button>`;
  const tone = toneMark(item.tone, view.details);
  const rewritten = earlier === null ? '' : `<details class="fold" data-fold="earlier:${escape(item.id)}"${view.open.has(`earlier:${item.id}`) ? ' open' : ''}><summary>Rewritten</summary><div class="was">${renderMarkdown(earlier.opening)}</div></details>`;
  // The copy button comes first on the line under the reply, then the tone with message details on and a speech failure, and the time at the right.
  const meta = metaLine([item.provisional ? '' : copyButton('copy-reply', 'Copy response'), tone, spokenMark(item)], item.at, stamped);
  const unread = item.unread ? ` unread" data-unread="${escape(item.id)}` : '';

  return `<li class="reply ${item.kind}${unread}" data-id="${escape(item.id)}"${item.speak === null ? '' : ' data-speak="1"'}><span class="dot"${item.unread ? ' title="Unread"' : ''}></span><div class="body">${body}${more}${rewritten}</div>${meta}${card}</li>`;
}

function artifactRow(artifact: ArtifactView): string {
  return `<li class="artifact"><button class="artifact-open" type="button" data-action="artifact" data-path="${escape(artifact.path)}" title="${escape(artifact.path)}"><span class="codicon codicon-${artifactIcon(artifact.type)}" aria-hidden="true"></span><span class="artifact-title">${escape(artifact.title)}</span><span class="artifact-kind">${escape(artifact.kind)}</span></button></li>`;
}

/**
 * A reply's or a status's Markdown when its card draws its questions: questions that end it are left out; questions with text after them stay
 * in place, folded into one line, "2 questions — answer below", that opens them. `ends` is false for text a spoken passage follows, whose questions
 * all fold.
 */
export function withoutQuestions(markdown: string, key: string, open: ReadonlySet<string>, ends = true): string {
  const segments = questionSegments(markdown);

  if (segments === null) {
    return renderMarkdown(markdown);
  }

  // The last run of questions, when only blank lines follow it, ends the message as the rules ask, and the card alone shows it.
  const last = segments.reduce((found, segment, index) => (segment.questions > 0 ? index : found), -1);
  const ending = ends && segments.slice(last + 1).every((segment) => segment.text.trim() === '');

  return segments
    .map((segment, index) => {
      if (segment.questions === 0) {
        return segment.text.trim() === '' ? '' : renderMarkdown(segment.text);
      }

      if (ending && index === last) {
        return '';
      }

      const fold = `questions:${key}:${index}`;

      return `<details class="fold questions-fold" data-fold="${escape(fold)}"${open.has(fold) ? ' open' : ''}><summary>${segment.questions} question${segment.questions === 1 ? '' : 's'} — answer below</summary><div class="was">${renderMarkdown(segment.text)}</div></details>`;
    })
    .join('');
}

/** A question card: each question with its options as radio or checkbox rows, an Other field, and Submit; greyed with its picks once answered. */
export function questionCard(key: string, questions: readonly Question[], draft: CardDraft | undefined, answer: string | null, canAnswer: boolean): string {
  // A later message answers the card only when it answers its questions; one that ignores them sets it aside, Skipped, with no picks.
  const outcome = cardOutcome(answer, questions);
  const answered = outcome !== null;
  const choices = outcome === 'answered' ? answersIn(answer!, questions) : answered ? new Map<number, QuestionChoice>() : (draft?.choices ?? new Map<number, QuestionChoice>());
  const locked = answered || !canAnswer || draft?.sending === true || draft?.sent != null;
  const blocks = questions.map((question, index) => {
    const choice = choices.get(index);
    const options = question.options
      .map((option) => {
        const checked = choice?.letters.includes(option.letter) ?? false;
        const mark = question.multi
          ? `<span class="question-mark checkbox${checked ? ' checked' : ''}" aria-hidden="true">${checked ? '<span class="codicon codicon-check"></span>' : ''}</span>`
          : `<span class="question-mark radio${checked ? ' checked' : ''}" aria-hidden="true">${checked ? '<span class="radio-dot"></span>' : ''}</span>`;

        return `<button type="button" class="question-option${answered && !checked ? ' dimmed' : ''}" role="${question.multi ? 'checkbox' : 'radio'}" aria-checked="${checked}" data-action="pick" data-card="${escape(key)}" data-question="${index}" data-letter="${option.letter}"${locked ? ' disabled' : ''}>${mark}<span class="question-option-text"><span class="question-letter">${option.letter}</span> ${renderInline(option.text)}</span></button>`;
      })
      .join('');
    const other = answered || !canAnswer ? (choice?.other ? `<div class="question-answer-other">Other: ${escape(choice.other)}</div>` : '') : `<input class="question-other" type="text" data-card="${escape(key)}" data-question="${index}" placeholder="Other…" value="${escape(choice?.other ?? '')}"${locked ? ' disabled' : ''}>`;

    return `<div class="question-block"><div class="question-text">${question.number === null ? '' : `${question.number}. `}${renderInline(question.text)}</div><div class="question-options">${options}${other}</div></div>`;
  });
  const footer = answered
    ? `<span class="question-state">${outcome === 'answered' ? 'Answered' : 'Skipped: your next message did not answer these questions'}</span>`
    : !canAnswer
      ? ''
      : `${draft?.error ? `<span class="question-error">${escape(draft.error)}</span>` : ''}${draft?.sent != null ? '<span class="question-state">Sending…</span>' : ''}<button type="button" class="question-submit" data-action="answer" data-card="${escape(key)}"${locked || !complete(questions, choices) ? ' disabled' : ''}>Submit</button>`;

  return `<div class="question-card${answered ? ` ${outcome}` : ''}" data-card-key="${escape(key)}">${blocks.join('')}<div class="question-footer">${footer}</div></div>`;
}

/** The card of a reply's or a status's questions, answered by the first message after it; empty without questions. */
function cardOf(key: string, markdown: string, answer: string | null, view: View, canAnswer: boolean): string {
  const questions = parseQuestions(markdown);

  return questions.length === 0 ? '' : questionCard(key, questions, view.cards.get(key), answer, canAnswer);
}

/** The text of the first message after a reply, which answers its card. */
function answerAfter(state: PageState, replyId: string): string | null {
  const from = state.items.findIndex((item) => item.id === replyId);
  const later = from === -1 ? undefined : state.items.slice(from + 1).find((item) => item.type === 'message' && answers(item));

  return later?.type === 'message' ? later.text : null;
}

/** The Conversation tab: why the page cannot talk to the session, earlier messages, and the timeline with its spinner. */
export function renderTimeline(state: PageState, view: View, now: number = Date.now()): string {
  if (state.session === null) {
    return '<p class="empty">No session yet. Messages appear here once the work item\'s session starts.</p>';
  }

  const entries = timeline(state.items, state.artifacts);
  const canAnswer = state.connected && state.session.conversation === 'full';
  // After the newest item, so replies written mid-turn show above it.
  const shownPrompt = view.prompt !== null && view.prompt.sessionId === state.session.id ? view.prompt : null;
  const spinner = turnRow(state.session, awaitingReply(state.items, state.session), shownPrompt?.prompt != null);
  let lastDay: string | null = null;
  const rows = entries.map((entry) => {
    if (entry.type === 'artifact') {
      return artifactRow(entry.artifact);
    }

    // The first item shown, and each turn that starts on another day than the turn before it, has a divider.
    const day = new Date(entry.item.at).toDateString();
    const divider = day !== lastDay && (lastDay === null || entry.type === 'message') ? `<li class="day" role="separator">${escape(dayLabel(entry.item.at, now))}</li>` : '';

    lastDay = entry.type === 'message' || lastDay === null ? day : lastDay;

    // The first item after a day's divider shows its time; with message details on, every item does.
    const timed = entry.type === 'message' || entry.item.kind !== 'note';
    const shown = stamped(timed, view.details, divider !== '');
    const html =
      entry.type === 'message'
        ? message(entry.item, shown, view.details)
        : reply(entry.item, entry.earlier, view, shown, entry.item.kind === 'reply' ? cardOf(`reply:${entry.item.id}`, entry.item.opening, answerAfter(state, entry.item.id), view, canAnswer) : '', state.expandReplies);

    return divider + html;
  });
  const earlier = state.more ? '<button class="earlier-items" type="button" data-action="earlier">Show earlier messages</button>' : '';
  // An ended session's reason shows above the composer instead.
  const notice = state.session.reason === null || state.session.state === 'ended' ? '' : `<p class="notice">${escape(state.session.reason)}</p>`;
  const requests = state.session.requests ?? [];
  const asking =
    requests.length > 0
      ? requests.map((request) => renderRequest(request, view.requestValues)).join('')
      : shownPrompt?.prompt != null && state.session.state === 'waiting'
        ? renderPrompt(shownPrompt.prompt, state.session.waitingFor, shownPrompt.sending)
        : '';

  return `${notice}${earlier}${rows.length === 0 && spinner === '' ? '<p class="empty">No messages yet. They appear here when you or the session write one.</p>' : `<ol class="timeline" aria-label="Conversation">${rows.join('')}${spinner}</ol>`}${asking}`;
}

/**
 * The row at the end of the timeline while the session is in a turn: "Starting…" or "Thinking…" with the spinner while it works on a reply;
 * while it waits on the operator in the terminal, "Waiting for your answer", "Waiting for permission" or "Waiting in the terminal" with a still
 * icon in the warning colour, since the page has no terminal to open. A Codex request the page answers draws its own card instead.
 */
export function turnRow(session: PageState['session'], awaiting: boolean, prompted = false): string {
  if (session?.state === 'waiting' && session.waitingFor !== null && (session.requests ?? []).length === 0) {
    const label = session.waitingFor === 'question' ? 'Waiting for your answer' : session.waitingFor === 'permission' ? 'Waiting for permission' : 'Waiting in the terminal';
    const icon = session.waitingFor === 'permission' ? 'shield' : session.waitingFor === 'question' ? 'question' : 'terminal';
    const who = session.provider === 'codex' ? 'Codex' : 'Claude';

    return `<li class="working waiting" role="status"><span class="codicon codicon-${icon}" aria-hidden="true"></span><span class="working-label">${label}</span><span class="working-detail">${who} asks in its terminal; ${prompted ? 'answer it below.' : 'answer it there.'}</span></li>`;
  }

  if (!awaiting || session === null) {
    return '';
  }

  return `<li class="working"><span class="codicon codicon-loading${session.state === 'waiting' ? '' : ' codicon-modifier-spin'}" aria-hidden="true"></span><span>${session.state === 'starting' ? 'Starting' : 'Thinking'}…</span></li>`;
}

/**
 * A permission prompt or question form a Claude session waits on in its terminal, as its screen shows it (architecture.md § Web page): the
 * prompt's lines, a button per numbered option, which presses its digit, Next (→) on a question form, and Cancel (Esc). Typed answers stay in the
 * terminal.
 */
export function renderPrompt(prompt: ScreenPrompt, waitingFor: string | null, sending: boolean): string {
  const disabled = sending ? ' disabled' : '';
  const options = prompt.options
    .map((option) => `<button type="button" class="prompt-option${option.selected ? ' current' : ''}" data-action="prompt-key" data-prompt-key="${escape(option.key)}"${disabled}><span class="question-letter">${escape(option.key)}</span> ${escape(option.label)}</button>`)
    .join('');
  const next = prompt.next ? `<button type="button" class="prompt-option secondary" data-action="prompt-key" data-prompt-key="next"${disabled}>Next →</button>` : '';
  const cancel = `<button type="button" class="prompt-option secondary" data-action="prompt-key" data-prompt-key="escape"${disabled}>Cancel (Esc)</button>`;
  const title = waitingFor === 'permission' ? 'Claude asks for permission' : 'Claude asks you';

  return (
    `<div class="request question-card prompt-card" data-key="prompt" role="group" aria-label="${escape(title)}"><div class="request-title"><span class="codicon codicon-${waitingFor === 'permission' ? 'shield' : 'question'}" aria-hidden="true"></span> ${escape(title)}</div>` +
    `<pre class="prompt-screen">${escape(prompt.lines.join('\n'))}</pre><div class="prompt-options">${options}</div><div class="question-footer">${next}${cancel}<span class="prompt-note">To type an answer, use the terminal.</span></div></div>`
  );
}

const DECISIONS: Record<string, string> = { accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Decline', cancel: 'Cancel' };

/**
 * A Codex session's pending request: a permission with its decisions as buttons, or questions with their options and a field for a typed
 * answer, a secret one hidden; one the page cannot answer says to answer it in the terminal.
 */
export function renderRequest(request: NativeRequest, values: ReadonlyMap<string, string>): string {
  const head = `<div class="request-title"><span class="codicon codicon-${request.kind === 'permission' ? 'shield' : 'question'}" aria-hidden="true"></span> ${escape(request.title)}</div>`;

  if (request.kind === 'unsupported') {
    return `<div class="request" data-key="request-${escape(request.id)}">${head}<p class="empty">Answer it in the terminal.</p></div>`;
  }

  if (request.kind === 'permission') {
    return `<div class="request" data-key="request-${escape(request.id)}">${head}<div class="request-actions">${request.decisions.map((decision) => `<button type="button" class="request-button" data-action="request-decision" data-request="${escape(request.id)}" data-decision="${escape(decision)}">${escape(DECISIONS[decision] ?? decision)}</button>`).join('')}</div></div>`;
  }

  const fields = request.questions.map((question) => {
    const key = `${request.id}:${question.id}`;
    const value = values.get(key) ?? '';
    const options = question.options.map((option) => `<button type="button" class="question-option" role="radio" aria-checked="${value === option}" data-action="request-option" data-field="${escape(key)}" data-value="${escape(option)}"><span class="question-mark radio${value === option ? ' checked' : ''}" aria-hidden="true">${value === option ? '<span class="radio-dot"></span>' : ''}</span><span class="question-option-text">${escape(option)}</span></button>`).join('');

    return `<div class="question-block" data-key="${escape(key)}"><div class="question-text">${escape(question.question)}</div><div class="question-options">${options}<input class="question-other request-field" type="${question.secret === true ? 'password' : 'text'}" data-field="${escape(key)}" placeholder="${question.options.length === 0 ? 'Answer…' : 'Other…'}" value="${question.options.includes(value) ? '' : escape(value)}"></div></div>`;
  });

  return `<div class="request question-card" data-key="request-${escape(request.id)}">${head}${fields.join('')}<div class="question-footer"><button type="button" class="question-submit" data-action="request-answer" data-request="${escape(request.id)}">Submit</button></div></div>`;
}

/** The Status tab: the latest status as Markdown with its time and age and a New mark while unread, or the stage dimmed. */
export function renderStatus(state: PageState, view: View, now: number): string {
  const status: StatusView | null = state.status;

  if (status === null) {
    return '<p class="empty">No status yet. It appears here when the session reports one.</p>';
  }

  const answer = (): string | null => {
    const from = state.items.findIndex((item) => item.type === 'reply' && `st-${item.id}` === status.id);
    const later = (from === -1 ? state.items.filter((item) => item.at > status.at) : state.items.slice(from + 1)).find((item) => item.type === 'message' && answers(item));

    return later?.type === 'message' ? later.text : null;
  };
  const card = status.fallback ? '' : cardOf(`status:${status.id}`, status.markdown, answer(), view, state.connected && state.session?.conversation === 'full');
  const label = status.fallback ? 'Stage' : 'Status';

  return `<div class="status-tab${status.fallback ? ' fallback' : ''}${status.unread ? ' unread' : ''}"${status.unread ? ` data-unread="${escape(status.id)}"` : ''}><div class="status-head"><span class="codicon codicon-pulse" aria-hidden="true"></span><span class="status-label">${label}</span><span class="status-age">${stampTime(status.at)} · ${ago(status.at, now)}</span>${status.unread ? '<span class="status-new">New</span>' : ''}</div><div class="status-body body">${card === '' ? renderMarkdown(status.markdown) : withoutQuestions(status.markdown, `status:${status.id}`, view.open)}</div>${card}</div>`;
}

/** The Artifacts tab: the work item's artifacts newest first; a click opens one in the page. */
export function renderArtifacts(state: PageState, now: number): string {
  if (state.artifacts.length === 0) {
    return '<p class="empty">No artifacts yet. They appear here when the session writes one.</p>';
  }

  return `<ul class="artifact-list">${state.artifacts.map((artifact) => `<li><button class="artifact-open" type="button" data-action="artifact" data-path="${escape(artifact.path)}" title="${escape(artifact.path)}"><span class="codicon codicon-${artifactIcon(artifact.type)}" aria-hidden="true"></span><span class="artifact-title">${escape(artifact.title)}</span><span class="artifact-kind">${escape(artifact.kind)} · ${ago(artifact.updatedAt, now)}</span></button></li>`).join('')}</ul>`;
}

/** The URL of an artifact's file for the page key, which the sandboxed frame's own relative files also resolve against. */
export function artifactUrl(key: string, path: string): string {
  return `/v1/conversation/artifact/${encodeURIComponent(key)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Whether an artifact opens in the sandboxed frame: a page or an SVG, whose scripts must reach neither the page nor the network. */
export function framed(artifact: ArtifactView): boolean {
  return artifact.type === 'html' || artifact.ext.toLowerCase() === 'svg' || artifact.ext.toLowerCase() === '.svg';
}

/**
 * An open artifact (architecture.md § Web page), in place in its pane: a page or an SVG in a sandboxed frame with an opaque origin, pictures,
 * audio and video in the page, Markdown drawn by the page into `.artifact-doc`, and anything else as a download. Its head has the kind as a
 * badge and the title, as claude-collab's viewer, then Open in new window and Download. Each version's files load afresh (`?v=`).
 */
export function renderArtifactView(key: string, artifact: ArtifactView): string {
  const file = artifactUrl(key, artifact.path);
  const url = `${file}?v=${artifact.updatedAt}`;
  const away =
    artifact.type === 'markdown'
      ? '<button class="icon" type="button" data-action="artifact-window" title="Open in new window" aria-label="Open in new window"><span class="codicon codicon-link-external"></span></button>'
      : `<a class="icon" href="${escape(url)}" target="_blank" rel="noopener noreferrer" title="Open in new window" aria-label="Open in new window"><span class="codicon codicon-link-external"></span></a>`;
  const head = `<div class="artifact-head"><button class="icon" type="button" data-action="close-artifact" title="Back to the list" aria-label="Back"><span class="codicon codicon-arrow-left"></span></button><span class="artifact-badge">${escape(artifact.kind)}</span><span class="artifact-title">${escape(artifact.title)}</span>${away}<a class="icon" href="${escape(file)}" download title="Download" aria-label="Download"><span class="codicon codicon-desktop-download"></span></a></div>`;
  let body: string;

  if (framed(artifact)) {
    body = `<iframe class="artifact-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${escape(url)}" title="${escape(artifact.title)}"></iframe>`;
  } else if (artifact.type === 'image') {
    body = `<img class="media" alt="${escape(artifact.title)}" src="${escape(url)}">`;
  } else if (artifact.type === 'audio') {
    body = `<audio class="media" controls preload="metadata" src="${escape(url)}"></audio>`;
  } else if (artifact.type === 'video') {
    body = `<video class="media" controls preload="metadata" src="${escape(url)}"></video>`;
  } else if (artifact.type === 'markdown') {
    body = '<div class="artifact-doc body"><p class="empty">Loading…</p></div>';
  } else {
    body = `<p class="empty"><a href="${escape(file)}" download>Download ${escape(artifact.path.split('/').pop() ?? artifact.path)}</a></p>`;
  }

  return `<div class="artifact-view" data-artifact="${escape(artifact.path)}" data-version="${artifact.updatedAt}">${head}${body}</div>`;
}

/** Front matter dropped from an artifact's Markdown, as the VS Code preview does not show it either. */
export function markdownBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** The composer footer's voice controls and mic, drawn by the Conversation view's renderer, for the page (architecture.md § Web page). */
export function renderVoice(voice: VoiceView | null, live = true): string {
  return renderVoiceControls(voice, live, 'page');
}

export { renderMicButton };

export { answerText, complete, parseQuestions };
