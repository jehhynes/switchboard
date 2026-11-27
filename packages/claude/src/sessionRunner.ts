import { dirname } from 'node:path';
import type { CopyRelation, MarkerReading, ObservedFork, ObservedSession, Reconciled, Session, SessionRunner, SessionTarget, StartAction, StartResult, StopReason } from '@switchboard/core';
import type { Exec } from './exec.js';
import { findForks, forkTargets, relationOf, Transcripts } from './fork.js';
import { markerState } from './hooks.js';
import type { Marker } from './hooks.js';
import { installHooks, readMarkers } from './install.js';
import { observe, observeForks, readRoster, stopSession } from './runner.js';

/** Why the runner of sessions Switchboard does not hold refuses to start one: every Claude session it starts is held (PRD R93). */
export const NOT_HELD = "Switchboard starts Claude sessions only in its terminal holder.";

export interface ClaudeRunnerDeps {
  /** Read at each use, so a change to `sessions.claudePath` applies to the next command. */
  claudePath(): string;
  exec: Exec;
  now(): number;
  /** The Switchboard home, which holds the hook scripts and the activity markers. */
  home: string;
  /** Claude's settings.json, where Switchboard installs its hooks. */
  claudeSettings: string;
  /** Whether hook markers decide state (`sessions.installHooks`); without them the roster alone does. */
  hooks(): boolean;
  /** The Node.js the hooks run (`sessions.nodePath`). */
  nodePath(): string;
}

/**
 * The Claude sessions Switchboard does not hold (architecture.md § Claude Code runner): registered sessions in the operator's own windows, followed
 * through `claude agents` until they end (PRD R81), and ended ones an earlier hub ran in Claude's background service, which it stops with `claude stop`
 * when the hub ends them at startup. It starts none, and it installs the Claude hooks every Claude session reads.
 */
export class ClaudeRunner implements SessionRunner {
  private readonly transcripts: Transcripts;

  constructor(private readonly deps: ClaudeRunnerDeps) {
    this.transcripts = new Transcripts(`${dirname(deps.claudeSettings).replaceAll('\\', '/')}/projects`, deps.now);
  }

  start(_action: StartAction): Promise<StartResult> {
    return Promise.resolve({ error: NOT_HELD });
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

  /**
   * A session the roster lists with a process, in a VS Code tab, a terminal or Claude's background service: a tab or terminal has no short ID, so its
   * native ID's first 8 characters stand for it (M7).
   */
  async live(nativeSessionId: string): Promise<{ shortId: string; cwd: string } | null | { error: string }> {
    const roster = await readRoster(this.deps.claudePath(), this.deps.exec);

    if ('error' in roster) {
      return roster;
    }

    const entry = roster.entries.find((candidate) => candidate.sessionId === nativeSessionId && candidate.pid !== undefined);

    return entry === undefined ? null : { shortId: entry.id ?? nativeSessionId.slice(0, 8), cwd: entry.cwd };
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

  isBackground(_target: SessionTarget): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** Stops an earlier hub's background session when the hub ends it at startup (PRD R93); a registered session is never stopped here (PRD R81). */
  stop(target: SessionTarget, _reason: StopReason): Promise<{ error: string } | null> {
    return target.shortId === null ? Promise.resolve({ error: 'The session has no short ID to stop.' }) : stopSession(this.deps.claudePath(), target.shortId, this.deps.exec);
  }

  /** No Claude session this runner follows starts, so one a stopped hub left starting failed (PRD R43). */
  reconcile(sessions: Session[]): Promise<Reconciled[]> {
    return Promise.resolve(sessions.map((session) => ({ sessionId: session.id, failed: 'Switchboard stopped while the session was starting.' })));
  }

  async installHooks(): Promise<string | null> {
    try {
      return await installHooks(this.deps.home, this.deps.claudeSettings, this.deps.nodePath());
    } catch (error) {
      return `Switchboard could not add its hooks to ${this.deps.claudeSettings}: ${(error as Error).message}`;
    }
  }
}
