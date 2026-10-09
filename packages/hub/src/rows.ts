import { activeSession, groupOf, triageLabel } from '@switchboard/core/group';
import type { Group } from '@switchboard/core/group';
import type { PoolView, Snapshot, WorkItemView } from './runtime.js';

// Imports only types and browser-safe core modules, so the History webview bundles it through `@switchboard/hub/rows`.

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

/** Each control icon's codicon glyph in codicon.ttf, which the dock draws; `symbol-file` is Open report's. */
export const CONTROL_GLYPHS = {
  check: '\u{eab2}',
  clockface: '\u{ec75}',
  'comment-discussion': '\u{eac7}',
  copy: '\u{ebcc}',
  'debug-restart': '\u{ead2}',
  'debug-stop': '\u{ead7}',
  'diff-multiple': '\u{ec23}',
  'symbol-file': '\u{ea7b}',
  history: '\u{ea82}',
  pass: '\u{eba4}',
  play: '\u{eb2c}',
  search: '\u{ea6d}',
} as const;

/** A codicon name a control may use; a new one needs its glyph in `CONTROL_GLYPHS`, or the build fails. */
export type ControlIcon = keyof typeof CONTROL_GLYPHS;

export interface Control {
  label: string;
  icon: ControlIcon;
  /** The message the button posts. */
  message: Record<string, unknown>;
}

/** The one control a Needs you or Unstarted row shows as a button, when one applies; every control is in its right-click menu. */
export function mainControl(item: WorkItemView): Control | null {
  const group = groupOf(item);

  if (group !== 'needs' && group !== 'unstarted') {
    return null;
  }

  // A question the session waits on comes before an approval it reported earlier, as the row's mark does.
  const wanted = waitsInBackground(activeSession(item))
    ? 'Open in Claude'
    : item.status === 'unstarted'
      ? 'Start'
      : item.status === 'awaiting-approval'
        ? 'Approve'
        : item.status === 'failed'
          ? 'Triage again'
          : null;

  return controlsOf(item).find((control) => control.label === wanted) ?? null;
}

/** The main control's tooltip: Approve names the prompt it runs, so the operator can read the exact command before approving (PRD R27). */
export function mainTitle(item: WorkItemView, control: Control): string {
  return control.label === 'Approve' && item.approvalPrompt !== null ? `Approve: runs ${item.approvalPrompt}` : control.label;
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

  const question = openQuestion(item);

  if (question !== null) {
    controls.push({ label: 'Open in Claude', icon: 'comment-discussion', message: question });
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

  // Runs in the item window, not the hub (PRD R57).
  if (item.worktree !== null) {
    controls.push({ label: 'Open Changes', icon: 'diff-multiple', message: { type: 'changes', path: item.worktree.path, key: ticketKey(item.ticket), title: item.ticket.title } });
  }

  return [...controls, historyControl(item.ticket)];
}

/**
 * A pool row's controls: Start once triage has chosen a playbook, which the pick starts (PRD R48), or Triage again after a failed triage,
 * then Snooze, Restore and History. `main` is the one the row shows as a button.
 */
export function poolControls(entry: PoolView): { main: Control | null; controls: Control[] } {
  const { ticket, triage } = entry;
  const pick: Control = { label: 'Start', icon: 'play', message: { type: 'action', action: { type: 'pick', ticketId: ticket.id } } };
  const again: Control = { label: 'Triage again', icon: 'search', message: { type: 'action', action: { type: 'retriage-pool', ticketId: ticket.id } } };
  const main = triage?.error != null ? again : triage?.playbook != null ? pick : null;

  return { main, controls: [...(main === null ? [] : [main]), ...snoozeControls(ticket), historyControl(ticket)] };
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

/** A session waiting on the operator in its background process, which Open in Claude stops and opens in a Claude tab (PRD R70). */
function waitsInBackground(session: SessionView | null): session is SessionView & { shortId: string; nativeSessionId: string } {
  return isBackground(session) && session.state === 'waiting' && session.nativeSessionId !== null;
}

/** Open in Claude: the hub stops the session, which then opens in the item window's Claude view (PRD R70). */
export function openQuestion(item: WorkItemView): { type: 'open-question'; workItemId: number; sessionId: string; cwd: string } | null {
  const session = activeSession(item);

  return waitsInBackground(session) ? { type: 'open-question', workItemId: item.id, sessionId: session.nativeSessionId, cwd: session.cwd } : null;
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

/** Character caps for the texts sessions report; the contract asks for less, and a longer text is cut here with its whole in the tooltip. */
export const CAPS = { stage: 24, approval: 60, note: 80, question: 80 } as const;

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

export function utcText(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The time in queue and its tooltip; a done row stops at `until`. Null for a pool ticket that has no scope entry. */
export function queuedTime(clock: Clock | null, until: number | null, now: number): { text: string; title: string } | null {
  if (clock === null) {
    return null;
  }

  const title = until === null ? `${clock.label} ${utcText(clock.since)}` : `${clock.label} ${utcText(clock.since)} to ${utcText(until)}`;

  return { text: queueTime(clock.since, until ?? now), title };
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

/** When a Done row was done, in local time: 24-hour `HH:mm` today, else `m/d` (PRD R27). */
export function doneStamp(doneAt: number, now: number): string {
  const date = new Date(doneAt);
  const pad = (value: number) => String(value).padStart(2, '0');

  return doneAt >= midnight(now) ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : `${date.getMonth() + 1}/${date.getDate()}`;
}

/** A Done row's done time, with the done time and scope entry in the tooltip (PRD R27). */
export function doneTime(item: WorkItemView, now: number): { text: string; title: string } {
  const doneAt = item.doneAt ?? item.createdAt;
  const clock = clockOf(item);

  return { text: doneStamp(doneAt, now), title: `Done ${utcText(doneAt)}; ${clock.label.toLowerCase()} ${utcText(clock.since)}` };
}

/** A work item row's time: the done time on an unsnoozed Done row, else the time in queue (PRD R27). */
export function rowTime(item: WorkItemView, now: number): { text: string; title: string } {
  return groupOf(item) === 'done' && !item.ticket.snoozed ? doneTime(item, now) : queuedTime(clockOf(item), item.doneAt, now)!;
}

export type Rating = { immediacy: string | null; severity: string | null } | null;

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

/** The priority dot's tooltip on a priority ticket, or null (PRD R50). */
export function priorityTitle(triage: Rating): string | null {
  return isPriority(triage) ? `Immediacy: ${triage!.immediacy ?? '?'}   Severity: ${triage!.severity ?? '?'}` : null;
}

/** The playbook a row names: `<namespace>:triage` while triage runs, else the chosen playbook, `ad-hoc`, or empty before triage. */
export function playbookText(entry: WorkItemView | PoolView, namespaces: Record<string, string>): string {
  if ('status' in entry) {
    return entry.status === 'triaging' ? triageLabel(entry.ticket.source, namespaces) : (entry.playbook ?? (entry.ticket.source === 'adhoc' ? 'ad-hoc' : ''));
  }

  // A snoozed ticket is never triaged, so a missing triage is not shown as running.
  return entry.triage !== null && entry.triage.endedAt === null ? triageLabel(entry.ticket.source, namespaces) : (entry.triage?.playbook ?? '');
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

const SOURCE_LABELS: Record<string, string> = { github: 'gh' };

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** The ticket's source and key, such as `gh 18941`. */
export function ticketKey(ticket: { source: string; sourceKey: string }): string {
  return `${sourceLabel(ticket.source)} ${ticket.sourceKey}`;
}

/** Each reason a queued row has not started, with what ends it, for the tooltip (PRD R34). */
export function waitTexts(item: WorkItemView): { text: string; title: string }[] {
  return item.waits.map((wait) => {
    switch (wait.kind) {
      case 'slot':
        return { text: `Waits for a slot · ${wait.used}/${wait.limit} in use`, title: `${wait.used} sessions are in Working; sessions.concurrency is ${wait.limit}.` };
      case 'session': {
        const owner = wait.ownItem ? 'its session' : `the ${wait.playbook ?? 'ad-hoc'} session`;

        return { text: `Waits for ${owner} to end`, title: `Session ${wait.shortId ?? wait.sessionId} on this ticket is still open, such as in a VS Code tab. Close or stop it to start.` };
      }
      case 'snoozed':
        return { text: 'Starts when the ticket wakes', title: 'The ticket is snoozed.' };
    }
  });
}

/** Outside Snoozed, a failed row takes the error stripe, and a blocked row or one with a question the warning stripe (PRD R27). */
export function stripeOf(item: WorkItemView): 'error' | 'warning' | null {
  if (item.ticket.snoozed) {
    return null;
  }

  if (item.status === 'failed') {
    return 'error';
  }

  return item.status === 'blocked' || (groupOf(item) === 'needs' && activeSession(item)?.state === 'waiting') ? 'warning' : null;
}

/** How long a running session goes without a stage report before the dock colours the stage age (PRD R58). */
export const STALE_STAGE_MS = 20 * 60_000;

/**
 * When a Working row's running session last reported a stage, or began running if it has reported none since: null unless the row is
 * stale (PRD R58). A stage from before a new session or a wait does not count against the current run.
 */
export function staleSince(item: WorkItemView, now: number): number | null {
  const session = activeSession(item);

  if (groupOf(item) !== 'working' || item.ticket.snoozed || session?.state !== 'running') {
    return null;
  }

  const since = Math.max(item.stageAt ?? -Infinity, item.runStartedAt ?? -Infinity, session.stateAt);

  return now - since >= STALE_STAGE_MS ? since : null;
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

/** What an empty group says; Done and Snoozed say nothing. */
export const GROUP_EMPTY: Partial<Record<RowGroup, string>> = { needs: 'Nothing needs you.', working: 'Nothing is running.', unstarted: 'Nothing waits to be started.' };

/** A row's `data-row` key: `item:<work item ID>` or `ticket:<pool ticket ID>`. */
export function rowKeyOf(entry: WorkItemView | PoolView): string {
  return 'status' in entry ? `item:${entry.id}` : `ticket:${entry.ticket.id}`;
}

/** The rows the dock shows, by group, each in list order (PRD R27, R49). */
export function listGroups(snapshot: Snapshot): Record<RowGroup, (WorkItemView | PoolView)[]> & { done: WorkItemView[] } {
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

/** Local midnight `days` days after the day of `time`. */
function midnight(time: number, days = 0): number {
  const date = new Date(time);

  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

/** The settings, playbook, hook and source errors the dock lists above the groups (PRD R42). */
export function snapshotErrors(snapshot: Snapshot): string[] {
  return [
    snapshot.errors.settings === null ? null : `Settings: ${snapshot.errors.settings}`,
    ...snapshot.errors.playbooks.map((error) => `Playbook ${error}`),
    snapshot.errors.hooks === null ? null : `Hooks: ${snapshot.errors.hooks}`,
    ...Object.entries(snapshot.errors.sources).map(([name, error]) => `${name}: ${error}`),
  ].filter((line): line is string => line !== null);
}

/** What an unconfigured home is missing, said plainly. */
export function setupNotes(snapshot: Snapshot): string[] {
  return [
    snapshot.sources.length > 0
      ? null
      : snapshot.sourceStates.length > 0
        ? 'No source is polled. Turn one on in the header.'
        : `No source is configured. Add one in ${snapshot.configDir}\\settings.json.`,
    snapshot.playbooks.length === 0 ? `No task playbooks are loaded. Add them under ${snapshot.configDir}\\playbooks.` : null,
  ].filter((line): line is string => line !== null);
}

/** The row's linked GitHub pull requests and issues as `PR #<n>` and `gh <n>`, as the row's menu names them (PRD R52). */
export function linkedKeys(entry: WorkItemView | PoolView): string[] {
  const keys = entry.links.flatMap((link) => {
    const kind = linkKind(link.target);
    const number = linkNumber(link.target);

    return kind === 'url' || number === null ? [] : [kind === 'pr' ? `PR #${number}` : `gh ${number}`];
  });

  // A link to the ticket itself repeats its key.
  return [...new Set(keys)].filter((key) => key !== ticketKey(entry.ticket));
}

/** What Go to Work Item matches besides the title and branch: the key, linked pull requests and issues, playbook and group (PRD R63). */
export function searchDescription(entry: WorkItemView | PoolView, group: RowGroup, namespaces: Record<string, string>): string {
  return [ticketKey(entry.ticket), ...linkedKeys(entry), playbookText(entry, namespaces), GROUP_TITLES[group]].filter((part) => part !== '').join(' · ');
}
