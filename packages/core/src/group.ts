import type { DoneReason, Session, Triage, WorkItem } from './model.js';
import { SETUP_AT_LIMIT, waitsOnLimit } from './limit.js';

// Imports only types and `limit.ts`, which imports only types, so the web page and the Chrome extension can bundle it for a browser through `@switchboard/core/group`.

/** The list's groups (PRD R27): Blocked on you, Ready for review, In progress, Unstarted and Done; Snoozed is the list's own. */
export type Group = 'blocked' | 'review' | 'progress' | 'unstarted' | 'done';

/** The state detail of a `waiting` Claude session that waits on a prompt before it starts, such as approving the project's MCP servers (PRD R41). */
export const START_PROMPT = 'start-prompt';

/** A session waiting on a prompt before it starts, which the operator answers by attaching to it (PRD R41). */
export function waitsToStart(session: Pick<Session, 'state' | 'stateDetail'> | null): boolean {
  return session !== null && session.state === 'waiting' && session.stateDetail === START_PROMPT;
}

/** The state detail of a `waiting` Claude session that waits on a permission prompt for a tool call, not on a question (PRD R70). */
export const PERMISSION_PROMPT = 'permission-prompt';

/** A session waiting on a permission prompt, which stopping it would drop, so the operator answers it by attaching to it (PRD R70). */
export function waitsOnPermission(session: { state: Session['state']; stateDetail?: string | null } | null): boolean {
  return session !== null && session.state === 'waiting' && session.stateDetail === PERMISSION_PROMPT;
}

/** The state detail of a `running` Claude session whose turn ended while background tasks run; a count of each kind follows it. */
export const BACKGROUND_DETAIL = 'turn ended with background tasks';

/** Background work a session's turn left running: subagents, shell commands and every other kind of task (mechanics M124). */
export interface BackgroundCounts {
  agents: number;
  shells: number;
  other: number;
}

const BACKGROUND_KINDS: readonly [key: keyof BackgroundCounts, word: string][] = [
  ['agents', 'agent'],
  ['shells', 'shell'],
  ['other', 'other task'],
];

/**
 * The detail of a turn that ended while background tasks run, from the task types `Stop` lists (`subagent`, `shell`, `code`, `monitor` and
 * others, mechanics M124), such as `turn ended with background tasks: 2 agents, 1 shell`; without types, as from an older hook writer, only
 * {@link BACKGROUND_DETAIL}.
 */
export function backgroundDetail(types: readonly string[] | undefined): string {
  if (types === undefined || types.length === 0) {
    return BACKGROUND_DETAIL;
  }

  const counts: BackgroundCounts = { agents: 0, shells: 0, other: 0 };

  for (const type of types) {
    counts[type === 'subagent' ? 'agents' : type === 'shell' ? 'shells' : 'other']++;
  }

  const parts = BACKGROUND_KINDS.filter(([key]) => counts[key] > 0).map(([key, word]) => `${counts[key]} ${word}${counts[key] === 1 ? '' : 's'}`);

  return `${BACKGROUND_DETAIL}: ${parts.join(', ')}`;
}

/** The background work of a `running` session whose turn ended with background tasks, all zero when its detail has no counts, else null. */
export function backgroundCounts(session: { state: Session['state']; stateDetail?: string | null } | null | undefined): BackgroundCounts | null {
  const detail = session?.state === 'running' ? (session.stateDetail ?? null) : null;

  if (detail === null || (detail !== BACKGROUND_DETAIL && !detail.startsWith(`${BACKGROUND_DETAIL}: `))) {
    return null;
  }

  const counts: BackgroundCounts = { agents: 0, shells: 0, other: 0 };

  for (const [key, word] of BACKGROUND_KINDS) {
    const found = new RegExp(`(\\d+) ${word}s?(,|$)`).exec(detail);

    counts[key] = found === null ? 0 : Number(found[1]);
  }

  return counts;
}

/** The line the conversation shows while a session's turn has ended and its background work runs, such as `3 agents running`. */
export function backgroundLabel(counts: BackgroundCounts): string {
  const parts = BACKGROUND_KINDS.filter(([key]) => counts[key] > 0).map(([key, word]) => {
    const name = key === 'other' && counts.agents + counts.shells === 0 ? 'background task' : word;

    return `${counts[key]} ${name}${counts[key] === 1 ? '' : 's'}`;
  });

  return parts.length === 0 ? 'Background tasks running' : `${parts.join(' · ')} running`;
}

/**
 * The state detail of an `idle` Code Mode or Codex app-server task session whose turn ended with a question card no message has answered yet,
 * so its work item waits on the operator's answer (PRD R103).
 */
export const QUESTION_CARD = 'question-card';

/** A session whose turn ended asking lettered questions in a reply or a status that no message has answered yet (PRD R103). */
export function waitsOnCard(session: { state: Session['state']; stateDetail?: string | null } | null | undefined): boolean {
  return session != null && session.state === 'idle' && session.stateDetail === QUESTION_CARD;
}

/** `triage` is the work item's latest triage, or null when it has none. A caller without `stateDetail` gets no permission mark. */
type Grouped = Pick<WorkItem, 'status' | 'readyAt'> & { sessions: (Pick<Session, 'state' | 'outcome' | 'promptless' | 'rateLimit'> & { stateDetail?: string | null })[]; triage: Pick<Triage, 'error'> | null };

/** Hosted conversations remain open while their session waits for another message. */
function idleConversation(item: Grouped): boolean {
  const latest = item.sessions.at(-1);
  return item.status === 'running' && latest?.promptless === true && (latest.state === 'idle' || latest.state === 'ended');
}

/** The work item failed because its latest triage failed, so Retry triages it again and it waits in Unstarted (PRD R27, R34). */
export function failedAtTriage(item: Pick<WorkItem, 'status'> & { triage: Pick<Triage, 'error'> | null }): boolean {
  return item.status === 'failed' && item.triage?.error != null;
}

/** Retry applies (PRD R34): the work item failed, or its setup stopped at a usage limit, which blocks it as a wait rather than failing it (PRD R111). */
export function retries(item: Pick<WorkItem, 'status' | 'error'>): boolean {
  return item.status === 'failed' || (item.status === 'blocked' && item.error === SETUP_AT_LIMIT);
}

/** The latest session while it has not ended; an earlier session left open idle in VS Code is not the work item's (PRD R17). */
export function activeSession<S extends Pick<Session, 'state'>>(item: { sessions: S[] }): S | null {
  const latest = item.sessions.at(-1);

  return latest !== undefined && latest.state !== 'ended' ? latest : null;
}

/** A work item's sessions as the question rules read them; without `stateDetail`, a question card's wait is not seen. */
type Asking = Pick<WorkItem, 'status'> & { sessions: (Pick<Session, 'state' | 'outcome'> & { stateDetail?: string | null })[] };

/**
 * A question waits on the operator: the session waits on it, its turn ended with an unanswered question card (PRD R103), or Open in Claude or
 * Codex stopped it and it has not run since (PRD R70). A queued, triaged or failed work item has moved on from an opened question.
 */
export function waitsOnQuestion(item: Asking): boolean {
  const latest = item.sessions.at(-1);
  const opened = latest?.outcome === 'opened' && (item.status === 'setup' || item.status === 'running' || item.status === 'awaiting-approval');

  return latest?.state === 'waiting' || (waitsOnCard(latest) && item.status === 'running') || opened;
}

/** The work item waits on the operator's answer or fix: it is blocked or failed, or a question waits on the operator (PRD R27). */
export function blocksOnYou(item: Asking): boolean {
  return item.status === 'blocked' || item.status === 'failed' || waitsOnQuestion(item);
}

/**
 * PRD R27 checks Done first, then Unstarted, which includes triage in progress or failed, then Ready for review for a work item that has been
 * ready, then Blocked on you, then queued starts in Unstarted, then In progress.
 */
export function groupOf(item: Grouped): Group {
  if (item.status === 'done') {
    return 'done';
  }

  if (item.status === 'unstarted' || item.status === 'triaging' || failedAtTriage(item)) {
    return 'unstarted';
  }

  // A ready work item keeps its place in Ready for review while it runs again, waits for a slot, asks a question, blocks or fails.
  if (item.readyAt !== null) {
    return 'review';
  }

  if (blocksOnYou(item)) {
    return 'blocked';
  }

  // A queued item waits for a slot or for another session of its ticket to end its turn (queueWaits).
  return item.status === 'queued' ? 'unstarted' : 'progress';
}

/** Whose turn it is (PRD R27): idle hosted conversations have none; blocked work and review wait on the operator. */
export function turnOf(item: Grouped): 'operator' | 'agent' | null {
  if (idleConversation(item)) return null;
  switch (groupOf(item)) {
    case 'blocked':
      return 'operator';
    case 'review':
    case 'progress':
      return blocksOnYou(item) || item.status === 'awaiting-approval' || item.status === 'finished' ? 'operator' : 'agent';
    case 'unstarted':
    case 'done':
      return null;
  }
}

/** An unsnoozed work item waiting on the operator, which the status bar counts and notifies (PRD R64, R65). */
export function needsYou(item: Grouped & { ticket: { snoozed: boolean } }): boolean {
  return !item.ticket.snoozed && turnOf(item) === 'operator';
}

/** A session whose work item is running and not waiting on a question holds a concurrency slot (PRD R38). */
export function holdsSlot(item: Asking): boolean {
  return (item.status === 'setup' || item.status === 'running') && !waitsOnQuestion(item);
}

/** Ready for review's sort key: the operator's position, else when the work item became ready (PRD R27, R73). */
export function reviewKey(item: Pick<WorkItem, 'readyAt' | 'orderAt'>): number {
  return item.orderAt ?? item.readyAt ?? Infinity;
}

/** Ready for review's order: by `reviewKey`, then by ID. */
export function reviewOrder(a: Pick<WorkItem, 'id' | 'readyAt' | 'orderAt'>, b: Pick<WorkItem, 'id' | 'readyAt' | 'orderAt'>): number {
  return reviewKey(a) - reviewKey(b) || a.id - b.id;
}

/** What differs between rows of one group (PRD R27): what the operator must do, the working phase, or how the work ended. */
export type Mark = 'question' | 'permission' | 'send' | 'review' | 'finished' | 'blocked' | 'failed' | 'queued' | 'setup' | 'running' | 'limited' | 'idle' | 'triaging' | 'done-session' | 'done-operator' | 'done-unassigned';

export const DONE_WORDS: Record<DoneReason, string> = { session: 'Finished by the session', operator: 'Marked done', unassigned: 'Left the assigned state' };

/** Each mark in words, for its tooltip. */
export const MARK_TITLES: Record<Mark, string> = {
  question: 'Answer a question',
  permission: 'Approve a permission',
  send: 'Approve to send',
  review: 'Review, then approve',
  finished: 'Review the finished turn',
  blocked: 'Blocked',
  failed: 'Failed',
  queued: 'Queued',
  setup: 'Setting up',
  running: 'Running',
  limited: 'Rate limited',
  idle: 'Idle',
  triaging: 'Triaging',
  'done-session': DONE_WORDS.session,
  'done-operator': DONE_WORDS.operator,
  'done-unassigned': DONE_WORDS.unassigned,
};

/** Each mark's codicon glyph in codicon.ttf, for the Chrome extension's pills; Queued's `clock` is an alias of `history`. */
export const MARK_GLYPHS: Record<Mark, string> = {
  question: '\u{eb32}',
  permission: '\u{eb53}', // shield
  send: '\u{ec0f}',
  review: '\u{ea70}', // eye
  finished: '\u{ea70}', // eye
  blocked: '\u{ead1}', // debug-pause
  failed: '\u{ea87}', // error
  queued: '\u{ea82}', // clock
  setup: '\u{eb6d}', // tools
  running: '\u{eb19}', // loading
  limited: '\u{eb7c}', // watch
  idle: '\u{ebb5}', // circle-large-outline
  triaging: '\u{eb19}', // loading
  'done-session': '\u{eab2}', // check
  'done-operator': '\u{eb99}', // account
  'done-unassigned': '\u{ea6e}', // sign-out
};

/**
 * Each mark's codicon name, the icon `MARK_GLYPHS` draws, for a page that draws codicons by class: one mapping for every
 * place the web page draws a mark.
 */
export const MARK_ICONS: Record<Mark, string> = {
  question: 'question',
  permission: 'shield',
  send: 'send',
  review: 'eye',
  finished: 'eye',
  blocked: 'debug-pause',
  failed: 'error',
  queued: 'clock',
  setup: 'tools',
  running: 'loading',
  limited: 'watch',
  idle: 'circle-large-outline',
  triaging: 'loading',
  'done-session': 'check',
  'done-operator': 'account',
  'done-unassigned': 'sign-out',
};

/**
 * How strongly a mark or a session icon is drawn: `muted`, in the secondary text colour, for every state that needs nothing of the operator;
 * `attention`, in the warning colour, for one that waits on the operator or on a usage limit; `error` for a failure. One rule for every place
 * the web page draws one, so colour means the same everywhere.
 */
export type IconTone = 'muted' | 'attention' | 'error';

export const MARK_TONES: Record<Mark, IconTone> = {
  question: 'attention',
  permission: 'attention',
  send: 'attention',
  review: 'muted',
  finished: 'muted',
  blocked: 'attention',
  failed: 'error',
  queued: 'muted',
  setup: 'muted',
  running: 'muted',
  limited: 'attention',
  idle: 'muted',
  triaging: 'muted',
  'done-session': 'muted',
  'done-operator': 'muted',
  'done-unassigned': 'muted',
};

/** The marks drawn spinning: a session at work. */
export const SPINNING_MARKS: ReadonlySet<Mark> = new Set<Mark>(['running', 'triaging']);

/** A session's state as an icon: its mark's when one means the same, else `starting`, `ended` or `none` for no session. */
export type SessionIcon = 'question' | 'permission' | 'running' | 'limited' | 'idle' | 'failed' | 'starting' | 'ended' | 'none';

/**
 * The codicon of each session state, `~spin` for one that spins: the same icon as the mark of that meaning, so a session waiting on a question
 * shows the list's question mark and an idle one its Idle mark. `check` is left to Done.
 */
export const SESSION_ICONS: Record<SessionIcon, string> = {
  question: MARK_ICONS.question,
  permission: MARK_ICONS.permission,
  running: `${MARK_ICONS.running}~spin`,
  limited: MARK_ICONS.limited,
  idle: MARK_ICONS.idle,
  failed: MARK_ICONS.failed,
  starting: `${MARK_ICONS.running}~spin`,
  // A small stop in a circle, of one weight with the other circle icons, rather than a heavy filled square.
  ended: 'stop-circle',
  none: 'circle-slash',
};

/** Each session icon's tone (`IconTone`). */
export const SESSION_TONES: Record<SessionIcon, IconTone> = {
  question: MARK_TONES.question,
  permission: MARK_TONES.permission,
  running: 'muted',
  limited: MARK_TONES.limited,
  idle: 'muted',
  failed: MARK_TONES.failed,
  starting: 'muted',
  ended: 'muted',
  none: 'muted',
};

/** A session's icon by its state, what it waits for and whether it waits for a usage limit to reset; `none` without a session. */
export function sessionIcon(state: Session['state'] | null | undefined, waitingFor: string | null = null, limited = false): SessionIcon {
  if (limited) {
    return 'limited';
  }

  switch (state) {
    case 'starting':
      return 'starting';
    case 'running':
      return 'running';
    case 'waiting':
      return waitingFor === 'permission' ? 'permission' : 'question';
    case 'idle':
      return 'idle';
    case 'failed':
      return 'failed';
    case 'ended':
      return 'ended';
    default:
      return 'none';
  }
}

/** The work item's mark, or null for an Unstarted item that is not triaging, failed or queued, which shows its priority instead. A snoozed item has its group's mark. */
export function markOf(item: Grouped & Pick<WorkItem, 'doneReason'> & { approvalSends: boolean }): Mark | null {
  switch (groupOf(item)) {
    case 'blocked':
    case 'review':
    case 'progress':
      // A question the session waits on comes before an approval it reported earlier.
      if (waitsOnQuestion(item)) {
        return waitsOnPermission(activeSession(item)) ? 'permission' : 'question';
      }

      if (item.status === 'failed' || item.status === 'blocked') {
        return item.status;
      }

      if (item.status === 'awaiting-approval') {
        return item.approvalSends ? 'send' : 'review';
      }

      // A run whose session waits for a usage limit to reset continues on its own (architecture.md § Rate limits).
      if ((item.status === 'running' || item.status === 'setup') && waitsOnLimit(activeSession(item))) {
        return 'limited';
      }

      if (idleConversation(item)) return 'idle';

      return item.status === 'finished' ? 'finished' : item.status === 'queued' ? 'queued' : item.status === 'setup' ? 'setup' : 'running';
    case 'unstarted':
      return item.status === 'triaging' || item.status === 'failed' || item.status === 'queued' ? item.status : null;
    case 'done':
      return `done-${item.doneReason ?? 'session'}`;
  }
}

/** The playbook slot during triage: the source's namespace and `triage`, such as `dev:triage`, or `triage` without one. */
export function triageLabel(source: string, namespaces: Record<string, string>): string {
  const namespace = namespaces[source] ?? '';

  return namespace === '' ? 'triage' : `${namespace}:triage`;
}

/**
 * The playbook slot of an ad-hoc work item, by how it was made: `conversation` for a hosted conversation, `task` from a session's task report,
 * whose ticket's `sourceId` keeps it after Delete clears the parent, `session` for a standalone session (PRD R122), `registered` for a
 * registered session, else `ad-hoc`.
 */
export function adhocLabel(item: { parentId: number | null; prompted: boolean; interactive?: boolean | undefined }, ticket: { sourceId: string | null; hostWindow?: string | null }): 'ad-hoc' | 'task' | 'registered' | 'conversation' | 'session' {
  return ticket.hostWindow != null ? 'conversation' : item.parentId !== null || ticket.sourceId === 'task' ? 'task' : item.interactive === true ? 'session' : item.prompted ? 'ad-hoc' : 'registered';
}

/** The prompt a work item without a playbook runs, an ad-hoc or task one's (PRD R6, R68), which Start with prompt… edits and History shows; else null. */
export function ownPrompt(item: Pick<WorkItem, 'playbook' | 'taskPrompt'>): string | null {
  return item.playbook === null ? item.taskPrompt : null;
}

/**
 * A URL as Open in Switchboard compares it (PRD R69): a GitHub issue or pull request page, any tab such as `/files` included, as
 * `github.com/<owner>/<repo>/<issues|pull>/<number>` in lower case; any other URL as parsed, without a trailing slash.
 */
export function urlKey(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const match = parsed.hostname === 'github.com' ? /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/|$)/.exec(parsed.pathname) : null;

  return match === null ? parsed.href.replace(/\/$/, '') : `github.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`.toLowerCase();
}

/** A ticket on the browser endpoint's `GET /cards` (PRD R67). `url` is the ticket's URL as stored. */
export interface Card {
  url: string;
  /** The playbook the list row shows, `<namespace>:triage` during triage, or null before triage chooses one. */
  playbook: string | null;
  group: Group;
  /** The row's mark (PRD R27), or null when the row shows none. A hub older than this field sends none. */
  mark?: Mark | null;
  snoozed: boolean;
  /** The list row's stripe (PRD R27), which colours the pill: null when the row has none. A hub older than this field sends none. */
  stripe?: 'error' | 'warning' | 'turn' | null;
  /** The URLs of the ticket's links (PRD R52), so a pull request page finds its ticket (PRD R69). A hub older than R69 sends none. */
  links?: string[];
  /** The work item the card shows, which the web page opens on another device (PRD R121); null for a pool ticket. A hub older than R121 sends none. */
  workItemId?: number | null;
}

/**
 * An ended Claude session that is not held yet: a registered one (PRD R81), or one an earlier hub ran in Claude's background service (PRD R93).
 * Opening it resumes it in the terminal holder, where it becomes a held session (PRD R95).
 */
export function resumesHeld(session: Pick<Session, 'codeMode' | 'provider' | 'state' | 'nativeSessionId'>): boolean {
  return session.codeMode !== true && session.provider === 'claude' && session.state === 'ended' && session.nativeSessionId !== null;
}
