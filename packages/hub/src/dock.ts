import { createHash } from 'node:crypto';
import { activeSession, MARK_GLYPHS, MARK_TITLES, markOf } from '@switchboard/core/group';
import type { Mark } from '@switchboard/core/group';
import { snoozeChoices, wakeText } from '@switchboard/core/snooze';
import type { SnoozeChoice } from '@switchboard/core/snooze';
import {
  age,
  CAPS,
  clip,
  controlsOf,
  GROUP_EMPTY,
  GROUP_TITLES,
  mainControl,
  mainTitle,
  openQuestion,
  panelGroups,
  playbookText,
  poolControls,
  priorityTitle,
  queuedTime,
  rowKeyOf,
  rowTime,
  searchDescription,
  setupNotes,
  snapshotErrors,
  staleSince,
  stripeOf,
  ticketKey,
  waitTexts,
} from './rows.js';
import type { Control, RowGroup } from './rows.js';
import type { PoolView, Snapshot, WorkItemView } from './runtime.js';

/** A piece of a row's third line: its text, its tooltip, and `warning` or `error` to colour it. */
export interface DockText {
  text: string;
  title: string | null;
  tone: 'warning' | 'error' | null;
}

/**
 * A work item's VS Code window (PRD R71). `name` names the workspace file and starts the window title, as `sb:<name> · `, by which the
 * dock finds the window; `title` is that prefix and the ticket title. The first folder never changes for a name.
 */
export interface DockWindow {
  name: string;
  title: string;
  folders: string[];
}

/** What a click does besides the switch: Open in Claude first, a session to open in the window's Claude view, or the ticket in the browser for a row with no window. */
export type DockOpen =
  | { type: 'question'; workItemId: number; sessionId: string; cwd: string }
  | { type: 'session'; sessionId: string; cwd: string }
  | { type: 'url'; url: string };

export interface DockRow {
  /** `item:<work item ID>` or `ticket:<pool ticket ID>`, as the panel's `data-row`. */
  key: string;
  title: string;
  /** The priority dot's tooltip on a priority ticket, else null (PRD R50). */
  priority: string | null;
  /** The time in queue, or the done time on a Done row, with what it counts. */
  time: { text: string; title: string } | null;
  playbook: string;
  /** The source and key, such as `gh 18941`. */
  ticket: string;
  source: string;
  url: string;
  /** The mark, its codicon glyph and its meaning in words. */
  mark: { kind: Mark; glyph: string; title: string } | null;
  /** Line 3 after the mark: waits, wake time, warning and error, the parent, and the stage, approval summary or question. */
  details: DockText[];
  stripe: 'error' | 'warning' | null;
  window: DockWindow | null;
  open: DockOpen | null;
  /** The hub controls in the right-click menu, each with the action the dock posts to `/action`; Snooze carries no wake time. */
  controls: { label: string; action: Record<string, unknown> }[];
  /** The label of the control the row shows as a button, as in the panel, or null (PRD R27). */
  main: string | null;
  /** The main control's tooltip, which for Approve names the prompt it runs (PRD R27). */
  mainTitle: string | null;
  /** A one-part question's options, each with the `answer` action it posts (PRD R70); empty otherwise. */
  answers: { label: string; description: string; action: Record<string, unknown> }[];
  /** The drafted texts Copy offers on an `awaiting-approval` row (PRD R60); empty otherwise. */
  pastes: { label: string; file: string }[];
  /** The controls that run in VS Code, each with the message a window runs: Open Changes, History, Open report. */
  commands: { label: string; command: Record<string, unknown> }[];
  /** What the search box matches: the title, key, linked pull requests and issues, playbook, group and branch, as Go to Work Item (PRD R63). */
  search: string;
}

export interface DockGroup {
  key: RowGroup;
  title: string;
  /** What the group says when it has no rows, or null. */
  empty: string | null;
  rows: DockRow[];
}

/** Everything the dock shows, sent whole on each change (PRD R71). */
export interface DockView {
  /** Settings, playbook, hook and source errors, then what an unconfigured home lacks. */
  notes: string[];
  groups: DockGroup[];
  /** Snooze's choices with their wake times, as the panel's picker offers them (PRD R49); the dock posts the chosen `until`. */
  snooze: SnoozeChoice[];
  /** Each configured source but ad-hoc and whether it is polled, for the header's toggles (PRD R3). */
  sources: { name: string; enabled: boolean }[];
  /** The repos an ad-hoc prompt can run in, the first being the default (PRD R6). */
  repoRoots: string[];
}

/** The rows the panel shows, by group and in the panel's order, as texts the dock draws without rules of its own (PRD R27, R71). */
export function dockView(snapshot: Snapshot, now: number): DockView {
  const groups = panelGroups(snapshot);
  const keys: RowGroup[] = ['needs', 'working', 'unstarted', 'done', ...(groups.snoozed.length === 0 ? [] : (['snoozed'] as const))];
  const row = (group: RowGroup) => (entry: WorkItemView | PoolView) => {
    const search = [entry.ticket.title, searchDescription(entry, group, snapshot.namespaces), 'status' in entry ? (entry.worktree?.branch ?? '') : ''].filter((part) => part !== '').join(' · ');

    return { ...('status' in entry ? itemRow(entry, now, snapshot.namespaces) : poolRow(entry, now, snapshot.namespaces)), search };
  };

  return {
    notes: [...snapshotErrors(snapshot), ...setupNotes(snapshot)],
    groups: keys.map((key) => ({ key, title: GROUP_TITLES[key], empty: GROUP_EMPTY[key] ?? null, rows: groups[key].map(row(key)) })),
    snooze: snoozeChoices(new Date(now)),
    sources: snapshot.sourceStates,
    repoRoots: snapshot.repoRoots,
  };
}

function itemRow(item: WorkItemView, now: number, namespaces: Record<string, string>): Omit<DockRow, 'search'> {
  const kind = markOf(item);
  const controls = controlsOf(item);
  const question = item.question ?? null;
  const sessionId = activeSession(item)?.nativeSessionId ?? null;
  const report = item.status === 'awaiting-approval' ? item.approvalReport : null;
  const main = mainControl(item);

  return {
    key: rowKeyOf(item),
    title: item.ticket.title,
    priority: priorityTitle(item.triage),
    time: rowTime(item, now),
    playbook: playbookText(item, namespaces),
    ticket: ticketKey(item.ticket),
    source: item.ticket.source,
    url: item.ticket.url,
    mark: kind === null ? null : { kind, glyph: MARK_GLYPHS[kind], title: MARK_TITLES[kind] },
    details: [
      ...waitTexts(item).map(({ text, title }) => ({ text, title, tone: null })),
      ...wake(item.ticket),
      ...[item.warning, item.error].filter((note): note is string => note !== null).map((note) => clipped(note, CAPS.note, 'warning')),
      ...(item.parent === null ? [] : [{ text: `From ${ticketKey(item.parent)}`, title: item.parent.title, tone: null }]),
      ...progress(item, now),
    ],
    stripe: stripeOf(item),
    window: windowOf(item),
    open: openOf(item),
    controls: hubControls(controls),
    main: main?.label ?? null,
    mainTitle: main === null ? null : mainTitle(item, main),
    answers:
      question !== null && question.parts === 1 && sessionId !== null
        ? question.options.map((option) => ({
            label: option.label,
            description: option.description,
            action: { type: 'answer', workItemId: item.id, nativeSessionId: sessionId, question: question.text, answer: option.label },
          }))
        : [],
    pastes: item.status === 'awaiting-approval' ? item.pastes.map(({ label, file }) => ({ label, file })) : [],
    commands: [...windowCommands(controls), ...(report === null ? [] : [{ label: 'Open report', command: { type: 'openUrl', url: report } }])],
  };
}

function poolRow(entry: PoolView, now: number, namespaces: Record<string, string>): Omit<DockRow, 'search'> {
  const { ticket, triage } = entry;
  const { main, controls } = poolControls(entry);

  return {
    key: rowKeyOf(entry),
    title: ticket.title,
    priority: priorityTitle(triage),
    time: queuedTime(ticket.scopeAt === null ? null : { since: ticket.scopeAt, label: 'In scope since' }, null, now),
    playbook: playbookText(entry, namespaces),
    ticket: ticketKey(ticket),
    source: ticket.source,
    url: ticket.url,
    mark: triage !== null && triage.endedAt === null ? { kind: 'triaging', glyph: MARK_GLYPHS.triaging, title: MARK_TITLES.triaging } : null,
    details: [...wake(ticket), ...(triage?.error == null ? [] : [clipped(triage.error, CAPS.note, 'warning')])],
    stripe: null,
    window: null,
    open: ticket.url === '' ? null : { type: 'url', url: ticket.url },
    controls: hubControls(controls),
    main: main?.label ?? null,
    mainTitle: main?.label ?? null,
    answers: [],
    pastes: [],
    commands: windowCommands(controls),
  };
}

function clipped(text: string, max: number, tone: DockText['tone'] = null): DockText {
  const { text: shown, full } = clip(text, max);

  return { text: shown, title: full, tone };
}

function wake(ticket: { snoozed: boolean; snoozedUntil: number | null }): DockText[] {
  return ticket.snoozed && ticket.snoozedUntil !== null ? [{ text: `Wakes ${wakeText(ticket.snoozedUntil)}`, title: null, tone: null }] : [];
}

/** The question, else the approval summary, else the stage, each with its age, as the panel's line 3 shows them (PRD R27, R58, R70). */
function progress(item: WorkItemView, now: number): DockText[] {
  const question = item.question ?? null;

  if (question !== null) {
    return [clipped(question.text, CAPS.question)];
  }

  const summary = item.status === 'awaiting-approval' ? item.approvalSummary : null;

  if (summary !== null) {
    const whole = summary.charAt(0).toUpperCase() + summary.slice(1);
    const { text, full } = clip(whole, CAPS.approval);

    return [{ text: `${text} · ${age(item.statusAt, now)}`, title: item.stage === null ? full : `${whole}\nLast stage: ${item.stage}`, tone: null }];
  }

  const stale = staleSince(item, now);
  const staleTitle = stale === null ? null : `No stage report for ${age(stale, now)}`;

  if (item.stage === null) {
    return stale === null ? [] : [{ text: `No stage report · ${age(stale, now)}`, title: staleTitle, tone: 'warning' }];
  }

  const { text, full } = clip(item.stage, CAPS.stage);
  const since = item.stageAt === null ? '' : ` · ${age(item.stageAt, now)}`;

  return [{ text: `${text}${since}`, title: staleTitle ?? full, tone: stale === null ? null : 'warning' }];
}

/**
 * The work item's window: the latest session's folder first, else the worktree, with the worktree second when the session ran
 * elsewhere; null with neither. The name is the ticket key, the first folder's name when that folder is not the worktree, and a hash of the first folder.
 */
export function windowOf(item: WorkItemView): DockWindow | null {
  const first = item.sessions.at(-1)?.cwd ?? item.worktree?.path ?? null;

  if (first === null || first === '') {
    return null;
  }

  const worktree = item.worktree?.path ?? null;
  const inWorktree = worktree !== null && samePath(first, worktree);
  // The hash names the first folder, so a window's first folder never changes: another folder, or a moved worktree, gets another window.
  const hash = createHash('sha256').update(normalPath(first)).digest('hex').slice(0, 6);
  const key = `${ticketKey(item.ticket).replace(' ', '-')}${inWorktree ? '' : `-${folderName(first)}`}-${hash}`;
  const name = key.replace(/[^A-Za-z0-9._-]+/g, '-');

  return { name, title: `sb:${name} · ${item.ticket.title}`, folders: worktree === null || inWorktree ? [first] : [first, worktree] };
}

/** Open in Claude while the background session waits on a question (PRD R70), else the latest session when it is not running in its background process. */
function openOf(item: WorkItemView): DockOpen | null {
  const question = openQuestion(item);

  if (question !== null) {
    return { type: 'question', workItemId: question.workItemId, sessionId: question.sessionId, cwd: question.cwd };
  }

  const latest = item.sessions.at(-1) ?? null;
  const active = activeSession(item);

  if (latest?.nativeSessionId != null && (active === null || active.released)) {
    return { type: 'session', sessionId: latest.nativeSessionId, cwd: latest.cwd };
  }

  // A row with no window opens its ticket, as the panel's click does (PRD R27).
  return windowOf(item) === null && item.ticket.url !== '' ? { type: 'url', url: item.ticket.url } : null;
}

/** The controls the hub runs; the panel's extension-run controls stay in the panel for now (PRD R71). */
function hubControls(controls: Control[]): DockRow['controls'] {
  return controls.flatMap((control) => (control.message['type'] === 'action' ? [{ label: control.label, action: control.message['action'] as Record<string, unknown> }] : []));
}

function normalPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * The controls a VS Code window runs (PRD R57, R59). Copy runs in the dock, from the row's pastes; Show in Source Control is left out, because the
 * item window's Source Control view already holds the worktree (PRD R71).
 */
function windowCommands(controls: Control[]): DockRow['commands'] {
  return controls.flatMap((control) => (['changes', 'history'].includes(String(control.message['type'])) ? [{ label: control.label, command: control.message }] : []));
}

function samePath(a: string, b: string): boolean {
  return normalPath(a) === normalPath(b);
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter((segment) => segment !== '').at(-1) ?? path;
}
