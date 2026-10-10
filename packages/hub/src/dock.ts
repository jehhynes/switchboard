import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { switchboardHome } from '@switchboard/core';
import { activeSession, MARK_GLYPHS, MARK_TITLES, markOf, turnOf } from '@switchboard/core/group';
import type { Mark } from '@switchboard/core/group';
import { snoozeChoices, wakeText } from '@switchboard/core/snooze';
import type { SnoozeChoice } from '@switchboard/core/snooze';
import {
  age,
  CAPS,
  clip,
  controlsOf,
  CONTROL_GLYPHS,
  doneBand,
  GROUP_EMPTY,
  GROUP_TITLES,
  linkKind,
  linkNumber,
  mainControl,
  mainTitle,
  moveControls,
  openQuestion,
  listGroups,
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
 * A work item's VS Code window (PRD R71). `name` names the workspace file and ends the window title, as `sb:<name>`, by which the
 * dock finds the window; `title` is the ticket title, which starts it. The first folder never changes for a name.
 */
export interface DockWindow {
  name: string;
  title: string;
  folders: string[];
  /** The window's `.code-workspace` file, `<Switchboard home>/windows/<name>.code-workspace`. */
  file: string;
}

/** Where the item windows' workspace files are, `<Switchboard home>/windows`. */
export function windowsDir(home: string): string {
  return join(switchboardHome(home), 'windows');
}

/**
 * The workspace file's text: the folders, and a `window.title` of the ticket title, the active editor and `sb:<name>`. VS Code reads every `$` in
 * a title as the start of a variable and drops the text up to a later `}`, so the ticket title's `$` becomes a fullwidth `＄`.
 */
export function workspaceText(window: DockWindow): string {
  const title = `${window.title.replaceAll('$', '＄')}\${separator}\${activeEditorShort}\${separator}sb:${window.name}`;

  return `${JSON.stringify({ folders: window.folders.map((path) => ({ path })), settings: { 'window.title': title, 'window.titleSeparator': ' · ' } }, null, 2)}\n`;
}

/** Writes a window's workspace file when its text differs, because VS Code applies any change to an open window; `written` caches what each file holds. */
export function writeWorkspaceFile(window: DockWindow, written: Map<string, string> = new Map()): void {
  const text = workspaceText(window);

  if (written.get(window.file) === text) {
    return;
  }

  let current: string | null = null;

  try {
    current = readFileSync(window.file, 'utf8');
  } catch {
    // A missing file is written.
  }

  if (current !== text) {
    const temporary = `${window.file}.${process.pid}.tmp`;

    mkdirSync(dirname(window.file), { recursive: true });
    writeFileSync(temporary, text);
    renameSync(temporary, window.file);
  }

  written.set(window.file, text);
}

/** What a click does besides the switch: Open in Claude first, a session to open in the window's Claude view, or the ticket in the browser for a row with no window. */
export type DockOpen =
  | { type: 'question'; workItemId: number; sessionId: string; cwd: string }
  | { type: 'session'; sessionId: string; cwd: string }
  | { type: 'url'; url: string };

export interface DockRow {
  /** `item:<work item ID>` or `ticket:<pool ticket ID>`. */
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
  /** The left stripe's colour (PRD R27): failed, blocked or asking, the operator's turn, or none on the agent's turn. */
  stripe: 'error' | 'warning' | 'turn' | null;
  /** Whose turn it is on an unsnoozed row in Blocked on you, Ready for review or In progress; null elsewhere. F8 visits `operator` rows (PRD R73). */
  turn: 'operator' | 'agent' | null;
  /** A Ready for review row on the agent's turn, which the dock dims (PRD R27). */
  dim: boolean;
  /** Ready for review rows can be dragged to a new place (PRD R73). */
  movable: boolean;
  window: DockWindow | null;
  open: DockOpen | null;
  /**
   * The hub controls in the right-click menu, each with its codicon glyph and the action the dock posts to `/action`; Snooze carries no wake time.
   * A control with `confirm` posts only after the operator confirms, such as Delete (PRD R76).
   */
  controls: { label: string; glyph: string; action: Record<string, unknown>; confirm?: { question: string; detail: string; action: string } }[];
  /** The label of the control the row shows as a button, or null (PRD R27). */
  main: string | null;
  /** The main control's codicon glyph, shown before its label, or null. */
  mainGlyph: string | null;
  /** The main control's tooltip, which for Approve names the prompt it runs (PRD R27). */
  mainTitle: string | null;
  /** A one-part question's options, each with the `answer` action it posts (PRD R70); empty otherwise. */
  answers: { label: string; description: string; action: Record<string, unknown> }[];
  /** The drafted texts Copy offers on an `awaiting-approval` row (PRD R60); empty otherwise. */
  pastes: { label: string; file: string }[];
  /** The controls that run in VS Code, each with the message a window runs: Open Changes, Open in terminal, History, Open report. */
  commands: { label: string; glyph: string; command: Record<string, unknown> }[];
  /** What the search box matches: the title, key, linked pull requests and issues, playbook, group and branch (PRD R63, R71). */
  search: string;
  /**
   * The ticket's links (PRD R52), a link to the ticket itself left out: `label` names it in the right-click menu (`PR #19002`, `gh 18941` or its
   * label); `badge` and `glyph` draw it as a badge on line 2, a pull request as its number after the pull request icon.
   */
  links: { label: string; url: string; kind: 'pr' | 'issue' | 'url'; badge: string; glyph: string | null }[];
  /** How many earlier work items with the same playbook were done, for "Returned ×N" on line 2 (PRD R51); 0 when it is not marked. */
  returned: number;
  /** A Done row's date band, such as `Today` or `Last week` (PRD R27); null in the other groups. */
  band: string | null;
}

export interface DockGroup {
  key: RowGroup;
  title: string;
  /** The group's codicon glyph, as the VS Code panel showed it. */
  glyph: string;
  /** What the group says when it has no rows, or null. */
  empty: string | null;
  /** Ready for review's rows on the operator's turn, which its header shows; null for the other groups. */
  yours: number | null;
  rows: DockRow[];
}

/** Everything the dock shows, sent whole on each change (PRD R71). */
export interface DockView {
  /** Settings, playbook, hook and source errors, then what an unconfigured home lacks. */
  notes: string[];
  groups: DockGroup[];
  /** Snooze's choices with their wake times, (PRD R49); the dock posts the chosen `until`. */
  snooze: SnoozeChoice[];
  /** Each configured source but ad-hoc and whether it is polled, for the header's toggles (PRD R3). */
  sources: { name: string; enabled: boolean }[];
  /** The repos an ad-hoc prompt can run in, the first being the default (PRD R6). */
  repoRoots: string[];
}

/** The rows by group and in list order, as texts the dock draws without rules of its own (PRD R27, R71). */
export function dockView(snapshot: Snapshot, now: number, windows: string): DockView {
  const groups = listGroups(snapshot);
  const keys: RowGroup[] = [
    'review',
    ...(groups.blocked.length === 0 ? [] : (['blocked'] as const)),
    'progress',
    'unstarted',
    ...(groups.snoozed.length === 0 ? [] : (['snoozed'] as const)),
    'done',
  ];
  const order = groups.review.map((entry) => (entry as WorkItemView).id);
  const row = (group: RowGroup) => (entry: WorkItemView | PoolView) => {
    const search = [entry.ticket.title, searchDescription(entry, group, snapshot.namespaces), 'status' in entry ? (entry.worktree?.branch ?? '') : ''].filter((part) => part !== '').join(' · ');

    // Done is sorted newest first, so each band's rows are consecutive.
    const band = group === 'done' && 'status' in entry ? doneBand(entry.doneAt ?? entry.createdAt, now) : null;

    const shown = 'status' in entry ? itemRow(entry, now, snapshot.namespaces, windows, group === 'review' ? order : null) : poolRow(entry, now, snapshot.namespaces);

    return { ...shown, search, links: linksOf(entry), returned: entry.returned, band };
  };
  const yours = (key: RowGroup) => (key === 'review' ? groups.review.filter((entry) => 'status' in entry && turnOf(entry) === 'operator').length : null);

  return {
    notes: [...snapshotErrors(snapshot), ...setupNotes(snapshot)],
    groups: keys.map((key) => ({ key, title: GROUP_TITLES[key], glyph: GROUP_GLYPHS[key], empty: GROUP_EMPTY[key] ?? null, yours: yours(key), rows: groups[key].map(row(key)) })),
    snooze: snoozeChoices(new Date(now)),
    sources: snapshot.sourceStates,
    repoRoots: snapshot.repoRoots,
  };
}

/** A work item's row; `order` is Ready for review's IDs in list order when the row is in that group, for its Move controls. */
function itemRow(item: WorkItemView, now: number, namespaces: Record<string, string>, windows: string, order: number[] | null): Omit<DockRow, 'search' | 'links' | 'returned' | 'band'> {
  const kind = markOf(item);
  const controls = order === null ? controlsOf(item) : [...controlsOf(item), ...moveControls(item, order)];
  const turn = item.ticket.snoozed ? null : turnOf(item);
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
    details: orMarkTitle(kind, [
      ...waitTexts(item).map(({ text, title }) => ({ text, title, tone: null })),
      ...wake(item.ticket),
      ...[item.warning, item.error].filter((note): note is string => note !== null).map((note) => clipped(note, CAPS.note, 'warning')),
      ...(item.parent === null ? [] : [{ text: `From ${ticketKey(item.parent)}`, title: item.parent.title, tone: null }]),
      ...progress(item, now),
    ]),
    stripe: stripeOf(item),
    turn,
    dim: order !== null && turn === 'agent',
    movable: order !== null,
    window: windowOf(item, windows),
    open: openOf(item, windows),
    controls: hubControls(controls),
    main: main?.label ?? null,
    mainGlyph: main === null ? null : CONTROL_GLYPHS[main.icon],
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
    commands: [...windowCommands(controls), ...(report === null ? [] : [{ label: 'Open report', glyph: CONTROL_GLYPHS['symbol-file'], command: { type: 'openUrl', url: report } }])],
  };
}

/** Line 3 with nothing but the mark names the mark in words, so the icon is never alone (PRD R27). */
function orMarkTitle(kind: Mark | null, details: DockText[]): DockText[] {
  return kind !== null && details.length === 0 ? [{ text: MARK_TITLES[kind], title: null, tone: null }] : details;
}

function poolRow(entry: PoolView, now: number, namespaces: Record<string, string>): Omit<DockRow, 'search' | 'links' | 'returned' | 'band'> {
  const { ticket, triage } = entry;
  const { main, controls } = poolControls(entry);
  const triaging = triage !== null && triage.endedAt === null;

  return {
    key: rowKeyOf(entry),
    title: ticket.title,
    priority: priorityTitle(triage),
    time: queuedTime(ticket.scopeAt === null ? null : { since: ticket.scopeAt, label: 'In scope since' }, null, now),
    playbook: playbookText(entry, namespaces),
    ticket: ticketKey(ticket),
    source: ticket.source,
    url: ticket.url,
    mark: triaging ? { kind: 'triaging', glyph: MARK_GLYPHS.triaging, title: MARK_TITLES.triaging } : null,
    details: orMarkTitle(triaging ? 'triaging' : null, [...wake(ticket), ...(triage?.error == null ? [] : [clipped(triage.error, CAPS.note, 'warning')])]),
    stripe: null,
    turn: null,
    dim: false,
    movable: false,
    window: null,
    open: ticket.url === '' ? null : { type: 'url', url: ticket.url },
    controls: hubControls(controls),
    main: main?.label ?? null,
    mainGlyph: main === null ? null : CONTROL_GLYPHS[main.icon],
    mainTitle: main?.label ?? null,
    answers: [],
    pastes: [],
    commands: windowCommands(controls),
  };
}

/** The ticket's links in the order reported, each once, named by its pull request or issue number when it has one (PRD R52). */
function linksOf(entry: WorkItemView | PoolView): DockRow['links'] {
  const seen = new Set<string>();

  return entry.links.flatMap((link): DockRow['links'] => {
    if (link.target === entry.ticket.url || seen.has(link.target)) {
      return [];
    }

    seen.add(link.target);

    const kind = linkKind(link.target);
    const number = linkNumber(link.target);
    if (kind === 'url' || number === null) {
      return [{ label: link.label, url: link.target, kind: 'url', badge: link.label, glyph: LINK_GLYPH }];
    }

    return kind === 'pr'
      ? [{ label: `PR #${number}`, url: link.target, kind, badge: number, glyph: PULL_REQUEST_GLYPH }]
      : [{ label: `gh ${number}`, url: link.target, kind, badge: `gh ${number}`, glyph: null }];
  });
}

function clipped(text: string, max: number, tone: DockText['tone'] = null): DockText {
  const { text: shown, full } = clip(text, max);

  return { text: shown, title: full, tone };
}

function wake(ticket: { snoozed: boolean; snoozedUntil: number | null }): DockText[] {
  return ticket.snoozed && ticket.snoozedUntil !== null ? [{ text: `Wakes ${wakeText(ticket.snoozedUntil)}`, title: null, tone: null }] : [];
}

/** The question, else the approval summary, else the stage, each with its age, for line 3 (PRD R27, R58, R70). */
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
export function windowOf(item: WorkItemView, windows: string): DockWindow | null {
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

  return { name, title: item.ticket.title, folders: worktree === null || inWorktree ? [first] : [first, worktree], file: join(windows, `${name}.code-workspace`) };
}

/**
 * What the item window opened from `file` shows in editor tabs (PRD R72), each once, for every work item whose window it is: `urls`, the tickets,
 * their other linked tickets and pages, then their pull requests, and `reports`, the approval reports of `awaiting-approval` work items.
 */
export function windowTabs(snapshot: Snapshot, file: string, windows: string): { urls: string[]; reports: string[] } {
  const items = snapshot.workItems.filter((item) => {
    const window = windowOf(item, windows);

    return window !== null && samePath(window.file, file);
  });
  const tickets = items.map((item) => item.ticket.url).filter((url) => url !== '');
  const links = items.flatMap((item) => item.links.map((link) => link.target).filter((target) => /^https?:\/\//i.test(target)));
  const reports = items.flatMap((item) => (item.status === 'awaiting-approval' && item.approvalReport !== null ? [item.approvalReport] : []));

  return {
    urls: [...new Set([...tickets, ...links.filter((link) => linkKind(link) !== 'pr'), ...links.filter((link) => linkKind(link) === 'pr')])],
    reports: [...new Set(reports)],
  };
}

/** Open in Claude while the background session waits on a question (PRD R70), else the latest session when it is not running in its background process. */
export function openOf(item: WorkItemView, windows: string): DockOpen | null {
  const question = openQuestion(item);

  if (question !== null) {
    return { type: 'question', workItemId: question.workItemId, sessionId: question.sessionId, cwd: question.cwd };
  }

  const latest = item.sessions.at(-1) ?? null;
  const active = activeSession(item);

  if (latest?.nativeSessionId != null && (active === null || active.released)) {
    return { type: 'session', sessionId: latest.nativeSessionId, cwd: latest.cwd };
  }

  // A row with no window opens its ticket (PRD R71).
  return windowOf(item, windows) === null && item.ticket.url !== '' ? { type: 'url', url: item.ticket.url } : null;
}

/** The controls the hub runs; Copy and the VS Code controls are in `pastes` and `commands` (PRD R71). */
function hubControls(controls: Control[]): DockRow['controls'] {
  return controls.flatMap((control) =>
    control.message['type'] === 'action'
      ? [{ label: control.label, glyph: CONTROL_GLYPHS[control.icon], action: control.message['action'] as Record<string, unknown>, ...(control.confirm === undefined ? {} : { confirm: control.confirm }) }]
      : [],
  );
}

/** The codicons of a pull request badge (git-pull-request) and of another link's badge (link). */
const PULL_REQUEST_GLYPH = '\u{ea64}';
const LINK_GLYPH = '\u{eb15}';

/** Each group's glyph: bell, eye, play-circle, inbox, pass and clockface. */
const GROUP_GLYPHS: Record<RowGroup, string> = { blocked: '\u{eaa2}', review: '\u{ea70}', progress: '\u{eba6}', unstarted: '\u{eb09}', done: '\u{eba4}', snoozed: '\u{ec75}' };

function normalPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * The controls a VS Code window runs (PRD R57, R59). Copy runs in the dock, from the row's pastes; Show in Source Control is left out, because the
 * item window's Source Control view already holds the worktree (PRD R71).
 */
function windowCommands(controls: Control[]): DockRow['commands'] {
  return controls.flatMap((control) => (['changes', 'terminal', 'history'].includes(String(control.message['type'])) ? [{ label: control.label, glyph: CONTROL_GLYPHS[control.icon], command: control.message }] : []));
}

function samePath(a: string, b: string): boolean {
  return normalPath(a) === normalPath(b);
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter((segment) => segment !== '').at(-1) ?? path;
}
