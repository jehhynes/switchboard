import type { Playbook } from './playbook.js';
import type { PermissionMode, Settings } from './settings.js';
import type { FailedStep, Immediacy, Session, SessionKind, SessionState, Severity, Ticket, WorkItem } from './model.js';
import type { Store } from './store.js';
import { renderTaskPrompt, sessionPrompt } from './template.js';

export const ADHOC_SOURCE = 'adhoc';

const EMPTY_TRIAGE = { context: null, playbook: null, summary: null, immediacy: null, severity: null, model: null } as const;

export const MESSAGES = {
  unassigned: 'The ticket left the assigned state without a done report.',
  stopped: 'Stopped by you.',
  setupWithoutWorktree: 'Setup ended without a worktree.',
  turnEnded: 'The turn ended without a done report.',
  sessionEnded: 'The session ended without a done report.',
  noTaskPlaybooks: 'No task playbooks to choose from.',
  pickEnded: 'The pick session ended without a done report.',
} as const;

/** One ticket from a complete poll. A ticket of the source missing from the poll is not in the assigned state. */
export interface PolledTicket {
  sourceKey: string;
  sourceId: string | null;
  title: string;
  url: string;
  assigned: boolean;
  /** Unclaimed in a queue the operator works, so they may pick it (PRD R47). Never true with `assigned`. */
  pool: boolean;
  /** When the customer has waited since, such as Zoho's `customerResponseTime`; it orders the pool (PRD R27). */
  sortAt: number | null;
}

export type Report =
  | { kind: 'stage'; stage: string }
  | { kind: 'worktree'; path: string; branch: string | null }
  | { kind: 'done'; summary: string | null }
  | { kind: 'blocked'; reason: string }
  | { kind: 'approval'; prompt: string; summary: string | null }
  | { kind: 'link'; label: string; target: string };

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
      summary: string;
      immediacy: Immediacy | null;
      severity: Severity | null;
      model: string | null;
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
  | { type: 'pick' | 'retriage-pool' | 'icebox' | 'restore'; ticketId: number }
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

const TURN_ENDED: readonly SessionState[] = ['idle', 'failed'];

/** Decides what one event changes and which actions the hub runs. Call it inside one store transaction. */
export function handle(store: Store, event: FlowEvent, context: FlowContext): FlowResult {
  const flow = new Flow(store, context);

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
      case 'icebox':
      case 'restore':
        return this.icebox(event.ticketId, event.type === 'icebox');
    }
  }

  // Sources

  private poll(source: string, polled: PolledTicket[]): void {
    const seen = new Set<string>();

    for (const entry of polled) {
      seen.add(entry.sourceKey);

      const known = this.store.findTicket(source, entry.sourceKey);
      const fields = { sourceId: entry.sourceId, title: entry.title, url: entry.url, assigned: entry.assigned, pool: entry.pool, sortAt: entry.sortAt, lastPolledAt: this.now };

      if (known === null) {
        const ticket = this.store.insertTicket({ source, sourceKey: entry.sourceKey, repoRoot: '', iceboxed: false, ...fields });

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
        this.store.updateTicket(ticket.id, { assigned: false, pool: false, lastPolledAt: this.now });

        if (ticket.pool) {
          this.leftPool(ticket.id);
        }

        if (ticket.assigned) {
          this.left(ticket.id);
        }
      }
    }
  }

  /** A ticket that entered the assigned state gets a work item, unless it already has an open one, such as a pick's (PRD R48). */
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
      needsPick: false,
      approvalPrompt: null,
      approvalSummary: null,
      createdAt: this.now,
      doneAt: null,
      doneReason: null,
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
        this.done(item, 'unassigned', MESSAGES.unassigned);
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
    const title = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';

    if (title === '') {
      throw new Refusal('The prompt is empty.');
    }

    if (repoRoot === '') {
      throw new Refusal('Choose a repo for the prompt.');
    }

    const keys = this.store.tickets(ADHOC_SOURCE).map((ticket) => Number(ticket.sourceKey));
    const sourceKey = String(Math.max(0, ...keys) + 1);
    const ticket = this.store.insertTicket({ source: ADHOC_SOURCE, sourceKey, sourceId: null, title, url: '', assigned: true, pool: false, iceboxed: false, sortAt: null, lastPolledAt: null, repoRoot });
    const item = this.store.insertWorkItem({
      ticketId: ticket.id,
      playbook: null,
      status: 'queued',
      stage: null,
      stageAt: null,
      taskPrompt: prompt,
      warning: null,
      error: null,
      failedStep: null,
      unassignedAt: null,
      queuedAt: this.now,
      needsPick: false,
      approvalPrompt: null,
      approvalSummary: null,
      createdAt: this.now,
      doneAt: null,
      doneReason: null,
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
      summary: event.summary,
      immediacy: event.immediacy,
      severity: event.severity,
      model: event.model,
    });

    const item = triage.workItemId === null ? null : this.store.workItem(triage.workItemId)!;

    if (item?.status !== 'triaging') {
      return;
    }

    this.store.updateWorkItem(item.id, { playbook: playbook.name, taskPrompt: null, error: null, failedStep: null });

    if (playbook.autoStart || this.picked(item)) {
      this.queue(item);
    } else {
      this.store.updateWorkItem(item.id, { status: 'unstarted' });
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

    const triage = this.store.insertTriage({ ...EMPTY_TRIAGE, ticketId: ticket.id, workItemId: item?.id ?? null, startedAt: this.now, endedAt: null, error: null });

    this.actions.push({
      type: 'triage',
      triageId: triage.id,
      workItemId: item?.id ?? null,
      ticket,
      systemPrompt: playbook.template,
      choices,
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
      this.done(item, 'unassigned', MESSAGES.unassigned);
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

    if (item !== null && current.kind === 'pick' && resumed && item.status === 'blocked') {
      // The operator resumed a blocked pick; its done report and end can still advance the work item.
      this.store.updateSession(session.id, { outcome: null, outcomeDetail: null });
      this.store.updateWorkItem(item.id, { status: 'setup', error: null, failedStep: null });
      return;
    }

    if (item === null || current.kind !== 'task') {
      return;
    }

    if (TURN_ENDED.includes(state) && current.outcome === null && item.status === 'running') {
      if (item.unassignedAt !== null) {
        this.done(item, 'unassigned', MESSAGES.unassigned);
      } else {
        this.block(item, state === 'failed' ? `The turn failed: ${detail ?? 'unknown error'}.` : MESSAGES.turnEnded);
      }
    } else if (resumed && item.status === 'blocked') {
      this.store.updateSession(session.id, { outcome: null, outcomeDetail: null });
      this.store.updateWorkItem(item.id, { status: 'running', error: null, failedStep: null });
    }
  }

  /** The session's process is gone: decide setup, or settle a task that never reported. */
  private ended(session: Session): void {
    const item = this.latest(session);

    if (item === null) {
      return;
    }

    if (session.kind === 'pick') {
      if (item.status !== 'setup') {
        return;
      }

      if (session.outcome === 'done') {
        this.afterPick(item);
      } else {
        this.block(item, session.outcomeDetail ?? MESSAGES.pickEnded, 'pick');
      }

      return;
    }

    if (session.kind === 'setup') {
      if (item.status !== 'setup') {
        return;
      }

      if (item.unassignedAt !== null) {
        this.done(item, 'unassigned', MESSAGES.unassigned);
      } else if (session.outcome === 'blocked') {
        this.fail(item, 'setup', `Setup blocked: ${session.outcomeDetail ?? ''}`);
      } else if (this.store.worktreeFor(item.ticketId) === null) {
        this.fail(item, 'setup', MESSAGES.setupWithoutWorktree);
      } else {
        this.store.updateSession(session.id, { outcome: 'done' });

        // An iceboxed ticket's task waits in the queue until it is restored (PRD R49).
        if (this.store.ticket(item.ticketId)!.iceboxed) {
          this.queue(item);
        } else {
          this.startSession(item);
        }
      }

      return;
    }

    if (session.outcome === 'done') {
      return;
    }

    if (item.unassignedAt !== null) {
      this.done(item, 'unassigned', MESSAGES.unassigned);
    } else if (item.status === 'running') {
      this.block(item, MESSAGES.sessionEnded);
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
        this.store.updateSession(sessionId, { outcome: 'done', outcomeDetail: report.summary });

        if (item !== null && session.kind === 'task') {
          this.done(item, 'session', null);
        }

        return;
      case 'blocked':
        this.store.updateSession(sessionId, { outcome: 'blocked', outcomeDetail: report.reason });

        if (item !== null && session.kind === 'task') {
          if (item.unassignedAt !== null) {
            this.done(item, 'unassigned', MESSAGES.unassigned);
          } else {
            this.block(item, report.reason);
          }
        } else if (item !== null && session.kind === 'pick') {
          this.block(item, report.reason, 'pick');
        }

        return;
      case 'approval':
        // The work is ready; Approve starts a new task session with the prompt that publishes it (PRD R23, R31).
        if (item !== null && session.kind === 'task') {
          this.store.updateWorkItem(item.id, { status: 'awaiting-approval', approvalPrompt: report.prompt, approvalSummary: report.summary, error: null, failedStep: null });
        }

        return;
      case 'link':
        // Links belong to the ticket, so a returned ticket keeps them (PRD R52).
        this.store.addLink({ ticketId: this.store.workItem(session.workItemId)!.ticketId, label: report.label, target: report.target, reportedAt: this.now });
        return;
    }
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
      this.done(item, 'unassigned', MESSAGES.unassigned);
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

  /** PRD R49: local only; an iceboxed ticket gets no automatic triage or start. */
  private icebox(ticketId: number, iceboxed: boolean): void {
    const ticket = this.store.ticket(ticketId);

    if (ticket === null) {
      throw new Refusal(`Unknown ticket ${ticketId}.`);
    }

    this.store.updateTicket(ticket.id, { iceboxed });
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

  /** PRD R48: a work item that reuses the pool triage, and a pick session to claim the ticket. */
  private pick(ticket: Ticket): void {
    const triages = this.store.poolTriages(ticket.id);
    const triaged = triages.filter((triage) => triage.summary !== null).at(-1);
    const item = this.store.insertWorkItem({
      ticketId: ticket.id,
      playbook: triaged?.playbook ?? null,
      status: 'queued',
      stage: null,
      stageAt: null,
      taskPrompt: null,
      warning: null,
      error: null,
      failedStep: null,
      unassignedAt: null,
      queuedAt: this.now,
      needsPick: true,
      approvalPrompt: null,
      approvalSummary: null,
      createdAt: this.now,
      doneAt: null,
      doneReason: null,
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

  /** After the claim the task starts as the operator's start, because the pick is their approval; without a pool triage result it is triaged first (PRD R48). */
  private afterPick(item: WorkItem): void {
    const playbook = item.playbook === null ? undefined : this.context.playbooks.get(item.playbook);

    this.store.updateWorkItem(item.id, { needsPick: false });

    if (playbook === undefined) {
      this.store.updateWorkItem(item.id, { status: 'triaging', error: null, failedStep: null });
    } else {
      this.queue(item);
    }
  }

  private picked(item: WorkItem): boolean {
    return this.store.sessionsFor(item.id).some((session) => session.kind === 'pick' && session.outcome === 'done');
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
      this.store.updateWorkItem(item.id, { status: 'triaging', error: null, failedStep: null });
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

    this.store.updateWorkItem(item.id, { status: 'triaging', error: null, failedStep: null, queuedAt: null, approvalPrompt: null, approvalSummary: null });
  }

  private requireNoSession(item: WorkItem): void {
    if (this.activeSession(item) !== null) {
      throw new Refusal('The work item has an active session.');
    }
  }

  // Status changes

  private queue(item: WorkItem): void {
    this.store.updateWorkItem(item.id, { status: 'queued', queuedAt: this.now, error: null, failedStep: null });
  }

  private done(item: WorkItem, reason: 'session' | 'operator' | 'unassigned', warning: string | null): void {
    this.store.updateWorkItem(item.id, { status: 'done', doneAt: this.now, doneReason: reason, warning, queuedAt: null });
  }

  private fail(item: WorkItem, step: 'triage' | SessionKind, cause: string): void {
    this.store.updateWorkItem(item.id, { status: 'failed', failedStep: step, error: cause, queuedAt: null });
  }

  private block(item: WorkItem, cause: string, step: FailedStep = 'task'): void {
    this.store.updateWorkItem(item.id, { status: 'blocked', failedStep: step, error: cause });
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

      if (!busy.has(item.id) && !ticket.iceboxed) {
        start(ticket, item);
      }
    }

    for (const ticket of this.store.poolTickets()) {
      if (free <= 0) {
        return;
      }

      if (!ticket.iceboxed && this.store.poolTriages(ticket.id).length === 0 && !this.hasOpenWorkItem(ticket.id)) {
        start(ticket, null);
      }
    }
  }

  private hasOpenWorkItem(ticketId: number): boolean {
    return this.store.workItemsForTicket(ticketId).some((item) => item.status !== 'done');
  }

  /** Starts queued work items in order while slots are free, skipping a ticket that already has an active session (PRD R17, R38). */
  private scheduleStarts(): void {
    const queued = this.store.workItemsWithStatus('queued').sort((a, b) => a.queuedAt! - b.queuedAt! || a.id - b.id);

    for (const item of queued) {
      if (this.store.activeSessions().length >= this.context.settings.sessions.concurrency) {
        return;
      }

      if (this.store.activeSessionsForTicket(item.ticketId).length === 0 && !this.store.ticket(item.ticketId)!.iceboxed) {
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

    if (item.playbook !== null && playbook === null && !item.needsPick) {
      this.fail(item, 'task', `Playbook ${item.playbook} is not loaded.`);
      return;
    }

    const worktree = this.store.worktreeFor(ticket.id);
    const repoRoot = ticket.repoRoot || source?.repoRoot || '';
    const approved = item.approvalPrompt !== null;
    const kind: SessionKind = item.needsPick ? 'pick' : !approved && playbook?.requiresWorktree === true && worktree === null ? 'setup' : 'task';
    // A pick runs the source's claim skill, which belongs to the source's repo (PRD R48).
    const cwd = kind === 'pick' || playbook?.workdir === 'repoRoot' ? repoRoot : (worktree?.path ?? repoRoot);

    if (cwd === '') {
      this.fail(item, kind, `sources.${ticket.source}.repoRoot is not set.`);
      return;
    }

    const id = this.context.newSessionId();
    const values = this.values(ticket, item);
    let prompt: string;

    if (kind === 'setup' || kind === 'pick') {
      const key = kind === 'setup' ? 'setupPrompt' : 'pickPrompt';
      const template = source?.[key] ?? '';

      if (template === '') {
        this.fail(item, kind, `sources.${ticket.source}.${key} is not set.`);
        return;
      }

      const rendered = renderTaskPrompt(template, values);

      if ('error' in rendered) {
        this.fail(item, kind, `sources.${ticket.source}.${key}: ${rendered.error}`);
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

    const full = sessionPrompt(prompt, id, this.context.report);

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
    });
    // An approved prompt is kept, so a Retry of a failed or blocked approval session runs it again.
    this.store.updateWorkItem(item.id, { status: kind === 'task' ? 'running' : 'setup', queuedAt: null, error: null, failedStep: null });
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

  private values(ticket: Ticket, item: WorkItem): Record<string, string> {
    const triage = this.store.triagesFor(item.id).filter((entry) => entry.summary !== null).at(-1);

    return {
      'ticket.source': ticket.source,
      'ticket.sourceKey': ticket.sourceKey,
      'ticket.title': ticket.title,
      'ticket.url': ticket.url,
      'ticket.context': triage?.context ?? '',
      'triage.summary': triage?.summary ?? '',
      report: this.context.report,
    };
  }

}
