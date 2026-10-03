import { classify, entryFor, installHooks, markerState, observe, readMarkers, readRoster, startSession, stopSession } from '@switchboard/claude';
import type { Exec, Marker } from '@switchboard/claude';
import { ADHOC_SOURCE, handle, importanceRank, switchboardHome } from '@switchboard/core';
import type { FlowAction, FlowEvent, FlowResult, Link, Session, Source, SourceSettings, Store, Ticket, Triage, WorkItem, Worktree } from '@switchboard/core';
import type { Config } from './config.js';
import { listWorktrees, reportedWorktree } from './git.js';

export const ROSTER_MS = 30_000;
export const MARKER_MS = 5_000;
/** How long the panel lists done work items. */
export const DONE_DAYS = 7;
/** How long a pending open waits for a window on its folder. */
export const OPEN_CLAIM_MS = 2 * 60_000;

export interface RuntimeDeps {
  /** The operator's home; the Switchboard home is `<home>/.switchboard`. */
  home: string;
  store: Store;
  exec: Exec;
  claudePath: string;
  /** Builds a polling source from its settings, or says why it cannot. Null for a source Switchboard does not know. */
  makeSource(name: string, settings: SourceSettings): { source: Source } | { error: string } | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  newSessionId(): string;
  /** Claude's settings.json, from the operator's profile even when the Switchboard home is overridden. */
  claudeSettings: string;
  log(line: string): void;
}

export interface WorkItemView extends WorkItem {
  ticket: Ticket;
  triage: Triage | null;
  sessions: Session[];
  worktree: Worktree | null;
  links: Link[];
  /** Earlier work items for the same ticket; above 0 the panel marks the work item Returned (PRD R51). */
  returned: number;
}

/** A pool ticket the operator may pick, with its pool triage (PRD R47). */
export interface PoolView {
  ticket: Ticket;
  triage: Triage | null;
  /** Done work items for the ticket; above 0 the panel marks it Returned (PRD R51). */
  returned: number;
}

/** Everything the panel shows, sent whole on each change. */
export interface Snapshot {
  workItems: WorkItemView[];
  /** By importance, then oldest first by the source's sort time (PRD R50). */
  pool: PoolView[];
  playbooks: { name: string; description: string }[];
  /** Repos an ad-hoc prompt can run in: each source's repo root, the first being the default. */
  repoRoots: string[];
  /** Sources being polled. */
  sources: string[];
  /** The Switchboard home, where settings.json and playbooks/ live. */
  home: string;
  errors: { settings: string | null; playbooks: string[]; hooks: string | null; sources: Record<string, string> };
}

export type ReportBody =
  | { sessionId: string; kind: 'stage'; stage: string }
  | { sessionId: string; kind: 'worktree'; path: string }
  | { sessionId: string; kind: 'done'; summary: string | null }
  | { sessionId: string; kind: 'blocked'; reason: string }
  | { sessionId: string; kind: 'approval'; prompt: string; summary: string | null }
  | { sessionId: string; kind: 'link'; label: string; target: string };

/** Orders the pool by importance rank, unrated last, keeping the store's sort-time order within a rank (PRD R50). */
export function sortPool(pool: PoolView[]): PoolView[] {
  const rank = (entry: PoolView) => importanceRank(entry.triage?.immediacy ?? null, entry.triage?.severity ?? null) ?? Infinity;

  return pool.map((entry, index) => ({ entry, index })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index).map(({ entry }) => entry);
}

/** Runs the core: turns timers, source reads, CLI results and requests into events, and runs the actions they decide. */
export class Runtime {
  private config: Config;
  private sources = new Map<string, Source>();
  private sourceErrors: Record<string, string> = {};
  private hookError: string | null = null;
  private pending = new Set<Promise<void>>();
  private listeners = new Set<() => void>();
  private timers: NodeJS.Timeout[] = [];
  private polling = new Set<string>();
  private pendingOpens = new Map<string, { sessionId: string; at: number }>();

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
    this.timers.push(setInterval(() => void this.readRoster(), ROSTER_MS), setInterval(() => this.readMarkers(), MARKER_MS));
    this.restartPolls();
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) {
      clearInterval(timer);
    }
  }

  /** True while any session may be running, so the hub stays up for its reports (PRD R43). */
  hasActiveSessions(): boolean {
    return this.deps.store.activeSessions().length > 0;
  }

  async pollSource(name: string): Promise<void> {
    const source = this.sources.get(name);

    if (source === undefined || this.polling.has(name)) {
      return;
    }

    this.polling.add(name);

    try {
      const result = await source.poll();

      if ('error' in result) {
        this.sourceErrors[name] = result.error;
        this.send({ type: 'poll-failed', source: name, error: result.error });
        return;
      }

      delete this.sourceErrors[name];
      this.send({ type: 'poll', source: name, tickets: result.tickets });
      await this.findWorktrees(name, source);
    } finally {
      this.polling.delete(name);
    }
  }

  /** Reads the roster and hook markers; a failed read changes nothing. */
  async readRoster(): Promise<void> {
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
    this.send({ type: 'roster', sessions: observe(roster.entries, sessions, this.markers()) });
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

    for (const session of this.deps.store.activeSessions()) {
      const marker = session.nativeSessionId === null ? undefined : markers.get(session.nativeSessionId);
      const observed = marker === undefined ? null : markerState(marker);

      if (observed !== null && session.state !== 'starting' && (observed.state !== session.state || observed.detail !== session.stateDetail)) {
        this.send({ type: 'marker', sessionId: session.id, ...observed });
      }
    }
  }

  /** A report from the `report` command. A worktree must be one `git worktree list` shows in that path. */
  async report(body: ReportBody): Promise<{ refused: string | null }> {
    if (body.kind === 'worktree') {
      const worktree = await reportedWorktree(body.path, this.deps.exec);

      if (worktree === null) {
        return { refused: `${body.path} is not a git worktree.` };
      }

      return { refused: this.send({ type: 'report', sessionId: body.sessionId, report: { kind: 'worktree', path: worktree.path, branch: worktree.branch } }).refused };
    }

    const report =
      body.kind === 'stage'
        ? { kind: body.kind, stage: body.stage }
        : body.kind === 'done'
          ? { kind: body.kind, summary: body.summary }
          : body.kind === 'approval'
            ? { kind: body.kind, prompt: body.prompt, summary: body.summary }
            : body.kind === 'link'
              ? { kind: body.kind, label: body.label, target: body.target }
              : { kind: body.kind, reason: body.reason };

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

    return {
      workItems: store.workItems(this.deps.now() - DONE_DAYS * 24 * 60 * 60 * 1000).map((item) => ({
        ...item,
        ticket: store.ticket(item.ticketId)!,
        triage: store.triagesFor(item.id).at(-1) ?? null,
        sessions: store.sessionsFor(item.id),
        worktree: store.worktreeFor(item.ticketId),
        links: store.linksFor(item.ticketId),
        returned: store.workItemsForTicket(item.ticketId).filter((other) => other.id < item.id).length,
      })),
      pool: sortPool(
        store
          .poolTickets()
          .map((ticket) => ({ ticket, items: store.workItemsForTicket(ticket.id) }))
          .filter(({ items }) => items.every((item) => item.status === 'done'))
          .map(({ ticket, items }) => ({ ticket, triage: store.poolTriages(ticket.id).at(-1) ?? null, returned: items.length })),
      ),
      playbooks: [...playbooks.values()].filter((playbook) => playbook.kind === 'task').map(({ name, description }) => ({ name, description })),
      repoRoots: [...new Set(Object.values(settings.sources).map((source) => source.repoRoot).filter((root) => root !== ''))],
      sources: [...this.sources.keys()],
      home: this.home,
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

    for (const timer of this.timers.splice(2)) {
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

        const result = await classify(
          { claudePath: this.deps.claudePath, systemPrompt: action.systemPrompt, choices: action.choices, context: context.context, model: action.model, timeoutSeconds: action.timeoutSeconds, cwd: this.home },
          this.deps.exec,
        );

        this.send(
          'error' in result
            ? { type: 'triage-failed', triageId: action.triageId, error: result.error, context: context.context }
            : {
                type: 'triage-succeeded',
                triageId: action.triageId,
                context: context.context,
                playbook: result.playbook,
                summary: result.summary,
                immediacy: result.immediacy,
                severity: result.severity,
                model: action.model,
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
    }
  }
}

function folderKey(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}
