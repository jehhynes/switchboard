import type { SourceIcon } from '@switchboard/core';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { isFolderHost, stateStale, switchboardHome } from '@switchboard/core';
import type { Provider, PullRequestStatus } from '@switchboard/core';
import { activeSession, MARK_GLYPHS, MARK_TITLES, markOf, turnOf } from '@switchboard/core/group';
import type { Mark } from '@switchboard/core/group';
import { snoozeChoices, wakeText } from '@switchboard/core/snooze';
import type { SnoozeChoice } from '@switchboard/core/snooze';
import { heldTexts } from './held.js';
import type { HeldSession } from './held.js';
import { noticeHash } from './notices.js';
import type { InfoNotice, Notice } from './notices.js';
import {
  age,
  CAPS,
  clip,
  controlsOf,
  isBackground,
  CONTROL_GLYPHS,
  doneBand,
  GROUP_EMPTY,
  GROUP_TITLES,
  linkKind,
  linkNumber,
  mainControl,
  mainTitle,
  moveControls,
  listGroups,
  playbookText,
  poolControls,
  priorityTitle,
  queuedTime,
  rowKeyOf,
  rowTime,
  searchDescription,
  errorNotices,
  setupNotices,
  staleSince,
  startPromptText,
  stripeOf,
  terminalCommand,
  ticketKey,
  shownKey,
  shownNumber,
  issueKey,
  issueHome,
  issueOfUrl,
  waitTexts,
  limitTexts,
  blockerTexts,
} from './rows.js';
import type { Control, RepoKeys, RowGroup } from './rows.js';
import type { PoolView, Snapshot, WorkItemView } from './runtime.js';

/** A piece of a row's third line: its text, its tooltip, and `warning` or `error` to colour it. */
export interface DockText {
  text: string;
  title: string | null;
  /** `dim`: a state whose turn or session has ended (architecture.md § States). */
  tone: 'warning' | 'error' | 'dim' | null;
}

/**
 * A work item's VS Code window (PRD R71). `name` names the workspace file and ends the window title, as `sb:<name>`, which tells the
 * window apart; `title` is the ticket title, which starts it. The first folder never changes for a name.
 */
export interface DockWindow {
  name: string;
  title: string;
  folders: string[];
  /** The window's `.code-workspace` file, `<Switchboard home>/windows/<name>.code-workspace`; null for a folder window, which has none. */
  file: string | null;
  /** A hosted conversation's host window (architecture.md § Hosted conversations), whose file its primary work item writes, not this row. */
  hosted?: true;
  /**
   * A folder-hosted conversation's host: the folder window's canonical folder, opened with `code <folder>` and reached only by a folder window on
   * it, never by an item window that holds the folder. Set only when `file` is null.
   */
  folder?: string;
}

/** Where the item windows' workspace files are, `<Switchboard home>/windows`. */
export function windowsDir(home: string): string {
  return join(switchboardHome(home), 'windows');
}

/**
 * The workspace file's text: the folders, a `window.title` of the ticket title, the active editor and `sb:<name>`, and
 * `extensions.ignoreRecommendations`, because VS Code keeps a dismissed recommendation prompt per workspace, so each new item window would
 * ask again (M50). VS Code reads every `$` in a title as the start of a variable and drops the text up to a later `}`, so the ticket title's
 * `$` becomes a fullwidth `＄`.
 */
export function workspaceText(window: DockWindow): string {
  const title = `${window.title.replaceAll('$', '＄')}\${separator}\${activeEditorShort}\${separator}sb:${window.name}`;

  return `${JSON.stringify({ folders: window.folders.map((path) => ({ path })), settings: { 'window.title': title, 'window.titleSeparator': ' · ', 'extensions.ignoreRecommendations': true } }, null, 2)}\n`;
}

/** Writes a window's workspace file when its text differs, because VS Code applies any change to an open window; `written` caches what each file holds. */
export function writeWorkspaceFile(window: DockWindow, written: Map<string, string> = new Map()): void {
  const text = workspaceText(window);
  const file = window.file;

  // A folder window has no workspace file to write.
  if (file === null || written.get(file) === text) {
    return;
  }

  let current: string | null = null;

  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // A missing file is written.
  }

  if (current !== text) {
    const temporary = `${file}.${process.pid}.tmp`;

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  }

  written.set(file, text);
}

/**
 * A session's terminal window (PRD R28, R71): `args` for the agent's CLI, which the hub names in `executable` when it sends the view; `name` is
 * the window's `sb:` name, one per session; `handoff` is the Open in Codex stop that runs first (PRD R70); `active` marks a session resumed
 * elsewhere, whose terminal is only brought forward, else its item window opens it.
 */
export interface DockTerminal {
  provider: Provider;
  sessionId: string;
  cwd: string;
  args: string[];
  name: string;
  title: string;
  handoff: { workItemId: number; sessionId: string } | null;
  active: boolean;
  /** A Code Mode session's attach terminal (PRD R95); the hub runs `hub.js` with `sessions.nodePath`. */
  codeMode?: true;
  execution?: 'app-server';
  executable?: string;
}

/**
 * A row of the held sessions window (PRD R94): the work item's key or `No work item`, the session IDs, folder, state, idle time, memory and
 * attached terminals; `terminal` opens its attach terminal in the terminal app, null for an orphan, which no session of the store names.
 */
export interface DockHeld {
  session: string;
  item: string;
  nativeSessionId: string;
  cwd: string;
  state: string;
  idle: string;
  memory: string;
  clients: number;
  orphan: boolean;
  /** The process has exited, whatever state the store still holds; Stop is then refused. */
  exited: boolean;
  terminal: DockTerminal | null;
}

/**
 * What a click does besides the switch: Open in Claude or Codex first, a session to open in the window's view of its provider, or the ticket in
 * the browser for a row with no window.
 */
export type DockOpen =
  | { type: 'question'; workItemId: number; sessionId: string; cwd: string; provider: Provider }
  | { type: 'session'; sessionId: string; cwd: string; provider: Provider }
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
  /** The source's plugin, such as `github`, which picks its icon; the source's name when it is no longer configured. */
  sourceKind: string;
  /**
   * The key without its source's label, such as `18941` for `gh 18941`, which the page shows after the source's logo; null where the key starts
   * otherwise, as another repository's prefix or an ad hoc ticket's folder does.
   */
  ticketNumber: string | null;
  url: string;
  /** The mark, its codicon glyph and its meaning in words. */
  mark: { kind: Mark; glyph: string; title: string } | null;
  /** Line 3 after the mark: waits, wake time, warning and error, the parent, and the stage or approval summary. */
  details: DockText[];
  /** The left stripe's colour (PRD R27): failed, blocked or asking, the operator's turn, or none on the agent's turn. */
  stripe: 'error' | 'warning' | 'turn' | null;
  /** Whose turn it is on an unsnoozed active row; null for idle hosted conversations and other groups. F8 visits `operator` rows (PRD R73). */
  turn: 'operator' | 'agent' | null;
  /** A Ready for review row on the agent's turn, which the list dims (PRD R27). */
  dim: boolean;
  /** Ready for review rows can be dragged to a new place (PRD R73). */
  movable: boolean;
  window: DockWindow | null;
  open: DockOpen | null;
  /** The terminal app window Open in terminal opens (PRD R28); null when the row offers none. */
  terminal: DockTerminal | null;
  /**
   * The hub controls in the right-click menu, each with its codicon glyph and the action it runs; Snooze carries no wake time.
   * A control with `confirm` posts only after the operator confirms, such as Delete (PRD R120); one with `input` posts the text the operator
   * enters as the action's `field`, such as Start with guidance… (PRD R77), and with `choice`, a changed choice as the action's `choice.field`,
   * such as Start with guidance…'s playbook (PRD R35).
   */
  controls: {
    label: string;
    glyph: string;
    action: Record<string, unknown>;
    confirm?: { question: string; detail: string; action: string };
    input?: NonNullable<Control['input']>;
    /** The submenu it is listed in, such as `Persona`, and whether it is checked there (architecture.md § Personas). */
    group?: string;
    checked?: boolean;
  }[];
  /** The label of the control the row shows as a button, or null (PRD R27). */
  main: string | null;
  /** The main control's codicon glyph, shown before its label, or null. */
  mainGlyph: string | null;
  /** The main control's tooltip, which for Approve names the prompt it runs (PRD R27). */
  mainTitle: string | null;
  /** The drafted texts Copy offers on an `awaiting-approval` row (PRD R60); empty otherwise. */
  pastes: { label: string; file: string }[];
  /** The row's controls that open something rather than run a hub action, each with its message: Open changes, History, Open report. */
  commands: { label: string; glyph: string; command: Record<string, unknown> }[];
  /** What the search box matches: the title, key, linked pull requests and issues, playbook, group and branch (PRD R63, R71). */
  search: string;
  /**
   * The ticket's links (PRD R52), a link to the ticket itself left out: `label` names it in the right-click menu (`PR #19002`, `gh 18941` or its
   * label); `badge` and `glyph` draw it as a badge on line 2, a pull request as its number after the pull request icon, an issue after GitHub's mark as its number, which `label`
   * names with a GitHub source's label (`gh 18941`), or as its key where a repository's prefix starts it. A `mentioned` link,
   * found in the ticket's text (PRD R61), follows the others and is drawn muted. A pull request its source has read carries `pr`, its state,
   * review decision and checks (PRD R92).
   */
  links: { label: string; url: string; kind: 'pr' | 'issue' | 'url'; badge: string; glyph: string | null; mentioned: boolean; pr?: PullRequestStatus }[];
  /** How many earlier work items with the same playbook, or one it is a return of, were done, for the return icon and count on line 2 (PRD R51); 0 when it is not marked. */
  returned: number;
  /** The comment icon on line 2, with the work item's comments, oldest first, as its tooltip (PRD R87); null without comments. */
  comment: { glyph: string; title: string } | null;
  /** A Done row's date band, such as `Today` or `Last week` (PRD R27); null in the other groups. */
  band: string | null;
}

export interface DockGroup {
  key: RowGroup;
  title: string;
  /** The group's codicon glyph. */
  glyph: string;
  /** What the group says when it has no rows, or null. */
  empty: string | null;
  rows: DockRow[];
}

/** Everything the list view holds, built whole on each change (PRD R71). */
export interface DockView {
  /**
   * The bell's notices but the voice's, which the hub adds (architecture.md § Web page, List header): settings, playbook, hook and source
   * errors, what an unconfigured home lacks, background sessions without a work item, and the terminal holder's.
   */
  notices: Notice[];
  /** One-time notices, which go to the pages as a toast: a holder restart that went well. */
  info: InfoNotice[];
  groups: DockGroup[];
  /** Snooze's choices with their wake times, (PRD R49); the chosen one's `until` goes with the action. */
  snooze: SnoozeChoice[];
  /** The configured sources but ad-hoc, by kind in order of first appearance, for the header's icons (PRD R3, R71). */
  sources: DockSourceGroup[];
  /** The repos an ad-hoc prompt can run in, the first being the default (PRD R6). */
  repoRoots: string[];
  /** The schedules the New session form can run now (PRD R82). */
  schedules: { name: string; playbook: string }[];
  /** The snapshot's held sessions, orphans first (PRD R94); absent when the holder holds none. */
  held?: DockHeld[];
}

/** The rows by group and in list order, as texts the list draws without rules of its own (PRD R27, R71). */
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
  // Done is sorted newest first, so each band's rows are consecutive.
  const row = (group: RowGroup) => (entry: WorkItemView | PoolView) =>
    dockRow(snapshot, entry, group, now, windows, group === 'review' ? order : null, group === 'done' && 'status' in entry ? doneBand(entry.doneAt ?? entry.createdAt, now) : null);

  return {
    ...noticesOf(snapshot),
    groups: keys.map((key) => ({ key, title: GROUP_TITLES[key], glyph: GROUP_GLYPHS[key], empty: GROUP_EMPTY[key] ?? null, rows: groups[key].map(row(key)) })),
    snooze: snoozeChoices(new Date(now)),
    sources: sourceGroups(snapshot.sourceStates),
    repoRoots: snapshot.repoRoots,
    schedules: snapshot.schedules,
    ...(snapshot.held === undefined ? {} : { held: snapshot.held.map((one) => heldRow(snapshot, one, now, windows)) }),
  };
}

/** What the search box matches in a row: the title, key, linked pull requests and issues, playbook, group and branch (PRD R63). */
export function searchText(entry: Pick<WorkItemView, 'ticket' | 'links' | 'status' | 'playbook' | 'parentId' | 'taskPrompt' | 'moved' | 'worktree'> | PoolView, group: RowGroup, snapshot: Pick<Snapshot, 'namespaces' | 'repoKeys'>): string {
  return [entry.ticket.title, searchDescription(entry as WorkItemView | PoolView, group, snapshot.namespaces, snapshot.repoKeys), 'status' in entry ? (entry.worktree?.branch ?? '') : ''].filter((part) => part !== '').join(' · ');
}

/** A row of `group` as the list draws it; `order` is Ready for review's IDs in list order when the row is in that group. */
export function dockRow(snapshot: Snapshot, entry: WorkItemView | PoolView, group: RowGroup, now: number, windows: string, order: number[] | null, band: string | null): DockRow {
  const kind = snapshot.sourceStates.find((source) => source.name === entry.ticket.source)?.kind;
  const shown = 'status' in entry ? itemRow(entry, now, snapshot.namespaces, windows, order, snapshot.repoKeys) : poolRow(entry, now, snapshot.namespaces);

  return { ...shown, ticket: shownKey(entry.ticket, snapshot.repoKeys), ticketNumber: shownNumber(entry.ticket, snapshot.repoKeys), sourceKind: kind ?? entry.ticket.source, search: searchText(entry, group, snapshot), links: linksOf(entry, snapshot.repoKeys, snapshot.pullRequests), returned: entry.returned, comment: 'status' in entry ? commentOf(entry) : null, band };
}

function heldRow(snapshot: Snapshot, one: HeldSession, now: number, windows: string): DockHeld {
  const { item, nativeSessionId, idle, memory } = heldTexts(one, now);
  const owner = one.workItemId === null ? undefined : snapshot.workItems.find((entry) => entry.id === one.workItemId);
  const session = owner?.sessions.find((entry) => entry.id === one.session);
  // A Codex terminal has no attach command yet, since `hub.js attach` takes only Code Mode sessions.
  const terminal = owner === undefined || session === undefined || one.orphan || session.execution === 'app-server' ? null : codeModeDockTerminal(owner, session, windows);

  // The page names the work item by its key and title; `hub.js holder list` keeps the key alone.
  return { session: one.session, item: owner === undefined ? item : `${item} · ${owner.ticket.title}`, nativeSessionId, cwd: one.cwd, state: one.state, idle, memory, clients: one.clients, orphan: one.orphan, exited: one.exitedAt !== null, terminal };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The bell's notices and one-time notices the snapshot holds (architecture.md § Web page, List header). */
export function noticesOf(snapshot: Snapshot): { notices: Notice[]; info: InfoNotice[] } {
  const holder = holderNotices(snapshot);

  return { notices: [...errorNotices(snapshot), ...setupNotices(snapshot), ...orphanNotices(snapshot.held ?? []), ...holder.notices], info: holder.info };
}

/**
 * The holder's notices (architecture.md § Restarting the holder). The sessions a restart resumes are the live held ones whose session the
 * store holds active; one that is starting, running or waiting is in a turn, which the restart interrupts, so the confirmation names it. Out
 * of date is dismissed until the next install, since its ID names the installed build; a restart that went well is a one-time notice, and one
 * that failed stays until dismissed or the hub restarts.
 */
export function holderNotices(snapshot: Pick<Snapshot, 'holder' | 'held' | 'workItems'>): { notices: Notice[]; info: InfoNotice[] } {
  const holder = snapshot.holder;
  const notices: Notice[] = [];
  const info: InfoNotice[] = [];

  if (holder === undefined) {
    return { notices, info };
  }

  const restart = holder.restart;

  if (restart?.state === 'running') {
    notices.push({ id: 'holder-restarting', class: 'transient', text: 'Restarting the terminal holder and resuming its sessions…', dismiss: null });
  } else if (holder.older) {
    const live = (snapshot.held ?? []).filter((one) => one.exitedAt === null);
    const sessionOf = (id: string) => snapshot.workItems.flatMap((item) => item.sessions.map((session) => ({ item, session }))).find((entry) => entry.session.id === id);
    const resumed = live.filter((one) => !one.orphan && (sessionOf(one.session)?.session.state ?? 'ended') !== 'ended');
    const busy = resumed.filter((one) => ['starting', 'running', 'waiting'].includes(sessionOf(one.session)!.session.state));
    const others = live.length - resumed.length;
    const name = (one: HeldSession) => {
      const title = sessionOf(one.session)!.item.ticket.title;

      return one.key === null ? title : `${title} (${one.key})`;
    };
    const parts = [
      live.length === 0 ? 'The terminal holder holds no live session.' : '',
      resumed.length === 0 ? '' : `Restarting stops ${resumed.length === 1 ? 'the background session' : `the ${resumed.length} background sessions`} and resumes ${resumed.length === 1 ? 'it' : 'them'} in a holder of the installed build.`,
      busy.length === 0 ? '' : `${busy.length === 1 ? 'This session is' : 'These sessions are'} not idle, so the restart interrupts ${busy.length === 1 ? 'its turn' : 'their turns'}: ${busy.map(name).join(', ')}.`,
      others === 0 ? '' : `${plural(others, resumed.length === 0 ? 'background session' : 'other background session', resumed.length === 0 ? 'background sessions' : 'other background sessions')} ${others === 1 ? 'ends and is' : 'end and are'} not resumed.`,
    ];

    notices.push({
      id: `holder-older:${holder.installed ?? ''}`,
      class: 'action',
      text: `The terminal holder that runs background sessions is out of date. Restart it to update${resumed.length === 0 ? '' : `; its ${plural(resumed.length, 'session stops and resumes', 'sessions stop and resume')}`}.`,
      dismiss: 'kept',
      action: { kind: 'holder-restart', label: 'Restart and resume', confirm: { question: 'Restart the terminal holder?', detail: parts.filter((part) => part !== '').join(' '), action: 'Restart and resume' } },
    });
  }

  if (restart?.state === 'done') {
    const resumed = plural(restart.resumed, 'session', 'sessions');
    const failed = restart.failed.length === 0 ? '' : ` ${plural(restart.failed.length, 'session', 'sessions')} did not resume: ${restart.failed.map((one) => `${one.key ?? one.session}: ${one.error}`).join(' ')}`;
    const text =
      restart.error === null
        ? `The terminal holder restarted${restart.resumed === 0 ? '' : ` and ${resumed} resumed`}.`
        : `The terminal holder did not restart: ${restart.error}${restart.resumed === 0 ? '' : ` ${resumed} resumed.`}`;

    if (restart.error === null && restart.failed.length === 0) {
      info.push({ id: `holder-restarted:${restart.at}`, text, at: restart.at });
    } else {
      notices.push({ id: `holder-result:${restart.at}`, class: 'action', text: `${text}${failed}`, dismiss: 'memory' });
    }
  }

  return { notices, info };
}

/** Background sessions without a work item, with Review; a dismissal lasts until the set of them changes, since the ID names it. */
function orphanNotices(held: HeldSession[]): Notice[] {
  const orphans = held.filter((one) => one.orphan).map((one) => one.session).sort();

  return orphans.length === 0
    ? []
    : [{ id: `orphans:${noticeHash(orphans.join(' '))}`, class: 'action', text: `${plural(orphans.length, 'background session', 'background sessions')} without a work item.`, dismiss: 'kept', action: { kind: 'held', label: 'Review' } }];
}

/**
 * One header icon: the sources of one kind. The icon is on while any of them is polled. A kind with one source toggles it on click; a kind with
 * several opens a menu with a check box per source (PRD R71).
 */
export interface DockSourceGroup {
  kind: string;
  /** The plugin's name for the kind, such as `GitHub`. */
  label: string;
  icon?: SourceIcon;
  enabled: boolean;
  /** The icon's tooltip: each source and whether it is polled, then what a click does. */
  title: string;
  sources: { name: string; enabled: boolean }[];
}

export function sourceGroups(states: Snapshot['sourceStates']): DockSourceGroup[] {
  const kinds = [...new Set(states.map((state) => state.kind))];

  return kinds.map((kind) => {
    const sources = states.filter((state) => state.kind === kind).map(({ name, enabled }) => ({ name, enabled }));
    const lines = sources.map((source) => `${source.name}: ${source.enabled ? 'on' : 'off'}`);
    const only = sources.length === 1 ? sources[0]! : null;
    const action = only === null ? 'Click to choose which are on.' : only.enabled ? 'Click to turn it off.' : 'Click to turn it on.';

    const first = states.find((state) => state.kind === kind)!;

    return { kind, label: first.label, ...(first.icon === undefined ? {} : { icon: first.icon }), enabled: sources.some((source) => source.enabled), title: [...lines, action].join('\n'), sources };
  });
}

/** A work item's row; `order` is Ready for review's IDs in list order when the row is in that group, for its Move controls. */
function itemRow(item: WorkItemView, now: number, namespaces: Record<string, string>, windows: string, order: number[] | null, keys: RepoKeys | undefined): Omit<DockRow, 'sourceKind' | 'ticketNumber' | 'search' | 'links' | 'returned' | 'comment' | 'band'> {
  const kind = markOf(item);
  const controls = order === null ? controlsOf(item) : [...controlsOf(item), ...moveControls(item, order)];
  const turn = item.ticket.snoozed ? null : turnOf(item);
  const report = item.status === 'awaiting-approval' ? item.approvalReport : null;
  const main = mainControl(item);

  return {
    key: rowKeyOf(item),
    title: item.ticket.title,
    priority: priorityTitle(item.triage),
    time: rowTime(item, now),
    playbook: playbookText(item, namespaces),
    ticket: shownKey(item.ticket, keys),
    source: item.ticket.source,
    url: item.ticket.url,
    mark: kind === null ? null : { kind, glyph: MARK_GLYPHS[kind], title: MARK_TITLES[kind] },
    details: orMarkTitle(kind, [
      ...[...startPromptText(item), ...limitTexts(item, now), ...waitTexts(item)].map(({ text, title }) => ({ text, title, tone: null })),
      ...blockerTexts(item.ticket, item.status).map(({ text, title }) => ({ text, title, tone: 'warning' as const })),
      ...wake(item.ticket),
      ...[item.warning, item.error].filter((note): note is string => note !== null).map((note) => clipped(note, CAPS.note, 'warning')),
      ...(item.parent === null ? [] : [{ text: `From ${shownKey(item.parent, keys)}`, title: item.parent.title, tone: null }]),
      ...(kind === 'question' || kind === 'permission' ? [] : progress(item, now)),
    ]),
    stripe: stripeOf(item),
    turn,
    dim: order !== null && turn === 'agent',
    movable: order !== null,
    window: windowOf(item, windows),
    open: openOf(item, windows),
    terminal: menuTerminal(item, windows),
    controls: hubControls(controls),
    main: main?.label ?? null,
    mainGlyph: main === null ? null : CONTROL_GLYPHS[main.icon],
    mainTitle: main === null ? null : mainTitle(item, main),
    pastes: item.status === 'awaiting-approval' ? item.pastes.map(({ label, file }) => ({ label, file })) : [],
    // Open in terminal runs in the terminal app, so it is not among these.
    commands: [...windowCommands(controls.filter((control) => control.message['type'] !== 'terminal')), ...(report === null ? [] : [{ label: 'Open report', glyph: CONTROL_GLYPHS['symbol-file'], command: { type: 'openUrl', url: report } }])],
  };
}

/** Line 3 with nothing but the mark names the mark in words, so the icon is never alone (PRD R27). */
function orMarkTitle(kind: Mark | null, details: DockText[]): DockText[] {
  return kind !== null && details.length === 0 ? [{ text: MARK_TITLES[kind], title: null, tone: null }] : details;
}

function poolRow(entry: PoolView, now: number, namespaces: Record<string, string>): Omit<DockRow, 'sourceKind' | 'ticketNumber' | 'search' | 'links' | 'returned' | 'comment' | 'band'> {
  const { ticket, triage } = entry;
  const { main, controls } = poolControls(entry);
  const triaging = triage !== null && triage.endedAt === null;

  return {
    key: rowKeyOf(entry),
    title: ticket.title,
    priority: priorityTitle(triage),
    time: queuedTime(ticket.scopeAt === null ? null : { since: ticket.scopeAt, label: 'In the pool since' }, null, now),
    playbook: playbookText(entry, namespaces),
    ticket: shownKey(ticket, undefined),
    source: ticket.source,
    url: ticket.url,
    mark: triaging ? { kind: 'triaging', glyph: MARK_GLYPHS.triaging, title: MARK_TITLES.triaging } : null,
    details: orMarkTitle(triaging ? 'triaging' : null, [
      ...blockerTexts(ticket, null).map(({ text, title }) => ({ text, title, tone: 'warning' as const })),
      ...wake(ticket),
      ...(triage?.error == null ? [] : [clipped(triage.error, CAPS.note, 'warning')]),
    ]),
    stripe: null,
    turn: null,
    dim: false,
    movable: false,
    window: null,
    open: entry.focus === null ? null : { type: 'url', url: entry.focus },
    terminal: null,
    controls: hubControls(controls),
    main: main?.label ?? null,
    mainGlyph: main === null ? null : CONTROL_GLYPHS[main.icon],
    mainTitle: main?.label ?? null,
    pastes: [],
    commands: windowCommands(controls),
  };
}

/** The ticket's links in the order reported, mentioned ones last, each once, named by its pull request or issue number when it has one (PRD R52, R61). */
function linksOf(entry: WorkItemView | PoolView, keys: RepoKeys | undefined, pullRequests: Snapshot['pullRequests'] = {}): DockRow['links'] {
  const seen = new Set<string>();
  const ordered = [...entry.links.filter((link) => !link.mentioned), ...entry.links.filter((link) => link.mentioned)];

  return ordered.flatMap((link): DockRow['links'] => {
    const { mentioned } = link;

    if (link.target === entry.ticket.url || seen.has(link.target)) {
      return [];
    }

    seen.add(link.target);

    const kind = linkKind(link.target);
    const number = linkNumber(link.target);
    if (kind === 'url' || number === null) {
      return [{ label: link.label, url: link.target, kind: 'url', badge: link.label, glyph: LINK_GLYPH, mentioned }];
    }

    if (kind === 'pr') {
      return [{ label: `PR #${number}`, url: link.target, kind, badge: number, glyph: PULL_REQUEST_GLYPH, mentioned, ...(pullRequests[link.target] === undefined ? {} : { pr: pullRequests[link.target] }) }];
    }

    const repo = issueOfUrl(link.target)?.repo ?? '';
    const key = issueKey(entry.ticket.source, repo, number, keys, true);
    // GitHub's mark stands for a GitHub source's label, such as `gh`, as on the ticket key; a repository's prefix stays.
    const badge = issueHome(entry.ticket.source, repo, keys, true) === undefined ? key : number;

    return [{ label: key, url: link.target, kind, badge, glyph: GITHUB_GLYPH, mentioned }];
  });
}

function clipped(text: string, max: number, tone: DockText['tone'] = null): DockText {
  const { text: shown, full } = clip(text, max);

  return { text: shown, title: full, tone };
}

/**
 * A snoozed row's wake time, unless the snooze is indefinite, then the snooze's comment (PRD R49). With a comment the wake time is only its
 * date, with the whole time as its tooltip, so the comment keeps most of line 3.
 */
function wake(ticket: { snoozed: boolean; snoozedUntil: number | null; snoozeComment?: string | null }): DockText[] {
  if (!ticket.snoozed) {
    return [];
  }

  const comment = ticket.snoozeComment ?? null;
  const until = ticket.snoozedUntil;
  const day = (time: number) => new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return [
    ...(until === null ? [] : [comment === null ? { text: `Snoozed until ${wakeText(until)}`, title: null, tone: null } : { text: `Snoozed until ${day(until)}`, title: `Snoozed until ${wakeText(until)}`, tone: null }]),
    ...(comment === null ? [] : [{ ...clipped(oneLine(comment), CAPS.note), title: comment }]),
  ];
}

/** Line 2's comment icon: each comment under its time, oldest first (PRD R87). */
function commentOf(item: WorkItemView): DockRow['comment'] {
  return item.comments.length === 0 ? null : { glyph: CONTROL_GLYPHS.comment, title: item.comments.map((comment) => `${wakeText(comment.at)}\n${comment.text}`).join('\n\n') };
}

/** A multi-line text on one line, for a row. */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ');
}

/**
 * The approval summary, else the state's headline, each with its age, for line 3 (PRD R27, R58). A state whose turn ended is dimmed; one whose
 * session ended is dimmed and named the last state (architecture.md § States).
 */
function progress(item: WorkItemView, now: number): DockText[] {
  const summary = item.status === 'awaiting-approval' ? item.approvalSummary : null;
  const state = item.state;

  if (summary !== null) {
    const whole = summary.charAt(0).toUpperCase() + summary.slice(1);
    const { text, full } = clip(whole, CAPS.approval);

    return [{ text: `${text} · ${age(item.statusAt, now)}`, title: state === null ? full : `${whole}\nLast state: ${state.headline}`, tone: null }];
  }

  const stale = staleSince(item, now);
  const staleTitle = stale === null ? null : `No state for ${age(stale, now)}`;

  if (state === null) {
    return stale === null ? [] : [{ text: `No state · ${age(stale, now)}`, title: staleTitle, tone: 'warning' }];
  }

  const old = stateStale(state, state.sessionId === null ? null : (item.sessions.find((session) => session.id === state.sessionId) ?? null));
  const { text, full } = clip(state.headline, CAPS.state);
  const shown = old === 'session' ? `Last state: ${text}` : text;
  const title = staleTitle ?? (old === 'session' ? `Last state: ${state.headline}` : old === 'turn' ? `${state.headline}\nAs of the last turn` : full);

  return [{ text: `${shown} · ${age(state.at, now)}`, title, tone: stale !== null ? 'warning' : old === null ? null : 'dim' }];
}

/**
 * The work item's window: the latest session's folder first, else the worktree, with the worktree second when the session ran
 * elsewhere; null with neither. The name is the ticket key, the first folder's name when that folder is not the worktree, and a hash of the first folder.
 */
export function windowOf(item: WorkItemView, windows: string): DockWindow | null {
  const latest = item.sessions.at(-1);
  const hostWindow = item.ticket.hostWindow ?? null;
  const host = hostWindow === null || hostIsPath(hostWindow) ? hostWindow : null;

  // A host that is no path, such as a web page's key, names no window: the conversation opens its own folder.
  if (hostWindow !== null && host === null) {
    const folder = latest?.cwd || item.ticket.repoRoot;

    return folder === '' ? null : { name: folderName(folder), title: item.ticket.title, folders: [folder], file: null, hosted: true, folder };
  }

  // A hosted conversation has no window of its own: it opens its host's (architecture.md § Hosted conversations).
  if (host !== null && isFolderHost(host)) {
    return { name: folderName(host), title: item.ticket.title, folders: [host], file: null, hosted: true, folder: host };
  }

  if (host !== null) {
    const name = (host.split(/[\\/]/).pop() ?? host).replace(/\.code-workspace$/i, '');

    return { name, title: item.ticket.title, folders: [latest?.cwd ?? item.ticket.repoRoot], file: host, hosted: true };
  }

  const first = latest?.cwd ?? item.worktree?.path ?? null;

  // A registered session lives in the operator's own window until it ends; an item window would open it again as a copy (PRD R81).
  if (first === null || first === '' || (latest?.external === true && latest.state !== 'ended')) {
    return null;
  }

  const worktree = item.worktree?.path ?? null;
  const inWorktree = worktree !== null && samePath(first, worktree);
  // The hash names the first folder, so a window's first folder never changes: another folder, or a moved worktree, gets another window.
  const hash = createHash('sha256').update(normalPath(first)).digest('hex').slice(0, 6);
  // A ticket a ticket report moved keeps its ad-hoc name, so its open window is still found (PRD R83).
  const named = item.ticket.adhocKey === null ? ticketKey(item.ticket) : ticketKey({ source: 'adhoc', sourceKey: item.ticket.adhocKey });
  const key = `${named.replace(' ', '-')}${inWorktree ? '' : `-${folderName(first)}`}-${hash}`;
  const name = key.replace(/[^A-Za-z0-9._-]+/g, '-');

  return { name, title: item.ticket.title, folders: worktree === null || inWorktree ? [first] : [first, worktree], file: join(windows, `${name}.code-workspace`) };
}

/** Whether a `Ticket.hostWindow` is a path, a workspace file or a folder, rather than a key that names no window, such as a web page's. */
export function hostIsPath(host: string): boolean {
  return win32.isAbsolute(host) || posix.isAbsolute(host);
}

/** The latest session, when Switchboard does not run it now. */
export function openOf(item: WorkItemView, windows: string): DockOpen | null {
  // A row with no window opens its focus (PRD R71, R79), and a registered session opens nowhere while it lives in the operator's window (PRD R81).
  if (windowOf(item, windows) === null) {
    return item.focus === null ? null : { type: 'url', url: item.focus };
  }

  const latest = item.sessions.at(-1) ?? null;
  const active = activeSession(item);

  if (latest?.execution === 'app-server' && latest.nativeSessionId !== null) return { type: 'session', sessionId: latest.id, cwd: latest.cwd, provider: 'codex' };

  // A Code Mode session opens its attach terminal, which the hub sends the item window for this open, except during a turn that does not wait
  // on the operator (PRD R28, R95).
  if (latest?.codeMode === true) {
    return active?.state === 'starting' || active?.state === 'running' ? null : { type: 'session', sessionId: latest.id, cwd: latest.cwd, provider: latest.provider };
  }

  // A session whose end has not finished may still run.
  if (latest?.nativeSessionId != null && (active === null || (active.released && !active.releasing))) {
    return { type: 'session', sessionId: latest.nativeSessionId, cwd: latest.cwd, provider: latest.provider };
  }

  return null;
}

/** Open in terminal's window for the latest session (PRD R28): `claude attach` in its background process, else a resume; null when none applies. */
function menuTerminal(item: WorkItemView, windows: string): DockTerminal | null {
  const command = terminalCommand(item);
  const latest = item.sessions.at(-1);

  if (command === null) {
    return null;
  }

  if (command['codeMode'] === true && latest !== undefined) {
    return codeModeDockTerminal(item, latest, windows);
  }

  const provider = command['provider'] as Provider;
  const sessionId = String(command['sessionId']);
  const shortId = command['shortId'] as string | null;
  const args = shortId !== null ? ['attach', shortId] : provider === 'codex' ? ['resume', sessionId] : ['--resume', sessionId];

  return { provider, sessionId, cwd: String(command['cwd']), args, ...terminalName(item, windows, sessionId.slice(0, 8)), handoff: null, active: command['active'] === true, ...(command['execution'] === 'app-server' ? { execution: 'app-server' as const } : {}) };
}

/** A Code Mode session's attach terminal, named by its Switchboard session ID (PRD R95). */
function codeModeDockTerminal(item: WorkItemView, session: WorkItemView['sessions'][number], windows: string): DockTerminal {
  // Named from the window of this session's folder, so an older held session keeps its terminal after a newer session starts elsewhere.
  const own = { ...item, sessions: item.sessions.slice(0, item.sessions.indexOf(session) + 1) };

  return { provider: 'claude', sessionId: session.id, cwd: session.cwd, args: ['attach', session.id], ...terminalName(own, windows, session.id), handoff: null, active: false, codeMode: true };
}

/**
 * A session's terminal name and title: the item window's name, else the ticket key, with `suffix`: the session's first eight characters, which
 * are its short ID too, so an attach and a later resume of one session share a window name and another session never takes it, or a Code Mode
 * session's Switchboard session ID.
 */
function terminalName(item: WorkItemView, windows: string, suffix: string): { name: string; title: string } {
  const base = windowOf(item, windows)?.name ?? ticketKey(item.ticket).replace(/[^A-Za-z0-9._-]+/g, '-');
  const name = `${base}-${suffix}`.replace(/[^A-Za-z0-9._-]+/g, '-');

  return { name, title: `${item.ticket.title} · sb:${name}` };
}

/** The controls the hub runs; Copy and the controls that open something are in `pastes` and `commands` (PRD R71). */
function hubControls(controls: Control[]): DockRow['controls'] {
  return controls.flatMap((control) =>
    control.message['type'] === 'action'
      ? [
          {
            label: control.label,
            glyph: CONTROL_GLYPHS[control.icon],
            action: control.message['action'] as Record<string, unknown>,
            ...(control.confirm === undefined ? {} : { confirm: control.confirm }),
            ...(control.input === undefined ? {} : { input: control.input }),
          },
        ]
      : [],
  );
}

/** The codicons of a pull request badge (git-pull-request), an issue's (github) and another link's (link). */
const PULL_REQUEST_GLYPH = '\u{ea64}';
const LINK_GLYPH = '\u{eb15}';
const GITHUB_GLYPH = '\u{ea84}';

/** Each group's glyph: bell, eye, play-circle, inbox, pass and clockface. */
const GROUP_GLYPHS: Record<RowGroup, string> = { blocked: '\u{eaa2}', review: '\u{ea70}', progress: '\u{eba6}', unstarted: '\u{eb09}', done: '\u{eba4}', snoozed: '\u{ec75}' };

function normalPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * The controls that open something for the row (PRD R57, R59). Copy is in the row's pastes; Show in Source Control is left out, because the
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
