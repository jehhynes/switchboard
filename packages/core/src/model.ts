/** Work item statuses (PRD R34). */
export type WorkItemStatus = 'triaging' | 'awaiting-approval' | 'queued' | 'setup' | 'running' | 'blocked' | 'failed' | 'done';

export type DoneReason = 'session' | 'operator' | 'unassigned';

/** The step Retry repeats (PRD R45). */
export type FailedStep = 'triage' | 'pick' | 'setup' | 'task';

/** A `pick` session claims a pool ticket for the operator through a skill (PRD R48). */
export type SessionKind = 'pick' | 'setup' | 'task';

/** Observed session state (PRD R36). */
export type SessionState = 'starting' | 'running' | 'waiting' | 'idle' | 'failed' | 'ended';

export type SessionOutcome = 'done' | 'blocked' | 'failed' | 'stopped';

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
  source: string;
  /** The key people use, such as an issue number. */
  sourceKey: string;
  /** The source's internal ID when its API needs a different one, such as Zoho's. */
  sourceId: string | null;
  title: string;
  url: string;
  /** The assigned state the last complete poll saw. */
  assigned: boolean;
  /** Whether the last complete poll saw the ticket in the source's pool (PRD R47). */
  pool: boolean;
  /** Moved to the Icebox by the operator: no automatic triage or start (PRD R49). Local only. */
  iceboxed: boolean;
  /** The source's sort time, which orders the pool so the longest-waiting customer comes first (PRD R27). */
  sortAt: number | null;
  lastPolledAt: number | null;
  /** The repo an ad-hoc prompt chose. Empty takes the source's `repoRoot` setting. */
  repoRoot: string;
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
  warning: string | null;
  /** The cause shown for `failed` or `blocked`, or a note such as a failed stop. */
  error: string | null;
  failedStep: FailedStep | null;
  /** The ticket left the assigned state while a session was active (PRD R10). */
  unassignedAt: number | null;
  /** When a waiting start was queued, for first-in first-out order. */
  queuedAt: number | null;
  /** Picked from the pool and not yet claimed: the next session is a pick session (PRD R48). */
  needsPick: boolean;
  /** The prompt an approval report named; Approve starts a task session with it (PRD R23, R31). */
  approvalPrompt: string | null;
  approvalSummary: string | null;
  createdAt: number;
  doneAt: number | null;
  doneReason: DoneReason | null;
}

export interface Triage {
  id: number;
  ticketId: number;
  /** Null for a pool triage until a pick attaches it to the new work item. */
  workItemId: number | null;
  context: string | null;
  playbook: string | null;
  summary: string | null;
  immediacy: Immediacy | null;
  severity: Severity | null;
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
}

export interface Session {
  id: string;
  workItemId: number;
  kind: SessionKind;
  provider: string;
  nativeSessionId: string | null;
  shortId: string | null;
  cwd: string;
  state: SessionState;
  stateAt: number;
  /** Error kind of a `failed` turn. */
  stateDetail: string | null;
  outcome: SessionOutcome | null;
  outcomeDetail: string | null;
  startedAt: number;
  endedAt: number | null;
  /** `claude stop` was sent to release the finished turn (PRD R39). */
  released: boolean;
}
