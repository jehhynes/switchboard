import { mkdirSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { classify, ClaudeRunner, NOT_SWITCHBOARD } from '@switchboard/claude';
import { classifyCodex, CodexRunner } from '@switchboard/codex';
import type { Exec } from '@switchboard/claude';
import type { Comment, FlowAction, FlowEvent, FlowResult, HandledWork, Link, MarkerReading, ObservedFork, OpenVSCode, ObservedSession, Paste, PolledTicket, Provider, QueueWait, Session, SessionRunner, Source, SourceSettings, Store, Ticket, TicketLookup, Triage, WorkItem, Worktree } from '@switchboard/core';
import { activeSession, ADHOC_SOURCE, awaitsRecheck, RESUME_PROMPT, effectiveFocus, executableDirOnPath, handle, heldSlots, nothingNew, playbookChoices, PROVIDERS, queueWaits, recordRefusal, reopenRefusal, repoRoots, SCHEDULE_SOURCE, sessionContract, switchboardHome, triageModel } from '@switchboard/core';
import type { Config } from './config.js';
import { listWorktrees, reportedWorktree } from './git.js';
import { doneSince } from './rows.js';

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
/** How long a done or link report waits for the source read that checks it (PRD R10, R52). */
export const REPORT_CHECK_MS = 6_000;
/** When the source is read again after a done report it lists as assigned; GitHub issue search lags an unassignment by seconds (mechanics M34). */
export const RECHECK_MS = 30_000;
/** How long Continue in Background waits for the tab's process to exit (PRD R89); closing the tab ended it within 4 seconds (mechanics M55). */
export const MOVE_EXIT_MS = 30_000;
const MOVE_POLL_MS = 250;
/** How long a resumed session may take to be listed in its background process with a pid, as for a start. */
export const RESUME_CONFIRM_MS = 60_000;
const RESUME_POLL_MS = 2_000;
/** How long `<sessions.nodePath> --version` may take. */
const NODE_CHECK_TIMEOUT_MS = 10_000;

export interface RuntimeDeps {
  /** The operator's home; the Switchboard home is `<home>/.switchboard`. */
  home: string;
  /** The folder holding settings.json. */
  configDir: string;
  store: Store;
  exec: Exec;
  /** Builds a polling source from its settings, or says why it cannot. Null for a source Switchboard does not know. */
  makeSource(name: string, settings: SourceSettings): { source: Source } | { error: string } | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  newSessionId(): string;
  /** Claude's settings.json, where the hooks are installed: the operator's profile's even when the Switchboard home is overridden. */
  claudeSettings: string;
  /** Codex's home (`CODEX_HOME` or `~/.codex`) and the variables Codex runs need; defaults for tests that run no Codex session. */
  codex?: { home: string; env: Record<string, string> };
  /** Stand-in runners for tests; each runner is built from the fields above otherwise. */
  runners?: Partial<Record<Provider, SessionRunner>>;
  /** Whether a process runs; a stand-in for tests. */
  alive?(pid: number): boolean;
  log(line: string): void;
}

/** `kill(pid, 0)` sends nothing; EPERM means the process exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface WorkItemView extends WorkItem {
  ticket: Ticket;
  /** The latest triage, which may still be running. */
  triage: Triage | null;
  /** The URL an item window opens: the latest successful triage's focus, else the ticket's URL (PRD R79). */
  focus: string | null;
  sessions: Session[];
  worktree: Worktree | null;
  links: Link[];
  /** Drafted texts the operator copies into the source (PRD R60). */
  pastes: Paste[];
  /** The operator's comments, oldest first (PRD R87). */
  comments: Comment[];
  /** Earlier started work items for the same ticket with the same playbook or one it is a return of; above 0 the dock marks the work item Returned (PRD R51). */
  returned: number;
  /** The ticket of the work item whose session reported this one as a task (PRD R68). */
  parent: Ticket | null;
  /** The ad-hoc work item a ticket report moved onto this ticket: its first work item, because an ad-hoc ticket has one (PRD R83). */
  moved: boolean;
  /** The playbook's `approvalSends`: Approve sends the work (PRD R27). */
  approvalSends: boolean;
  /** What keeps a queued work item from starting; empty for every other status (PRD R34). */
  waits: QueueWait[];
  /** The operator can reopen it (PRD R86). */
  reopenable: boolean;
  /** The playbooks Start with guidance… offers an `unstarted` work item, its own among them; empty otherwise (PRD R35). */
  playbookChoices: string[];
}

/** A pool ticket the operator may pick, with its pool triage (PRD R47). */
export interface PoolView {
  ticket: Ticket;
  triage: Triage | null;
  /** The URL a click on its row opens (PRD R79). */
  focus: string | null;
  /** The ticket's links, such as a GitHub issue its thread names (PRD R52, R61). */
  links: Link[];
  /** Started done work items for the ticket with the latest triage's playbook or one it is a return of; above 0 the dock marks it Returned (PRD R51). */
  returned: number;
  /** The playbooks Start with guidance… offers, the triage's among them (PRD R35). */
  playbookChoices: string[];
}

/** Everything a window and the dock show, sent whole on each change. */
export interface Snapshot {
  workItems: WorkItemView[];
  /** Oldest first by the source's sort time; the dock orders it with the unstarted work items (PRD R27). */
  pool: PoolView[];
  playbooks: { name: string; description: string }[];
  /** Repos an ad-hoc prompt can run in: each source's repo root, the first being the default. */
  repoRoots: string[];
  /** The schedules Run now offers, in settings order (PRD R82). */
  schedules: { name: string; playbook: string }[];
  /** Sources being polled. */
  sources: string[];
  /** Every configured source but ad-hoc, for the operator's source filter. */
  sourceStates: { name: string; enabled: boolean }[];
  /** Each configured source's playbook namespace, which names a triage in progress, such as `dev:triage`. */
  namespaces: Record<string, string>;
  /** The folder holding settings.json. */
  configDir: string;
  /** `dock.openVSCode`: whether rows open their item window always, or only for review (PRD R71). */
  openVSCode: OpenVSCode;
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
  /** Each runner's hook error from its last install. */
  private hookErrors: Record<Provider, string | null> = { claude: null, codex: null };
  /** Why `sessions.nodePath` cannot run, which the hooks and session reports need; shown with the hook errors. */
  private nodeError: string | null = null;
  /** Counts Node.js checks, so only the latest one sets `nodeError`. */
  private nodeChecks = 0;
  /** Each runner's latest install; installs of one runner run in turn, so an older result never replaces a newer one. */
  private hookInstalls: Record<Provider, Promise<void>> = { claude: Promise.resolve(), codex: Promise.resolve() };
  private pending = new Set<Promise<void>>();
  private listeners = new Set<() => void>();
  /** The roster, marker and wake timers, then one poll timer per source; `restartPolls` replaces the poll timers. */
  private timers: NodeJS.Timeout[] = [];
  /** Set by `stop`, so a pending recheck does not read a source after the store closes. */
  private stopped = false;
  /** Session ID and token of each done report with a second read scheduled, so a startup scan and a report do not schedule two. */
  private readonly rechecks = new Set<string>();
  private markerWatcher: FSWatcher | null = null;
  private markerRead: NodeJS.Timeout | null = null;
  private markerWatchRetry: NodeJS.Timeout | null = null;
  private markerWatchFailed = false;
  /** The marker time last checked per ended session, so each marker an ended session writes reads the roster once. */
  private markerSeen = new Map<string, number>();
  /** The marker time last checked per native ID that is no session's, in a session's project directory: it may be a fork (PRD R78). */
  private unknownSeen = new Map<string, number>();
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
    const codex = deps.codex ?? { home: join(deps.home, '.codex'), env: {} };
    const claudePath = () => this.config.settings.sessions.claudePath;
    const nodePath = () => this.config.settings.sessions.nodePath;
    const codexPath = () => this.config.settings.sessions.codexPath;

    this.runners = {
      claude:
        deps.runners?.claude ??
        new ClaudeRunner({ claudePath, nodePath, exec: deps.exec, sleep: deps.sleep, now: deps.now, home: this.home, claudeSettings: deps.claudeSettings, hooks }),
      codex:
        deps.runners?.codex ??
        new CodexRunner({ codexPath, nodePath, exec: deps.exec, sleep: deps.sleep, now: deps.now, home: this.home, codexHome: codex.home, env: codex.env, hooks }),
    };
    this.buildSources();
  }

  get home(): string {
    return switchboardHome(this.deps.home);
  }

  /** The report command prefix sessions run (architecture.md § Session reports). */
  get reportCommand(): string {
    return `${this.config.settings.sessions.nodePath} "${this.home.replaceAll('\\', '/')}/hub.js" report`;
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
    const before = this.config.settings.sessions;
    const after = config.settings.sessions;

    this.config = config;

    // Hook commands name the Node.js, and Codex's trust needs its CLI; each change, and turning hooks on or off, applies without a hub restart.
    if (after.nodePath !== before.nodePath || after.claudePath !== before.claudePath || after.codexPath !== before.codexPath) {
      this.track(this.checkNode());
    }

    if (after.installHooks) {
      const providers = !before.installHooks || after.nodePath !== before.nodePath ? PROVIDERS : after.codexPath !== before.codexPath ? (['codex'] as const) : [];

      if (providers.length > 0) {
        this.track(this.installHooks(providers));
      }
    } else if (before.installHooks) {
      // The hooks stay installed but their markers are no longer read, so an install error no longer applies.
      this.track(this.clearHookErrors());
    }

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

  /** Polls every source that is on now and restarts its poll interval, for the dock's Refresh; returns why it could not, or null. */
  pollNow(): string | null {
    if (this.sources.size === 0) {
      const errors = Object.entries(this.sourceErrors).map(([name, error]) => `${name}: ${error}`);

      return errors.length > 0 ? errors.join(' ') : 'No source is polled. Turn one on in the header.';
    }

    this.restartPolls();
    return null;
  }

  /** Startup reconciliation (PRD R43): triage the hub abandoned runs again, and a start it abandoned fails. */
  async startup(): Promise<void> {
    await this.checkNode();

    if (this.config.settings.sessions.installHooks) {
      await this.installHooks(PROVIDERS);
    }

    for (const triage of this.deps.store.runningTriages()) {
      this.send({ type: 'triage-cancelled', triageId: triage.id });
    }

    await this.reconcile(this.deps.store.activeSessions().filter((entry) => entry.state === 'starting'));

    this.resumeMoves();

    await this.readRoster();

    this.recheckDoneReports();
  }

  /**
   * Runs `<sessions.nodePath> --version` with the PATH each agent the hub starts gets: the hub's, with an absolute path's directory of that
   * agent first. A Claude background session started by an already running Claude service has that service's environment instead.
   */
  private async checkNode(): Promise<void> {
    const check = ++this.nodeChecks;
    const { nodePath, claudePath, codexPath } = this.config.settings.sessions;
    const envs = new Map<string, { agents: string[]; env: Record<string, string> }>();

    for (const [agent, env] of [['Claude Code', executableDirOnPath(claudePath)], ['Codex', executableDirOnPath(codexPath)]] as const) {
      const key = JSON.stringify(env);
      envs.set(key, { agents: [...(envs.get(key)?.agents ?? []), agent], env });
    }

    const results = await Promise.all([...envs.values()].map(async ({ agents, env }) => ({ agents, result: await this.deps.exec(nodePath, ['--version'], { timeoutMs: NODE_CHECK_TIMEOUT_MS, env }) })));

    if (check !== this.nodeChecks) {
      return;
    }

    const missing = results.filter(({ result }) => result.missing).flatMap(({ agents }) => agents);
    const failed = results.find(({ result }) => !result.missing && result.code !== 0);

    this.nodeError =
      missing.length > 0
        ? `Node.js was not found at ${nodePath} on the PATH ${missing.join(' and ')} get${missing.length === 1 ? 's' : ''} from the hub, so Switchboard's hooks and session reports there cannot run. Install it or set sessions.nodePath.`
        : failed !== undefined
          ? `${nodePath} --version failed, so Switchboard's hooks and session reports may not run: ${failed.result.timedOut ? 'it did not finish' : failed.result.stderr.trim() || `exit code ${String(failed.result.code)}`}.`
          : null;
    this.changed();
  }

  /** Clears each runner's hook error after any install in flight, so that install cannot bring its error back. */
  private async clearHookErrors(): Promise<void> {
    await Promise.all(
      PROVIDERS.map((provider) => {
        const clear = this.hookInstalls[provider].then(() => {
          this.hookErrors[provider] = null;
          this.changed();
        });

        this.hookInstalls[provider] = clear;
        return clear;
      }),
    );
  }

  private async installHooks(providers: readonly Provider[]): Promise<void> {
    await Promise.all(
      providers.map((provider) => {
        const install = this.hookInstalls[provider].then(async () => {
          this.hookErrors[provider] = await this.runners[provider].installHooks();
          this.changed();
        });

        this.hookInstalls[provider] = install.catch(() => {});
        return install;
      }),
    );
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
    this.stopped = true;

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
    return this.sourceOperation(name, () => this.read(name, source));
  }

  private sourceOperation<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const read = (this.reads.get(name) ?? Promise.resolve()).then(operation);
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
    // A queued read can start after the hub stopped or the source was turned off.
    if (this.stopped || this.sources.get(name) !== source) {
      return null;
    }

    const result = await source.poll(this.deps.store.currentTickets(name));
    const assignments: NonNullable<Extract<FlowEvent, { type: 'poll' }>['assignments']> = [];
    if (!('error' in result)) {
      for (const ticket of this.deps.store.handledTickets(name)) {
        const assignment = await this.assignmentRead(source, ticket.url);
        if (assignment === null || 'error' in assignment) {
          const error = assignment === null ? `The ${name} source cannot read the assignment of ${ticket.ref}.` : assignment.error;
          if (this.sources.get(name) === source) {
            this.sourceErrors[name] = error;
            this.send({ type: 'poll-failed', source: name, error });
          }
          return null;
        }
        assignments.push({ ticketId: ticket.id, expectedKey: ticket.handledAssignmentKey!, key: assignment.assignmentKey });
        const polled = result.tickets.find((entry) => entry.sourceKey === ticket.sourceKey);
        if (polled !== undefined) polled.assigned = assignment.assigned;
        else result.tickets.push({ sourceKey: ticket.sourceKey, ref: assignment.ticket.ref, title: assignment.ticket.title, url: assignment.ticket.url, sourceId: ticket.sourceId, assigned: assignment.assigned, pool: false, sortAt: ticket.sortAt, enteredAt: null });
      }
    }

    // The operator turned the source off while it was read; its result would show an error or tickets of a source that is off.
    if (this.sources.get(name) !== source) {
      return null;
    }

    if ('error' in result) {
      this.sourceErrors[name] = result.error;
      this.send({ type: 'poll-failed', source: name, error: result.error });
      return null;
    }

    delete this.sourceErrors[name];
    this.send({ type: 'poll', source: name, tickets: result.tickets, assignments });
    await this.findWorktrees(name, source);

    return result.tickets;
  }

  /**
   * Whether a fresh read lists a task session's ticket as assigned when it reports done (PRD R10); if so, `recheck` settles the report. False
   * when the read fails or takes longer than REPORT_CHECK_MS, which keeps the reply inside the report CLI's 10-second timeout.
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

  /** Starts the second read of each done report that waits for one, as the flow marks it (PRD R10). */
  private recheckDoneReports(): void {
    const store = this.deps.store;

    for (const item of store.workItems(Number.MAX_SAFE_INTEGER)) {
      const session = store.sessionsFor(item.id).at(-1);

      const token = session?.outcomeDetail ?? null;
      const key = `${session?.id} ${token}`;

      if (session !== undefined && token !== null && awaitsRecheck(item, session) && !this.rechecks.has(key)) {
        this.rechecks.add(key);
        void this.recheck(session.id, token, store.ticket(item.ticketId)!).finally(() => this.rechecks.delete(key));
      }
    }
  }

  /**
   * After RECHECK_MS, reads the ticket's source again, behind any read in flight, and sends whether it still lists the ticket as assigned. A
   * failed read, one over REPORT_CHECK_MS or a source turned off accepts the done report; a stop leaves it for `startup`.
   */
  private async recheck(sessionId: string, token: string, ticket: Ticket): Promise<void> {
    await this.deps.sleep(RECHECK_MS);
    const source = this.sources.get(ticket.source);

    if (this.stopped) {
      return;
    }

    const read = source === undefined ? Promise.resolve(null) : this.readAfter(ticket.source, source).catch(() => null);
    const tickets = await Promise.race([read, this.deps.sleep(REPORT_CHECK_MS).then(() => 'late' as const)]);

    if (tickets === 'late') {
      this.deps.log(`done report for ${ticket.ref} accepted unchecked: the second ${ticket.source} read took over ${REPORT_CHECK_MS / 1000} seconds`);
    }

    if (!this.stopped) {
      const assigned = tickets !== 'late' && (tickets?.some((entry) => entry.sourceKey === ticket.sourceKey && entry.assigned) ?? false);

      this.send({ type: 'done-checked', sessionId, token, assigned });
    }
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
    const forks: ObservedFork[] = [];
    const checked: string[] = [];
    // A question reported, or a move to the background begun or ended, while the reads ran makes their result stale for that session, which the
    // next read decides (PRD R70, R89). Checked once all providers' reads are done, since the event applies them together.
    const marks = (session: Session | null) => `${session?.question?.id ?? ''}|${session?.move?.id ?? ''}|${session?.movedAt ?? ''}`;
    const asked = new Map(sessions.map((session) => [session.id, marks(session)]));

    for (const provider of PROVIDERS) {
      const own = sessions.filter((session) => session.provider === provider);

      if (own.length === 0) {
        continue;
      }

      const roster = await this.runners[provider].observe(own);

      // A failed read changes none of the provider's sessions.
      if ('error' in roster) {
        this.deps.log(`${provider} roster read failed: ${roster.error}`);
        continue;
      }

      observed.push(...roster.sessions);
      forks.push(...(roster.forks ?? []));
      checked.push(...own.map((session) => session.id));
    }

    const stale = new Set(sessions.filter((session) => marks(this.deps.store.session(session.id)) !== asked.get(session.id)).map((session) => session.id));

    if (stale.size > 0) {
      this.rosterAgain = true;
    }

    const fresh = checked.filter((id) => !stale.has(id));

    if (fresh.length > 0) {
      const filteredForks = forks.filter((fork) => !stale.has(fork.sessionId));

      this.send({ type: 'roster', sessions: observed.filter((entry) => !stale.has(entry.sessionId)), checked: fresh, ...(filteredForks.length > 0 ? { forks: filteredForks } : {}) });
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

    const known = new Set(started.flatMap((session) => [...(session.nativeSessionId === null ? [] : [session.nativeSessionId]), ...session.retiredIds]));
    const projects = new Set(started.filter((session) => session.provider === 'claude').map((session) => projectOf(session.cwd)));
    // A marker from an unknown copy in a session's project directory may be a fork, which only a roster read can adopt.
    const forked = [...markers].filter(([id, reading]) => {
      if (known.has(id) || reading.cwd == null || !projects.has(projectOf(reading.cwd)) || this.unknownSeen.get(id) === reading.at) {
        return false;
      }

      this.unknownSeen.set(id, reading.at);

      return true;
    });

    const active = this.deps.store.activeSessions();
    // Only a roster read can decide a session whose process may have ended or moved, such as to an interactive process.
    const recheck = active.some((session) => session.nativeSessionId !== null && markers.get(session.nativeSessionId)?.recheck === true);

    if (changed.length > 0 || recheck || forked.length > 0) {
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
    const kept = Object.fromEntries(['kind', 'stage', 'path', 'label', 'target', 'file', 'title', 'url', 'playbook'].filter((key) => typeof fields[key] === 'string').map((key) => [key, fields[key]]));
    const event = { type: 'report', sessionId, report: kept } as unknown as FlowEvent;

    this.deps.store.transaction(() => recordRefusal(this.deps.store, event, this.deps.now(), message));
    this.changed();
  }

  /**
   * Why a report from a Claude copy is refused: the copy is one a fork retired (PRD R78). A report from a newer fork not adopted yet is
   * recorded and starts a roster read; one from an unrelated copy is recorded as before.
   */
  private retiredCopy(sessionId: string, nativeSessionId: string): string | null {
    const session = this.deps.store.session(sessionId);

    if (session === null || session.provider !== 'claude' || session.nativeSessionId === null || session.nativeSessionId === nativeSessionId) {
      return null;
    }

    const relation = this.runners.claude.relation?.(nativeSessionId, session) ?? 'unrelated';

    if (relation === 'newer') {
      void this.readRoster();
    }

    return relation === 'older' ? `Session ${nativeSessionId.slice(0, 8)} was replaced by fork ${session.shortId ?? session.nativeSessionId.slice(0, 8)}, so the report was not recorded.` : null;
  }

  /**
   * The report contract of the Switchboard session with this Claude session ID, or of which it is a newer fork not adopted yet (PRD R78),
   * for the hook that restores it after compaction, or null.
   */
  contract(nativeSessionId: string): string | null {
    const session = this.deps.store.sessionByNativeId(nativeSessionId) ?? this.runners.claude.forkOf?.(nativeSessionId, this.deps.store.startedSessions()) ?? null;

    if (session === null) {
      return null;
    }

    this.deps.log(`restored the report contract of session ${session.id} after compaction`);

    return sessionContract(session.id, this.reportCommand, session.reports, session.provider);
  }

  /**
   * Registers a live Claude session the operator started outside Switchboard as a work item (PRD R81), and answers its work item's key and its
   * report contract; a session Switchboard has answers them again, so a retry after a lost reply recovers the contract. A copy of a Switchboard
   * session's family, newer or older, is refused, because a fork continues that session (PRD R78).
   */
  async register(nativeSessionId: string, title: string): Promise<{ key: string; contract: string; already: boolean } | { refused: string }> {
    const keyOf = (session: Session) => {
      const ticket = this.deps.store.ticket(this.deps.store.workItem(session.workItemId)!.ticketId)!;

      return `${ticket.source} ${ticket.sourceKey}`;
    };
    const known = this.deps.store.sessionByNativeId(nativeSessionId);

    if (known !== null) {
      return { key: keyOf(known), contract: sessionContract(known.id, this.reportCommand, known.reports, known.provider), already: true };
    }

    const family = this.deps.store.startedSessions().find((session) => session.provider === 'claude' && (session.retiredIds.includes(nativeSessionId) || (this.runners.claude.relation?.(nativeSessionId, session) ?? 'unrelated') !== 'unrelated'));

    if (family !== undefined) {
      return { refused: `This session is a copy of ${keyOf(family)}, which Switchboard continues in its latest copy.` };
    }

    const live = this.runners.claude.live === undefined ? { error: 'The Claude runner cannot register sessions.' } : await this.runners.claude.live(nativeSessionId);

    if (live === null) {
      return { refused: `Claude does not list session ${nativeSessionId} as running.` };
    }

    if ('error' in live) {
      return { refused: live.error };
    }

    const { refused } = this.send({ type: 'register', nativeSessionId, shortId: live.shortId, cwd: live.cwd, title });

    if (refused !== null) {
      return { refused };
    }

    const session = this.deps.store.sessionByNativeId(nativeSessionId)!;

    return { key: keyOf(session), contract: sessionContract(session.id, this.reportCommand, session.reports, session.provider), already: false };
  }

  /**
   * Continue in Background (PRD R89): finds the session in the item window's Claude tab labelled `label`, which must be one of `workItemIds`, and
   * starts its move. It answers once the flow has stored the move with the tab's process, so the window closes the tab only after that.
   */
  async background(label: string, workItemIds: number[]): Promise<{ refused: string } | null> {
    const runner = this.runners.claude;
    const tab = runner.tab === undefined ? { error: 'The Claude runner cannot move sessions.' } : await runner.tab(label);

    if ('error' in tab) {
      return { refused: tab.error };
    }

    if ('refused' in tab) {
      return tab;
    }

    const session = this.deps.store.sessionByNativeId(tab.nativeSessionId);

    if (session === null) {
      return { refused: NOT_SWITCHBOARD };
    }

    const { refused } = this.send({ type: 'background', sessionId: session.id, nativeSessionId: tab.nativeSessionId, pid: tab.pid, workItemIds });

    return refused === null ? null : { refused };
  }

  /** Waits for the tab's process to exit, then resumes the session in its background process, unless Stop or Delete ended the move first. */
  private async resumeSession(action: Extract<FlowAction, { type: 'resume-session' }>): Promise<void> {
    const alive = this.deps.alive ?? processAlive;
    const current = () => this.deps.store.session(action.sessionId)?.move?.id === action.moveId;

    // A stopped hub has closed the store; the move stays stored, and the next hub's startup continues it.
    for (const until = this.deps.now() + MOVE_EXIT_MS; alive(action.pid); await this.deps.sleep(MOVE_POLL_MS)) {
      if (this.stopped || !current()) {
        return;
      }

      if (this.deps.now() >= until) {
        this.deps.log(`session ${action.sessionId} stays in its tab: process ${action.pid} did not exit within ${MOVE_EXIT_MS / 1000} seconds`);
        this.send({ type: 'move-cancelled', sessionId: action.sessionId, moveId: action.moveId });
        return;
      }
    }

    const runner = this.runners[action.provider];

    if (this.stopped || !current() || runner.resume === undefined) {
      return;
    }

    const deadline = this.deps.now() + RESUME_CONFIRM_MS;

    this.send({ type: 'move-launching', sessionId: action.sessionId, moveId: action.moveId, deadline });

    const launched = await runner.resume(action.nativeSessionId, action.prompt, action.cwd);

    if ('copy' in launched && launched.copy !== null) {
      const failure = await runner.stop({ sessionId: action.sessionId, shortId: launched.copy }, 'operator');
      const stopped = failure === null ? 'and Switchboard stopped it' : `and stopping it failed: ${failure.error}`;

      if (this.stopped) {
        this.deps.log(`session ${action.sessionId}: Claude started a copy as ${launched.copy} instead of resuming it, ${stopped}`);
        return;
      }

      this.resumeResult(action.sessionId, action.moveId, { failed: `Claude started a copy as ${launched.copy} instead of resuming the session, ${stopped}.` });
      return;
    }

    await this.confirmResume(action.sessionId, action.moveId, action.nativeSessionId, deadline, 'error' in launched ? launched.error : null);
  }

  /**
   * Waits until the roster lists the session in its background process with a pid, or the deadline passes. A failed read, or an entry with no pid
   * yet, decides nothing, because a launch takes seconds to list its pid (mechanics M5).
   */
  private async confirmResume(sessionId: string, moveId: string, nativeSessionId: string, deadline: number, launchError: string | null): Promise<void> {
    const runner = this.runners.claude;

    for (;;) {
      const listed = runner.background === undefined ? null : await runner.background(nativeSessionId);

      if (this.stopped) {
        return;
      }

      // A process listed after the deadline still runs the session, so it is taken rather than left running unseen.
      if (listed !== null && 'shortId' in listed) {
        this.resumeResult(sessionId, moveId, { shortId: listed.shortId });
        return;
      }

      if (this.deps.now() >= deadline) {
        this.resumeResult(sessionId, moveId, { failed: launchError ?? `The session did not appear in claude agents within ${RESUME_CONFIRM_MS / 1000} seconds.` });
        return;
      }

      await this.deps.sleep(RESUME_POLL_MS);
    }
  }

  /** Sends the resume's result; a process started for a move that Delete ended belongs to no work item, so it is stopped. */
  private resumeResult(sessionId: string, moveId: string, result: { shortId: string } | { failed: string }): void {
    if ('shortId' in result && this.deps.store.session(sessionId)?.move?.id !== moveId) {
      this.deps.log(`session ${sessionId} resumed in the background as ${result.shortId} after its move ended; stopping it`);
      this.track(
        this.runners.claude.stop({ sessionId, shortId: result.shortId }, 'operator').then((failure) => {
          if (failure !== null) {
            this.deps.log(`stop of ${result.shortId} failed; it may still be running: ${failure.error}`);
          }
        }),
      );
      return;
    }

    this.send('shortId' in result ? { type: 'session-resumed', sessionId, moveId, shortId: result.shortId } : { type: 'resume-failed', sessionId, moveId, message: result.failed });
  }

  /** After a restart (PRD R89): a move still waiting runs again from the wait, and a launch is never repeated, only confirmed by its deadline. */
  private resumeMoves(): void {
    for (const session of this.deps.store.activeSessions()) {
      const move = session.move;

      if (move === null || session.nativeSessionId === null) {
        continue;
      }

      if (move.phase === 'waiting') {
        this.track(this.resumeSession({ type: 'resume-session', sessionId: session.id, moveId: move.id, provider: session.provider, nativeSessionId: session.nativeSessionId, cwd: session.cwd, pid: move.pid, prompt: RESUME_PROMPT }));
      } else {
        this.track(this.confirmResume(session.id, move.id, session.nativeSessionId, move.deadline ?? this.deps.now(), null));
      }
    }
  }

  /**
   * A ticket report (PRD R83): moves the session's ad-hoc work item onto the ticket at `url`, which an enabled source reads, and answers the
   * work item's key and the session's report contract, again for a retry. A lookup that fails or takes longer than REPORT_CHECK_MS refuses,
   * because the move needs the ticket's title and state.
   */
  async ticket(sessionId: string, url: string, playbook: string | null, nativeSessionId: string | null = null): Promise<{ key: string; contract: string } | { refused: string }> {
    const fields = { kind: 'ticket', url, playbook };
    const refuse = (refused: string) => {
      this.refuseReport(sessionId, fields, refused);

      return { refused };
    };
    const retired = () => (nativeSessionId === null ? null : this.retiredCopy(sessionId, nativeSessionId));
    const early = retired();

    if (early !== null) {
      return refuse(early);
    }

    if (this.deps.store.session(sessionId) === null) {
      return refuse(`Unknown session ${sessionId}.`);
    }

    let found: { source: string; reader: Source; lookup: TicketLookup } | null = null;

    for (const [name, source] of [...this.sources]) {
      const lookup = source.ticketAt === undefined ? null : await Promise.race([source.ticketAt(url).catch((error: unknown) => ({ error: String(error) })), this.deps.sleep(REPORT_CHECK_MS).then(() => ({ error: `${name} did not answer within ${REPORT_CHECK_MS / 1000} seconds.` }))]);

      if (lookup !== null) {
        found = { source: name, reader: source, lookup };
        break;
      }
    }

    if (found === null) {
      return refuse(`No enabled source has a ticket at ${url}.`);
    }

    if ('error' in found.lookup) {
      return refuse(found.lookup.error);
    }

    const ticket = found.lookup.ticket;

    if (!ticket.open) {
      return refuse(`${ticket.ref} is closed.`);
    }

    const later = retired();

    if (later !== null) {
      return refuse(later);
    }

    // A source turned off or reconfigured during the lookup may no longer read the repository the ticket came from.
    if (this.sources.get(found.source) !== found.reader) {
      return refuse(`The ${found.source} source changed during the lookup. Send the report again.`);
    }

    const { refused } = this.send({ type: 'ticket', sessionId, source: found.source, sourceKey: ticket.sourceKey, ref: ticket.ref, title: ticket.title, url: ticket.url, playbook });

    if (refused !== null) {
      return { refused };
    }

    const session = this.deps.store.session(sessionId)!;

    return { key: `${found.source} ${ticket.sourceKey}`, contract: sessionContract(session.id, this.reportCommand, session.reports, session.provider) };
  }

  private async assignmentRead(source: Source, url: string) {
    if (source.assignmentAt === undefined) return null;
    return Promise.race([
      source.assignmentAt(url).catch((error: unknown) => ({ error: String(error) })),
      this.deps.sleep(REPORT_CHECK_MS).then(() => ({ error: 'The assignment read timed out. Retry the report or poll.' })),
    ]);
  }

  async handled(sessionId: string, url: string, releaseKey: string | null, nativeSessionId: string | null = null): Promise<{ assignmentKey: string | null } | { refused: string }> {
    const refuse = (refused: string) => {
      this.refuseReport(sessionId, { kind: 'handled', url, releaseKey }, refused);
      return { refused };
    };
    for (const [name, source] of [...this.sources]) {
      const result = await this.sourceOperation(name, async () => {
        const lookup = await this.assignmentRead(source, url);
        if (lookup === null) return null;
        if ('error' in lookup) return refuse(lookup.error);
        if (this.stopped || this.sources.get(name) !== source) return refuse(`The ${name} source changed during the lookup. Retry the report.`);
        const retired = nativeSessionId === null ? null : this.retiredCopy(sessionId, nativeSessionId);
        if (retired !== null) return refuse(retired);
        if (releaseKey === null && (!lookup.ticket.open || lookup.assignmentKey === null)) return refuse('Registration requires an open ticket assigned to the operator.');
        const key = releaseKey ?? lookup.assignmentKey!;
        const { refused } = this.send({ type: 'handled', sessionId, source: name, ...lookup.ticket, url: lookup.ticket.url, key, release: releaseKey !== null, assigned: lookup.assigned });
        return refused === null ? { assignmentKey: releaseKey === null ? key : null } : { refused };
      });
      if (result !== null) return result;
    }
    return refuse('No enabled source supports assignments for this ticket URL.');
  }

  /**
   * A report from the `report` command, from the Claude copy `nativeSessionId` names when the command knows it. A worktree must be one
   * `git worktree list` shows in that path.
   */
  async report(body: ReportBody, nativeSessionId: string | null = null): Promise<{ refused: string | null }> {
    // Checked again before the report is applied, because a roster read can continue the session as a fork during the checks.
    const retired = () => {
      const refused = nativeSessionId === null ? null : this.retiredCopy(body.sessionId, nativeSessionId);

      if (refused !== null) {
        const { sessionId: _sessionId, ...fields } = body;
        this.refuseReport(body.sessionId, fields, refused);
      }

      return refused;
    };
    const early = retired();

    if (early !== null) {
      return { refused: early };
    }

    if (body.kind === 'worktree') {
      const worktree = await reportedWorktree(body.path, this.deps.exec);

      if (worktree === null) {
        const refused = `${body.path} is not a git worktree.`;

        this.refuseReport(body.sessionId, { kind: 'worktree', path: body.path }, refused);

        return { refused };
      }

      return { refused: retired() ?? this.send({ type: 'report', sessionId: body.sessionId, report: { kind: 'worktree', path: worktree.path, branch: worktree.branch } }).refused };
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

    const late = retired();

    if (late !== null) {
      return { refused: late };
    }

    const refused = this.send({ type: 'report', sessionId: body.sessionId, report }).refused;

    if (body.kind === 'done') {
      this.recheckDoneReports();
    }

    return { refused };
  }

  snapshot(): Snapshot {
    const store = this.deps.store;
    const { settings, playbooks, settingsError, playbookErrors } = this.config;
    const enabled = this.enabledSources();
    // Returned counts earlier work items with the same playbook, or one it is a return of, that started a session; a failed launch has no shortId.
    const started = (item: WorkItem) => store.sessionsFor(item.id).some((session) => session.shortId !== null);
    const returned = (items: WorkItem[], playbook: string | null, ticket: Ticket) => {
      // A schedule's runs repeat by design, so they are not returns (PRD R82).
      if (playbook === null || ticket.source === SCHEDULE_SOURCE) {
        return 0;
      }

      const counted = new Set([playbook, ...(playbooks.get(playbook)?.returnOf ?? [])]);

      return items.filter((item) => item.playbook !== null && counted.has(item.playbook) && started(item)).length;
    };
    const used = heldSlots(store);

    return {
      workItems: store.workItems(doneSince(this.deps.now())).map((item) => {
        const ticket = store.ticket(item.ticketId)!;
        const triages = store.triagesFor(item.id);

        return {
          ...item,
          ticket,
          triage: triages.at(-1) ?? null,
          focus: effectiveFocus(triages, ticket.url),
          sessions: store.sessionsFor(item.id),
          worktree: store.worktreeFor(item.ticketId),
          links: store.linksFor(item.ticketId),
          pastes: store.pastesFor(item.id),
          comments: store.commentsFor(item.id),
          returned: returned(store.workItemsForTicket(item.ticketId).filter((other) => other.id < item.id), item.playbook, ticket),
          parent: item.parentId === null ? null : store.ticket(store.workItem(item.parentId)!.ticketId),
          moved: ticket.adhocKey !== null && store.workItemsForTicket(item.ticketId)[0]?.id === item.id,
          approvalSends: item.playbook !== null && playbooks.get(item.playbook)?.approvalSends === true,
          waits: item.status === 'queued' ? queueWaits(store, item, settings.sessions.concurrency, used) : [],
          reopenable: reopenRefusal(item, store.workItemsForTicket(item.ticketId), ticket) === null,
          playbookChoices: item.status === 'unstarted' ? playbookChoices(item.playbook, ticket.source, playbooks) : [],
        };
      }),
      pool: store
        .poolTickets()
        .map((ticket) => ({ ticket, items: store.workItemsForTicket(ticket.id) }))
        // A disabled source's pool is not read, so its tickets are not shown.
        .filter(({ ticket, items }) => this.sources.has(ticket.source) && items.every((item) => item.status === 'done'))
        .map(({ ticket, items }) => {
          const triages = store.poolTriages(ticket.id);
          const triage = triages.at(-1) ?? null;

          return { ticket, triage, focus: effectiveFocus(triages, ticket.url), links: store.linksFor(ticket.id), returned: returned(items, triage?.playbook ?? null, ticket), playbookChoices: playbookChoices(triage?.playbook ?? null, ticket.source, playbooks) };
        }),
      playbooks: [...playbooks.values()].filter((playbook) => playbook.kind === 'task').map(({ name, description }) => ({ name, description })),
      repoRoots: repoRoots(settings),
      schedules: Object.entries(settings.schedules).map(([name, schedule]) => ({ name, playbook: schedule.playbook })),
      sources: [...this.sources.keys()],
      sourceStates: Object.entries(settings.sources)
        .filter(([name]) => name !== ADHOC_SOURCE)
        .map(([name]) => ({ name, enabled: enabled.has(name) })),
      namespaces: Object.fromEntries(Object.entries(settings.sources).map(([name, source]) => [name, source.namespace])),
      openVSCode: settings.dock.openVSCode,
      configDir: this.deps.configDir,
      errors: {
        settings: settingsError,
        playbooks: playbookErrors.map((entry) => `${entry.name}: ${entry.error}`),
        hooks: [this.nodeError, ...PROVIDERS.map((provider) => this.hookErrors[provider])].filter((error) => error !== null).join(' ') || null,
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
      const ticket = key === null ? null : this.deps.store.findTicket(name, key);

      // The flow links only a ticket without a worktree, and each event rebuilds the views, so a linked ticket gets none.
      if (key !== null && ticket !== null && this.deps.store.worktreeFor(ticket.id) === null) {
        this.send({ type: 'worktree-found', source: name, sourceKey: key, path: worktree.path, branch: worktree.branch! });
      }
    }
  }

  private async run(action: FlowAction): Promise<void> {
    switch (action.type) {
      case 'triage': {
        const provider = this.config.settings.sessions.provider;
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

        const stale = nothingNew(action.handled, context.activityAt);
        const text = triageText(context.context, this.deps.now(), action.handled, stale);
        const model = triageModel(provider, action.model);
        if (model !== action.model) {
          this.deps.log(`Triage model ${action.model} does not match ${provider}; using its default model.`);
        }
        const input = {
          systemPrompt: action.systemPrompt,
          choices: action.choices,
          rates: action.rates,
          focusIds: (context.anchors ?? []).map((anchor) => anchor.id),
          context: text,
          model,
          timeoutSeconds: action.timeoutSeconds,
          cwd: this.home,
        };
        const result = provider === 'codex'
          ? await classifyCodex({
              ...input,
              codexPath: this.config.settings.sessions.codexPath,
              env: this.deps.codex?.env ?? {},
              configPath: join(this.deps.codex?.home ?? join(this.deps.home, '.codex'), 'config.toml'),
            }, this.deps.exec)
          : await classify({ ...input, claudePath: this.config.settings.sessions.claudePath, settingsPath: this.deps.claudeSettings }, this.deps.exec);


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
                model,
                links: context.links ?? [],
                focus: result.focus,
                anchors: context.anchors ?? [],
                stale,
              },
        );
        return;
      }
      case 'start-session': {
        const result = await this.runners[action.provider].start(action);

        this.send(
          'error' in result
            ? { type: 'session-start-failed', sessionId: action.sessionId, message: result.error }
            : { type: 'session-started', sessionId: action.sessionId, nativeSessionId: result.nativeSessionId, shortId: result.shortId, ...(result.startPrompt ? { startPrompt: true as const } : {}) },
        );
        return;
      }
      case 'resume-session':
        return this.resumeSession(action);
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

        this.send(
          failure === null
            ? { type: 'stop-succeeded', sessionId: action.sessionId, reason: action.reason, shortId: action.shortId }
            : { type: 'stop-failed', sessionId: action.sessionId, reason: action.reason, message: failure.error, shortId: action.shortId },
        );
        return;
      }
    }
  }
}

/** Claude's project directory name for a working directory, ignoring case. */
function projectOf(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
}

/**
 * The source's triage context led by the current UTC time, in the form sources use, so triage can judge how recent each event is, then by
 * the earlier work item's handling, saying when `stale` that nothing is newer (PRD R80).
 */
export function triageText(context: string, now: number, handled: HandledWork | null = null, stale = false): string {
  const earlier = handled === null ? '' : `Earlier work: ${handled.playbook === null ? 'a work item' : `a ${handled.playbook} work item`} for this ticket handled the activity up to ${utc(handled.at)} UTC, so that activity is background.`;
  const note = earlier === '' ? '' : `${earlier}${stale ? ' Nothing from anyone else in the activity below is newer, so nothing new asks for an action.' : ''}\n\n`;

  return `Current time: ${utc(now)} UTC\n\n${note}${context}`;
}

function utc(time: number): string {
  return new Date(time).toISOString().slice(0, 16).replace('T', ' ');
}
