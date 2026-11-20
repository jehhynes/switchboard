import type { DoneReason, Session, Triage, WorkItem } from './model.js';

// Imports only types, so the History webview and the Chrome extension can bundle it for a browser through `@switchboard/core/group`.

/** Dock groups (PRD R27): Blocked on you, Ready for review, In progress, Unstarted and Done; Snoozed is the dock's own. */
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

/** `triage` is the work item's latest triage, or null when it has none. A caller without `stateDetail` gets no permission mark. */
type Grouped = Pick<WorkItem, 'status' | 'readyAt'> & { sessions: (Pick<Session, 'state' | 'outcome' | 'promptless'> & { stateDetail?: string | null })[]; triage: Pick<Triage, 'error'> | null };

/** Hosted conversations remain open while their session waits for another message. */
function idleConversation(item: Grouped): boolean {
  const latest = item.sessions.at(-1);
  return item.status === 'running' && latest?.promptless === true && (latest.state === 'idle' || latest.state === 'ended');
}

/** The work item failed because its latest triage failed, so Retry triages it again and it waits in Unstarted (PRD R27, R34). */
export function failedAtTriage(item: Pick<WorkItem, 'status'> & { triage: Pick<Triage, 'error'> | null }): boolean {
  return item.status === 'failed' && item.triage?.error != null;
}

/** The latest session while it has not ended; an earlier session left open idle in VS Code is not the work item's (PRD R17). */
export function activeSession<S extends Pick<Session, 'state'>>(item: { sessions: S[] }): S | null {
  const latest = item.sessions.at(-1);

  return latest !== undefined && latest.state !== 'ended' ? latest : null;
}

/**
 * A question waits on the operator: the session waits on it, or Open in Claude or Codex stopped it and it has not run since (PRD R70). A
 * queued, triaged or failed work item has moved on from an opened question.
 */
export function waitsOnQuestion(item: Pick<WorkItem, 'status'> & { sessions: Pick<Session, 'state' | 'outcome'>[] }): boolean {
  const latest = item.sessions.at(-1);
  const opened = latest?.outcome === 'opened' && (item.status === 'setup' || item.status === 'running' || item.status === 'awaiting-approval');

  return latest?.state === 'waiting' || opened;
}

/** The work item waits on the operator's answer or fix: it is blocked or failed, or a question waits on the operator (PRD R27). */
export function blocksOnYou(item: Pick<WorkItem, 'status'> & { sessions: Pick<Session, 'state' | 'outcome'>[] }): boolean {
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
export function holdsSlot(item: Pick<WorkItem, 'status'> & { sessions: Pick<Session, 'state' | 'outcome'>[] }): boolean {
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
export type Mark = 'question' | 'permission' | 'send' | 'review' | 'finished' | 'blocked' | 'failed' | 'queued' | 'setup' | 'running' | 'idle' | 'triaging' | 'done-session' | 'done-operator' | 'done-unassigned';

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
  idle: 'Idle',
  triaging: 'Triaging',
  'done-session': DONE_WORDS.session,
  'done-operator': DONE_WORDS.operator,
  'done-unassigned': DONE_WORDS.unassigned,
};

/** Each mark's codicon glyph in codicon.ttf, for the dock and the Chrome extension's pills; Queued's `clock` is an alias of `history`. */
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
  idle: '\u{ebb5}', // circle-large-outline
  triaging: '\u{eb19}', // loading
  'done-session': '\u{eab2}', // check
  'done-operator': '\u{eb99}', // account
  'done-unassigned': '\u{ea6e}', // sign-out
};

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
 * The playbook slot of an ad-hoc work item, by how it was made: `task` from a session's task report, whose ticket's `sourceId` keeps it after
 * Delete clears the parent, `registered` for a registered session, else `ad-hoc`.
 */
export function adhocLabel(item: { parentId: number | null; prompted: boolean }, ticket: { sourceId: string | null; hostWindow?: string | null }): 'ad-hoc' | 'task' | 'registered' | 'conversation' {
  return ticket.hostWindow != null ? 'conversation' : item.parentId !== null || ticket.sourceId === 'task' ? 'task' : item.prompted ? 'ad-hoc' : 'registered';
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
  /** The playbook the dock shows, `<namespace>:triage` during triage, or null before triage chooses one. */
  playbook: string | null;
  group: Group;
  /** The row's mark (PRD R27), or null when the row shows none. A hub older than this field sends none. */
  mark?: Mark | null;
  snoozed: boolean;
  /** The URLs of the ticket's links (PRD R52), so a pull request page finds its ticket (PRD R69). A hub older than R69 sends none. */
  links?: string[];
}
