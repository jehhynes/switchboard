import type { LiveState, ObservedFork, ObservedSession } from '@switchboard/core';
import type { Exec } from './exec.js';
import { claudeEnvironment, failureOf } from './exec.js';
import { markerState } from './hooks.js';
import type { Marker } from './hooks.js';

/** One `claude agents --json` entry. A background session has a short `id` and a `state`. */
export interface RosterEntry {
  id?: string;
  sessionId: string;
  pid?: number;
  kind: string;
  state?: string;
  status?: string;
  /** What a `blocked` background session waits on: `permission prompt` for a tool call, `input needed` for a question (mechanics M57). */
  waitingFor?: string;
  cwd: string;
  name?: string;
}

const ROSTER_TIMEOUT_MS = 15_000;

export type RosterResult = { entries: RosterEntry[] } | { error: string };

/** `claude agents --json`; `all` also lists background jobs whose process ended (mechanics M55). */
export async function readRoster(claudePath: string, exec: Exec, all = false): Promise<RosterResult> {
  const result = await exec(claudePath, ['agents', '--json', ...(all ? ['--all'] : [])], { timeoutMs: ROSTER_TIMEOUT_MS, env: claudeEnvironment(claudePath) });

  if (result.code !== 0) {
    return { error: failureOf(claudePath, result, ROSTER_TIMEOUT_MS) };
  }

  try {
    const entries: unknown = JSON.parse(result.stdout);

    return Array.isArray(entries) ? { entries: entries as RosterEntry[] } : { error: 'claude agents returned an unexpected response.' };
  } catch {
    return { error: 'claude agents returned output that is not JSON.' };
  }
}

const STOP_TIMEOUT_MS = 15_000;

/** `claude stop`, never `claude rm`, which can delete the session's worktree (GC M33); only an earlier hub's background session is stopped so. */
export async function stopSession(claudePath: string, shortId: string, exec: Exec): Promise<{ error: string } | null> {
  const result = await exec(claudePath, ['stop', shortId], { timeoutMs: STOP_TIMEOUT_MS, env: claudeEnvironment(claudePath) });

  return result.code === 0 ? null : { error: failureOf(claudePath, result, STOP_TIMEOUT_MS) };
}

/** The roster entry of a session, matched by short ID. */
export function entryFor(entries: RosterEntry[], shortId: string): RosterEntry | undefined {
  return entries.find((entry) => entry.id === shortId || entry.sessionId.startsWith(shortId));
}

/**
 * The roster's state for a session without a hook marker: `working` runs, `blocked` waits for the operator, `done` and
 * `stopped` ended the turn. An interactive entry, such as a VS Code tab, has only `status`: `idle`, `busy` or `waiting` (M7).
 */
export function rosterState(entry: RosterEntry): LiveState {
  if (entry.state === undefined) {
    return entry.status === 'idle' ? 'idle' : entry.status === 'waiting' ? 'waiting' : 'running';
  }

  switch (entry.state) {
    case 'blocked':
      return 'waiting';
    case 'done':
    case 'stopped':
      return 'idle';
    default:
      return 'running';
  }
}

/**
 * The roster event for sessions Switchboard does not hold, such as a registered session in the operator's own window (PRD R81): those an interactive
 * roster entry with a process holds, with the state their hook marker gives, else the roster's. A background entry is a session an earlier hub ran in
 * Claude's background service, which the hub no longer follows (PRD R93), and an entry without a pid holds no process (GC M33).
 */
export function observe(entries: RosterEntry[], sessions: { id: string; shortId: string | null }[], markers: ReadonlyMap<string, Marker>): ObservedSession[] {
  const observed: ObservedSession[] = [];
  const live = entries.filter((entry) => entry.pid !== undefined && entry.kind !== 'background');

  for (const session of sessions) {
    const entry = session.shortId === null ? undefined : entryFor(live, session.shortId);

    if (entry !== undefined) {
      observed.push({ sessionId: session.id, ...stateOf(entry, markers), interactive: true });
    }
  }

  return observed;
}

/** The roster event's forks: each session's fork entry with the state its own marker gives, else the roster's (PRD R78). */
export function observeForks(forks: ReadonlyMap<string, RosterEntry>, markers: ReadonlyMap<string, Marker>): ObservedFork[] {
  return [...forks].map(([sessionId, entry]) => ({ sessionId, nativeSessionId: entry.sessionId, shortId: entry.id ?? entry.sessionId.slice(0, 8), ...stateOf(entry, markers) }));
}

/** The hook marker's state, else the roster's. */
function stateOf(entry: RosterEntry, markers: ReadonlyMap<string, Marker>): { state: LiveState; detail: string | null } {
  const marker = markers.get(entry.sessionId);

  // A tab or terminal that resumed the session has run no turn yet, though the roster lists it as busy while it loads (M25).
  if (marker?.event === 'SessionStart' && marker.source !== 'compact') {
    return { state: 'idle', detail: null };
  }

  return (marker === undefined ? null : markerState(marker)) ?? { state: rosterState(entry), detail: null };
}
