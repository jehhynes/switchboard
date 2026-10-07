import type { Playbook } from './playbook.js';
import { repoRoots } from './settings.js';
import type { PermissionMode, Settings } from './settings.js';
import { REPORT_KINDS } from './model.js';
import type { FailedStep, Immediacy, ReportKind, Session, SessionKind, SessionState, Severity, Ticket, WorkItem, WorkItemStatus } from './model.js';
import type { SourceLink } from './source.js';
import type { NewWorkItem, Store } from './store.js';
import { renderTaskPrompt, sessionPrompt, triagePrompt } from './template.js';
import type { TemplateVariable } from './template.js';

export const ADHOC_SOURCE = 'adhoc';

/** The statuses of a run; entering one from another status starts the Working clock (PRD R27). */
const RUN_STATUSES: ReadonlySet<WorkItemStatus> = new Set(['triaging', 'queued', 'setup', 'running']);

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
  turnFinished: 'The session finished its turn.',
  sessionFinished: 'The session ended.',
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
  | { kind: 'task'; prompt: string; repo: string | null; title: string | null };

export type StopReason = 'operator' | 'release';

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
  | { type: 'roster'; sessions: ObservedSession[] }
  | { type: 'marker'; sessionId: string; state: LiveState; detail: string | null }
  | { type: 'report'; sessionId: string; report: Report }
  | { type: 'stop-succeeded'; sessionId: string; reason: StopReason }
  | { type: 'stop-failed'; sessionId: string; reason: StopReason; message: string }
  | { type: 'worktree-found'; source: string; sourceKey: string; path: string; branch: string }
  | { type: 'adhoc'; prompt: string; repoRoot: string }
  | { type: 'start' | 'approve' | 'retry' | 'mark-done' | 'retriage' | 'stop'; workItemId: number }
  | { type: 'pick' | 'retriage-pool' | 'restore'; ticketId: number }
  /** Snoozes the ticket until `until`, or indefinitely when null (PRD R49). */
  | { type: 'snooze'; ticketId: number; until: number | null }
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
      cwd: string;
      prompt: string;
      name: string;
      permissionMode: PermissionMode;
      model: string | null;
    }
  | { type: 'stop-session'; sessionId: string; shortId: string | null; reason: StopReason };

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
function sessionReports(kind: SessionKind, approved: boolean, playbook: Playbook | null): ReportKind[] {
  if (kind !== 'task' || approved) {
    return ['stage', 'worktree', 'done', 'link', 'task'];
  }

  // An ad-hoc work item has no playbook to change.
  return playbook === null ? REPORT_KINDS.filter((entry) => entry !== 'playbook') : REPORT_KINDS.filter((entry) => entry === 'stage' || entry === 'link' || entry === 'task' || (playbook.reports as readonly string[]).includes(entry));
}

/** Why a task session's turn or process ended without finishing, naming only a report its prompt offered. */
function endedMessage(session: Session, turn: boolean): string {
  if (session.reports.includes('done')) {
    return turn ? MESSAGES.turnEnded : MESSAGES.sessionEnded;
  }

  if (session.reports.includes('approval')) {
    return turn ? MESSAGES.turnEndedWithoutApproval : MESSAGES.sessionEndedWithoutApproval;
  }

  return turn ? MESSAGES.turnFinished : MESSAGES.sessionFinished;
}

const TURN_ENDED: readonly SessionState[] = ['idle', 'failed'];

/** The prompt's first non-empty line, which titles an ad-hoc ticket. */
function firstLine(prompt: string): string {
  return prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
}

/** Compares repo paths as Windows does: either separator, any case, no trailing separator. */
function samePath(a: string, b: string): boolean {
  const key = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

  return key(a) === key(b);
}

/** Decides what one event changes and which actions the hub runs. Call it inside one store transaction. */
export function handle(store: Store, event: FlowEvent, context: FlowContext): FlowResult {
  const flow = new Flow(store, context);

  flow.wake();

  try {
    flow.apply(event);
  } catch (error) {
    if (error instanceof Refusal) {
      return { actions: [], refused: error.message };
    }

    throw error;
  }

  flow.schedule();

  return { actions: flow.actions, refused: null };
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
        return this.roster(event.sessions);
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
        return this.start(this.openItem(event.workItemId));
      case 'approve':
        return this.approve(this.openItem(event.workItemId));
      case 'retry':
        return this.retry(this.openItem(event.workItemId));
      case 'mark-done':
        return this.done(this.openItem(event.workItemId), 'operator', null);
      case 'retriage':
        return this.retriage(this.openItem(event.workItemId));
      case 'stop':
        return this.stop(this.knownItem(event.workItemId));
      case 'pick':
        return this.pick(this.poolTicket(event.ticketId));
      case 'retriage-pool':
        return this.retriagePool(this.poolTicket(event.ticketId));
      case 'snooze':
        return this.snooze(event.ticketId, event.until);
      case 'restore':
        return this.restore(event.ticketId);
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
      warning: null,
      error: null,
      failedStep: null,
      unassignedAt: null,
      queuedAt: null,
      approvalPrompt: null,
      approvalSummary: null,
      approvalReport: null,
      createdAt: this.now,
      statusAt: this.now,
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

  /** PRD R10: done now when no session is active, otherwise when the active session reports or ends. */
  private left(ticketId: number): void {
    for (const item of this.store.workItemsForTicket(ticketId)) {
      if (item.status === 'done') {
        continue;
      }

      if (this.activeSession(item) === null) {
        this.done(item, 'unassigned', null);
      } else if (item.unassignedAt === null) {
        this.store.updateWorkItem(item.id, { unassignedAt: this.now });
      }
    }
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

    this.store.insertWorkItem({
      ticketId: ticket.id,
      playbook: null,
      status: queued ? 'queued' : 'unstarted',
      stage: null,
      stageAt: null,
      taskPrompt: prompt,
      warning: null,
      error: null,
      failedStep: null,
      unassignedAt: null,
      queuedAt: queued ? this.now : null,
      approvalPrompt: null,
      approvalSummary: null,
      approvalReport: null,
      createdAt: this.now,
      statusAt: this.now,
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

    if (item?.status !== 'triaging') {
      return;
    }

    this.store.updateWorkItem(item.id, { playbook: playbook.name, taskPrompt: null, error: null, failedStep: null });

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

    if (item?.status === 'triaging') {
      this.fail(item, 'triage', error);
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
        this.fail(item, 'triage', error);
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

    this.fail(item, session.kind, message);
  }

  /** Liveness comes from the roster alone (GC M20): a listed session is alive, an unlisted one has ended. */
  private roster(observed: ObservedSession[]): void {
    const listed = new Map(observed.map((entry) => [entry.sessionId, entry]));

    for (const entry of observed) {
      const session = this.store.session(entry.sessionId);

      if (session !== null && session.state !== 'starting') {
        // An interactive session is the operator's; Switchboard never stops it (PRD R39).
        if (entry.interactive === true && !session.released) {
          this.store.updateSession(session.id, { released: true });
        }

        this.setState({ ...session, released: session.released || entry.interactive === true }, entry.state, entry.detail);
      }
    }

    for (const session of this.store.activeSessions()) {
      if (session.state !== 'starting' && !listed.has(session.id)) {
        // Its background process is gone, so a later resume (such as in a VS Code tab) is never released (PRD R39).
        this.store.updateSession(session.id, { state: 'ended', stateAt: this.now, stateDetail: null, endedAt: this.now, released: true });
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

    this.store.updateSession(session.id, { state, stateAt: this.now, stateDetail: detail, endedAt: null });

    const current = { ...session, state, stateDetail: detail };
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
      if (item.unassignedAt !== null) {
        this.done(item, 'unassigned', null);
      } else {
        this.block(item, state === 'failed' ? `The turn failed: ${detail ?? 'unknown error'}.` : endedMessage(current, true));
      }
    } else if (resumed && item.status === 'blocked') {
      this.store.updateSession(session.id, { outcome: null, outcomeDetail: null });
      this.setStatus(item.id, { status: 'running', error: null, failedStep: null });
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
        this.fail(item, 'setup', MESSAGES.setupWithoutWorktree);
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
      this.block(item, endedMessage(session, false));
    }
  }

  /** PRD R39: stop a session whose turn has ended, once, so it can resume in VS Code. */
  private release(session: Session): void {
    if (session.released) {
      return;
    }

    this.store.updateSession(session.id, { released: true });
    this.actions.push({ type: 'stop-session', sessionId: session.id, shortId: session.shortId, reason: 'release' });
  }

  private report(sessionId: string, report: Report): void {
    const session = this.session(sessionId);

    if (!session.reports.includes(report.kind)) {
      throw new Refusal(`This session's prompt does not offer the ${report.kind} report.`);
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
          this.setStatus(item.id, { status: 'awaiting-approval', approvalPrompt: report.prompt, approvalSummary: report.summary, approvalReport: report.report, error: null, failedStep: null });
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

    this.actions.push({ type: 'stop-session', sessionId: session.id, shortId: session.shortId, reason: 'operator' });
  }

  private stopSucceeded(sessionId: string, reason: StopReason): void {
    const session = this.session(sessionId);

    if (session.state === 'ended') {
      return;
    }

    // A session that already reported done ends normally, so a finished setup still starts its task.
    const stopped = reason === 'operator' && session.outcome !== 'done';

    this.store.updateSession(sessionId, {
      state: 'ended',
      released: true,
      stateAt: this.now,
      endedAt: this.now,
      ...(stopped && session.outcome === null ? { outcome: 'stopped' as const, outcomeDetail: MESSAGES.stopped } : {}),
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
    } else {
      this.block(item, MESSAGES.stopped, session.kind);
    }
  }

  /** The session stays as it was, so the operator can stop it again. */
  private stopFailed(sessionId: string, reason: StopReason, message: string): void {
    const session = this.session(sessionId);
    const item = this.latest(session);

    if (item !== null) {
      this.store.updateWorkItem(item.id, { error: `${reason === 'operator' ? 'Stop' : 'Release'} failed: ${message}` });
    }
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
  private pick(ticket: Ticket): void {
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
      warning: null,
      error: null,
      failedStep: null,
      unassignedAt: null,
      queuedAt: this.now,
      approvalPrompt: null,
      approvalSummary: null,
      approvalReport: null,
      createdAt: this.now,
      statusAt: this.now,
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

  private start(item: WorkItem): void {
    if (item.status !== 'unstarted') {
      throw new Refusal('The work item is not unstarted.');
    }

    this.queue(item);
  }

  /** PRD R45: repeat the step that stopped. */
  private retry(item: WorkItem): void {
    if (item.status !== 'failed' && item.status !== 'blocked') {
      throw new Refusal('Only a failed or blocked work item can be retried.');
    }

    if (item.failedStep === 'triage') {
      this.setStatus(item.id, { status: 'triaging', error: null, failedStep: null });
      return;
    }

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

    this.setStatus(item.id, { status: 'triaging', error: null, failedStep: null, queuedAt: null, approvalPrompt: null, approvalSummary: null, approvalReport: null });
  }

  private requireNoSession(item: WorkItem): void {
    if (this.activeSession(item) !== null) {
      throw new Refusal('The work item has an active session.');
    }
  }

  // Status changes

  /** Every status change comes here, so statusAt and runStartedAt stay true (PRD R27). */
  private setStatus(id: number, patch: Partial<NewWorkItem> & { status: WorkItemStatus }): void {
    const before = this.store.workItem(id)!.status;
    const run = RUN_STATUSES.has(patch.status) && !RUN_STATUSES.has(before) ? { runStartedAt: this.now } : {};

    this.store.updateWorkItem(id, before === patch.status ? patch : { ...patch, statusAt: this.now, ...run });
  }

  private queue(item: WorkItem): void {
    this.setStatus(item.id, { status: 'queued', queuedAt: this.now, error: null, failedStep: null });
  }

  private done(item: WorkItem, reason: 'session' | 'operator' | 'unassigned', warning: string | null): void {
    const scopeAt = this.store.ticket(item.ticketId)!.scopeAt ?? item.createdAt;

    this.setStatus(item.id, { status: 'done', doneAt: this.now, doneReason: reason, warning, queuedAt: null, scopeAt });
  }

  private fail(item: WorkItem, step: 'triage' | SessionKind, cause: string): void {
    this.setStatus(item.id, { status: 'failed', failedStep: step, error: cause, queuedAt: null });
  }

  private block(item: WorkItem, cause: string, step: FailedStep = 'task'): void {
    this.setStatus(item.id, { status: 'blocked', failedStep: step, error: cause });
  }

  /** The session's work item when the session is its latest and it is not done (PRD R45). */
  private latest(session: Session): WorkItem | null {
    const item = this.store.workItem(session.workItemId)!;
    const sessions = this.store.sessionsFor(item.id);

    return item.status !== 'done' && sessions.at(-1)?.id === session.id ? item : null;
  }

  private activeSession(item: WorkItem): Session | null {
    return this.store.sessionsFor(item.id).find((session) => session.state !== 'ended') ?? null;
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
   * Starts queued work items in order while slots are free, skipping a ticket that already has an active session (PRD R17, R38).
   * A `waiting` session holds no slot, so open questions do not stall the queue.
   */
  private scheduleStarts(): void {
    const queued = this.store.workItemsWithStatus('queued').sort((a, b) => a.queuedAt! - b.queuedAt! || a.id - b.id);

    for (const item of queued) {
      if (this.store.activeSessions().filter((session) => session.state !== 'waiting').length >= this.context.settings.sessions.concurrency) {
        return;
      }

      if (this.store.activeSessionsForTicket(item.ticketId).length === 0 && !this.store.ticket(item.ticketId)!.snoozed) {
        this.startSession(item);
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
      this.fail(item, 'task', `Playbook ${item.playbook} is not loaded.`);
      return;
    }

    const worktree = this.store.worktreeFor(ticket.id);
    const repoRoot = ticket.repoRoot || source?.repoRoot || '';
    const approved = item.approvalPrompt !== null;
    const kind: SessionKind = !approved && playbook?.requiresWorktree === true && worktree === null ? 'setup' : 'task';
    const cwd = playbook?.workdir === 'repoRoot' ? repoRoot : (worktree?.path ?? repoRoot);

    if (cwd === '') {
      this.fail(item, kind, `sources.${ticket.source}.repoRoot is not set.`);
      return;
    }

    const id = this.context.newSessionId();
    const values = this.values(ticket, item);
    let prompt: string;

    if (kind === 'setup') {
      const template = source?.setupPrompt ?? '';

      if (template === '') {
        this.fail(item, kind, `sources.${ticket.source}.setupPrompt is not set.`);
        return;
      }

      const rendered = renderTaskPrompt(template, values);

      if ('error' in rendered) {
        this.fail(item, kind, `sources.${ticket.source}.setupPrompt: ${rendered.error}`);
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
        this.fail(item, 'task', `Playbook ${playbook.name}: ${rendered.error}`);
        return;
      }

      prompt = rendered.text;
    }

    const reports = sessionReports(kind, approved, playbook);
    const full = sessionPrompt(prompt, id, this.context.report, reports);

    if (kind === 'task' && playbook !== null) {
      this.store.updateWorkItem(item.id, { taskPrompt: full });
    }
    const label = kind === 'task' ? (item.playbook ?? 'ad-hoc') : kind;
    const own = kind === 'task' ? playbook : null;

    this.store.insertSession({
      id,
      workItemId: item.id,
      kind,
      provider: 'claude',
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
      reports,
    });
    // An approved prompt is kept, so a Retry of a failed or blocked approval session runs it again.
    this.setStatus(item.id, { status: kind === 'task' ? 'running' : 'setup', queuedAt: null, error: null, failedStep: null });
    this.actions.push({
      type: 'start-session',
      sessionId: id,
      workItemId: item.id,
      kind,
      cwd,
      prompt: full,
      name: `switchboard · ${label} · ${ticket.source} ${ticket.sourceKey}`,
      permissionMode: own?.permissionMode ?? sessions.permissionMode,
      model: own?.model ?? (sessions.model || null),
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
