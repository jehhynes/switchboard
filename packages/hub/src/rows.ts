import { activeSession, adhocLabel, blocksOnYou, groupOf, holdsSlot, ownPrompt, retries, reviewOrder, triageLabel, turnOf, waitsOnPermission, waitsOnQuestion, waitsToStart } from '@switchboard/core/group';
import type { Provider, TicketBlocker } from '@switchboard/core';
import { waitsOnLimit } from '@switchboard/core/limit';
import { timeAt } from '@switchboard/core/time';
import type { Group } from '@switchboard/core/group';
import type { Notice, NoticeAction } from './notices.js';
import type { PoolView, Snapshot, WorkItemView } from './runtime.js';

// Imports only types and browser-safe core modules, so a browser bundle can import it through `@switchboard/hub/rows`.

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

/** Each control icon's codicon glyph in codicon.ttf, which the list draws; `symbol-file` is Open report's. */
export const CONTROL_GLYPHS = {
  'arrow-circle-up': '\u{ebff}',
  'arrow-down': '\u{ea9a}',
  'arrow-up': '\u{eaa1}',
  check: '\u{eab2}',
  clockface: '\u{ec75}',
  comment: '\u{ea6b}',
  'comment-discussion': '\u{eac7}',
  copy: '\u{ebcc}',
  discard: '\u{eae2}',
  edit: '\u{ea73}',
  'debug-restart': '\u{ead2}',
  'debug-stop': '\u{ead7}',
  'diff-multiple': '\u{ec23}',
  'symbol-file': '\u{ea7b}',
  history: '\u{ea82}',
  'issue-reopened': '\u{eb0b}',
  pass: '\u{eba4}',
  play: '\u{eb2c}',
  refresh: '\u{eb37}',
  search: '\u{ea6d}',
  terminal: '\u{ea85}',
  trash: '\u{ea81}',
} as const;

/** A codicon name a control may use; a new one needs its glyph in `CONTROL_GLYPHS`, or the build fails. */
export type ControlIcon = keyof typeof CONTROL_GLYPHS;

export interface Control {
  label: string;
  icon: ControlIcon;
  /** The message the button posts. */
  message: Record<string, unknown>;
  /** A question the page asks before it runs the control, with its detail and the label of the button that goes ahead. */
  confirm?: { question: string; detail: string; action: string };
  /**
   * A text the page asks for before it runs the control, set as the action's `field`, with the label of the button that goes ahead and `text` in
   * the box at first; with `choice`, the page also offers `values`, `value` selected, and sets a changed choice as the action's `choice.field`.
   */
  input?: { question: string; detail: string; field: string; action: string; text?: string; choice?: InputChoice };
}

export interface InputChoice {
  field: string;
  label: string;
  value: string;
  values: string[];
}

/**
 * Start with guidance…: Start, after the page asks for guidance that the task session's prompt ends with (PRD R77), and for the playbook when
 * there is another to choose (PRD R35).
 */
function guidedStart(message: Record<string, unknown>, playbook: string | null, playbooks: string[]): Control {
  const choice = playbook !== null && playbooks.length > 1 ? { choice: { field: 'playbook', label: 'Playbook', value: playbook, values: playbooks } } : {};
  const input = { question: 'Start with guidance', detail: "Switchboard adds your guidance to the end of the session's prompt.", field: 'guidance', action: 'Start', ...choice };

  return { label: 'Start with guidance…', icon: 'comment', message, input };
}

/** Start with prompt…: Start, after the operator reads and edits the prompt of an ad-hoc or task work item, which later starts keep (PRD R77). */
function promptedStart(message: Record<string, unknown>, prompt: string): Control {
  const input = { question: 'Start with prompt', detail: 'The session runs this prompt. Switchboard keeps your changes for later starts.', field: 'prompt', action: 'Start', text: prompt };

  return { label: 'Start with prompt…', icon: 'edit', message, input };
}

/** Add comment…: a note on the work item, which its row shows in a tooltip on line 2 (PRD R87). */
function commentControl(item: WorkItemView): Control {
  const input = { question: 'Add comment', detail: 'Shown on the work item only; it is not sent to the ticket.', field: 'text', action: 'Add' };

  return { label: 'Add comment…', icon: 'comment', message: { type: 'action', action: { type: 'comment', workItemId: item.id } }, input };
}

/**
 * The one control a Blocked on you, Ready for review or Unstarted row shows as a button, when one applies; every control is in its right-click
 * menu.
 */
export function mainControl(item: WorkItemView): Control | null {
  const group = groupOf(item);

  if (group === 'progress' || group === 'done') {
    return null;
  }

  const controls = controlsOf(item);

  // A prompt before the session starts, a permission prompt, or any wait of a Code Mode session is answered by attaching to it (PRD R41, R70, R95).
  if (isBackground(activeSession(item)) && waitsInTerminal(activeSession(item))) {
    return controls.find((control) => control.label === 'Open in terminal') ?? null;
  }

  // An ad-hoc or task work item's Start opens its prompt first (PRD R77).
  const wanted = item.status === 'unstarted' ? (ownPrompt(item) === null ? 'Start' : 'Start with prompt…') : item.status === 'awaiting-approval' ? 'Approve' : retries(item) ? 'Retry' : null;

  return controls.find((control) => control.label === wanted) ?? null;
}

/**
 * The main control's tooltip: Approve names the prompt it runs, so the operator can read the exact command before approving (PRD R27), and a
 * terminal control names a Code Mode session, which the row does not show (PRD R22).
 */
export function mainTitle(item: WorkItemView, control: Control): string {
  if (control.label === 'Approve' && item.approvalPrompt !== null) {
    return `Approve: runs ${item.approvalPrompt}`;
  }

  const latest = item.sessions.at(-1);

  // A held session runs without Code Mode when sessions.codeMode was off at its start, or a registered one ran without it (PRD R81, R93).
  return control.icon === 'terminal' && latest?.codeMode === true ? `${control.label}: attaches to the ${latest.withoutCodeMode === true || latest.registered === true ? 'session in the terminal holder' : 'Code Mode session'}` : control.label;
}

/** The controls that apply to a work item (PRD R27). */
export function controlsOf(item: WorkItemView): Control[] {
  const controls: Control[] = [];
  const session = activeSession(item);
  const action = (type: string) => ({ type: 'action', action: { type, workItemId: item.id } });

  if (item.status === 'unstarted') {
    const prompt = ownPrompt(item);

    controls.push({ label: 'Start', icon: 'play', message: action('start') }, prompt === null ? guidedStart(action('start'), item.playbook, item.playbookChoices) : promptedStart(action('start'), prompt));
  }

  if (item.status === 'awaiting-approval') {
    controls.push({ label: 'Approve', icon: 'check', message: action('approve') });
  }

  // The page reads each paste through `row-paste` and writes it to the clipboard (PRD R60).
  if (item.status === 'awaiting-approval' && item.pastes.length > 0) {
    controls.push({ label: 'Copy', icon: 'copy', message: { type: 'copy', pastes: item.pastes.map(({ label, file }) => ({ label, file })) } });
  }

  // Processes an ended Code Mode session left can keep it from resuming, so Stop session ends them (PRD R95).
  if (isBackground(session) || (session?.execution === 'app-server' && session.nativeSessionId !== null) || (session === null && (item.leftovers?.length ?? 0) > 0)) {
    controls.push({ label: 'Stop session', icon: 'debug-stop', message: action('stop') });
  }

  // Retries from the step that failed, or setup that stopped at a usage limit (PRD R34, R111).
  if (retries(item) && session === null) {
    controls.push({ label: 'Retry', icon: 'refresh', message: action('retry') });
  }

  if (item.status !== 'done') {
    controls.push({ label: 'Mark done', icon: 'pass', message: action('mark-done') });
  } else if (item.reopenable) {
    controls.push({ label: 'Reopen', icon: 'issue-reopened', message: action('reopen') });
  }

  if (item.status !== 'done' || item.ticket.snoozed) {
    controls.push(...snoozeControls(item.ticket));
  }

  controls.push(commentControl(item));

  // Runs in the item window, not the hub (PRD R57).
  if (item.worktree !== null) {
    controls.push({ label: 'Open changes', icon: 'diff-multiple', message: { type: 'changes', path: item.worktree.path, key: shownKey(item.ticket, undefined), title: item.ticket.title } });
  }

  const terminal = terminalCommand(item);

  if (terminal !== null) {
    controls.push({ label: 'Open in terminal', icon: 'terminal', message: terminal });
  }

  // A starting session has no short ID to stop yet, except a Code Mode one, which the hub ends in the terminal holder (PRD R120).
  const heldStart = session?.state === 'starting' && (session.codeMode === true || (session.execution === 'app-server' && session.nativeSessionId !== null));

  if (session?.state !== 'starting' || heldStart) {
    controls.push({ label: 'Delete', icon: 'trash', message: action('delete'), confirm: deleteConfirm(item, heldStart || isBackground(session)) });
  }

  return [...controls, historyControl(item.ticket)];
}

/** What Delete asks before it deletes the work item (PRD R120). */
function deleteConfirm(item: WorkItemView, stops: boolean): NonNullable<Control['confirm']> {
  const detail = [
    stops ? 'Its running session is stopped.' : null,
    `Switchboard deletes the work item, its sessions and its history. The ticket, its worktree and ${PROVIDER_NAMES[item.sessions.at(-1)?.provider ?? 'claude']}'s session files stay.`,
    item.ticket.source === 'adhoc' ? null : item.ticket.source === 'schedule' ? 'Its schedule makes the next work item at its next time or Run now.' : 'The ticket gets a new work item only when it is assigned to you again.',
  ];

  return { question: `Delete ${shownKey(item.ticket, undefined)}?`, detail: detail.filter((text) => text !== null).join(' '), action: 'Delete' };
}

/**
 * Open in terminal (PRD R28): a held Claude session's attach terminal, which opens in every state and resumes an ended session in the holder; Codex's
 * terminal app on an app-server thread; else `codex resume` once a Codex exec session has ended, since Codex has no attach (mechanics M31). Null
 * while a registered session lives in the operator's own window (PRD R81).
 */
export function terminalCommand(item: WorkItemView): Record<string, unknown> | null {
  const latest = item.sessions.at(-1) ?? null;
  const session = activeSession(item);
  const name = shownKey(item.ticket, undefined);

  if (latest?.codeMode === true) {
    return codeModeTerminal(item.ticket, latest);
  }
  if (latest?.execution === 'app-server' && latest.nativeSessionId !== null) {
    return { type: 'terminal', provider: 'codex', sessionId: latest.nativeSessionId, cwd: latest.cwd, name, shortId: null, active: false, execution: 'app-server' };
  }

  if (isBackground(session)) {
    return null;
  }

  // A session whose release stop has not finished may still run, and a registered one runs in the operator's window, which the terminal cannot
  // find (PRD R81).
  if (latest?.nativeSessionId == null || (session !== null && (session.state === 'starting' || !session.released || session.releasing || session.external === true))) {
    return null;
  }

  return { type: 'terminal', provider: latest.provider, sessionId: latest.nativeSessionId, cwd: latest.cwd, name, shortId: null, active: session !== null };
}

/**
 * A Code Mode session's attach terminal (PRD R95), which runs `hub.js attach <Switchboard session ID>` and resumes an ended session; the
 * Switchboard session ID, unlike the Claude one, survives `/clear`, `/branch` and `/resume`.
 */
export function codeModeTerminal(ticket: { source: string; sourceKey: string; repoRoot?: string }, session: Pick<SessionView, 'id' | 'cwd' | 'shortId'>): Record<string, unknown> {
  return { type: 'terminal', provider: 'claude', sessionId: session.id, cwd: session.cwd, name: shownKey(ticket, undefined), shortId: session.shortId, active: false, codeMode: true };
}

/**
 * Move to top, Move up and Move down for a Ready for review row, from its neighbours in `order`, the group's IDs in list order, and
 * Reset position when the operator has moved it (PRD R73).
 */
export function moveControls(item: WorkItemView, order: number[]): Control[] {
  const index = order.indexOf(item.id);
  const move = (after: number | null) => ({ type: 'action', action: { type: 'move', workItemId: item.id, after } });
  const controls: Control[] = [];

  if (index < 0) {
    return controls;
  }

  if (index > 0) {
    controls.push({ label: 'Move to top', icon: 'arrow-circle-up', message: move(null) });
    controls.push({ label: 'Move up', icon: 'arrow-up', message: move(index > 1 ? order[index - 2]! : null) });
  }

  if (index < order.length - 1) {
    controls.push({ label: 'Move down', icon: 'arrow-down', message: move(order[index + 1]!) });
  }

  if (item.orderAt !== null) {
    controls.push({ label: 'Reset position', icon: 'discard', message: { type: 'action', action: { type: 'reset-position', workItemId: item.id } } });
  }

  return controls;
}

/**
 * A pool row's controls: Start once triage has chosen a playbook, which the pick starts (PRD R48), or Triage again after a failed triage,
 * then Snooze, Unsnooze and History. `main` is the one the row shows as a button.
 */
export function poolControls(entry: PoolView): { main: Control | null; controls: Control[] } {
  const { ticket, triage } = entry;
  const pickMessage = { type: 'action', action: { type: 'pick', ticketId: ticket.id } };
  const pick: Control = { label: 'Start', icon: 'play', message: pickMessage };
  const again: Control = { label: 'Triage again', icon: 'search', message: { type: 'action', action: { type: 'retriage-pool', ticketId: ticket.id } } };
  const main = triage?.error != null ? again : triage?.playbook != null ? pick : null;
  const guided = main === pick ? [guidedStart(pickMessage, triage?.playbook ?? null, entry.playbookChoices)] : [];

  return { main, controls: [...(main === null ? [] : [main]), ...guided, ...snoozeControls(ticket), historyControl(ticket)] };
}

/** Every run the ticket has had, in a read-only document the extension opens (PRD R59). */
function historyControl(ticket: { id: number; source: string; sourceKey: string }): Control {
  return { label: 'History', icon: 'history', message: { type: 'history', ticketId: ticket.id, key: ticketKey(ticket) } };
}

type SessionView = WorkItemView['sessions'][number];

/**
 * A session Switchboard runs, held in the terminal holder or on Codex's app-server, including one whose end has not finished or failed, so Stop session
 * stays offered; a released session that is active is a registered one in the operator's own window (PRD R81).
 */
export function isBackground(session: SessionView | null): session is SessionView & { shortId: string } {
  return session !== null && session.state !== 'starting' && session.shortId !== null && (!session.released || session.releasing);
}

/**
 * A wait the operator answers by attaching to the session in a terminal: a prompt before it starts (PRD R41), a permission prompt (PRD R70), or
 * any wait of a held session or an app-server thread (PRD R95).
 */
function waitsInTerminal(session: SessionView | null): boolean {
  return waitsToStart(session) || waitsOnPermission(session) || ((session?.codeMode === true || session?.execution === 'app-server') && session.state === 'waiting');
}

/** How labels name each provider. */
export const PROVIDER_NAMES: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };


/**
 * Snooze… for a ticket, and Unsnooze when it is snoozed, so a snoozed ticket can take a new wake time without waking first (PRD R49).
 * Snooze… carries no wake time or comment: the page asks for them before it runs the action.
 */
function snoozeControls(ticket: { id: number; snoozed: boolean }): Control[] {
  const controls: Control[] = [{ label: 'Snooze…', icon: 'clockface', message: { type: 'action', action: { type: 'snooze', ticketId: ticket.id } } }];

  if (ticket.snoozed) {
    controls.push({ label: 'Unsnooze', icon: 'debug-restart', message: { type: 'action', action: { type: 'restore', ticketId: ticket.id } } });
  }

  return controls;
}

/** Character caps for the texts sessions report; the contract asks for less, and a longer text is cut here with its whole in the tooltip. */
export const CAPS = { state: 40, approval: 60, note: 80 } as const;

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
 * The row's time, by group (PRD R27): Blocked on you since the work item entered its status or its session began to wait, Ready for review
 * since it became ready, In progress since the run started, and Unstarted, Snoozed and Done since the ticket entered the source's scope,
 * stopping at done. A Done row shows its done time instead, with this in the tooltip.
 */
export function clockOf(item: WorkItemView): Clock {
  const group = groupOf(item);

  if (group === 'done') {
    // Never the ticket's scopeAt: a ticket that returned after the work item was done has a later one.
    return { since: item.scopeAt ?? item.createdAt, label: 'Yours from' };
  }

  if (item.ticket.snoozed || group === 'unstarted') {
    return { since: item.ticket.scopeAt ?? item.createdAt, label: 'Yours since' };
  }

  if (group === 'blocked') {
    const byStatus = item.status === 'blocked' || item.status === 'failed';

    const latest = item.sessions.at(-1);

    return !byStatus && latest !== undefined && waitsOnQuestion(item) ? { since: latest.stateAt, label: 'Waiting since' } : { since: item.statusAt, label: item.status === 'blocked' ? 'Blocked since' : item.status === 'failed' ? 'Failed since' : 'Waiting since' };
  }

  if (group === 'review') {
    return { since: item.readyAt!, label: 'Ready since' };
  }

  return { since: item.runStartedAt ?? item.statusAt, label: 'Started working' };
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

/** Local midnight on the Monday that starts the week of `time`. */
function weekStart(time: number): number {
  return midnight(time, -((new Date(time).getDay() + 6) % 7));
}

/** The start of Done's list: local midnight on the Monday two weeks before this week's, so Two weeks ago holds a whole week (PRD R27). */
export function doneSince(now: number): number {
  return midnight(weekStart(now), -14);
}

/** Done's date bands: Today, Yesterday, Earlier this week, Last week and Two weeks ago, with weeks starting on Monday (PRD R27). */
export function doneBand(doneAt: number, now: number): string {
  const today = midnight(now);
  const week = weekStart(now);

  if (doneAt >= today) {
    return 'Today';
  }

  if (doneAt >= midnight(now, -1)) {
    return 'Yesterday';
  }

  if (doneAt >= week) {
    return 'Earlier this week';
  }

  return doneAt >= midnight(week, -7) ? 'Last week' : 'Two weeks ago';
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

/** Priority: a customer blocked now, or high severity (PRD R50). */
export function isPriority(triage: Rating): boolean {
  return (triage?.immediacy != null && triage.immediacy !== 'NON-BLOCKING') || triage?.severity === 'HIGH';
}

/** The priority dot's tooltip on a priority ticket, or null (PRD R50). */
export function priorityTitle(triage: Rating): string | null {
  return isPriority(triage) ? `Immediacy: ${triage!.immediacy ?? '?'}   Severity: ${triage!.severity ?? '?'}` : null;
}

/** The playbook a row names: `<namespace>:triage` while triage runs, else the chosen playbook, an ad-hoc work item's origin, or empty before triage. */
export function playbookText(entry: WorkItemView | PoolView, namespaces: Record<string, string>): string {
  if ('status' in entry) {
    return entry.status === 'triaging' ? triageLabel(entry.ticket.source, namespaces) : (entry.playbook ?? (entry.ticket.source === 'adhoc' || entry.moved ? adhocLabel({ parentId: entry.parentId, prompted: entry.taskPrompt !== null, interactive: entry.interactive }, entry.ticket) : ''));
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

/**
 * The ticket's source and stored key, such as `gh 18941` or `gh acme/widgets-dashboard#63`. It does not change with labels, so it names
 * item windows' workspace files; rows show {@link shownKey}.
 */
export function ticketKey(ticket: { source: string; sourceKey: string; repoRoot?: string }): string {
  return `${sourceLabel(ticket.source)} ${ticket.sourceKey}`;
}

/** How rows shorten repository keys (PRD R27), from the hub's snapshot. */
export interface RepoKeys {
  /** Each source's home repository, `owner/name` in lowercase, or empty. */
  homes: Record<string, string>;
  /** Each other repository's short name: its label, such as `dash`, else its name when no other owner's repository shares it. */
  prefixes: Record<string, string>;
}

/**
 * An issue's key as rows show it (PRD R27): `<source label> <n>` in the source's home repository (`gh 18941`), `<prefix> <n>` in a repository
 * with a short name (`dash 63`, `widgets-dashboard 63`), else `owner/name#n`. A link names an issue in any source's home repository by that
 * source's label, the source's own first.
 */
export function issueKey(source: string, repo: string, number: string, keys: RepoKeys | undefined, link = false): string {
  const home = issueHome(source, repo, keys, link);
  const prefix = keys?.prefixes[repo];

  return home !== undefined ? `${sourceLabel(home)} ${number}` : prefix === undefined ? `${repo}#${number}` : `${prefix} ${number}`;
}

/** The source whose label {@link issueKey} names an issue by, a GitHub source, or undefined where a prefix or `owner/name` names it. */
export function issueHome(source: string, repo: string, keys: RepoKeys | undefined, link = false): string | undefined {
  if (keys === undefined) {
    return 'github';
  }

  return repo === (keys.homes[source] ?? '') ? source : link ? Object.keys(keys.homes).find((name) => repo !== '' && keys.homes[name] === repo) : undefined;
}

/** The ticket's key as rows show it: {@link issueKey} for another repository's issue, else {@link ticketKey}. */
export function shownKey(ticket: { source: string; sourceKey: string; repoRoot?: string }, keys: RepoKeys | undefined): string {
  if (ticket.source === 'adhoc' && ticket.repoRoot) {
    const folder = ticket.repoRoot.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || ticket.repoRoot;
    return `${folder} ${ticket.sourceKey}`;
  }
  const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ticket.sourceKey);

  return qualified === null || keys === undefined ? ticketKey(ticket) : issueKey(ticket.source, qualified[1]!, qualified[2]!, keys);
}

/**
 * The key {@link shownKey} gives without its source's label, such as `18941` for `gh 18941`, which the page shows after the source's logo;
 * null where the key starts otherwise: another repository's prefix or an ad hoc ticket's folder.
 */
export function shownNumber(ticket: { source: string; sourceKey: string; repoRoot?: string }, keys: RepoKeys | undefined): string | null {
  if (ticket.source === 'adhoc') {
    return null;
  }

  // As shownKey: the source's label shows only for a plain key or an issue in the source's home repository, whatever another repository's prefix is.
  const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ticket.sourceKey);

  if (qualified === null || keys === undefined) {
    return ticket.sourceKey;
  }

  return qualified[1] === (keys.homes[ticket.source] ?? '') ? qualified[2]! : null;
}

/** The repository, in lowercase, and number of a GitHub issue URL, or null. */
export function issueOfUrl(target: string): { repo: string; number: string } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/i.exec(target);

  return match === null ? null : { repo: match[1]!.toLowerCase(), number: match[2]! };
}

/** The prompt a session waits on before it starts (PRD R41), or a background session's permission prompt (PRD R70), for line 3. */
export function startPromptText(item: WorkItemView): { text: string; title: string }[] {
  const session = activeSession(item);
  // Tooltips name a Code Mode session, which the row does not show (PRD R22).
  const codeMode = session?.codeMode === true && session.withoutCodeMode !== true;

  if (waitsToStart(session)) {
    const before = codeMode ? 'Claude asks before the Code Mode session starts, such as to trust the folder.' : "Claude asks before the session starts, such as to approve the project's MCP servers.";

    return [{ text: 'Waits for you in its terminal before starting', title: `${before} Open in terminal to answer it.` }];
  }

  return isBackground(session) && waitsOnPermission(session)
    ? [{ text: 'Waits for your permission in its terminal', title: `Claude asks to approve a tool call${codeMode ? ' in the Code Mode session' : ''}. Open in terminal to answer it; stopping the session would drop the prompt.` }]
    : [];
}

/** Each reason a queued row has not started, with what ends it, for the tooltip (PRD R34). */
export function waitTexts(item: WorkItemView): { text: string; title: string }[] {
  return item.waits.map((wait) => {
    switch (wait.kind) {
      case 'slot':
        return { text: `Waits to start · ${wait.used} of ${wait.limit} sessions running`, title: `Switchboard starts at most ${wait.limit} sessions at once (Settings › Sessions); this one starts when fewer are running.` };
      case 'session': {
        const owner = wait.ownItem ? 'its session' : wait.playbook ?? 'the ad-hoc session';

        return { text: `Waits for ${owner} to finish its turn`, title: `Session ${wait.shortId ?? wait.sessionId} on this ticket is running or waiting on a question. This starts when its turn ends.` };
      }
      case 'snoozed':
        return { text: 'Starts after the snooze ends', title: 'The ticket is snoozed.' };
      case 'blockers':
        return { text: `Starts when ${refList(wait.blockers)} ${wait.blockers.length === 1 ? 'closes' : 'close'}`, title: blockersTitle(wait.blockers) };
      case 'limit':
        return { text: `Starts when the usage limit resets, ${limitTime(wait.until, null)}`, title: `A ${wait.provider === 'codex' ? 'Codex' : 'Claude'} session stopped at a usage limit, so new ${wait.provider === 'codex' ? 'Codex' : 'Claude'} sessions wait until it resets at ${limitTime(wait.until, null, true)}.` };
    }
  });
}

/** A limit in words: a usage limit waits for its quota to reset, a throttle for the provider to accept requests again. */
function limitWord(limit: { kind?: string }): string {
  return limit.kind === 'throttle' ? 'Rate limited' : 'Usage limit';
}

/** A limit's time (`timeAt`): `1:20 PM` on `now`'s day, else with the day, `Mon, Nov 30, 4:00 AM`, as `full` always gives it. */
export function limitTime(at: number, now: number | null, full = false): string {
  return timeAt(at, now ?? at, full || now === null ? 'dated' : 'auto');
}

/**
 * Line 3's limit text for a work item whose latest session stopped at a usage or rate limit (architecture.md § Rate limits): when it resumes, the
 * reset Claude Code waits for itself, else the hub's next attempt; for a background session, which the operator continues, when the limit resets.
 */
export function limitTexts(item: WorkItemView, now: number): { text: string; title: string }[] {
  const session = item.sessions.at(-1);
  const limit = session?.rateLimit;

  if (session === undefined || limit == null) {
    return [];
  }

  const held = session.codeMode === true || session.execution === 'app-server';
  const lines = [limit.message ?? (limit.kind === 'throttle' ? 'The provider is limiting requests.' : 'The session stopped at a usage limit.')];

  // A background session is released after its turn, so its blocked work item shows the reset until it passes.
  if (!held) {
    const next = session.kind === 'setup' ? 'Retry setup after the reset.' : 'Open the session after the reset to continue it.';

    return limit.resetsAt === null || limit.resetsAt <= now || item.status !== 'blocked' ? [] : [{ text: `${limitWord(limit)} · resets ${limitTime(limit.resetsAt, now)}`, title: [...lines, next].join('\n') }];
  }

  if (!waitsOnLimit(session)) {
    return [];
  }

  const attempts = limit.attempts === 0 ? [] : [`Switchboard sent continue ${limit.attempts} ${limit.attempts === 1 ? 'time' : 'times'}.`];

  if (limit.cli && limit.resetsAt !== null && limit.attempts === 0) {
    return [{ text: `${limitWord(limit)} · resumes ${limitTime(limit.resetsAt, now)}`, title: [...lines, `Claude Code continues on its own after the reset; Switchboard continues it at ${limitTime(limit.nextAt, now)} if it has not.`].join('\n') }];
  }

  const verb = limit.resetsAt === null || limit.attempts > 0 ? 'retries' : 'resumes';

  return [{ text: `${limitWord(limit)} · ${verb} ${limitTime(limit.nextAt, now)}`, title: [...lines, `Switchboard continues it at ${limitTime(limit.nextAt, now, true)}.`, ...attempts].join('\n') }];
}

/** The open issues blocking a ticket whose work has not queued, for line 3 of an open work item's or pool ticket's row (PRD R90). */
export function blockerTexts(ticket: { blockers?: TicketBlocker[] }, status: string | null): { text: string; title: string }[] {
  const blockers = ticket.blockers ?? [];

  // A queued row names them as a wait reason (waitTexts), and a done row needs no warning.
  return blockers.length === 0 || status === 'queued' || status === 'done' ? [] : [{ text: `${blockers.length === 1 ? 'Blocker' : 'Blockers'}: ${refList(blockers)}`, title: `${blockersTitle(blockers)}\nA start waits until ${blockers.length === 1 ? 'it closes' : 'they close'}.` }];
}

/** `#12`, `#12 and #15`, or `#12, #15 and #20`. */
function refList(blockers: TicketBlocker[]): string {
  const refs = blockers.map((blocker) => blocker.ref);

  return refs.length === 1 ? refs[0]! : `${refs.slice(0, -1).join(', ')} and ${refs.at(-1)!}`;
}

function blockersTitle(blockers: TicketBlocker[]): string {
  return ['Open issues that block this one:', ...blockers.map((blocker) => `${blocker.ref} ${blocker.title}`)].join('\n');
}

/**
 * The left stripe of an unsnoozed row on the operator's turn (PRD R27): `error` when failed, `warning` when blocked or asking a question,
 * `turn` when work waits for the operator's review or approval; null on the agent's turn and elsewhere.
 */
export function stripeOf(item: WorkItemView): 'error' | 'warning' | 'turn' | null {
  if (item.ticket.snoozed || turnOf(item) !== 'operator') {
    return null;
  }

  if (blocksOnYou(item)) {
    return item.status === 'failed' ? 'error' : 'warning';
  }

  return 'turn';
}

/** How long a running session goes without a state before the list colours the state's age (PRD R58). */
export const STALE_STATE_MS = 30 * 60_000;

/**
 * When a running work item's session last set a state, or began running if it has set none since: null unless the row is stale (PRD R58). A
 * state from before a new session or a wait does not count against the current run.
 */
export function staleSince(item: WorkItemView, now: number): number | null {
  const session = activeSession(item);

  if (!holdsSlot(item) || item.ticket.snoozed || session?.state !== 'running') {
    return null;
  }

  const since = Math.max(item.state?.at ?? -Infinity, item.runStartedAt ?? -Infinity, session.stateAt);

  return now - since >= STALE_STATE_MS ? since : null;
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

export const GROUP_TITLES: Record<RowGroup, string> = {
  blocked: 'Blocked on you',
  review: 'Ready for review',
  progress: 'In progress',
  unstarted: 'Unstarted',
  done: 'Done',
  snoozed: 'Snoozed',
};

/** What an empty group says; Blocked on you is hidden when empty, and Done and Snoozed say nothing. */
export const GROUP_EMPTY: Partial<Record<RowGroup, string>> = {
  review: 'Nothing to review. Finished work appears here for you to check.',
  progress: 'Nothing in progress. Work appears here while its session runs.',
  unstarted: 'Nothing to start. New work items wait here until their session starts.',
};

/** A row's `data-row` key: `item:<work item ID>` or `ticket:<pool ticket ID>`. */
export function rowKeyOf(entry: WorkItemView | PoolView): string {
  return 'status' in entry ? `item:${entry.id}` : `ticket:${entry.ticket.id}`;
}

/**
 * The rows the list shows, by group, each in list order (PRD R27, R49): Blocked on you oldest wait first, Ready for review by the
 * operator's position or readyAt, In progress oldest run first.
 */
export function listGroups(snapshot: Snapshot): Record<RowGroup, (WorkItemView | PoolView)[]> & { done: WorkItemView[] } {
  const groups: Record<Group, WorkItemView[]> = { blocked: [], review: [], progress: [], unstarted: [], done: [] };
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
    blocked: groups.blocked.sort((a, b) => clockOf(a).since - clockOf(b).since || a.id - b.id),
    review: groups.review.sort(reviewOrder),
    progress: groups.progress.sort((a, b) => clockOf(a).since - clockOf(b).since || a.id - b.id),
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

/**
 * The settings, playbook, hook and source errors as the bell's notices (PRD R42): none can be dismissed, since each clears once fixed.
 */
export function errorNotices(snapshot: Snapshot): Notice[] {
  const settings: NoticeAction = { kind: 'settings', label: 'Open Settings' };
  const error = (id: string, text: string, action?: NoticeAction): Notice => ({ id, class: 'action', text, dismiss: null, ...(action === undefined ? {} : { action }) });

  return [
    ...(snapshot.errors.settings === null ? [] : [error('settings', `Settings: ${snapshot.errors.settings}`, settings)]),
    ...snapshot.errors.playbooks.map((text) => error(`playbook:${text.split(': ')[0]}`, `Playbook ${text}`, settings)),
    ...(snapshot.errors.hooks === null ? [] : [error('hooks', `Hooks: ${snapshot.errors.hooks}`)]),
    ...Object.entries(snapshot.errors.sources).map(([name, text]) => error(`source:${name}`, `${name}: ${text}`, { kind: 'poll', label: 'Check again' })),
  ];
}

/** What an unconfigured home is missing, said plainly, as the bell's notices; each clears once configured. */
export function setupNotices(snapshot: Snapshot): Notice[] {
  // The path is joined with the separator the folder already uses.
  const settings = `${snapshot.configDir}${snapshot.configDir.includes('\\') ? '\\' : '/'}settings.json`;
  const open: NoticeAction = { kind: 'settings', label: 'Open Settings' };
  const notice = (id: string, text: string, action?: NoticeAction): Notice => ({ id, class: 'action', text, dismiss: null, ...(action === undefined ? {} : { action }) });

  return [
    ...(snapshot.sources.length > 0
      ? []
      : snapshot.sourceStates.length > 0
        ? [notice('setup:sources', 'No source is on. Turn one on in the list header.')]
        : [notice('setup:sources', `No source is configured. Add one in ${settings}.`, open)]),
    ...(snapshot.playbooks.length === 0 ? [notice('setup:playbooks', `No task playbooks are loaded. Add them under playbooks in ${settings}.`, open)] : []),
  ];
}

/** The row's linked GitHub pull requests and issues as `PR #<n>` and {@link issueKey}, as the row's menu names them (PRD R52). */
export function linkedKeys(entry: WorkItemView | PoolView, repoKeys?: RepoKeys): string[] {
  const keys = entry.links.flatMap((link) => {
    const kind = linkKind(link.target);
    const number = linkNumber(link.target);
    const issue = issueOfUrl(link.target);

    return kind === 'url' || number === null ? [] : [kind === 'pr' ? `PR #${number}` : issueKey(entry.ticket.source, issue?.repo ?? '', number, issue === null ? undefined : repoKeys, true)];
  });

  // A link to the ticket itself repeats its key.
  return [...new Set(keys)].filter((key) => key !== shownKey(entry.ticket, repoKeys));
}

/** What Go to Work Item matches besides the title and branch: the key, linked pull requests and issues, playbook and group (PRD R63). */
export function searchDescription(entry: WorkItemView | PoolView, group: RowGroup, namespaces: Record<string, string>, repoKeys?: RepoKeys): string {
  return [shownKey(entry.ticket, repoKeys), ...linkedKeys(entry, repoKeys), playbookText(entry, namespaces), GROUP_TITLES[group]].filter((part) => part !== '').join(' · ');
}
