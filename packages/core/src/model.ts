import type { Provider } from './settings.js';

/** Work item statuses (PRD R34). */
export type WorkItemStatus = 'triaging' | 'unstarted' | 'queued' | 'setup' | 'running' | 'awaiting-approval' | 'finished' | 'blocked' | 'failed' | 'done';

export type DoneReason = 'session' | 'operator' | 'unassigned';

export type SessionKind = 'setup' | 'task';

/** Observed session state (PRD R36). */
export type SessionState = 'starting' | 'running' | 'waiting' | 'idle' | 'failed' | 'ended';

/** `opened`: stopped for Open in Claude or Codex; the question still waits until the operator resumes the session (PRD R70). */
export type SessionOutcome = 'done' | 'failed' | 'stopped' | 'opened';

/** The reports a session can send (PRD R23). */
export const REPORT_KINDS = ['stage', 'worktree', 'done', 'approval', 'link', 'playbook', 'paste', 'task', 'question'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Triage's importance rating (PRD R50). Earlier values rank first. */
export const IMMEDIACIES = ['URGENT', 'BLOCKING', 'NON-BLOCKING'] as const;
export const SEVERITIES = ['HIGH', 'MED', 'LOW'] as const;

export type Immediacy = (typeof IMMEDIACIES)[number];
export type Severity = (typeof SEVERITIES)[number];

/** Immediacy rank plus severity rank, lowest first; null when triage did not rate both (PRD R50). */
export function importanceRank(immediacy: Immediacy | null, severity: Severity | null): number | null {
  return immediacy === null || severity === null ? null : IMMEDIACIES.indexOf(immediacy) + SEVERITIES.indexOf(severity);
}

export interface Ticket {
  id: number;
  /** The operator assignment another session already handles; null until explicitly reported. */
  handledAssignmentKey?: string | null;
  source: string;
  /** The key people use, such as an issue number. */
  sourceKey: string;
  /** The reference with its source's mark, such as `#123` or `T456`, set by the source; empty until the first poll after migration 5. */
  ref: string;
  /** The source's internal ID when its API needs a different one, such as Zoho's. */
  sourceId: string | null;
  title: string;
  url: string;
  /** The assigned state the last complete poll saw. */
  assigned: boolean;
  /** Whether the last complete poll saw the ticket in the source's pool (PRD R47). */
  pool: boolean;
  /** Active Support queue membership, independent of assigned/pool eligibility. */
  inQueue?: boolean;
  assigneeId?: string | null;
  /** Snoozed by the operator: no automatic triage or start until it wakes or is restored (PRD R49). Local only. */
  snoozed: boolean;
  /** When the snooze ends and the ticket returns to its group; null for an indefinite snooze (PRD R49). */
  snoozedUntil: number | null;
  /** The operator's comment with the snooze, shown with the wake time and cleared when the snooze ends (PRD R49). */
  snoozeComment?: string | null;
  /** The source's sort time, which orders the pool so the longest-waiting customer comes first (PRD R27). */
  sortAt: number | null;
  /** When the ticket last entered the source's scope (assigned or pool); the in-queue time counts from it (PRD R27). */
  scopeAt: number | null;
  lastPolledAt: number | null;
  /** The repo an ad-hoc prompt chose. Empty takes the source's `repoRoot` setting. */
  repoRoot: string;
  /** The ad-hoc key of a ticket a ticket report moved to a source (PRD R83), so the key is not used again and the item window keeps its name. */
  adhocKey: string | null;
  /** The open issues the source lists as blocking this ticket, from the last complete poll that saw it (PRD R90); absent from an older hub's snapshot. */
  blockers?: TicketBlocker[];
}

/** An open issue that blocks a ticket (PRD R90). `ref` is `#12` in the ticket's repository, else `owner/repo#12`. */
export interface TicketBlocker {
  url: string;
  ref: string;
  title: string;
}

export interface WorkItem {
  id: number;
  ticketId: number;
  /** Null for an ad-hoc work item and before triage chooses one. */
  playbook: string | null;
  status: WorkItemStatus;
  stage: string | null;
  stageAt: number | null;
  /** The prompt the latest task session ran, or the typed prompt of an ad-hoc work item. */
  taskPrompt: string | null;
  /** The operator's guidance from Start, added to the next task session's prompt and cleared when that session starts (PRD R77). */
  guidance: string | null;
  /** A task report's prompt, which a repeated report matches after Start with prompt… edits `taskPrompt` (PRD R68, R77); null otherwise. */
  reportedPrompt: string | null;
  warning: string | null;
  /** The cause shown for `failed` or `blocked`, or a note such as a failed stop. */
  error: string | null;
  /** The ticket left the assigned state while a session was active (PRD R10). */
  unassignedAt: number | null;
  /** When a waiting start was queued, for first-in first-out order. */
  queuedAt: number | null;
  /** The prompt an approval report named; Approve starts a task session with it (PRD R23, R31). */
  approvalPrompt: string | null;
  approvalSummary: string | null;
  /** The draft Approve publishes, which the Report button opens (PRD R27). */
  approvalReport: string | null;
  /**
   * A resumed session runs on an approval report; the run ending without a report returns the work item to `awaiting-approval` (PRD R23).
   * On a done work item: an approval still waited when it became done other than by a done report, so Reopen restores it (PRD R86).
   */
  approvalHeld: boolean;
  createdAt: number;
  /** When the status last changed; Blocked on you counts from it (PRD R27). */
  statusAt: number;
  /** When the work item last entered a working status from another; In progress counts from it (PRD R27). */
  runStartedAt: number | null;
  /** When the work item first became `awaiting-approval` or `finished`; Ready for review sorts and counts from it (PRD R27). */
  readyAt: number | null;
  /** The operator's position in Ready for review, which replaces `readyAt` in the sort (PRD R73). */
  orderAt: number | null;
  /** The ticket's scopeAt, kept when the work item is done, so Done shows the time from entering scope to done (PRD R27). */
  scopeAt: number | null;
  doneAt: number | null;
  doneReason: DoneReason | null;
  /** The work item whose session created this one with a task report (PRD R68). */
  parentId: number | null;
}

export interface Triage {
  id: number;
  ticketId: number;
  /** Null for a pool triage until a pick attaches it to the new work item. */
  workItemId: number | null;
  context: string | null;
  playbook: string | null;
  immediacy: Immediacy | null;
  severity: Severity | null;
  /** The URL of the page or comment the operator reads first (PRD R79); null before triage ends, on failure, and on triages from before it existed. */
  focus: string | null;
  model: string | null;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

export interface Worktree {
  id: number;
  ticketId: number;
  path: string;
  branch: string | null;
  linkedBy: 'report' | 'convention';
}

/** A link a session reported for its ticket, such as an issue, a pull request or a case file (PRD R52). */
export interface Link {
  id: number;
  ticketId: number;
  label: string;
  /** An http(s) URL or an absolute file path. */
  target: string;
  reportedAt: number;
  /** Found in the ticket's own text, such as an issue a support note names, rather than reported by a session (PRD R61). */
  mentioned: boolean;
}

/** A drafted text the operator pastes into the source by hand, such as a customer reply; Copy puts the file's text on the clipboard (PRD R60). */
export interface Paste {
  id: number;
  workItemId: number;
  /** Names the text in the dock, such as `Customer reply`; a later paste with the same label replaces it. */
  label: string;
  /** An absolute path, read when the operator copies it. */
  file: string;
  reportedAt: number;
}

/** A note the operator added to a work item (PRD R87). Local only. */
export interface Comment {
  id: number;
  workItemId: number;
  at: number;
  text: string;
}

export interface Session {
  id: string;
  workItemId: number;
  kind: SessionKind;
  /** The agent the session runs in (PRD R22). */
  provider: Provider;
  nativeSessionId: string | null;
  shortId: string | null;
  cwd: string;
  state: SessionState;
  stateAt: number;
  /** Error kind of a `failed` turn, or `START_PROMPT` or `PERMISSION_PROMPT` for a `waiting` one. */
  stateDetail: string | null;
  outcome: SessionOutcome | null;
  outcomeDetail: string | null;
  startedAt: number;
  endedAt: number | null;
  /** `claude stop` was sent to release the finished turn (PRD R39). */
  released: boolean;
  /** The release stop was sent and has not finished, so the background process may still hold the session. */
  releasing: boolean;
  /** The question a Codex session reported and waits on once its turn ends (PRD R70). */
  question: SessionQuestionReport | null;
  /** The reports its prompt offers; the hub refuses the rest (PRD R23). */
  reports: ReportKind[];
  /** Native IDs of the copies a fork replaced; they no longer change the session (PRD R78). */
  retiredIds: string[];
  /** The short ID of a fork that waits for the session's background process to be released (PRD R78). */
  pendingFork: string | null;
  /** Registered from a window Switchboard did not open, until it ends, so no item window opens it as a copy (PRD R81). */
  external: boolean;
  /** Continue in Background under way: the tab's process must exit before the session resumes in its background process (PRD R89). */
  move: SessionMove | null;
  /** When the last move ended, so a roster read that started before it does not change the session. */
  movedAt: number | null;
}

/**
 * A move to the background (PRD R89). `waiting`: for the tab's process `pid` to exit; `launching`: `claude --bg --resume` ran, and a roster read
 * that lists the session in its background process before `deadline` confirms it. `id` names the attempt, so a result of another is not applied.
 */
export interface SessionMove {
  id: string;
  pid: number;
  phase: 'waiting' | 'launching';
  at: number;
  deadline: number | null;
}

export interface SessionQuestionReport {
  /** Tells apart two reports of the same text, so a roster read that ran across a report is not applied (architecture.md § Codex runner). */
  id: string;
  text: string;
}

/** Why a queued work item has not started (PRD R17, R38, R49, R90). */
export type QueueWait =
  | { kind: 'slot'; used: number; limit: number }
  /** A live session of the ticket; `playbook` is its work item's, or null when it is this work item's own session. */
  | { kind: 'session'; sessionId: string; shortId: string | null; ownItem: boolean; playbook: string | null }
  | { kind: 'snoozed' }
  | { kind: 'blockers'; blockers: TicketBlocker[] };
