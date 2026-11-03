import type { Playbook } from './playbook.js';
import { activeSession, failedAtTriage, groupOf, ownPrompt, reviewKey, START_PROMPT, waitsToStart } from './group.js';
import { heldSlots, queueWaits } from './queue.js';
import { latestDue, SCHEDULE_SOURCE, scheduleText } from './schedule.js';
import { repoRoots } from './settings.js';
import type { PermissionMode, Provider, ScheduleSettings, Settings } from './settings.js';
import { REPORT_KINDS } from './model.js';
import type { Immediacy, ReportKind, Session, SessionKind, SessionState, Severity, Ticket, WorkItem, WorkItemStatus } from './model.js';
import { focusUrl } from './focus.js';
import type { Anchor, SourceLink } from './source.js';
import type { Actor, EventRecord, NewWorkItem, Store } from './store.js';
import { renderTaskPrompt, sessionContract, sessionPrompt, triagePrompt } from './template.js';
import type { PlaybookChoice, TemplateVariable } from './template.js';

export const ADHOC_SOURCE = 'adhoc';

/** The statuses of a run; entering one from another status starts the Working clock (PRD R27). */
const RUN_STATUSES: ReadonlySet<WorkItemStatus> = new Set(['setup', 'running']);

/** The statuses that put a work item in Ready for review for good (PRD R27). */
const READY_STATUSES: ReadonlySet<WorkItemStatus> = new Set(['awaiting-approval', 'finished']);

/** A ticket that leaves the source's scope stops being snoozed, so it leaves the Snoozed group (PRD R49). */
const UNSNOOZED = { snoozed: false, snoozedUntil: null, snoozeComment: null } as const;

const EMPTY_TRIAGE = { context: null, playbook: null, immediacy: null, severity: null, focus: null, model: null } as const;

export const MESSAGES = {
  stopped: 'Stopped by you.',
  setupWithoutWorktree: 'Setup ended without a worktree.',
  turnEnded: 'The turn ended without a done report.',
  sessionEnded: 'The session ended without a done report.',
  turnEndedWithoutApproval: 'The turn ended without an approval report.',
  sessionEndedWithoutApproval: 'The session ended without an approval report.',
  noTaskPlaybooks: 'No task playbooks to choose from.',
  doneStillAssigned: 'The session reported done, but the ticket is still assigned to you.',
  nothingNew: 'Nothing is newer than the earlier work item',
} as const;

/** The first message of a session resumed in its background process after its tab closed mid-turn (PRD R89, mechanics M55). */
export const RESUME_PROMPT = 'The VS Code window closed while your turn was running, so your last tool call may have been cut off. Continue where you left off.';

/** Starts a task session's `outcomeDetail` while its done report waits for the hub's second read of the ticket (PRD R10). */
export const UNCONFIRMED_DONE = 'Waiting to read the ticket again';

/**
 * Why a work item cannot be reopened, or null (PRD R86): it must be done, its ticket's latest work item with no open one, and its ticket not
 * registered as handled by another session, whose work the scheduler would not start.
 */
export function reopenRefusal(item: Pick<WorkItem, 'id' | 'status'>, ticketItems: readonly Pick<WorkItem, 'id' | 'status'>[], ticket: Pick<Ticket, 'handledAssignmentKey'>): string | null {
  if (item.status !== 'done') {
    return 'The work item is not done.';
  }

  if (ticketItems.some((other) => other.id > item.id || other.status !== 'done')) {
    return 'Only the latest work item of a ticket with no open work item can be reopened.';
  }

  return ticket.handledAssignmentKey == null ? null : "Another session handles the ticket's assignment.";
}

/**
 * The task playbooks Start with guidance… offers, triage's choice among them: those of the work item's playbook namespace, in settings order. None for
 * a work item without a playbook, such as an ad-hoc one, or a scheduled run, which keeps its schedule's (PRD R35).
 */
export function playbookChoices(playbook: string | null, source: string, playbooks: ReadonlyMap<string, Playbook>): string[] {
  if (playbook === null || source === SCHEDULE_SOURCE) {
    return [];
  }

  const namespace = namespaceOf(playbook);

  return [...playbooks.values()].filter((candidate) => candidate.kind === 'task' && namespaceOf(candidate.name) === namespace).map((candidate) => candidate.name);
}

function namespaceOf(playbook: string): string {
  return playbook.split(':')[0]!;
}

/** A task session's done report whose first read still listed the ticket, on a work item the second read can still settle. */
export function awaitsRecheck(item: Pick<WorkItem, 'status'>, session: Pick<Session, 'kind' | 'outcome' | 'outcomeDetail'>): boolean {
  return session.kind === 'task' && session.outcome === 'done' && !!session.outcomeDetail?.startsWith(UNCONFIRMED_DONE) && (item.status === 'running' || item.status === 'awaiting-approval');
}

/** When an earlier work item of the ticket took in its activity, and that work item's playbook (PRD R80). */
export interface HandledWork {
  at: number;
  playbook: string | null;
}

/** True when the source reports no activity after the earlier work item took it in, so nothing new asks for an action (PRD R80). */
export function nothingNew(handled: HandledWork | null, activityAt: number | null | undefined): boolean {
  return handled !== null && activityAt !== undefined && (activityAt === null || activityAt <= handled.at);
}

/** One ticket from a complete poll. A ticket of the source missing from the poll is not in the assigned state. */
export interface PolledTicket {
  inQueue?: boolean;
  assigneeId?: string | null;
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
  /** `assigned`: a fresh read still lists the task's ticket as assigned, so the work item waits for `done-checked` (PRD R10). */
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

/** A live fork that may replace a session (PRD R78), with the fork's own state. */
export interface ObservedFork {
  sessionId: string;
  nativeSessionId: string;
  shortId: string;
  state: LiveState;
  detail: string | null;
}

export type FlowEvent =
  | { type: 'poll'; source: string; tickets: PolledTicket[]; assignments?: { ticketId: number; expectedKey: string; key: string | null }[] }
  | { type: 'handled'; sessionId: string; source: string; sourceKey: string; ref: string; title: string; url: string; key: string; release: boolean; assigned: boolean }
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
      /** The anchor id the classifier chose, resolved against `anchors` and the playbook's page (PRD R79). */
      focus?: string | null;
      anchors?: Anchor[];
      /** `nothingNew` held, so the work item waits for Start whatever the playbook's `autoStart` (PRD R80). */
      stale?: boolean;
    }
  | { type: 'triage-failed'; triageId: number; error: string; context: string | null }
  /** The hub stopped during triage. Nothing failed, so the work item is triaged again. */
  | { type: 'triage-cancelled'; triageId: number }
  | { type: 'session-started'; sessionId: string; nativeSessionId: string | null; shortId: string; startPrompt?: true }
  | { type: 'session-start-failed'; sessionId: string; message: string }
  /** `checked` lists the sessions the read looked for, so a session whose start completed during the read is not ended; all when absent. */
  | { type: 'roster'; sessions: ObservedSession[]; checked?: string[]; forks?: ObservedFork[] }
  | { type: 'marker'; sessionId: string; state: LiveState; detail: string | null }
  | { type: 'report'; sessionId: string; report: Report }
  /** The hub's recheck of a done report whose first read still listed the ticket as assigned (PRD R10). */
  /** 	oken is the session's outcomeDetail when the hub scheduled the read, so a check of a superseded report changes nothing. */
  | { type: 'done-checked'; sessionId: string; token: string; assigned: boolean }
  /** `shortId` is the copy the stop targeted; a result for a copy a fork retired changes nothing (PRD R78). */
  | { type: 'stop-succeeded'; sessionId: string; reason: StopReason; shortId?: string | null }
  | { type: 'stop-failed'; sessionId: string; reason: StopReason; message: string; shortId?: string | null }
  | { type: 'worktree-found'; source: string; sourceKey: string; path: string; branch: string }
  /** `start` queues the work item to run now; otherwise it waits `unstarted` for Start (PRD R6). */
  | { type: 'adhoc'; prompt: string; repoRoot: string; start?: boolean }
  /** A live Claude session the operator started outside Switchboard, as the roster lists it (PRD R81). */
  | { type: 'register'; nativeSessionId: string; shortId: string; cwd: string; title: string }
  /**
   * A ticket report: the session's ad-hoc work item continues as the work item of the source's ticket the hub read, with `playbook` when
   * the report names one (PRD R83).
   */
  | { type: 'ticket'; sessionId: string; source: string; sourceKey: string; ref: string; title: string; url: string; playbook: string | null }
  /** Run now: a queued work item for the named schedule (PRD R82). */
  | { type: 'run-schedule'; name: string }
  /** `retry` retries a failed work item from the step that failed (PRD R34). */
  | { type: 'approve' | 'mark-done' | 'reopen' | 'retry' | 'stop' | 'delete'; workItemId: number }
  /** `guidance` is added to the task session's prompt (PRD R77); `playbook` replaces triage's choice (PRD R35); `prompt` replaces an ad-hoc one (PRD R77). */
  | { type: 'start'; workItemId: number; guidance?: string | null; playbook?: string | null; prompt?: string | null }
  | { type: 'pick'; ticketId: number; guidance?: string | null; playbook?: string | null }
  /** Stops the waiting session the row showed, named by its native ID, to open it in a Claude tab (PRD R70). */
  | { type: 'open-question'; workItemId: number; nativeSessionId: string }
  /**
   * Continue in Background (PRD R89): the session the hub found in the item window's Claude tab, whose process is `pid`, and the work items of that
   * window, which must hold it. `busy`: the roster listed the process running a turn, which the session's state may not show yet without hooks.
   */
  | { type: 'background'; sessionId: string; nativeSessionId: string; pid: number; busy: boolean; workItemIds: number[] }
  /** The tab's process exited and `claude --bg --resume` runs, which a roster read must confirm before `deadline`. */
  | { type: 'move-launching'; sessionId: string; moveId: string; deadline: number }
  | { type: 'session-resumed'; sessionId: string; moveId: string; shortId: string }
  | { type: 'resume-failed'; sessionId: string; moveId: string; message: string }
  /** The tab's process did not exit, so the session stays where it is. */
  | { type: 'move-cancelled'; sessionId: string; moveId: string }
  | { type: 'retriage-pool' | 'restore'; ticketId: number }
  /** Snoozes the ticket until `until`, or indefinitely when null, with the operator's comment (PRD R49). */
  | { type: 'snooze'; ticketId: number; until: number | null; comment?: string | null }
  /** Adds the operator's comment to a work item (PRD R87). */
  | { type: 'comment'; workItemId: number; text: string }
  /** Places a Ready for review work item after `after`, or first when null (PRD R73). */
  | { type: 'move'; workItemId: number; after: number | null }
  /** Returns a moved work item to its place by readyAt (PRD R73). */
  | { type: 'reset-position'; workItemId: number }
  | { type: 'tick' };

export type TriageChoice = PlaybookChoice;

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
      /** The latest earlier work item's handling; null for a pool triage or a ticket without one (PRD R80). */
      handled: HandledWork | null;
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
  | { type: 'stop-session'; sessionId: string; provider: Provider; shortId: string | null; reason: StopReason }
  /** Waits for the tab's process `pid` to exit, then resumes the session in its background process with `prompt` (PRD R89). */
  | { type: 'resume-session'; sessionId: string; moveId: string; provider: Provider; nativeSessionId: string; cwd: string; pid: number; prompt: string };

export interface FlowContext {
  now: number;
  settings: Settings;
  playbooks: ReadonlyMap<string, Playbook>;
  /** The report command prefix, `<sessions.nodePath> "<home>/hub.js" report`. */
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

/** Start with prompt…'s trimmed prompt when it differs from the work item's stored one, else null (PRD R77). */
function editedPrompt(store: Store, workItemId: number, prompt: string | null | undefined): string | null {
  const text = textOf(prompt);
  const item = store.workItem(workItemId);

  return text === null || item === null || text === ownPrompt(item)?.trim() ? null : text;
}

/** The operator's text, such as Start's guidance (PRD R77) or a comment (PRD R49, R87), trimmed, or null when blank. */
function textOf(text: string | null | undefined): string | null {
  return text?.trim() || null;
}

/** Compares repo paths as Windows does: either separator, any case, no trailing separator. */
function samePath(a: string, b: string): boolean {
  const key = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

  return key(a) === key(b);
}

const OPERATOR_EVENTS: ReadonlySet<FlowEvent['type']> = new Set(['adhoc', 'register', 'run-schedule', 'start', 'approve', 'mark-done', 'reopen', 'retry', 'stop', 'delete', 'open-question', 'background','pick', 'retriage-pool', 'restore', 'snooze', 'comment', 'move', 'reset-position']);

/**
 * Events logged even when they change nothing, because they record a request or a report (PRD R59). The rest, such as polls and
 * roster reads, are logged only when they change a row.
 */
const ALWAYS_LOGGED: ReadonlySet<FlowEvent['type']> = new Set([...OPERATOR_EVENTS, 'report', 'ticket', 'session-start-failed', 'stop-failed', 'move-cancelled']);

function actorOf(type: FlowEvent['type']): Actor {
  if (OPERATOR_EVENTS.has(type)) {
    return 'operator';
  }

  switch (type) {
    case 'report':
    case 'ticket':
      return 'session';
    case 'handled':
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

/** A stop result for a copy that a fork retired after the stop was sent. */
function retiredStop(session: Session, shortId: string | null | undefined): boolean {
  return shortId !== undefined && shortId !== session.shortId;
}

/** The event's own fields for the log: no prompt, context or polled list, except the prompt the operator edited in Start with prompt… (PRD R77). */
function detailOf(store: Store, event: FlowEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'poll':
    case 'poll-failed':
      return { source: event.source };
    case 'triage-succeeded':
      return { triageId: event.triageId, playbook: event.playbook, immediacy: event.immediacy, severity: event.severity, model: event.model, ...(event.stale ? { stale: true } : {}) };
    case 'triage-failed':
      return { triageId: event.triageId, error: event.error };
    case 'triage-cancelled':
      return { triageId: event.triageId };
    case 'session-started':
      return { shortId: event.shortId, ...(event.startPrompt ? { startPrompt: true } : {}) };
    case 'session-start-failed':
      return { message: event.message };
    case 'marker':
      return { state: event.state, detail: event.detail };
    case 'report': {
      const { prompt: _prompt, ...report } = event.report as Report & { prompt?: string };
      return report;
    }
    case 'done-checked':
      return { assigned: event.assigned };
    case 'stop-succeeded':
      return { reason: event.reason };
    case 'stop-failed':
      return { reason: event.reason, message: event.message };
    case 'worktree-found':
      return { path: event.path, branch: event.branch };
    case 'adhoc':
      return { repoRoot: event.repoRoot, start: event.start === true };
    case 'register':
      return { cwd: event.cwd };
    case 'session-resumed':
      return { shortId: event.shortId };
    case 'resume-failed':
      return { message: event.message };
    case 'ticket':
      return { source: event.source, sourceKey: event.sourceKey, playbook: event.playbook };
    case 'handled':
      return { source: event.source, sourceKey: event.sourceKey, key: event.key, release: event.release, reportedBySessionId: event.sessionId };
    case 'run-schedule':
      return { name: event.name };
    case 'start':
    case 'pick': {
      const detail = { ...(textOf(event.guidance) === null ? {} : { guidance: textOf(event.guidance) }), ...(event.playbook == null ? {} : { playbook: event.playbook }) };
      const prompt = event.type === 'start' ? editedPrompt(store, event.workItemId, event.prompt) : null;
      const all = prompt === null ? detail : { ...detail, prompt };

      return Object.keys(all).length === 0 ? null : all;
    }
    case 'snooze':
      return textOf(event.comment) === null ? { until: event.until } : { until: event.until, comment: textOf(event.comment) };
    case 'comment':
      return { text: textOf(event.text) };
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
  if (event.type === 'handled') return { ...none, ticketId: store.findTicket(event.source, event.sourceKey)?.id ?? null };
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

  if (event.type === 'run-schedule') {
    return { ...none, ticketId: store.findTicket(SCHEDULE_SOURCE, event.name)?.id ?? null };
  }

  return none;
}

/** The event as the activity log records it (PRD R59). */
export function eventRecord(store: Store, event: FlowEvent, at: number): EventRecord {
  return { at, type: event.type, actor: actorOf(event.type), ...subjectOf(store, event), detail: detailOf(store, event) };
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

    // The hub ticks every minute, so a schedule's run starts within a minute of its time (PRD R82).
    if (event.type === 'tick') {
      flow.runSchedules();
    }

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

    flow.endUnownedHandling();
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
        return this.poll(event.source, event.tickets, event.assignments);
      case 'handled':
        return this.registerHandled(event);
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
        return this.sessionStarted(event.sessionId, event.nativeSessionId, event.shortId, event.startPrompt === true);
      case 'session-start-failed':
        return this.sessionStartFailed(event.sessionId, event.message);
      case 'roster':
        return this.roster(event.sessions, event.checked, event.forks ?? []);
      case 'marker':
        return this.marker(event.sessionId, event.state, event.detail);
      case 'report':
        return this.report(event.sessionId, event.report);
      case 'done-checked':
        return this.doneChecked(event.sessionId, event.token, event.assigned);
      case 'stop-succeeded':
        return this.stopSucceeded(event.sessionId, event.reason, event.shortId);
      case 'stop-failed':
        return this.stopFailed(event.sessionId, event.reason, event.message, event.shortId);
      case 'worktree-found':
        return this.worktreeFound(event.source, event.sourceKey, event.path, event.branch);
      case 'adhoc':
        return this.adhoc(event.prompt, event.repoRoot, event.start === true);
      case 'register':
        return this.register(event);
      case 'ticket':
        return this.moveToTicket(event);
      case 'run-schedule':
        return this.runSchedule(event.name);
      case 'start':
        return this.start(this.openItem(event.workItemId), textOf(event.guidance), event.playbook ?? null, editedPrompt(this.store, event.workItemId, event.prompt));
      case 'approve':
        return this.approve(this.openItem(event.workItemId));
      case 'mark-done':
        return this.done(this.openItem(event.workItemId), 'operator', null);
      case 'reopen':
        return this.reopen(this.knownItem(event.workItemId));
      case 'retry':
        return this.retry(this.openItem(event.workItemId));
      case 'stop':
        return this.stop(this.knownItem(event.workItemId));
      case 'delete':
        return this.delete(this.knownItem(event.workItemId));
      case 'open-question':
        return this.openQuestion(this.openItem(event.workItemId), event.nativeSessionId);
      case 'background':
        return this.background(event);
      case 'move-launching':
        return this.moveLaunching(event.sessionId, event.moveId, event.deadline);
      case 'session-resumed':
        return this.sessionResumed(event.sessionId, event.moveId, event.shortId);
      case 'resume-failed':
        return this.resumeFailed(event.sessionId, event.moveId, event.message);
      case 'move-cancelled':
        return this.moveCancelled(event.sessionId, event.moveId);
      case 'pick':
        return this.pick(this.poolTicket(event.ticketId), textOf(event.guidance), event.playbook ?? null);
      case 'retriage-pool':
        return this.retriagePool(this.poolTicket(event.ticketId));
      case 'snooze':
        return this.snooze(event.ticketId, event.until, textOf(event.comment));
      case 'comment':
        return this.comment(this.knownItem(event.workItemId), textOf(event.text));
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
      this.store.updateTicket(ticket.id, UNSNOOZED);
    }
  }

  /**
   * Ends each handled assignment whose reporting work item is done or deleted, and gives a still-assigned ticket a work item, so no ticket
   * stays hidden after the work that handled it ends (PRD R85).
   */
  endUnownedHandling(): void {
    const ended: number[] = [];

    for (const ticket of this.store.handledTickets()) {
      const registration = this.store.handledRegistrations(ticket.id).filter((entry) => entry.key === ticket.handledAssignmentKey).at(-1);
      const reporter = registration?.workItemId == null ? null : this.store.workItem(registration.workItemId);

      if (reporter !== null && reporter.status !== 'done') {
        continue;
      }

      this.store.updateTicket(ticket.id, { handledAssignmentKey: null });
      ended.push(ticket.id);

      if (ticket.assigned) {
        this.createWorkItem(ticket.id);
      }
    }

    if (ended.length > 0) {
      this.store.noteEvent({ handledEnded: ended });
    }
  }

  // Sources

  private poll(source: string, polled: PolledTicket[], assignments: Extract<FlowEvent, { type: 'poll' }>['assignments'] = []): void {
    const returned = new Set<number>();
    const assignmentChanges: { ticketId: number; reason: string }[] = [];
    for (const assignment of assignments) {
      const ticket = this.store.ticket(assignment.ticketId);
      if (ticket?.source !== source || ticket.handledAssignmentKey !== assignment.expectedKey || assignment.key === assignment.expectedKey) continue;
      this.store.updateTicket(ticket.id, { handledAssignmentKey: null });
      assignmentChanges.push({ ticketId: ticket.id, reason: assignment.key === null ? 'unassigned' : 'reassigned' });
      returned.add(ticket.id);
    }
    if (assignmentChanges.length > 0) this.store.noteEvent({ assignmentChanges });
    const seen = new Set<string>();
    if (source === 'zoho' || source === 'forum') {
      this.store.volumePoll(source, this.now, (this.context.settings.sources[source]?.pollIntervalSeconds ?? 300) * 1000);
    }

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
        inQueue: (source === 'zoho' || source === 'forum') && entry.inQueue === true,
        assigneeId: entry.assigneeId ?? null,
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

      if (entry.assigned && (!known.assigned || returned.has(known.id))) {
        this.createWorkItem(known.id);
      } else if (!entry.assigned && known.assigned) {
        this.left(known.id);
      }
    }

    for (const ticket of this.store.currentTickets(source)) {
      if (!seen.has(ticket.sourceKey)) {
        this.store.updateTicket(ticket.id, { assigned: false, pool: false, inQueue: false, assigneeId: null, lastPolledAt: this.now, ...UNSNOOZED });

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
    if (this.store.ticket(ticketId)?.handledAssignmentKey != null) return;
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
      reportedPrompt: null,
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

  /** Support keeps ticket-only triages across queue and assignment changes for reporting. */
  private leftPool(ticketId: number): void {
    const source = this.store.ticket(ticketId)!.source;
    if (source === 'zoho' || source === 'forum') return;
    for (const triage of this.store.poolTriages(ticketId)) {
      this.store.deleteTriage(triage.id);
    }
  }

  /**
   * PRD R10: deleted when it never had a session, done now when no session is active or its session reported done, otherwise
   * when the active session reports or ends. A running triage also defers the deletion, so its row keeps holding a `triage.concurrency`
   * slot until the classifier finishes.
   */
  private left(ticketId: number): void {
    const running = new Set(this.store.runningTriages().map((triage) => triage.workItemId));

    for (const item of this.store.workItemsForTicket(ticketId)) {
      if (item.status === 'done') {
        continue;
      }

      const active = this.activeSession(item);

      if (this.store.sessionsFor(item.id).length === 0) {
        if (!running.has(item.id)) {
          this.store.deleteWorkItem(item.id);
        } else if (item.unassignedAt === null) {
          this.store.updateWorkItem(item.id, { unassignedAt: this.now });
        }
      } else if (active === null || (active.kind === 'task' && active.outcome === 'done' && item.status === 'blocked') || awaitsRecheck(item, active)) {
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

  private adhoc(prompt: string, repoRoot: string, start: boolean): void {
    const title = firstLine(prompt);

    if (title === '') {
      throw new Refusal('The prompt is empty.');
    }

    if (repoRoot === '') {
      throw new Refusal('Choose a repo for the prompt.');
    }

    this.insertAdhoc(prompt, title, repoRoot, null, start ? 'queued' : 'unstarted');
  }

  /**
   * PRD R81: a live Claude session the operator started outside Switchboard becomes a running ad-hoc work item in its own directory. The session
   * counts as released, because its process is the operator's, and stays external until it ends.
   */
  private register(event: Extract<FlowEvent, { type: 'register' }>): void {
    const title = event.title.trim();

    if (title === '') {
      throw new Refusal('The title is empty.');
    }

    const known = this.store.sessionByNativeId(event.nativeSessionId) ?? this.store.startedSessions().find((session) => session.retiredIds.includes(event.nativeSessionId)) ?? null;

    if (known !== null) {
      const ticket = this.store.ticket(this.store.workItem(known.workItemId)!.ticketId)!;

      throw new Refusal(`This session is already in Switchboard as ${ticket.source} ${ticket.sourceKey}.`);
    }

    const item = this.insertAdhoc(null, title, event.cwd, null, 'running');

    this.store.insertSession({
      id: this.context.newSessionId(),
      workItemId: item.id,
      kind: 'task',
      provider: 'claude',
      nativeSessionId: event.nativeSessionId,
      shortId: event.shortId,
      cwd: event.cwd,
      state: 'running',
      stateAt: this.now,
      stateDetail: null,
      outcome: null,
      outcomeDetail: null,
      startedAt: this.now,
      endedAt: null,
      released: true,
      releasing: false,
      question: null,
      reports: sessionReports('task', false, null, 'claude'),
      retiredIds: [],
      pendingFork: null,
      external: true,
      move: null,
      movedAt: null,
    });
  }

  /**
   * PRD R83: the ad-hoc ticket of the session's work item becomes the source's ticket in place, so its work item, sessions, worktree, links and
   * History stay with it. It is stored out of the assigned state, so the poll that first lists it in scope finds the open work item and creates
   * none (PRD R7). A ticket a poll stored with nothing on it gives way. A registered session takes the playbook's reports at once, because its
   * contract is only in its conversation; a session Switchboard started keeps the contract in its system prompt, and its later sessions get the
   * playbook's.
   */
  private moveToTicket(event: Extract<FlowEvent, { type: 'ticket' }>): void {
    const session = this.session(event.sessionId);
    const item = this.store.workItem(session.workItemId)!;
    const ticket = this.store.ticket(item.ticketId)!;
    // A retry after a lost reply.
    if (ticket.source === event.source && ticket.sourceKey === event.sourceKey) {
      return;
    }

    if (ticket.source !== ADHOC_SOURCE) {
      throw new Refusal('Only an ad-hoc or registered work item can move to a ticket.');
    }

    if (item.status === 'done') {
      throw new Refusal('The work item is done.');
    }

    if (this.store.sessionsFor(item.id).at(-1)?.id !== session.id) {
      throw new Refusal("Only the work item's latest session can move it to a ticket.");
    }

    const playbook = event.playbook === null ? null : this.ticketPlaybook(event.source, event.playbook);
    const existing = this.store.findTicket(event.source, event.sourceKey);

    if (existing !== null) {
      const bare = existing.handledAssignmentKey == null && this.store.workItemsForTicket(existing.id).length === 0 && this.store.worktreeFor(existing.id) === null && this.store.linksFor(existing.id).length === 0 && this.store.poolTriages(existing.id).length === 0;

      if (!bare) {
        throw new Refusal(`Switchboard already has ${event.source} ${event.sourceKey}.`);
      }

      this.store.transferVolume(existing.id, ticket.id);
      this.store.deleteBareTicket(existing.id);
    }

    this.store.updateTicket(ticket.id, { source: event.source, sourceKey: event.sourceKey, ref: event.ref, sourceId: null, title: event.title, url: event.url, assigned: false, pool: false, adhocKey: ticket.sourceKey });
    this.store.noteEvent({ adhocKey: ticket.sourceKey });

    if (playbook !== null) {
      this.store.updateWorkItem(item.id, { playbook: playbook.name });

      if (session.external) {
        this.store.updateSession(session.id, { reports: sessionReports('task', false, playbook, session.provider) });
      }
    }
  }

  /** A ticket report's playbook: a task playbook in the source's namespace, when the source has one (PRD R83). */
  private ticketPlaybook(source: string, name: string): Playbook {
    const namespace = this.context.settings.sources[source]?.namespace ?? '';
    const playbook = this.context.playbooks.get(name);

    if (playbook === undefined || playbook.kind !== 'task' || (namespace !== '' && name.split(':')[0] !== namespace)) {
      throw new Refusal(namespace === '' ? `${name} is not a task playbook.` : `${name} is not a task playbook in the ${namespace} namespace.`);
    }

    return playbook;
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

    if (this.store.workItemsWithParent(parent.id).some((item) => item.status !== 'done' && item.reportedPrompt === report.prompt)) {
      return;
    }

    this.insertAdhoc(report.prompt, report.title?.trim() || line, repoRoot, parent.id, 'unstarted');
  }

  /**
   * An ad-hoc ticket and work item: queued when the operator chose Start automatically, otherwise unstarted, and running, with no
   * prompt, for a registered session (PRD R6, R68, R81).
   */
  private insertAdhoc(prompt: string | null, title: string, repoRoot: string, parentId: number | null, status: 'queued' | 'unstarted' | 'running'): WorkItem {
    const keys = this.store.adhocKeys().map(Number);
    const sourceKey = String(Math.max(0, ...keys) + 1);
    // A follow-up keeps its origin when Delete clears its parentId (PRD R27, R76).
    const ticket = this.store.insertTicket({ source: ADHOC_SOURCE, sourceKey, ref: `#${sourceKey}`, sourceId: parentId === null ? null : 'task', title, url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: this.now, lastPolledAt: null, repoRoot });
    const queued = status === 'queued';

    if (parentId !== null) {
      this.store.noteEvent({ childTicketId: ticket.id, childRef: ticket.ref, childTitle: title });
    }

    return this.store.insertWorkItem({
      ticketId: ticket.id,
      playbook: null,
      status,
      stage: null,
      stageAt: null,
      taskPrompt: prompt,
      guidance: null,
      reportedPrompt: parentId === null ? null : prompt,
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
      runStartedAt: status === 'unstarted' ? null : this.now,
      scopeAt: null,
      doneAt: null,
      doneReason: null,
      parentId,
    });
  }

  // Schedules

  /**
   * PRD R82: keeps a ticket for each schedule, and gives each schedule that came due since the last tick a work item, unless it has an open one.
   * The ticket's `lastPolledAt` is when its schedule was last checked, so a time that passed while the hub was stopped runs once at the next tick,
   * and its `sourceId` is the schedule's `scheduleText`, so a schedule added again or moved starts from now instead of catching up.
   */
  runSchedules(): void {
    const configured = this.context.settings.schedules;

    for (const ticket of this.store.tickets(SCHEDULE_SOURCE)) {
      if (configured[ticket.sourceKey] === undefined && ticket.sourceId !== null) {
        this.store.beginEvent({ at: this.now, type: 'schedule', actor: 'hub', ticketId: ticket.id, workItemId: null, sessionId: null, detail: { name: ticket.sourceKey } });
        this.store.updateTicket(ticket.id, { sourceId: null });
      }
    }

    for (const [name, schedule] of Object.entries(configured)) {
      this.store.beginEvent({ at: this.now, type: 'schedule', actor: 'hub', ticketId: this.store.findTicket(SCHEDULE_SOURCE, name)?.id ?? null, workItemId: null, sessionId: null, detail: { name } });

      const ticket = this.scheduleTicket(name, schedule);
      const due = latestDue(schedule, this.now);
      const when = scheduleText(schedule);
      const checked = ticket.sourceId === when ? ticket.lastPolledAt : null;

      if (ticket.sourceId !== when) {
        this.store.updateTicket(ticket.id, { sourceId: when });
      }

      this.store.updateTicket(ticket.id, { lastPolledAt: this.now });

      if (due === null || checked === null || due <= checked) {
        continue;
      }

      const skipped = this.hasOpenWorkItem(ticket.id);

      this.store.beginEvent({ at: this.now, type: 'schedule', actor: 'hub', ticketId: ticket.id, workItemId: null, sessionId: null, detail: { name, dueAt: due, skipped } }, true);

      if (!skipped) {
        this.insertRun(ticket, schedule, false);
      }
    }
  }

  private runSchedule(name: string): void {
    const schedule = this.context.settings.schedules[name];

    if (schedule === undefined) {
      throw new Refusal(`settings.json has no schedule named ${name}.`);
    }

    const ticket = this.scheduleTicket(name, schedule);

    if (this.hasOpenWorkItem(ticket.id)) {
      throw new Refusal(`${name} already has an open work item.`);
    }

    this.insertRun(ticket, schedule, true);
  }

  /** The schedule's ticket, titled by its playbook's description, made when first seen. */
  private scheduleTicket(name: string, schedule: ScheduleSettings): Ticket {
    const title = this.context.playbooks.get(schedule.playbook)?.description || name;
    const known = this.store.findTicket(SCHEDULE_SOURCE, name);

    if (known === null) {
      return this.store.insertTicket({ source: SCHEDULE_SOURCE, sourceKey: name, ref: name, sourceId: scheduleText(schedule), title, url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: this.now, lastPolledAt: this.now, repoRoot: schedule.repoRoot });
    }

    if (known.title !== title || known.repoRoot !== schedule.repoRoot) {
      this.store.updateTicket(known.id, { title, repoRoot: schedule.repoRoot });
    }

    return { ...known, title, repoRoot: schedule.repoRoot };
  }

  /** A run of a schedule: queued when its playbook starts automatically or the operator asked for it, else unstarted, and failed without a task playbook. */
  private insertRun(ticket: Ticket, schedule: ScheduleSettings, start: boolean): void {
    const playbook = this.context.playbooks.get(schedule.playbook);
    const error = playbook === undefined ? `Playbook ${schedule.playbook} is not loaded.` : playbook.kind !== 'task' ? `${schedule.playbook} is not a task playbook.` : null;
    const status: WorkItemStatus = error !== null ? 'failed' : start || playbook!.autoStart ? 'queued' : 'unstarted';

    // The in-queue time counts from the run's start, not the schedule's first one (PRD R27).
    this.store.updateTicket(ticket.id, { scopeAt: this.now });
    this.store.insertWorkItem({
      ticketId: ticket.id,
      playbook: schedule.playbook,
      status,
      stage: null,
      stageAt: null,
      taskPrompt: null,
      guidance: null,
      reportedPrompt: null,
      warning: null,
      error,
      unassignedAt: null,
      queuedAt: status === 'queued' ? this.now : null,
      approvalPrompt: null,
      approvalSummary: null,
      approvalReport: null,
      approvalHeld: false,
      createdAt: this.now,
      statusAt: this.now,
      readyAt: null,
      orderAt: null,
      runStartedAt: status === 'queued' ? this.now : null,
      scopeAt: null,
      doneAt: null,
      doneReason: null,
      parentId: null,
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
      focus: focusUrl(event.anchors ?? [], event.focus ?? null, playbook.focus),
      model: event.model,
    });

    for (const link of event.links ?? []) {
      this.store.addLink({ ticketId: triage.ticketId, label: link.label, target: link.target, reportedAt: this.now, mentioned: link.mentioned === true });
    }

    const item = triage.workItemId === null ? null : this.store.workItem(triage.workItemId)!;

    if (item?.status !== 'triaging' || this.deletedAfterTriage(item)) {
      return;
    }

    this.store.updateWorkItem(item.id, { playbook: playbook.name, taskPrompt: null, error: null });

    if (playbook.autoStart && !event.stale) {
      this.queue(item);
    } else {
      // The row says why the work item waits; Start clears it (PRD R80).
      this.setStatus(item.id, { status: 'unstarted', error: event.stale ? MESSAGES.nothingNew : null });
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
    // The failed triage row marks a work item failed at triage (PRD R34).
    const fail = (error: string) => {
      this.store.insertTriage({ ...EMPTY_TRIAGE, ticketId: ticket.id, workItemId: item?.id ?? null, startedAt: this.now, endedAt: this.now, error });

      if (item !== null) {
        this.fail(item, error);
      }
    };

    if (playbook === undefined || playbook.kind !== 'triage') {
      fail(name === '' ? `sources.${ticket.source}.triagePlaybook is not set.` : `Triage playbook ${name} is not loaded.`);
      return;
    }

    const choices = [...this.context.playbooks.values()]
      .filter((candidate) => candidate.kind === 'task' && candidate.name.startsWith(prefix))
      .map((candidate) => ({ name: candidate.name, description: candidate.description, focus: candidate.focus }));

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
      handled: item === null ? null : this.handled(item),
    });
  }

  /**
   * The latest earlier work item of the ticket and when it took in the ticket's activity: the start of its first task session that the runner
   * started, or when the operator marked it done without one (PRD R80). A work item with neither, such as one unassigned during setup, did not act on it.
   * A handled-assignment registration counts as the reporting work item taking in the ticket's activity when it registered (PRD R85).
   */
  private handled(item: WorkItem): HandledWork | null {
    let latest: HandledWork | null = null;

    for (const other of this.store.workItemsForTicket(item.ticketId)) {
      const starts = this.store.sessionsFor(other.id).filter((session) => session.kind === 'task' && session.shortId !== null).map((session) => session.startedAt);
      const at = starts.length > 0 ? Math.min(...starts) : other.doneReason === 'operator' ? other.doneAt : null;

      if (other.id !== item.id && at !== null && (latest === null || at > latest.at)) {
        latest = { at, playbook: other.playbook };
      }
    }

    for (const registration of this.store.handledRegistrations(item.ticketId)) {
      if (latest === null || registration.at > latest.at) {
        // Registrations logged before the event kept the playbook take it from the reporter while it exists.
        const playbook = registration.playbook ?? (registration.workItemId === null ? null : (this.store.workItem(registration.workItemId)?.playbook ?? null));
        latest = { at: registration.at, playbook };
      }
    }

    return latest;
  }

  // Sessions

  private session(sessionId: string): Session {
    const session = this.store.session(sessionId);

    if (session === null) {
      throw new Refusal(`Unknown session ${sessionId}.`);
    }

    return session;
  }

  private registerHandled(event: Extract<FlowEvent, { type: 'handled' }>): void {
    const session = this.session(event.sessionId);
    const origin = this.store.workItem(session.workItemId)!;
    if (origin.status === 'done' || this.store.sessionsFor(origin.id).at(-1)?.id !== session.id) throw new Refusal('Only the current session of an open work item can report a handled assignment.');
    let ticket = this.store.findTicket(event.source, event.sourceKey);
    if (ticket?.id === origin.ticketId) throw new Refusal('The session already works on this ticket.');
    if (event.release) {
      if (ticket === null) throw new Refusal('No handled assignment was registered for this ticket.');
      if (ticket.handledAssignmentKey == null && this.store.assignmentEnded(ticket.id, event.key)) return;
      if (ticket.handledAssignmentKey !== event.key) throw new Refusal('The handled assignment changed; the release was not applied.');
      this.store.updateTicket(ticket.id, { handledAssignmentKey: null, assigned: event.assigned });
      this.store.noteEvent({ assignmentReason: 'released' });
      if (event.assigned) this.createWorkItem(ticket.id);
      return;
    }
    if (ticket?.handledAssignmentKey === event.key) return;
    const registered = ticket === null ? null : this.store.registeredAssignment(ticket.id, session.id);
    if (registered !== null && registered !== event.key) throw new Refusal('This session registered an earlier assignment; it cannot register the returned work.');
    if (ticket !== null && (ticket.handledAssignmentKey != null || this.store.assignmentEnded(ticket.id, event.key))) throw new Refusal('This assignment was already released or another assignment is registered.');
    const items = ticket === null ? [] : this.store.workItemsForTicket(ticket.id).filter((item) => item.status !== 'done');
    if (items.some((item) => this.store.sessionsFor(item.id).length > 0)) throw new Refusal('This ticket already has started work; resolve it before registering the assignment.');
    ticket ??= this.store.insertTicket({ source: event.source, sourceKey: event.sourceKey, ref: event.ref, title: event.title, url: event.url, sourceId: null, assigned: false, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
    for (const item of items) this.store.deleteWorkItem(item.id);
    this.store.updateTicket(ticket.id, { handledAssignmentKey: event.key });
    this.store.noteEvent({ reportedByWorkItemId: origin.id, reportedByPlaybook: origin.playbook });
  }

  private sessionStarted(sessionId: string, nativeSessionId: string | null, shortId: string, startPrompt: boolean): void {
    const session = this.session(sessionId);

    if (session.state === 'starting') {
      const state = startPrompt ? { state: 'waiting' as const, stateDetail: START_PROMPT } : { state: 'running' as const };

      this.store.updateSession(sessionId, { nativeSessionId, shortId, ...state, stateAt: this.now });
      const item = this.store.workItem(session.workItemId)!;

      // The started task session's prompt holds the guidance (PRD R77).
      if (session.kind === 'task' && item.guidance !== null) {
        this.store.updateWorkItem(item.id, { guidance: null });
      }

      const ticket = this.store.ticket(item.ticketId)!;
      if (session.kind === 'task' && (ticket.source === 'zoho' || ticket.source === 'forum')) {
        this.store.volumeWorked(ticket.id, session.id, this.now);
      }
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
  private roster(observed: ObservedSession[], checked: string[] | undefined, forks: ObservedFork[]): void {
    const listed = new Map(observed.map((entry) => [entry.sessionId, entry]));

    for (const fork of forks) {
      const adopted = this.adoptFork(fork);

      if (adopted) {
        listed.set(fork.sessionId, { sessionId: fork.sessionId, state: fork.state, detail: fork.detail, interactive: true });
      }
    }

    const forked = new Set(forks.map((fork) => fork.sessionId));

    // A waiting fork the operator closed no longer holds back Open in Claude.
    for (const session of this.store.activeSessions()) {
      if (session.pendingFork !== null && !forked.has(session.id) && (checked === undefined || checked.includes(session.id))) {
        this.store.updateSession(session.id, { pendingFork: null });
      }
    }

    for (const entry of listed.values()) {
      const session = this.store.session(entry.sessionId);

      // A moving session's tab process is going and its background one not confirmed, so no listing decides it (PRD R89).
      if (session !== null && session.state !== 'starting' && session.move === null) {
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
      if (session.state !== 'starting' && session.move === null && !listed.has(session.id) && (looked === null || looked.has(session.id))) {
        // Its background process is gone, so a later resume (such as in a VS Code tab) is never released (PRD R39).
        this.store.updateSession(session.id, { state: 'ended', stateAt: this.now, stateDetail: null, endedAt: this.now, released: true, releasing: false, question: null, external: false });
        this.ended({ ...session, state: 'ended' });
      }
    }
  }

  /**
   * A fork replaces the work item's latest session, whose current copy is retired (PRD R78). While that copy holds Switchboard's background
   * process, the fork waits for its release (R39), so its work is never cut off.
   */
  private adoptFork(fork: ObservedFork): boolean {
    const session = this.store.session(fork.sessionId);

    // A moving session resumes its own ID, so a fork waits until the move ends (PRD R89).
    if (session === null || session.state === 'starting' || session.move !== null || session.nativeSessionId === null || session.nativeSessionId === fork.nativeSessionId || session.retiredIds.includes(fork.nativeSessionId)) {
      return false;
    }

    if (this.store.sessionsFor(session.workItemId).at(-1)?.id !== session.id) {
      return false;
    }

    if (!session.released || session.releasing) {
      if (session.pendingFork !== fork.shortId) {
        this.store.updateSession(session.id, { pendingFork: fork.shortId });
      }

      return false;
    }

    this.store.updateSession(session.id, { nativeSessionId: fork.nativeSessionId, shortId: fork.shortId, retiredIds: [...session.retiredIds, session.nativeSessionId], pendingFork: null });

    return true;
  }

  /**
   * A hook marker sets the state of a live session only, because a killed process leaves its marker behind. A session waiting on a prompt before
   * it starts leaves that state only when the roster lists its process (PRD R41).
   */
  private marker(sessionId: string, state: LiveState, detail: string | null): void {
    const session = this.session(sessionId);

    if (session.state !== 'starting' && session.state !== 'ended' && session.move === null && !waitsToStart(session)) {
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

    if (item !== null && current.kind === 'setup') {
      this.setupState(item, current, state, resumed);
      return;
    }

    if (item === null || current.kind !== 'task') {
      return;
    }

    // Resumed before the recheck of its done report, so that report no longer ends the work item.
    if (resumed && awaitsRecheck(item, current)) {
      this.store.updateSession(session.id, { outcome: null, outcomeDetail: null });
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
    } else if (state === 'running' && detail === null && item.status === 'awaiting-approval') {
      // The operator gave the session more work after its approval report; the report waits until the run ends (PRD R34).
      // A turn that ends with background tasks stays `running` with a detail, so the next prompt or tool call still counts.
      this.store.updateSession(session.id, { outcome: null, outcomeDetail: null });
      this.setStatus(item.id, { status: 'running', approvalHeld: true, error: null });
    }
  }

  /** Settles a done report the first read could not confirm: blocked when the ticket is still assigned, else done (PRD R10). */
  private doneChecked(sessionId: string, token: string, assigned: boolean): void {
    const session = this.store.session(sessionId);
    const item = session === null ? null : this.latest(session);

    // A resume, an approval report or a later done report replaced the token, or the status changed.
    if (item === null || session!.outcomeDetail !== token || !awaitsRecheck(item, session!)) {
      return;
    }

    this.store.updateSession(sessionId, { outcomeDetail: null });

    if (assigned) {
      this.block(item, MESSAGES.doneStillAssigned);
    } else {
      this.done(item, 'session', null);
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

      if (item.unassignedAt === null && this.store.worktreeFor(item.ticketId) === null) {
        this.fail(item, MESSAGES.setupWithoutWorktree);
      } else {
        this.finishSetup(item, session);
      }

      return;
    }

    // A done report with its ticket still assigned leaves the work item open until the recheck or the ticket leaving settles it.
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

  /**
   * A setup session the operator resumed, such as one opened in Claude to answer its question (PRD R70), keeps its process while the tab is open,
   * so its turn end decides setup. A resume after setup failed because the process was gone, as at a logout, retries it.
   */
  private setupState(item: WorkItem, session: Session, state: LiveState, resumed: boolean): void {
    if (resumed && item.status === 'failed' && item.error === MESSAGES.setupWithoutWorktree) {
      this.setStatus(item.id, { status: 'setup', error: null });
    } else if (TURN_ENDED.includes(state) && session.released && !session.releasing && item.status === 'setup' && (item.unassignedAt !== null || this.store.worktreeFor(item.ticketId) !== null)) {
      this.finishSetup(item, session);
    }
  }

  private finishSetup(item: WorkItem, session: Session): void {
    if (item.unassignedAt !== null) {
      this.done(item, 'unassigned', null);
      return;
    }

    this.store.updateSession(session.id, { outcome: 'done' });

    // A snoozed ticket's task waits in the queue until the ticket wakes or is restored (PRD R49).
    if (this.store.ticket(item.ticketId)!.snoozed) {
      this.queue(item);
    } else {
      this.startSession(item);
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
          // A read that still lists the ticket waits for the hub's recheck (`done-checked`), because issue search lags an unassignment.
          if (report.assigned === true) {
            this.store.updateSession(sessionId, { outcomeDetail: `${UNCONFIRMED_DONE}; it was still assigned at ${new Date(this.now).toISOString()}.` });
          } else {
            this.done(item, 'session', null);
          }
        }

        return;
      case 'approval':
        // The work is ready; Approve starts a new task session with the prompt that publishes it (PRD R23, R31).
        if (item !== null && session.kind === 'task') {
          // An approval after a done report the hub has not confirmed replaces it.
          if (awaitsRecheck(item, session)) {
            this.store.updateSession(sessionId, { outcomeDetail: null });
          }

          this.setStatus(item.id, { status: 'awaiting-approval', approvalPrompt: report.prompt, approvalSummary: report.summary, approvalReport: report.report, error: null });
        }

        return;
      case 'link':
        // Links belong to the ticket, so a returned ticket keeps them (PRD R52).
        this.store.addLink({ ticketId: this.store.workItem(session.workItemId)!.ticketId, label: report.label, target: report.target, reportedAt: this.now, mentioned: false });
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

    // A registered session runs in the operator's window, so Switchboard never stops it (PRD R81).
    if (session.external) {
      throw new Refusal('The session runs in your own window; stop it there.');
    }

    if (session.move?.phase === 'launching') {
      throw new Refusal('The session is starting in the background; stop it once it has started.');
    }

    // Its tab's process is exiting and no background one has started, so the move ends and nothing is left to stop (PRD R89).
    if (session.move !== null) {
      this.store.updateSession(session.id, { move: null, movedAt: this.now });
      this.stopSucceeded(session.id, 'operator', undefined);
      return;
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

    // Its follow-ups lose their parentId, so their tickets keep the origin, as tickets made before it was stored did not (PRD R27).
    for (const child of this.store.workItemsWithParent(item.id)) {
      this.store.updateTicket(child.ticketId, { sourceId: 'task' });
    }

    this.store.deleteWorkItem(item.id);

    // A snoozed ticket with no row left would stay hidden on GitHub boards (PRD R56) until it left scope.
    const ticket = this.store.ticket(item.ticketId)!;

    if (ticket.snoozed && !ticket.pool && this.store.workItemsForTicket(ticket.id).length === 0) {
      this.store.updateTicket(ticket.id, UNSNOOZED);
    }
  }

  private stopSucceeded(sessionId: string, reason: StopReason, shortId: string | null | undefined): void {
    const session = this.session(sessionId);

    if (session.state === 'ended' || retiredStop(session, shortId)) {
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
  private stopFailed(sessionId: string, reason: StopReason, message: string, shortId: string | null | undefined): void {
    const session = this.session(sessionId);
    const item = retiredStop(session, shortId) ? null : this.latest(session);

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

    if (session.pendingFork !== null) {
      throw new Refusal(`Fork ${session.pendingFork} waits to continue this session; stop the session to continue in the fork.`);
    }

    if (session.state !== 'waiting') {
      throw new Refusal('The session is not waiting on a question.');
    }

    if (waitsToStart(session)) {
      throw new Refusal('The session waits on a prompt before it starts; open it in a terminal to answer it.');
    }

    return session as Session & { shortId: string };
  }

  /**
   * Continue in Background (PRD R89): once the tab's process exits, the session resumes in its background process. The window closes the tab after
   * this succeeds, so the session must be running there, released to it, and Switchboard's own.
   */
  private background(event: Extract<FlowEvent, { type: 'background' }>): void {
    const session = this.store.session(event.sessionId);
    const item = session === null ? null : this.latest(session);

    if (session === null || item === null || session.nativeSessionId !== event.nativeSessionId || !event.workItemIds.includes(item.id)) {
      throw new Refusal("This tab's session is not one of Switchboard's work items.");
    }

    if (session.provider !== 'claude' || session.external) {
      throw new Refusal('This session never ran in the background, so it cannot continue there.');
    }

    if (session.move !== null) {
      throw new Refusal('The session is already moving to the background.');
    }

    if (!session.released || session.releasing) {
      throw new Refusal('The session already runs in the background.');
    }

    if (session.pendingFork !== null) {
      throw new Refusal(`Fork ${session.pendingFork} waits to continue this session; continue in the fork.`);
    }

    if (session.state !== 'running' && !event.busy) {
      throw new Refusal('Continue in Background works while the session is running.');
    }

    const moveId = this.context.newSessionId();

    this.store.updateSession(session.id, { move: { id: moveId, pid: event.pid, phase: 'waiting', at: this.now, deadline: null } });
    this.actions.push({ type: 'resume-session', sessionId: session.id, moveId, provider: session.provider, nativeSessionId: event.nativeSessionId, cwd: session.cwd, pid: event.pid, prompt: RESUME_PROMPT });
  }

  /** The session's move with this ID, or null for another attempt's result, such as one that Stop or Delete ended. */
  private currentMove(sessionId: string, moveId: string): Session | null {
    const session = this.store.session(sessionId);

    return session?.move?.id === moveId ? session : null;
  }

  private moveLaunching(sessionId: string, moveId: string, deadline: number): void {
    const session = this.currentMove(sessionId, moveId);

    if (session !== null) {
      this.store.updateSession(sessionId, { move: { ...session.move!, phase: 'launching', deadline } });
    }
  }

  /** The background process holds the session again, so R39 releases it at its turn end. */
  private sessionResumed(sessionId: string, moveId: string, shortId: string): void {
    if (this.currentMove(sessionId, moveId) === null) {
      return;
    }

    this.store.updateSession(sessionId, {
      move: null,
      movedAt: this.now,
      shortId,
      state: 'running',
      stateAt: this.now,
      stateDetail: null,
      endedAt: null,
      released: false,
      releasing: false,
    });
  }

  /** The session ended with the tab, and its resume failed; the work item shows why (Visible failure). */
  private resumeFailed(sessionId: string, moveId: string, message: string): void {
    const session = this.currentMove(sessionId, moveId);

    if (session === null) {
      return;
    }

    const cause = `Continue in Background failed: ${message}`;

    this.store.updateSession(sessionId, { move: null, movedAt: this.now, state: 'ended', stateAt: this.now, stateDetail: null, endedAt: this.now, released: true, releasing: false, question: null, outcome: session.outcome ?? 'failed', outcomeDetail: session.outcome === null ? cause : session.outcomeDetail });

    const item = this.latest(session);

    if (item === null) {
      return;
    }

    // Its process is gone, so its end decides setup, as when a setup session's process ends any other way; the session keeps the cause.
    if (session.kind === 'setup') {
      this.ended({ ...session, state: 'ended' });
      return;
    }

    if (item.unassignedAt !== null) {
      this.done(item, 'unassigned', null);
    } else if (item.approvalHeld || item.status === 'awaiting-approval') {
      // An approval reported before the failure still waits on the operator; the cause shows beside it (PRD R40).
      this.restoreApproval(item, cause);
    } else if (item.status === 'running') {
      this.block(item, cause);
    }
  }

  /** The tab's process is still running, so the session stays in its tab and the roster observes it again. */
  private moveCancelled(sessionId: string, moveId: string): void {
    if (this.currentMove(sessionId, moveId) !== null) {
      this.store.updateSession(sessionId, { move: null, movedAt: this.now });
    }
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

  /** A work item in Ready for review: open, ready and not snoozed (PRD R73). */
  private reviewItem(workItemId: number): WorkItem {
    const item = this.openItem(workItemId);

    if (this.store.ticket(item.ticketId)!.snoozed || groupOf({ ...item, sessions: this.store.sessionsFor(item.id), triage: this.store.triagesFor(item.id).at(-1) ?? null }) !== 'review') {
      throw new Refusal('The work item is not in Ready for review.');
    }

    return item;
  }

  /**
   * Sets `orderAt` between `after` and the next work item in Ready for review's order, or first when `after` is null. The order holds every
   * ready work item, snoozed ones too, so they return to their places, and stays before now, so a newly ready one comes last.
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
  private snooze(ticketId: number, until: number | null, comment: string | null): void {
    if (until !== null && until <= this.now) {
      throw new Refusal('The snooze time has passed.');
    }

    this.store.updateTicket(this.knownTicket(ticketId).id, { snoozed: true, snoozedUntil: until, snoozeComment: comment });
  }

  private restore(ticketId: number): void {
    this.store.updateTicket(this.knownTicket(ticketId).id, UNSNOOZED);
  }

  /** PRD R87: local only; any work item, open or done, takes a comment. */
  private comment(item: WorkItem, text: string | null): void {
    if (text === null) {
      throw new Refusal('The comment is empty.');
    }

    this.store.addComment({ workItemId: item.id, at: this.now, text });
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
  private pick(ticket: Ticket, guidance: string | null, playbook: string | null): void {
    const triages = this.store.poolTriages(ticket.id);
    const triaged = triages.filter((triage) => triage.playbook !== null).at(-1);

    if (triaged?.playbook == null) {
      throw new Refusal('The ticket has no triage result yet.');
    }

    const item = this.store.insertWorkItem({
      ticketId: ticket.id,
      playbook: this.chosenPlaybook(triaged.playbook, ticket, playbook),
      status: 'queued',
      stage: null,
      stageAt: null,
      taskPrompt: null,
      guidance,
      reportedPrompt: null,
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

  private start(item: WorkItem, guidance: string | null, playbook: string | null, prompt: string | null): void {
    if (item.status !== 'unstarted') {
      throw new Refusal('The work item is not unstarted.');
    }

    // Start with prompt… edits the prompt of a work item without a playbook, which every later start runs (PRD R77).
    if (prompt !== null && ownPrompt(item) === null) {
      throw new Refusal("The work item runs its playbook's prompt.");
    }

    // The focus stays as triage set it (PRD R79).
    this.store.updateWorkItem(item.id, { guidance, playbook: this.chosenPlaybook(item.playbook, this.store.ticket(item.ticketId)!, playbook), ...(prompt === null ? {} : { taskPrompt: prompt }) });
    this.queue(item);
  }

  /** The playbook Start with guidance… chose, or triage's when it chose none (PRD R35). */
  private chosenPlaybook(triaged: string | null, ticket: Ticket, chosen: string | null): string | null {
    if (chosen === null || chosen === triaged) {
      return triaged;
    }

    if (!playbookChoices(triaged, ticket.source, this.context.playbooks).includes(chosen)) {
      throw new Refusal(triaged === null || ticket.source === SCHEDULE_SOURCE ? 'The playbook of this work item cannot change.' : `${chosen} is not a task playbook in the ${namespaceOf(triaged)} namespace.`);
    }

    return chosen;
  }

  /**
   * PRD R34: a work item that failed at triage triages again; any other failure queues it, so its next start runs setup, the approved prompt
   * or the task session, as before it failed. Its playbook, approval, guidance and readiness stay.
   */
  private retry(item: WorkItem): void {
    if (item.status !== 'failed') {
      throw new Refusal('The work item has not failed.');
    }

    this.requireNoSession(item);

    if (failedAtTriage({ ...item, triage: this.store.triagesFor(item.id).at(-1) ?? null })) {
      this.setStatus(item.id, { status: 'triaging', error: null });
    } else {
      this.queue(item);
    }
  }

  /**
   * PRD R86: a done work item opens where its work stands: running while its task session is in a turn, `awaiting-approval` for an approval
   * that waited when it became done, else `finished`; without a task session it waits for Start, or for triage. A turn holds that approval.
   */
  private reopen(item: WorkItem): void {
    const refusal = reopenRefusal(item, this.store.workItemsForTicket(item.ticketId), this.store.ticket(item.ticketId)!);

    if (refusal !== null) {
      throw new Refusal(refusal);
    }

    const latest = this.store.sessionsFor(item.id).at(-1);

    // An outcome such as `stopped` from before the work item was done would keep its next turn end from settling it.
    if (latest !== undefined && latest.outcome !== null && latest.outcome !== 'opened') {
      this.store.updateSession(latest.id, { outcome: null, outcomeDetail: null });
    }

    const turnEnded = latest !== undefined && (TURN_ENDED.includes(latest.state) || latest.state === 'ended');
    const approval = latest?.kind === 'task' && item.approvalHeld;
    const status: WorkItemStatus = latest?.kind !== 'task'
      ? item.playbook !== null || item.taskPrompt !== null ? 'unstarted' : 'triaging'
      : turnEnded ? (approval ? 'awaiting-approval' : 'finished') : 'running';

    this.setStatus(item.id, { status, approvalHeld: approval && !turnEnded, doneAt: null, doneReason: null, scopeAt: null, warning: null, error: null, unassignedAt: null, queuedAt: null });
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
    const current = this.store.workItem(item.id)!;
    const latest = this.store.sessionsFor(item.id).at(-1);
    // A done report, settled now or awaiting its recheck, covers the publication; any other ending keeps a waiting or approved-but-unstarted
    // approval for Reopen (PRD R86).
    const reported = reason === 'session' || (latest !== undefined && awaitsRecheck(current, latest));
    const approvalHeld = !reported && (current.status === 'awaiting-approval' || current.approvalHeld || (current.status === 'queued' && current.approvalPrompt !== null));

    this.setStatus(item.id, { status: 'done', doneAt: this.now, doneReason: reason, warning, queuedAt: null, scopeAt, approvalHeld });
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

  /** Triages work items, pool tickets, then retained Support tickets, within the shared concurrency limit. */
  private scheduleTriage(): void {
    const running = this.store.runningTriages();
    const busy = new Set(running.map((triage) => triage.workItemId));
    const busyTickets = new Set(running.filter((triage) => triage.workItemId === null).map((triage) => triage.ticketId));
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

      if (!busy.has(item.id) && !busyTickets.has(ticket.id) && !ticket.snoozed && ticket.handledAssignmentKey == null) {
        start(ticket, item);
      }
    }

    for (const ticket of this.store.poolTickets()) {
      if (free <= 0) {
        return;
      }

      if (!ticket.snoozed && ticket.handledAssignmentKey == null && this.store.poolTriages(ticket.id).length === 0 && !this.hasOpenWorkItem(ticket.id)) {
        start(ticket, null);
      }
    }

    const enabled = this.store.enabledSources();
    for (const ticket of this.store.unclassifiedTickets()) {
      if (free <= 0) return;
      if (enabled.has(ticket.source) && this.context.settings.sources[ticket.source] && !ticket.snoozed && ticket.handledAssignmentKey == null && !this.hasOpenWorkItem(ticket.id)) start(ticket, null);
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

      if (this.store.ticket(item.ticketId)?.handledAssignmentKey == null && queueWaits(this.store, item, limit, used).length === 0) {
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

    if (playbook !== null && playbook.kind !== 'task') {
      this.fail(item, `${playbook.name} is not a task playbook.`);
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
    // The guidance waits through a setup session and a failed start for the task session, and an approved prompt does not take it (PRD R77).
    const guided = kind === 'task' && !approved;
    const full = sessionPrompt(prompt, id, guided ? item.guidance : null);

    if (kind === 'task' && playbook !== null) {
      this.store.updateWorkItem(item.id, { taskPrompt: full });
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
      retiredIds: [],
      pendingFork: null,
      external: false,
      move: null,
      movedAt: null,
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
