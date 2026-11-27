import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ClaudeRunner, conversationRules, markerState, projectSlug, readMarkers, rosterState } from '@switchboard/claude';
import type { RosterEntry } from '@switchboard/claude';
import { CodexRunner } from '@switchboard/codex';
import type { Exec, ExecResult } from '@switchboard/claude';
import { BACKOFF_MS, CLI_MARGIN_MS, CONTINUE_TEXT, CONVERSATION_RETENTION, DEFAULT_SETTINGS, launchOptions, MESSAGES, parsePlaybook, QUESTION_CARD, Store, toneSection, toneVersion, UNCONFIRMED_DONE } from '@switchboard/core';
import { recordPath } from '@switchboard/holder';
import type { SessionEntry } from '@switchboard/holder';
import { NotWritten } from '@switchboard/conversation';
import { markOf } from '@switchboard/core/group';
import type { ContextResult, CopyRelation, Playbook, PolledTicket, PollResult, PullRequestStatus, Session, SessionRunner, Settings, Source, StartAction, Ticket } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { HolderConnection } from '../src/holder.js';
import { ConversationService } from '../src/conversation.js';
import { WindowScopes } from '../src/windows.js';
import { ATTACH_RESERVATION_MS, INPUT_SETTLE_MS, PULL_REQUESTS_FOCUS_MS, questionCardOpen, REPORT_CHECK_MS, MARKER_MS, RECHECK_MS, MARKER_WATCH_RETRY_MS, repoKeysOf, Runtime, SESSION_ENDED, SESSION_RELAUNCHED, triageText, WAKE_MS } from '../src/runtime.js';
import type { RuntimeDeps } from '../src/runtime.js';
import { controlsOf, doneSince } from '../src/rows.js';
import { dockView } from '../src/dock.js';
import { questionIndex, QUESTIONS_SINCE } from '../src/questions.js';

export const T0 = Date.UTC(2026, 9, 3, 12);

export let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchboard-runtime-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

export function playbook(name: string, entry: unknown): [string, Playbook] {
  const parsed = parsePlaybook(name, entry);

  if ('error' in parsed) {
    throw new Error(parsed.error);
  }

  return [name, parsed.playbook];
}

export const PLAYBOOKS = new Map([
  playbook('triage:github', { description: 'Triage', kind: 'triage', template: 'Classify.' }),
  playbook('dev:develop', { description: 'Build it', autoStart: true, reports: ['done', 'approval', 'worktree'], template: 'Build {{ticket.sourceKey}}.' }),
]);

export function config(patch: Partial<Settings['sessions']> = {}): Config {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      sessions: { ...DEFAULT_SETTINGS.sessions, installHooks: false, ...patch },
      sources: { github: { kind: 'github', pollIntervalSeconds: 300, repoRoot: 'D:/git/widgets', triagePlaybook: 'triage:github', setupPrompt: '', namespace: '', options: {} } },
    },
    settingsError: null,
    settingsWarnings: [],
    playbooks: PLAYBOOKS,
    playbookErrors: [],
  };
}

export const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', missing: false, timedOut: false });
export const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr, missing: false, timedOut: false });

/** A fake Claude CLI and git. `roster` is what `claude agents --json` lists. */
export class FakeCli {
  roster: object[] = [];
  gitGate: Promise<void> | null = null;
  gitEntered: (() => void) | null = null;
  /** When set, the next roster read lists the roster as it is now, then waits for this before returning. */
  rosterGate: Promise<void> | null = null;
  calls: string[][] = [];
  /** What `<sessions.nodePath> --version` answers. */
  nodeResult = ok('v24.0.0\n');
  /** When set, each Node.js check waits here for its answer instead of answering `nodeResult`. */
  heldNode: ((answer: ExecResult) => void)[] | null = null;
  nodeEnvs: Record<string, string>[] = [];
  /** Answers a Node.js check by its environment, before `nodeResult`. */
  nodeAnswer: ((env: Record<string, string>) => ExecResult | undefined) | null = null;
  classifyResult = ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:develop' } }));
  codexClassifyResult = ok('{"type":"turn.completed"}\n');
  /** Per-ticket classifier output by triage context, overriding `classifyResult`. */
  classifyByContext = new Map<string, ExecResult>();
  startResult: ExecResult | null = null;
  stopResult = ok('');
  worktrees = 'worktree D:/git/widgets\nHEAD abc\nbranch refs/heads/master\n\nworktree D:/git/widgets-wt/7-fix\nHEAD def\nbranch refs/heads/7-fix\n';
  started = 0;
  /** The start actions the held runner was given. */
  heldStarts: StartAction[] = [];
  /** The folder of each git call. */
  gitCwds: string[] = [];

  exec: Exec = async (file, args, options) => {
    this.calls.push([file, ...args]);

    if (file === 'git') {
      this.gitCwds.push(options.cwd ?? '');
      this.gitEntered?.();
      const gate = this.gitGate;
      this.gitGate = null;

      if (gate !== null) {
        await gate;
      }

      return ok(this.worktrees);
    }

    if (args[0] === '-p') {
      return this.classifyByContext.get(options.stdin ?? '') ?? this.classifyResult;
    }

    if (args[0] === 'exec' && args.includes('--output-schema')) {
      writeFileSync(args[args.indexOf('--output-last-message') + 1]!, '{"playbook":"dev:develop"}');
      return this.codexClassifyResult;
    }

    if (args[0] === 'agents') {
      const listed = JSON.stringify(this.roster);
      const gate = this.rosterGate;
      this.rosterGate = null;
      await gate;

      return ok(listed);
    }

    if (args[0] === 'stop') {
      this.roster = this.roster.filter((entry) => (entry as { id: string }).id !== args[1]);
      return this.stopResult;
    }

    if (args[0] === '--version') {
      this.nodeEnvs.push(options.env ?? {});
      return this.heldNode === null ? (this.nodeAnswer?.(options.env ?? {}) ?? this.nodeResult) : new Promise((answer) => this.heldNode!.push(answer));
    }

    throw new Error(`unexpected call ${file} ${args.join(' ')}`);
  };
}

export class FakeSource implements Source {
  readonly name = 'github';
  result: PollResult = { tickets: [] };
  /** When set, the next poll waits for this before returning the `result` it started with. */
  gate: Promise<void> | null = null;
  polls = 0;
  /** The sourceKeys of the current tickets each poll was given. */
  current: string[][] = [];
  context: (ticket: { sourceKey: string }) => Promise<ContextResult> = async (ticket) => ({ context: `Issue ${ticket.sourceKey} text` });
  checkLink?: NonNullable<Source['checkLink']>;
  ticketAt?: NonNullable<Source['ticketAt']>;
  assignmentAt?: NonNullable<Source['assignmentAt']>;
  pullRequests?: NonNullable<Source['pullRequests']>;

  async poll(current: readonly Ticket[]): Promise<PollResult> {
    this.polls++;
    this.current.push(current.map((ticket) => ticket.sourceKey));
    const result = this.result;
    const gate = this.gate;
    this.gate = null;
    await gate;

    return result;
  }

  /** The repository each branch was read in. */
  branchRepos: string[] = [];

  keyOfBranch(branch: string, repo: string): string | null {
    this.branchRepos.push(repo);
    const number = /^(\d+)-/.exec(branch)?.[1] ?? null;
    return number === null || repo === '' || repo === 'acme/widgets' ? number : `${repo}#${number}`;
  }
}

export const issue = (key: string): PolledTicket => ({ sourceKey: key, ref: `#${key}`, repo: '', sourceId: null, title: `Issue ${key}`, url: `u/${key}`, assigned: true, pool: false, sortAt: null, enteredAt: null });

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/** A fake Codex trust call for the Codex runner, which installs the Codex hooks, so no test starts a real Codex process. */
export class FakeCodex {
  trustError: string | null = null;
  trustCalls = 0;
  /** When set, each trust call waits here for its answer instead of answering `trustError`. */
  heldTrust: ((answer: string | null) => void)[] | null = null;

  runner(): CodexRunner {
    return new CodexRunner({
      codexPath: () => 'codex',
      home: join(home, '.switchboard'),
      codexHome: join(home, '.codex'),
      env: {},
      nodePath: () => 'node',
      trust: async () => {
        this.trustCalls += 1;
        return this.heldTrust === null ? this.trustError : new Promise((answer) => this.heldTrust!.push(answer));
      },
    });
  }
}

/**
 * A stand-in for the terminal holder's runner, which holds every Claude session (PRD R93): a start lists the session in the fake CLI's roster under
 * a short ID, so a test drives its state through that list and the hook markers, and a stop takes it off the list.
 */
export function heldRunner(cli: FakeCli, hooks: () => boolean): SessionRunner {
  const markers = () => (hooks() ? readMarkers(join(home, '.switchboard')) : new Map<string, ReturnType<typeof readMarkers> extends Map<string, infer M> ? M : never>());

  return {
    start: async (action) => {
      cli.heldStarts.push(action);
      // A start waits on the holder, as a real one does.
      await new Promise((done) => setImmediate(done));

      if (cli.startResult !== null && cli.startResult.code !== 0) {
        return { error: cli.startResult.stderr.trim() };
      }

      const id = `0000000${++cli.started}`;

      cli.roster.push({ id, sessionId: `${id}-native`, pid: 100 + cli.started, kind: 'interactive', cwd: action.cwd, status: 'busy' });

      return { shortId: id, nativeSessionId: `${id}-native`, ...(action.launchId === undefined ? {} : { launchId: action.launchId }) };
    },
    observe: async (sessions) => {
      const read = await cli.exec('claude', ['agents', '--json'], { timeoutMs: 1 });

      if (read.code !== 0) {
        return { error: read.stderr };
      }

      const entries: unknown = JSON.parse(read.stdout);
      const known = markers();

      if (!Array.isArray(entries)) {
        return { error: 'claude agents returned an unexpected response.' };
      }

      return {
        sessions: sessions.flatMap((session) => {
          const entry = (entries as RosterEntry[]).find((one) => one.id === session.shortId && one.pid !== undefined);
          const marker = session.nativeSessionId === null ? undefined : known.get(session.nativeSessionId);

          return entry === undefined ? [] : [{ sessionId: session.id, ...((marker === undefined ? null : markerState(marker)) ?? { state: rosterState(entry), detail: null }), interactive: false }];
        }),
      };
    },
    markers: () => new Map([...markers()].map(([id, marker]) => [id, { at: marker.at ?? 0, cwd: marker.cwd ?? null, observed: markerState(marker), recheck: false }])),
    isBackground: async () => true,
    stop: async (target) => {
      const result = await cli.exec('claude', ['stop', target.shortId ?? ''], { timeoutMs: 1 });

      return result.code === 0 ? null : { error: result.stderr };
    },
    reconcile: async (sessions) =>
      sessions.map((session) => {
        const entry = (cli.roster as RosterEntry[]).find((one) => one.sessionId === session.nativeSessionId && one.pid !== undefined);

        return entry === undefined ? { sessionId: session.id, failed: 'Switchboard stopped while the session was starting.' } : { sessionId: session.id, started: { shortId: entry.id!, nativeSessionId: entry.sessionId } };
      }),
    installHooks: async () => null,
  };
}

/** A stand-in for the Codex app-server runner, whose starts give the session a thread at once, so no test starts a Codex daemon (PRD R107). */
export function appServerRunner(): SessionRunner {
  return {
    start: async (action) => ({ shortId: `${action.sessionId}-thread`, nativeSessionId: `${action.sessionId}-thread` }),
    observe: async (sessions) => ({ sessions: sessions.filter((session) => session.state !== 'ended').map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) }),
    markers: () => new Map(),
    isBackground: async () => true,
    stop: async () => null,
    reconcile: async () => [],
    installHooks: async () => null,
  };
}

/** A null `codex` leaves the runtime to build its own Codex runner. */
export function setup(cfg = config(), now = () => T0, runners?: RuntimeDeps['runners'], codex: FakeCodex | null = new FakeCodex(), named: Record<string, FakeSource> = {}, extra: Partial<RuntimeDeps> = {}) {
  const store = Store.open(':memory:');
  const cli = new FakeCli();

  for (const name of Object.keys(cfg.settings.sources)) {
    store.setSourceEnabled(name, true);
  }

  const source = new FakeSource();
  let ids = 0;
  const logs: string[] = [];
  // The done check's timeout fires only when a test releases it.
  const late = deferred();
  // The re-read after a blocked done report runs only when a test releases it.
  const recheck = deferred();
  const runtime = new Runtime(
    {
      home,
      store,
      exec: cli.exec,
      makeSource: (name, settings) => (named[name] !== undefined ? { source: named[name] } : settings.kind === 'github' ? { source } : null),
      now,
      sleep: (ms) => (ms === REPORT_CHECK_MS ? late.promise : ms === RECHECK_MS ? recheck.promise : Promise.resolve()),
      newSessionId: () => `s${++ids}`,
      claudeSettings: join(home, '.claude', 'settings.json'),
      configDir: join(home, 'cfg'),
      log: (line) => logs.push(line),
      runners: { codeMode: heldRunner(cli, () => cfg.settings.sessions.installHooks), codexAppServer: appServerRunner(), ...(codex === null ? {} : { codex: codex.runner() }), ...runners },
      ...extra,
    },
    cfg,
  );

  return { store, cli, source, runtime, logs, late, recheck, codex };
}


/** A stand-in runner whose observation and stops a test sets. */
export function fakeRunner(overrides: Partial<SessionRunner> = {}): SessionRunner & { stops: string[]; starts: string[] } {
  const stops: string[] = [];
  const starts: string[] = [];

  return {
    start: async (action) => {
      starts.push(action.sessionId);
      return { shortId: `${action.sessionId}-short`, nativeSessionId: `${action.sessionId}-native`, ...(action.codeMode === true ? { launchId: `${action.sessionId}-launch` } : {}) };
    },
    observe: async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) }),
    markers: () => new Map(),
    isBackground: async () => true,
    stop: async (target) => {
      stops.push(target.sessionId);
      return null;
    },
    reconcile: async () => [],
    installHooks: async () => null,
    stops,
    starts,
    ...overrides,
  };
}

/** A session s1 Switchboard does not hold, which Claude's roster follows, and a held Code Mode session s2, both running. */
export async function twoSessions(codeMode: SessionRunner) {
  const claude = fakeRunner();
  const context = setup(config(), () => T0, { claude, codeMode });

  context.runtime.send({ type: 'adhoc', prompt: 'background', repoRoot: 'D:/git/widgets', start: true });
  context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
  await context.runtime.settled();
  context.store.updateSession('s1', { codeMode: false, launchId: null });
  context.store.updateSession('s2', { codeMode: true, launchId: 'launch-2' });

  return { ...context, claude };
}

/** A held session whose transcript the real Claude conversation adapter reads, with each wait between its reads counted. */
export async function transcriptSession() {
  const context = setup(config({ codeMode: true }), () => T0, { codeMode: fakeRunner() });
  const { runtime, store } = context;
  const sleeps: number[] = [];
  const service = new ConversationService({
    store,
    windows: new WindowScopes({ store, windows: join(home, 'windows'), newKey: () => 'k' }),
    projectsDir: join(home, 'projects'),
    claudeConfig: join(home, '.claude.json'),
    screen: async () => null,
    input: { reserve: async () => ({ refused: 'unused' }), write: async () => ({ rev: 0 }), cannotType: () => null },
    hooks: () => true,
    now: () => T0,
    sleep: async (ms) => { sleeps.push(ms); await new Promise((resolve) => setImmediate(resolve)); },
    newId: () => String(sleeps.length),
    log: () => {},
  });

  runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
  await runtime.settled();
  runtime.setConversationReader({ read: (ids) => service.readNow(ids), catchUp: (id) => service.catchUp(id) });
  const session = store.activeSessions()[0]!;
  const folder = join(home, 'projects', projectSlug(session.cwd));
  const path = join(folder, `${session.nativeSessionId}.jsonl`);
  const at = new Date(T0).toISOString();
  const lines = {
    prompt: JSON.stringify({ type: 'user', uuid: 'u1', timestamp: at, message: { role: 'user', content: 'Start' } }),
    question: JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Before I go on:\n\n1. Which port?\n   - A) 8765\n   - B) 8799' }] } }),
    hooks: JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', uuid: 's1', timestamp: at, isSidechain: false }),
    duration: JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 's2', timestamp: at, durationMs: 4026, isSidechain: false }),
  };
  const append = (...more: string[]) => appendFileSync(path, more.map((line) => `${line}\n`).join(''));

  mkdirSync(folder, { recursive: true });
  append(lines.prompt);
  return { ...context, service, session, sleeps, lines, append };
}
