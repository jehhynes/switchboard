import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { classify, ClaudeRunner, findTranscript, CodeModeRunner, conversationRules, HOOKS_REQUIRED, readRoster } from '@switchboard/claude';
import { classifyCodex, CodexRunner } from '@switchboard/codex';
import type { Exec } from '@switchboard/claude';
import type { FlowAction, FlowEvent, FlowResult, HandledWork, MarkerReading, ObservedFork, ObservedSession, PolledTicket, Provider, Session, SessionRunner, Source, SourceSettings, Store, Ticket, TicketLookup, Triage, Worktree } from '@switchboard/core';
import { activeSession, ADHOC_SOURCE, artifactsDir, awaitsRecheck, RESUME_PROMPT, executableDirOnPath, handle, launchOptions, nothingNew, PROVIDERS, recordRefusal, homeRepo, repoOf, sessionName, ticketRoot, sessionContract, switchboardHome, triageModel } from '@switchboard/core';
import { noKind } from './config.js';
import type { Config } from './config.js';
import { listWorktrees, reportedWorktree } from './git.js';
import { HolderError, recordPath } from '@switchboard/holder';
import { NotWritten } from '@switchboard/conversation';
import type { SessionEntry } from '@switchboard/holder';
import { findHeld, heldFromHolder } from './held.js';
import type { HeldSession } from './held.js';
import { HolderLink } from './holder.js';
import type { HolderLinkDeps } from './holder.js';
import { buildSnapshot } from './snapshot.js';
import type { Snapshot, SnapshotInputs } from './snapshot.js';

export { buildSnapshot, repoKeysOf } from './snapshot.js';
export type { PoolView, Snapshot, SnapshotInputs, WorkItemView } from './snapshot.js';

const NOT_SWITCHBOARD = "This session is not one of Switchboard's work items.";
const NEVER_BACKGROUND = 'This session never ran in the background, so it cannot continue there.';

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
/** Time the window's close leaves the tab's process to exit before the wait gives up; it exited within 4.4 seconds (mechanics M55). */
const MOVE_CLOSE_MARGIN_MS = 10_000;
/** How long a resumed session may take to be listed in its background process with a pid, as for a start. */
export const RESUME_CONFIRM_MS = 60_000;
const RESUME_POLL_MS = 2_000;
/** How long `<sessions.nodePath> --version` may take. */
const NODE_CHECK_TIMEOUT_MS = 10_000;
/** How long input to a held session after its turn defers its end, for the prompt's marker to be read. */
export const INPUT_SETTLE_MS = 60_000;
/** Why a message cannot be typed into a session (architecture.md § Typing a message). */
export const SESSION_ENDED = 'The session has ended. Open it in the terminal to resume it.';
export const SESSION_RELAUNCHED = 'The session was resumed since the view showed it; send the message again.';
/** Why a held session cannot be typed into: its holder is from an older build; `stopAll` is the command that replaces it (`hub.js holder stop --all`). */
export function holderCannotType(stopAll: string): string {
  return `The terminal holder is from an older build and cannot type. To switch to this build, run ${stopAll} in a terminal: it lists the sessions that end with the holder, each of which can be resumed, and ends them when run again with --yes. Until then, open the session in the terminal.`;
}
/** How long `POST /attach` defers a held session's end for its client to connect (architecture.md § Code Mode sessions). */
export const ATTACH_RESERVATION_MS = 15_000;

/** `POST /attach`'s answer: the holder to connect to and the session to attach, or why not, with its HTTP status. */
export type AttachResult = { port: number; token: string; session: string } | { refused: string; status: 404 | 409 };

/** A runner per agent, and the Code Mode runner for Claude sessions held in the terminal holder (PRD R93). */
export type RunnerKey = Provider | 'codeMode';
const RUNNER_KEYS: readonly RunnerKey[] = [...PROVIDERS, 'codeMode'];

function runnerKey(session: { provider: Provider; codeMode?: boolean }): RunnerKey {
  return session.codeMode === true ? 'codeMode' : session.provider;
}

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
  runners?: Partial<Record<RunnerKey, SessionRunner>>;
  /** Whether a process runs; a stand-in for tests. */
  alive?(pid: number): boolean;
  log(line: string): void;
  /** The Code Mode idle limit, shorter than the default for tests and live acceptance (`--code-mode-idle-ms`). */
  codeModeIdleMs?: number;
  /** Stand-ins for the holder link's connection, lock check and start, for tests. */
  holder?: Partial<Pick<HolderLinkDeps, 'connect' | 'lockHeld' | 'launch'>>;
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
  /** What each source's last poll left out, such as an issue another source owns (PRD R44). */
  private sourceNotes: Record<string, string[]> = {};
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
  /** One runner per agent, chosen by each session's provider (PRD R22), and one for Code Mode sessions (PRD R93). */
  private readonly runners: Record<RunnerKey, SessionRunner>;
  /** The terminal holder of this home, connected on first use (PRD R94). */
  private readonly holder: HolderLink;
  /** Code Mode sessions whose end runs now, so a retry does not end one twice and an attach waits for it (PRD R95). */
  private readonly ending = new Map<string, Promise<void>>();
  /** Attach reservations: until when each defers its session's end, for the client to connect (PRD R95). */
  private readonly reservations = new Map<string, number>();
  /** Input reservations: how many messages each session's conversation is typing, which defer its end as a terminal does (architecture.md § Typing a message). */
  private readonly inputs = new Map<string, number>();
  /** Sessions whose resume spawn runs now; roster reads leave them out (PRD R95). */
  private readonly resuming = new Set<string>();
  /** The attach in flight per session, which concurrent attaches share, so a session is never resumed twice. */
  private readonly attaching = new Map<string, Promise<AttachResult>>();
  /** Code Mode sessions whose end waits for an attached terminal, logged once each. */
  private readonly deferred = new Set<string>();
  /** The holder's last list (PRD R94); a failed read keeps it. */
  private heldEntries: SessionEntry[] = [];
  private heldError: string | null = null;
  /** Orphans logged, so each is logged once. */
  private readonly orphansLogged = new Set<string>();
  /** The leftover pids the resume guard last refused an attach for, per ended Code Mode session, until a resume or a leftover stop succeeds (PRD R95). */
  private readonly guarded = new Map<string, number[]>();

  constructor(
    private readonly deps: RuntimeDeps,
    config: Config,
  ) {
    this.config = config;
    this.holder = new HolderLink({ home: this.home, nodePath: () => this.config.settings.sessions.nodePath, log: (line) => deps.log(line), now: deps.now, sleep: deps.sleep, gone: () => this.holderGone(), ...deps.holder });

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
      codeMode:
        deps.runners?.codeMode ??
        new CodeModeRunner({
          claudePath,
          home: this.home,
          hooks,
          holder: (start) => this.holder.find(start),
          transcriptExists: (cwd, nativeSessionId) => findTranscript(join(dirname(deps.claudeSettings), 'projects'), cwd, nativeSessionId) !== null,
          now: deps.now,
          sleep: deps.sleep,
          ...(deps.codeModeIdleMs === undefined ? {} : { idleMs: deps.codeModeIdleMs }),
          // Confirms a held process's new session ID after /clear, /branch or /resume (mechanics M67).
          roster: async () => {
            const roster = await readRoster(claudePath(), deps.exec);

            return 'error' in roster ? roster : roster.entries.map((entry) => ({ sessionId: entry.sessionId, ...(entry.pid === undefined ? {} : { pid: entry.pid }) }));
          },
        }),
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

  /** The command that ends the terminal holder and its sessions, so the next session starts the installed build. */
  get holderStopCommand(): string {
    return `${this.config.settings.sessions.nodePath} "${this.home.replaceAll('\\', '/')}/hub.js" holder stop --all`;
  }

  /** The connected holder's `welcome`, for `POST /holder/list`; null while none is connected. */
  heldHolder(): { protocol: number; build: string; pid: number; features?: string[] } | null {
    return this.holder.connected()?.welcome ?? null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  /** Applies one event in one transaction and starts its actions. */
  send(event: FlowEvent): FlowResult {
    const { settings, playbooks } = this.config;
    const result = this.deps.store.transaction(() =>
      handle(this.deps.store, event, { now: this.deps.now(), settings, playbooks, report: this.reportCommand, newSessionId: this.deps.newSessionId, newUuid: randomUUID }),
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
    for (const key of RUNNER_KEYS) {
      const own = starting.filter((session) => runnerKey(session) === key);

      for (const result of own.length === 0 ? [] : await this.runners[key].reconcile(own)) {
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
    this.holder.close();
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
        const assignment = await this.assignmentRead(source, ticket.url, true);
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
        else result.tickets.push({ sourceKey: ticket.sourceKey, ref: assignment.ticket.ref, repo: assignment.ticket.repo, title: assignment.ticket.title, url: assignment.ticket.url, sourceId: ticket.sourceId, assigned: assignment.assigned, pool: false, sortAt: ticket.sortAt, enteredAt: null });
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

    // An issue on two boards belongs to the source that stored it first (PRD R44). Checked after the last await, so another source's poll
    // cannot store the issue between this check and this poll's event.
    const notes: string[] = [];

    result.tickets = result.tickets.filter((entry) => {
      const owner = entry.url === '' ? null : this.deps.store.ticketByUrl(entry.url);

      if (owner !== null && owner.source !== name) {
        notes.push(`${entry.url} belongs to ${owner.source}.`);
        return false;
      }

      return true;
    });

    delete this.sourceErrors[name];
    this.sourceNotes[name] = notes;
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
    await this.readSessions();
    await this.readHeld();
  }

  private async readSessions(): Promise<void> {
    if (this.unreconciled.size > 0) {
      await this.reconcile(this.deps.store.activeSessions().filter((session) => session.state === 'starting' && this.unreconciled.has(session.id)));
    }

    // A session being resumed has no launch the read could tell its new process by, so the read leaves it to the next one (PRD R95).
    const sessions = this.deps.store.startedSessions().filter((session) => !this.resuming.has(session.id));

    if (sessions.length === 0) {
      return;
    }

    // Worktree discovery runs first, so the hook markers the roster read takes in are as fresh as the event it sends.
    await this.findSetupWorktrees();

    const observed: ObservedSession[] = [];
    const forks: ObservedFork[] = [];
    const checked: string[] = [];
    // Sessions of a terminal holder that is gone, and held sessions past the idle limit (PRD R94, R95).
    const lost: string[] = [];
    const idle: string[] = [];
    // A question reported, or a move to the background begun or ended, while the reads ran makes their result stale for that session, which the
    // next read decides (PRD R70, R89). A held session resumed, or being resumed, meanwhile is left to the next timed read and its markers (PRD R95).
    // Checked once all providers' reads are done, since the event applies them together.
    const marks = (session: Session | null) => `${session?.question?.id ?? ''}|${session?.move?.id ?? ''}|${session?.movedAt ?? ''}`;
    const asked = new Map(sessions.map((session) => [session.id, marks(session)]));
    const launches = new Map(sessions.map((session) => [session.id, session.launchId ?? null]));
    const endedBefore = new Set(sessions.filter((session) => session.state === 'ended').map((session) => session.id));

    for (const key of RUNNER_KEYS) {
      const own = sessions.filter((session) => runnerKey(session) === key);

      // Only a resume through the holder revives an ended Code Mode session, so ended ones need no holder read.
      if (own.length === 0 || (key === 'codeMode' && own.every((session) => session.state === 'ended'))) {
        continue;
      }

      const roster = await this.runners[key].observe(own);

      // A failed read changes none of the provider's sessions.
      if ('error' in roster) {
        this.deps.log(`${key} roster read failed: ${roster.error}`);
        continue;
      }

      // Interrupted work ends with the cause, not through the roster's end path (PRD R94).
      if (roster.gone === true) {
        lost.push(...own.filter((session) => session.state !== 'ended').map((session) => session.id));
        continue;
      }

      idle.push(...(roster.idle ?? []));
      observed.push(...roster.sessions);
      forks.push(...(roster.forks ?? []));
      checked.push(...own.map((session) => session.id));
    }

    const stale = new Set(sessions.filter((session) => marks(this.deps.store.session(session.id)) !== asked.get(session.id)).map((session) => session.id));

    if (stale.size > 0) {
      this.rosterAgain = true;
    }

    for (const session of sessions) {
      const now = this.deps.store.session(session.id);

      // A session that ended during the read, as by Stop, was read live before its end, so the read says nothing about it.
      if (this.resuming.has(session.id) || (now?.launchId ?? null) !== launches.get(session.id) || (now?.state === 'ended' && !endedBefore.has(session.id))) {
        stale.add(session.id);
      }
    }

    const fresh = checked.filter((id) => !stale.has(id));

    // Only a session already ended when the read began can be one a stopped hub resumed.
    for (const entry of observed.filter((one) => !stale.has(one.sessionId) && endedBefore.has(one.sessionId))) {
      this.reviveHeld(entry.sessionId);
    }

    if (fresh.length > 0) {
      const filteredForks = forks.filter((fork) => !stale.has(fork.sessionId));

      this.send({ type: 'roster', sessions: observed.filter((entry) => !stale.has(entry.sessionId)), checked: fresh, ...(filteredForks.length > 0 ? { forks: filteredForks } : {}) });
    }

    for (const sessionId of lost.filter((id) => !stale.has(id))) {
      this.deps.log(`session ${sessionId} ended: the terminal holder stopped`);
      this.send({ type: 'holder-lost', sessionId });
    }

    for (const sessionId of idle.filter((id) => !stale.has(id))) {
      this.send({ type: 'held-idle', sessionId });
    }

    // An end deferred while a terminal is attached, including one a stopped hub left, is tried again (PRD R95).
    for (const session of this.deps.store.activeSessions()) {
      if (session.codeMode === true && session.releasing && !session.released && !this.ending.has(session.id)) {
        this.track(this.run({ type: 'stop-session', sessionId: session.id, provider: session.provider, shortId: session.shortId, reason: 'release', codeMode: true }));
      }
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

    for (const key of RUNNER_KEYS) {
      for (const [id, reading] of this.runners[key].markers(started.filter((session) => runnerKey(session) === key))) {
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

    // A Code Mode session follows only its own held process's ID changes, which a roster read adopts (PRD R93).
    if (session.codeMode === true) {
      void this.readRoster();

      return `Session ${nativeSessionId.slice(0, 8)} is not the session Switchboard started, so the report was not recorded.`;
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
  contract(nativeSessionId: string, source: 'compact' | 'resume' = 'compact'): string | null {
    const session = this.deps.store.sessionByNativeId(nativeSessionId) ?? this.runners.claude.forkOf?.(nativeSessionId, this.deps.store.startedSessions().filter((one) => one.codeMode !== true)) ?? null;

    // A resume keeps the prompt the session started with, contract included; only a Code Mode session gets the current conversation rules.
    if (session === null || (source === 'resume' && session.codeMode !== true)) {
      return null;
    }

    if (source === 'resume') {
      this.deps.log(`gave session ${session.id} the conversation rules on resume`);

      return conversationRules(artifactsDir(session.cwd, session.workItemId));
    }

    this.deps.log(`restored the report contract of session ${session.id} after compaction`);

    const contract = sessionContract(session.id, this.reportCommand, session.reports, session.provider);

    return session.codeMode === true ? `${contract}\n\n${conversationRules(artifactsDir(session.cwd, session.workItemId))}` : contract;
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

    const family = this.deps.store.startedSessions().find((session) => session.provider === 'claude' && (session.retiredIds.includes(nativeSessionId) || (session.codeMode !== true && (this.runners.claude.relation?.(nativeSessionId, session) ?? 'unrelated') !== 'unrelated')));

    if (family !== undefined) {
      return { refused: `This session is a copy of ${keyOf(family)}, which Switchboard continues in its latest copy.` };
    }

    // After /clear, /branch or /resume in a held session's terminal its new ID is followed there, not registered (PRD R81, R93).
    const held = this.runners.codeMode.heldBy?.(nativeSessionId, this.deps.store.activeSessions()) ?? null;

    if (held !== null) {
      return { refused: `This session runs in the terminal holder for ${keyOf(held)}, which Switchboard follows there.` };
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
   * Continue in Background (PRD R89): finds the session in the Claude tab labelled `label` of the window whose extension host is `hostPid`, which
   * must belong to one of `workItemIds`, and starts its move. A long label is cut, so the tab's process, a child of that extension host, tells it
   * apart from other sessions the label may name. It answers once the flow has stored the move with that process, so the window closes the tab
   * only after that.
   */
  async background(label: string | null, hostPid: number, workItemIds: number[]): Promise<{ refused: string } | { pid: number }> {
    const runner = this.runners.claude;
    const tab = runner.tab === undefined ? { error: 'The Claude runner cannot move sessions.' } : await runner.tab(label, hostPid);

    if ('error' in tab) {
      return { refused: tab.error };
    }

    if (tab.others > 0) {
      return { refused: 'Another Claude session runs in this window; closing the window would end it.' };
    }

    if (tab.candidates.length > 1) {
      return {
        refused:
          label === null
            ? 'Several Claude sessions run in this window, so Switchboard cannot tell which one the sidebar holds.'
            : `Several Claude sessions in this window are named "${label}", so Switchboard cannot tell which one this tab holds.`,
      };
    }

    const [found] = tab.candidates;
    const session = found === undefined ? null : this.deps.store.sessionByNativeId(found.nativeSessionId);

    if (found === undefined || session === null || !workItemIds.includes(session.workItemId)) {
      return { refused: NOT_SWITCHBOARD };
    }

    if (!found.background) {
      return { refused: NEVER_BACKGROUND };
    }

    const { refused } = this.send({ type: 'background', sessionId: session.id, nativeSessionId: found.nativeSessionId, pid: found.pid, busy: found.busy, workItemIds });

    return refused === null ? { pid: found.pid } : { refused };
  }

  /**
   * Whether the window may close: the moving process `pid` is still the window's only live Claude session, so a session opened in the window while
   * the hub answered does not end with it, and its move still waits with time left for the process to exit before the wait gives up (PRD R89).
   */
  async windowAlone(hostPid: number, pid: number): Promise<boolean | { error: string }> {
    const pending = () => this.deps.store.movingSessions().some((session) => session.move?.pid === pid && session.move.phase === 'waiting' && this.deps.now() - session.move.at < MOVE_EXIT_MS - MOVE_CLOSE_MARGIN_MS);

    if (!pending()) {
      return { error: 'The move is no longer waiting for the window to close.' };
    }

    const runner = this.runners.claude;
    const window = runner.tab === undefined ? { error: 'The Claude runner cannot move sessions.' } : await runner.tab(null, hostPid);

    if ('error' in window) {
      return window;
    }

    return pending() ? window.candidates.length === 1 && window.candidates[0]!.pid === pid : { error: 'The move is no longer waiting for the window to close.' };
  }

  /** Waits for the tab's process to exit, then resumes the session in its background process, unless Stop or Delete ended the move first. */
  private async resumeSession(action: Extract<FlowAction, { type: 'resume-session' }>): Promise<void> {
    const alive = this.deps.alive ?? processAlive;
    const current = () => this.deps.store.session(action.sessionId)?.move?.id === action.moveId;

    // A stopped hub has closed the store; the move stays stored, and the next hub's startup continues it.
    for (const until = (this.deps.store.session(action.sessionId)?.move?.at ?? this.deps.now()) + MOVE_EXIT_MS; alive(action.pid); await this.deps.sleep(MOVE_POLL_MS)) {
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
    for (const session of this.deps.store.movingSessions()) {
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

    const { sources, refusal } = this.byOwner(url);

    if (refusal !== null) {
      return refuse(refusal);
    }

    for (const [name, source] of sources) {
      const lookup = source.ticketAt === undefined ? null : await Promise.race([source.ticketAt(url).catch((error: unknown) => ({ error: String(error) })), this.deps.sleep(REPORT_CHECK_MS).then(() => ({ error: `${name} did not answer within ${REPORT_CHECK_MS / 1000} seconds.` }))]);

      if (lookup !== null) {
        found = { source: name, reader: source, lookup };
        break;
      }
    }

    if (found === null) {
      return refuse(`No enabled source has ${url} on its board.`);
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

    const { refused } = this.send({ type: 'ticket', sessionId, source: found.source, sourceKey: ticket.sourceKey, ref: ticket.ref, repo: ticket.repo, title: ticket.title, url: ticket.url, playbook });

    if (refused !== null) {
      return { refused };
    }

    const session = this.deps.store.session(sessionId)!;

    return { key: `${found.source} ${ticket.sourceKey}`, contract: sessionContract(session.id, this.reportCommand, session.reports, session.provider) };
  }

  private async assignmentRead(source: Source, url: string, anyBoard = false) {
    if (source.assignmentAt === undefined) return null;
    return Promise.race([
      source.assignmentAt(url, anyBoard).catch((error: unknown) => ({ error: String(error) })),
      this.deps.sleep(REPORT_CHECK_MS).then(() => ({ error: 'The assignment read timed out. Retry the report or poll.' })),
    ]);
  }

  async handled(sessionId: string, url: string, releaseKey: string | null, nativeSessionId: string | null = null): Promise<{ assignmentKey: string | null } | { refused: string }> {
    const refuse = (refused: string) => {
      this.refuseReport(sessionId, { kind: 'handled', url, releaseKey }, refused);
      return { refused };
    };
    const { sources, owner, refusal } = this.byOwner(url);
    if (refusal !== null) return refuse(refusal);
    for (const [name, source] of sources) {
      const result = await this.sourceOperation(name, async () => {
        // The owning source reads its ticket on any board, so a registered issue that left the board can still be released.
        const lookup = await this.assignmentRead(source, url, name === owner);
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
    return refuse(`No enabled source has ${url} on its board.`);
  }

  /**
   * The enabled sources, the one that already stores a ticket at `url` first, so an issue on two boards stays with it (PRD R44, R83, R85), or
   * why none may answer: the owner is configured but off, and another source would store the issue a second time.
   */
  private byOwner(url: string): { sources: [string, Source][]; owner: string | undefined; refusal: string | null } {
    const owner = this.deps.store.ticketByUrl(url)?.source;
    const off = owner !== undefined && this.config.settings.sources[owner] !== undefined && !this.sources.has(owner);

    return {
      sources: [...this.sources].sort(([a], [b]) => Number(b === owner) - Number(a === owner)),
      owner,
      refusal: off ? `${url} belongs to ${owner}, which is off. Turn it on in the header.` : null,
    };
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
    return buildSnapshot(this.deps.store, this.snapshotInputs());
  }

  /**
   * A held session's screen with its attributes, for the conversation layer's screen copy (architecture.md § Conversation), through the
   * connection the roster reads keep; null without one, or from a holder that does not serve snapshots. It never looks for or starts a holder.
   */
  async heldScreen(session: string, scrollback: number): Promise<{ data: string; cols: number; rows: number; rev: number; keyAt?: number | null } | null> {
    const holder = this.holder.connected();

    return holder?.snapshot === undefined || !(holder.welcome.features ?? []).includes('snapshot') ? null : holder.snapshot(session, scrollback);
  }

  /** Why the connected holder cannot type into its sessions, as one from an older build cannot; null when it can or none is connected, which a write then reports. */
  heldCannotType(): string | null {
    const holder = this.holder.connected();

    return holder === null || (holder.write !== undefined && (holder.welcome.features ?? []).includes('write')) ? null : holderCannotType(this.holderStopCommand);
  }

  /** Types into a held session through the connection the roster reads keep (architecture.md § Typing a message). */
  async writeHeld(session: string, data: string): Promise<{ rev: number }> {
    const holder = this.holder.connected();

    if (holder === null) {
      throw new NotWritten('The terminal holder is not connected.');
    }

    if (holder.write === undefined || !(holder.welcome.features ?? []).includes('write')) {
      throw new NotWritten(holderCannotType(this.holderStopCommand));
    }

    try {
      return await holder.write(session, data);
    } catch (error) {
      // A refusal did nothing; a lost connection may have delivered the input.
      throw error instanceof HolderError && error.refused ? new NotWritten(error.message) : error;
    }
  }

  /**
   * An input reservation for a message typed into a Code Mode session (architecture.md § Typing a message): it waits for an end, stop or resume of
   * the session in progress, as an attach does, then checks that the session is still live under the launch the view showed, and defers a release
   * until it is released. Refused with why, when the session ended or was resumed under another launch.
   */
  async reserveInput(sessionId: string, launch: string | null): Promise<{ release(): void } | { refused: string }> {
    for (;;) {
      while (this.ending.has(sessionId)) {
        await this.ending.get(sessionId);
      }

      const resume = this.attaching.get(sessionId);

      if (resume === undefined || !this.resuming.has(sessionId)) {
        break;
      }

      await resume.catch(() => undefined);
    }

    const session = this.deps.store.session(sessionId);

    if (session === null || session.codeMode !== true || session.state === 'ended') {
      return { refused: SESSION_ENDED };
    }

    if ((session.launchId ?? null) !== launch) {
      return { refused: SESSION_RELAUNCHED };
    }

    this.inputs.set(sessionId, (this.inputs.get(sessionId) ?? 0) + 1);

    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }

        released = true;

        const left = (this.inputs.get(sessionId) ?? 1) - 1;

        if (left > 0) {
          this.inputs.set(sessionId, left);
        } else {
          this.inputs.delete(sessionId);
        }
      },
    };
  }

  /** What the snapshot shows beyond the store, as one structured-cloneable message for the snapshot worker. */
  snapshotInputs(): SnapshotInputs {
    const { settings, playbooks, settingsError, playbookErrors } = this.config;

    return {
      settings,
      playbooks: [...playbooks],
      settingsError,
      playbookErrors: playbookErrors.map(({ name, error }) => ({ name, error })),
      enabled: [...this.enabledSources()],
      sources: [...this.sources.keys()],
      held: this.heldSessions(),
      guarded: [...this.guarded],
      nodeError: this.nodeError,
      hookErrors: { ...this.hookErrors },
      sourceErrors: { ...this.sourceErrors },
      sourceNotes: { ...this.sourceNotes },
      now: this.deps.now(),
      configDir: this.deps.configDir,
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
    this.sourceNotes = {};

    // Only a valid file lists the configured sources; with an invalid one the previous settings stay in force.
    if (this.config.settingsError === null) {
      this.deps.store.keepSourceStates(Object.keys(this.config.settings.sources));

      // Tickets stored before tickets recorded their repository are the home repository's, which the file cannot change from now on (PRD R44).
      for (const [name, source] of Object.entries(this.config.settings.sources)) {
        const home = homeRepo(source);

        if (home !== '' && source.kind === 'github') {
          this.deps.store.fillHomeRepo(name, home);
        }
      }
    }

    const enabled = this.enabledSources();

    for (const [name, settings] of Object.entries(this.config.settings.sources)) {
      if (!enabled.has(name) || name === ADHOC_SOURCE) {
        continue;
      }

      const made = this.deps.makeSource(name, settings);

      if (made === null) {
        this.sourceErrors[name] = noKind(settings.kind);
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

  /** Links worktrees by branch name in the root of each repository with open tickets in the source (PRD R25). */
  private async findWorktrees(name: string, source: Source): Promise<void> {
    const settings = this.config.settings;
    const stored = this.deps.store.reposBySource();
    const repos = [...new Set([homeRepo(settings.sources[name]), ...this.deps.store.openRepos(name).map((repo) => repoOf(settings, { source: name, repo }))])];

    for (const repo of repos) {
      await this.findWorktreesIn(name, source, repo, stored);
    }
  }

  private async findWorktreesIn(name: string, source: Source, repo: string, stored: Record<string, string[]>): Promise<void> {
    const root = ticketRoot(this.config.settings, { source: name, repo, repoRoot: '' }, stored);
    const worktrees = 'error' in root ? null : await listWorktrees(root.root, this.deps.exec);

    for (const worktree of worktrees ?? []) {
      const key = worktree.branch === null ? null : source.keyOfBranch(worktree.branch, repo);
      const ticket = key === null ? null : this.deps.store.findTicket(name, key);

      // The flow links only a ticket without a worktree, and each event rebuilds the views, so a linked ticket gets none.
      if (key !== null && ticket !== null && this.deps.store.worktreeFor(ticket.id) === null) {
        this.send({ type: 'worktree-found', source: name, sourceKey: key, path: worktree.path, branch: worktree.branch! });
      }
    }
  }

  /**
   * Reads the holder's list for the held sessions (architecture.md § Visibility of held sessions), whether or not a Code Mode session is active, so
   * the orphans of a reset store show. Without a holder record it never connects, so a hub that never held a session does nothing.
   */
  private async readHeld(): Promise<void> {
    const found = existsSync(recordPath(this.home)) ? await this.holder.find(false) : { gone: true as const };
    let entries: SessionEntry[] = [];
    let error: string | null = null;

    if ('error' in found) {
      error = found.error;
    } else if ('holder' in found) {
      try {
        entries = await found.holder.list();
      } catch (failure) {
        error = (failure as Error).message;
      }
    }

    if (error !== null) {
      if (error !== this.heldError) {
        this.deps.log(`held session list failed: ${error}`);
      }

      this.heldError = error;
      return;
    }

    const before = JSON.stringify(this.heldEntries);

    this.heldError = null;
    this.heldEntries = [...entries];

    for (const held of this.heldSessions().filter((one) => one.orphan && !this.orphansLogged.has(one.session))) {
      this.orphansLogged.add(held.session);
      this.deps.log(`held session ${held.session} has no work item: ${held.label}`);
    }

    if (JSON.stringify(entries) !== before) {
      this.changed();
    }
  }

  /**
   * The holder's last list joined with the store, orphans first. An orphan is a live process whose session is no active session of the store; a
   * known older session still held, such as one whose end waits for its terminal, is not one, nor is a session whose resume spawn runs.
   */
  heldSessions(): HeldSession[] {
    const store = this.deps.store;
    const joined = this.heldEntries.map((entry): HeldSession => {
      const own = heldFromHolder(entry);
      const session = store.session(entry.session);
      const active = session !== null && session.state !== 'ended';
      const orphan = entry.exitedAt === null && !active && !this.resuming.has(entry.session);

      if (session === null) {
        return { ...own, orphan };
      }

      const item = store.workItem(session.workItemId);
      const ticket = item === null ? null : store.ticket(item.ticketId);

      return {
        ...own,
        workItemId: session.workItemId,
        key: ticket === null ? own.key : `${ticket.source} ${ticket.sourceKey}`,
        nativeSessionId: session.nativeSessionId ?? own.nativeSessionId,
        state: active ? session.state : own.state,
        orphan,
      };
    });

    return [...joined.filter((one) => one.orphan), ...joined.filter((one) => !one.orphan)];
  }

  /** `POST /holder/list`: the held sessions, read again first. */
  async listHeld(): Promise<HeldSession[]> {
    await this.readHeld();

    return this.heldSessions();
  }

  /**
   * `POST /holder/stop` (PRD R94): stops the held session `id` names, a Switchboard session ID, a Claude session ID, current or retired, or its
   * first 8 characters. An active session stops through the flow, as Stop does, so its result reaches the flow before an attach decides; an orphan
   * ends in the holder directly.
   */
  async stopHeld(id: string): Promise<{ stopped: string } | { refused: string; status: 404 | 409 }> {
    const store = this.deps.store;
    let found: ReturnType<typeof findHeld<HeldSession>>;

    for (;;) {
      await this.readHeld();
      found = findHeld(this.heldSessions(), id, (entry) => store.session(entry.session)?.retiredIds ?? []);

      const resume = 'refused' in found ? undefined : this.attaching.get(found.session);

      // A session whose resume spawn runs is still ended in the store, so the stop waits for the resume and then stops it through the flow.
      if ('refused' in found || !this.resuming.has(found.session) || resume === undefined) {
        break;
      }

      await resume;
    }

    if ('refused' in found) {
      return found;
    }

    if (found.exitedAt !== null) {
      return { refused: `Held session ${found.session} has exited.`, status: 409 };
    }

    const session = store.session(found.session);

    if (session !== null && session.state !== 'ended') {
      const result = this.send({ type: 'stop', workItemId: session.workItemId, sessionId: session.id });

      if (result.refused !== null) {
        return { refused: result.refused, status: 409 };
      }

      while (this.ending.has(session.id)) {
        await this.ending.get(session.id);
      }

      const after = store.session(session.id);

      if (after === null || after.state === 'ended') {
        return { stopped: session.id };
      }

      const error = store.workItem(session.workItemId)?.error ?? null;

      return { refused: error?.startsWith('Stop failed') ? error : `Stop of held session ${session.id} failed; it is still held.`, status: 409 };
    }

    // An attach of the session waits for the kill, as for any stop of a held session.
    const stopping = this.runners.codeMode.stop({ sessionId: found.session, shortId: session?.shortId ?? null }, 'operator');

    await this.trackEnd(found.session, async () => {
      await stopping;
    });

    const failure = await stopping;

    if (failure !== null) {
      return { refused: `Stop failed: ${failure.error}`, status: 409 };
    }

    this.deps.log(`stopped orphaned held session ${found.session}: ${found.label}`);
    await this.readHeld();

    return { stopped: found.session };
  }

  /**
   * No holder holds the lock, so the sessions the last one held have ended (PRD R94). Found here, before a start replaces it, as well as at a roster
   * read; a session still starting is settled by its own start check.
   */
  private holderGone(): void {
    for (const session of this.deps.store.activeSessions()) {
      if (session.codeMode === true && session.state !== 'starting') {
        this.deps.log(`session ${session.id} ended: the terminal holder stopped`);
        this.send({ type: 'holder-lost', sessionId: session.id });
      }
    }
  }

  /**
   * `POST /attach` (architecture.md § Code Mode sessions): the holder to attach to for a Code Mode session, resumed when it has ended. Takes an
   * attach reservation, which defers an end until the client connects, waits for an end in progress, and refuses a resume while processes of the
   * session's last run still run. Concurrent attaches of one session share one attempt, so it is resumed once.
   */
  attach(sessionId: string): Promise<AttachResult> {
    const running = this.attaching.get(sessionId);

    if (running !== undefined) {
      return running;
    }

    const attempt = this.attachOnce(sessionId).finally(() => this.attaching.delete(sessionId));

    this.attaching.set(sessionId, attempt);

    return attempt;
  }

  private async attachOnce(sessionId: string): Promise<AttachResult> {
    const store = this.deps.store;
    const first = store.session(sessionId);

    if (first === null) {
      return { refused: `No session ${sessionId}.`, status: 404 };
    }

    const name = first.shortId ?? sessionId;

    if (first.codeMode !== true) {
      return { refused: `Session ${name} is not a Code Mode session; open it in Claude.`, status: 409 };
    }

    for (const [id, until] of this.reservations) {
      if (until <= this.deps.now()) {
        this.reservations.delete(id);
      }
    }

    this.reservations.set(sessionId, this.deps.now() + ATTACH_RESERVATION_MS);

    const result = await this.attachHeld(sessionId, name);

    if ('refused' in result) {
      this.reservations.delete(sessionId);
    }

    return result;
  }

  private async attachHeld(sessionId: string, name: string): Promise<AttachResult> {
    const store = this.deps.store;
    const refuse = (refused: string, status: 404 | 409 = 409): AttachResult => ({ refused, status });
    const answer = (): AttachResult => {
      const record = this.holder.record();

      return record === null ? refuse('The terminal holder closed the connection.') : { port: record.port, token: record.token, session: sessionId };
    };

    // An end or stop of the session can start during any wait below, so each decision is taken again once none is pending.
    for (;;) {
      while (this.ending.has(sessionId)) {
        await this.ending.get(sessionId);
      }

      const found = await this.holder.find(true);

      if (!('holder' in found)) {
        return refuse('error' in found ? found.error : 'The terminal holder did not start.');
      }

      let live: boolean;

      try {
        live = (await found.holder.list()).some((entry) => entry.session === sessionId && entry.exitedAt === null);
      } catch (error) {
        return refuse((error as Error).message);
      }

      if (this.ending.has(sessionId)) {
        continue;
      }

      // A starting session is attached too, so the operator can answer a prompt before its start.
      if (live) {
        this.reviveHeld(sessionId);
        return answer();
      }

      if (store.session(sessionId)?.state !== 'ended') {
        await this.readRoster();

        if (this.ending.has(sessionId)) {
          continue;
        }
      }

      const session = store.session(sessionId);

      if (session === null) {
        return refuse(`No session ${sessionId}.`, 404);
      }

      if (session.state !== 'ended') {
        return refuse(`Session ${name} is still ${session.state === 'starting' ? 'starting' : 'ending'}; try again.`);
      }

      if (!this.config.settings.sessions.installHooks) {
        return refuse(HOOKS_REQUIRED);
      }

      const left = (await this.runners.codeMode.leftovers?.(session.lastTree ?? [])) ?? [];

      if (!Array.isArray(left)) {
        return refuse(left.error);
      }

      if (left.length > 0) {
        const pids = left.map((member) => member.pid).join(', ');

        this.guarded.set(sessionId, left.map((member) => member.pid));
        this.changed();

        return refuse(`Session ${name} still has ${left.length} ${left.length === 1 ? 'process' : 'processes'} from its previous run (${left.length === 1 ? 'pid' : 'pids'} ${pids}). Stop them or wait for them to end.`);
      }

      if (this.ending.has(sessionId)) {
        continue;
      }

      return this.resume(session, name, answer, refuse);
    }
  }

  /**
   * An ended Code Mode session the holder lists live was resumed by a hub that stopped before it recorded the resume; its launch was stored before
   * the spawn, so the session is held again under it (PRD R95).
   */
  private reviveHeld(sessionId: string): void {
    const session = this.deps.store.session(sessionId);

    if (session?.codeMode === true && session.state === 'ended' && session.launchId != null && !this.resuming.has(sessionId)) {
      this.deps.log(`session ${sessionId} is live in the terminal holder under launch ${session.launchId}; holding it again`);
      this.guarded.delete(sessionId);
      this.send({ type: 'held-resumed', sessionId, launchId: session.launchId });
    }
  }

  /** Spawns the ended session again; roster reads leave it alone meanwhile, since they cannot tell its new process from its old launch. */
  private async resume(session: Session, name: string, answer: () => AttachResult, refuse: (refused: string, status?: 404 | 409) => AttachResult): Promise<AttachResult> {
    const store = this.deps.store;
    const sessionId = session.id;
    const item = store.workItem(session.workItemId);

    if (item === null) {
      return refuse(`No work item holds session ${name}.`, 404);
    }

    const ticket = store.ticket(item.ticketId)!;
    const playbook = item.playbook === null ? null : (this.config.playbooks.get(item.playbook) ?? null);
    const options = launchOptions(this.config.settings, playbook, session.kind, session.provider);

    this.resuming.add(sessionId);

    try {
      // Stored before the spawn, so a hub that stops during it finds the live process under this launch.
      const launchId = this.runners.codeMode.newLaunchId?.() ?? randomUUID();

      this.send({ type: 'held-resuming', sessionId, launchId });

      const resumed = this.runners.codeMode.resumeHeld === undefined
        ? { error: 'The Code Mode runner cannot resume sessions.' }
        : await this.runners.codeMode.resumeHeld(
            session,
            options.permissionMode,
            options.model,
            `${sessionName(session.kind, item, ticket)} ${session.nativeSessionId ?? ''}`,
            launchId,
            // A session started with no prompt that ended before its first message starts again with its contract (mechanics M87).
            session.promptless === true ? { contract: sessionContract(session.id, this.reportCommand, session.reports, session.provider), name: sessionName(session.kind, item, ticket) } : undefined,
          );

      if ('error' in resumed) {
        return refuse(resumed.error);
      }

      // Delete during the spawn leaves the new process no session to hold it, so it is ended.
      const after = store.session(sessionId);

      if (after === null || after.state !== 'ended') {
        const failure = await this.runners.codeMode.stop({ sessionId, shortId: session.shortId }, 'operator');

        this.deps.log(`session ${sessionId} changed while it resumed; ${failure === null ? 'ended the resumed process' : `ending the resumed process failed, so it may still be running: ${failure.error}`}`);

        return after === null ? refuse(`No session ${sessionId}.`, 404) : refuse(`Session ${name} changed while it resumed; try again.`);
      }

      this.deps.log(`session ${sessionId} resumed in the terminal holder`);
      this.guarded.delete(sessionId);
      this.send({ type: 'held-resumed', sessionId, launchId: resumed.launchId });

      return answer();
    } finally {
      this.resuming.delete(sessionId);
    }
  }

  /**
   * Whether a Code Mode session's release ends it now: not when a new turn cancelled it, and not while a terminal is attached, which defers it to a
   * later roster read (PRD R95).
   */
  private async endsNow(action: Extract<FlowAction, { type: 'stop-session' }>): Promise<boolean> {
    const waiting = () => {
      const session = this.deps.store.session(action.sessionId);

      return session !== null && session.releasing && !session.released ? session : null;
    };

    if (waiting() === null) {
      this.deferred.delete(action.sessionId);
      this.deps.log(`end of held session ${action.sessionId} skipped: it no longer waits to end`);
      return false;
    }

    const activity = (await this.runners.codeMode.heldActivity?.(action.sessionId)) ?? { clients: 0, lastInputAt: null };
    // A new turn during the read cancels the end.
    const session = waiting();

    if (session === null) {
      this.deferred.delete(action.sessionId);
      this.deps.log(`end of held session ${action.sessionId} skipped: it no longer waits to end`);
      return false;
    }

    // The marker read now may show a new turn the flow has not applied; it cancels the end when it is.
    const reading = session.nativeSessionId === null ? undefined : this.runners.codeMode.markers([session]).get(session.nativeSessionId);

    // Only a turn-end marker lets the end go on: any other, such as a PreToolUse that replaced the prompt's marker, belongs to a new turn. A
    // compaction says neither, since a manual `/compact` ends with no Stop, so recent output, such as a running turn's spinner, defers the end instead.
    const compacted = reading?.compacted === true;

    if (reading !== undefined && !compacted && reading.observed?.state !== 'idle' && reading.observed?.state !== 'failed') {
      this.deps.log(`end of held session ${action.sessionId} skipped: its last marker is not a turn end`);
      return false;
    }

    // Input after the turn's own end, by its marker's time, may be a prompt whose marker has not been written yet, so the end waits for it a while (PRD R95).
    // After a compaction the turn end's own time is gone, and the time the hub applied it can be later than newer activity, so any recent activity counts.
    const turnEnd = compacted ? -Infinity : (reading?.at ?? session.stateAt);
    const recent = (at: number | null | undefined) => at != null && at > turnEnd && this.deps.now() - at < INPUT_SETTLE_MS;
    const typed = !('error' in activity) && (recent(activity.lastInputAt) || (compacted && recent(activity.lastOutputAt)));
    // An attach reservation counts as a terminal until its client connects (PRD R95), and an input reservation while a message is typed.
    const reserved = (this.reservations.get(action.sessionId) ?? -Infinity) > this.deps.now();
    const typing = this.inputs.has(action.sessionId);

    if (!('error' in activity) && activity.clients === 0 && !typed && !reserved && !typing) {
      this.deferred.delete(action.sessionId);
      return true;
    }

    if (!this.deferred.has(action.sessionId)) {
      this.deferred.add(action.sessionId);
      const why = 'error' in activity ? activity.error : activity.clients > 0 ? `${activity.clients} terminal${activity.clients === 1 ? ' is' : 's are'} attached` : reserved ? 'a terminal is attaching' : typing ? 'a message is being typed' : 'input arrived after its turn';

      this.deps.log(`end of held session ${action.sessionId} deferred: ${why}`);
    }

    return false;
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
        // Switchboard never clones: a folder a pattern names must already hold the repository's clone.
        if (action.clone !== undefined && !existsSync(join(action.cwd, '.git'))) {
          this.send({ type: 'session-start-failed', sessionId: action.sessionId, message: `No clone of ${action.clone} at ${action.cwd}.` });
          return;
        }

        const runner = this.runners[runnerKey(action)];
        const result = await runner.start(action);

        // Delete during a Code Mode start removes the row while the holder spawns, so the process is ended here (PRD R76, R95).
        if (!('error' in result) && action.codeMode === true && this.deps.store.session(action.sessionId) === null) {
          const failure = await runner.stop({ sessionId: action.sessionId, shortId: result.shortId }, 'operator');

          this.deps.log(`session ${action.sessionId} started after its work item was deleted; ${failure === null ? 'ended it' : `ending it failed, so it may still be running: ${failure.error}`}`);
          return;
        }

        this.send(
          'error' in result
            ? { type: 'session-start-failed', sessionId: action.sessionId, message: result.error }
            : {
                type: 'session-started',
                sessionId: action.sessionId,
                nativeSessionId: result.nativeSessionId,
                shortId: result.shortId,
                ...(result.startPrompt ? { startPrompt: true as const } : {}),
                ...(result.launchId === undefined ? {} : { launchId: result.launchId }),
              },
        );
        return;
      }
      case 'resume-session':
        return this.resumeSession(action);
      case 'stop-session': {
        const runner = this.runners[runnerKey(action)];

        if (action.codeMode === true && action.reason === 'release') {
          if (this.ending.has(action.sessionId)) {
            return;
          }

          return this.trackEnd(action.sessionId, async () => {
            if (await this.endsNow(action)) {
              await this.stopSession(action);
            }
          });
        }

        // An attach waits for every stop of a held session, operator stops included, until its result reaches the flow.
        if (action.codeMode === true) {
          const earlier = this.ending.get(action.sessionId);

          return this.trackEnd(action.sessionId, async () => {
            await Promise.all([earlier, this.stopSession(action)]);
          });
        }

        if (action.codeMode !== true && action.reason === 'release' && action.shortId !== null && !(await runner.isBackground(action))) {
          // The operator resumed it, such as in a VS Code tab; a release never stops their session (PRD R39).
          this.deps.log(`release skipped: session ${action.sessionId} is not a background process`);
          return;
        }

        return this.stopSession(action);
      }
    }
  }

  /** Runs a held session's end or stop as the one `POST /attach` waits for, until it and any it joined finish. */
  private trackEnd(sessionId: string, work: () => Promise<void>): Promise<void> {
    const end: Promise<void> = work().finally(() => {
      if (this.ending.get(sessionId) === end) {
        this.ending.delete(sessionId);
      }
    });

    this.ending.set(sessionId, end);

    return end;
  }

  private async stopSession(action: Extract<FlowAction, { type: 'stop-session' }>): Promise<void> {
    const { leftovers, ...target } = action;
    const failure = await this.runners[runnerKey(action)].stop(leftovers === true ? { ...target, lastTree: this.deps.store.session(action.sessionId)?.lastTree ?? [] } : target, action.reason);

    if (failure === null) {
      if (leftovers === true) {
        this.guarded.delete(action.sessionId);
      }

      await this.findSetupWorktrees();
    } else if (this.deps.store.session(action.sessionId) === null) {
      // Delete removed the session row, so the flow has nowhere to show the failure (PRD R76).
      this.deps.log(`stop of deleted session ${action.sessionId} (${action.shortId}) failed; it may still be running: ${failure.error}`);
    }

    this.send(
      failure === null
        ? { type: 'stop-succeeded', sessionId: action.sessionId, reason: action.reason, shortId: action.shortId, ...(action.leftovers === true ? { leftovers: true as const } : {}) }
        : { type: 'stop-failed', sessionId: action.sessionId, reason: action.reason, message: failure.error, shortId: action.shortId, ...(action.leftovers === true ? { leftovers: true as const } : {}) },
    );
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
