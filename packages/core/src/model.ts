/** Work item statuses (PRD R34). */
export type WorkItemStatus = 'triaging' | 'awaiting-approval' | 'queued' | 'setup' | 'running' | 'blocked' | 'failed' | 'done';

export type DoneReason = 'session' | 'operator' | 'unassigned';

/** The step Retry repeats (PRD R45). */
export type FailedStep = 'triage' | 'setup' | 'task';

export type SessionKind = 'setup' | 'task';

/** Observed session state (PRD R36). */
export type SessionState = 'starting' | 'running' | 'waiting' | 'idle' | 'failed' | 'ended';

export type SessionOutcome = 'done' | 'blocked' | 'failed' | 'stopped';

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
  createdAt: number;
  doneAt: number | null;
  doneReason: DoneReason | null;
}

export interface Triage {
  id: number;
  workItemId: number;
  context: string | null;
  playbook: string | null;
  summary: string | null;
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
