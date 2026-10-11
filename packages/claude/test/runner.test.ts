import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Exec, ExecResult } from '../src/exec.js';
import type { Marker } from '../src/hooks.js';
import { entryFor, observe, readRoster, rosterState, shortIdFrom, startArgs, startSession, stopSession } from '../src/runner.js';
import type { StartAction } from '@switchboard/core';
import type { RosterEntry } from '../src/runner.js';

const AGENTS = readFileSync(join(import.meta.dirname, 'fixtures', 'agents.json'), 'utf8');
const ENTRIES = JSON.parse(AGENTS) as RosterEntry[];

const ACTION: StartAction = {
  type: 'start-session',
  sessionId: 's1',
  workItemId: 1,
  kind: 'task',
  cwd: 'D:/git/widgets',
  prompt: '/gc-plan 15619',
  contract: 'Report to Switchboard with these commands:',
  name: 'switchboard · dev:develop · github 15619',
  permissionMode: 'auto',
  model: 'opus',
};

/** Recorded `--bg` output (mechanics M5). */
const LAUNCHED = 'backgrounded · 1a2b3c4d · switchboard · mech · e2\n  claude agents             list sessions\n  claude attach 1a2b3c4d    open in this terminal\n  claude logs 1a2b3c4d      show recent output\n  claude stop 1a2b3c4d      stop this session\n';

const ran = (patch: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...patch });

/** Answers each call in turn and fails on an unexpected call. */
function fakeExec(...answers: ExecResult[]) {
  return vi.fn<Exec>(async () => {
    const answer = answers.shift();

    if (answer === undefined) {
      throw new Error('unexpected exec call');
    }

    return answer;
  });
}

function clock() {
  let now = 0;

  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

describe('startArgs and shortIdFrom', () => {
  it('starts in the background with the mode, name, model and the prompt as one argument', () => {
    expect(startArgs(ACTION)).toEqual([
      '--bg',
      '--permission-mode',
      'auto',
      '--settings',
      '{"worktree":{"bgIsolation":"none"}}',
      '-n',
      'switchboard · dev:develop · github 15619',
      '--model',
      'opus',
      '--append-system-prompt',
      'Report to Switchboard with these commands:',
      '/gc-plan 15619',
    ]);
    expect(startArgs({ ...ACTION, model: null })).not.toContain('--model');
  });

  it('reads the short ID from the backgrounded line only', () => {
    expect(shortIdFrom(LAUNCHED)).toBe('1a2b3c4d');
    expect(shortIdFrom('Starting…\r\nbackgrounded · 1a2b3c4d · switchboard · x\r\n')).toBe('1a2b3c4d');
    expect(shortIdFrom('usage: claude --bg')).toBeNull();
  });
});

describe('startSession', () => {
  it('launches in the work directory and waits for the session on the roster with a pid', async () => {
    const entry = { id: '1a2b3c4d', sessionId: '1a2b3c4d-0000-4000-8000-000000000000', kind: 'background', cwd: 'D:/git/widgets', state: 'working' };
    const launching = JSON.stringify([...ENTRIES, entry]);
    const listed = JSON.stringify([...ENTRIES, { ...entry, pid: 5 }]);
    const exec = fakeExec(ran({ stdout: LAUNCHED }), ran({ stdout: AGENTS }), ran({ code: 1, stderr: 'busy' }), ran({ stdout: launching }), ran({ stdout: listed }));

    expect(await startSession('claude', ACTION, { exec, ...clock() })).toEqual({ shortId: '1a2b3c4d', nativeSessionId: '1a2b3c4d-0000-4000-8000-000000000000' });
    expect(exec.mock.calls[0]).toEqual(['claude', startArgs(ACTION), { cwd: 'D:/git/widgets', timeoutMs: 60_000 }]);
    expect(exec.mock.calls[1]).toEqual(['claude', ['agents', '--json'], { timeoutMs: 15_000 }]);
    expect(exec).toHaveBeenCalledTimes(5);
  });

  it('fails when the entry never gets a pid', async () => {
    const launching = JSON.stringify([{ id: '1a2b3c4d', sessionId: '1a2b3c4d-0000', kind: 'background', cwd: '', state: 'working' }]);
    const exec = fakeExec(ran({ stdout: LAUNCHED }), ...Array.from({ length: 30 }, () => ran({ stdout: launching })));

    expect(await startSession('claude', ACTION, { exec, ...clock() })).toEqual({ error: 'Session 1a2b3c4d did not appear in claude agents within 60 seconds.' });
  });

  it("fails with Claude's message, such as the trust refusal", async () => {
    const refusal = 'Workspace not trusted. Run `claude` in D:\\git\\x once and accept the trust prompt, then retry.\n';

    expect(await startSession('claude', ACTION, { exec: fakeExec(ran({ code: 1, stderr: refusal })), ...clock() })).toEqual({
      error: 'Workspace not trusted. Run `claude` in D:\\git\\x once and accept the trust prompt, then retry.',
    });
  });

  it('fails when no ID is printed or the session never reaches the roster', async () => {
    expect(await startSession('claude', ACTION, { exec: fakeExec(ran({ stdout: 'odd output' })), ...clock() })).toEqual({ error: 'Claude started a session without printing its ID: odd output' });

    const roster = Array.from({ length: 30 }, () => ran({ stdout: AGENTS }));
    const exec = fakeExec(ran({ stdout: 'backgrounded · 1a2b3c4d · x' }), ...roster);

    expect(await startSession('claude', ACTION, { exec, ...clock() })).toEqual({ error: 'Session 1a2b3c4d did not appear in claude agents within 60 seconds.' });
    expect(exec).toHaveBeenCalledTimes(31);
  });
});

describe('roster', () => {
  it('reads entries and fails on a CLI error or bad output', async () => {
    expect(await readRoster('claude', fakeExec(ran({ stdout: AGENTS })))).toEqual({ entries: ENTRIES });
    expect(await readRoster('claude', fakeExec(ran({ code: 1, stderr: 'no' })))).toEqual({ error: 'no' });
    expect(await readRoster('claude', fakeExec(ran({ stdout: '{}' })))).toEqual({ error: 'claude agents returned an unexpected response.' });
    expect(await readRoster('claude', fakeExec(ran({ stdout: 'x' })))).toEqual({ error: 'claude agents returned output that is not JSON.' });
  });

  it('matches by short ID and maps roster states', () => {
    expect(entryFor(ENTRIES, 'a54bd2e6')?.pid).toBe(8292);
    expect(entryFor(ENTRIES, 'ffffffff')).toBeUndefined();
    expect(['working', 'blocked', 'done', 'stopped', undefined].map((state) => rosterState({ sessionId: 'x', kind: 'background', cwd: '', ...(state === undefined ? {} : { state }) }))).toEqual([
      'running',
      'waiting',
      'idle',
      'idle',
      'running',
    ]);
    expect(['idle', 'busy', 'waiting'].map((status) => rosterState({ sessionId: 'x', kind: 'interactive', cwd: '', status }))).toEqual(['idle', 'running', 'waiting']);
  });

  it('observes sessions whose entry holds a process, preferring the hook marker', () => {
    const marker = (event: string): Marker => ({ sessionId: '', event, notificationType: null, source: null, toolName: null, backgroundTasks: 0, error: null, errorMessage: null });
    const sessions = [
      { id: 's-gone', shortId: '45503b04' },
      { id: 's-roster', shortId: 'a54bd2e6' },
      { id: 's-unstarted', shortId: null },
      { id: 's-missing', shortId: 'ffffffff' },
    ];

    expect(observe(ENTRIES, sessions, new Map())).toEqual([{ sessionId: 's-roster', state: 'waiting', detail: null, interactive: false }]);
    expect(observe(ENTRIES, sessions, new Map([['a54bd2e6-d6aa-4867-bf31-e1fa0b9e8aa9', marker('Stop')]]))).toEqual([{ sessionId: 's-roster', state: 'idle', detail: null, interactive: false }]);
    expect(observe(ENTRIES, sessions, new Map([['a54bd2e6-d6aa-4867-bf31-e1fa0b9e8aa9', marker('SessionStart')]]))).toEqual([{ sessionId: 's-roster', state: 'waiting', detail: null, interactive: false }]);
    expect(observe(ENTRIES, [{ id: 's-tab', shortId: '3e065e9f' }], new Map())).toEqual([{ sessionId: 's-tab', state: 'running', detail: null, interactive: true }]);
  });
});

describe('stopSession', () => {
  it('runs claude stop and reports a failure', async () => {
    const exec = fakeExec(ran({}), ran({ code: 1, stderr: 'No such agent' }));

    expect(await stopSession('claude', '1a2b3c4d', exec)).toBeNull();
    expect(exec.mock.calls[0]).toEqual(['claude', ['stop', '1a2b3c4d'], { timeoutMs: 15_000 }]);
    expect(await stopSession('claude', '1a2b3c4d', exec)).toEqual({ error: 'No such agent' });
  });
});
