import { activeSession, groupOf, MARK_TITLES, markOf as markKindOf } from '@switchboard/core/group';
import type { Mark as MarkKind } from '@switchboard/core/group';
import type { PoolView, Snapshot, WorkItemView } from '@switchboard/hub';
import {
  age,
  CAPS,
  clip,
  controlsOf,
  editorAction,
  GROUP_EMPTY,
  GROUP_TITLES,
  linkKind,
  linkNumber,
  mainControl,
  openAction,
  panelGroups,
  playbookText,
  poolControls,
  priorityTitle,
  queuedTime,
  rowKeyOf,
  rowTime,
  splitLinks,
  staleSince,
  stripeOf,
  ticketKey,
  ticketOpen,
  waitTexts,
  doneBand,
  snapshotErrors,
  setupNotes,
} from '@switchboard/hub/rows';
import type { Control, RowGroup } from '@switchboard/hub/rows';
import { wakeText } from '@switchboard/core/snooze';

export { groupOf };


export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function openAttribute(action: Record<string, unknown> | null, editor: Record<string, unknown> | null = null): string {
  return `${action === null ? '' : ` data-open="${escape(JSON.stringify(action))}"`}${editor === null ? '' : ` data-open-editor="${escape(JSON.stringify(editor))}"`}`;
}

/** The wake time on a snoozed row's line 3; nothing for an indefinite snooze, which the group already says. */
function wake(ticket: { snoozed: boolean; snoozedUntil: number | null }): string {
  return ticket.snoozed && ticket.snoozedUntil !== null
    ? `<span class="wake" title="Wakes ${escape(wakeText(ticket.snoozedUntil))}"><span class="codicon codicon-clockface"></span> ${escape(wakeText(ticket.snoozedUntil))}</span>`
    : '';
}

/** The last segment of a file path, with either separator. */
function fileName(path: string): string {
  return path.split(/[\\/]/).filter((segment) => segment !== '').at(-1) ?? path;
}

/**
 * A primary action: a large button with its icon and verb; a narrow panel hides the verb, which stays in the tooltip (PRD R27).
 * Approve takes the primary colour (`primary`), the rest a muted fill; `iconOnly` drops the verb.
 */
function actionButton(control: Control, primary = false, iconOnly = false, title = control.label): string {
  const label = iconOnly ? '' : `<span class="label">${escape(control.label)}</span>`;

  return `<button class="control action-button${primary ? ' primary' : ''}${iconOnly ? ' icon-only' : ''}" title="${escape(title)}" data-message="${escape(JSON.stringify(control.message))}"><span class="codicon codicon-${control.icon}"></span>${label}</button>`;
}

/** A span of reported text, cut at its cap; a cut span carries the whole text as its tooltip and `data-full`, so the hover handler leaves it. */
function clipped(className: string, text: string, max: number, suffix = ''): string {
  const { text: shown, full } = clip(text, max);
  const attributes = full === null ? '' : ` title="${escape(full)}" data-full`;

  return `<span class="${className}"${attributes}>${escape(shown)}${suffix}</span>`;
}

/** The actions column at the right of lines 2 and 3, left out when empty. */
function actionsColumn(parts: string): string {
  return parts === '' ? '' : `\n<div class="actions">${parts}</div>`;
}

/** Each control's `switchboard.row.<key>` command in the row's right-click menu. */
export const ROW_COMMANDS: Record<string, string> = {
  Start: 'start',
  Approve: 'approve',
  'Open in Claude': 'openQuestion',
  Attach: 'attach',
  Stop: 'stop',
  'Triage again': 'triageAgain',
  'Mark done': 'markDone',
  Snooze: 'snooze',
  Restore: 'restore',
  'Open Changes': 'changes',
  'Show in Source Control': 'sourceControl',
  Copy: 'copy',
  History: 'history',
};

/**
 * The row's right-click menu: VS Code shows each `webview/context` command whose context key is set here, and passes this
 * object to the command it runs. It holds each command's hub action, or the whole message of a control the extension runs itself.
 */
export function rowContext(controls: Control[]): string {
  const actions: Record<string, unknown> = {};
  const context: Record<string, unknown> = { webviewSection: 'row', preventDefaultContextMenuItems: true, actions };

  for (const control of controls) {
    const key = ROW_COMMANDS[control.label]!;

    context[`switchboard.row.${key}`] = true;
    actions[key] = control.message['type'] === 'action' ? control.message['action'] : control.message;
  }

  return ` data-vscode-context="${escape(JSON.stringify(context))}"`;
}

/** The time in queue, or a Done row's done time, with what it counts in the tooltip. */
function timeSpan(time: { text: string; title: string } | null): string {
  return time === null ? '' : `<span class="queue" title="${escape(time.title)}">${time.text}</span>`;
}

type Rating = Parameters<typeof priorityTitle>[0];

/** The priority dot, with the rating in its tooltip; nothing when not priority (PRD R27, R50). */
function priorityDot(triage: Rating): string {
  const title = priorityTitle(triage);

  return title === null ? '' : `<span class="priority" title="${escape(title)}"></span>`;
}

export interface Mark {
  icon: string;
  /** What the mark means, in words, for its tooltip. */
  title: string;
  /** `error` or `warning` colours the mark. */
  tone?: 'error' | 'warning';
}

const MARK_ICONS: Record<MarkKind, string> = {
  question: 'question',
  send: 'send',
  review: 'eye',
  blocked: 'debug-pause',
  failed: 'error',
  queued: 'clock',
  setup: 'tools',
  running: 'sync codicon-modifier-spin',
  triaging: 'loading codicon-modifier-spin',
  'done-session': 'check',
  'done-operator': 'account',
  'done-unassigned': 'sign-out',
};

function markFor(kind: MarkKind): Mark {
  return kind === 'failed' ? { icon: MARK_ICONS[kind], title: MARK_TITLES[kind], tone: 'error' } : { icon: MARK_ICONS[kind], title: MARK_TITLES[kind] };
}

const TRIAGING = markFor('triaging');

/** The row mark shows what differs between rows of the same group; a snoozed item shows its group's mark (PRD R27). Unstarted rows show the priority dot, Triaging or Queued. */
export function markOf(item: WorkItemView): Mark | 'priority' {
  const kind = markKindOf(item);

  return kind === null ? 'priority' : markFor(kind);
}

/** The status mark for line 3; Unstarted rows have none but Triaging and Queued, because their mark is the priority dot. */
function statusMark(item: WorkItemView): string {
  const mark = markOf(item);

  return mark === 'priority' ? '' : markIcon(mark);
}

function markIcon(mark: Mark): string {
  return `<span class="mark codicon codicon-${mark.icon}${mark.tone === undefined ? '' : ` ${mark.tone}`}" title="${escape(mark.title)}"></span>`;
}

/** The playbook name: the namespace and colon muted, the name in the foreground colour (PRD R27). */
function playbookLabel(name: string): string {
  const colon = name.indexOf(':');
  const namespace = colon === -1 ? '' : name.slice(0, colon + 1);

  return `<span class="playbook-name"><span class="namespace">${escape(namespace)}</span><span class="name">${escape(name.slice(colon + 1))}</span></span>`;
}

/** Marks a ticket that came back after earlier work items (PRD R51). */
function returned(count: number): string {
  return count === 0 ? '' : `<span class="returned">Returned ×${count}</span>`;
}

const LINK_ICONS = { pr: 'git-pull-request', url: 'link' } as const;

function linkBadge(link: { label: string; target: string }): string {
  const kind = linkKind(link.target);

  // A GitHub issue reads like a GitHub ticket's key, `gh <number>`, whatever label the session gave it.
  if (kind === 'issue') {
    return `<a class="key github" href="${escape(link.target)}" title="${escape(link.target)}">gh ${linkNumber(link.target)}</a>`;
  }

  // The pull request icon already says PR, so the badge shows only the number from the URL, whatever label the session gave it.
  const label = kind === 'pr' ? linkNumber(link.target)! : link.label;

  return `<a class="badge ${kind}" href="${escape(link.target)}" title="${escape(link.target)}"><span class="codicon codicon-${LINK_ICONS[kind]}"></span> ${escape(label)}</a>`;
}

/** The ticket's source and key, coloured by source, with github shortened to gh. */
function ticketLink(ticket: WorkItemView['ticket']): string {
  const label = ticketKey(ticket);
  const attributes = `class="key ${escape(ticket.source)}"`;

  return ticket.url === '' ? `<span ${attributes}>${escape(label)}</span>` : `<a ${attributes} href="${escape(ticket.url)}">${escape(label)}</a>`;
}

/** "From <key>" on a work item a session reported as a task; a click selects the work item it came from (PRD R68). */
function fromParent(item: WorkItemView): string {
  if (item.parent === null || item.parentId === null) {
    return '';
  }

  return `<button class="from" data-reveal="item:${item.parentId}" title="${escape(`Show the work item it came from: ${item.parent.title}`)}">From <span class="key ${escape(item.parent.source)}">${escape(ticketKey(item.parent))}</span></button>`;
}

/** Each reason a queued row has not started, with what ends it in the tooltip (PRD R34). */
function waits(item: WorkItemView): string {
  return waitTexts(item)
    .map(({ text, title }) => `<span class="wait" title="${escape(title)}">${escape(text)}</span>`)
    .join('');
}

/** Line 1: the title, led by the priority dot on a priority ticket, and the time in queue (PRD R27). */
function firstLine(triage: Rating, title: string, queue: string): string {
  return `<div class="line first"><span class="title">${priorityDot(triage)}${escape(title)}</span>${queue}</div>`;
}

/** Line 3, left out when empty: the status mark, the note that explains it, and the facts that lines 1 and 2 do not show. */
function thirdLine(parts: string): string {
  return parts === '' ? '' : `\n<div class="line third"><span class="meta">${parts}</span></div>`;
}

/** The stage and its age on line 3; a stale row colours the age, or shows `No stage report` when it has no stage (PRD R58). */
function stageText(item: WorkItemView, now: number): string {
  const stale = staleSince(item, now);
  const title = stale === null ? '' : escape(`No stage report for ${age(stale, now)}`);

  if (item.stage === null) {
    return stale === null ? '' : `<span class="stale" title="${title}">No stage report · ${age(stale, now)}</span>`;
  }

  const since = item.stageAt === null ? '' : stale === null ? ` · ${age(item.stageAt, now)}` : `<span class="stale" title="${title}"> · ${age(item.stageAt, now)}</span>`;

  return clipped('stage', item.stage, CAPS.stage, since);
}

/**
 * On an `awaiting-approval` row, the approval summary, capitalised, and the time since the row last became `awaiting-approval` take the stage's place. A fixed tooltip holds the
 * whole summary and the last stage, because the hover handler leaves it even when the width cuts the summary (PRD R27).
 */
function approvalText(item: WorkItemView, summary: string, now: number): string {
  const whole = summary.charAt(0).toUpperCase() + summary.slice(1);
  const { text, full } = clip(whole, CAPS.approval);
  const tooltip = item.stage === null ? full : `${whole}\nLast stage: ${item.stage}`;
  const attributes = tooltip === null ? '' : ` title="${escape(tooltip)}" data-full`;

  return `<span class="approval"${attributes}>${escape(text)}<span class="since"> · ${age(item.statusAt, now)}</span></span>`;
}

/**
 * The question the background session waits on, in place of the stage, and for a one-part question a button per option that
 * sends its label as the answer (PRD R70). A question with more parts has no buttons, because the reply answers only the first.
 */
function questionText(item: WorkItemView, question: NonNullable<WorkItemView['question']>): string {
  const nativeSessionId = activeSession(item)?.nativeSessionId ?? null;
  const options =
    question.parts === 1 && nativeSessionId !== null
      ? question.options
          .map((option) => {
            const message = { type: 'action', action: { type: 'answer', workItemId: item.id, nativeSessionId, question: question.text, answer: option.label } };

            return `<button class="control option" title="${escape(option.description || option.label)}" data-message="${escape(JSON.stringify(message))}">${escape(option.label)}</button>`;
          })
          .join('')
      : '';

  return `${clipped('question', question.text, CAPS.question)}${options}`;
}

function row(item: WorkItemView, now: number, ui: PanelUi, namespaces: Record<string, string>): string {
  const main = mainControl(item);
  const rowKey = rowKeyOf(item);
  const summary = item.status === 'awaiting-approval' ? item.approvalSummary : null;
  // A hub older than PRD R70 sends no question.
  const question = item.question ?? null;
  const stage = question !== null ? questionText(item, question) : summary === null ? stageText(item, now) : approvalText(item, summary, now);
  const notes = [item.warning, item.error].filter((note): note is string => note !== null).map((note) => clipped('note', note, CAPS.note)).join('');
  const { primary, rest } = splitLinks(item);
  const report = item.status === 'awaiting-approval' ? item.approvalReport : null;
  const reportButton = report === null ? '' : actionButton({ label: 'Report', icon: 'file', message: { type: 'openUrl', url: report } }, false, true, fileName(report));
  const copy = controlsOf(item).find((control) => control.label === 'Copy');
  const copyButton = copy === undefined ? '' : actionButton(copy, false, true, item.pastes.length === 1 ? `Copy ${item.pastes[0]!.label}` : 'Copy…');
  const stripe = stripeOf(item);

  return `<div class="item${stripe === null ? '' : ` stripe-${stripe}`}${selectedClass(rowKey, ui)}" data-item="${item.id}" data-row="${rowKey}" tabindex="0"${openAttribute(openAction(item), editorAction(item))}${rowContext(controlsOf(item))}>
${firstLine(item.triage, item.ticket.title, timeSpan(rowTime(item, now)))}
<div class="line second"><span class="meta">${playbookLabel(playbookText(item, namespaces))}${ticketLink(item.ticket)}${primary.map(linkBadge).join('')}${returned(item.returned)}</span></div>${thirdLine(
    `${statusMark(item)}${waits(item)}${wake(item.ticket)}${notes}${fromParent(item)}${stage}${rest.map(linkBadge).join('')}`,
  )}${actionsColumn(`${copyButton}${reportButton}${main === null ? '' : actionButton(main, main.label === 'Approve', false, mainTitle(item, main))}`)}
</div>`;
}

/** Approve's tooltip names the prompt it runs, so the operator can read the exact command before approving. */
function mainTitle(item: WorkItemView, control: Control): string {
  return control.label === 'Approve' && item.approvalPrompt !== null ? `Approve: runs ${item.approvalPrompt}` : control.label;
}

function errors(snapshot: Snapshot): string {
  const lines = snapshotErrors(snapshot);

  return lines.length === 0 ? '' : `<div class="errors">${lines.map((line) => `<div class="note"><span class="codicon codicon-warning"></span> ${escape(line)}</div>`).join('')}</div>`;
}

/** Says plainly what an unconfigured home is missing. */
function setup(snapshot: Snapshot): string {
  return setupNotes(snapshot)
    .map((line) => `<p class="empty"><span class="codicon codicon-info"></span> ${escape(line)}</p>`)
    .join('');
}

/**
 * A pool row in Unstarted: priority, title, time in queue; playbook, ticket, links, Returned, Start; Snooze in the right-click menu.
 * A click opens the ticket (PRD R27, R47, R48).
 */
function poolRow(entry: PoolView, now: number, ui: PanelUi, namespaces: Record<string, string>): string {
  const { ticket, triage } = entry;
  const rowKey = rowKeyOf(entry);
  const { main, controls } = poolControls(entry);
  const triaging = triage !== null && triage.endedAt === null;
  const { primary, rest } = splitLinks(entry);

  return `<div class="item pool-item${selectedClass(rowKey, ui)}" data-ticket="${ticket.id}" data-row="${rowKey}" tabindex="0"${openAttribute(ticketOpen(ticket))}${rowContext(controls)}>
${firstLine(triage, ticket.title, timeSpan(queuedTime(ticket.scopeAt === null ? null : { since: ticket.scopeAt, label: 'In scope since' }, null, now)))}
<div class="line second"><span class="meta">${playbookLabel(playbookText(entry, namespaces))}${ticketLink(ticket)}${primary.map(linkBadge).join('')}${returned(entry.returned)}</span></div>${thirdLine(
    `${triaging ? markIcon(TRIAGING) : ''}${wake(ticket)}${triage?.error != null ? clipped('note', triage.error, CAPS.note) : ''}${rest.map(linkBadge).join('')}`,
  )}${actionsColumn(main === null ? '' : actionButton(main))}
</div>`;
}

/** What the operator changed in the panel: opened or closed groups, and the selected row. */
export interface PanelUi {
  /** Groups the operator opened or closed; others take their default. */
  groups: ReadonlyMap<string, boolean>;
  selected: string | null;
}

function selectedClass(key: string, ui: PanelUi): string {
  return ui.selected === key ? ' selected' : '';
}

/** Needs you, Working and Unstarted start open; Done and Snoozed start closed. */
const OPEN_BY_DEFAULT = new Set(['needs', 'working', 'unstarted']);

const GROUP_ICONS: Record<string, string> = { needs: 'bell', working: 'play-circle', unstarted: 'inbox', done: 'pass', snoozed: 'clockface' };

function group(key: string, title: string, count: number, body: string, ui: PanelUi): string {
  const open = ui.groups.get(key) ?? OPEN_BY_DEFAULT.has(key);

  return `<details class="group" data-group="${key}"${open ? ' open' : ''}><summary><span class="codicon codicon-${GROUP_ICONS[key]}"></span><h3>${escape(title)}</h3><span class="count${count === 0 ? ' zero' : ''}">${count}</span></summary>${body}</details>`;
}

/** A collapsible date band in Done; bands start open, and the operator's choice is kept under `done:<band>`. */
function band(title: string, rows: string[], ui: PanelUi): string {
  const key = `done:${title}`;
  const open = ui.groups.get(key) ?? true;

  return `<details class="band" data-group="${key}"${open ? ' open' : ''}><summary><h4>${title}</h4><span class="count">${rows.length}</span></summary>\n${rows.join('\n')}\n</details>`;
}

/** The whole panel. */
export function renderPanel(snapshot: Snapshot, now: number, ui: PanelUi): string {
  const groups = panelGroups(snapshot);
  const { namespaces } = snapshot;
  const html = (entry: WorkItemView | PoolView) => ('status' in entry ? row(entry, now, ui, namespaces) : poolRow(entry, now, ui, namespaces));
  const doneBody = () => {
    // Done is sorted newest first, so each band's rows are consecutive.
    const bands = new Map<string, string[]>();

    for (const entry of groups.done) {
      const title = doneBand(entry.doneAt ?? entry.createdAt, now);

      bands.set(title, [...(bands.get(title) ?? []), html(entry)]);
    }

    return [...bands].map(([title, rows]) => band(title, rows, ui)).join('\n');
  };
  const body = (key: RowGroup) => {
    const rows = key === 'done' ? doneBody() : groups[key].map(html).join('\n');

    return rows || (GROUP_EMPTY[key] === undefined ? '' : `<p class="empty">${GROUP_EMPTY[key]}</p>`);
  };
  const shown = (key: RowGroup) => group(key, GROUP_TITLES[key], groups[key].length, body(key), ui);

  return `${errors(snapshot)}${setup(snapshot)}
${shown('needs')}
${shown('working')}
${shown('unstarted')}
${shown('done')}
${groups.snoozed.length === 0 ? '' : shown('snoozed')}`;
}
