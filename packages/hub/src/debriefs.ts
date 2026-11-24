import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { DEBRIEF_ENV, debriefRange, failureOf, findTranscript, frictionOf, rosterState, runDebrief, scopeOf, subagentTranscripts } from '@switchboard/claude';
import type { DebriefCache, DebriefRange, DebriefResult, Exec, ExecResult, FrictionEntry, RosterResult } from '@switchboard/claude';
import { codexDebriefRange, codexScopeOf, findRollout, runCodexDebrief, appServerDebriefRange } from '@switchboard/codex';
import type { Json } from '@switchboard/codex';
import type { CodexDebriefRange } from '@switchboard/codex';
import type { Session } from '@switchboard/core';

/** A session whose work item is not done is debriefed this long after its last turn, in case the operator resumes it (PRD R55). */
export const DEBRIEF_IDLE_MS = 45 * 60 * 1000;
/** Past this age the one-hour prompt cache has expired; the session is skipped rather than run cold. */
export const DEBRIEF_EXPIRY_MS = 60 * 60 * 1000;
/** Work since the last debrief needs at least this many main-transcript tool calls. */
export const DEBRIEF_TOOL_CALL_FLOOR = 10;
/** One fork or Codex debrief runs at most this long; a fork waits on the subagents it asks. */
export const DEBRIEF_TIMEOUT_MS = 10 * 60 * 1000;
/** How often the hub looks for sessions to debrief. */
export const DEBRIEF_SCAN_MS = 60 * 1000;
/** The agent-delegate debrief command's exit code for a thread that is not Codex's or has no turn since `--since`. */
const NOTHING_TO_DEBRIEF = 3;

/** What a debrief remembers about one session. Ground Control wrote the same file, so its sessions are not debriefed again. */
export interface SessionDebrief {
  /** The last message a successful debrief covered; the next one starts after it. */
  throughMessageUuid: string | null;
  debriefedAt: string | null;
  /** Failed attempts on the range ending at `attemptedThrough`; Switchboard makes one, so a failed range waits for new work. */
  attempts: number;
  lastError: string | null;
  attemptedAt: string | null;
  attemptedThrough: string | null;
}

/** What a debrief remembers about one Codex thread a debriefed session delegated to, in Ground Control's format. */
export interface CodexDebrief {
  parentSessionId: string;
  cwd: string;
  /** The last successful debrief; the next one asks only about turns since. */
  debriefedAt: string | null;
  lastError: string | null;
  /** Set when a debriefed session's range names the thread; cleared by the thread's one attempt, so a restart still asks it. */
  pending: boolean;
  attempts: number;
  attemptedAt: string | null;
}

/** `state.json`. */
export interface DebriefState {
  v: 1;
  sessions: Record<string, SessionDebrief>;
  codex: Record<string, CodexDebrief>;
  /** When each subagent a fork was shown was last debriefed, keyed `<sessionId>/<agentId>`. */
  subagents: Record<string, string>;
}

/** One line of `log/YYYY-MM.jsonl`, which the friction-review skill reads. */
export type DebriefLogEntry = {
  v: 1;
  at: string;
  sessionId: string;
  cwd: string;
  friction: FrictionEntry[];
} & (
  | {
      provider: 'claude';
      parentSessionId: null;
      fromMessageUuid: string | null;
      throughMessageUuid: string;
      skills: string[];
      toolCalls: number;
      cache: DebriefCache | null;
      startedAt: string;
      subagents: string[];
      delegated: string[];
    }
  /** A Codex thread a Claude session delegated to, through agent-delegate. */
  | { provider: 'codex'; parentSessionId: string; fromMessageUuid: null; throughMessageUuid: null; skills: null; toolCalls: null; cache: null }
  /** A Codex session's own thread; the message IDs are its turn IDs. */
  | { provider: 'codex'; parentSessionId: null; fromMessageUuid: string | null; throughMessageUuid: string; skills: null; toolCalls: number; cache: null }
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The state, empty when the file does not exist, or null when it cannot be read. */
export function readDebriefState(dir: string): DebriefState | null {
  let text: string;

  try {
    text = readFileSync(`${dir}/state.json`, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { v: 1, sessions: {}, codex: {}, subagents: {} } : null;
  }

  try {
    const state: unknown = JSON.parse(text);

    if (!isRecord(state) || state['v'] !== 1 || !isRecord(state['sessions'])) {
      return null;
    }

    return {
      v: 1,
      // An entry that is not an object is dropped, so its session is asked about the whole transcript again.
      sessions: Object.fromEntries(Object.entries(state['sessions']).filter(([, entry]) => isRecord(entry))) as Record<string, SessionDebrief>,
      codex: isRecord(state['codex']) ? (state['codex'] as Record<string, CodexDebrief>) : {},
      subagents: isRecord(state['subagents']) ? (state['subagents'] as Record<string, string>) : {},
    };
  } catch {
    return null;
  }
}

function writeState(dir: string, state: DebriefState): boolean {
  try {
    const path = `${dir}/state.json`;
    const tmp = `${path}.${process.pid}.tmp`;

    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, path);

    return true;
  } catch {
    return false;
  }
}

/** The text inside a Markdown code fence the model may wrap its JSON in. */
function unfenced(text: string): string {
  return /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text)?.[1] ?? text;
}

/** Whether the file ends inside a line, as a write cut short leaves it. */
function endsInsideLine(path: string): boolean {
  try {
    return statSync(path).size > 0 && !readFileSync(path, 'utf8').endsWith('\n');
  } catch {
    return false;
  }
}

function appendLog(dir: string, entry: DebriefLogEntry): boolean {
  try {
    const path = `${dir}/log/${entry.at.slice(0, 7)}.jsonl`;

    mkdirSync(`${dir}/log`, { recursive: true });
    // Starting a fresh line keeps this one readable after a write cut short.
    appendFileSync(path, `${endsInsideLine(path) ? '\n' : ''}${JSON.stringify(entry)}\n`);

    return true;
  } catch {
    return false;
  }
}

export interface DebriefDeps {
  appServer?: { history(threadId: string): Promise<Json[]>; run(threadId: string, prompt: string, timeoutMs: number): Promise<{ text: string } | { error: string }> };
  /** Holds `state.json` and `log/`. */
  dir: string;
  /** The debrief prompt; `{{scope}}` names the work it covers and `{{subagents}}` the subagents the fork may message. */
  promptPath: string;
  /** Claude's `projects` directory, where transcripts are. */
  projectsDir: string;
  /** The Claude Code CLI (`sessions.claudePath`). */
  claudePath(): string;
  /** agent-delegate's debrief command for a Codex thread, run with `nodePath`; skipped when the file is missing. */
  codexScript: string;
  /** The Codex CLI (`sessions.codexPath`) and Codex's home, whose `sessions` folder holds the rollouts, for Codex sessions' own debriefs. */
  codexPath(): string;
  codexHome: string;
  nodePath: string;
  exec: Exec;
  enabled(): boolean;
  /** Switchboard's started sessions. */
  sessions(): Session[];
  /** Whether the work item is done; its sessions are debriefed without the idle wait. */
  workItemDone(workItemId: number): boolean;
  roster(): Promise<RosterResult>;
  now(): number;
  newId(): string;
  log(line: string): void;
}

/** One debrief's entries, merged into the state on disk. */
interface Change {
  sessions?: Record<string, SessionDebrief>;
  codex?: Record<string, CodexDebrief>;
  subagents?: Record<string, string>;
}

type Candidate = {
  session: Session & { nativeSessionId: string };
  transcript: string;
  writtenAt: number;
} & ({ provider: 'claude'; range: DebriefRange } | { provider: 'codex'; range: CodexDebriefRange });

/** Whether a range is worth a fork: new work over the floor, and not a range whose debrief failed, which is reported and not retried. */
export function rangeDue(range: { throughMessageUuid: string; toolCalls: number }, held: SessionDebrief | undefined): boolean {
  if (range.throughMessageUuid === held?.throughMessageUuid || range.toolCalls < DEBRIEF_TOOL_CALL_FLOOR) {
    return false;
  }

  return held?.attemptedThrough !== range.throughMessageUuid;
}

/** The end of a candidate's range, which the state records. */
const throughOf = (candidate: Candidate): string => (candidate.provider === 'claude' ? candidate.range.throughMessageUuid : candidate.range.throughTurnId);

/**
 * Friction debriefs (PRD R55): forks each Switchboard session once it is 45 to 60 minutes past its last turn and has done
 * enough work, and appends what the fork reports to the debrief log. One fork runs at a time.
 */
export class Debriefs {
  private scanning = false;
  /** What a write could not store. No fork starts until it is stored, so a failed write neither loses nor repeats paid work. */
  private unsaved: { lines: DebriefLogEntry[]; change: Change } | null = null;
  /** The last condition logged, so a scan repeating it every minute says it once. */
  private said = '';
  /** Code Mode sessions whose skip was logged (PRD R55). */
  private readonly skippedCodeMode = new Set<string>();

  constructor(private readonly deps: DebriefDeps) {}

  /** True while a scan, and so possibly a fork, runs; the hub stays up for it. */
  running(): boolean {
    return this.scanning;
  }

  async scan(): Promise<void> {
    if (this.scanning || !this.deps.enabled()) {
      return;
    }

    this.scanning = true;

    try {
      await this.run();
    } catch (error) {
      this.deps.log(`debrief: the scan failed: ${String(error)}`);
    } finally {
      this.scanning = false;
    }
  }

  private say(condition: string, line: string): void {
    if (condition !== this.said) {
      this.said = condition;
      this.deps.log(line);
    }
  }

  private async run(): Promise<void> {
    if (this.unsaved !== null && !this.save(this.unsaved.change, this.unsaved.lines)) {
      return;
    }

    let prompt: string;

    try {
      prompt = readFileSync(this.deps.promptPath, 'utf8');
    } catch {
      this.say('no-prompt', `debrief: no prompt at ${this.deps.promptPath}, so no session is debriefed`);
      return;
    }

    // Threads a stopped hub or a held write left waiting are asked before any new fork.
    await this.askPending();

    if (this.unsaved !== null) {
      return;
    }

    const tried = new Set<string>();

    // The state and roster are read again before each fork, because a fork can take minutes in which a session may resume.
    for (;;) {
      const state = readDebriefState(this.deps.dir);

      if (state === null) {
        this.say('bad-state', `debrief: ${this.deps.dir}/state.json cannot be read; debriefs wait until it can`);
        return;
      }

      this.said = '';

      const next = this.deps.enabled() ? await this.next(state, tried) : null;

      if (next === null) {
        return;
      }

      tried.add(next.session.id);

      if (next.provider === 'codex') {
        // A Codex session's run decides its state in the store, read again here, as the scan may have taken a while.
        const fresh = this.deps.sessions().find((session) => session.id === next.session.id);

        if (fresh === undefined || !['idle', 'failed', 'ended'].includes(fresh.state)) {
          continue;
        }
      } else {
        const roster = await this.deps.roster();

        if ('error' in roster) {
          this.deps.log(`debrief: the roster could not be read: ${roster.error}`);
          return;
        }

        const entry = roster.entries.find((candidate) => candidate.sessionId === next!.session.nativeSessionId && candidate.pid !== undefined);

        if (entry !== undefined && rosterState(entry) !== 'idle') {
          continue;
        }
      }

      // The roster read can take seconds, in which the setting can change or the cache expire.
      if (!this.deps.enabled() || this.deps.now() - next.writtenAt >= DEBRIEF_EXPIRY_MS) {
        continue;
      }

      await (next.provider === 'claude' ? this.debrief(state, prompt, next) : this.debriefCodexSession(state, prompt, next));
      await this.askPending();

      if (this.unsaved !== null) {
        return;
      }
    }
  }

  /** The due session nearest cache expiry, with the range its debrief covers. */
  private async next(state: DebriefState, tried: ReadonlySet<string>): Promise<Candidate | null> {
    const now = this.deps.now();
    const candidates: Candidate[] = [];

    for (const session of this.deps.sessions()) {
      const ended = session.endedAt === null ? false : now - session.endedAt >= DEBRIEF_EXPIRY_MS;

      if (session.nativeSessionId === null || tried.has(session.id) || ended || !['idle', 'failed', 'ended'].includes(session.state)) {
        continue;
      }

      // `claude -p --resume` refuses a Code Mode session, and resuming it without Code Mode is refused too (mechanics M74).
      if (session.codeMode === true) {
        if (!this.skippedCodeMode.has(session.id)) {
          this.skippedCodeMode.add(session.id);
          this.deps.log(`debrief: session ${session.id} skipped, because Code Mode sessions cannot be debriefed`);
        }

        continue;
      }

      const held = state.sessions[session.nativeSessionId];

      if (session.provider === 'codex') {
        if (session.execution === 'app-server' && this.deps.appServer !== undefined) {
          if (now - (session.endedAt ?? session.stateAt) >= DEBRIEF_EXPIRY_MS) continue;
          try {
            const found = appServerDebriefRange(await this.deps.appServer.history(session.nativeSessionId), held?.throughMessageUuid ?? null);
            const age = found === null ? -1 : now - found.writtenAt;
            if (found !== null && age >= (this.deps.workItemDone(session.workItemId) ? 0 : DEBRIEF_IDLE_MS) && age < DEBRIEF_EXPIRY_MS && rangeDue({ throughMessageUuid: found.range.throughTurnId, toolCalls: found.range.toolCalls }, held)) candidates.push({ provider: 'codex', session: session as Candidate['session'], transcript: '', ...found });
          } catch (error) { this.deps.log(`debrief: Codex history unavailable: ${String(error)}`); }
          continue;
        }
        const candidate = this.codexCandidate(session as Candidate['session'], held, now);

        if (candidate !== null) {
          candidates.push(candidate);
        }

        continue;
      }

      const transcript = findTranscript(this.deps.projectsDir, session.cwd, session.nativeSessionId);
      const age = transcript === null ? -1 : now - transcript.writtenAt;

      if (transcript === null || age < (this.deps.workItemDone(session.workItemId) ? 0 : DEBRIEF_IDLE_MS) || age >= DEBRIEF_EXPIRY_MS) {
        continue;
      }

      let text: string;

      try {
        text = readFileSync(transcript.path, 'utf8');
      } catch {
        continue;
      }

      const range = debriefRange(text, subagentTranscripts(transcript.path), session.nativeSessionId, held?.throughMessageUuid ?? null);

      if (range !== null && rangeDue(range, held)) {
        candidates.push({ provider: 'claude', session: session as Candidate['session'], transcript: transcript.path, writtenAt: transcript.writtenAt, range });
      }
    }

    return candidates.sort((left, right) => left.writtenAt - right.writtenAt)[0] ?? null;
  }

  /** A Codex session due for a debrief: its rollout's last turn 45 to 60 minutes old, or done, with enough tool calls since its last debrief. */
  private codexCandidate(session: Candidate['session'], held: SessionDebrief | undefined, now: number): Candidate | null {
    const rollout = findRollout(this.deps.codexHome, session.nativeSessionId);
    const age = rollout === null ? -1 : now - rollout.writtenAt;

    if (rollout === null || age < (this.deps.workItemDone(session.workItemId) ? 0 : DEBRIEF_IDLE_MS) || age >= DEBRIEF_EXPIRY_MS) {
      return null;
    }

    let text: string;

    try {
      text = readFileSync(rollout.path, 'utf8');
    } catch {
      return null;
    }

    const range = codexDebriefRange(text, held?.throughMessageUuid ?? null);

    return range !== null && rangeDue({ throughMessageUuid: range.throughTurnId, toolCalls: range.toolCalls }, held)
      ? { provider: 'codex', session, transcript: rollout.path, writtenAt: rollout.writtenAt, range }
      : null;
  }

  /** Asks a Codex session in an ephemeral fork of its thread; a failure is recorded on its range and not retried (PRD R55). */
  private async debriefCodexSession(state: DebriefState, prompt: string, candidate: Candidate & { provider: 'codex' }): Promise<void> {
    const thread = candidate.session.nativeSessionId;
    const held = state.sessions[thread];
    const through = candidate.range.throughTurnId;

    this.deps.log(`debrief: Codex session ${thread}, ${candidate.range.toolCalls} tool calls since ${held?.throughMessageUuid ?? 'the start'}`);

    const rendered = prompt.replaceAll('{{scope}}', () => codexScopeOf(candidate.range)).replaceAll('{{subagents}}', 'none');
    const result = await (candidate.session.execution === 'app-server' && this.deps.appServer !== undefined
      ? this.deps.appServer.run(thread, rendered, DEBRIEF_TIMEOUT_MS)
      : runCodexDebrief(
      {
        codexPath: this.deps.codexPath(),
        threadId: thread,
        cwd: candidate.session.cwd,
        // A Codex fork has no subagents to message.
        prompt: prompt.replaceAll('{{scope}}', () => codexScopeOf(candidate.range)).replaceAll('{{subagents}}', 'none'),
        env: { CODEX_HOME: this.deps.codexHome, [DEBRIEF_ENV]: '1' },
        timeoutMs: DEBRIEF_TIMEOUT_MS,
      },
      this.deps.exec,
    )).catch((error: unknown) => ({ error: `The debrief failed: ${String(error)}` }));
    const at = new Date(this.deps.now()).toISOString();
    let friction: FrictionEntry[] | null = null;

    if ('text' in result) {
      try {
        friction = frictionOf(JSON.parse(unfenced(result.text)));
      } catch {
        friction = null;
      }
    }

    const error = 'error' in result ? result.error : friction === null ? `the answer was not the friction JSON: ${result.text.slice(0, 200)}` : null;

    if (error !== null || friction === null) {
      this.deps.log(`debrief: Codex session ${thread} failed: ${error}`);
      this.save(
        {
          sessions: {
            [thread]: { throughMessageUuid: held?.throughMessageUuid ?? null, debriefedAt: held?.debriefedAt ?? null, attempts: 1, lastError: error, attemptedAt: at, attemptedThrough: through },
          },
        },
        [],
      );
      return;
    }

    this.deps.log(`debrief: Codex session ${thread}, ${friction.length} friction reports`);
    this.save(
      { sessions: { [thread]: { throughMessageUuid: through, debriefedAt: at, attempts: 0, lastError: null, attemptedAt: null, attemptedThrough: null } } },
      [
        {
          v: 1,
          at,
          provider: 'codex',
          sessionId: thread,
          parentSessionId: null,
          cwd: candidate.session.cwd,
          fromMessageUuid: held?.throughMessageUuid ?? null,
          throughMessageUuid: through,
          skills: null,
          toolCalls: candidate.range.toolCalls,
          cache: null,
          friction,
        },
      ],
    );
  }

  private async debrief(state: DebriefState, prompt: string, candidate: Candidate & { provider: 'claude' }): Promise<void> {
    const sessionId = candidate.session.nativeSessionId;
    const held = state.sessions[sessionId];
    const prefix = `${sessionId}/`;
    // One clock read: the fork chooses subagents by it, and a success records it as their last debrief.
    const startedMs = this.deps.now();
    const startedAt = new Date(startedMs).toISOString();

    this.deps.log(`debrief: ${sessionId}, ${candidate.range.toolCalls} tool calls since ${held?.throughMessageUuid ?? 'the start'}`);

    const result: DebriefResult = await runDebrief(
      {
        claudePath: this.deps.claudePath(),
        sessionId,
        forkId: this.deps.newId(),
        cwd: candidate.session.cwd,
        transcript: candidate.transcript,
        prompt: prompt.replaceAll('{{scope}}', () => scopeOf(candidate.range)),
        subagentsDebriefed: Object.fromEntries(Object.entries(state.subagents).filter(([key]) => key.startsWith(prefix)).map(([key, at]) => [key.slice(prefix.length), at])),
        now: startedMs,
        timeoutMs: DEBRIEF_TIMEOUT_MS,
      },
      this.deps.exec,
    ).catch((error: unknown) => ({ error: `The debrief failed: ${String(error)}` }));
    const at = new Date(this.deps.now()).toISOString();

    if ('error' in result) {
      this.deps.log(`debrief: ${sessionId} failed: ${result.error}`);
      this.save(
        {
          codex: this.pending(state, candidate),
          sessions: {
            [sessionId]: {
              throughMessageUuid: held?.throughMessageUuid ?? null,
              debriefedAt: held?.debriefedAt ?? null,
              attempts: 1,
              lastError: result.error,
              attemptedAt: at,
              attemptedThrough: candidate.range.throughMessageUuid,
            },
          },
        },
        [],
      );
    } else {
      this.deps.log(`debrief: ${sessionId}, ${result.friction.length} friction reports`);
      this.save(
        {
          codex: this.pending(state, candidate),
          sessions: { [sessionId]: { throughMessageUuid: candidate.range.throughMessageUuid, debriefedAt: at, attempts: 0, lastError: null, attemptedAt: null, attemptedThrough: null } },
          // A subagent's later work is what it wrote after this fork started.
          subagents: Object.fromEntries(result.subagents.map((agentId) => [`${prefix}${agentId}`, startedAt])),
        },
        [
          {
            v: 1,
            at,
            provider: 'claude',
            sessionId,
            parentSessionId: null,
            cwd: candidate.session.cwd,
            fromMessageUuid: held?.throughMessageUuid ?? null,
            throughMessageUuid: candidate.range.throughMessageUuid,
            skills: candidate.range.skills,
            toolCalls: candidate.range.toolCalls,
            cache: result.cache,
            friction: result.friction,
            startedAt,
            subagents: result.subagents,
            delegated: candidate.range.delegated,
          },
        ],
      );
    }

  }

  /** The range's delegated threads, marked to be asked. */
  private pending(state: DebriefState, candidate: Candidate & { provider: 'claude' }): Record<string, CodexDebrief> {
    return Object.fromEntries(
      candidate.range.delegated.map((thread) => {
        const held = state.codex[thread];

        return [thread, { parentSessionId: candidate.session.nativeSessionId, cwd: candidate.session.cwd, debriefedAt: held?.debriefedAt ?? null, lastError: held?.lastError ?? null, pending: true, attempts: 0, attemptedAt: held?.attemptedAt ?? null }];
      }),
    );
  }

  /** Asks every pending Codex thread once. */
  private async askPending(): Promise<void> {
    const state = readDebriefState(this.deps.dir);

    for (const [thread, held] of Object.entries(state?.codex ?? {})) {
      if (this.unsaved !== null || !this.deps.enabled()) {
        return;
      }

      if (held.pending === true) {
        await this.debriefCodex(thread, held);
      }
    }
  }

  /** Asks a Codex thread the session delegated to about its turns since its last debrief, once; a failure is reported, not retried. */
  private async debriefCodex(thread: string, held: CodexDebrief): Promise<void> {
    const { parentSessionId, cwd } = held;

    try {
      statSync(this.deps.codexScript);
    } catch {
      this.say('no-codex', `debrief: no Codex debrief command at ${this.deps.codexScript}, so delegated Codex threads are not debriefed`);
      return;
    }

    const since = held.debriefedAt;
    const result = await this.deps
      .exec(this.deps.nodePath, [this.deps.codexScript, thread, '--prompt', this.deps.promptPath, ...(since === null ? [] : ['--since', since])], {
      timeoutMs: DEBRIEF_TIMEOUT_MS,
      // Runs an Electron runtime as Node; plain Node ignores it.
      env: { ELECTRON_RUN_AS_NODE: '1', [DEBRIEF_ENV]: '1' },
    })
      .catch((error: unknown): ExecResult => ({ code: null, stdout: '', stderr: String(error), missing: false, timedOut: false }));
    const at = new Date(this.deps.now()).toISOString();
    let friction: FrictionEntry[] | null = null;

    if (result.code === 0) {
      try {
        friction = frictionOf(JSON.parse(result.stdout));
      } catch {
        friction = null;
      }
    }

    const error = result.code === NOTHING_TO_DEBRIEF || friction !== null ? null : result.code === 0 ? `the answer was not the friction JSON: ${result.stdout.slice(0, 200)}` : failureOf(this.deps.nodePath, result, DEBRIEF_TIMEOUT_MS, { notFound: `${this.deps.nodePath} was not found.` });

    if (error !== null) {
      this.deps.log(`debrief: Codex thread ${thread} failed: ${error}`);
    } else if (friction !== null) {
      this.deps.log(`debrief: Codex thread ${thread}, ${friction.length} friction reports`);
    }

    this.save(
      { codex: { [thread]: { parentSessionId, cwd, debriefedAt: friction === null ? since : at, lastError: error, pending: false, attempts: error === null ? 0 : 1, attemptedAt: error === null ? null : at } } },
      friction === null
        ? []
        : [{ v: 1, at, provider: 'codex', sessionId: thread, parentSessionId, cwd, fromMessageUuid: null, throughMessageUuid: null, skills: null, toolCalls: null, cache: null, friction }],
    );
  }

  /**
   * Appends the lines, then merges the change into the state as it is on disk, so another writer's entries are kept. What
   * cannot be written is held and written first by the next scan.
   */
  private save(change: Change, lines: DebriefLogEntry[]): boolean {
    const failed = lines.findIndex((line) => !appendLog(this.deps.dir, line));

    if (failed >= 0) {
      this.unsaved = { lines: lines.slice(failed), change };
    } else {
      const current = readDebriefState(this.deps.dir);
      const written =
        current !== null &&
        writeState(this.deps.dir, {
          ...current,
          sessions: { ...current.sessions, ...change.sessions },
          codex: { ...current.codex, ...change.codex },
          subagents: { ...current.subagents, ...change.subagents },
        });

      this.unsaved = written ? null : { lines: [], change };
    }

    if (this.unsaved !== null) {
      this.say('unsaved', `debrief: could not write to ${this.deps.dir}; debriefs wait until it can be written`);
    }

    return this.unsaved === null;
  }
}
