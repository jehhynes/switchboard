import { dirname } from 'node:path';
import type { CopyRelation, MarkerReading, ObservedFork, ObservedSession, Reconciled, Session, SessionRunner, SessionTarget, StartAction, StartResult, StopReason } from '@switchboard/core';
import type { Exec } from './exec.js';
import { findForks, forkTargets, relationOf, Transcripts } from './fork.js';
import { markerState } from './hooks.js';
import type { Marker } from './hooks.js';
import type { ProcessTable, TabCandidate } from './runner.js';
import { installHooks, readMarkers } from './install.js';
import { copyFrom, entryFor, LAUNCH_TIMEOUT_MS, observe, observeForks, parentPids, readRoster, resumeArgs, startSession, stopSession, tabCandidates } from './runner.js';
import { claudeEnvironment, failureOf } from './exec.js';

export interface ClaudeRunnerDeps {
  /** Read at each use, so a change to `sessions.claudePath` applies to the next command. */
  claudePath(): string;
  exec: Exec;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The Switchboard home, which holds the hook scripts and the activity markers. */
  home: string;
  /** Claude's settings.json, where Switchboard installs its hooks. */
  claudeSettings: string;
  /** Whether hook markers decide state (`sessions.installHooks`); without them the roster alone does. */
  hooks(): boolean;
  /** The Node.js the hooks run (`sessions.nodePath`). */
  nodePath(): string;
  /** Where parent PIDs are read; the real process table by default. */
  processTable?: ProcessTable;
}

/** Claude Code's background sessions (architecture.md § Claude Code runner). */
export class ClaudeRunner implements SessionRunner {
  private readonly transcripts: Transcripts;

  constructor(private readonly deps: ClaudeRunnerDeps) {
    this.transcripts = new Transcripts(`${dirname(deps.claudeSettings).replaceAll('\\', '/')}/projects`, deps.now);
  }

  start(action: StartAction): Promise<StartResult> {
    return startSession(this.deps.claudePath(), action, { exec: this.deps.exec, sleep: this.deps.sleep, now: this.deps.now });
  }

  async observe(sessions: Session[]): Promise<{ sessions: ObservedSession[]; forks: ObservedFork[] } | { error: string }> {
    const roster = await readRoster(this.deps.claudePath(), this.deps.exec);

    if ('error' in roster) {
      return roster;
    }

    const markers = this.rawMarkers();

    return { sessions: observe(roster.entries, sessions, markers), forks: observeForks(findForks(this.transcripts, roster.entries, sessions), markers) };
  }

  relation(nativeSessionId: string, session: Session): CopyRelation {
    if (session.nativeSessionId === null || session.nativeSessionId === nativeSessionId) {
      return 'unrelated';
    }

    this.transcripts.pass();

    return relationOf(this.transcripts, nativeSessionId, null, session as Session & { nativeSessionId: string });
  }

  forkOf(nativeSessionId: string, sessions: Session[]): Session | null {
    this.transcripts.pass();

    return forkTargets(sessions).find((session) => relationOf(this.transcripts, nativeSessionId, null, session) === 'newer') ?? null;
  }

  /** A session the roster lists with a process: a VS Code tab or terminal has no short ID, so its native ID's first 8 characters match it (M7). */
  async live(nativeSessionId: string): Promise<{ shortId: string; cwd: string } | null | { error: string }> {
    const roster = await readRoster(this.deps.claudePath(), this.deps.exec);

    if ('error' in roster) {
      return roster;
    }

    const entry = roster.entries.find((candidate) => candidate.sessionId === nativeSessionId && candidate.pid !== undefined);

    return entry === undefined ? null : { shortId: entry.id ?? nativeSessionId.slice(0, 8), cwd: entry.cwd };
  }

  /** Only processes whose parent is the window's extension host `hostPid` are that window's tabs (mechanics M55). */
  async tab(label: string, hostPid: number): Promise<{ candidates: TabCandidate[] } | { error: string }> {
    const roster = await readRoster(this.deps.claudePath(), this.deps.exec, true);

    if ('error' in roster) {
      return roster;
    }

    const candidates = tabCandidates(roster.entries, label);
    const parents = await parentPids(this.deps.exec, candidates.map((candidate) => candidate.pid), this.deps.processTable);

    return 'error' in parents ? parents : { candidates: candidates.filter((candidate) => parents.get(candidate.pid) === hostPid) };
  }

  async resume(nativeSessionId: string, prompt: string, cwd: string): Promise<{ copy: string | null } | { error: string }> {
    const claudePath = this.deps.claudePath();
    const result = await this.deps.exec(claudePath, resumeArgs(nativeSessionId, prompt), { cwd, timeoutMs: LAUNCH_TIMEOUT_MS, env: claudeEnvironment(claudePath) });

    return result.code === 0 ? { copy: copyFrom(`${result.stdout}\n${result.stderr}`) } : { error: failureOf(claudePath, result, LAUNCH_TIMEOUT_MS, { cwd }) };
  }

  async background(nativeSessionId: string): Promise<{ shortId: string } | null | { error: string }> {
    const roster = await readRoster(this.deps.claudePath(), this.deps.exec);

    if ('error' in roster) {
      return roster;
    }

    const entry = roster.entries.find((candidate) => candidate.sessionId === nativeSessionId && candidate.kind === 'background' && candidate.pid !== undefined);

    return entry === undefined ? null : { shortId: entry.id ?? nativeSessionId.slice(0, 8) };
  }

  /** Hook markers, or none when hooks are off, so the roster alone decides state. */
  private rawMarkers(): Map<string, Marker> {
    return this.deps.hooks() ? readMarkers(this.deps.home) : new Map();
  }

  markers(_sessions: Session[]): Map<string, MarkerReading> {
    const readings = new Map<string, MarkerReading>();

    for (const [id, marker] of this.rawMarkers()) {
      readings.set(id, { at: marker.at ?? 0, cwd: marker.cwd ?? null, observed: markerState(marker), recheck: false });
    }

    return readings;
  }

  async isBackground(target: SessionTarget): Promise<boolean> {
    if (target.shortId === null) {
      return false;
    }

    const roster = await readRoster(this.deps.claudePath(), this.deps.exec);

    return 'entries' in roster && entryFor(roster.entries, target.shortId)?.kind === 'background';
  }

  stop(target: SessionTarget, _reason: StopReason): Promise<{ error: string } | null> {
    return target.shortId === null ? Promise.resolve({ error: 'The session has not started yet.' }) : stopSession(this.deps.claudePath(), target.shortId, this.deps.exec);
  }

  /** A background session started by a hub that stopped cannot be matched to its roster entry, so its start fails (PRD R43). */
  reconcile(sessions: Session[]): Promise<Reconciled[]> {
    return Promise.resolve(sessions.map((session) => ({ sessionId: session.id, failed: 'The hub stopped while the session was starting.' })));
  }

  installHooks(): Promise<string | null> {
    try {
      return Promise.resolve(installHooks(this.deps.home, this.deps.claudeSettings, this.deps.nodePath()));
    } catch (error) {
      return Promise.resolve(`Switchboard could not add its hooks to ${this.deps.claudeSettings}: ${(error as Error).message}`);
    }
  }
}
