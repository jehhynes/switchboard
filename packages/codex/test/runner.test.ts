import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, StartAction } from '@switchboard/core';
import { CODEX_HOOK_SOURCE } from '../src/hooks.js';
import type { ProcessIdentity, ProcessInfo } from '../src/processes.js';
import { readRecord, runFiles, writeRecord } from '../src/records.js';
import type { RunRecord } from '../src/records.js';
import { CodexRunner, EXIT_WAIT_MS, START_TIMEOUT_MS } from '../src/runner.js';

const THREAD = '01a128b1-5384-7b62-a7be-64a4b4c611a9';
const STARTED = `{"type":"thread.started","thread_id":"${THREAD}"}\n`;
const TURN = '{"type":"turn.started"}\n';
const DONE = '{"type":"turn.completed","usage":{}}\n';

let home: string;
let codexHome: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchboard-codex-runner-'));
  codexHome = join(home, '.codex');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const ACTION: StartAction = {
  type: 'start-session',
  sessionId: 's1',
  workItemId: 1,
  kind: 'task',
  provider: 'codex',
  cwd: 'D:/git/widgets',
  prompt: '/sb-plan 1',
  contract: 'Report to Switchboard with these commands:',
  name: 'switchboard · dev:develop · github 1',
  permissionMode: 'bypassPermissions',
  model: null,
};

/** A fake process table, spawner and clock. Each spawn runs `onSpawn` with the run's files. */
class Fake {
  now = 0;
  nextPid = 100;
  alive = new Set<number>();
  created = new Map<number, string>();
  spawns: { args: string[]; stdout: string; stderr: string; cwd: string; env?: Record<string, string> }[] = [];
  kills: number[] = [];
  /** Each spawned process's command line; another process that takes a PID has another. */
  commandLines = new Map<number, string>();
  tags = new Map<string, ProcessIdentity>();
  /** Process names other than codex.exe, such as npm's launcher on Linux. */
  names = new Map<number, string>();
  queries = 0;
  queryError: string | null = null;
  /** Fails this many process queries before answering. */
  queryFailures = 0;
  /** Answers this many tag searches with no process first. */
  tagMisses = 0;
  /** Holds the next tag search until released. */
  tagGate: Promise<void> | null = null;
  killError: string | null = null;
  tagError: string | null = null;
  spawnError: string | null = null;
  spawnMissing = false;
  codexPath = 'codex';
  spawnedFiles: string[] = [];
  trusted: ReadonlySet<string>[] = [];
  trustResult: string | null = null;
  onSpawn: (files: { stdout: string; stderr: string }, pid: number) => void = (files) => writeFileSync(files.stdout, STARTED + TURN);

  runner(): CodexRunner {
    return new CodexRunner({
      codexPath: () => this.codexPath,
      exec: async () => {
        throw new Error('unexpected exec');
      },
      sleep: async (ms) => {
        this.now += ms;
      },
      now: () => this.now,
      home,
      codexHome,
      env: { CODEX_HOME: codexHome },
      hooks: () => true,
      spawn: async (file, args, options) => {
        this.spawnedFiles.push(file);

        if (this.spawnError !== null) {
          return { pid: null, error: this.spawnError, missing: this.spawnMissing };
        }

        const pid = this.nextPid++;

        this.spawns.push({ args, ...options });
        this.commandLines.set(pid, ['codex.exe', ...args].join(' '));
        writeFileSync(options.stdout, '');
        writeFileSync(options.stderr, '');
        this.alive.add(pid);
        this.created.set(pid, `c${pid}`);
        this.onSpawn(options, pid);
        return { pid, error: null };
      },
      processes: async (pids) => {
        this.queries += 1;

        if (this.queryError !== null) {
          return { error: this.queryError };
        }

        if (this.queryFailures > 0) {
          this.queryFailures -= 1;
          return { error: 'WMI busy' };
        }

        return new Map(pids.filter((pid) => this.alive.has(pid)).map((pid): [number, ProcessInfo] => [pid, { pid, created: this.created.get(pid)!, name: this.names.get(pid) ?? 'codex.exe', commandLine: this.commandLines.get(pid) ?? '' }]));
      },
      tagged: async (tag) => {
        const gate = this.tagGate;

        this.tagGate = null;
        await gate;

        if (this.tagMisses > 0) {
          this.tagMisses -= 1;
          return null;
        }

        return this.tagError === null ? (this.tags.get(tag) ?? null) : { error: this.tagError };
      },
      alive: (pid) => this.alive.has(pid),
      kill: async (pid) => {
        if (this.killError !== null) {
          return { error: this.killError };
        }

        this.kills.push(pid);
        this.alive.delete(pid);
        return null;
      },
      trust: async (commands) => {
        this.trusted.push(commands);
        return this.trustResult;
      },
    });
  }
}

const session = (patch: Partial<Session> = {}): Session => ({
  id: 's1',
  workItemId: 1,
  kind: 'task',
  provider: 'codex',
  nativeSessionId: THREAD,
  shortId: THREAD,
  cwd: 'D:/git/widgets',
  state: 'running',
  stateAt: 0,
  stateDetail: null,
  outcome: null,
  outcomeDetail: null,
  startedAt: 0,
  endedAt: null,
  released: false, releasing: false, question: null, retiredIds: [], pendingFork: null, external: false,
  reports: ['stage'],
  ...patch,
});

const append = (record: RunRecord, text: string) => writeFileSync(runFiles(home, record.sessionId).stdout, readFileSync(runFiles(home, record.sessionId).stdout, 'utf8') + text);

async function started(fake: Fake): Promise<{ runner: CodexRunner; record: RunRecord }> {
  const runner = fake.runner();

  expect(await runner.start(ACTION)).toEqual({ shortId: THREAD, nativeSessionId: THREAD });

  return { runner, record: readRecord(home, 's1')! };
}

function marker(patch: Record<string, unknown>): void {
  mkdirSync(join(home, 'activity'), { recursive: true });
  writeFileSync(join(home, 'activity', `${THREAD}.json`), JSON.stringify({ v: 1, provider: 'codex', sessionId: THREAD, event: 'UserPromptSubmit', at: 50, source: null, toolName: null, turnId: 'u1', transcriptPath: null, pid: 900, created: 'c900', ...patch }));
}

describe('start', () => {
  it('starts detached with the tag, mode and contract, and records the thread and the process', async () => {
    const fake = new Fake();
    const { record } = await started(fake);

    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]!.args).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'developer_instructions="Report to Switchboard with these commands:"',
      '-c',
      'switchboard_run="s1"',
      '-C',
      'D:/git/widgets',
      '--',
      '$sb-plan 1',
    ]);
    expect(fake.spawns[0]!).toMatchObject({ cwd: 'D:/git/widgets', env: { CODEX_HOME: codexHome } });
    expect(fake.spawns[0]!.env).toEqual({ CODEX_HOME: codexHome });
    expect(record).toMatchObject({ threadId: THREAD, process: { pid: 100, created: 'c100' }, mode: 'bypassPermissions', contract: ACTION.contract });
  });

  it("refuses a mode a background run cannot finish in, and fails with Codex's refusal or a spawn error", async () => {
    const fake = new Fake();

    expect(await fake.runner().start({ ...ACTION, permissionMode: 'acceptEdits' })).toEqual({ error: 'Codex runs sessions only in auto, plan, dontAsk or bypassPermissions, not acceptEdits.' });

    fake.onSpawn = (files, pid) => {
      writeFileSync(files.stderr, 'Reading additional input from stdin...\nNot inside a trusted directory and --skip-git-repo-check was not specified.\n');
      fake.alive.delete(pid);
    };
    expect(await fake.runner().start(ACTION)).toEqual({ error: 'Not inside a trusted directory and --skip-git-repo-check was not specified.' });

    fake.onSpawn = (_files, pid) => fake.alive.delete(pid);
    expect(await fake.runner().start(ACTION)).toEqual({ error: 'Codex exited before it started the session.' });

    fake.spawnError = 'spawn codex ENOENT';
    expect(await fake.runner().start(ACTION)).toEqual({ error: 'spawn codex ENOENT' });
  });

  it('spawns the Codex CLI the setting names at each start, and says when it is not found', async () => {
    const fake = new Fake();
    const runner = fake.runner();

    fake.codexPath = '/opt/codex/bin/codex';
    fake.spawnError = 'spawn /opt/codex/bin/codex ENOENT';
    fake.spawnMissing = true;
    expect(await runner.start(ACTION)).toEqual({ error: 'Codex was not found at /opt/codex/bin/codex. Install it or set sessions.codex.path.' });

    fake.codexPath = '/usr/local/bin/codex';
    fake.spawnError = null;
    expect(await runner.start(ACTION)).toMatchObject({ shortId: THREAD });
    expect(fake.spawnedFiles).toEqual(['/opt/codex/bin/codex', '/usr/local/bin/codex']);
    // npm's launcher runs the node an nvm install keeps beside it.
    const env = fake.spawns[0]!.env!;
    expect(env[Object.keys(env).find((name) => name.toUpperCase() === 'PATH')!]!.split(delimiter)[0]).toBe(dirname('/usr/local/bin/codex'));
  });

  it('never adopts a process that took the PID before its creation time was read, so a timeout ends nothing', async () => {
    const fake = new Fake();

    fake.onSpawn = (_files, pid) => {
      // The run exits at once and another program takes its PID.
      fake.commandLines.set(pid, 'C:/Windows/notepad.exe');
    };
    expect(await fake.runner().start(ACTION)).toEqual({ error: `Codex did not start the session within ${START_TIMEOUT_MS / 1000} seconds, and it may still be running: its process could not be identified.` });
    expect(readRecord(home, 's1')!.process).toBeNull();
    expect(fake.kills).toEqual([]);
  });

  it('ends a start that prints no thread in time', async () => {
    const fake = new Fake();

    fake.onSpawn = () => {};
    expect(await fake.runner().start(ACTION)).toEqual({ error: `Codex did not start the session within ${START_TIMEOUT_MS / 1000} seconds.` });
    expect(fake.kills).toEqual([100]);
  });

  it("ends a launcher's Codex child that started only after the spawn's checks, when the start times out", async () => {
    const fake = new Fake();

    fake.onSpawn = (_files, pid) => fake.names.set(pid, 'MainThread');
    fake.tagMisses = 3;
    fake.tags.set('s1', { pid: 150, created: 'c150' });
    fake.alive.add(150);
    fake.created.set(150, 'c150');
    expect(await fake.runner().start(ACTION)).toEqual({ error: `Codex did not start the session within ${START_TIMEOUT_MS / 1000} seconds.` });
    expect(readRecord(home, 's1')!.process).toEqual({ pid: 150, created: 'c150' });
    expect(fake.kills).toEqual([150]);
  });
});

describe('observe', () => {
  it('follows the run: running, then the turn end while it exits, then the end delivered after it exited, then gone once released', async () => {
    const fake = new Fake();
    const { runner, record } = await started(fake);

    expect(await runner.observe([session()])).toMatchObject({ sessions: [{ sessionId: 's1', state: 'running', detail: null, interactive: false }] });

    append(record, DONE);
    expect(await runner.observe([session()])).toMatchObject({ sessions: [{ sessionId: 's1', state: 'idle', detail: null, interactive: false }] });

    fake.alive.delete(100);
    expect(await runner.observe([session()])).toMatchObject({ sessions: [{ sessionId: 's1', state: 'idle', detail: null, interactive: false }] });
    expect(await runner.observe([session({ released: true })])).toMatchObject({ sessions: [] });
  });

  it('ends a run that died without a turn end, and one whose PID another process now has', async () => {
    const fake = new Fake();
    const { runner } = await started(fake);

    fake.created.set(100, 'reused');
    expect(await runner.observe([session()])).toMatchObject({ sessions: [] });

    fake.alive.delete(100);
    expect(await runner.observe([session()])).toMatchObject({ sessions: [] });
  });

  it('ends a session whose record has another format, such as one written before a session had one run', async () => {
    const fake = new Fake();
    const { runner, record } = await started(fake);

    writeFileSync(join(home, 'codex', 's1.json'), JSON.stringify({ ...record, v: 1, attempt: 2 }));
    expect(readRecord(home, 's1')).toBeNull();
    expect(await runner.observe([session()])).toMatchObject({ sessions: [] });
  });

  it('gives a failed turn with its message', async () => {
    const fake = new Fake();
    const { runner, record } = await started(fake);

    append(record, '{"type":"turn.failed","error":{"message":"stream disconnected"}}\n');
    fake.alive.delete(100);
    expect(await runner.observe([session()])).toMatchObject({ sessions: [{ sessionId: 's1', state: 'failed', detail: 'stream disconnected', interactive: false }] });
  });

  it("takes a live process that resumed the thread since the run began as the operator's", async () => {
    const fake = new Fake();
    const { runner, record } = await started(fake);

    append(record, DONE);
    fake.alive.delete(100);
    fake.alive.add(900);
    fake.created.set(900, 'c900');
    marker({ event: 'UserPromptSubmit' });
    expect(await runner.observe([session({ released: true })])).toMatchObject({ sessions: [{ sessionId: 's1', state: 'running', detail: null, interactive: true }] });

    // The panel's process stays; a reused PID does not.
    fake.created.set(900, 'other');
    expect(await runner.observe([session({ released: true })])).toMatchObject({ sessions: [] });
  });

  it('finds a run the record holds no process for by its tag, and fails the read when the query fails', async () => {
    const fake = new Fake();
    const { runner } = await started(fake);
    const record = readRecord(home, 's1')!;

    writeRecord(home, { ...record, process: null });
    fake.tags.set('s1', { pid: 100, created: 'c100' });
    expect(await runner.observe([session()])).toMatchObject({ sessions: [{ sessionId: 's1', state: 'running', detail: null, interactive: false }] });
    expect(readRecord(home, 's1')!.process).toEqual({ pid: 100, created: 'c100' });

    fake.queryError = 'WMI is down';
    expect(await runner.observe([session()])).toEqual({ error: 'The Codex process query failed: WMI is down' });
  });

  it('keeps a session running while the turn that reported a question runs, and waiting once it ended', async () => {
    const fake = new Fake();
    const { runner, record } = await started(fake);

    const asking = session({ question: { id: 'q1', text: 'Which tree?' } });

    expect(await runner.observe([asking])).toMatchObject({ sessions: [{ sessionId: 's1', state: 'running', detail: null, interactive: false }] });

    append(record, DONE);
    fake.alive.delete(100);
    expect(await runner.observe([asking])).toMatchObject({ sessions: [{ sessionId: 's1', state: 'waiting', detail: null, interactive: false }] });
  });
});

describe('markers', () => {
  it('gives the run state without a query once the roster read knows the process, and asks for the roster otherwise', async () => {
    const fake = new Fake();
    const { runner, record } = await started(fake);

    expect(runner.markers([session()]).get(THREAD)).toEqual({ at: 0, observed: null, recheck: true });

    await runner.observe([session()]);
    const queries = fake.queries;

    expect(runner.markers([session()]).get(THREAD)).toEqual({ at: 0, observed: { state: 'running', detail: null }, recheck: false });
    append(record, DONE);
    expect(runner.markers([session()]).get(THREAD)).toEqual({ at: 0, observed: { state: 'idle', detail: null }, recheck: false });
    expect(fake.queries).toBe(queries);

    // The process died without a turn end: only the roster read ends the session.
    rmSync(runFiles(home, 's1').stdout);
    writeFileSync(runFiles(home, 's1').stdout, STARTED);
    fake.alive.delete(100);
    expect(runner.markers([session()]).get(THREAD)).toEqual({ at: 0, observed: null, recheck: true });
  });

  it('asks for the roster when the operator took the session, and skips sessions without a thread or record', async () => {
    const fake = new Fake();
    const { runner } = await started(fake);

    await runner.observe([session()]);
    fake.alive.add(900);
    marker({ event: 'Stop', at: 60 });
    expect(runner.markers([session()]).get(THREAD)).toEqual({ at: 60, observed: null, recheck: true });
    expect(runner.markers([session({ nativeSessionId: null }), session({ id: 's9' })]).size).toBe(0);
  });
});

describe('isBackground', () => {
  it("is false once another live process resumed the thread, and true for the run's own markers", async () => {
    const fake = new Fake();
    const { runner } = await started(fake);

    expect(await runner.isBackground({ sessionId: 's1', shortId: THREAD })).toBe(true);
    marker({ pid: 100, created: 'c100' });
    expect(await runner.isBackground({ sessionId: 's1', shortId: THREAD })).toBe(true);

    marker({});
    fake.alive.add(900);
    fake.created.set(900, 'c900');
    expect(await runner.isBackground({ sessionId: 's1', shortId: THREAD })).toBe(false);
    expect(await runner.isBackground({ sessionId: 's9', shortId: null })).toBe(false);
  });
});

describe('stop', () => {
  it('lets a released run exit on its own, and ends one that does not exit in time', async () => {
    const fake = new Fake();
    const { runner } = await started(fake);

    fake.alive.delete(100);
    expect(await runner.stop({ sessionId: 's1', shortId: THREAD }, 'release')).toBeNull();
    expect(fake.kills).toEqual([]);

    fake.alive.add(100);
    const before = fake.now;
    expect(await runner.stop({ sessionId: 's1', shortId: THREAD }, 'open')).toBeNull();
    expect(fake.now - before).toBeGreaterThanOrEqual(EXIT_WAIT_MS);
    expect(fake.kills).toEqual([100]);
  });

  it('ends the run at once for the operator, but never a process that reuses its PID', async () => {
    const fake = new Fake();
    const { runner } = await started(fake);

    fake.created.set(100, 'reused');
    expect(await runner.stop({ sessionId: 's1', shortId: THREAD }, 'operator')).toBeNull();
    expect(fake.kills).toEqual([]);

    fake.created.set(100, 'c100');
    expect(await runner.stop({ sessionId: 's1', shortId: THREAD }, 'operator')).toBeNull();
    expect(fake.kills).toEqual([100]);

    fake.alive.add(100);
    fake.queryError = 'denied';
    expect(await runner.stop({ sessionId: 's1', shortId: THREAD }, 'operator')).toEqual({ error: 'The Codex process query failed: denied' });
  });

  it('refuses a session that has not started, and one whose record is missing or of another format', async () => {
    const fake = new Fake();
    const { runner, record } = await started(fake);
    const unreadable = { error: "The session's run record cannot be read, so Switchboard cannot stop its Codex process." };

    expect(await runner.stop({ sessionId: 's9', shortId: null }, 'operator')).toEqual({ error: 'The session has not started yet.' });
    expect(await runner.stop({ sessionId: 's9', shortId: 'x' }, 'operator')).toEqual(unreadable);

    writeFileSync(join(home, 'codex', 's1.json'), JSON.stringify({ ...record, v: 1, attempt: 2 }));
    expect(await runner.stop({ sessionId: 's1', shortId: THREAD }, 'operator')).toEqual(unreadable);
    expect(await runner.stop({ sessionId: 's1', shortId: THREAD }, 'open')).toEqual(unreadable);
    expect(fake.kills).toEqual([]);
  });
});

describe('reconcile', () => {
  it('completes a start whose thread appeared, finds an untracked run by its tag, and fails the rest', async () => {
    const fake = new Fake();

    await started(fake);
    const record = readRecord(home, 's1')!;

    writeRecord(home, { ...record, sessionId: 's2', process: null, threadId: null });
    writeFileSync(runFiles(home, 's2').stdout, STARTED);
    fake.tags.set('s2', { pid: 100, created: 'c100' });
    writeRecord(home, { ...record, sessionId: 's3', process: null, threadId: null });
    writeFileSync(runFiles(home, 's3').stdout, '');

    const runner = fake.runner();

    expect(await runner.reconcile([session({ id: 's2', state: 'starting' }), session({ id: 's3', state: 'starting' }), session({ id: 's4', state: 'starting' })])).toEqual([
      { sessionId: 's2', started: { shortId: THREAD, nativeSessionId: THREAD } },
      { sessionId: 's3', failed: 'The hub stopped while the session was starting.' },
      { sessionId: 's4', failed: 'The hub stopped while the session was starting.' },
    ]);
    expect(readRecord(home, 's2')!.process).toEqual({ pid: 100, created: 'c100' });
  });
});

describe('installHooks', () => {
  it("writes the hook script and Switchboard's entries, then has Codex trust them", async () => {
    const fake = new Fake();

    expect(await fake.runner().installHooks()).toBeNull();
    expect(readFileSync(join(home, 'codex-hook.mjs'), 'utf8')).toBe(CODEX_HOOK_SOURCE);
    expect(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).toContain('codex-hook.mjs');
    expect([...fake.trusted[0]!]).toEqual([`node "${join(home, 'codex-hook.mjs').replaceAll('\\', '/')}"`, `node "${join(home, 'contract.mjs').replaceAll('\\', '/')}"`]);
  });

  it('reports a hooks file it must not change and a trust failure', async () => {
    const fake = new Fake();

    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'hooks.json'), '{ not json');
    expect(await fake.runner().installHooks()).toBe('Codex hooks.json is not valid JSON, so Switchboard left it alone.');
    expect(fake.trusted).toHaveLength(0);

    rmSync(join(codexHome, 'hooks.json'));
    fake.trustResult = "Codex did not trust Switchboard's hooks: no app-server";
    expect(await fake.runner().installHooks()).toBe("Codex did not trust Switchboard's hooks: no app-server");
    expect(existsSync(join(codexHome, 'hooks.json'))).toBe(true);
  });
});

describe('lifecycle races and recovery', () => {
  const ROLLOUT = readFileSync(join(import.meta.dirname, 'fixtures', 'rollout-failed.jsonl'), 'utf8');

  it("keeps a failed turn that only the rollout shows, in the roster read and in the marker pass after it", async () => {
    const fake = new Fake();
    const { runner, record } = await started(fake);
    const rollout = join(home, 'rollout.jsonl');

    append(record, DONE);
    fake.alive.delete(100);
    fake.alive.add(900);
    fake.created.set(900, 'c900');
    writeFileSync(rollout, ROLLOUT);
    marker({ event: 'UserPromptSubmit', turnId: '01a128bc-0ea9-7db2-b40c-05026520c232', transcriptPath: rollout });

    const failed = { state: 'failed', detail: "The 'no-such-model' model is not supported when using Codex with a ChatGPT account." };

    expect(await runner.observe([session({ released: true })])).toMatchObject({ sessions: [{ sessionId: 's1', ...failed, interactive: true }] });
    expect(runner.markers([session({ released: true })]).get(THREAD)).toEqual({ at: 50, observed: failed, recheck: false });
  });

  it('finds an untracked run by its tag before a stop acts on it, and returns a failed query', async () => {
    const fake = new Fake();
    const { runner } = await started(fake);

    writeRecord(home, { ...readRecord(home, 's1')!, process: null });
    fake.tags.set('s1', { pid: 100, created: 'c100' });
    expect(await runner.stop({ sessionId: 's1', shortId: THREAD }, 'operator')).toBeNull();
    expect(fake.kills).toEqual([100]);

    writeRecord(home, { ...readRecord(home, 's1')!, process: null });
    fake.tagError = 'WMI is down';
    expect(await runner.stop({ sessionId: 's1', shortId: THREAD }, 'operator')).toEqual({ error: 'The Codex process query failed: WMI is down' });
  });

  it("records the Codex child of a launcher, such as npm's on Linux, and leaves a child not started yet to be found by its tag", async () => {
    const fake = new Fake();

    fake.names.set(100, 'MainThread');
    fake.tags.set('s1', { pid: 101, created: 'c101' });
    expect((await started(fake)).record.process).toEqual({ pid: 101, created: 'c101' });

    const later = new Fake();

    later.names.set(100, 'MainThread');
    expect(await later.runner().start(ACTION)).toEqual({ shortId: THREAD, nativeSessionId: THREAD });
    expect(readRecord(home, 's1')!.process).toBeNull();
  });

  it('waits on a spawned process whose creation time cannot be read yet, and leaves it to be found by its tag', async () => {
    const fake = new Fake();

    fake.queryFailures = 3;
    const runner = fake.runner();

    expect(await runner.start(ACTION)).toEqual({ shortId: THREAD, nativeSessionId: THREAD });
    expect(readRecord(home, 's1')!.process).toBeNull();

    fake.tags.set('s1', { pid: 100, created: 'c100' });
    expect(await runner.observe([session()])).toMatchObject({ sessions: [{ sessionId: 's1', state: 'running', detail: null, interactive: false }] });
  });

  it('leaves a start whose process cannot be checked for a later read', async () => {
    const fake = new Fake();

    await started(fake);
    writeRecord(home, { ...readRecord(home, 's1')!, threadId: null });
    rmSync(runFiles(home, 's1').stdout);
    writeFileSync(runFiles(home, 's1').stdout, '');
    fake.queryError = 'WMI is down';
    expect(await fake.runner().reconcile([session({ state: 'starting' })])).toEqual([{ sessionId: 's1', pending: 'The Codex process query failed: WMI is down' }]);
  });
});
