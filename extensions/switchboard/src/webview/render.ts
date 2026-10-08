import { activeSession, groupOf, triageLabel } from '@switchboard/core/group';
import type { Group } from '@switchboard/core/group';
import type { PoolView, Snapshot, WorkItemView } from '@switchboard/hub';
import { wakeText } from '@switchboard/core/snooze';

export { activeSession, groupOf };
export type { Group };

export const DONE_WORDS: Record<'session' | 'operator' | 'unassigned', string> = { session: 'Finished by the session', operator: 'Marked done', unassigned: 'Left the assigned state' };

/** The one control a Needs you or Unstarted row shows as a button, when one applies; every control is in its right-click menu. */
export function mainControl(item: WorkItemView): Control | null {
  const group = groupOf(item);

  if (group !== 'needs' && group !== 'unstarted') {
    return null;
  }

  const wanted = item.status === 'unstarted' ? 'Start' : item.status === 'awaiting-approval' ? 'Approve' : item.status === 'failed' || item.status === 'blocked' ? 'Retry' : null;

  return controlsOf(item).find((control) => control.label === wanted) ?? null;
}

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A short age such as `40s`, `5m`, `2h` or `3d`. */
export function age(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export interface Control {
  label: string;
  icon: string;
  /** The message the button posts. */
  message: Record<string, unknown>;
}

/** The controls that apply to a work item (PRD R27). */
export function controlsOf(item: WorkItemView): Control[] {
  const controls: Control[] = [];
  const session = activeSession(item);
  const adhoc = item.ticket.source === 'adhoc';
  const action = (type: string) => ({ type: 'action', action: { type, workItemId: item.id } });

  if (item.status === 'unstarted') {
    controls.push({ label: 'Start', icon: 'play', message: action('start') });
  }

  if (item.status === 'awaiting-approval') {
    controls.push({ label: 'Approve', icon: 'check', message: action('approve') });
  }

  // Runs in the extension, which reads the file and writes the clipboard (PRD R60).
  if (item.status === 'awaiting-approval' && item.pastes.length > 0) {
    controls.push({ label: 'Copy', icon: 'copy', message: { type: 'copy', pastes: item.pastes.map(({ label, file }) => ({ label, file })) } });
  }

  if (item.status === 'failed' || item.status === 'blocked') {
    controls.push({ label: 'Retry', icon: 'refresh', message: action('retry') });
  }

  if (isBackground(session)) {
    controls.push({ label: 'Stop', icon: 'debug-stop', message: action('stop') });
  }

  if (item.status !== 'done' && session === null && !adhoc && item.status !== 'triaging') {
    controls.push({ label: 'Triage again', icon: 'search', message: action('retriage') });
  }

  if (item.status !== 'done') {
    controls.push({ label: 'Mark done', icon: 'pass', message: action('mark-done') });
  }

  if (item.status !== 'done' || item.ticket.snoozed) {
    controls.push(...snoozeControls(item.ticket));
  }

  // These run in the extension, not the hub (PRD R57).
  if (item.worktree !== null) {
    const key = ticketKey(item.ticket);

    controls.push(
      { label: 'Open Changes', icon: 'diff-multiple', message: { type: 'changes', path: item.worktree.path, key, title: item.ticket.title } },
      { label: 'Show in Source Control', icon: 'source-control', message: { type: 'sourceControl', path: item.worktree.path } },
    );
  }

  return [...controls, historyControl(item.ticket)];
}

/** Every run the ticket has had, in a read-only document the extension opens (PRD R59). */
function historyControl(ticket: { id: number; source: string; sourceKey: string }): Control {
  return { label: 'History', icon: 'history', message: { type: 'history', ticketId: ticket.id, key: ticketKey(ticket) } };
}

type SessionView = WorkItemView['sessions'][number];

/** A session running in its background process; a released session that is active again was resumed elsewhere, such as in a VS Code tab. */
function isBackground(session: SessionView | null): session is SessionView & { shortId: string } {
  return session !== null && session.state !== 'starting' && session.shortId !== null && !session.released;
}


/**
 * What a click on the row opens (PRD R27): the latest session in a terminal, attached while its background process runs and
 * resumed otherwise, else the worktree in VS Code, else, with no session, the ticket. `active` marks a session resumed elsewhere,
 * such as in a VS Code tab. Null when there is nothing to open, as for a session still starting.
 */
export function openAction(item: WorkItemView): Record<string, unknown> | null {
  const latest = item.sessions.at(-1) ?? null;
  const session = activeSession(item);
  const name = `${item.ticket.source} ${item.ticket.sourceKey}`;

  if (isBackground(session)) {
    return { type: 'attach', shortId: session.shortId, name };
  }

  if (latest?.nativeSessionId != null && (session === null || session.released)) {
    return { type: 'resume', sessionId: latest.nativeSessionId, cwd: latest.cwd, name, active: session !== null };
  }

  if (item.worktree !== null) {
    return { type: 'openFolder', path: item.worktree.path };
  }

  return item.sessions.length === 0 ? ticketOpen(item.ticket) : null;
}

/** The ticket in the browser; null for a ticket with no URL, such as an ad-hoc one. */
function ticketOpen(ticket: { url: string }): Record<string, unknown> | null {
  return ticket.url === '' ? null : { type: 'openUrl', url: ticket.url };
}

/**
 * What a Ctrl+click on the row opens: the session in VS Code when it is not running in its background process, else the
 * worktree in VS Code, because an editor resume of a live background session is refused (M7); otherwise null.
 */
export function editorAction(item: WorkItemView): Record<string, unknown> | null {
  const action = openAction(item);

  if (action?.['type'] === 'resume') {
    return { type: 'open', sessionId: action['sessionId'], cwd: action['cwd'] };
  }

  return item.worktree === null ? null : { type: 'openFolder', path: item.worktree.path };
}

function openAttribute(action: Record<string, unknown> | null, editor: Record<string, unknown> | null = null): string {
  return `${action === null ? '' : ` data-open="${escape(JSON.stringify(action))}"`}${editor === null ? '' : ` data-open-editor="${escape(JSON.stringify(editor))}"`}`;
}

/**
 * Snooze for a ticket, and Restore when it is snoozed, so a snoozed ticket can take a new wake time without waking first (PRD R49).
 * Snooze carries no wake time: the extension asks for one before it reaches the hub.
 */
function snoozeControls(ticket: { id: number; snoozed: boolean }): Control[] {
  const controls: Control[] = [{ label: 'Snooze', icon: 'clockface', message: { type: 'action', action: { type: 'snooze', ticketId: ticket.id } } }];

  if (ticket.snoozed) {
    controls.push({ label: 'Restore', icon: 'debug-restart', message: { type: 'action', action: { type: 'restore', ticketId: ticket.id } } });
  }

  return controls;
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
 * The tone colours it: `primary` for Approve, `error` or `warning` for Retry, none for the rest; `iconOnly` drops the verb.
 */
function actionButton(control: Control, tone: 'primary' | 'error' | 'warning' | null = null, iconOnly = false, title = control.label): string {
  const label = iconOnly ? '' : `<span class="label">${escape(control.label)}</span>`;

  return `<button class="control action-button${tone === null ? '' : ` ${tone}`}${iconOnly ? ' icon-only' : ''}" title="${escape(title)}" data-message="${escape(JSON.stringify(control.message))}"><span class="codicon codicon-${control.icon}"></span>${label}</button>`;
}

/** Approve takes the primary colour, and Retry the error colour on a failed row or the warning colour on a blocked one. */
function toneOf(item: WorkItemView, control: Control): 'primary' | 'error' | 'warning' | null {
  if (control.label === 'Approve') {
    return 'primary';
  }

  return control.label === 'Retry' ? (item.status === 'failed' ? 'error' : 'warning') : null;
}

/** Character caps for the texts sessions report; the contract asks for less, and a longer text is cut here with its whole in the tooltip. */
export const CAPS = { stage: 24, approval: 60, note: 80 } as const;

/** The text cut at `max` characters on a word boundary with an ellipsis, and the whole text for the tooltip when it was cut. */
export function clip(text: string, max: number): { text: string; full: string | null } {
  // Graphemes, not UTF-16 units, so an emoji or an accented letter at the cap is kept whole.
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((segment) => segment.segment);

  if (graphemes.length <= max) {
    return { text, full: null };
  }

  const cut = graphemes.slice(0, max).join('');
  // A cap that falls on a word boundary keeps the whole word before it.
  const space = graphemes[max] === ' ' ? cut.length : cut.lastIndexOf(' ');

  return { text: `${(space > cut.length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`, full: text };
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
  Retry: 'retry',
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

/** Time in queue as a whole number of minutes, hours, days or weeks, such as `40m`, `5h`, `3d` or `2w`. */
export function queueTime(since: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);

  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

export interface Clock {
  since: number;
  /** What the time counts, for the tooltip. */
  label: string;
}

/**
 * The row's time, by group (PRD R27): Needs you since the work item entered its status or its session began to wait, Working since the run
 * started, and Unstarted, Snoozed and Done since the ticket entered the source's scope, stopping at done. A Done row shows its done time instead, with this in the tooltip.
 */
export function clockOf(item: WorkItemView): Clock {
  const group = groupOf(item);
  const session = activeSession(item);

  if (group === 'done') {
    // Never the ticket's scopeAt: a ticket that returned after the work item was done has a later one.
    return { since: item.scopeAt ?? item.createdAt, label: 'In scope from' };
  }

  if (item.ticket.snoozed || group === 'unstarted') {
    return { since: item.ticket.scopeAt ?? item.createdAt, label: 'In scope since' };
  }

  if (group === 'needs') {
    const byStatus = item.status === 'awaiting-approval' || item.status === 'blocked' || item.status === 'failed';

    return !byStatus && session?.state === 'waiting' ? { since: session.stateAt, label: 'Waiting since' } : { since: item.statusAt, label: 'In this status since' };
  }

  return { since: item.runStartedAt ?? item.statusAt, label: 'Working since' };
}

function utcText(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function queued(clock: Clock | null, until: number | null, now: number): string {
  if (clock === null) {
    return '';
  }

  const title = until === null ? `${clock.label} ${utcText(clock.since)}` : `${clock.label} ${utcText(clock.since)} to ${utcText(until)}`;

  return `<span class="queue" title="${escape(title)}">${queueTime(clock.since, until ?? now)}</span>`;
}

/** When a Done row was done, in local time: 24-hour `HH:mm` today, else `m/d` (PRD R27). */
export function doneStamp(doneAt: number, now: number): string {
  const date = new Date(doneAt);
  const pad = (value: number) => String(value).padStart(2, '0');

  return doneAt >= midnight(now) ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : `${date.getMonth() + 1}/${date.getDate()}`;
}

function doneTime(item: WorkItemView, now: number): string {
  const doneAt = item.doneAt ?? item.createdAt;
  const clock = clockOf(item);

  return `<span class="queue" title="${escape(`Done ${utcText(doneAt)}; ${clock.label.toLowerCase()} ${utcText(clock.since)}`)}">${doneStamp(doneAt, now)}</span>`;
}

type Rating = { immediacy: string | null; severity: string | null } | null;

const RANKS: Record<string, number> = { URGENT: 0, BLOCKING: 1, 'NON-BLOCKING': 2, HIGH: 0, MED: 1, LOW: 2 };

/** Immediacy rank plus severity rank, or null unless both are rated (PRD R50). */
export function rankOf(triage: Rating): number | null {
  const immediacy = triage?.immediacy == null ? undefined : RANKS[triage.immediacy];
  const severity = triage?.severity == null ? undefined : RANKS[triage.severity];

  return immediacy === undefined || severity === undefined ? null : immediacy + severity;
}

/** Priority, as the Support board derives it: a customer blocked now, or high severity (PRD R50). */
export function isPriority(triage: Rating): boolean {
  return (triage?.immediacy != null && triage.immediacy !== 'NON-BLOCKING') || triage?.severity === 'HIGH';
}

/** The priority dot, with the rating in its tooltip; nothing when not priority (PRD R27, R50). */
export function priorityDot(triage: Rating): string {
  if (!isPriority(triage)) {
    return '';
  }

  return `<span class="priority" title="${escape(`Immediacy: ${triage!.immediacy ?? '?'}   Severity: ${triage!.severity ?? '?'}`)}"></span>`;
}

export interface Mark {
  icon: string;
  /** What the mark means, in words, for its tooltip. */
  title: string;
  /** `error` or `warning` colours the mark. */
  tone?: 'error' | 'warning';
}

const TRIAGING: Mark = { icon: 'loading codicon-modifier-spin', title: 'Triaging' };

/** The row mark shows what differs between rows of the same group; a snoozed item shows its group's mark (PRD R27). Unstarted rows show the priority dot, Triaging or Queued. */
export function markOf(item: WorkItemView): Mark | 'priority' {
  const session = activeSession(item);

  switch (groupOf(item)) {
    case 'needs':
      if (session?.state === 'waiting') {
        return { icon: 'question', title: 'Answer a question' };
      }

      if (item.status === 'awaiting-approval') {
        return item.approvalSends ? { icon: 'send', title: 'Approve to send' } : { icon: 'eye', title: 'Review, then approve' };
      }

      return item.status === 'failed' ? { icon: 'error', title: 'Failed', tone: 'error' } : { icon: 'debug-pause', title: 'Blocked' };
    case 'working':
      if (item.status === 'setup') {
        return { icon: 'tools', title: 'Setting up' };
      }

      return { icon: 'sync codicon-modifier-spin', title: 'Running' };
    case 'unstarted':
      return item.status === 'triaging' ? TRIAGING : item.status === 'queued' ? { icon: 'clock', title: 'Queued' } : 'priority';
    case 'done':
      return item.doneReason === 'operator'
        ? { icon: 'account', title: DONE_WORDS.operator }
        : item.doneReason === 'unassigned'
          ? { icon: 'sign-out', title: DONE_WORDS.unassigned }
          : { icon: 'check', title: DONE_WORDS.session };
  }
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

/** The playbook a row names: `<namespace>:triage` while triage runs, else the chosen playbook, `ad-hoc`, or empty before triage. */
export function playbookText(entry: WorkItemView | PoolView, namespaces: Record<string, string>): string {
  if ('status' in entry) {
    return entry.status === 'triaging' ? triageLabel(entry.ticket.source, namespaces) : (entry.playbook ?? (entry.ticket.source === 'adhoc' ? 'ad-hoc' : ''));
  }

  // A snoozed ticket is never triaged, so a missing triage is not shown as running.
  return entry.triage !== null && entry.triage.endedAt === null ? triageLabel(entry.ticket.source, namespaces) : (entry.triage?.playbook ?? '');
}

/** Marks a ticket that came back after earlier work items (PRD R51). */
function returned(count: number): string {
  return count === 0 ? '' : `<span class="returned">Returned ×${count}</span>`;
}

const PULL_REQUEST = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/;
const ISSUE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/;

/** A link's kind by its URL: a GitHub pull request or issue, or another URL (PRD R52). */
export function linkKind(target: string): 'pr' | 'issue' | 'url' {
  return PULL_REQUEST.test(target) ? 'pr' : ISSUE.test(target) ? 'issue' : 'url';
}

/** A GitHub pull request's or issue's number, from the same URL patterns as `linkKind`, or null for another URL. */
export function linkNumber(target: string): string | null {
  return (PULL_REQUEST.exec(target) ?? ISSUE.exec(target))?.[1] ?? null;
}

const LINK_ICONS = { pr: 'git-pull-request', url: 'link' } as const;

function linkBadge(link: { label: string; target: string }): string {
  const kind = linkKind(link.target);

  // A GitHub issue reads like a GitHub ticket's key, `gh <number>`, whatever label the session gave it.
  if (kind === 'issue') {
    return `<a class="key github" href="${escape(link.target)}" title="${escape(link.target)}">gh ${ISSUE.exec(link.target)![1]}</a>`;
  }

  // The pull request icon already says PR, so the badge shows only the number from the URL, whatever label the session gave it.
  const label = kind === 'pr' ? PULL_REQUEST.exec(link.target)![1]! : link.label;

  return `<a class="badge ${kind}" href="${escape(link.target)}" title="${escape(link.target)}"><span class="codicon codicon-${LINK_ICONS[kind]}"></span> ${escape(label)}</a>`;
}

const SOURCE_LABELS: Record<string, string> = { github: 'gh' };

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** The ticket's source and key, such as `gh 18941`. */
export function ticketKey(ticket: { source: string; sourceKey: string }): string {
  return `${sourceLabel(ticket.source)} ${ticket.sourceKey}`;
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

  const label = `${sourceLabel(item.parent.source)} ${item.parent.sourceKey}`;

  return `<button class="from" data-reveal="item:${item.parentId}" title="${escape(`Show the work item it came from: ${item.parent.title}`)}">From <span class="key ${escape(item.parent.source)}">${escape(label)}</span></button>`;
}

/** Each reason a queued row has not started, with what ends it in the tooltip (PRD R34). */
function waits(item: WorkItemView): string {
  return item.waits
    .map((wait): [string, string] => {
      switch (wait.kind) {
        case 'slot':
          return [`Waits for a slot · ${wait.used}/${wait.limit} in use`, `${wait.used} sessions are in Working; sessions.concurrency is ${wait.limit}.`];
        case 'session': {
          const owner = wait.ownItem ? 'its session' : `the ${wait.playbook ?? 'ad-hoc'} session`;

          return [`Waits for ${owner} to end`, `Session ${wait.shortId ?? wait.sessionId} on this ticket is still open, such as in a VS Code tab. Close or stop it to start.`];
        }
        case 'snoozed':
          return ['Starts when the ticket wakes', 'The ticket is snoozed.'];
      }
    })
    .map(([text, title]) => `<span class="wait" title="${escape(title)}">${escape(text)}</span>`)
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

/**
 * Splits a work item's or pool ticket's links: line 2 shows pull requests, and GitHub issues unless the ticket is a GitHub one; the rest go
 * to line 3. A link to the ticket itself is dropped, because the ticket link already shows it (PRD R52).
 */
export function splitLinks(item: Pick<WorkItemView, 'links' | 'ticket'>): { primary: WorkItemView['links']; rest: WorkItemView['links'] } {
  const links = item.links.filter((link) => link.target !== item.ticket.url);
  const primary = [
    ...links.filter((link) => linkKind(link.target) === 'pr'),
    ...(item.ticket.source === 'github' ? [] : links.filter((link) => linkKind(link.target) === 'issue')),
  ];

  return { primary, rest: links.filter((link) => !primary.includes(link)) };
}

/** How long a running session goes without a stage report before the panel colours the stage age (PRD R58). */
export const STALE_STAGE_MS = 20 * 60_000;

/**
 * When a Working row's running session last reported a stage, or began running if it has reported none since: null unless the row is
 * stale (PRD R58). A stage from before a retry or a wait does not count against the current run.
 */
export function staleSince(item: WorkItemView, now: number): number | null {
  const session = activeSession(item);

  if (groupOf(item) !== 'working' || item.ticket.snoozed || session?.state !== 'running') {
    return null;
  }

  const since = Math.max(item.stageAt ?? -Infinity, item.runStartedAt ?? -Infinity, session.stateAt);

  return now - since >= STALE_STAGE_MS ? since : null;
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
 * On an `awaiting-approval` row, the approval summary, capitalised, and the time since the report take the stage's place. A fixed tooltip holds the
 * whole summary and the last stage, because the hover handler leaves it even when the width cuts the summary (PRD R27).
 */
function approvalText(item: WorkItemView, summary: string, now: number): string {
  const whole = summary.charAt(0).toUpperCase() + summary.slice(1);
  const { text, full } = clip(whole, CAPS.approval);
  const tooltip = item.stage === null ? full : `${whole}\nLast stage: ${item.stage}`;
  const attributes = tooltip === null ? '' : ` title="${escape(tooltip)}" data-full`;

  return `<span class="approval"${attributes}>${escape(text)}<span class="since"> · ${age(item.statusAt, now)}</span></span>`;
}

function row(item: WorkItemView, now: number, ui: PanelUi, namespaces: Record<string, string>): string {
  const main = mainControl(item);
  const rowKey = rowKeyOf(item);
  const summary = item.status === 'awaiting-approval' ? item.approvalSummary : null;
  const stage = summary === null ? stageText(item, now) : approvalText(item, summary, now);
  const notes = [item.warning, item.error].filter((note): note is string => note !== null).map((note) => clipped('note', note, CAPS.note)).join('');
  const { primary, rest } = splitLinks(item);
  const report = item.status === 'awaiting-approval' ? item.approvalReport : null;
  const reportButton = report === null ? '' : actionButton({ label: 'Report', icon: 'file', message: { type: 'openUrl', url: report } }, null, true, fileName(report));
  const copy = controlsOf(item).find((control) => control.label === 'Copy');
  const copyButton = copy === undefined ? '' : actionButton(copy, null, true, item.pastes.length === 1 ? `Copy ${item.pastes[0]!.label}` : 'Copy…');

  return `<div class="item${stripeClass(item)}${selectedClass(rowKey, ui)}" data-item="${item.id}" data-row="${rowKey}" tabindex="0"${openAttribute(openAction(item), editorAction(item))}${rowContext(controlsOf(item))}>
${firstLine(item.triage, item.ticket.title, groupOf(item) === 'done' && !item.ticket.snoozed ? doneTime(item, now) : queued(clockOf(item), item.doneAt, now))}
<div class="line second"><span class="meta">${playbookLabel(playbookText(item, namespaces))}${ticketLink(item.ticket)}${primary.map(linkBadge).join('')}${returned(item.returned)}</span></div>${thirdLine(
    `${statusMark(item)}${waits(item)}${wake(item.ticket)}${notes}${fromParent(item)}${stage}${rest.map(linkBadge).join('')}`,
  )}${actionsColumn(`${copyButton}${reportButton}${main === null ? '' : actionButton(main, toneOf(item, main), false, mainTitle(item, main))}`)}
</div>`;
}

/** Outside Snoozed, a failed row takes the error stripe, and a blocked row or one with a question the warning stripe (PRD R27). */
function stripeClass(item: WorkItemView): string {
  if (item.ticket.snoozed) {
    return '';
  }

  if (item.status === 'failed') {
    return ' stripe-error';
  }

  return item.status === 'blocked' || (groupOf(item) === 'needs' && activeSession(item)?.state === 'waiting') ? ' stripe-warning' : '';
}

/** Approve's tooltip names the prompt it runs, so the operator can read the exact command before approving. */
function mainTitle(item: WorkItemView, control: Control): string {
  return control.label === 'Approve' && item.approvalPrompt !== null ? `Approve: runs ${item.approvalPrompt}` : control.label;
}

function errors(snapshot: Snapshot): string {
  const lines = [
    snapshot.errors.settings === null ? null : `Settings: ${snapshot.errors.settings}`,
    ...snapshot.errors.playbooks.map((error) => `Playbook ${error}`),
    snapshot.errors.hooks === null ? null : `Hooks: ${snapshot.errors.hooks}`,
    ...Object.entries(snapshot.errors.sources).map(([name, error]) => `${name}: ${error}`),
  ].filter((line): line is string => line !== null);

  return lines.length === 0 ? '' : `<div class="errors">${lines.map((line) => `<div class="note"><span class="codicon codicon-warning"></span> ${escape(line)}</div>`).join('')}</div>`;
}

/** Says plainly what an unconfigured home is missing. */
function setup(snapshot: Snapshot): string {
  const lines = [
    snapshot.sources.length > 0
      ? null
      : snapshot.sourceStates.length > 0
        ? 'No source is polled. Turn one on in the title bar.'
        : `No source is configured. Add one in ${snapshot.configDir}\\settings.json.`,
    snapshot.playbooks.length === 0 ? `No task playbooks are loaded. Add them under ${snapshot.configDir}\\playbooks.` : null,
  ].filter((line): line is string => line !== null);

  return lines.map((line) => `<p class="empty"><span class="codicon codicon-info"></span> ${escape(line)}</p>`).join('');
}


/**
 * A pool row in Unstarted: priority, title, time in queue; playbook, ticket, links, Returned, Start; Snooze in the right-click menu.
 * A click opens the ticket (PRD R27, R47, R48).
 */
function poolRow(entry: PoolView, now: number, ui: PanelUi, namespaces: Record<string, string>): string {
  const { ticket, triage } = entry;
  const rowKey = rowKeyOf(entry);
  const pick: Control = { label: 'Start', icon: 'play', message: { type: 'action', action: { type: 'pick', ticketId: ticket.id } } };
  const again: Control = { label: 'Triage again', icon: 'search', message: { type: 'action', action: { type: 'retriage-pool', ticketId: ticket.id } } };
  const failed = triage?.error != null;
  const triaging = triage !== null && triage.endedAt === null;
  // Start appears once triage has chosen a playbook, which the pick starts (PRD R48).
  const main = failed ? again : triage?.playbook != null ? pick : null;
  const controls = [...(main === null ? [] : [main]), ...snoozeControls(ticket), historyControl(ticket)];
  const { primary, rest } = splitLinks(entry);

  return `<div class="item pool-item${selectedClass(rowKey, ui)}" data-ticket="${ticket.id}" data-row="${rowKey}" tabindex="0"${openAttribute(ticketOpen(ticket))}${rowContext(controls)}>
${firstLine(triage, ticket.title, queued(ticket.scopeAt === null ? null : { since: ticket.scopeAt, label: 'In scope since' }, null, now))}
<div class="line second"><span class="meta">${playbookLabel(playbookText(entry, namespaces))}${ticketLink(ticket)}${primary.map(linkBadge).join('')}${returned(entry.returned)}</span></div>${thirdLine(
    `${triaging ? markIcon(TRIAGING) : ''}${wake(ticket)}${failed ? clipped('note', triage!.error!, CAPS.note) : ''}${rest.map(linkBadge).join('')}`,
  )}${actionsColumn(main === null ? '' : actionButton(main))}
</div>`;
}

/**
 * Unstarted work items and pool tickets together: by importance rank, an unrated one counting as rank 2, then oldest first
 * by the source's sort time or the work item's creation (PRD R27, R50).
 */
export function unstartedOrder(items: WorkItemView[], pool: PoolView[]): (WorkItemView | PoolView)[] {
  const key = (entry: WorkItemView | PoolView) => {
    const since = entry.ticket.sortAt ?? ('createdAt' in entry ? entry.createdAt : Infinity);

    return [rankOf(entry.triage) ?? 2, since] as const;
  };

  return [...items, ...pool].sort((a, b) => {
    const [rankA, sinceA] = key(a);
    const [rankB, sinceB] = key(b);

    return rankA - rankB || (sinceA === sinceB ? 0 : sinceA < sinceB ? -1 : 1);
  });
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

/** A snoozed ticket shows as one row: its pool entry, else its open work item, else its latest one (PRD R49). */
function snoozedRows(items: WorkItemView[]): WorkItemView[] {
  const rows = new Map<number, WorkItemView>();

  for (const item of items) {
    const shown = rows.get(item.ticketId);

    if (shown === undefined || (shown.status === 'done' && (item.status !== 'done' || item.id > shown.id))) {
      rows.set(item.ticketId, item);
    }
  }

  return items.filter((item) => rows.get(item.ticketId) === item);
}

export type RowGroup = Group | 'snoozed';

export const GROUP_TITLES: Record<RowGroup, string> = { needs: 'Needs you', working: 'Working', unstarted: 'Unstarted', done: 'Done', snoozed: 'Snoozed' };

/** A row's `data-row` key: `item:<work item ID>` or `ticket:<pool ticket ID>`. */
export function rowKeyOf(entry: WorkItemView | PoolView): string {
  return 'status' in entry ? `item:${entry.id}` : `ticket:${entry.ticket.id}`;
}

/** The rows the panel shows, by group, each in panel order (PRD R27, R49). */
export function panelGroups(snapshot: Snapshot): Record<RowGroup, (WorkItemView | PoolView)[]> & { done: WorkItemView[] } {
  const groups: Record<Group, WorkItemView[]> = { needs: [], working: [], unstarted: [], done: [] };
  const snoozedPool = snapshot.pool.filter((entry) => entry.ticket.snoozed);
  // A pool row stands for its ticket, whose work items are all done.
  const pooledTickets = new Set(snoozedPool.map((entry) => entry.ticket.id));
  const snoozedItems = snoozedRows(snapshot.workItems.filter((item) => item.ticket.snoozed && !pooledTickets.has(item.ticketId)));

  for (const item of snapshot.workItems) {
    if (!item.ticket.snoozed) {
      groups[groupOf(item)].push(item);
    }
  }

  return {
    ...groups,
    done: groups.done.sort((a, b) => (b.doneAt ?? b.createdAt) - (a.doneAt ?? a.createdAt) || b.id - a.id),
    unstarted: unstartedOrder(groups.unstarted, snapshot.pool.filter((entry) => !entry.ticket.snoozed)),
    snoozed: [...snoozedItems, ...snoozedPool],
  };
}

const EMPTY: Partial<Record<RowGroup, string>> = { needs: 'Nothing needs you.', working: 'Nothing is running.', unstarted: 'Nothing waits to be started.' };

/** Local midnight `days` days after the day of `time`. */
function midnight(time: number, days = 0): number {
  const date = new Date(time);

  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

/** Done's date bands, as in Windows Explorer: Today, Yesterday, Earlier this week, Last week and Older, with weeks starting on Monday (PRD R27). */
export function doneBand(doneAt: number, now: number): string {
  const today = midnight(now);
  const week = midnight(now, -((new Date(now).getDay() + 6) % 7));

  if (doneAt >= today) {
    return 'Today';
  }

  if (doneAt >= midnight(now, -1)) {
    return 'Yesterday';
  }

  if (doneAt >= week) {
    return 'Earlier this week';
  }

  return doneAt >= midnight(week, -7) ? 'Last week' : 'Older';
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

    return rows || (EMPTY[key] === undefined ? '' : `<p class="empty">${EMPTY[key]}</p>`);
  };
  const shown = (key: RowGroup) => group(key, GROUP_TITLES[key], groups[key].length, body(key), ui);

  return `${errors(snapshot)}${setup(snapshot)}
${shown('needs')}
${shown('working')}
${shown('unstarted')}
${shown('done')}
${groups.snoozed.length === 0 ? '' : shown('snoozed')}`;
}
