import { START_PROMPT } from '@switchboard/core';
import type { LiveState, ObservedFork, ObservedSession, StartAction, StartResult } from '@switchboard/core';
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
  cwd: string;
  name?: string;
}

export const START_TIMEOUT_MS = 60_000;
export const LAUNCH_TIMEOUT_MS = 60_000;
const ROSTER_TIMEOUT_MS = 15_000;
export const STOP_TIMEOUT_MS = 15_000;
const ROSTER_POLL_MS = 2_000;

/**
 * Background session start (GC M33). `bgIsolation: none` lets the session edit its working directory; the prompt is one
 * argument, so a leading slash command survives. `--bg` ignores `--session-id`, so the short ID comes from its output.
 * The contract goes in the system prompt, which Claude records and reuses on resume until compaction (mechanics M30).
 */
export function startArgs(action: StartAction): string[] {
  return [
    '--bg',
    '--permission-mode',
    action.permissionMode,
    '--settings',
    JSON.stringify({ worktree: { bgIsolation: 'none' } }),
    '-n',
    action.name,
    ...(action.model === null ? [] : ['--model', action.model]),
    '--append-system-prompt',
    action.contract,
    action.prompt,
  ];
}

/** Reads the short ID from `backgrounded · <id> · <name>`. */
export function shortIdFrom(stdout: string): string | null {
  return /^\s*backgrounded\s+·\s+([0-9a-f]{8})\s+·/m.exec(stdout)?.[1] ?? null;
}

export type RosterResult = { entries: RosterEntry[] } | { error: string };

/** `claude agents --json`; `all` also lists background jobs whose process ended, such as one released to a VS Code tab (mechanics M55). */
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

/** The roster entry of a background session, matched by short ID. */
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

export interface StartDeps {
  exec: Exec;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Starts a background session and waits for its roster entry to have a pid. Claude's own message explains a refusal, such as an untrusted
 * directory. A session waiting on a prompt before it starts, such as approving the project's MCP servers, is listed `blocked` with no pid until
 * the operator answers (mechanics M41). Two such reads in a row start it as waiting on that prompt, which the operator answers by attaching.
 */
export async function startSession(claudePath: string, action: StartAction, deps: StartDeps): Promise<StartResult> {
  const launched = await deps.exec(claudePath, startArgs(action), { cwd: action.cwd, timeoutMs: LAUNCH_TIMEOUT_MS, env: claudeEnvironment(claudePath) });

  if (launched.code !== 0) {
    return { error: failureOf(claudePath, launched, LAUNCH_TIMEOUT_MS, { cwd: action.cwd }) };
  }

  const shortId = shortIdFrom(launched.stdout);

  if (shortId === null) {
    return { error: `Claude started a session without printing its ID: ${launched.stdout.trim()}` };
  }

  let blockedReads = 0;

  for (const deadline = deps.now() + START_TIMEOUT_MS; deps.now() < deadline; await deps.sleep(ROSTER_POLL_MS)) {
    const roster = await readRoster(claudePath, deps.exec);
    const entry = 'entries' in roster ? entryFor(roster.entries, shortId) : undefined;

    // A new entry has no pid for its first seconds (mechanics M5); the session is alive once it does.
    if (entry?.pid !== undefined) {
      return { shortId, nativeSessionId: entry.sessionId };
    }

    blockedReads = entry?.state === 'blocked' ? blockedReads + 1 : 0;

    if (entry !== undefined && blockedReads === 2) {
      return { shortId, nativeSessionId: entry.sessionId, startPrompt: true };
    }
  }

  return { error: `Session ${shortId} did not appear in claude agents within ${START_TIMEOUT_MS / 1000} seconds.` };
}

/**
 * Continue in Background's resume (PRD R89): no flag but the prompt, so Claude wakes the session with the options it started with and keeps its
 * IDs; any flag, or a session still live, starts a copy instead (mechanics M18, M30, M55).
 */
export function resumeArgs(nativeSessionId: string, prompt: string): string[] {
  return ['--bg', '--resume', nativeSessionId, prompt];
}

/** The short ID from `… so this started a copy as <id>`, which `claude --bg --resume` prints when it did not resume the session itself (M55). */
export function copyFrom(output: string): string | null {
  return /started a copy as ([0-9a-f]{8})/.exec(output)?.[1] ?? null;
}

export const NOT_SWITCHBOARD = "This tab's session is not one of Switchboard's work items.";
export const NEVER_BACKGROUND = 'This session never ran in the background, so it cannot continue there.';

/**
 * The session a Claude tab labelled `label` holds (PRD R89). The tab's label is the session's name, and `--all` lists the session's earlier
 * background job beside its live interactive entry, which shows Claude holds the options to resume it with (mechanics M55).
 */
export function tabSession(entries: RosterEntry[], label: string): { nativeSessionId: string; pid: number } | { refused: string } {
  const live = entries.filter((entry) => entry.name === label && entry.pid !== undefined && entry.kind !== 'background');

  if (live.length > 1) {
    return { refused: `Several running Claude sessions are named "${label}", so Switchboard cannot tell which one this tab holds.` };
  }

  const [entry] = live;

  if (entry === undefined) {
    return { refused: NOT_SWITCHBOARD };
  }

  if (!entries.some((other) => other.sessionId === entry.sessionId && other.kind === 'background')) {
    return { refused: NEVER_BACKGROUND };
  }

  return { nativeSessionId: entry.sessionId, pid: entry.pid! };
}

/** `claude stop`, never `claude rm`, which can delete the session's worktree (GC M33). */
export async function stopSession(claudePath: string, shortId: string, exec: Exec): Promise<{ error: string } | null> {
  const result = await exec(claudePath, ['stop', shortId], { timeoutMs: STOP_TIMEOUT_MS, env: claudeEnvironment(claudePath) });

  return result.code === 0 ? null : { error: failureOf(claudePath, result, STOP_TIMEOUT_MS) };
}

/**
 * The roster event for Switchboard's sessions: those whose roster entry holds a process, with the state their hook
 * marker gives, else the roster's. A listed entry without a pid holds no process (GC M33).
 */
export function observe(entries: RosterEntry[], sessions: { id: string; shortId: string | null; state?: string; stateDetail?: string | null }[], markers: ReadonlyMap<string, Marker>): ObservedSession[] {
  const observed: ObservedSession[] = [];

  for (const session of sessions) {
    const entry = session.shortId === null ? undefined : entryFor(entries, session.shortId);

    // A session that started waiting on a prompt has no pid until the operator answers it. The roster lists a gone process the same way, so
    // only a session that started so is taken to wait (mechanics M41).
    if (entry !== undefined && entry.pid === undefined && entry.state === 'blocked' && session.state === 'waiting' && session.stateDetail === START_PROMPT) {
      observed.push({ sessionId: session.id, state: 'waiting', detail: START_PROMPT, interactive: false });
      continue;
    }

    if (entry?.pid === undefined) {
      continue;
    }

    observed.push({ sessionId: session.id, ...stateOf(entry, markers), interactive: entry.kind !== 'background' });
  }

  return observed;
}

/** The roster event's forks: each session's fork entry with the state its own marker gives, else the roster's (PRD R78). */
export function observeForks(forks: ReadonlyMap<string, RosterEntry>, markers: ReadonlyMap<string, Marker>): ObservedFork[] {
  return [...forks].map(([sessionId, entry]) => ({ sessionId, nativeSessionId: entry.sessionId, shortId: entry.id ?? entry.sessionId.slice(0, 8), ...stateOf(entry, markers) }));
}

function stateOf(entry: RosterEntry, markers: ReadonlyMap<string, Marker>): { state: LiveState; detail: string | null } {
  const marker = markers.get(entry.sessionId);

  // A tab or terminal that resumed the session has run no turn yet, though the roster lists it as busy while it loads (M25).
  if (entry.kind !== 'background' && marker?.event === 'SessionStart' && marker.source !== 'compact') {
    return { state: 'idle', detail: null };
  }

  return (marker === undefined ? null : markerState(marker)) ?? { state: rosterState(entry), detail: null };
}
