import { mkdirSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { classify, ClaudeRunner } from '@switchboard/claude';
import { CodexRunner } from '@switchboard/codex';
import type { Exec } from '@switchboard/claude';
import type { FlowAction, FlowEvent, FlowResult, Link, MarkerReading, ObservedSession, Paste, PolledTicket, Provider, QueueWait, Session, SessionRunner, Source, SourceSettings, Store, Ticket, Triage, WorkItem, Worktree } from '@switchboard/core';
import { activeSession, ADHOC_SOURCE, handle, heldSlots, PROVIDERS, queueWaits, recordRefusal, repoRoots, sessionContract, switchboardHome } from '@switchboard/core';
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
/** How long the dock lists done work items. */
export const DONE_DAYS = 7;
/** How long a done or link report waits for the source read that checks it (PRD R10, R52). */
export const REPORT_CHECK_MS = 6_000;

export interface RuntimeDeps {
  /** The operator's home; the Switchboard home is `<home>/.switchboard`. */
  home: string;
  /** The folder holding settings.json. */
  configDir: string;
  store: Store;
  exec: Exec;
  claudePath: string;
  /** Builds a polling source from its settings, or says why it cannot. Null for a source Switchboard does not know. */
  makeSource(name: string, settings: SourceSettings): { source: Source } | { error: string } | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  newSessionId(): string;
  /** Claude's settings.json, where the hooks are installed: the operator's profile's even when the Switchboard home is overridden. */
  claudeSettings: string;
  /** The Codex CLI, Codex's home (`CODEX_HOME` or `~/.codex`), and the variables Codex runs need; defaults for tests that run no Codex session. */
  codex?: { path: string; home: string; env: Record<string, string> };
  /** Stand-in runners for tests; each runner is built from the fields above otherwise. */
  runners?: Partial<Record<Provider, SessionRunner>>;
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
  /** Earlier started work items for the same ticket with the same playbook or one it is a return of; above 0 the dock marks the work item Returned (PRD R51). */
  returned: number;
  /** The ticket of the work item whose session reported this one as a task (PRD R68). */
  parent: Ticket | null;
  /** The playbook's `approvalSends`: Approve sends the work (PRD R27). */
  approvalSends: boolean;
  /** What keeps a queued work item from starting; empty for every other status (PRD R34). */
  waits: QueueWait[];
}

/** A pool ticket the operator may pick, with its pool triage (PRD R47). */
export interface PoolView {
  ticket: Ticket;
  triage: Triage | null;
  /** The ticket's links, such as a GitHub issue its thread names (PRD R52, R61). */
  links: Link[];
  /** Started done work items for the ticket with the latest triage's playbook or one it is a return of; above 0 the dock marks it Returned (PRD R51). */
  returned: number;
}

/** Everything a window and the dock show, sent whole on each change. */
export interface Snapshot {
  workItems: WorkItemView[];
  /** Oldest first by the source's sort time; the dock orders it with the unstarted work items (PRD R27). */
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
  /** The folder holding settings.json. */
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
  | { sessionId: string; kind: 'task'; prompt: string; repo: string | null; title: string | null }
  | { sessionId: string; kind: 'question'; text: string };

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
  /** Sessions a stopped hub left starting that a runner could not settle yet. */
  private unreconciled = new Set<string>();
  /** One runner per agent, chosen by each session's provider (PRD R22). */
  private readonly runners: Record<Provider, SessionRunner>;

  constructor(
    private readonly deps: RuntimeDeps,
    config: Config,
  ) {
    this.config = config;

    const hooks = () => this.config.settings.sessions.installHooks;
    const codex = deps.codex ?? { path: 'codex', home: join(deps.home, '.codex'), env: {} };

    this.runners = {
      claude:
        deps.runners?.claude ??
        new ClaudeRunner({ claudePath: deps.claudePath, exec: deps.exec, sleep: deps.sleep, now: deps.now, home: this.home, claudeSettings: deps.claudeSettings, hooks }),
      codex:
        deps.runners?.codex ??
        new CodexRunner({ codexPath: codex.path, exec: deps.exec, sleep: deps.sleep, now: deps.now, home: this.home, codexHome: codex.home, env: codex.env, hooks }),
    };
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

    this.changed();

    return result;
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

  /** The sources the operator turned on in the dock's header (PRD R3). */
  enabledSources(): Set<string> {
    return this.deps.store.enabledSources();
  }

  /** Turns a configured source on or off and starts or stops its polls; returns why it could not, or null. */
  setSourceEnabled(name: string, enabled: boolean): string | null {
    if (this.config.settings.sources[name] === undefined || name === ADHOC_SOURCE) {
      return `settings.json has no source named ${name}.`;
    }

    this.deps.store.setSourceEnabled(name, enabled);
    this.reload(this.config);
    return null;
  }

  /** Startup reconciliation (PRD R43): triage the hub abandoned runs again, and a start it abandoned fails. */
  async startup(): Promise<void> {
    if (this.config.settings.sessions.installHooks) {
      const errors = await Promise.all(PROVIDERS.map((provider) => this.runners[provider].installHooks()));

      this.hookError = errors.filter((error) => error !== null).join(' ') || null;
    }

    for (const triage of this.deps.store.runningTriages()) {
      this.send({ type: 'triage-cancelled', triageId: triage.id });
    }

    await this.reconcile(this.deps.store.activeSessions().filter((entry) => entry.state === 'starting'));

    await this.readRoster();
  }

  /** Settles sessions a stopped hub left starting; one the runner cannot tell about yet is asked about again at the next roster read. */
  private async reconcile(starting: Session[]): Promise<void> {
    for (const provider of PROVIDERS) {
      for (const result of await this.runners[provider].reconcile(starting.filter((session) => session.provider === provider))) {
        if ('pending' in result) {
          this.unreconciled.add(result.sessionId);
          this.deps.log(`session ${result.sessionId} left starting by the hub that stopped is not settled yet: ${result.pending}`);
          continue;
        }

        this.unreconciled.delete(result.sessionId);
        this.send(
          'failed' in result
            ? { type: 'session-start-failed', sessionId: result.sessionId, message: result.failed }
            : { type: 'session-started', sessionId: result.sessionId, ...result.started },
        );
      }
    }
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

    // The operator turned the source off while it was read; its result would show an error or tickets of a source that is off.
    if (!this.sources.has(name)) {
      return null;
    }

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
   * longer than REPORT_CHECK_MS, which keeps the reply inside the report CLI's 10-second timeout.
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

    const tickets = await Promise.race([this.readAfter(ticket.source, source).catch(() => null), this.deps.sleep(REPORT_CHECK_MS).then(() => 'late' as const)]);

    if (tickets === 'late') {
      this.deps.log(`done report for ${ticket.ref} accepted unchecked: the ${ticket.source} read took over ${REPORT_CHECK_MS / 1000} seconds`);
      return false;
    }

    return tickets?.some((entry) => entry.sourceKey === ticket.sourceKey && entry.assigned) ?? false;
  }

  /**
   * Why the ticket's source refuses a link the session reports, or null (PRD R52). A failed check, or one that takes longer than
   * REPORT_CHECK_MS, accepts the link, so a GitHub outage does not block a session.
   */
  private async linkRefusal(sessionId: string, target: string): Promise<string | null> {
    const store = this.deps.store;
    const session = store.session(sessionId);
    const ticket = session === null ? null : store.ticket(store.workItem(session.workItemId)!.ticketId)!;
    const source = ticket === null ? undefined : this.sources.get(ticket.source);

    if (ticket === null || source?.checkLink === undefined) {
      return null;
    }

    const check = await Promise.race([source.checkLink(ticket, target).catch(() => ({ error: 'the check failed' })), this.deps.sleep(REPORT_CHECK_MS).then(() => 'late' as const)]);

    if (check === 'late' || 'error' in check) {
      this.deps.log(`link report for ${ticket.ref} accepted unchecked: ${check === 'late' ? `the ${ticket.source} check took over ${REPORT_CHECK_MS / 1000} seconds` : check.error}`);
      return null;
    }

    return check.refused;
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
    if (this.unreconciled.size > 0) {
      await this.reconcile(this.deps.store.activeSessions().filter((session) => session.state === 'starting' && this.unreconciled.has(session.id)));
    }

    const sessions = this.deps.store.startedSessions();

    if (sessions.length === 0) {
      return;
    }

    // Worktree discovery runs first, so the hook markers the roster read takes in are as fresh as the event it sends.
    await this.findSetupWorktrees();

    const observed: ObservedSession[] = [];
    const checked: string[] = [];

    for (const provider of PROVIDERS) {
      const own = sessions.filter((session) => session.provider === provider);

      if (own.length === 0) {
        continue;
      }

      // A question reported while the read ran makes its result stale for that session, which the next read decides (PRD R70).
      const asked = new Map(own.map((session) => [session.id, session.question?.id ?? null]));
      const roster = await this.runners[provider].observe(own);

      // A failed read changes none of the provider's sessions.
      if ('error' in roster) {
        this.deps.log(`${provider} roster read failed: ${roster.error}`);
        continue;
      }

      const stale = new Set(own.filter((session) => (this.deps.store.session(session.id)?.question?.id ?? null) !== asked.get(session.id)).map((session) => session.id));

      if (stale.size > 0) {
        this.rosterAgain = true;
      }

      observed.push(...roster.sessions.filter((entry) => !stale.has(entry.sessionId)));
      checked.push(...own.filter((session) => !stale.has(session.id)).map((session) => session.id));
    }

    if (checked.length > 0) {
      this.send({ type: 'roster', sessions: observed, checked });
    }
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
    const started = this.deps.store.startedSessions();
    const markers = new Map<string, MarkerReading>();

    for (const provider of PROVIDERS) {
      for (const [id, reading] of this.runners[provider].markers(started.filter((session) => session.provider === provider))) {
        markers.set(id, reading);
      }
    }

    // A new marker from an ended session can mean the operator resumed it, as in a VS Code tab; only the roster can revive it.
    const changed = started.filter((session) => {
      const at = session.state === 'ended' && session.nativeSessionId !== null ? markers.get(session.nativeSessionId)?.at : undefined;

      if (at === undefined || this.markerSeen.get(session.nativeSessionId!) === at) {
        return false;
      }

      this.markerSeen.set(session.nativeSessionId!, at);

      return true;
    });

    const active = this.deps.store.activeSessions();
    // Only a roster read can decide a session whose process may have ended or moved, such as to an interactive process.
    const recheck = active.some((session) => session.nativeSessionId !== null && markers.get(session.nativeSessionId)?.recheck === true);

    if (changed.length > 0 || recheck) {
      void this.readRoster();
    }

    for (const session of active) {
      const reading = session.nativeSessionId === null ? undefined : markers.get(session.nativeSessionId);
      // A reading that needs the roster read is left to it, so a provisional state never releases a session.
      const observed = reading === undefined || reading.recheck ? null : reading.observed;

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

  /** The report contract of the Switchboard session with this Claude session ID, for the hook that restores it after compaction, or null. */
  contract(nativeSessionId: string): string | null {
    const session = this.deps.store.sessionByNativeId(nativeSessionId);

    if (session === null) {
      return null;
    }

    this.deps.log(`restored the report contract of session ${session.id} after compaction`);

    return sessionContract(session.id, this.reportCommand, session.reports, session.provider);
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

    if (body.kind === 'link') {
      const refused = await this.linkRefusal(body.sessionId, body.target);

      if (refused !== null) {
        this.refuseReport(body.sessionId, { kind: 'link', label: body.label, target: body.target }, refused);

        return { refused };
      }
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
                  : body.kind === 'question'
                    ? { kind: body.kind, text: body.text }
                    : { kind: body.kind, label: body.label, target: body.target };

    return { refused: this.send({ type: 'report', sessionId: body.sessionId, report }).refused };
  }

  snapshot(): Snapshot {
    const store = this.deps.store;
    const { settings, playbooks, settingsError, playbookErrors } = this.config;
    const enabled = this.enabledSources();
    // Returned counts earlier work items with the same playbook, or one it is a return of, that started a session; a failed launch has no shortId.
    const started = (item: WorkItem) => store.sessionsFor(item.id).some((session) => session.shortId !== null);
    const returned = (items: WorkItem[], playbook: string | null) => {
      if (playbook === null) {
        return 0;
      }

      const counted = new Set([playbook, ...(playbooks.get(playbook)?.returnOf ?? [])]);

      return items.filter((item) => item.playbook !== null && counted.has(item.playbook) && started(item)).length;
    };
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
        .map(([name]) => ({ name, enabled: enabled.has(name) })),
      namespaces: Object.fromEntries(Object.entries(settings.sources).map(([name, source]) => [name, source.namespace])),
      configDir: this.deps.configDir,
      errors: {
        settings: settingsError,
        playbooks: playbookErrors.map((entry) => `${entry.name}: ${entry.error}`),
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

    // Only a valid file lists the configured sources; with an invalid one the previous settings stay in force.
    if (this.config.settingsError === null) {
      this.deps.store.keepSourceStates(Object.keys(this.config.settings.sources));
    }

    const enabled = this.enabledSources();

    for (const [name, settings] of Object.entries(this.config.settings.sources)) {
      if (!enabled.has(name) || name === ADHOC_SOURCE) {
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
        const result = await this.runners[action.provider].start(action);

        this.send(
          'error' in result
            ? { type: 'session-start-failed', sessionId: action.sessionId, message: result.error }
            : { type: 'session-started', sessionId: action.sessionId, nativeSessionId: result.nativeSessionId, shortId: result.shortId },
        );
        return;
      }
      case 'stop-session': {
        const runner = this.runners[action.provider];

        if (action.reason === 'release' && action.shortId !== null && !(await runner.isBackground(action))) {
          // The operator resumed it, such as in a VS Code tab; a release never stops their session (PRD R39).
          this.deps.log(`release skipped: session ${action.sessionId} is not a background process`);
          return;
        }

        const failure = await runner.stop(action, action.reason);

        if (failure === null) {
          await this.findSetupWorktrees();
        } else if (this.deps.store.session(action.sessionId) === null) {
          // Delete removed the session row, so the flow has nowhere to show the failure (PRD R76).
          this.deps.log(`stop of deleted session ${action.sessionId} (${action.shortId}) failed; it may still be running: ${failure.error}`);
        }

        this.send(failure === null ? { type: 'stop-succeeded', sessionId: action.sessionId, reason: action.reason } : { type: 'stop-failed', sessionId: action.sessionId, reason: action.reason, message: failure.error });
        return;
      }
    }
  }
}

/** The source's triage context led by the current UTC time, in the form sources use, so triage can judge how recent each event is. */
export function triageText(context: string, now: number): string {
  return `Current time: ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC\n\n${context}`;
}
