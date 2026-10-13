import type { Playbook } from './playbook.js';
import { activeSession, groupOf, reviewKey } from './group.js';
import { heldSlots, queueWaits } from './queue.js';
import { repoRoots } from './settings.js';
import type { PermissionMode, Provider, Settings } from './settings.js';
import { REPORT_KINDS } from './model.js';
import type { Immediacy, ReportKind, Session, SessionKind, SessionState, Severity, Ticket, WorkItem, WorkItemStatus } from './model.js';
import type { SourceLink } from './source.js';
import type { Actor, EventRecord, NewWorkItem, Store } from './store.js';
import { renderTaskPrompt, sessionContract, sessionPrompt, triagePrompt } from './template.js';
import type { TemplateVariable } from './template.js';

export const ADHOC_SOURCE = 'adhoc';

/** The statuses of a run; entering one from another status starts the Working clock (PRD R27). */
const RUN_STATUSES: ReadonlySet<WorkItemStatus> = new Set(['setup', 'running']);

/** The statuses that put a work item in Ready for review for good (PRD R27). */
const READY_STATUSES: ReadonlySet<WorkItemStatus> = new Set(['awaiting-approval', 'finished']);

/** A ticket that leaves the source's scope stops being snoozed, so it leaves the Snoozed group (PRD R49). */
const UNSNOOZED = { snoozed: false, snoozedUntil: null } as const;

const EMPTY_TRIAGE = { context: null, playbook: null, immediacy: null, severity: null, model: null } as const;

export const MESSAGES = {
  stopped: 'Stopped by you.',
  setupWithoutWorktree: 'Setup ended without a worktree.',
  turnEnded: 'The turn ended without a done report.',
  sessionEnded: 'The session ended without a done report.',
  turnEndedWithoutApproval: 'The turn ended without an approval report.',
  sessionEndedWithoutApproval: 'The session ended without an approval report.',
  noTaskPlaybooks: 'No task playbooks to choose from.',
  doneStillAssigned: 'The session reported done, but the ticket is still assigned to you.',
} as const;

/** One ticket from a complete poll. A ticket of the source missing from the poll is not in the assigned state. */
export interface PolledTicket {
  sourceKey: string;
  /** The reference people use, such as `#123` or `T456`; the source sets it (`{{ticket.ref}}`). */
  ref: string;
  sourceId: string | null;
  title: string;
  url: string;
  assigned: boolean;
  /** Unclaimed in a queue the operator works, so they may pick it (PRD R47). Never true with `assigned`. */
  pool: boolean;
  /** When the customer has waited since, such as Zoho's `customerResponseTime`; it orders the pool (PRD R27). */
  sortAt: number | null;
  /** When the ticket last entered the source's scope, as the source records it, such as Zoho's escalation to Support; null when unknown (PRD R27). */
  enteredAt: number | null;
}

export type Report =
  | { kind: 'stage'; stage: string }
  | { kind: 'worktree'; path: string; branch: string | null }
  /** `assigned`: a fresh read still lists the task's ticket as assigned, so the session did not hand it off (PRD R10). */
  | { kind: 'done'; assigned?: boolean }
  | { kind: 'approval'; prompt: string; summary: string | null; report: string | null }
  | { kind: 'link'; label: string; target: string }
  | { kind: 'playbook'; playbook: string }
  | { kind: 'paste'; label: string; file: string }
  /** A follow-up for a new ad-hoc work item (PRD R68); a null repo or title takes the default. */
  | { kind: 'task'; prompt: string; repo: string | null; title: string | null }
  /** A Codex session's question, which it waits on once its turn ends (PRD R70). */
  | { kind: 'question'; text: string };

/** `open`: the operator opens the waiting session in a Claude tab to answer it there (PRD R70). */
export type StopReason = 'operator' | 'release' | 'open';

export type LiveState = Exclude<SessionState, 'starting' | 'ended'>;

/** A Switchboard session on a successful roster read, with the state its hook marker gives, or the roster's when it has none. */
export interface ObservedSession {
  sessionId: string;
  state: LiveState;
  detail: string | null;
  /** Listed as an interactive session, such as a VS Code tab, rather than Switchboard's background process. */
  interactive?: boolean;
}

export type FlowEvent =
  | { type: 'poll'; source: string; tickets: PolledTicket[] }
  | { type: 'poll-failed'; source: string; error: string }
  | {
      type: 'triage-succeeded';
      triageId: number;
      context: string;
      playbook: string;
      immediacy: Immediacy | null;
      severity: Severity | null;
      model: string | null;
      links?: SourceLink[];
    }
  | { type: 'triage-failed'; triageId: number; error: string; context: string | null }
  /** The hub stopped during triage. Nothing failed, so the work item is triaged again. */
  | { type: 'triage-cancelled'; triageId: number }
  | { type: 'session-started'; sessionId: string; nativeSessionId: string | null; shortId: string }
  | { type: 'session-start-failed'; sessionId: string; message: string }
  /** `checked` lists the sessions the read looked for, so a session whose start completed during the read is not ended; all when absent. */
  | { type: 'roster'; sessions: ObservedSession[]; checked?: string[] }
  | { type: 'marker'; sessionId: string; state: LiveState; detail: string | null }
  | { type: 'report'; sessionId: string; report: Report }
  | { type: 'stop-succeeded'; sessionId: string; reason: StopReason }
  | { type: 'stop-failed'; sessionId: string; reason: StopReason; message: string }
  | { type: 'worktree-found'; source: string; sourceKey: string; path: string; branch: string }
  | { type: 'adhoc'; prompt: string; repoRoot: string }
  | { type: 'approve' | 'mark-done' | 'retriage' | 'stop' | 'delete'; workItemId: number }
  /** `guidance` is added to the task session's prompt (PRD R77). */
  | { type: 'start'; workItemId: number; guidance?: string | null }
  | { type: 'pick'; ticketId: number; guidance?: string | null }
  /** Stops the waiting session the row showed, named by its native ID, to open it in a Claude tab (PRD R70). */
  | { type: 'open-question'; workItemId: number; nativeSessionId: string }
  | { type: 'retriage-pool' | 'restore'; ticketId: number }
  /** Snoozes the ticket until `until`, or indefinitely when null (PRD R49). */
  | { type: 'snooze'; ticketId: number; until: number | null }
  /** Places a Ready for review work item after `after`, or first when null (PRD R73). */
  | { type: 'move'; workItemId: number; after: number | null }
  /** Returns a moved work item to its place by readyAt (PRD R73). */
  | { type: 'reset-position'; workItemId: number }
  | { type: 'tick' };

export interface TriageChoice {
  name: string;
  description: string;
}

export type FlowAction =
  | {
      type: 'triage';
      triageId: number;
      /** Null for a pool triage. */
      workItemId: number | null;
      ticket: Ticket;
      systemPrompt: string;
      choices: TriageChoice[];
      /** Whether the triage playbook rates immediacy and severity. */
      rates: boolean;
      model: string | null;
      timeoutSeconds: number;
    }
  | {
      type: 'start-session';
      sessionId: string;
      workItemId: number;
      kind: SessionKind;
      /** The runner that starts it (PRD R22). */
      provider: Provider;
      cwd: string;
      /** The first message. */
      prompt: string;
      /** The report contract, appended to the system prompt. */
      contract: string;
      name: string;
      permissionMode: PermissionMode;
      model: string | null;
    }
  /** The provider travels with the action, because Delete removes the session's row before its stop runs. */
  | { type: 'stop-session'; sessionId: string; provider: Provider; shortId: string | null; reason: StopReason };

export interface FlowContext {
  now: number;
  settings: Settings;
  playbooks: ReadonlyMap<string, Playbook>;
  /** The report command prefix, `node "<home>/hub.js" report`. */
  report: string;
  newSessionId(): string;
}

export interface FlowResult {
  actions: FlowAction[];
  /** Why an operator action or report was refused, or null. */
  refused: string | null;
}

class Refusal extends Error {}

/**
 * The reports a session's prompt offers (PRD R23). A playbook's task session gets stage, link and the playbook's own; a setup or approved
 * session finishes with done, and an ad-hoc prompt has no playbook to narrow them.
 */
function sessionReports(kind: SessionKind, approved: boolean, playbook: Playbook | null, provider: Provider): ReportKind[] {
  // A background Codex run cannot wait on the operator mid-turn, so it reports its question (mechanics M31).
  const asks = (entry: ReportKind) => entry === 'question' && provider === 'codex';

  if (kind !== 'task' || approved) {
    return REPORT_KINDS.filter((entry) => ['stage', 'worktree', 'done', 'link', 'task'].includes(entry) || asks(entry));
  }

  // An ad-hoc work item has no playbook to change.
  return playbook === null
    ? REPORT_KINDS.filter((entry) => entry !== 'playbook' && (entry !== 'question' || asks(entry)))
    : REPORT_KINDS.filter((entry) => entry === 'stage' || entry === 'link' || entry === 'task' || asks(entry) || (playbook.reports as readonly string[]).includes(entry));
}

/** Why a task session's turn or process ended without the done or approval report its prompt offered. */
function endedMessage(session: Session, turn: boolean): string {
  if (session.reports.includes('done')) {
    return turn ? MESSAGES.turnEnded : MESSAGES.sessionEnded;
  }

  return turn ? MESSAGES.turnEndedWithoutApproval : MESSAGES.sessionEndedWithoutApproval;
}

const TURN_ENDED: readonly SessionState[] = ['idle', 'failed'];

/** The prompt's first non-empty line, which titles an ad-hoc ticket. */
function firstLine(prompt: string): string {
  return prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
}

/** The operator's guidance from Start, trimmed, or null when there is none (PRD R77). */
function guidanceOf(text: string | null | undefined): string | null {
  return text?.trim() || null;
}

/** Compares repo paths as Windows does: either separator, any case, no trailing separator. */
function samePath(a: string, b: string): boolean {
  const key = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

  return key(a) === key(b);
}

const OPERATOR_EVENTS: ReadonlySet<FlowEvent['type']> = new Set(['adhoc', 'start', 'approve', 'mark-done', 'retriage', 'stop', 'delete', 'open-question', 'pick', 'retriage-pool', 'restore', 'snooze', 'move', 'reset-position']);

/**
 * Events logged even when they change nothing, because they record a request or a report (PRD R59). The rest, such as polls and
 * roster reads, are logged only when they change a row.
 */
const ALWAYS_LOGGED: ReadonlySet<FlowEvent['type']> = new Set([...OPERATOR_EVENTS, 'report', 'session-start-failed', 'stop-failed']);

function actorOf(type: FlowEvent['type']): Actor {
  if (OPERATOR_EVENTS.has(type)) {
    return 'operator';
  }

  switch (type) {
    case 'report':
      return 'session';
    case 'poll':
    case 'poll-failed':
      return 'source';
    case 'triage-succeeded':
    case 'triage-failed':
      return 'triage';
    default:
      return 'hub';
  }
}

/** The event's own fields for the log: no prompt, context or polled list. */
function detailOf(event: FlowEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'poll':
    case 'poll-failed':
      return { source: event.source };
    case 'triage-succeeded':
      return { triageId: event.triageId, playbook: event.playbook, immediacy: event.immediacy, severity: event.severity, model: event.model };
    case 'triage-failed':
      return { triageId: event.triageId, error: event.error };
    case 'triage-cancelled':
      return { triageId: event.triageId };
    case 'session-started':
      return { shortId: event.shortId };
    case 'session-start-failed':
      return { message: event.message };
    case 'marker':
      return { state: event.state, detail: event.detail };
    case 'report': {
      const { prompt: _prompt, ...report } = event.report as Report & { prompt?: string };
      return report;
    }
    case 'stop-succeeded':
      return { reason: event.reason };
    case 'stop-failed':
      return { reason: event.reason, message: event.message };
    case 'worktree-found':
      return { path: event.path, branch: event.branch };
    case 'adhoc':
      return { repoRoot: event.repoRoot };
    case 'start':
    case 'pick':
      return guidanceOf(event.guidance) === null ? null : { guidance: guidanceOf(event.guidance) };
    case 'snooze':
      return { until: event.until };
    case 'move':
      return { after: event.after };
    case 'delete':
      return { workItemId: event.workItemId };
    default:
      return null;
  }
}

/** The ticket, work item and session an event names, when it names one that exists. */
function subjectOf(store: Store, event: FlowEvent): Pick<EventRecord, 'ticketId' | 'workItemId' | 'sessionId'> {
  const none = { ticketId: null, workItemId: null, sessionId: null };
  const ofItem = (workItemId: number | null, sessionId: string | null = null) => {
    const item = workItemId === null ? null : store.workItem(workItemId);
    return item === null ? none : { ticketId: item.ticketId, workItemId: item.id, sessionId };
  };

  if ('sessionId' in event) {
    const session = store.session(event.sessionId);
    return session === null ? none : ofItem(session.workItemId, session.id);
  }

  // The ticket's log keeps the delete, because the work item's own log is deleted with it (PRD R76).
  if (event.type === 'delete') {
    return { ...none, ticketId: store.workItem(event.workItemId)?.ticketId ?? null };
  }

  if ('workItemId' in event) {
    return ofItem(event.workItemId);
  }

  if ('triageId' in event) {
    const triage = store.triage(event.triageId);
    return triage === null ? none : { ticketId: triage.ticketId, workItemId: triage.workItemId, sessionId: null };
  }

  if ('ticketId' in event) {
    return { ...none, ticketId: store.ticket(event.ticketId)?.id ?? null };
  }

  if (event.type === 'worktree-found') {
    return { ...none, ticketId: store.findTicket(event.source, event.sourceKey)?.id ?? null };
  }

  return none;
}

/** The event as the activity log records it (PRD R59). */
export function eventRecord(store: Store, event: FlowEvent, at: number): EventRecord {
  return { at, type: event.type, actor: actorOf(event.type), ...subjectOf(store, event), detail: detailOf(event) };
}

/** Logs an event the hub refused before the flow saw it, such as a worktree report naming no git worktree. */
export function recordRefusal(store: Store, event: FlowEvent, at: number, message: string): void {
  const record = eventRecord(store, event, at);

  try {
    store.beginEvent(record, record.ticketId !== null);
    store.refuseEvent(message);
  } finally {
    store.endEvent();
  }
}

/** Decides what one event changes and which actions the hub runs. Call it inside one store transaction. */
export function handle(store: Store, event: FlowEvent, context: FlowContext): FlowResult {
  const flow = new Flow(store, context);

  try {
    store.beginEvent({ at: context.now, type: 'wake', actor: 'hub', ticketId: null, workItemId: null, sessionId: null, detail: null });
    flow.wake();
    const record = eventRecord(store, event, context.now);

    store.beginEvent(record, ALWAYS_LOGGED.has(event.type) && record.ticketId !== null);

    try {
      flow.apply(event);
    } catch (error) {
      if (error instanceof Refusal) {
        store.refuseEvent(error.message);
        return { actions: [], refused: error.message };
      }

      throw error;
    }

    flow.schedule();

    return { actions: flow.actions, refused: null };
  } finally {
    store.endEvent();
  }
}

class Flow {
  readonly actions: FlowAction[] = [];

  constructor(
    private readonly store: Store,
    private readonly context: FlowContext,
  ) {}

  private get now(): number {
    return this.context.now;
  }

  apply(event: FlowEvent): void {
    switch (event.type) {
      case 'poll':
        return this.poll(event.source, event.tickets);
      case 'poll-failed':
      case 'tick':
        return;
      case 'triage-succeeded':
        return this.triageSucceeded(event);
      case 'triage-failed':
        return this.triageFailed(event.triageId, event.error, event.context);
      case 'triage-cancelled':
        return this.triageCancelled(event.triageId);
      case 'session-started':
        return this.sessionStarted(event.sessionId, event.nativeSessionId, event.shortId);
      case 'session-start-failed':
        return this.sessionStartFailed(event.sessionId, event.message);
      case 'roster':
        return this.roster(event.sessions, event.checked);
      case 'marker':
        return this.marker(event.sessionId, event.state, event.detail);
      case 'report':
        return this.report(event.sessionId, event.report);
      case 'stop-succeeded':
        return this.stopSucceeded(event.sessionId, event.reason);
      case 'stop-failed':
        return this.stopFailed(event.sessionId, event.reason, event.message);
      case 'worktree-found':
        return this.worktreeFound(event.source, event.sourceKey, event.path, event.branch);
      case 'adhoc':
        return this.adhoc(event.prompt, event.repoRoot);
      case 'start':
        return this.start(this.openItem(event.workItemId), guidanceOf(event.guidance));
      case 'approve':
        return this.approve(this.openItem(event.workItemId));
      case 'mark-done':
        return this.done(this.openItem(event.workItemId), 'operator', null);
      case 'retriage':
        return this.retriage(this.openItem(event.workItemId));
      case 'stop':
        return this.stop(this.knownItem(event.workItemId));
      case 'delete':
        return this.delete(this.knownItem(event.workItemId));
      case 'open-question':
        return this.openQuestion(this.openItem(event.workItemId), event.nativeSessionId);
      case 'pick':
        return this.pick(this.poolTicket(event.ticketId), guidanceOf(event.guidance));
      case 'retriage-pool':
        return this.retriagePool(this.poolTicket(event.ticketId));
      case 'snooze':
        return this.snooze(event.ticketId, event.until);
      case 'restore':
        return this.restore(event.ticketId);
      case 'move':
        return this.move(this.reviewItem(event.workItemId), event.after);
      case 'reset-position':
        return this.store.updateWorkItem(this.reviewItem(event.workItemId).id, { orderAt: null });
    }
  }

  /** Ends every snooze whose wake time has passed, so the ticket returns to its group on the next event (PRD R49). */
  wake(): void {
    for (const ticket of this.store.dueSnoozes(this.now)) {
      this.store.updateTicket(ticket.id, { snoozed: false, snoozedUntil: null });
    }
  }

  // Sources

  private poll(source: string, polled: PolledTicket[]): void {
    const seen = new Set<string>();

    for (const entry of polled) {
      seen.add(entry.sourceKey);

      const known = this.store.findTicket(source, entry.sourceKey);
      const fields = {
        ref: entry.ref,
        sourceId: entry.sourceId,
        title: entry.title,
        url: entry.url,
        assigned: entry.assigned,
        pool: entry.pool,
        sortAt: entry.sortAt,
        scopeAt: this.scopeAt(known, entry),
        lastPolledAt: this.now,
        ...(entry.assigned || entry.pool ? {} : UNSNOOZED),
      };

      if (known === null) {
        const ticket = this.store.insertTicket({ source, sourceKey: entry.sourceKey, repoRoot: '', snoozed: false, snoozedUntil: null, ...fields });

        if (entry.assigned) {
          this.createWorkItem(ticket.id);
        }

        continue;
      }

      this.store.updateTicket(known.id, fields);

      if (known.pool && !entry.pool) {
        this.leftPool(known.id);
      }

      if (entry.assigned && !known.assigned) {
        this.createWorkItem(known.id);
      } else if (!entry.assigned && known.assigned) {
        this.left(known.id);
      }
    }

    for (const ticket of this.store.tickets(source)) {
      if (!seen.has(ticket.sourceKey) && (ticket.assigned || ticket.pool)) {
        this.store.updateTicket(ticket.id, { assigned: false, pool: false, lastPolledAt: this.now, ...UNSNOOZED });

        if (ticket.pool) {
          this.leftPool(ticket.id);
        }

        if (ticket.assigned) {
          this.left(ticket.id);
        }
      }
    }
  }

  /**
   * When the ticket entered the source's scope (PRD R53). The source's time wins, because its scope can be wider than the assigned state and
   * the pool, such as a GitHub issue on another status. Without one, the ticket keeps its time, or takes this poll's when it has none.
   */
  private scopeAt(known: Ticket | null, entry: PolledTicket): number | null {
    return entry.enteredAt ?? known?.scopeAt ?? (entry.assigned || entry.pool ? this.now : null);
  }

  /** A ticket that entered the assigned state gets a work item, unless it already has an open one, such as a picked pool ticket's (PRD R48). */
  private createWorkItem(ticketId: number): void {
    const open = this.store.workItemsForTicket(ticketId).filter((item) => item.status !== 'done');

    if (open.length > 0) {
      // Assigned again: the deferred unassignment no longer applies (PRD R10).
      for (const item of open.filter((entry) => entry.unassignedAt !== null)) {
        this.store.updateWorkItem(item.id, { unassignedAt: null });
      }

      return;
    }

    this.store.insertWorkItem({
      ticketId,
      playbook: null,
      status: 'triaging',
      stage: null,
      stageAt: null,
      taskPrompt: null,
      guidance: null,
      warning: null,
      error: null,
      unassignedAt: null,
      queuedAt: null,
      approvalPrompt: null,
      approvalSummary: null,
      approvalReport: null,
      approvalHeld: false,
      createdAt: this.now,
      statusAt: this.now,
      readyAt: null,
      orderAt: null,
      runStartedAt: this.now,
      scopeAt: null,
      doneAt: null,
      doneReason: null,
      parentId: null,
    });
  }

  /** A ticket that left the pool without a pick loses its pool triage, so it is triaged again if it returns (PRD R47). */
  private leftPool(ticketId: number): void {
    for (const triage of this.store.poolTriages(ticketId)) {
      this.store.deleteTriage(triage.id);
    }
  }

  /**
   * PRD R10: deleted when it never had a session, done now when no session is active, otherwise when the active session reports or ends.
   * A running triage also defers the deletion, so its row keeps holding a `triage.concurrency` slot until the classifier finishes.
   */
  private left(ticketId: number): void {
    const running = new Set(this.store.runningTriages().map((triage) => triage.workItemId));

    for (const item of this.store.workItemsForTicket(ticketId)) {
      if (item.status === 'done') {
        continue;
      }

      if (this.store.sessionsFor(item.id).length === 0) {
        if (!running.has(item.id)) {
          this.store.deleteWorkItem(item.id);
        } else if (item.unassignedAt === null) {
          this.store.updateWorkItem(item.id, { unassignedAt: this.now });
        }
      } else if (this.activeSession(item) === null) {
        this.done(item, 'unassigned', null);
      } else if (item.unassignedAt === null) {
        this.store.updateWorkItem(item.id, { unassignedAt: this.now });
      }
    }
  }

  /** Deletes a work item whose ticket left during its triage, when it never had a session (PRD R10). */
  private deletedAfterTriage(item: WorkItem): boolean {
    if (item.unassignedAt === null || this.store.sessionsFor(item.id).length > 0) {
      return false;
    }

    this.store.deleteWorkItem(item.id);
    return true;
  }

  private worktreeFound(source: string, sourceKey: string, path: string, branch: string): void {
    const ticket = this.store.findTicket(source, sourceKey);

    if (ticket !== null && this.store.worktreeFor(ticket.id) === null) {
      this.store.linkWorktree({ ticketId: ticket.id, path, branch, linkedBy: 'convention' });
    }
  }

  private adhoc(prompt: string, repoRoot: string): void {
    const title = firstLine(prompt);

    if (title === '') {
      throw new Refusal('The prompt is empty.');
    }

    if (repoRoot === '') {
      throw new Refusal('Choose a repo for the prompt.');
    }

    this.insertAdhoc(prompt, title, repoRoot, null);
  }

  /**
   * PRD R68: a session's follow-up becomes an unstarted ad-hoc work item, in the named repo or else the reporting ticket's, which must be
   * a configured repo root. A repeated report adds nothing while the earlier work item is open.
   */
  private task(session: Session, report: Extract<Report, { kind: 'task' }>): void {
    const line = firstLine(report.prompt);

    if (line === '') {
      throw new Refusal('The prompt is empty.');
    }

    const parent = this.store.workItem(session.workItemId)!;
    const ticket = this.store.ticket(parent.ticketId)!;
    const wanted = report.repo ?? (ticket.repoRoot || this.context.settings.sources[ticket.source]?.repoRoot || '');
    const roots = repoRoots(this.context.settings);
    const repoRoot = roots.find((root) => samePath(root, wanted));

    if (repoRoot === undefined) {
      throw new Refusal(`${wanted === '' ? 'Name a repo with --repo.' : `${wanted} is not a configured repo root.`} Repo roots: ${roots.join(', ') || 'none'}.`);
    }

    if (this.store.workItemsWithParent(parent.id).some((item) => item.status !== 'done' && item.taskPrompt === report.prompt)) {
      return;
    }

    this.insertAdhoc(report.prompt, report.title?.trim() || line, repoRoot, parent.id);
  }

  /** An ad-hoc ticket and work item: queued when the operator typed the prompt, unstarted when a session reported it (PRD R6, R68). */
  private insertAdhoc(prompt: string, title: string, repoRoot: string, parentId: number | null): void {
    const keys = this.store.tickets(ADHOC_SOURCE).map((ticket) => Number(ticket.sourceKey));
    const sourceKey = String(Math.max(0, ...keys) + 1);
    const ticket = this.store.insertTicket({ source: ADHOC_SOURCE, sourceKey, ref: `#${sourceKey}`, sourceId: null, title, url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: this.now, lastPolledAt: null, repoRoot });
    const queued = parentId === null;

    if (parentId !== null) {
      this.store.noteEvent({ childTicketId: ticket.id, childRef: ticket.ref, childTitle: title });
    }

    this.store.insertWorkItem({
      ticketId: ticket.id,
      playbook: null,
      status: queued ? 'queued' : 'unstarted',
      stage: null,
      stageAt: null,
      taskPrompt: prompt,
      guidance: null,
      warning: null,
      error: null,
      unassignedAt: null,
      queuedAt: queued ? this.now : null,
      approvalPrompt: null,
      approvalSummary: null,
      approvalReport: null,
      approvalHeld: false,
      createdAt: this.now,
      statusAt: this.now,
      readyAt: null,
      orderAt: null,
      runStartedAt: queued ? this.now : null,
      scopeAt: null,
      doneAt: null,
      doneReason: null,
      parentId,
    });
  }

  // Triage

  private triageSucceeded(event: Extract<FlowEvent, { type: 'triage-succeeded' }>): void {
    const triage = this.store.triage(event.triageId);

    if (triage === null || triage.endedAt !== null) {
      return;
    }

    const playbook = this.context.playbooks.get(event.playbook);

    if (playbook === undefined || playbook.kind !== 'task') {
      this.triageFailed(event.triageId, `Triage chose an unknown playbook: ${event.playbook}.`, event.context);
      return;
    }

    this.store.updateTriage(triage.id, {
      endedAt: this.now,
      context: event.context,
      playbook: event.playbook,
      immediacy: event.immediacy,
      severity: event.severity,
      model: event.model,
    });

    for (const link of event.links ?? []) {
      this.store.addLink({ ticketId: triage.ticketId, label: link.label, target: link.target, reportedAt: this.now });
    }

    const item = triage.workItemId === null ? null : this.store.workItem(triage.workItemId)!;

    if (item?.status !== 'triaging' || this.deletedAfterTriage(item)) {
      return;
    }

    this.store.updateWorkItem(item.id, { playbook: playbook.name, taskPrompt: null, error: null });

    if (playbook.autoStart) {
      this.queue(item);
    } else {
      this.setStatus(item.id, { status: 'unstarted' });
    }
  }

  private triageFailed(triageId: number, error: string, context: string | null): void {
    const triage = this.store.triage(triageId);

    if (triage === null || triage.endedAt !== null) {
      return;
    }

    this.store.updateTriage(triage.id, { endedAt: this.now, error, context });

    const item = triage.workItemId === null ? null : this.store.workItem(triage.workItemId)!;

    if (item?.status === 'triaging' && !this.deletedAfterTriage(item)) {
      this.fail(item, error);
    }
  }

  private triageCancelled(triageId: number): void {
    const triage = this.store.triage(triageId);

    if (triage === null || triage.endedAt !== null) {
      return;
    }

    // A cancelled pool triage is removed, so the pool ticket is due again; a work item stays triaging.
    if (triage.workItemId === null) {
      this.store.deleteTriage(triage.id);
    } else {
      this.store.updateTriage(triage.id, { endedAt: this.now, error: 'Cancelled.' });
      this.deletedAfterTriage(this.store.workItem(triage.workItemId)!);
    }
  }

  /** Triages a work item, or a pool ticket when `item` is null. Choices are the task playbooks of the source's namespace. */
  private startTriage(ticket: Ticket, item: WorkItem | null): void {
    const source = this.context.settings.sources[ticket.source];
    const name = source?.triagePlaybook ?? '';
    const playbook = this.context.playbooks.get(name);
    const prefix = source?.namespace ? `${source.namespace}:` : '';
    const fail = (error: string) => {
      if (item === null) {
        this.store.insertTriage({ ...EMPTY_TRIAGE, ticketId: ticket.id, workItemId: null, startedAt: this.now, endedAt: this.now, error });
      } else {
        this.fail(item, error);
      }
    };

    if (playbook === undefined || playbook.kind !== 'triage') {
      fail(name === '' ? `sources.${ticket.source}.triagePlaybook is not set.` : `Triage playbook ${name} is not loaded.`);
      return;
    }

    const choices = [...this.context.playbooks.values()]
      .filter((candidate) => candidate.kind === 'task' && candidate.name.startsWith(prefix))
      .map((candidate) => ({ name: candidate.name, description: candidate.description }));

    if (choices.length === 0) {
      fail(prefix === '' ? MESSAGES.noTaskPlaybooks : `No task playbooks in the ${source!.namespace} namespace.`);
      return;
    }

    const systemPrompt = triagePrompt(playbook.template, choices);

    if ('error' in systemPrompt) {
      fail(`Triage playbook ${name}: ${systemPrompt.error}`);
      return;
    }

    const triage = this.store.insertTriage({ ...EMPTY_TRIAGE, ticketId: ticket.id, workItemId: item?.id ?? null, startedAt: this.now, endedAt: null, error: null });

    this.actions.push({
      type: 'triage',
      triageId: triage.id,
      workItemId: item?.id ?? null,
      ticket,
      systemPrompt: systemPrompt.text,
      choices,
      rates: playbook.rates,
      model: this.context.settings.triage.model || null,
      timeoutSeconds: this.context.settings.triage.timeoutSeconds,
    });
  }

  // Sessions

  private session(sessionId: string): Session {
    const session = this.store.session(sessionId);

    if (session === null) {
      throw new Refusal(`Unknown session ${sessionId}.`);
    }

    return session;
  }

  private sessionStarted(sessionId: string, nativeSessionId: string | null, shortId: string): void {
    const session = this.session(sessionId);

    if (session.state === 'starting') {
      this.store.updateSession(sessionId, { nativeSessionId, shortId, state: 'running', stateAt: this.now });
    }
  }

  /** PRD R41: Claude's own message says how to trust an untrusted directory. */
  private sessionStartFailed(sessionId: string, message: string): void {
    const session = this.session(sessionId);

    this.store.updateSession(sessionId, { state: 'ended', stateAt: this.now, endedAt: this.now, outcome: 'failed', outcomeDetail: message, released: true });

    const item = this.latest(session);

    if (item === null) {
      return;
    }

    if (item.unassignedAt !== null) {
      this.done(item, 'unassigned', null);
      return;
    }

    this.fail(item, message);
  }

  /** Liveness comes from the roster alone (GC M20): a listed session is alive, an unlisted one has ended. */
  private roster(observed: ObservedSession[], checked?: string[]): void {
    const listed = new Map(observed.map((entry) => [entry.sessionId, entry]));

    for (const entry of observed) {
      const session = this.store.session(entry.sessionId);

      if (session !== null && session.state !== 'starting') {
        // An opened question waits until the operator's tab runs or asks again; a background listing was read before the stop, and an idle tab has
        // not answered, so neither changes the session or the clock (PRD R70).
        if (session.outcome === 'opened' && session.state === 'ended' && !(entry.interactive === true && (entry.state === 'running' || entry.state === 'waiting'))) {
          continue;
        }

        // An interactive session is the operator's; Switchboard never stops it (PRD R39).
        // The operator has the session now and answers in its own view, so a reported question is no longer waited on.
        if (entry.interactive === true && (!session.released || session.releasing || session.question !== null)) {
          this.store.updateSession(session.id, { released: true, releasing: false, question: null });
        }

        this.setState({ ...session, released: session.released || entry.interactive === true, releasing: session.releasing && entry.interactive !== true }, entry.state, entry.detail);
      }
    }

    const looked = checked === undefined ? null : new Set(checked);

    for (const session of this.store.activeSessions()) {
      if (session.state !== 'starting' && !listed.has(session.id) && (looked === null || looked.has(session.id))) {
        // Its background process is gone, so a later resume (such as in a VS Code tab) is never released (PRD R39).
        this.store.updateSession(session.id, { state: 'ended', stateAt: this.now, stateDetail: null, endedAt: this.now, released: true, releasing: false, question: null });
        this.ended({ ...session, state: 'ended' });
      }
    }
  }

  /** A hook marker sets the state of a live session only, because a killed process leaves its marker behind. */
  private marker(sessionId: string, state: LiveState, detail: string | null): void {
    const session = this.session(sessionId);

    if (session.state !== 'starting' && session.state !== 'ended') {
      this.setState(session, state, detail);
    }
  }

  private setState(session: Session, state: LiveState, detail: string | null): void {
    if (session.state === state && session.stateDetail === detail) {
      return;
    }

    const reopened = session.outcome === 'opened' ? { outcome: null, outcomeDetail: null } : {};

    this.store.updateSession(session.id, { state, stateAt: this.now, stateDetail: detail, endedAt: null, ...reopened });

    const current = { ...session, state, stateDetail: detail, ...reopened };
    // A new turn after the last one ended, as when the operator resumes the session in VS Code.
    const resumed = (state === 'running' || state === 'waiting') && (session.state === 'ended' || TURN_ENDED.includes(session.state));

    if (TURN_ENDED.includes(state)) {
      this.release(current);
    }

    const item = this.latest(current);

    if (item === null || current.kind !== 'task') {
      return;
    }

    if (TURN_ENDED.includes(state) && current.outcome === null && item.status === 'running') {
      const cause = state === 'failed' ? `The turn failed: ${detail ?? 'unknown error'}.` : null;

      if (item.unassignedAt !== null) {
        this.done(item, 'unassigned', null);
      } else if (item.approvalHeld) {
        this.restoreApproval(item, cause);
      } else if (cause === null) {
        this.endRun(item, current, true);
      } else {
        this.block(item, cause);
      }
    } else if (resumed && (item.status === 'blocked' || item.status === 'finished')) {
      this.store.updateSession(session.id, { outcome: null, outcomeDetail: null });
      this.setStatus(item.id, { status: 'running', error: null });
    } else if (state === 'running' && item.status === 'awaiting-approval') {
      // The operator gave the session more work after its approval report; the report waits until the run ends (PRD R34).
      this.store.updateSession(session.id, { outcome: null, outcomeDetail: null });
      this.setStatus(item.id, { status: 'running', approvalHeld: true, error: null });
    }
  }

  /** The session's process is gone: decide setup, or settle a task that never reported. */
  private ended(session: Session): void {
    const item = this.latest(session);

    if (item === null) {
      return;
    }

    if (session.kind === 'setup') {
      if (item.status !== 'setup') {
        return;
      }

      if (item.unassignedAt !== null) {
        this.done(item, 'unassigned', null);
      } else if (this.store.worktreeFor(item.ticketId) === null) {
        this.fail(item, MESSAGES.setupWithoutWorktree);
      } else {
        this.store.updateSession(session.id, { outcome: 'done' });

        // A snoozed ticket's task waits in the queue until the ticket wakes or is restored (PRD R49).
        if (this.store.ticket(item.ticketId)!.snoozed) {
          this.queue(item);
        } else {
          this.startSession(item);
        }
      }

      return;
    }

    // A session that reported done with its ticket still assigned leaves the work item blocked until the ticket leaves.
    if (item.unassignedAt !== null) {
      this.done(item, 'unassigned', null);
    } else if (session.outcome === 'done') {
      return;
    } else if (item.status === 'running') {
      if (item.approvalHeld) {
        this.restoreApproval(item, null);
      } else {
        this.endRun(item, session, false);
      }
    }
  }

  /** PRD R39: stop a session whose turn has ended, once, so it can resume in VS Code. */
  private release(session: Session): void {
    if (session.released) {
      return;
    }

    this.store.updateSession(session.id, { released: true, releasing: true });
    this.actions.push({ type: 'stop-session', sessionId: session.id, provider: session.provider, shortId: session.shortId, reason: 'release' });
  }

  private report(sessionId: string, report: Report): void {
    const session = this.session(sessionId);

    if (!session.reports.includes(report.kind)) {
      throw new Refusal(`This session's report contract does not offer the ${report.kind} report.`);
    }

    // A report after Open in Claude or Codex comes from the session the operator resumed, so its question no longer waits (PRD R70).
    if (session.outcome === 'opened') {
      this.store.updateSession(sessionId, { outcome: null, outcomeDetail: null });
    }

    const item = this.latest(session);

    switch (report.kind) {
      case 'stage':
        if (item !== null) {
          this.store.updateWorkItem(item.id, { stage: report.stage, stageAt: this.now });
        }
        return;
      case 'worktree': {
        const ticketId = this.store.workItem(session.workItemId)!.ticketId;
        this.store.linkWorktree({ ticketId, path: report.path, branch: report.branch, linkedBy: 'report' });
        return;
      }
      case 'done':
        this.store.updateSession(sessionId, { outcome: 'done', outcomeDetail: null });

        if (item !== null && session.kind === 'task') {
          if (report.assigned === true) {
            this.block(item, MESSAGES.doneStillAssigned);
          } else {
            this.done(item, 'session', null);
          }
        }

        return;
      case 'approval':
        // The work is ready; Approve starts a new task session with the prompt that publishes it (PRD R23, R31).
        if (item !== null && session.kind === 'task') {
          this.setStatus(item.id, { status: 'awaiting-approval', approvalPrompt: report.prompt, approvalSummary: report.summary, approvalReport: report.report, error: null });
        }

        return;
      case 'link':
        // Links belong to the ticket, so a returned ticket keeps them (PRD R52).
        this.store.addLink({ ticketId: this.store.workItem(session.workItemId)!.ticketId, label: report.label, target: report.target, reportedAt: this.now });
        return;
      case 'playbook':
        if (item !== null && session.kind === 'task') {
          this.store.updateWorkItem(item.id, { playbook: this.handoffPlaybook(item, report.playbook) });
        }

        return;
      case 'paste':
        // Pastes belong to the work item whose draft they are; Copy shows on its approval row (PRD R60).
        if (item !== null) {
          this.store.setPaste({ workItemId: item.id, label: report.label, file: report.file, reportedAt: this.now });
        }

        return;
      case 'task':
        // Follow-up work is new work, so it is recorded whatever the state of the reporting work item.
        return this.task(session, report);
      case 'question':
        // A session the operator resumed elsewhere asks there; only its background run waits on a reported question.
        if (session.state !== 'ended' && (!session.released || session.releasing)) {
          this.store.updateSession(sessionId, { question: { id: this.context.newSessionId(), text: report.text } });
        }

        return;
    }
  }

  /** The playbook a session hands its work item to: a task playbook in the work item's namespace (PRD R23). */
  private handoffPlaybook(item: WorkItem, name: string): string {
    const namespace = item.playbook?.split(':')[0];
    const playbook = this.context.playbooks.get(name);

    if (playbook === undefined || playbook.kind !== 'task' || name.split(':')[0] !== namespace) {
      throw new Refusal(`${name} is not a task playbook in the ${namespace} namespace.`);
    }

    return name;
  }

  private stop(item: WorkItem): void {
    const session = this.activeSession(item);

    if (session === null) {
      throw new Refusal('The work item has no active session.');
    }

    this.actions.push({ type: 'stop-session', sessionId: session.id, provider: session.provider, shortId: session.shortId, reason: 'operator' });
  }

  /**
   * PRD R76: stops a session running in its background process, then deletes the work item. A starting session has no short ID to stop yet; a
   * session the operator resumed is theirs, so it keeps running, and its later reports are refused as from an unknown session.
   */
  private delete(item: WorkItem): void {
    const session = this.activeSession(item);

    if (session?.state === 'starting') {
      throw new Refusal('The session is starting. Delete the work item once it has started.');
    }

    // A session whose release stop has not finished may still run in its background process.
    if (session !== null && (!session.released || session.releasing)) {
      this.actions.push({ type: 'stop-session', sessionId: session.id, provider: session.provider, shortId: session.shortId, reason: 'operator' });
    }

    this.store.deleteWorkItem(item.id);

    // A snoozed ticket with no row left would stay hidden on GitHub boards (PRD R56) until it left scope.
    const ticket = this.store.ticket(item.ticketId)!;

    if (ticket.snoozed && !ticket.pool && this.store.workItemsForTicket(ticket.id).length === 0) {
      this.store.updateTicket(ticket.id, UNSNOOZED);
    }
  }

  private stopSucceeded(sessionId: string, reason: StopReason): void {
    const session = this.session(sessionId);

    if (session.state === 'ended') {
      return;
    }

    // A session that already reported done ends normally, so a finished setup still starts its task.
    const stopped = reason !== 'release' && session.outcome !== 'done';
    // Open in Claude or Codex leaves the status as it was: the question still waits on the operator (PRD R70).
    const outcome = reason === 'open' ? { outcome: 'opened' as const, outcomeDetail: null } : { outcome: 'stopped' as const, outcomeDetail: MESSAGES.stopped };

    this.store.updateSession(sessionId, {
      state: 'ended',
      released: true,
      releasing: false,
      question: null,
      // An opened question keeps the time it was asked, which the row's clock counts from (PRD R27).
      ...(reason === 'open' ? {} : { stateAt: this.now }),
      endedAt: this.now,
      ...(stopped && session.outcome === null ? outcome : {}),
    });

    if (!stopped) {
      this.ended({ ...session, state: 'ended' });
      return;
    }

    const item = this.latest(session);

    if (item === null) {
      return;
    }

    if (item.unassignedAt !== null) {
      this.done(item, 'unassigned', null);
    } else if (reason === 'open') {
      return;
    } else if (item.approvalHeld || item.status === 'awaiting-approval') {
      // A stop is not a decision on the approval, so Approve stays offered (PRD R40).
      this.restoreApproval(item, MESSAGES.stopped);
    } else {
      this.block(item, MESSAGES.stopped);
    }
  }

  /** The session stays as it was, so the operator can stop it again. */
  private stopFailed(sessionId: string, reason: StopReason, message: string): void {
    const session = this.session(sessionId);
    const item = this.latest(session);

    if (item !== null) {
      this.store.updateWorkItem(item.id, { error: `${reason === 'release' ? 'Release' : 'Stop'} failed: ${message}` });
    }
  }

  /** The work item's active session when it is the row's session, runs in its background process and waits on the operator (PRD R70). */
  private waitingBackground(item: WorkItem, nativeSessionId: string): Session & { shortId: string } {
    const session = this.activeSession(item);

    if (session === null || session.state === 'starting' || session.shortId === null || session.released) {
      throw new Refusal('The work item has no session running in its background process.');
    }

    if (session.nativeSessionId !== nativeSessionId) {
      throw new Refusal('The work item has another session now.');
    }

    if (session.state !== 'waiting') {
      throw new Refusal('The session is not waiting on a question.');
    }

    return session as Session & { shortId: string };
  }

  /** Stops the background session, so the window can open it in a Claude tab, which asks the question again (PRD R70). */
  private openQuestion(item: WorkItem, nativeSessionId: string): void {
    const session = this.waitingBackground(item, nativeSessionId);

    this.actions.push({ type: 'stop-session', sessionId: session.id, provider: session.provider, shortId: session.shortId, reason: 'open' });
  }

  // Operator actions

  private knownItem(workItemId: number): WorkItem {
    const item = this.store.workItem(workItemId);

    if (item === null) {
      throw new Refusal(`Unknown work item ${workItemId}.`);
    }

    return item;
  }

  private openItem(workItemId: number): WorkItem {
    const item = this.knownItem(workItemId);

    if (item.status === 'done') {
      throw new Refusal('The work item is done.');
    }

    return item;
  }

  /** A work item in Ready for review: open, ready, not snoozed and not blocked on the operator (PRD R73). */
  private reviewItem(workItemId: number): WorkItem {
    const item = this.openItem(workItemId);

    if (this.store.ticket(item.ticketId)!.snoozed || groupOf({ ...item, sessions: this.store.sessionsFor(item.id) }) !== 'review') {
      throw new Refusal('The work item is not in Ready for review.');
    }

    return item;
  }

  /**
   * Sets `orderAt` between `after` and the next work item in Ready for review's order, or first when `after` is null. The order holds every
   * ready work item, snoozed and blocked ones too, so they return to their places, and stays before now, so a newly ready one comes last.
   */
  private move(item: WorkItem, after: number | null): void {
    if (after === item.id) {
      throw new Refusal('A work item cannot move after itself.');
    }

    if (after !== null) {
      this.reviewItem(after);
    }

    let order = this.store.readyWorkItems().filter((entry) => entry.id !== item.id);
    let index = after === null ? 0 : order.findIndex((entry) => entry.id === after) + 1;
    const gap = () => {
      const before = index === 0 ? null : reviewKey(order[index - 1]!);
      const next = index === order.length ? this.now : reviewKey(order[index]!);

      return { before, next };
    };
    let { before, next } = gap();

    if (before !== null && next - before < 2) {
      // Too close to place between: respace the whole order 1s apart, ending before now, which keeps every work item's place.
      order.forEach((entry, position) => this.store.updateWorkItem(entry.id, { orderAt: this.now - (order.length - position) * 1000 }));
      order = this.store.readyWorkItems().filter((entry) => entry.id !== item.id);
      index = after === null ? 0 : order.findIndex((entry) => entry.id === after) + 1;
      ({ before, next } = gap());
    }

    this.store.updateWorkItem(item.id, { orderAt: before === null ? next - 60_000 : Math.floor((before + next) / 2) });
  }

  /** PRD R49: local only; a snoozed ticket gets no automatic triage or start until `until` passes, or until restored when `until` is null. */
  private snooze(ticketId: number, until: number | null): void {
    if (until !== null && until <= this.now) {
      throw new Refusal('The snooze time has passed.');
    }

    this.store.updateTicket(this.knownTicket(ticketId).id, { snoozed: true, snoozedUntil: until });
  }

  private restore(ticketId: number): void {
    this.store.updateTicket(this.knownTicket(ticketId).id, { snoozed: false, snoozedUntil: null });
  }

  private knownTicket(ticketId: number): Ticket {
    const ticket = this.store.ticket(ticketId);

    if (ticket === null) {
      throw new Refusal(`Unknown ticket ${ticketId}.`);
    }

    return ticket;
  }

  private poolTicket(ticketId: number): Ticket {
    const ticket = this.store.ticket(ticketId);

    if (ticket === null || !ticket.pool) {
      throw new Refusal('The ticket is not in the pool.');
    }

    if (this.hasOpenWorkItem(ticket.id)) {
      throw new Refusal('The ticket already has a work item.');
    }

    return ticket;
  }

  /** PRD R48: a queued work item with the pool triage's playbook; its task session's skill claims the ticket. */
  private pick(ticket: Ticket, guidance: string | null): void {
    const triages = this.store.poolTriages(ticket.id);
    const triaged = triages.filter((triage) => triage.playbook !== null).at(-1);

    if (triaged?.playbook == null) {
      throw new Refusal('The ticket has no triage result yet.');
    }

    const item = this.store.insertWorkItem({
      ticketId: ticket.id,
      playbook: triaged.playbook,
      status: 'queued',
      stage: null,
      stageAt: null,
      taskPrompt: null,
      guidance,
      warning: null,
      error: null,
      unassignedAt: null,
      queuedAt: this.now,
      approvalPrompt: null,
      approvalSummary: null,
      approvalReport: null,
      approvalHeld: false,
      createdAt: this.now,
      statusAt: this.now,
      readyAt: null,
      orderAt: null,
      runStartedAt: this.now,
      scopeAt: null,
      doneAt: null,
      doneReason: null,
      parentId: null,
    });

    for (const triage of triages) {
      this.store.updateTriage(triage.id, { workItemId: item.id });
    }
  }

  private retriagePool(ticket: Ticket): void {
    const triages = this.store.poolTriages(ticket.id);

    if (triages.some((triage) => triage.endedAt === null)) {
      throw new Refusal('Triage is already running.');
    }

    for (const triage of triages) {
      this.store.deleteTriage(triage.id);
    }
  }

  private approve(item: WorkItem): void {
    if (item.status !== 'awaiting-approval') {
      throw new Refusal('The work item is not awaiting approval.');
    }

    this.queue(item);
  }

  private start(item: WorkItem, guidance: string | null): void {
    if (item.status !== 'unstarted') {
      throw new Refusal('The work item is not unstarted.');
    }

    this.store.updateWorkItem(item.id, { guidance });
    this.queue(item);
  }

  private retriage(item: WorkItem): void {
    this.requireNoSession(item);

    if (this.store.ticket(item.ticketId)!.source === ADHOC_SOURCE) {
      throw new Refusal('An ad-hoc work item is not triaged.');
    }

    if (this.store.runningTriages().some((triage) => triage.workItemId === item.id)) {
      throw new Refusal('Triage is already running.');
    }

    this.setStatus(item.id, { status: 'triaging', error: null, queuedAt: null, guidance: null, approvalPrompt: null, approvalSummary: null, approvalReport: null, readyAt: null, orderAt: null });
  }

  private requireNoSession(item: WorkItem): void {
    if (this.activeSession(item) !== null) {
      throw new Refusal('The work item has an active session.');
    }
  }

  // Status changes

  /** Every status change comes here, so statusAt, runStartedAt and readyAt stay true (PRD R27). */
  private setStatus(id: number, patch: Partial<NewWorkItem> & { status: WorkItemStatus }): void {
    const { status: before, readyAt } = this.store.workItem(id)!;
    const run = RUN_STATUSES.has(patch.status) && !RUN_STATUSES.has(before) ? { runStartedAt: this.now } : {};
    const ready = readyAt === null && READY_STATUSES.has(patch.status) ? { readyAt: this.now } : {};

    this.store.updateWorkItem(id, before === patch.status ? patch : { approvalHeld: false, ...patch, statusAt: this.now, ...run, ...ready });
  }

  /** A run or stop ended without a report: the earlier approval waits again, with the cause when the run did not finish. */
  private restoreApproval(item: WorkItem, cause: string | null): void {
    this.setStatus(item.id, { status: 'awaiting-approval', error: cause });
  }

  private queue(item: WorkItem): void {
    this.setStatus(item.id, { status: 'queued', queuedAt: this.now, error: null });
  }

  private done(item: WorkItem, reason: 'session' | 'operator' | 'unassigned', warning: string | null): void {
    const scopeAt = this.store.ticket(item.ticketId)!.scopeAt ?? item.createdAt;

    this.setStatus(item.id, { status: 'done', doneAt: this.now, doneReason: reason, warning, queuedAt: null, scopeAt });
  }

  private fail(item: WorkItem, cause: string): void {
    this.setStatus(item.id, { status: 'failed', error: cause, queuedAt: null });
  }

  private block(item: WorkItem, cause: string): void {
    this.setStatus(item.id, { status: 'blocked', error: cause });
  }

  /** A run that ended without a report: `finished` for review when the prompt offered neither done nor approval, else blocked (PRD R23). */
  private endRun(item: WorkItem, session: Session, turn: boolean): void {
    if (session.reports.includes('done') || session.reports.includes('approval')) {
      this.block(item, endedMessage(session, turn));
    } else {
      this.setStatus(item.id, { status: 'finished', error: null });
    }
  }

  /** The session's work item when the session is its latest and it is not done (PRD R45). */
  private latest(session: Session): WorkItem | null {
    const item = this.store.workItem(session.workItemId)!;
    const sessions = this.store.sessionsFor(item.id);

    return item.status !== 'done' && sessions.at(-1)?.id === session.id ? item : null;
  }

  private activeSession(item: WorkItem): Session | null {
    return activeSession({ sessions: this.store.sessionsFor(item.id) });
  }

  // Scheduling

  schedule(): void {
    this.scheduleTriage();
    this.scheduleStarts();
  }

  /** Triages work items, then pool tickets that have no triage yet, up to `triage.concurrency` at once (PRD R47). */
  private scheduleTriage(): void {
    const running = this.store.runningTriages();
    const busy = new Set(running.map((triage) => triage.workItemId));
    let free = this.context.settings.triage.concurrency - running.length;
    const start = (ticket: Ticket, item: WorkItem | null) => {
      const before = this.actions.length;
      this.startTriage(ticket, item);
      free -= this.actions.length - before;
    };

    for (const item of this.store.workItemsWithStatus('triaging')) {
      if (free <= 0) {
        return;
      }

      const ticket = this.store.ticket(item.ticketId)!;

      if (!busy.has(item.id) && !ticket.snoozed) {
        start(ticket, item);
      }
    }

    for (const ticket of this.store.poolTickets()) {
      if (free <= 0) {
        return;
      }

      if (!ticket.snoozed && this.store.poolTriages(ticket.id).length === 0 && !this.hasOpenWorkItem(ticket.id)) {
        start(ticket, null);
      }
    }
  }

  private hasOpenWorkItem(ticketId: number): boolean {
    return this.store.workItemsForTicket(ticketId).some((item) => item.status !== 'done');
  }

  /**
   * Starts queued work items in order while slots are free, skipping a ticket with another session in a turn (PRD R17, R38).
   * A session holds a slot only while its work item runs, so a question, an approval, a block, Done and Snoozed do not stall the queue.
   */
  private scheduleStarts(): void {
    const queued = this.store.workItemsWithStatus('queued').sort((a, b) => a.queuedAt! - b.queuedAt! || a.id - b.id);
    const limit = this.context.settings.sessions.concurrency;
    let used = heldSlots(this.store);

    for (const item of queued) {
      if (used >= limit) {
        return;
      }

      if (queueWaits(this.store, item, limit, used).length === 0) {
        this.startSession(item);
        used = heldSlots(this.store);
      }
    }
  }

  /** Starts the work item's setup or task session. The task after a setup session takes the setup session's slot (PRD R38). */
  private startSession(item: WorkItem): void {
    const ticket = this.store.ticket(item.ticketId)!;
    const source = this.context.settings.sources[ticket.source];
    const sessions = this.context.settings.sessions;
    const playbook = item.playbook === null ? null : (this.context.playbooks.get(item.playbook) ?? null);

    if (item.playbook !== null && playbook === null) {
      this.fail(item, `Playbook ${item.playbook} is not loaded.`);
      return;
    }

    const worktree = this.store.worktreeFor(ticket.id);
    const repoRoot = ticket.repoRoot || source?.repoRoot || '';
    const approved = item.approvalPrompt !== null;
    const kind: SessionKind = !approved && playbook?.requiresWorktree === true && worktree === null ? 'setup' : 'task';
    const cwd = playbook?.workdir === 'repoRoot' ? repoRoot : (worktree?.path ?? repoRoot);

    if (cwd === '') {
      this.fail(item, `sources.${ticket.source}.repoRoot is not set.`);
      return;
    }

    const id = this.context.newSessionId();
    const values = this.values(ticket, item);
    let prompt: string;

    if (kind === 'setup') {
      const template = source?.setupPrompt ?? '';

      if (template === '') {
        this.fail(item, `sources.${ticket.source}.setupPrompt is not set.`);
        return;
      }

      const rendered = renderTaskPrompt(template, values);

      if ('error' in rendered) {
        this.fail(item, `sources.${ticket.source}.setupPrompt: ${rendered.error}`);
        return;
      }

      prompt = rendered.text;
    } else if (approved) {
      prompt = item.approvalPrompt!;
    } else if (playbook === null) {
      prompt = item.taskPrompt ?? '';
    } else {
      const rendered = renderTaskPrompt(playbook.template, values);

      if ('error' in rendered) {
        this.fail(item, `Playbook ${playbook.name}: ${rendered.error}`);
        return;
      }

      prompt = rendered.text;
    }

    // Every session of a work item runs in its playbook's agent, so a setup or an approved prompt runs where the playbook's skills do.
    const provider = playbook?.provider ?? sessions.provider;
    const reports = sessionReports(kind, approved, playbook, provider);
    // The guidance waits through a setup session for the task session, and an approved prompt does not take it (PRD R77).
    const guided = kind === 'task' && !approved;
    const full = sessionPrompt(prompt, id, guided ? item.guidance : null);

    if (kind === 'task' && playbook !== null) {
      this.store.updateWorkItem(item.id, { taskPrompt: full });
    }

    if (guided && item.guidance !== null) {
      this.store.updateWorkItem(item.id, { guidance: null });
    }
    const label = kind === 'task' ? (item.playbook ?? 'ad-hoc') : kind;
    const own = kind === 'task' ? playbook : null;

    this.store.insertSession({
      id,
      workItemId: item.id,
      kind,
      provider,
      nativeSessionId: null,
      shortId: null,
      cwd,
      state: 'starting',
      stateAt: this.now,
      stateDetail: null,
      outcome: null,
      outcomeDetail: null,
      startedAt: this.now,
      endedAt: null,
      released: false,
      releasing: false,
      question: null,
      reports,
    });
    this.setStatus(item.id, { status: kind === 'task' ? 'running' : 'setup', queuedAt: null, error: null });
    this.actions.push({
      type: 'start-session',
      sessionId: id,
      workItemId: item.id,
      kind,
      provider,
      cwd,
      prompt: full,
      contract: sessionContract(id, this.context.report, reports, provider),
      name: `switchboard · ${label} · ${ticket.source} ${ticket.sourceKey}`,
      permissionMode: own?.permissionMode ?? (provider === 'codex' ? sessions.codex.permissionMode : sessions.permissionMode),
      model: own?.model ?? ((provider === 'codex' ? sessions.codex.model : sessions.model) || null),
    });
  }

  private values(ticket: Ticket, item: WorkItem): Record<Exclude<TemplateVariable, 'session.id'>, string> {
    const triage = this.store.triagesFor(item.id).filter((entry) => entry.playbook !== null).at(-1);

    return {
      'ticket.source': ticket.source,
      'ticket.sourceKey': ticket.sourceKey,
      'ticket.ref': ticket.ref,
      'ticket.title': ticket.title,
      'ticket.url': ticket.url,
      'ticket.context': triage?.context ?? '',
      report: this.context.report,
    };
  }

}
