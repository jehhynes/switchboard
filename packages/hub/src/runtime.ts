import { mkdirSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { classify, entryFor, installHooks, jobStatePath, markerState, observe, readJobQuestion, readMarkers, readRoster, replyToSession, startSession, stopSession } from '@switchboard/claude';
import type { Exec, JobQuestion, Marker, ServiceDeps } from '@switchboard/claude';
import type { FlowAction, FlowEvent, FlowResult, Link, Paste, PolledTicket, QueueWait, Session, Source, SourceSettings, Store, Ticket, Triage, WorkItem, Worktree } from '@switchboard/core';
import { ADHOC_SOURCE, handle, heldSlots, queueWaits, recordRefusal, repoRoots, switchboardHome } from '@switchboard/core';
import type { Config } from './config.js';
import { listWorktrees, reportedWorktree } from './git.js';

export const ROSTER_MS = 30_000;
export const MARKER_MS = 5_000;
/** How long a marker change waits for the hook's other writes before the hub reads the markers. */
export const MARKER_SETTLE_MS = 50;
/** How long the hub waits to watch the activity folder again after the watch failed or the folder was removed. */
export const MARKER_WATCH_RETRY_MS = 1_000;
/** How often a tick ends snoozes whose wake time has passed (PRD R49). */
export const WAKE_MS = 60_000;
/** The roster, marker and wake timers `start` sets before the poll timers. */
const FIXED_TIMERS = 3;
/** How long the panel lists done work items. */
export const DONE_DAYS = 7;
/** How long a pending open waits for a window on its folder. */
export const OPEN_CLAIM_MS = 2 * 60_000;
/** How long a done report waits for the source read that checks its ticket (PRD R10). */
export const DONE_CHECK_MS = 6_000;
/** The job state can be written after the waiting marker, so the panel reads the question again this long after a session starts waiting (PRD R70). */
export const QUESTION_READ_MS = 1_000;

export interface RuntimeDeps {
  /** The operator's home; the Switchboard home is `<home>/.switchboard`. */
  home: string;
  /** The folder holding settings.json and playbooks/. */
  configDir: string;
  store: Store;
  exec: Exec;
  claudePath: string;
  /** Builds a polling source from its settings, or says why it cannot. Null for a source Switchboard does not know. */
  makeSource(name: string, settings: SourceSettings): { source: Source } | { error: string } | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  newSessionId(): string;
  /** Claude's settings.json, from the operator's profile even when the Switchboard home is overridden; its folder holds the job states. */
  claudeSettings: string;
  /** Reaches Claude's background service, which answers a session's question (PRD R70). */
  service: ServiceDeps;
  log(line: string): void;
}

export interface WorkItemView extends WorkItem {
  ticket: Ticket;
  triage: Triage | null;
  sessions: Session[];
  worktree: Worktree | null;
  links: Link[];
  /** Drafted texts the operator copies into the source (PRD R60). */
  pastes: Paste[];
  /** Earlier started work items for the same ticket; above 0 the panel marks the work item Returned (PRD R51). */
  returned: number;
  /** The ticket of the work item whose session reported this one as a task (PRD R68). */
  parent: Ticket | null;
  /** The playbook's `approvalSends`: Approve sends the work (PRD R27). */
  approvalSends: boolean;
  /** What keeps a queued work item from starting; empty for every other status (PRD R34). */
  waits: QueueWait[];
  /**
   * The question the active session waits on in its background process, from Claude's job state: the first part's text and options, and
   * how many parts the call has. Null when the job state holds none (PRD R70).
   */
  question: { text: string; options: JobQuestion['options']; parts: number } | null;
}

/** A pool ticket the operator may pick, with its pool triage (PRD R47). */
export interface PoolView {
  ticket: Ticket;
  triage: Triage | null;
  /** The ticket's links, such as a GitHub issue its thread names (PRD R52, R61). */
  links: Link[];
  /** Started done work items for the ticket; above 0 the panel marks it Returned (PRD R51). */
  returned: number;
}

/** Everything the panel shows, sent whole on each change. */
export interface Snapshot {
  workItems: WorkItemView[];
  /** Oldest first by the source's sort time; the panel orders it with the unstarted work items (PRD R27). */
  pool: PoolView[];
  playbooks: { name: string; description: string }[];
  /** Repos an ad-hoc prompt can run in: each source's repo root, the first being the default. */
  repoRoots: string[];
  /** Sources being polled. */
  sources: string[];
  /** Every configured source but ad-hoc, for the operator's source filter. */
  sourceStates: { name: string; enabled: boolean }[];
  /** Each configured source's playbook namespace, which names a triage in progress, such as `dev:triage`. */
  namespaces: Record<string, string>;
  /** The folder holding settings.json and playbooks/. */
  configDir: string;
  errors: { settings: string | null; playbooks: string[]; hooks: string | null; sources: Record<string, string> };
}

export type ReportBody =
  | { sessionId: string; kind: 'stage'; stage: string }
  | { sessionId: string; kind: 'worktree'; path: string }
  | { sessionId: string; kind: 'done' }
  | { sessionId: string; kind: 'approval'; prompt: string; summary: string | null; report: string | null }
  | { sessionId: string; kind: 'link'; label: string; target: string }
  | { sessionId: string; kind: 'playbook'; playbook: string }
  | { sessionId: string; kind: 'paste'; label: string; file: string }
  | { sessionId: string; kind: 'task'; prompt: string; repo: string | null; title: string | null };

/** Runs the core: turns timers, source reads, CLI results and requests into events, and runs the actions they decide. */
export class Runtime {
  private config: Config;
  private sources = new Map<string, Source>();
  private sourceErrors: Record<string, string> = {};
  private hookError: string | null = null;
  private pending = new Set<Promise<void>>();
  private listeners = new Set<() => void>();
  /** The roster, marker and wake timers, then one poll timer per source; `restartPolls` replaces the poll timers. */
  private timers: NodeJS.Timeout[] = [];
  private markerWatcher: FSWatcher | null = null;
  private markerRead: NodeJS.Timeout | null = null;
  private markerWatchRetry: NodeJS.Timeout | null = null;
  private markerWatchFailed = false;
  /** The marker time last checked per ended session, so each marker an ended session writes reads the roster once. */
  private markerSeen = new Map<string, number>();
  /** The roster read in flight; reads run one at a time, so an older result never overwrites a newer one. */
  private rosterRead: Promise<void> | null = null;
  /** A read was asked for while one ran, so it runs again once that read finishes. */
  private rosterAgain = false;
  /** The read in flight per source; reads run one at a time, so their results apply in order. */
  private reads = new Map<string, Promise<void>>();
  private pendingOpens = new Map<string, { sessionId: string; at: number }>();
  /** Job state reads by short ID, kept while the file's modification time is unchanged. */
  private questions = new Map<string, { mtimeMs: number; question: WorkItemView['question'] }>();
  /** The job state's modification time when the hub sent an answer, by short ID, so a question is answered once (PRD R70). */
  private answered = new Map<string, number>();
  /** Background sessions waiting on the operator by short ID, each with the timer that reads its question again. */
  private waitingReads = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deps: RuntimeDeps,
    config: Config,
  ) {
    this.config = config;
    this.buildSources();
  }

  get home(): string {
    return switchboardHome(this.deps.home);
  }

  /** The report command prefix sessions run (architecture.md § Session reports). */
  get reportCommand(): string {
    return `node "${this.home.replaceAll('\\', '/')}/hub.js" report`;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  /** Applies one event in one transaction and starts its actions. */
  send(event: FlowEvent): FlowResult {
    const { settings, playbooks } = this.config;
    const result = this.deps.store.transaction(() =>
      handle(this.deps.store, event, { now: this.deps.now(), settings, playbooks, report: this.reportCommand, newSessionId: this.deps.newSessionId }),
    );

    for (const action of result.actions) {
      this.track(this.run(action));
    }

    this.watchQuestions();
    this.changed();

    return result;
  }

  /** Sends the snapshot again `QUESTION_READ_MS` after a background session starts waiting, so its question shows without another event. */
  private watchQuestions(): void {
    const waiting = new Set(this.deps.store.activeSessions().flatMap((session) => (waitsInBackground(session) ? [session.shortId] : [])));

    for (const [id, timer] of this.waitingReads) {
      if (!waiting.has(id)) {
        clearTimeout(timer);
        this.waitingReads.delete(id);
        this.questions.delete(id);
        this.answered.delete(id);
      }
    }

    for (const id of waiting) {
      if (!this.waitingReads.has(id)) {
        const timer = setTimeout(() => this.changed(), QUESTION_READ_MS);

        timer.unref();
        this.waitingReads.set(id, timer);
      }
    }
  }

  /**
   * Sends an answer only while the job state still shows the question the row showed, and once per question, because the service
   * takes a reply to a session no longer waiting as its next prompt (PRD R70, mechanics M24).
   */
  answer(event: Extract<FlowEvent, { type: 'answer' }>): FlowResult {
    const store = this.deps.store;
    const session = store.sessionsFor(event.workItemId).find((entry) => entry.state !== 'ended') ?? null;

    if (session === null || !waitsInBackground(session) || session.nativeSessionId !== event.nativeSessionId) {
      return this.send(event);
    }

    const question = this.questionOf(session);
    const mtimeMs = this.questions.get(session.shortId)?.mtimeMs;
    // A reply answers only the first part of a question with several and loses the rest (mechanics M24).
    const refused =
      question?.text !== event.question
        ? 'The session no longer waits on that question.'
        : question.parts !== 1
          ? 'The question has several parts; answer it with Open in Claude.'
          : this.answered.get(session.shortId) === mtimeMs
            ? 'The answer to that question was already sent.'
            : null;

    if (refused !== null) {
      store.transaction(() => recordRefusal(store, event, this.deps.now(), refused));
      this.changed();

      return { actions: [], refused };
    }

    const result = this.send(event);

    if (result.refused === null && mtimeMs !== undefined) {
      this.answered.set(session.shortId, mtimeMs);
    }

    return result;
  }

  /** The question a background session waits on, read again only when its job state changed (PRD R70). */
  private questionOf(session: Session | null): WorkItemView['question'] {
    if (session === null || !waitsInBackground(session)) {
      return null;
    }

    const configDir = dirname(this.deps.claudeSettings);
    let mtimeMs: number;

    try {
      const stat = statSync(jobStatePath(configDir, session.shortId), { throwIfNoEntry: false });

      if (stat === undefined) {
        return null;
      }

      mtimeMs = stat.mtimeMs;
    } catch {
      return null;
    }

    const cached = this.questions.get(session.shortId);

    if (cached?.mtimeMs === mtimeMs) {
      return cached.question;
    }

    const read = readJobQuestion(configDir, session.shortId);
    const question = read === null ? null : { text: read.questions[0]!.question, options: read.questions[0]!.options, parts: read.questions.length };

    this.questions.set(session.shortId, { mtimeMs, question });

    return question;
  }

  /** Resolves when every action started so far, and the events they caused, have finished. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  reload(config: Config): void {
    this.config = config;
    this.buildSources();
    this.restartPolls();
    this.send({ type: 'tick' });
  }

  /** Startup reconciliation (PRD R43): triage the hub abandoned runs again, and a start it abandoned fails. */
  async startup(): Promise<void> {
    if (this.config.settings.sessions.installHooks) {
      try {
        this.hookError = installHooks(this.home, this.deps.claudeSettings);
      } catch (error) {
        this.hookError = `Switchboard could not add its hooks to ${this.deps.claudeSettings}: ${(error as Error).message}`;
      }
    }

    for (const triage of this.deps.store.runningTriages()) {
      this.send({ type: 'triage-cancelled', triageId: triage.id });
    }

    for (const session of this.deps.store.activeSessions().filter((entry) => entry.state === 'starting')) {
      this.send({ type: 'session-start-failed', sessionId: session.id, message: 'The hub stopped while the session was starting.' });
    }

    await this.readRoster();
  }

  start(): void {
    this.timers.push(setInterval(() => void this.readRoster(), ROSTER_MS), setInterval(() => this.readMarkers(), MARKER_MS), setInterval(() => this.send({ type: 'tick' }), WAKE_MS));
    this.watchMarkers();
    this.restartPolls();
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) {
      clearInterval(timer);
    }

    for (const timer of this.waitingReads.values()) {
      clearTimeout(timer);
    }

    this.waitingReads.clear();

    this.markerWatcher?.close();
    this.markerWatcher = null;
    clearTimeout(this.markerRead ?? undefined);
    this.markerRead = null;
    clearTimeout(this.markerWatchRetry ?? undefined);
    this.markerWatchRetry = null;
  }

  /** Reads the markers soon after a hook writes one; the `MARKER_MS` timer stays as a fallback. */
  private watchMarkers(): void {
    const dir = join(this.home, 'activity');
    const rearm = (reason: string) => {
      this.markerWatcher?.close();
      this.markerWatcher = null;

      if (!this.markerWatchFailed) {
        this.deps.log(`marker watch stopped: ${reason}`);
        this.markerWatchFailed = true;
      }

      // `stop` clears the timers; a watcher that fails after it is not re-armed.
      if (this.timers.length > 0 && this.markerWatchRetry === null) {
        this.markerWatchRetry = setTimeout(() => {
          this.markerWatchRetry = null;
          this.watchMarkers();
        }, MARKER_WATCH_RETRY_MS);
      }
    };

    // Windows keeps firing on a removed folder without an error, and a watch does not follow a folder made again at the same path.
    const folderId = () => statSync(dir, { bigint: true, throwIfNoEntry: false })?.ino ?? null;

    try {
      mkdirSync(dir, { recursive: true });
      const id = folderId();
      const watcher = watch(dir, () => {
        if (watcher !== this.markerWatcher) {
          return;
        }

        try {
          if (folderId() !== id) {
            rearm('the activity folder was removed or replaced');
            return;
          }
        } catch (error) {
          rearm((error as Error).message);
          return;
        }

        this.markerRead ??= setTimeout(() => {
          this.markerRead = null;
          this.readMarkers();
        }, MARKER_SETTLE_MS);
      });
      watcher.on('error', (error) => watcher === this.markerWatcher && rearm(error.message));
      this.markerWatcher = watcher;
      this.markerWatchFailed = false;
    } catch (error) {
      rearm((error as Error).message);
    }
  }

  /** True while any session may be running, so the hub stays up for its reports (PRD R43). */
  hasActiveSessions(): boolean {
    return this.deps.store.activeSessions().length > 0;
  }

  async pollSource(name: string): Promise<void> {
    const source = this.sources.get(name);

    if (source === undefined || this.reads.has(name)) {
      return;
    }

    await this.readAfter(name, source);
  }

  /** Reads the source once any read in flight has finished. */
  private readAfter(name: string, source: Source): Promise<PolledTicket[] | null> {
    const read = (this.reads.get(name) ?? Promise.resolve()).then(() => this.read(name, source));
    const settled: Promise<void> = read.then(
      () => undefined,
      () => undefined,
    );

    this.reads.set(name, settled);
    void settled.then(() => {
      if (this.reads.get(name) === settled) {
        this.reads.delete(name);
      }
    });

    return read;
  }

  /** Polls the source and applies the result; null when the read failed. */
  private async read(name: string, source: Source): Promise<PolledTicket[] | null> {
    const result = await source.poll();

    if ('error' in result) {
      this.sourceErrors[name] = result.error;
      this.send({ type: 'poll-failed', source: name, error: result.error });
      return null;
    }

    delete this.sourceErrors[name];
    this.send({ type: 'poll', source: name, tickets: result.tickets });
    await this.findWorktrees(name, source);

    return result.tickets;
  }

  /**
   * Whether a fresh read lists a task session's ticket as assigned when it reports done (PRD R10). False when the read fails or takes
   * longer than DONE_CHECK_MS, which keeps the reply inside the report CLI's 10-second timeout.
   */
  private async stillAssigned(sessionId: string): Promise<boolean> {
    const store = this.deps.store;
    const session = store.session(sessionId);
    const item = session === null ? null : store.workItem(session.workItemId);

    if (session?.kind !== 'task' || item === null || item.status === 'done') {
      return false;
    }

    const ticket = store.ticket(item.ticketId)!;
    const source = this.sources.get(ticket.source);

    if (source === undefined) {
      return false;
    }

    const tickets = await Promise.race([this.readAfter(ticket.source, source).catch(() => null), this.deps.sleep(DONE_CHECK_MS).then(() => 'late' as const)]);

    if (tickets === 'late') {
      this.deps.log(`done report for ${ticket.ref} accepted unchecked: the ${ticket.source} read took over ${DONE_CHECK_MS / 1000} seconds`);
      return false;
    }

    return tickets?.some((entry) => entry.sourceKey === ticket.sourceKey && entry.assigned) ?? false;
  }

  /** Reads the roster and hook markers; a failed read changes nothing. */
  /** Reads the roster, or joins the read in flight and repeats it once that read finishes, because it may predate the request. */
  readRoster(): Promise<void> {
    if (this.rosterRead !== null) {
      this.rosterAgain = true;
      return this.rosterRead;
    }

    this.rosterRead = (async () => {
      do {
        this.rosterAgain = false;
        await this.readRosterOnce();
      } while (this.rosterAgain);
    })().finally(() => {
      this.rosterRead = null;
    });

    return this.rosterRead;
  }

  private async readRosterOnce(): Promise<void> {
    const sessions = this.deps.store.startedSessions();

    if (sessions.length === 0) {
      return;
    }

    const roster = await readRoster(this.deps.claudePath, this.deps.exec);

    if ('error' in roster) {
      this.deps.log(`roster read failed: ${roster.error}`);
      return;
    }

    await this.findSetupWorktrees();
    this.send({ type: 'roster', sessions: observe(roster.entries, sessions, this.markers()), checked: sessions.map((session) => session.id) });
  }

  /** Hook markers, or none when hooks are off, so the roster alone decides state. */
  private markers(): Map<string, Marker> {
    return this.config.settings.sessions.installHooks ? readMarkers(this.home) : new Map();
  }

  /** Links a worktree a setup session created without reporting it, before its end decides the setup (PRD R25). */
  private async findSetupWorktrees(): Promise<void> {
    const store = this.deps.store;
    const names = new Set(
      store
        .activeSessions()
        .filter((session) => session.kind === 'setup')
        .map((session) => store.ticket(store.workItem(session.workItemId)!.ticketId)!.source),
    );

    for (const name of names) {
      const source = this.sources.get(name);

      if (source !== undefined) {
        await this.findWorktrees(name, source);
      }
    }
  }

  /** Sends a marker event for each live session whose marker shows another state. */
  readMarkers(): void {
    const markers = this.markers();
    // A new marker from an ended session can mean the operator resumed it, as in a VS Code tab; only the roster can revive it.
    const changed = this.deps.store.startedSessions().filter((session) => {
      const at = session.state === 'ended' && session.nativeSessionId !== null ? markers.get(session.nativeSessionId)?.at : undefined;

      if (at === undefined || this.markerSeen.get(session.nativeSessionId!) === at) {
        return false;
      }

      this.markerSeen.set(session.nativeSessionId!, at);

      return true;
    });

    if (changed.length > 0) {
      void this.readRoster();
    }

    for (const session of this.deps.store.activeSessions()) {
      const marker = session.nativeSessionId === null ? undefined : markers.get(session.nativeSessionId);
      const observed = marker === undefined ? null : markerState(marker);

      if (observed !== null && session.state !== 'starting' && (observed.state !== session.state || observed.detail !== session.stateDetail)) {
        this.send({ type: 'marker', sessionId: session.id, ...observed });
      }
    }
  }

  /**
   * Logs a report the hub refused before the flow saw it, such as a bad request or a worktree report naming no git worktree (PRD R59).
   * Only the report's kind and its short text fields are kept: never a prompt.
   */
  refuseReport(sessionId: string, fields: Record<string, unknown>, message: string): void {
    const kept = Object.fromEntries(['kind', 'stage', 'path', 'label', 'target', 'file', 'title'].filter((key) => typeof fields[key] === 'string').map((key) => [key, fields[key]]));
    const event = { type: 'report', sessionId, report: kept } as unknown as FlowEvent;

    this.deps.store.transaction(() => recordRefusal(this.deps.store, event, this.deps.now(), message));
    this.changed();
  }

  /** A report from the `report` command. A worktree must be one `git worktree list` shows in that path. */
  async report(body: ReportBody): Promise<{ refused: string | null }> {
    if (body.kind === 'worktree') {
      const worktree = await reportedWorktree(body.path, this.deps.exec);

      if (worktree === null) {
        const refused = `${body.path} is not a git worktree.`;

        this.refuseReport(body.sessionId, { kind: 'worktree', path: body.path }, refused);

        return { refused };
      }

      return { refused: this.send({ type: 'report', sessionId: body.sessionId, report: { kind: 'worktree', path: worktree.path, branch: worktree.branch } }).refused };
    }

    const report =
      body.kind === 'stage'
        ? { kind: body.kind, stage: body.stage }
        : body.kind === 'done'
          ? { kind: body.kind, assigned: await this.stillAssigned(body.sessionId) }
          : body.kind === 'approval'
            ? { kind: body.kind, prompt: body.prompt, summary: body.summary, report: body.report }
            : body.kind === 'playbook'
              ? { kind: body.kind, playbook: body.playbook }
              : body.kind === 'paste'
                ? { kind: body.kind, label: body.label, file: body.file }
                : body.kind === 'task'
                  ? { kind: body.kind, prompt: body.prompt, repo: body.repo, title: body.title }
                  : { kind: body.kind, label: body.label, target: body.target };

    return { refused: this.send({ type: 'report', sessionId: body.sessionId, report }).refused };
  }

  /** Records that a window asked to open a session in a window on `cwd`, which that window claims when it connects or gains focus. */
  recordOpen(sessionId: string, cwd: string): void {
    this.pendingOpens.set(folderKey(cwd), { sessionId, at: this.deps.now() });
  }

  /** The session a window on `folder` should open, if one is pending and recent. Claiming removes it. */
  claimOpen(folder: string): string | null {
    const key = folderKey(folder);
    const pending = this.pendingOpens.get(key);

    this.pendingOpens.delete(key);

    return pending !== undefined && this.deps.now() - pending.at <= OPEN_CLAIM_MS ? pending.sessionId : null;
  }

  snapshot(): Snapshot {
    const store = this.deps.store;
    const { settings, playbooks, settingsError, playbookErrors } = this.config;
    // Returned counts earlier work items with the same playbook that started a session; a failed launch has no shortId.
    const started = (item: WorkItem) => store.sessionsFor(item.id).some((session) => session.shortId !== null);
    const returned = (items: WorkItem[], playbook: string | null) =>
      playbook === null ? 0 : items.filter((item) => item.playbook === playbook && started(item)).length;
    const used = heldSlots(store);

    return {
      workItems: store.workItems(this.deps.now() - DONE_DAYS * 24 * 60 * 60 * 1000).map((item) => ({
        ...item,
        ticket: store.ticket(item.ticketId)!,
        triage: store.triagesFor(item.id).at(-1) ?? null,
        sessions: store.sessionsFor(item.id),
        worktree: store.worktreeFor(item.ticketId),
        links: store.linksFor(item.ticketId),
        pastes: store.pastesFor(item.id),
        returned: returned(store.workItemsForTicket(item.ticketId).filter((other) => other.id < item.id), item.playbook),
        parent: item.parentId === null ? null : store.ticket(store.workItem(item.parentId)!.ticketId),
        approvalSends: item.playbook !== null && playbooks.get(item.playbook)?.approvalSends === true,
        waits: item.status === 'queued' ? queueWaits(store, item, settings.sessions.concurrency, used) : [],
        question: item.status === 'done' ? null : this.questionOf(store.sessionsFor(item.id).find((session) => session.state !== 'ended') ?? null),
      })),
      pool: store
        .poolTickets()
        .map((ticket) => ({ ticket, items: store.workItemsForTicket(ticket.id) }))
        // A disabled source's pool is not read, so its tickets are not shown.
        .filter(({ ticket, items }) => this.sources.has(ticket.source) && items.every((item) => item.status === 'done'))
        .map(({ ticket, items }) => {
          const triage = store.poolTriages(ticket.id).at(-1) ?? null;

          return { ticket, triage, links: store.linksFor(ticket.id), returned: returned(items, triage?.playbook ?? null) };
        }),
      playbooks: [...playbooks.values()].filter((playbook) => playbook.kind === 'task').map(({ name, description }) => ({ name, description })),
      repoRoots: repoRoots(settings),
      sources: [...this.sources.keys()],
      sourceStates: Object.entries(settings.sources)
        .filter(([name]) => name !== ADHOC_SOURCE)
        .map(([name, source]) => ({ name, enabled: source.enabled })),
      namespaces: Object.fromEntries(Object.entries(settings.sources).map(([name, source]) => [name, source.namespace])),
      configDir: this.deps.configDir,
      errors: {
        settings: settingsError,
        playbooks: playbookErrors.map((entry) => `${entry.file}: ${entry.error}`),
        hooks: this.hookError,
        sources: { ...this.sourceErrors },
      },
    };
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => this.deps.log(`action failed: ${String(error)}`)).finally(() => this.pending.delete(tracked));

    this.pending.add(tracked);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private buildSources(): void {
    this.sources.clear();
    this.sourceErrors = {};

    for (const [name, settings] of Object.entries(this.config.settings.sources)) {
      if (!settings.enabled || name === ADHOC_SOURCE) {
        continue;
      }

      const made = this.deps.makeSource(name, settings);

      if (made === null) {
        this.sourceErrors[name] = `Switchboard has no source named ${name}.`;
      } else if ('error' in made) {
        this.sourceErrors[name] = made.error;
      } else {
        this.sources.set(name, made.source);
      }
    }
  }

  private restartPolls(): void {
    if (this.timers.length === 0) {
      return;
    }

    for (const timer of this.timers.splice(FIXED_TIMERS)) {
      clearInterval(timer);
    }

    for (const name of this.sources.keys()) {
      const seconds = this.config.settings.sources[name]!.pollIntervalSeconds;

      this.timers.push(setInterval(() => void this.pollSource(name), seconds * 1000));
      void this.pollSource(name);
    }
  }

  /** Links worktrees by branch name (PRD R25). */
  private async findWorktrees(name: string, source: Source): Promise<void> {
    const repoRoot = this.config.settings.sources[name]?.repoRoot ?? '';
    const worktrees = repoRoot === '' ? null : await listWorktrees(repoRoot, this.deps.exec);

    for (const worktree of worktrees ?? []) {
      const key = worktree.branch === null ? null : source.keyOfBranch(worktree.branch);

      if (key !== null && this.deps.store.findTicket(name, key) !== null) {
        this.send({ type: 'worktree-found', source: name, sourceKey: key, path: worktree.path, branch: worktree.branch! });
      }
    }
  }

  /** Whether the roster lists the session as Switchboard's background process. */
  private async isBackground(shortId: string): Promise<boolean> {
    const roster = await readRoster(this.deps.claudePath, this.deps.exec);

    return 'entries' in roster && entryFor(roster.entries, shortId)?.kind === 'background';
  }

  private async run(action: FlowAction): Promise<void> {
    switch (action.type) {
      case 'triage': {
        const source = this.sources.get(action.ticket.source);

        if (source === undefined) {
          this.send({ type: 'triage-failed', triageId: action.triageId, error: `The ${action.ticket.source} source is not enabled.`, context: null });
          return;
        }

        const context = await source.context(action.ticket);

        if ('error' in context) {
          this.send({ type: 'triage-failed', triageId: action.triageId, error: context.error, context: null });
          return;
        }

        if (context.warning !== undefined) {
          this.deps.log(`triage context for ${action.ticket.ref}: ${context.warning}`);
        }

        const text = triageText(context.context, this.deps.now());
        const result = await classify(
          { claudePath: this.deps.claudePath, systemPrompt: action.systemPrompt, choices: action.choices, rates: action.rates, context: text, model: action.model, timeoutSeconds: action.timeoutSeconds, cwd: this.home },
          this.deps.exec,
        );

        this.send(
          'error' in result
            ? { type: 'triage-failed', triageId: action.triageId, error: result.error, context: text }
            : {
                type: 'triage-succeeded',
                triageId: action.triageId,
                context: text,
                playbook: result.playbook,
                immediacy: result.immediacy,
                severity: result.severity,
                model: action.model,
                links: context.links ?? [],
              },
        );
        return;
      }
      case 'start-session': {
        const result = await startSession(this.deps.claudePath, action, { exec: this.deps.exec, sleep: this.deps.sleep, now: this.deps.now });

        this.send(
          'error' in result
            ? { type: 'session-start-failed', sessionId: action.sessionId, message: result.error }
            : { type: 'session-started', sessionId: action.sessionId, nativeSessionId: result.nativeSessionId, shortId: result.shortId },
        );
        return;
      }
      case 'stop-session': {
        if (action.reason === 'release' && action.shortId !== null && !(await this.isBackground(action.shortId))) {
          // The operator resumed it, such as in a VS Code tab; a release never stops their session (PRD R39).
          this.deps.log(`release skipped: session ${action.sessionId} is not a background process`);
          return;
        }

        const failure = action.shortId === null ? { error: 'The session has not started yet.' } : await stopSession(this.deps.claudePath, action.shortId, this.deps.exec);

        if (failure === null) {
          await this.findSetupWorktrees();
        }

        this.send(failure === null ? { type: 'stop-succeeded', sessionId: action.sessionId, reason: action.reason } : { type: 'stop-failed', sessionId: action.sessionId, reason: action.reason, message: failure.error });
        return;
      }
      case 'reply-session': {
        const failure = await replyToSession(dirname(this.deps.claudeSettings), action.shortId, action.text, this.deps.service);

        if (failure !== null) {
          this.answered.delete(action.shortId);
          this.send({ type: 'reply-failed', sessionId: action.sessionId, message: failure.error });
        }

        return;
      }
    }
  }
}

/** A session running in its background process and waiting on the operator; a released session that is active again runs elsewhere. */
function waitsInBackground(session: Session): session is Session & { shortId: string } {
  return session.state === 'waiting' && session.shortId !== null && !session.released;
}

function folderKey(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

/** The source's triage context led by the current UTC time, in the form sources use, so triage can judge how recent each event is. */
export function triageText(context: string, now: number): string {
  return `Current time: ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC\n\n${context}`;
}
