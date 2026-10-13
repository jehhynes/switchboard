import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec, MarkerReading, ObservedSession, Reconciled, Session, SessionRunner, SessionTarget, StartAction, StartResult, StopReason } from '@switchboard/core';
import { isCodexPermissionMode } from '@switchboard/core';
import { startArgs } from './args.js';
import type { RunOptions } from './args.js';
import { CODEX_HOOK_SOURCE, codexHookCommands, parseCodexMarker, planCodexHooks } from './hooks.js';
import type { CodexMarker } from './hooks.js';
import { lastErrorLine, parseRunLog } from './log.js';
import type { RunLog } from './log.js';
import { carriesTag, findTagged, killTree, pidAlive, queryProcesses, runTag, sameProcess, spawnDetached } from './processes.js';
import type { DetachedSpawn, ProcessIdentity, ProcessInfo } from './processes.js';
import { readRecord, readText, RUN_RECORD_VERSION, runFiles, writeRecord } from './records.js';
import type { RunRecord } from './records.js';
import { readTail, reduce, turnEndOf } from './reducer.js';
import type { Reduced } from './reducer.js';
import { trustHooks } from './trust.js';

/** How long a start waits for Codex's first event of the run. */
export const START_TIMEOUT_MS = 60_000;
/** How long a release or an open waits for a run's process to exit after its turn, before it is ended. */
export const EXIT_WAIT_MS = 15_000;
const POLL_MS = 250;
/** How often a spawn tries to read the new process's creation time before it leaves the identity to the run tag. */
const IDENTITY_TRIES = 3;

export interface CodexRunnerDeps {
  codexPath: string;
  exec: Exec;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The Switchboard home, which holds the run records, the hook script and the activity markers. */
  home: string;
  /** Codex's home, `CODEX_HOME` or `~/.codex`, which holds hooks.json. */
  codexHome: string;
  /** Variables for every Codex process besides `CODEX_HOME`, which is always `codexHome`. */
  env: Record<string, string>;
  /** Whether Switchboard's hooks are on (`sessions.installHooks`). */
  hooks(): boolean;
  spawn?: (file: string, args: string[], options: { cwd: string; stdout: string; stderr: string; env?: Record<string, string> }) => Promise<DetachedSpawn>;
  processes?: (pids: number[]) => Promise<Map<number, ProcessInfo> | { error: string }>;
  tagged?: (tag: string) => Promise<ProcessIdentity | null | { error: string }>;
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => Promise<{ error: string } | null>;
  trust?: (commands: ReadonlySet<string>) => Promise<string | null>;
}

type Spawned = { pid: number; identity: ProcessIdentity | null } | { error: string };

/** Codex sessions run as `codex exec` processes the hub starts, one per turn (architecture.md § Codex runner). */
export class CodexRunner implements SessionRunner {
  /** Process creation times from the last roster read, so the marker pass can tell a reused PID without a query. */
  private known = new Map<number, string>();
  /** The operation in flight per session, so a read, a stop and a reconcile of one session never interleave. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: CodexRunnerDeps) {}

  /** Every Codex process reads the same home as the hooks Switchboard installs. */
  private get env(): Record<string, string> {
    return { ...this.deps.env, CODEX_HOME: this.deps.codexHome };
  }

  private get spawn() {
    return this.deps.spawn ?? spawnDetached;
  }

  private alive(pid: number): boolean {
    return (this.deps.alive ?? pidAlive)(pid);
  }

  private processes(pids: number[]) {
    return this.deps.processes ? this.deps.processes(pids) : queryProcesses(this.deps.exec, pids);
  }

  private tagged(tag: string) {
    return this.deps.tagged ? this.deps.tagged(tag) : findTagged(this.deps.exec, tag);
  }

  private kill(pid: number) {
    return this.deps.kill ? this.deps.kill(pid) : killTree(this.deps.exec, pid);
  }

  /** Runs the operation after the session's earlier ones. */
  private serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(sessionId) ?? Promise.resolve()).then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );

    this.queues.set(sessionId, settled);
    void settled.then(() => this.queues.get(sessionId) === settled && this.queues.delete(sessionId));

    return run;
  }

  private options(record: RunRecord): RunOptions {
    return { mode: record.mode, model: record.model, contract: record.contract, tag: runTag(record.sessionId) };
  }

  private log(record: RunRecord): RunLog {
    return parseRunLog(readText(runFiles(this.deps.home, record.sessionId).stdout));
  }

  private failure(record: RunRecord, fallback: string): string {
    return lastErrorLine(readText(runFiles(this.deps.home, record.sessionId).stderr)) ?? fallback;
  }

  /** Spawns the run and reads its creation time; a process whose time cannot be read yet is found later by its run tag. */
  private async spawnRun(record: RunRecord, args: string[]): Promise<Spawned> {
    const files = runFiles(this.deps.home, record.sessionId);
    const spawned = await this.spawn(this.deps.codexPath, args, { cwd: record.cwd, ...files, env: this.env });

    if (spawned.pid === null) {
      return { error: spawned.error ?? 'Codex did not start.' };
    }

    for (let tries = 0; tries < IDENTITY_TRIES; tries++) {
      const found = await this.processes([spawned.pid]);

      if (!('error' in found)) {
        const info = found.get(spawned.pid);

        // A process that already exited has no creation time, and one without the run's tag took the PID after it; the log and stderr say what the run did.
        return { pid: spawned.pid, identity: info === undefined || !carriesTag(info.commandLine, runTag(record.sessionId)) ? null : { pid: info.pid, created: info.created } };
      }

      await this.deps.sleep(POLL_MS);
    }

    return { pid: spawned.pid, identity: null };
  }

  /** Waits until the run's log holds the thread ID, the process exits, or the time runs out. The PID is the one just spawned. */
  private async waitForThread(record: RunRecord, pid: number): Promise<'seen' | 'exited' | 'timeout'> {
    for (const deadline = this.deps.now() + START_TIMEOUT_MS; ; await this.deps.sleep(POLL_MS)) {
      if (this.log(record).threadId !== null) {
        return 'seen';
      }

      if (!this.alive(pid)) {
        // The process may have written the thread ID just before it exited.
        return this.log(record).threadId !== null ? 'seen' : 'exited';
      }

      if (this.deps.now() >= deadline) {
        return 'timeout';
      }
    }
  }

  async start(action: StartAction): Promise<StartResult> {
    if (!isCodexPermissionMode(action.permissionMode)) {
      return { error: `Codex runs sessions only in auto, plan, dontAsk or bypassPermissions, not ${action.permissionMode}.` };
    }

    return this.serial(action.sessionId, async () => {
      const record: RunRecord = {
        v: RUN_RECORD_VERSION,
        sessionId: action.sessionId,
        cwd: action.cwd,
        mode: action.permissionMode as RunRecord['mode'],
        model: action.model,
        contract: action.contract,
        threadId: null,
        spawnedAt: this.deps.now(),
        process: null,
      };

      writeRecord(this.deps.home, record);

      const spawned = await this.spawnRun(record, startArgs(action.cwd, action.prompt, this.options(record)));

      if ('error' in spawned) {
        return { error: spawned.error };
      }

      record.process = spawned.identity;
      writeRecord(this.deps.home, record);

      return this.awaitStart(record, spawned.pid);
    });
  }

  /** Waits for the thread ID of a start whose process was spawned. */
  private async awaitStart(record: RunRecord, pid: number): Promise<StartResult> {
    const seen = await this.waitForThread(record, pid);

    if (seen === 'seen') {
      record.threadId = this.log(record).threadId;
      writeRecord(this.deps.home, record);

      return { shortId: record.threadId!, nativeSessionId: record.threadId! };
    }

    if (seen === 'exited') {
      return { error: this.failure(record, 'Codex exited before it started the session.') };
    }

    const ended = record.process === null ? { error: 'its process could not be identified' } : await this.killVerified(record.process);

    return { error: `Codex did not start the session within ${START_TIMEOUT_MS / 1000} seconds${ended === null ? '' : `, and it may still be running: ${ended.error}`}.` };
  }

  /** The markers of Codex sessions by thread ID. */
  private readMarkers(): Map<string, CodexMarker> {
    const markers = new Map<string, CodexMarker>();

    if (!this.deps.hooks()) {
      return markers;
    }

    const dir = join(this.deps.home, 'activity');
    let files: string[];

    try {
      files = readdirSync(dir).filter((file) => file.endsWith('.json'));
    } catch {
      return markers;
    }

    for (const file of files) {
      const marker = parseCodexMarker(readText(join(dir, file)));

      if (marker !== null) {
        markers.set(marker.sessionId, marker);
      }
    }

    return markers;
  }

  /** Whether the identity's process lives: from a fresh query when given, else from the PID and the last known creation time. */
  private lives(identity: ProcessIdentity | null, fresh: Map<number, ProcessInfo> | null): boolean | null {
    if (identity === null) {
      return false;
    }

    if (fresh !== null) {
      return fresh.get(identity.pid)?.created === identity.created;
    }

    if (!this.alive(identity.pid)) {
      return false;
    }

    const known = this.known.get(identity.pid);

    return known === undefined ? null : known === identity.created;
  }

  private reduceOne(session: Session, record: RunRecord, marker: CodexMarker | null, fresh: Map<number, ProcessInfo> | null): Reduced | null {
    const runAlive = this.lives(record.process, fresh);
    const ownerIdentity = marker?.pid != null && marker.created !== null ? { pid: marker.pid, created: marker.created } : null;
    const ownerAlive = this.lives(ownerIdentity, fresh);

    // Without a query, a PID whose creation time is unknown cannot be told from a reused one.
    if (runAlive === null || ownerAlive === null) {
      return null;
    }

    return reduce({
      released: session.released,
      question: session.question !== null,
      record,
      log: this.log(record),
      runAlive,
      marker,
      markerOwnerAlive: ownerAlive,
      rolloutEnd: (held) => (held.turnId === null || held.transcriptPath === null ? null : turnEndOf(readTail(held.transcriptPath), held.turnId)),
    });
  }

  /**
   * Brings the record up to date before it is read or acted on, inside the session's queue: finds by its tag the run's process when the record
   * holds no identity for it.
   */
  private async refresh(sessionId: string): Promise<RunRecord | null | { error: string }> {
    const record = readRecord(this.deps.home, sessionId);

    if (record === null) {
      return null;
    }

    if (record.process !== null) {
      return record;
    }

    const found = await this.tagged(runTag(sessionId));

    if (found !== null && 'error' in found) {
      return { error: `The Codex process query failed: ${found.error}` };
    }

    if (found !== null) {
      record.process = found;
      writeRecord(this.deps.home, record);
    }

    return record;
  }

  async observe(sessions: Session[]): Promise<{ sessions: ObservedSession[] } | { error: string }> {
    const records = new Map<string, RunRecord>();

    for (const session of sessions) {
      const record = await this.serial(session.id, () => this.refresh(session.id));

      if (record !== null && 'error' in record) {
        return record;
      }

      if (record !== null) {
        records.set(session.id, record);
      }
    }

    const markers = this.readMarkers();
    const pids = [...records.values()].flatMap((record) => (record.process === null ? [] : [record.process.pid]));

    for (const session of sessions) {
      const pid = session.nativeSessionId === null ? null : markers.get(session.nativeSessionId)?.pid;

      if (pid != null) {
        pids.push(pid);
      }
    }

    const fresh = await this.processes(pids);

    if ('error' in fresh) {
      return { error: `The Codex process query failed: ${fresh.error}` };
    }

    this.known = new Map([...fresh.values()].map((info) => [info.pid, info.created]));

    const observed: ObservedSession[] = [];

    for (const session of sessions) {
      const record = records.get(session.id);
      const reduced = record === undefined ? null : this.reduceOne(session, record, session.nativeSessionId === null ? null : (markers.get(session.nativeSessionId) ?? null), fresh);

      if (reduced?.listed === true) {
        observed.push({ sessionId: session.id, state: reduced.state, detail: reduced.detail, interactive: reduced.interactive });
      }
    }

    return { sessions: observed };
  }

  markers(sessions: Session[]): Map<string, MarkerReading> {
    const readings = new Map<string, MarkerReading>();
    const markers = this.readMarkers();

    for (const session of sessions) {
      const record = readRecord(this.deps.home, session.id);

      if (session.nativeSessionId === null || record === null) {
        continue;
      }

      const marker = markers.get(session.nativeSessionId) ?? null;
      const reduced = this.reduceOne(session, record, marker, null);
      const at = marker?.at ?? 0;

      if (reduced === null || !reduced.listed || (reduced.interactive && !session.released)) {
        // Only the roster read can end the session or take it as the operator's.
        readings.set(session.nativeSessionId, { at, observed: null, recheck: true });
      } else {
        readings.set(session.nativeSessionId, { at, observed: { state: reduced.state, detail: reduced.detail }, recheck: false });
      }
    }

    return readings;
  }

  async isBackground(target: SessionTarget): Promise<boolean> {
    const record = readRecord(this.deps.home, target.sessionId);

    if (record === null || record.threadId === null) {
      return false;
    }

    const marker = this.readMarkers().get(record.threadId) ?? null;
    const owner = marker?.pid != null && marker.created !== null ? { pid: marker.pid, created: marker.created } : null;

    if (marker === null || owner === null || marker.at < record.spawnedAt || sameProcess(owner, record.process)) {
      return true;
    }

    const fresh = await this.processes([owner.pid]);

    // A failed query keeps the release, because the run itself ends with its turn.
    return 'error' in fresh || fresh.get(owner.pid)?.created !== owner.created;
  }

  /** Waits for the process to exit, up to EXIT_WAIT_MS. */
  private async exited(identity: ProcessIdentity | null): Promise<boolean> {
    if (identity === null) {
      return true;
    }

    for (const deadline = this.deps.now() + EXIT_WAIT_MS; this.deps.now() < deadline; await this.deps.sleep(POLL_MS)) {
      if (!this.alive(identity.pid)) {
        return true;
      }
    }

    return !this.alive(identity.pid);
  }

  /** Ends the process only while it is still the one the record names; a reused PID belongs to another process. */
  private async killVerified(identity: ProcessIdentity): Promise<{ error: string } | null> {
    const fresh = await this.processes([identity.pid]);

    if ('error' in fresh) {
      return { error: `The Codex process query failed: ${fresh.error}` };
    }

    return fresh.get(identity.pid)?.created === identity.created ? this.kill(identity.pid) : null;
  }

  /** Lets the process exit after its turn, and ends it when it does not in time. */
  private async settle(identity: ProcessIdentity | null): Promise<{ error: string } | null> {
    return identity === null || (await this.exited(identity)) ? null : this.killVerified(identity);
  }

  stop(target: SessionTarget, reason: StopReason): Promise<{ error: string } | null> {
    return this.serial(target.sessionId, async () => {
      const record = await this.refresh(target.sessionId);

      // A missing record, or one of another format, does not say which process to end, so the stop cannot be confirmed.
      if (record === null) {
        return { error: target.shortId === null ? 'The session has not started yet.' : "The session's run record cannot be read, so Switchboard cannot stop its Codex process." };
      }

      if ('error' in record) {
        return record;
      }

      // A release or an open follows the turn's end, so the process exits on its own; an operator stop ends it now.
      return reason === 'operator' ? (record.process === null ? null : this.killVerified(record.process)) : this.settle(record.process);
    });
  }

  /**
   * After a restart, settles each session left starting: its record is brought up to date first, so a process a stopped hub spawned without
   * recording is found by its tag. A failed process query leaves the session for a later read.
   */
  async reconcile(sessions: Session[]): Promise<Reconciled[]> {
    const results: Reconciled[] = [];

    for (const session of sessions) {
      results.push(
        await this.serial(session.id, async (): Promise<Reconciled> => {
          const record = await this.refresh(session.id);

          if (record === null) {
            return { sessionId: session.id, failed: 'The hub stopped while the session was starting.' };
          }

          if ('error' in record) {
            return { sessionId: session.id, pending: record.error };
          }

          const log = this.log(record);

          if (log.threadId !== null) {
            record.threadId = log.threadId;
            writeRecord(this.deps.home, record);
            return { sessionId: session.id, started: { shortId: log.threadId, nativeSessionId: log.threadId } };
          }

          if (record.process !== null) {
            const fresh = await this.processes([record.process.pid]);

            if ('error' in fresh) {
              return { sessionId: session.id, pending: `The Codex process query failed: ${fresh.error}` };
            }

            if (fresh.get(record.process.pid)?.created === record.process.created) {
              const started = await this.awaitStart(record, record.process.pid);

              return 'error' in started ? { sessionId: session.id, failed: started.error } : { sessionId: session.id, started };
            }
          }

          return { sessionId: session.id, failed: 'The hub stopped while the session was starting.' };
        }),
      );
    }

    return results;
  }

  async installHooks(): Promise<string | null> {
    const hookPath = join(this.deps.home, 'codex-hook.mjs').replaceAll('\\', '/');
    const contractPath = join(this.deps.home, 'contract.mjs').replaceAll('\\', '/');
    const hooksPath = join(this.deps.codexHome, 'hooks.json');

    try {
      mkdirSync(this.deps.home, { recursive: true });

      if (readText(hookPath) !== CODEX_HOOK_SOURCE) {
        writeFileSync(hookPath, CODEX_HOOK_SOURCE);
      }

      const plan = planCodexHooks(readText(hooksPath) || null, hookPath, contractPath);

      if ('error' in plan) {
        return plan.error;
      }

      if ('text' in plan) {
        mkdirSync(this.deps.codexHome, { recursive: true });
        writeFileSync(hooksPath, plan.text);
      }
    } catch (error) {
      return `Switchboard could not add its hooks to ${hooksPath}: ${(error as Error).message}`;
    }

    const commands = codexHookCommands(hookPath, contractPath);
    const trust = this.deps.trust ?? ((wanted: ReadonlySet<string>) => trustHooks(this.deps.codexPath, wanted, this.env));
    const failure = await trust(new Set([commands.hook, commands.contract]));

    return failure === null ? null : `Codex did not trust Switchboard's hooks: ${failure}`;
  }
}
