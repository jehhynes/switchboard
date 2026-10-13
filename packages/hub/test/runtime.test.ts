import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRunner } from '@switchboard/claude';
import { CodexRunner } from '@switchboard/codex';
import type { Exec, ExecResult } from '@switchboard/claude';
import { DEFAULT_SETTINGS, parsePlaybook, Store } from '@switchboard/core';
import type { ContextResult, Playbook, PolledTicket, PollResult, Session, SessionRunner, Settings, Source } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { REPORT_CHECK_MS, MARKER_MS, MARKER_WATCH_RETRY_MS, Runtime, triageText, WAKE_MS } from '../src/runtime.js';
import type { RuntimeDeps } from '../src/runtime.js';
import { controlsOf } from '../src/rows.js';

const T0 = Date.UTC(2026, 9, 3, 12);

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchboard-runtime-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function playbook(name: string, entry: unknown): [string, Playbook] {
  const parsed = parsePlaybook(name, entry);

  if ('error' in parsed) {
    throw new Error(parsed.error);
  }

  return [name, parsed.playbook];
}

const PLAYBOOKS = new Map([
  playbook('triage:github', { description: 'Triage', kind: 'triage', template: 'Classify.' }),
  playbook('dev:develop', { description: 'Build it', autoStart: true, reports: ['done', 'approval', 'worktree'], template: 'Build {{ticket.sourceKey}}.' }),
]);

function config(patch: Partial<Settings['sessions']> = {}): Config {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      sessions: { ...DEFAULT_SETTINGS.sessions, installHooks: false, ...patch },
      sources: { github: { pollIntervalSeconds: 300, repoRoot: 'D:/git/widgets', triagePlaybook: 'triage:github', setupPrompt: '', namespace: '', options: {} } },
    },
    settingsError: null,
    playbooks: PLAYBOOKS,
    playbookErrors: [],
  };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', missing: false, timedOut: false });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr, missing: false, timedOut: false });

/** A fake Claude CLI and git. `roster` is what `claude agents --json` lists. */
class FakeCli {
  roster: object[] = [];
  gitGate: Promise<void> | null = null;
  gitEntered: (() => void) | null = null;
  /** When set, the next roster read lists the roster as it is now, then waits for this before returning. */
  rosterGate: Promise<void> | null = null;
  calls: string[][] = [];
  classifyResult = ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:develop' } }));
  /** Per-ticket classifier output by triage context, overriding `classifyResult`. */
  classifyByContext = new Map<string, ExecResult>();
  startResult: ExecResult | null = null;
  stopResult = ok('');
  worktrees = 'worktree D:/git/widgets\nHEAD abc\nbranch refs/heads/master\n\nworktree D:/git/widgets-wt/7-fix\nHEAD def\nbranch refs/heads/7-fix\n';
  private started = 0;

  exec: Exec = async (file, args, options) => {
    this.calls.push([file, ...args]);

    if (file === 'git') {
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

    if (args[0] === '--bg') {
      if (this.startResult !== null) {
        return this.startResult;
      }

      const id = `0000000${++this.started}`;
      this.roster.push({ id, sessionId: `${id}-native`, pid: 100 + this.started, kind: 'background', cwd: '', state: 'working' });

      return ok(`backgrounded · ${id} · name\n`);
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

    throw new Error(`unexpected call ${file} ${args.join(' ')}`);
  };
}

class FakeSource implements Source {
  readonly name = 'github';
  result: PollResult = { tickets: [] };
  /** When set, the next poll waits for this before returning the `result` it started with. */
  gate: Promise<void> | null = null;
  polls = 0;
  context: (ticket: { sourceKey: string }) => Promise<ContextResult> = async (ticket) => ({ context: `Issue ${ticket.sourceKey} text` });
  checkLink?: NonNullable<Source['checkLink']>;

  async poll(): Promise<PollResult> {
    this.polls++;
    const result = this.result;
    const gate = this.gate;
    this.gate = null;
    await gate;

    return result;
  }

  keyOfBranch(branch: string): string | null {
    return /^(\d+)-/.exec(branch)?.[1] ?? null;
  }
}

const issue = (key: string): PolledTicket => ({ sourceKey: key, ref: `#${key}`, sourceId: null, title: `Issue ${key}`, url: `u/${key}`, assigned: true, pool: false, sortAt: null, enteredAt: null });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/**
 * A fake Codex: a process table, a spawner whose runs write `onSpawn`'s log, and a trust call, so no test starts a real Codex process. Its
 * runs live until a test ends them.
 */
class FakeCodex {
  alive = new Set<number>();
  nextPid = 500;
  spawned: string[][] = [];
  commandLines = new Map<number, string>();
  kills: number[] = [];
  trustError: string | null = null;
  queryError: string | null = null;
  onSpawn: (stdout: string, pid: number, args: string[]) => string = () => '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n';
  /** Holds the next process query until released. */
  queryGate: Promise<void> | null = null;
  queryEntered: (() => void) | null = null;

  runner(): CodexRunner {
    return new CodexRunner({
      codexPath: 'codex',
      exec: async () => {
        throw new Error('unexpected exec');
      },
      sleep: async () => {},
      now: () => T0,
      home: join(home, '.switchboard'),
      codexHome: join(home, '.codex'),
      env: {},
      hooks: () => true,
      spawn: async (_file, args, options) => {
        const pid = this.nextPid++;

        this.spawned.push(args);
        this.commandLines.set(pid, args.join(' '));
        this.alive.add(pid);
        writeFileSync(options.stdout, this.onSpawn(options.stdout, pid, args));
        writeFileSync(options.stderr, '');
        return { pid, error: null };
      },
      processes: async (pids) => {
        const gate = this.queryGate;

        this.queryGate = null;
        this.queryEntered?.();
        await gate;

        return this.queryError !== null ? { error: this.queryError } : new Map(pids.filter((pid) => this.alive.has(pid)).map((pid) => [pid, { pid, created: `c${pid}`, name: 'codex.exe', commandLine: this.commandLines.get(pid) ?? '' }]));
      },
      tagged: async () => null,
      alive: (pid) => this.alive.has(pid),
      kill: async (pid) => {
        this.kills.push(pid);
        this.alive.delete(pid);
        return null;
      },
      trust: async () => this.trustError,
    });
  }
}

function setup(cfg = config(), now = () => T0, runners?: RuntimeDeps['runners'], codex = new FakeCodex()) {
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
  const runtime = new Runtime(
    {
      home,
      store,
      exec: cli.exec,
      claudePath: 'claude',
      makeSource: (name) => (name === 'github' ? { source } : null),
      now,
      sleep: (ms) => (ms === REPORT_CHECK_MS ? late.promise : Promise.resolve()),
      newSessionId: () => `s${++ids}`,
      claudeSettings: join(home, '.claude', 'settings.json'),
      configDir: join(home, 'cfg'),
      log: (line) => logs.push(line),
      runners: { codex: codex.runner(), ...runners },
    },
    cfg,
  );

  return { store, cli, source, runtime, logs, late, codex };
}

describe('Runtime', () => {
  it('wakes a due snooze on its minute tick, without any other event', async () => {
    vi.useFakeTimers();
    try {
      let now = T0;
      const { store, source, runtime } = setup(config(), () => now);
      source.result = { tickets: [issue('5')] };
      store.insertTicket({ source: 'github', sourceKey: '5', ref: '#5', sourceId: null, title: 'Issue 5', url: 'u', assigned: true, pool: false, snoozed: true, snoozedUntil: T0 + WAKE_MS, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
      let changes = 0;
      runtime.onChange(() => changes++);
      runtime.start();

      now = T0 + WAKE_MS - 1;
      await vi.advanceTimersByTimeAsync(WAKE_MS - 1);
      expect(store.ticket(1)).toMatchObject({ snoozed: true, snoozedUntil: T0 + WAKE_MS });

      now = T0 + WAKE_MS;
      await vi.advanceTimersByTimeAsync(1);
      expect(store.ticket(1)).toMatchObject({ snoozed: false, snoozedUntil: null });
      expect(changes).toBeGreaterThan(0);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });


  it('polls, triages through the source and classifier, and starts the chosen playbook', async () => {
    const { store, cli, source, runtime } = setup();
    let changes = 0;
    runtime.onChange(() => changes++);
    source.result = { tickets: [issue('7')] };
    source.context = async (ticket) => ({ context: `Issue ${ticket.sourceKey} text`, links: [{ label: 'Pull request #70', target: 'https://github.com/o/r/pull/70' }] });

    await runtime.pollSource('github');
    await runtime.settled();

    expect(store.linksFor(1)).toMatchObject([{ label: 'Pull request #70', target: 'https://github.com/o/r/pull/70' }]);
    const classifyCall = cli.calls.find((call) => call[1] === '-p');
    expect(classifyCall?.at(-1)).toContain('Classify.');
    expect(store.triage(1)?.context).toBe('Current time: 2026-10-03 12:00 UTC\n\nIssue 7 text');
    expect(store.triage(1)).toMatchObject({ playbook: 'dev:develop' });
    expect(store.session('s1')).toMatchObject({ shortId: '00000001', nativeSessionId: '00000001-native', state: 'running', cwd: 'D:/git/widgets-wt/7-fix' });
    expect(store.workItem(1)?.status).toBe('running');
    expect(store.worktreeFor(1)).toMatchObject({ path: 'D:/git/widgets-wt/7-fix', branch: '7-fix', linkedBy: 'convention' });
    expect(cli.calls.find((call) => call[0] === 'git')).toEqual(['git', 'worktree', 'list', '--porcelain']);
    expect(changes).toBeGreaterThan(3);
  });

  it('logs a context warning and still triages', async () => {
    const { store, source, runtime, logs } = setup();
    source.result = { tickets: [issue('7')] };
    source.context = async (ticket) => ({ context: `Issue ${ticket.sourceKey} text`, warning: 'Roles file r.json is not JSON.' });

    await runtime.pollSource('github');
    await runtime.settled();

    expect(logs).toContain('triage context for #7: Roles file r.json is not JSON.');
    expect(store.triage(1)).toMatchObject({ playbook: 'dev:develop', error: null });
  });

  it('records a failed poll and a failed triage', async () => {
    const { store, cli, source, runtime } = setup();

    source.result = { error: 'The GitHub CLI is not signed in. Run gh auth login.' };
    await runtime.pollSource('github');
    expect(runtime.snapshot().errors.sources).toEqual({ github: 'The GitHub CLI is not signed in. Run gh auth login.' });

    source.result = { tickets: [issue('7')] };
    source.context = async () => ({ context: 'Issue 7 text', links: [{ label: 'Pull request #70', target: 'https://github.com/o/r/pull/70' }] });
    cli.classifyResult = fail('API Error: 529');
    await runtime.pollSource('github');
    await runtime.settled();

    expect(runtime.snapshot().errors.sources).toEqual({});
    expect(store.workItem(1)).toMatchObject({ status: 'failed', error: 'API Error: 529' });
    expect(store.linksFor(1)).toEqual([]);

    source.context = async () => ({ error: 'Issue 7 was not found in acme/widgets.' });
    runtime.send({ type: 'retriage', workItemId: 1 });
    await runtime.settled();
    expect(store.workItem(1)).toMatchObject({ status: 'failed', error: 'Issue 7 was not found in acme/widgets.' });
  });

  it("fails a start with Claude's message", async () => {
    const { store, cli, source, runtime } = setup();
    cli.startResult = fail('Workspace not trusted. Run `claude` in D:\\git\\widgets once and accept the trust prompt, then retry.');
    source.result = { tickets: [issue('8')] };

    await runtime.pollSource('github');
    await runtime.settled();

    expect(store.workItem(1)).toMatchObject({ status: 'failed', error: 'Workspace not trusted. Run `claude` in D:\\git\\widgets once and accept the trust prompt, then retry.' });
  });

  it('observes markers and the roster, releases the finished turn, and ends sessions that leave the roster', async () => {
    const { store, cli, source, runtime } = setup(config({ installHooks: true }));
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    mkdirSync(join(home, '.switchboard', 'activity'), { recursive: true });
    writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'PermissionRequest' }));
    runtime.readMarkers();
    expect(store.session('s1')?.state).toBe('waiting');

    writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'Stop', backgroundTasks: 0 }));
    await runtime.readRoster();
    await runtime.settled();

    expect(cli.calls.filter((call) => call[1] === 'stop')).toEqual([['claude', 'stop', '00000001']]);
    expect(store.session('s1')).toMatchObject({ state: 'ended', released: true });
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'The turn ended without a done report.' });
    expect(runtime.hasActiveSessions()).toBe(false);
  });

  it('never releases a session the roster lists as interactive', async () => {
    const { store, cli, source, runtime, logs } = setup(config({ installHooks: true }));
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    (cli.roster[0] as { kind: string }).kind = 'interactive';
    mkdirSync(join(home, '.switchboard', 'activity'), { recursive: true });
    writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'Stop', backgroundTasks: 0 }));
    runtime.readMarkers();
    await runtime.settled();

    expect(cli.calls.filter((call) => call[1] === 'stop')).toEqual([]);
    expect(logs).toEqual(['release skipped: session s1 is not a background process']);
    expect(store.session('s1')).toMatchObject({ state: 'idle', released: true });
  });

  it('reads a marker as soon as the hook writes it, before the marker timer fires', async () => {
    const { store, source, runtime } = setup(config({ installHooks: true }));
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    runtime.start();

    try {
      writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'PermissionRequest' }));
      await vi.waitFor(() => expect(store.session('s1')?.state).toBe('waiting'), { timeout: MARKER_MS / 2 });

      writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'PostToolUse', toolName: 'AskUserQuestion' }));
      await vi.waitFor(() => expect(store.session('s1')?.state).toBe('running'), { timeout: MARKER_MS / 2 });
    } finally {
      runtime.stop();
    }
  });

  it('watches the activity folder again after it is removed', async () => {
    const { store, source, runtime, logs } = setup(config({ installHooks: true }));
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    runtime.start();

    try {
      const dir = join(home, '.switchboard', 'activity');
      // Made again at once, so only the folder's identity shows the watch is stale.
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      writeFileSync(join(dir, 'other.json'), '{}');
      await vi.waitFor(() => expect(logs).toContain('marker watch stopped: the activity folder was removed or replaced'), { timeout: MARKER_MS / 2 });
      await new Promise((resolve) => setTimeout(resolve, MARKER_WATCH_RETRY_MS + 200));

      writeFileSync(join(dir, '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'PermissionRequest' }));
      await vi.waitFor(() => expect(store.session('s1')?.state).toBe('waiting'), { timeout: MARKER_MS / 2 });
    } finally {
      runtime.stop();
    }
  });

  it('reads the roster when a session that ended writes a marker, so a resumed session returns to Working at once', async () => {
    let now = T0;
    const { store, cli, source, runtime } = setup(config({ installHooks: true }), () => now);
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const dir = join(home, '.switchboard', 'activity');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'Stop', backgroundTasks: 0, at: T0 }));
    await runtime.readRoster();
    await runtime.settled();
    expect(store.session('s1')?.state).toBe('ended');
    expect(store.workItem(1)?.status).toBe('blocked');

    // Each marker reads the roster once, so a marker left by a process that is gone reads it once only.
    const reads = () => cli.calls.filter((call) => call[1] === 'agents').length;
    const idle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const before = reads();
    runtime.readMarkers();
    await idle();
    expect(reads()).toBe(before + 1);
    runtime.readMarkers();
    await idle();
    expect(reads()).toBe(before + 1);
    expect(store.session('s1')?.state).toBe('ended');

    // The marker time is the hook's clock, so a resume counts even when it is earlier than the hub's end time.
    now = T0 + 60_000;
    cli.roster = [{ id: '00000001', sessionId: '00000001-native', pid: 200, kind: 'interactive', status: 'busy' }];
    writeFileSync(join(dir, '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'UserPromptSubmit', at: T0 - 1 }));
    runtime.readMarkers();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('running'));
    expect(store.session('s1')?.state).toBe('running');
  });

  it('takes in the hook markers after worktree discovery, so a marker written during it is not overwritten', async () => {
    const cfg = config({ installHooks: true });
    cfg.settings.sources['github']!.setupPrompt = '/init-worktree {{ticket.sourceKey}}';
    cfg.playbooks = new Map([...PLAYBOOKS, playbook('dev:develop', { description: 'Build it', autoStart: true, requiresWorktree: true, template: 'Build.' })]);
    const { runtime, store, cli, source } = setup(cfg);
    cli.worktrees = 'worktree D:/git/widgets\nHEAD abc\nbranch refs/heads/master\n';
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const dir = join(home, '.switchboard', 'activity');
    const write = (event: string, at: number) => writeFileSync(join(dir, '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event, at, backgroundTasks: 0 }));

    mkdirSync(dir, { recursive: true });
    write('Stop', 1);
    const entered = deferred();
    const gate = deferred();
    cli.gitEntered = entered.resolve;
    cli.gitGate = gate.promise;
    const read = runtime.readRoster();
    await entered.promise;
    write('UserPromptSubmit', 2);
    runtime.readMarkers();
    expect(store.session('s1')?.state).toBe('running');

    gate.resolve();
    await read;
    await runtime.settled();
    expect(store.session('s1')).toMatchObject({ state: 'running', released: false, releasing: false, question: null });
    runtime.stop();
  });

  it('leaves a marker reading that needs the roster read to it, without changing the session', async () => {
    const real = new ClaudeRunner({ claudePath: 'claude', exec: async () => ({ code: 0, stdout: '[]', stderr: '', missing: false, timedOut: false }), sleep: async () => {}, now: () => T0, home, claudeSettings: join(home, '.claude', 'settings.json'), hooks: () => true });
    const roster = deferred();
    let reads = 0;
    const runner: SessionRunner = Object.assign(Object.create(real) as SessionRunner, {
      start: async () => ({ shortId: 'abc', nativeSessionId: 'native-1' }),
      markers: () => new Map([['native-1', { at: 1, observed: { state: 'idle' as const, detail: null }, recheck: true }]]),
      observe: async (sessions: Session[]) => {
        reads += 1;
        await roster.promise;
        return { sessions: sessions.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) };
      },
    });
    const { runtime, store } = setup(config(), () => T0, { claude: runner });

    runtime.send({ type: 'adhoc', prompt: 'test', repoRoot: 'D:/git/widgets' });
    await runtime.settled();
    runtime.readMarkers();
    await new Promise((done) => setImmediate(done));

    expect(reads).toBe(1);
    expect(store.session('s1')).toMatchObject({ state: 'running', released: false, releasing: false, question: null });

    roster.resolve();
    await runtime.readRoster();
    expect(store.session('s1')).toMatchObject({ state: 'running', released: false, releasing: false, question: null });
    runtime.stop();
  });

  it('reads the roster again when asked during a read, so an older result does not end a resumed session', async () => {
    const { store, cli, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const reads = () => cli.calls.filter((call) => call[1] === 'agents').length;
    const before = reads();
    const roster = cli.roster;
    cli.roster = [];
    const first = runtime.readRoster();
    cli.roster = roster;
    const second = runtime.readRoster();
    expect(second).toBe(first);
    await first;

    expect(reads()).toBe(before + 2);
    expect(store.session('s1')).toMatchObject({ state: 'running' });
  });

  it('keeps a session whose start is confirmed during a roster read that did not look for it', async () => {
    const { store, cli, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const gate = deferred();
    cli.rosterGate = gate.promise;
    const read = runtime.readRoster();

    source.result = { tickets: [issue('8'), issue('9')] };
    await runtime.pollSource('github');
    await runtime.settled();
    expect(store.session('s2')).toMatchObject({ state: 'running' });

    gate.resolve();
    await read;
    expect(store.session('s2')).toMatchObject({ state: 'running', released: false, releasing: false, question: null });
  });

  it('ignores markers when hooks are off', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    mkdirSync(join(home, '.switchboard', 'activity'), { recursive: true });
    writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'PermissionRequest' }));
    runtime.readMarkers();
    await runtime.readRoster();

    expect(store.session('s1')?.state).toBe('running');
  });

  it('links a setup worktree by branch name before the setup session ends', async () => {
    const cfg = config();
    cfg.settings.sources['github']!.setupPrompt = '/init-worktree {{ticket.sourceKey}}';
    cfg.playbooks = new Map([...PLAYBOOKS, playbook('dev:develop', { description: 'Build it', autoStart: true, requiresWorktree: true, template: 'Build.' })]);
    const { store, cli, source, runtime } = setup(cfg);
    cli.worktrees = 'worktree D:/git/widgets\nHEAD abc\nbranch refs/heads/master\n';
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    expect(store.session('s1')).toMatchObject({ kind: 'setup', state: 'running' });

    cli.worktrees += '\nworktree D:/git/widgets-wt/8-new\nHEAD def\nbranch refs/heads/8-new\n';
    cli.roster = [];
    await runtime.readRoster();
    await runtime.settled();

    expect(store.worktreeFor(1)).toMatchObject({ path: 'D:/git/widgets-wt/8-new', linkedBy: 'convention' });
    expect(store.session('s2')).toMatchObject({ kind: 'task', cwd: 'D:/git/widgets-wt/8-new', state: 'running' });
  });

  it('skips a failed roster read', async () => {
    const { store, cli, source, runtime, logs } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    cli.roster = 'not a list' as unknown as object[];
    await runtime.readRoster();

    expect(store.session('s1')?.state).toBe('running');
    expect(logs).toEqual(['claude roster read failed: claude agents returned an unexpected response.']);
  });

  it('records reports, validating a worktree with git', async () => {
    const { store, cli, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Planning' })).toEqual({ refused: null });
    expect(store.workItem(1)?.stage).toBe('Planning');

    expect(await runtime.report({ sessionId: 's1', kind: 'worktree', path: 'D:\\git\\widgets-wt\\7-fix\\' })).toEqual({ refused: null });
    expect(store.worktreeFor(1)).toMatchObject({ path: 'D:/git/widgets-wt/7-fix', branch: '7-fix', linkedBy: 'report' });
    expect(cli.calls.at(-1)).toEqual(['git', 'worktree', 'list', '--porcelain']);

    expect(await runtime.report({ sessionId: 's1', kind: 'worktree', path: 'D:/elsewhere' })).toEqual({ refused: 'D:/elsewhere is not a git worktree.' });
    // The flow never sees this report, so the hub logs the refusal itself (PRD R59).
    expect(store.ticketHistory(1)!.events.at(-1)).toMatchObject({ type: 'report', actor: 'session', sessionId: 's1', detail: { kind: 'worktree', path: 'D:/elsewhere' }, refused: 'D:/elsewhere is not a git worktree.' });
    // A request the hub rejects keeps only the report's kind and short fields, never its prompt.
    runtime.refuseReport('s1', { sessionId: 's1', kind: 'task', prompt: 'secret plan', title: 'Fix', repo: 7 }, 'Expected {…}.');
    expect(store.ticketHistory(1)!.events.at(-1)).toMatchObject({ type: 'report', sessionId: 's1', detail: { kind: 'task', title: 'Fix' }, refused: 'Expected {…}.' });
    expect(JSON.stringify(store.ticketHistory(1)!.events.at(-1))).not.toContain('secret plan');
    expect(await runtime.report({ sessionId: 's9', kind: 'done' })).toEqual({ refused: 'Unknown session s9.' });
    expect(await runtime.report({ sessionId: 's1', kind: 'approval', prompt: '/publish', summary: 'Ready.', report: 'D:/wt/review.md' })).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'awaiting-approval', approvalPrompt: '/publish', approvalSummary: 'Ready.', approvalReport: 'D:/wt/review.md' });
    source.result = { tickets: [] };
    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)?.status).toBe('done');

    source.result = { tickets: [issue('9')] };
    await runtime.pollSource('github');
    await runtime.settled();
    store.updateSession('s2', { reports: ['stage', 'link'] });
    expect(await runtime.report({ sessionId: 's2', kind: 'done' })).toEqual({ refused: "This session's report contract does not offer the done report." });
    expect(store.workItem(2)?.status).toBe('running');
  });

  it('records a paste only from a session offered it, and puts the pastes in the snapshot (R60)', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    store.updateSession('s1', { reports: ['stage', 'link'] });
    expect(await runtime.report({ sessionId: 's1', kind: 'paste', label: 'Customer reply', file: 'D:/case/draft-reply.md' })).toEqual({ refused: "This session's report contract does not offer the paste report." });
    expect(runtime.snapshot().workItems[0]?.pastes).toEqual([]);

    store.updateSession('s1', { reports: ['stage', 'link', 'paste'] });
    expect(await runtime.report({ sessionId: 's1', kind: 'paste', label: 'Customer reply', file: 'D:/case/draft-reply.md' })).toEqual({ refused: null });
    expect(runtime.snapshot().workItems[0]?.pastes).toMatchObject([{ workItemId: 1, label: 'Customer reply', file: 'D:/case/draft-reply.md' }]);
  });

  it('turns a task report into an unstarted ad-hoc row from its parent, which Start runs in the repo (PRD R68)', async () => {
    const { store, cli, source, runtime } = setup();
    source.result = { tickets: [issue('18941')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(await runtime.report({ sessionId: 's1', kind: 'task', prompt: 'Fix the flaky CartTests', repo: null, title: null })).toEqual({ refused: null });
    expect(await runtime.report({ sessionId: 's1', kind: 'task', prompt: 'x', repo: 'D:/git/support', title: null })).toEqual({ refused: 'D:/git/support is not a configured repo root. Repo roots: D:/git/widgets.' });

    const child = runtime.snapshot().workItems.find((item) => item.parentId === 1);
    expect(child).toMatchObject({ status: 'unstarted', playbook: null, ticket: { source: 'adhoc', title: 'Fix the flaky CartTests', repoRoot: 'D:/git/widgets' }, parent: { source: 'github', sourceKey: '18941' } });
    expect(runtime.snapshot().workItems.find((item) => item.id === 1)?.parent).toBeNull();

    runtime.send({ type: 'start', workItemId: child!.id });
    await runtime.settled();

    expect(store.sessionsFor(child!.id)).toMatchObject([{ cwd: 'D:/git/widgets', state: 'running' }]);
    const start = cli.calls.filter((call) => call[1] === '--bg').at(-1);
    expect(start?.at(-1)).toBe('Fix the flaky CartTests');
    expect(start?.at(-2)).toMatch(/^Report to Switchboard/);
  });

  it('blocks a done report while a fresh read lists the ticket as assigned, without telling the session (PRD R10)', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'The session reported done, but the ticket is still assigned to you.' });
    expect(store.session('s1')?.outcome).toBe('done');
  });

  it('finishes on a done report when a fresh read lists the ticket outside the assigned state', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    source.result = { tickets: [{ ...issue('8'), assigned: false }] };
    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'session' });
    expect(store.ticket(1)?.assigned).toBe(false);
  });

  it('accepts a done report when the source read fails', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    source.result = { error: 'GitHub is down.' };
    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)?.status).toBe('done');
    expect(runtime.snapshot().errors.sources).toEqual({ github: 'GitHub is down.' });
  });

  it('drops a read that finishes after its source is turned off', async () => {
    const { store, source, runtime } = setup();
    const slow = deferred();
    source.gate = slow.promise;
    source.result = { error: 'The forum database cannot be reached; check the VPN.' };
    const scheduled = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(1));

    expect(runtime.setSourceEnabled('github', false)).toBeNull();
    slow.resolve();
    await scheduled;
    await runtime.settled();

    expect(runtime.snapshot().errors.sources).toEqual({});

    // A slow read of tickets is dropped as well.
    expect(runtime.setSourceEnabled('github', true)).toBeNull();
    source.result = { tickets: [issue('8')] };
    const second = deferred();
    source.gate = second.promise;
    const again = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(2));
    expect(runtime.setSourceEnabled('github', false)).toBeNull();
    second.resolve();
    await again;
    await runtime.settled();

    expect(store.findTicket('github', '8')).toBeNull();
  });

  it('accepts a done report unchecked when the source read outlasts the check, and applies reads in order', async () => {
    const { store, source, runtime, logs, late } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const slow = deferred();
    source.gate = slow.promise;
    const scheduled = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(2));
    source.result = { tickets: [] };
    const report = runtime.report({ sessionId: 's1', kind: 'done' });
    late.resolve();

    expect(await report).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'session' });
    expect(logs).toContain('done report for #8 accepted unchecked: the github read took over 6 seconds');

    // The scheduled poll, read before the ticket left, applies before the done check's read, so the ticket ends unassigned.
    slow.resolve();
    await scheduled;
    await vi.waitFor(() => expect(store.ticket(1)?.assigned).toBe(false));
    await runtime.settled();
    expect(store.workItemsForTicket(1)).toHaveLength(1);
  });

  it('stops a session and reports a failed stop', async () => {
    const { store, cli, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    cli.stopResult = fail('No such agent');
    runtime.send({ type: 'stop', workItemId: 1 });
    await runtime.settled();
    expect(store.workItem(1)).toMatchObject({ status: 'running', error: 'Stop failed: No such agent' });

    cli.stopResult = ok('');
    runtime.send({ type: 'stop', workItemId: 1 });
    await runtime.settled();
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });
  });

  it('logs a failed stop of a deleted work item, which has no row to show it (PRD R76)', async () => {
    const { store, cli, source, runtime, logs } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    const [session] = store.sessionsFor(1);

    cli.stopResult = fail('No such agent');
    runtime.send({ type: 'delete', workItemId: 1 });
    await runtime.settled();

    expect(store.workItem(1)).toBeNull();
    expect(logs).toContain(`stop of deleted session ${session!.id} (${session!.shortId}) failed; it may still be running: No such agent`);
  });

  it('reconciles at startup and installs hooks when enabled', async () => {
    const { store, runtime } = setup(config({ installHooks: true }));
    store.insertTicket({ source: 'adhoc', sourceKey: '1', ref: '#1', sourceId: null, title: 'x', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: 'D:/x' });
    runtime.send({ type: 'adhoc', prompt: 'Do it', repoRoot: 'D:/scratch' });
    await runtime.settled();
    store.updateSession('s1', { state: 'starting', shortId: null });

    await runtime.startup();

    expect(store.session('s1')).toMatchObject({ state: 'ended', outcome: 'failed' });
    expect(store.workItem(1)).toMatchObject({ status: 'failed', error: 'The hub stopped while the session was starting.' });
    expect(Object.keys(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks)).toHaveLength(13);
    expect(runtime.snapshot().errors.hooks).toBeNull();
  });

  it("installs both agents' hooks at startup and shows each failure", async () => {
    const codex = new FakeCodex();
    const { runtime } = setup(config({ installHooks: true }), () => T0, undefined, codex);

    codex.trustError = 'no app-server';
    await runtime.startup();

    expect(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).toContain('codex-hook.mjs');
    expect(runtime.snapshot().errors.hooks).toBe("Codex did not trust Switchboard's hooks: no app-server");
  });

  it('runs a Codex session through the Codex runner: started, running, released when its turn ends, then ended', async () => {
    const codex = new FakeCodex();
    const cfg = config({ provider: 'codex' });
    const { store, runtime } = setup(cfg, () => T0, undefined, codex);

    runtime.send({ type: 'adhoc', prompt: '/gc-plan 1', repoRoot: 'D:/git/widgets' });
    await runtime.settled();

    expect(codex.spawned[0]!.slice(0, 2)).toEqual(['exec', '--json']);
    expect(codex.spawned[0]!.at(-1)).toBe('$gc-plan 1');
    expect(store.session('s1')).toMatchObject({ provider: 'codex', nativeSessionId: 'thread-1', shortId: 'thread-1', state: 'running' });

    await runtime.readRoster();
    expect(store.session('s1')).toMatchObject({ state: 'running', released: false, releasing: false, question: null });

    // The turn ends and its process exits; the next read delivers the end, the release lets the process go, and the session ends.
    writeFileSync(join(home, '.switchboard', 'codex', 's1.jsonl'), '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n{"type":"turn.completed"}\n');
    codex.alive.clear();
    await runtime.readRoster();
    await runtime.settled();
    expect(store.session('s1')).toMatchObject({ state: 'ended', released: true });
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'The turn ended without a done report.' });
    expect(codex.kills).toEqual([]);
  });

  it('asks again at each roster read about a Codex start it could not settle at startup', async () => {
    const codex = new FakeCodex();
    const { store, runtime, logs } = setup(config({ provider: 'codex' }), () => T0, undefined, codex);

    runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets' });
    await runtime.settled();

    // As a hub that stopped before the thread appeared would leave it.
    const recordFile = join(home, '.switchboard', 'codex', 's1.json');
    writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(readFileSync(recordFile, 'utf8')), threadId: null }));
    writeFileSync(join(home, '.switchboard', 'codex', 's1.jsonl'), '');
    store.updateSession('s1', { state: 'starting', shortId: null, nativeSessionId: null });
    codex.queryError = 'WMI is down';

    await runtime.startup();
    expect(store.session('s1')).toMatchObject({ state: 'starting' });
    expect(logs).toContain('session s1 left starting by the hub that stopped is not settled yet: The Codex process query failed: WMI is down');

    codex.queryError = null;
    writeFileSync(join(home, '.switchboard', 'codex', 's1.jsonl'), '{"type":"thread.started","thread_id":"thread-1"}\n');
    await runtime.readRoster();
    expect(store.session('s1')).toMatchObject({ state: 'running', nativeSessionId: 'thread-1' });
  });

  it("keeps one agent's sessions as they were when its read fails, while the other agent's read applies", async () => {
    const codex = new FakeCodex();
    const { store, cli, source, runtime, logs } = setup(config(), () => T0, undefined, codex);

    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    runtime.reload({ ...config({ provider: 'codex' }), playbooks: PLAYBOOKS });
    runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets' });
    await runtime.settled();
    expect(store.session('s2')).toMatchObject({ provider: 'codex', state: 'running' });

    cli.roster = 'not a list' as unknown as object[];
    codex.alive.clear();
    await runtime.readRoster();

    expect(store.session('s1')).toMatchObject({ provider: 'claude', state: 'running' });
    expect(store.session('s2')).toMatchObject({ state: 'ended' });
    expect(logs).toContain('claude roster read failed: claude agents returned an unexpected response.');
  });

  it('counts Claude and Codex sessions against one concurrency limit (PRD R38)', async () => {
    const codex = new FakeCodex();
    const { store, source, runtime } = setup(config({ concurrency: 1 }), () => T0, undefined, codex);

    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    runtime.reload({ ...config({ concurrency: 1, provider: 'codex' }), playbooks: PLAYBOOKS });
    runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets' });
    await runtime.settled();

    expect(store.workItem(2)).toMatchObject({ status: 'queued' });
    expect(codex.spawned).toHaveLength(0);
  });

  it("offers Open in Codex once the turn that reported a question ends, and stops the session for it (PRD R70)", async () => {
    const codex = new FakeCodex();
    const { store, runtime } = setup(config({ provider: 'codex' }), () => T0, undefined, codex);
    const log = join(home, '.switchboard', 'codex', 's1.jsonl');
    const opens = () => controlsOf(runtime.snapshot().workItems[0]!).filter((control) => control.message['type'] === 'open-question');

    runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets' });
    await runtime.settled();
    expect(await runtime.report({ sessionId: 's1', kind: 'question', text: 'Which tree?' })).toEqual({ refused: null });
    expect(store.session('s1')!.question).toEqual({ id: 's2', text: 'Which tree?' });

    // Running: the question waits for the turn to end.
    await runtime.readRoster();
    expect(opens()).toEqual([]);

    writeFileSync(log, '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n{"type":"turn.completed"}\n');
    codex.alive.clear();
    await runtime.readRoster();
    await runtime.settled();
    expect(store.session('s1')).toMatchObject({ state: 'waiting', released: false });
    expect(opens().map((control) => control.label)).toEqual(['Open in Codex']);

    expect(runtime.send({ type: 'open-question', workItemId: 1, nativeSessionId: 'thread-1' }).refused).toBeNull();
    await runtime.settled();
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Opened in Codex to answer.' });
    expect(store.session('s1')).toMatchObject({ state: 'ended', question: null });
  });

  describe('Codex question races and recovery (PRD R70)', () => {
    const START = '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n';
    const DONE = START + '{"type":"turn.completed"}\n';
    const log = () => join(home, '.switchboard', 'codex', 's1.jsonl');

    it('keeps a question reported while a roster read ran, and decides it at the next read', async () => {
      const codex = new FakeCodex();
      const { store, runtime } = setup(config({ provider: 'codex' }), () => T0, undefined, codex);

      runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets' });
      await runtime.settled();

      const entered = deferred();
      const gate = deferred();

      codex.queryEntered = entered.resolve;
      codex.queryGate = gate.promise;
      const read = runtime.readRoster();

      await entered.promise;
      codex.queryEntered = null;
      await runtime.report({ sessionId: 's1', kind: 'question', text: 'Which tree?' });
      writeFileSync(log(), DONE);
      codex.alive.clear();
      gate.resolve();
      await read;
      await runtime.settled();

      expect(store.session('s1')).toMatchObject({ state: 'waiting', released: false });
      expect(store.session('s1')!.question).toMatchObject({ text: 'Which tree?' });
    });

    it('keeps an approval through a question, and holds no slot while it waits (PRD R34, R38)', async () => {
      const codex = new FakeCodex();
      const cfg = config({ provider: 'codex', concurrency: 1 });
      const { store, runtime } = setup(cfg, () => T0, undefined, codex);

      runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets' });
      await runtime.settled();
      await runtime.report({ sessionId: 's1', kind: 'approval', prompt: '/legacy-ship 1', summary: 'Ship it', report: null });
      await runtime.report({ sessionId: 's1', kind: 'question', text: 'Ship now?' });
      writeFileSync(log(), DONE);
      codex.alive.clear();
      await runtime.readRoster();
      await runtime.settled();

      expect(store.workItem(1)).toMatchObject({ status: 'awaiting-approval', approvalPrompt: '/legacy-ship 1' });
      expect(store.session('s1')).toMatchObject({ state: 'waiting' });

      runtime.send({ type: 'adhoc', prompt: 'Other work', repoRoot: 'D:/git/widgets' });
      await runtime.settled();
      expect(store.workItem(2)).toMatchObject({ status: 'running' });
    });
  });

  it('stops a running Codex session for the operator by ending its process', async () => {
    const codex = new FakeCodex();
    const { store, runtime } = setup(config({ provider: 'codex' }), () => T0, undefined, codex);

    runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets' });
    await runtime.settled();
    await runtime.readRoster();

    expect(runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
    await runtime.settled();
    expect(codex.kills).toEqual([500]);
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });
  });

  it('shows a failed hook install instead of failing startup', async () => {
    const { runtime } = setup(config({ installHooks: true }));
    mkdirSync(join(home, '.claude', 'settings.json'), { recursive: true });

    await runtime.startup();

    expect(runtime.snapshot().errors.hooks).toMatch(/^Switchboard could not add its hooks to .*settings\.json: EISDIR/);
  });

  it('builds the panel snapshot', async () => {
    const { source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const snapshot = runtime.snapshot();

    expect(snapshot.workItems).toHaveLength(1);
    expect(snapshot.workItems[0]).toMatchObject({ id: 1, status: 'running', ticket: { sourceKey: '8' }, triage: { playbook: 'dev:develop' }, sessions: [{ id: 's1' }] });
    expect(snapshot.playbooks).toEqual([{ name: 'dev:develop', description: 'Build it' }]);
    expect(snapshot.repoRoots).toEqual(['D:/git/widgets']);
    expect(runtime.reportCommand).toBe(`node "${join(home, '.switchboard').replaceAll('\\', '/')}/hub.js" report`);
  });

  it('triages the pool, lists it oldest first, and starts the triaged playbook on a pick with fake runners', async () => {
    const { store, cli, source, runtime } = setup(config());
    source.result = { tickets: [{ ...issue('9'), assigned: false, pool: true, sortAt: 20, enteredAt: null }, { ...issue('8'), assigned: false, pool: true, sortAt: 10, enteredAt: null }] };
    source.context = async (ticket) => ({ context: `Issue ${ticket.sourceKey} text`, links: ticket.sourceKey === '9' ? [{ label: 'Issue #90', target: 'https://github.com/o/r/issues/90' }] : [] });

    await runtime.pollSource('github');
    await runtime.settled();

    const pool = runtime.snapshot().pool;
    expect(pool.map((entry) => [entry.ticket.sourceKey, entry.triage?.playbook])).toEqual([['8', 'dev:develop'], ['9', 'dev:develop']]);
    // A pool ticket shows the links its triage found before any session runs (PRD R61).
    expect(pool.map((entry) => entry.links.map((link) => link.target))).toEqual([[], ['https://github.com/o/r/issues/90']]);
    expect(runtime.snapshot().workItems).toEqual([]);

    expect(runtime.send({ type: 'pick', ticketId: pool[0]!.ticket.id }).refused).toBeNull();
    await runtime.settled();

    const start = cli.calls.find((call) => call[1] === '--bg');
    expect(start?.slice(-3)).toEqual(['--append-system-prompt', expect.stringMatching(/^Report to Switchboard with these commands:\n- .* stage s1 /), 'Build 8.']);
    expect(store.session('s1')).toMatchObject({ kind: 'task', state: 'running' });
    // After a compaction, the hook gets the contract the session started with (mechanics M30).
    expect(runtime.contract(store.session('s1')!.nativeSessionId!)).toBe(start?.at(-2));
    expect(runtime.contract('not-a-switchboard-session')).toBeNull();
    expect(runtime.snapshot().pool.map((entry) => entry.ticket.sourceKey)).toEqual(['9']);
    expect(runtime.snapshot().workItems).toMatchObject([{ status: 'running', playbook: 'dev:develop', triage: { playbook: 'dev:develop' } }]);
  });

  it('lists the pool oldest first with each rating, counts the started done work items of a returned ticket with the same playbook or one it is a return of, and hides a disabled source (PRD R50, R51)', async () => {
    const cfg = config();
    cfg.playbooks = new Map([...PLAYBOOKS, playbook('triage:github', { description: 'Triage', kind: 'triage', rates: true, template: 'Classify and rate.' })]);
    const { store, cli, source, runtime } = setup(cfg);
    const rated = (immediacy: string, severity: string) => ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:develop', immediacy, severity } }));
    cli.classifyByContext.set(triageText('Issue 2 text', T0), rated('NON-BLOCKING', 'LOW'));
    cli.classifyByContext.set(triageText('Issue 3 text', T0), rated('BLOCKING', 'HIGH'));
    cli.classifyByContext.set(triageText('Issue 4 text', T0), rated('URGENT', 'MED'));
    const pooled = (key: string, sortAt: number) => ({ ...issue(key), assigned: false, pool: true, sortAt, enteredAt: null });
    source.result = { tickets: [pooled('1', 10), pooled('2', 20), pooled('3', 30), pooled('4', 25), pooled('5', 5)] };

    await runtime.pollSource('github');
    await runtime.settled();

    // The panel orders by importance; the snapshot keeps the source's sort time.
    expect(runtime.snapshot().pool.map((entry) => [entry.ticket.sourceKey, entry.triage?.immediacy ?? null, entry.triage?.severity ?? null])).toEqual([
      ['5', null, null],
      ['1', null, null],
      ['2', 'NON-BLOCKING', 'LOW'],
      ['4', 'URGENT', 'MED'],
      ['3', 'BLOCKING', 'HIGH'],
    ]);

    // Of four done work items, only the started one with the triaged playbook counts: one never ran a session, one's launch failed, one ran another playbook.
    const ticket = store.findTicket('github', '1')!;
    const done = { ticketId: ticket.id, playbook: 'dev:develop', status: 'done', stage: null, stageAt: null, taskPrompt: null, warning: null, error: null, unassignedAt: null, queuedAt: null, approvalPrompt: null, approvalSummary: null, approvalReport: null, approvalHeld: false, createdAt: T0, statusAt: T0, runStartedAt: null, readyAt: null, orderAt: null, scopeAt: null, doneAt: T0, doneReason: 'operator', parentId: null } as const;
    const ran = store.insertWorkItem(done);
    store.insertWorkItem(done);
    const refused = store.insertWorkItem(done);
    const review = store.insertWorkItem({ ...done, playbook: 'dev:review' });
    const session = { kind: 'task', provider: 'claude', nativeSessionId: null, cwd: 'C:/repo', state: 'ended', stateAt: T0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: T0, endedAt: T0, released: false, releasing: false, question: null } as const;
    store.insertSession({ ...session, id: 'ran', workItemId: ran.id, shortId: 'abc123', reports: [] });
    store.insertSession({ ...session, id: 'refused', workItemId: refused.id, shortId: null, reports: [] });
    store.insertSession({ ...session, id: 'review', workItemId: review.id, shortId: 'def456', reports: [] });

    expect(runtime.snapshot().pool.map((entry) => [entry.ticket.sourceKey, entry.returned])).toEqual([['5', 0], ['1', 1], ['2', 0], ['4', 0], ['3', 0]]);

    // With dev:develop a return of dev:review, the started dev:review work item counts as well.
    const returning = config();
    returning.playbooks = new Map([...cfg.playbooks, playbook('dev:develop', { description: 'Build it', returnOf: ['dev:review'], template: 'Build.' })]);
    runtime.reload(returning);

    expect(runtime.snapshot().pool.find((entry) => entry.ticket.sourceKey === '1')?.returned).toBe(2);

    // A disabled source's pool is not read, so it is hidden; the filter lists it as off.
    const off = config();
    off.settings.sources['github']!.namespace = 'dev';
    runtime.reload(off);

    expect(runtime.setSourceEnabled('github', false)).toBeNull();
    expect(store.enabledSources()).toEqual(new Set());
    expect(runtime.snapshot().pool).toEqual([]);
    expect(runtime.snapshot().sourceStates).toEqual([{ name: 'github', enabled: false }]);
    expect(runtime.snapshot().namespaces).toEqual({ github: 'dev' });
    expect(runtime.setSourceEnabled('zoho', true)).toBe('settings.json has no source named zoho.');
    expect(runtime.setSourceEnabled('adhoc', true)).toBe('settings.json has no source named adhoc.');
    expect(store.enabledSources()).toEqual(new Set());
  });

  it('gives each work item its current playbook\'s approvalSends (PRD R27)', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(runtime.snapshot().workItems.map((item) => [item.playbook, item.approvalSends])).toEqual([['dev:develop', false]]);

    const sends = config();
    sends.playbooks = new Map([...PLAYBOOKS, playbook('dev:develop', { description: 'Build it', reports: ['approval'], approvalSends: true, template: 'Build.' })]);
    runtime.reload(sends);
    expect(runtime.snapshot().workItems.map((item) => item.approvalSends)).toEqual([true]);

    // A work item with no playbook, or one whose playbook is gone, has no approval that sends.
    store.updateWorkItem(1, { playbook: 'dev:gone' });
    expect(runtime.snapshot().workItems.map((item) => item.approvalSends)).toEqual([false]);
  });

  it('lists the queue waits of a queued work item only (PRD R34)', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    // The task started, so its live session keeps the work item from starting again once it is queued.
    expect(runtime.snapshot().workItems.map((item) => [item.status, item.waits])).toEqual([['running', []]]);

    store.updateWorkItem(1, { status: 'queued', queuedAt: T0 });
    expect(runtime.snapshot().workItems[0]!.waits).toMatchObject([{ kind: 'session', sessionId: 's1', ownItem: true, playbook: null }]);
  });

  it("refuses a link report its ticket's source refuses, and logs the refusal in History (PRD R52)", async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    const checked: [string, string][] = [];
    source.checkLink = async (ticket, target) => {
      checked.push([ticket.sourceKey, target]);
      return { refused: target.endsWith('/13') ? 'Pull request #13 does not close #8.' : null };
    };

    expect(await runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #13', target: 'https://github.com/o/r/pull/13' })).toEqual({ refused: 'Pull request #13 does not close #8.' });
    expect(await runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #12', target: 'https://github.com/o/r/pull/12' })).toEqual({ refused: null });
    expect(checked).toEqual([['8', 'https://github.com/o/r/pull/13'], ['8', 'https://github.com/o/r/pull/12']]);
    expect(store.linksFor(1).map((link) => link.target)).toEqual(['https://github.com/o/r/pull/12']);
    expect(store.ticketHistory(1)!.events.find((event) => event.refused !== null && event.type === 'report')).toMatchObject({ sessionId: 's1', detail: { kind: 'link', label: 'PR #13', target: 'https://github.com/o/r/pull/13' }, refused: 'Pull request #13 does not close #8.' });
  });

  it('accepts a link report unchecked when the check fails, throws or outlasts REPORT_CHECK_MS', async () => {
    const { store, source, runtime, logs, late } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    source.checkLink = async () => ({ error: 'GitHub is down.' });
    expect(await runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #12', target: 'https://github.com/o/r/pull/12' })).toEqual({ refused: null });
    source.checkLink = async () => {
      throw new Error('boom');
    };
    expect(await runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #13', target: 'https://github.com/o/r/pull/13' })).toEqual({ refused: null });
    source.checkLink = () => new Promise(() => {});
    const report = runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #14', target: 'https://github.com/o/r/pull/14' });
    late.resolve();

    expect(await report).toEqual({ refused: null });
    expect(store.linksFor(1).map((link) => link.label)).toEqual(['PR #12', 'PR #13', 'PR #14']);
    expect(logs).toEqual(
      expect.arrayContaining([
        'link report for #8 accepted unchecked: GitHub is down.',
        'link report for #8 accepted unchecked: the check failed',
        'link report for #8 accepted unchecked: the github check took over 6 seconds',
      ]),
    );
  });

  it('records a link report and lists the ticket links and earlier work items, with those of playbooks it is a return of, on the work item (PRD R51, R52)', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(await runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #12', target: 'https://github.com/o/r/pull/12' })).toEqual({ refused: null });
    expect(await runtime.report({ sessionId: 'nope', kind: 'link', label: 'x', target: 'https://x' })).toEqual({ refused: 'Unknown session nope.' });
    expect(runtime.snapshot().workItems[0]).toMatchObject({ returned: 0, links: [{ label: 'PR #12', target: 'https://github.com/o/r/pull/12' }] });

    // The started earlier work item is counted after it leaves the Done list; work item 2 started no session, so it is not.
    // Work item 4 has another playbook, so the earlier started work item does not count for it.
    const { id: _id, ...first } = store.workItem(1)!;
    store.updateWorkItem(1, { status: 'done', doneAt: T0 - 30 * 86_400_000, doneReason: 'operator' });
    store.insertWorkItem({ ...first, status: 'triaging', createdAt: T0 });
    store.insertWorkItem({ ...first, status: 'triaging', createdAt: T0 });
    store.insertWorkItem({ ...first, playbook: 'dev:review', status: 'triaging', createdAt: T0 });

    expect(runtime.snapshot().workItems.map((item) => [item.id, item.playbook, item.returned, item.links.length])).toEqual([
      [4, 'dev:review', 0, 1],
      [3, 'dev:develop', 1, 1],
      [2, 'dev:develop', 1, 1],
    ]);

    // A playbook that is a return of dev:develop counts its started work items too.
    const cfg = config();
    cfg.playbooks = new Map([...PLAYBOOKS, playbook('dev:review', { description: 'Review it', returnOf: ['dev:develop'], template: 'Review.' })]);
    runtime.reload(cfg);

    expect(runtime.snapshot().workItems.map((item) => [item.id, item.returned])).toEqual([[4, 1], [3, 1], [2, 1]]);

    // Counting runs one way: a later dev:develop work item does not count the started dev:review one.
    store.insertSession({ id: 'review', workItemId: 4, shortId: 'def456', kind: 'task', provider: 'claude', nativeSessionId: null, cwd: 'C:/repo', state: 'ended', stateAt: T0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: T0, endedAt: T0, released: false, releasing: false, question: null, reports: [] });
    const later = store.insertWorkItem({ ...first, status: 'triaging', createdAt: T0 });

    expect(runtime.snapshot().workItems.find((item) => item.id === later.id)?.returned).toBe(1);
  });

  it('turns off a source that was removed from settings.json, so adding it again starts it off, and keeps it while the file is invalid', () => {
    const { store, runtime } = setup();
    const removed = config();
    removed.settings.sources = {};

    runtime.reload({ ...removed, settingsError: 'sessions.concurrency must be a whole number from 1 to 10.' });
    expect(store.enabledSources()).toEqual(new Set(['github']));

    runtime.reload(removed);
    expect(store.enabledSources()).toEqual(new Set());

    runtime.reload(config());
    expect(runtime.snapshot().sourceStates).toEqual([{ name: 'github', enabled: false }]);
  });

  it('reports an unknown or misconfigured source', () => {
    const cfg = config();
    cfg.settings.sources['zoho'] = { ...cfg.settings.sources['github']! };
    const { runtime } = setup(cfg);

    expect(runtime.snapshot().errors.sources).toEqual({ zoho: 'Switchboard has no source named zoho.' });
  });
});

describe('Open in Claude (PRD R70)', () => {
  /** A running dev:develop session s1 (short ID 00000001) for ticket 8. */
  async function started() {
    const context = setup(config(), () => T0);
    context.source.result = { tickets: [issue('8')] };
    await context.runtime.pollSource('github');
    await context.runtime.settled();

    return context;
  }

  it('stops the session for Open in Claude without the release check, and blocks the work item', async () => {
    const { store, cli, runtime } = await started();
    runtime.send({ type: 'marker', sessionId: 's1', state: 'waiting', detail: null });
    const roster = cli.calls.filter((call) => call[1] === 'agents').length;

    runtime.send({ type: 'open-question', workItemId: 1, nativeSessionId: '00000001-native' });
    await runtime.settled();

    expect(cli.calls.filter((call) => call[1] === 'stop')).toEqual([['claude', 'stop', '00000001']]);
    expect(cli.calls.filter((call) => call[1] === 'agents')).toHaveLength(roster);
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Opened in Claude to answer.' });
    expect(store.session('s1')).toMatchObject({ state: 'ended', released: true });
  });
});
