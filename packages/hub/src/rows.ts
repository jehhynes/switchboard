import { activeSession, adhocLabel, blocksOnYou, groupOf, holdsSlot, ownPrompt, reviewOrder, triageLabel, turnOf, waitsOnPermission, waitsOnQuestion, waitsToStart } from '@switchboard/core/group';
import type { OpenVSCode, Provider, TicketBlocker } from '@switchboard/core';
import { waitsOnLimit } from '@switchboard/core/limit';
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
  /** A question the dock asks before it posts the message, with its detail and the label of the button that goes ahead. */
  confirm?: { question: string; detail: string; action: string };
  /**
   * A text the dock asks for before it posts the message, set as the action's `field`, with the label of the button that goes ahead and `text` in
   * the box at first; with `choice`, the dock also offers `values`, `value` selected, and sets a changed choice as the action's `choice.field`.
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
 * Start with guidance…: Start, after the dock asks for guidance that the task session's prompt ends with (PRD R77), and for the playbook when
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
  const input = { question: 'Add comment', detail: 'Switchboard keeps it with the work item and shows it on the row. It is not sent to the source.', field: 'text', action: 'Add' };

  return { label: 'Add comment…', icon: 'comment', message: { type: 'action', action: { type: 'comment', workItemId: item.id } }, input };
}

/** Answer in terminal: the row's click, which opens the session's terminal, in place of Open in Claude or Codex (PRD R70, R71). */
export const ANSWER_IN_TERMINAL: Control = { label: 'Answer in terminal', icon: 'terminal', message: { type: 'click' } };

/**
 * The one control a Blocked on you, Ready for review or Unstarted row shows as a button, when one applies; every control is in its right-click
 * menu. With `dock.openVSCode: review`, Answer in terminal replaces Open in Claude or Codex and a prompt before start's Open in terminal.
 */
export function mainControl(item: WorkItemView, mode: OpenVSCode = 'always'): Control | null {
  const group = groupOf(item);

  if (group === 'progress' || group === 'done') {
    return null;
  }

  const controls = controlsOf(item, mode);

  // A prompt before the session starts, a permission prompt, or any wait of a Code Mode session is answered by attaching to it (PRD R41, R70, R95).
  if (isBackground(activeSession(item)) && waitsInTerminal(activeSession(item))) {
    return mode === 'review' ? ANSWER_IN_TERMINAL : (controls.find((control) => control.label === 'Open in terminal') ?? null);
  }

  // A question the session waits on comes before an approval it reported earlier, as the row's mark does.
  if (waitsInBackground(activeSession(item))) {
    return controls.find((control) => control.message['type'] === 'open-question' || control === ANSWER_IN_TERMINAL) ?? null;
  }

  // An ad-hoc or task work item's Start opens its prompt first (PRD R77).
  const wanted = item.status === 'unstarted' ? (ownPrompt(item) === null ? 'Start' : 'Start with prompt…') : item.status === 'awaiting-approval' ? 'Approve' : item.status === 'failed' ? 'Retry' : null;

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

  return control.icon === 'terminal' && item.sessions.at(-1)?.codeMode === true ? `${control.label}: attaches to the Code Mode session` : control.label;
}

/** The controls that apply to a work item (PRD R27); with `dock.openVSCode: review`, Answer in terminal replaces Open in Claude or Codex. */
export function controlsOf(item: WorkItemView, mode: OpenVSCode = 'always'): Control[] {
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

  // Runs in the extension, which reads the file and writes the clipboard (PRD R60).
  if (item.status === 'awaiting-approval' && item.pastes.length > 0) {
    controls.push({ label: 'Copy', icon: 'copy', message: { type: 'copy', pastes: item.pastes.map(({ label, file }) => ({ label, file })) } });
  }

  const question = openQuestion(item);

  if (question !== null) {
    controls.push(mode === 'review' ? ANSWER_IN_TERMINAL : { label: `Open in ${PROVIDER_NAMES[question.provider]}`, icon: 'comment-discussion', message: question });
  }

  // Processes an ended Code Mode session left can keep it from resuming, so Stop ends them (PRD R95).
  if (isBackground(session) || (session?.execution === 'app-server' && session.nativeSessionId !== null) || (session === null && (item.leftovers?.length ?? 0) > 0)) {
    controls.push({ label: 'Stop', icon: 'debug-stop', message: action('stop') });
  }

  // Retries from the step that failed (PRD R34).
  if (item.status === 'failed' && session === null) {
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
    controls.push({ label: 'Open changes', icon: 'diff-multiple', message: { type: 'changes', path: item.worktree.path, key: ticketKey(item.ticket), title: item.ticket.title } });
  }

  const terminal = terminalCommand(item);

  if (terminal !== null) {
    controls.push({ label: 'Open in terminal', icon: 'terminal', message: terminal });
  }

  // A starting session has no short ID to stop yet, except a Code Mode one, which the hub ends in the terminal holder (PRD R76).
  const heldStart = session?.state === 'starting' && (session.codeMode === true || (session.execution === 'app-server' && session.nativeSessionId !== null));

  if (session?.state !== 'starting' || heldStart) {
    controls.push({ label: 'Delete', icon: 'trash', message: action('delete'), confirm: deleteConfirm(item, heldStart || isBackground(session)) });
  }

  return [...controls, historyControl(item.ticket)];
}

/** What Delete asks before it deletes the work item (PRD R76). */
function deleteConfirm(item: WorkItemView, stops: boolean): NonNullable<Control['confirm']> {
  const detail = [
    stops ? 'Its running session is stopped.' : null,
    `Switchboard deletes the work item, its sessions and its history. The ticket, its worktree and ${PROVIDER_NAMES[item.sessions.at(-1)?.provider ?? 'claude']}'s session files stay.`,
    item.ticket.source === 'adhoc' ? null : item.ticket.source === 'schedule' ? 'Its schedule makes the next work item at its next time or Run now.' : 'The ticket gets a new work item only when it is assigned to you again.',
  ];

  return { question: `Delete ${ticketKey(item.ticket)}?`, detail: detail.filter((text) => text !== null).join(' '), action: 'Delete' };
}

/**
 * Open in terminal (PRD R28): `claude attach` while a Claude session runs in its background process, else `claude --resume` or `codex resume`
 * once it has ended; Codex has no attach (mechanics M31). `active` marks a session the operator resumed, in a terminal or a VS Code tab, which is
 * shown rather than resumed again. Null while it starts, except for a Code Mode session, whose attach terminal opens in every state.
 */
export function terminalCommand(item: WorkItemView): Record<string, unknown> | null {
  const latest = item.sessions.at(-1) ?? null;
  const session = activeSession(item);
  const name = ticketKey(item.ticket);

  if (latest?.codeMode === true) {
    return codeModeTerminal(item.ticket, latest);
  }
  if (latest?.execution === 'app-server' && latest.nativeSessionId !== null) {
    return { type: 'terminal', provider: 'codex', sessionId: latest.nativeSessionId, cwd: latest.cwd, name, shortId: null, active: false, execution: 'app-server' };
  }

  if (isBackground(session)) {
    return session.provider === 'codex'
      ? null
      : { type: 'terminal', provider: session.provider, sessionId: session.nativeSessionId ?? session.shortId, cwd: session.cwd, name, shortId: session.shortId, active: false };
  }

  // A session whose release stop has not finished may still be held by its background process (PRD R39), and a registered one by the
  // operator's window, which the terminal cannot find (PRD R81).
  if (latest?.nativeSessionId == null || (session !== null && (session.state === 'starting' || !session.released || session.releasing || session.external === true))) {
    return null;
  }

  return { type: 'terminal', provider: latest.provider, sessionId: latest.nativeSessionId, cwd: latest.cwd, name, shortId: null, active: session !== null };
}

/**
 * A Code Mode session's attach terminal (PRD R95), which runs `hub.js attach <Switchboard session ID>` and resumes an ended session; the
 * Switchboard session ID, unlike the Claude one, survives `/clear`, `/branch` and `/resume`.
 */
export function codeModeTerminal(ticket: { source: string; sourceKey: string }, session: Pick<SessionView, 'id' | 'cwd' | 'shortId'>): Record<string, unknown> {
  return { type: 'terminal', provider: 'claude', sessionId: session.id, cwd: session.cwd, name: ticketKey(ticket), shortId: session.shortId, active: false, codeMode: true };
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
 * A session running in its background process, including one whose release stop has not finished or failed, so Stop stays offered; a released
 * session that is active again was resumed elsewhere, such as in a VS Code tab.
 */
export function isBackground(session: SessionView | null): session is SessionView & { shortId: string } {
  return session !== null && session.state !== 'starting' && session.shortId !== null && (!session.released || session.releasing);
}

/**
 * A session waiting on the operator in its background process, which Open in Claude or Codex stops and opens in a tab (PRD R70). While a fork
 * waits for its release (PRD R78) Stop is offered instead, as Open would open the retired copy; a hub older than forks sends no `pendingFork`.
 * A session waiting on a prompt before it starts has nothing to open in a tab yet (PRD R41), and stopping one that waits on a permission prompt
 * drops the prompt (PRD R70).
 */
function waitsInBackground(session: SessionView | null): session is SessionView & { shortId: string; nativeSessionId: string } {
  return isBackground(session) && session.state === 'waiting' && !waitsInTerminal(session) && session.nativeSessionId !== null && (session.pendingFork ?? null) === null;
}

/**
 * A wait the operator answers by attaching to the session in a terminal: a prompt before it starts (PRD R41), a permission prompt (PRD R70), or
 * any wait of a Code Mode session, because the Claude view refuses Code Mode (PRD R95).
 */
function waitsInTerminal(session: SessionView | null): boolean {
  return waitsToStart(session) || waitsOnPermission(session) || ((session?.codeMode === true || session?.execution === 'app-server') && session.state === 'waiting');
}

/**
 * Open in Claude or Codex: the hub stops the session, which then opens in the item window's view of its provider (PRD R70). A Codex session offers it
 * only while it waits on a question it reported, not on a permission prompt.
 */
export function openQuestion(item: WorkItemView): { type: 'open-question'; workItemId: number; sessionId: string; cwd: string; provider: Provider } | null {
  const session = activeSession(item);

  return waitsInBackground(session) && (session.provider !== 'codex' || session.question !== null) ? { type: 'open-question', workItemId: item.id, sessionId: session.nativeSessionId, cwd: session.cwd, provider: session.provider } : null;
}

/** How labels name each provider. */
export const PROVIDER_NAMES: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };


/**
 * Snooze… for a ticket, and Unsnooze when it is snoozed, so a snoozed ticket can take a new wake time without waking first (PRD R49).
 * Snooze… carries no wake time or comment: the dock asks for them in its snooze dialog before it posts the action.
 */
function snoozeControls(ticket: { id: number; snoozed: boolean }): Control[] {
  const controls: Control[] = [{ label: 'Snooze…', icon: 'clockface', message: { type: 'action', action: { type: 'snooze', ticketId: ticket.id } } }];

  if (ticket.snoozed) {
    controls.push({ label: 'Unsnooze', icon: 'debug-restart', message: { type: 'action', action: { type: 'restore', ticketId: ticket.id } } });
  }

  return controls;
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
    return { since: item.scopeAt ?? item.createdAt, label: 'In scope from' };
  }

  if (item.ticket.snoozed || group === 'unstarted') {
    return { since: item.ticket.scopeAt ?? item.createdAt, label: 'In scope since' };
  }

  if (group === 'blocked') {
    const byStatus = item.status === 'blocked' || item.status === 'failed';

    const latest = item.sessions.at(-1);

    return !byStatus && latest !== undefined && waitsOnQuestion(item) ? { since: latest.stateAt, label: 'Waiting since' } : { since: item.statusAt, label: 'In this status since' };
  }

  if (group === 'review') {
    return { since: item.readyAt!, label: 'Ready since' };
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

/** Priority, as the Support board derives it: a customer blocked now, or high severity (PRD R50). */
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
    return entry.status === 'triaging' ? triageLabel(entry.ticket.source, namespaces) : (entry.playbook ?? (entry.ticket.source === 'adhoc' || entry.moved ? adhocLabel({ parentId: entry.parentId, prompted: entry.taskPrompt !== null }, entry.ticket) : ''));
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
 * VS Code windows and workspace files; rows show {@link shownKey}.
 */
export function ticketKey(ticket: { source: string; sourceKey: string }): string {
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
  if (keys === undefined) {
    return `gh ${number}`;
  }

  const home = repo === (keys.homes[source] ?? '') ? source : link ? Object.keys(keys.homes).find((name) => repo !== '' && keys.homes[name] === repo) : undefined;
  const prefix = keys.prefixes[repo];

  return home !== undefined ? `${sourceLabel(home)} ${number}` : prefix === undefined ? `${repo}#${number}` : `${prefix} ${number}`;
}

/** The ticket's key as rows show it: {@link issueKey} for another repository's issue, else {@link ticketKey}. */
export function shownKey(ticket: { source: string; sourceKey: string }, keys: RepoKeys | undefined): string {
  const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ticket.sourceKey);

  return qualified === null || keys === undefined ? ticketKey(ticket) : issueKey(ticket.source, qualified[1]!, qualified[2]!, keys);
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
  const codeMode = session?.codeMode === true;

  if (waitsToStart(session)) {
    const before = codeMode ? 'Claude asks before the Code Mode session starts, such as to trust the folder.' : "Claude asks before the session starts, such as to approve the project's MCP servers.";

    return [{ text: 'Waits on a prompt before it starts', title: `${before} Open in terminal to answer it.` }];
  }

  return isBackground(session) && waitsOnPermission(session)
    ? [{ text: 'Waits on a permission prompt', title: `Claude asks to approve a tool call${codeMode ? ' in the Code Mode session' : ''}. Open in terminal to answer it; stopping the session would drop the prompt.` }]
    : [];
}

/** Each reason a queued row has not started, with what ends it, for the tooltip (PRD R34). */
export function waitTexts(item: WorkItemView): { text: string; title: string }[] {
  return item.waits.map((wait) => {
    switch (wait.kind) {
      case 'slot':
        return { text: `Waits for a slot · ${wait.used}/${wait.limit} in use`, title: `${wait.used} sessions are running; sessions.concurrency is ${wait.limit}.` };
      case 'session': {
        const owner = wait.ownItem ? 'its session' : `the ${wait.playbook ?? 'ad-hoc'} session`;

        return { text: `Waits for ${owner}'s turn to end`, title: `Session ${wait.shortId ?? wait.sessionId} on this ticket is running or waiting on a question. This starts when its turn ends.` };
      }
      case 'snoozed':
        return { text: 'Starts when the ticket wakes', title: 'The ticket is snoozed.' };
      case 'blockers':
        return { text: `Starts when ${refList(wait.blockers)} ${wait.blockers.length === 1 ? 'closes' : 'close'}`, title: blockersTitle(wait.blockers) };
      case 'limit':
        return { text: `Starts after the usage limit resets, ${limitTime(wait.until, null)}`, title: `A ${wait.provider === 'codex' ? 'Codex' : 'Claude'} session stopped at a usage limit, so new ${wait.provider === 'codex' ? 'Codex' : 'Claude'} sessions wait until it resets at ${limitTime(wait.until, null, true)}.` };
    }
  });
}

/** A limit's time: `1:20 PM` today, else with its weekday, `Mon 4:00 AM`; `full` gives the date too. */
export function limitTime(at: number, now: number | null, full = false): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  if (full) {
    return date.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  return now !== null && new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
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
    return limit.resetsAt === null || limit.resetsAt <= now || item.status !== 'blocked' ? [] : [{ text: `Rate limited · resets ${limitTime(limit.resetsAt, now)}`, title: [...lines, 'Open the session to continue it after the reset.'].join('\n') }];
  }

  if (!waitsOnLimit(session)) {
    return [];
  }

  const attempts = limit.attempts === 0 ? [] : [`Switchboard typed the continue text ${limit.attempts} ${limit.attempts === 1 ? 'time' : 'times'}.`];

  if (limit.cli && limit.resetsAt !== null && limit.attempts === 0) {
    return [{ text: `Rate limited · resumes ${limitTime(limit.resetsAt, now)}`, title: [...lines, `Claude Code continues on its own after the reset; Switchboard continues it at ${limitTime(limit.nextAt, now)} if it has not.`].join('\n') }];
  }

  const verb = limit.resetsAt === null || limit.attempts > 0 ? 'retries' : 'resumes';

  return [{ text: `Rate limited · ${verb} ${limitTime(limit.nextAt, now)}`, title: [...lines, `Switchboard continues it at ${limitTime(limit.nextAt, now, true)}.`, ...attempts].join('\n') }];
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

/** How long a running session goes without a stage report before the dock colours the stage age (PRD R58). */
export const STALE_STAGE_MS = 30 * 60_000;

/**
 * When a running work item's session last reported a stage, or began running if it has reported none since: null unless the row is
 * stale (PRD R58). A stage from before a new session or a wait does not count against the current run.
 */
export function staleSince(item: WorkItemView, now: number): number | null {
  const session = activeSession(item);

  if (!holdsSlot(item) || item.ticket.snoozed || session?.state !== 'running') {
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

export const GROUP_TITLES: Record<RowGroup, string> = {
  blocked: 'Blocked on you',
  review: 'Ready for review',
  progress: 'In progress',
  unstarted: 'Unstarted',
  done: 'Done',
  snoozed: 'Snoozed',
};

/** What an empty group says; Blocked on you is hidden when empty, and Done and Snoozed say nothing. */
export const GROUP_EMPTY: Partial<Record<RowGroup, string>> = { review: 'Nothing is ready for review.', progress: 'Nothing is in progress.', unstarted: 'Nothing waits to be started.' };

/** A row's `data-row` key: `item:<work item ID>` or `ticket:<pool ticket ID>`. */
export function rowKeyOf(entry: WorkItemView | PoolView): string {
  return 'status' in entry ? `item:${entry.id}` : `ticket:${entry.ticket.id}`;
}

/**
 * The rows the dock shows, by group, each in list order (PRD R27, R49): Blocked on you oldest wait first, Ready for review by the
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

/** The settings, playbook, hook and source errors the dock lists above the groups (PRD R42). */
export function snapshotErrors(snapshot: Snapshot): string[] {
  return [
    snapshot.errors.settings === null ? null : `Settings: ${snapshot.errors.settings}`,
    ...snapshot.errors.playbooks.map((error) => `Playbook ${error}`),
    snapshot.errors.hooks === null ? null : `Hooks: ${snapshot.errors.hooks}`,
    ...Object.entries(snapshot.errors.sources).map(([name, error]) => `${name}: ${error}`),
    ...(snapshot.notes ?? []),
  ].filter((line): line is string => line !== null);
}

/** What an unconfigured home is missing, said plainly. */
export function setupNotes(snapshot: Snapshot): string[] {
  // The webview bundles this module, so the path is joined with the separator the folder already uses, not node:path.
  const settings = `${snapshot.configDir}${snapshot.configDir.includes('\\') ? '\\' : '/'}settings.json`;

  return [
    snapshot.sources.length > 0
      ? null
      : snapshot.sourceStates.length > 0
        ? 'No source is polled. Turn one on in the header.'
        : `No source is configured. Add one in ${settings}.`,
    snapshot.playbooks.length === 0 ? `No task playbooks are loaded. Add them under playbooks in ${settings}.` : null,
  ].filter((line): line is string => line !== null);
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
