import { realpathSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import type { CopyRelation, MarkerReading, ObservedFork, ObservedSession, Reconciled, Session, SessionRunner, SessionTarget, StartAction, StartResult, StopReason } from '@switchboard/core';
import type { Exec } from './exec.js';
import { findForks, forkTargets, relationOf, Transcripts } from './fork.js';
import { markerState } from './hooks.js';
import type { Marker } from './hooks.js';
import type { ProcessTable, TabCandidate } from './runner.js';
import { installHooks, readMarkers } from './install.js';
import { copyFrom, entryFor, LAUNCH_TIMEOUT_MS, START_TIMEOUT_MS, observe, observeForks, parentPids, readRoster, resumeArgs, startSession, stopSession, tabCandidates } from './runner.js';
import { claudeEnvironment, failureOf } from './exec.js';

/** A roster directory and a configured repository may use different links or platform spellings. */
export function rosterDirectory(path: string, platform: NodeJS.Platform = process.platform): string {
  let real = path;
  try { real = realpathSync.native(path); } catch { /* Missing directories still have a comparable platform spelling. */ }
  const paths = platform === 'win32' ? win32 : posix;
  let normalized = paths.normalize(real);
  if (normalized.length > paths.parse(normalized).root.length) normalized = normalized.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

export interface ClaudeRunnerDeps {
  /** Read at each use, so a change to `sessions.claudePath` applies to the next command. */
  claudePath(): string;
  platform?: NodeJS.Platform;
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
  private readonly blockedStarts = new Map<string, { native: string; reads: number; at: number }>();

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

  /**
   * Only processes whose parent is the window's extension host `hostPid` are that window's Claude sessions, in a tab or the sidebar (mechanics
   * M55); `others` counts those the label does not name, which the window's close would end too.
   */
  async tab(label: string | null, hostPid: number): Promise<{ candidates: TabCandidate[]; others: number } | { error: string }> {
    const roster = await readRoster(this.deps.claudePath(), this.deps.exec, true);

    if ('error' in roster) {
      return roster;
    }

    const live = roster.entries.filter((entry) => entry.pid !== undefined && entry.kind !== 'background');
    const parents = await parentPids(this.deps.exec, live.map((entry) => entry.pid!), this.deps.processTable);

    if ('error' in parents) {
      return parents;
    }

    const inWindow = live.filter((entry) => parents.get(entry.pid!) === hostPid);
    const candidates = tabCandidates(roster.entries, label).filter((candidate) => parents.get(candidate.pid) === hostPid);

    return { candidates, others: inWindow.length - candidates.length };
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

  /** Rejoin only a unique native identity or the start's stored Switchboard ID in its label. */
  async reconcile(sessions: Session[]): Promise<Reconciled[]> {
    for (const [id, reading] of this.blockedStarts) {
      if (this.deps.now() - reading.at >= START_TIMEOUT_MS) this.blockedStarts.delete(id);
    }
    if (sessions.length === 0) return [];
    const roster = await readRoster(this.deps.claudePath(), this.deps.exec);
    if ('error' in roster) return sessions.map(session => ({ sessionId: session.id, pending: roster.error }));
    const pathKey = (path: string): string => rosterDirectory(path, this.deps.platform);
    return sessions.map(session => {
      const matches = roster.entries.filter(entry => entry.kind === 'background' && pathKey(entry.cwd) === pathKey(session.cwd) && (
        session.nativeSessionId !== null ? entry.sessionId === session.nativeSessionId :
        session.shortId !== null ? entryFor([entry], session.shortId) !== undefined : entry.name?.endsWith(` · ${session.id}`) === true
      ));
      const entry = matches.length === 1 ? matches[0]! : null;
      const previous = this.blockedStarts.get(session.id);
      const blocked = entry?.state === 'blocked' && entry.pid === undefined ? (previous?.native === entry.sessionId ? previous.reads : 0) + 1 : 0;
      if (entry !== null && blocked > 0) this.blockedStarts.set(session.id, { native: entry.sessionId, reads: blocked, at: this.deps.now() });
      else this.blockedStarts.delete(session.id);
      if (entry !== null && (entry.pid !== undefined || blocked >= 2)) {
        this.blockedStarts.delete(session.id);
        return { sessionId: session.id, started: { shortId: entry.id ?? entry.sessionId.slice(0, 8), nativeSessionId: entry.sessionId, ...(entry.pid === undefined ? { startPrompt: true as const } : {}) } };
      }
      if (matches.length > 1) return { sessionId: session.id, pending: 'More than one Claude background session matches this start; inspect claude agents and stop the extra session so the original can be recovered.', attention: true as const };
      return this.deps.now() - session.startedAt < LAUNCH_TIMEOUT_MS + START_TIMEOUT_MS
        ? { sessionId: session.id, pending: 'Waiting for the Claude background session to appear in the roster.' }
        : { sessionId: session.id, pending: `The Claude start is still unconfirmed; inspect claude agents for the label ending · ${session.id}, then use Stop to clear this unconfirmed start if needed.`, attention: true as const, ...(matches.length === 0 ? { clearable: true as const } : {}) };

    });
  }

  async installHooks(): Promise<string | null> {
    try {
      return await installHooks(this.deps.home, this.deps.claudeSettings, this.deps.nodePath());
    } catch (error) {
      return `Switchboard could not add its hooks to ${this.deps.claudeSettings}: ${(error as Error).message}`;
    }
  }
}
