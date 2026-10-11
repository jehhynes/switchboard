import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@switchboard/core';
import type { Exec, ExecResult } from '../src/exec.js';
import { jobStatePath } from '../src/service.js';
import { ClaudeRunner } from '../src/sessionRunner.js';
import type { ClaudeRunnerDeps } from '../src/sessionRunner.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const ran = (patch: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...patch });

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchboard-claude-runner-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1',
    workItemId: 1,
    kind: 'task',
    provider: 'claude',
    nativeSessionId: '1a2b3c4d-0000-4000-8000-000000000000',
    shortId: '1a2b3c4d',
    cwd: 'D:/git/widgets',
    state: 'running',
    stateAt: 0,
    stateDetail: null,
    outcome: null,
    outcomeDetail: null,
    startedAt: 0,
    endedAt: null,
    released: false, releasing: false, question: null,
    reports: ['stage'],
    ...patch,
  };
}

function runner(exec: Exec, patch: Partial<ClaudeRunnerDeps> = {}): ClaudeRunner {
  return new ClaudeRunner({
    claudePath: 'claude',
    exec,
    sleep: async () => {},
    now: () => 0,
    home: join(root, '.switchboard'),
    claudeSettings: join(root, '.claude', 'settings.json'),
    service: { listPipes: () => [], connect: () => { throw new Error('no pipe'); } },
    hooks: () => true,
    ...patch,
  });
}

function marker(event: string, at: number): void {
  mkdirSync(join(root, '.switchboard', 'activity'), { recursive: true });
  writeFileSync(join(root, '.switchboard', 'activity', `${session().nativeSessionId}.json`), JSON.stringify({ v: 1, sessionId: session().nativeSessionId, event, at, notificationType: null, source: null, toolName: null, backgroundTasks: 0, error: null, errorMessage: null }));
}

const ENTRY = { id: '1a2b3c4d', sessionId: '1a2b3c4d-0000-4000-8000-000000000000', pid: 5, kind: 'background', cwd: 'D:/git/widgets', state: 'working' };

describe('ClaudeRunner', () => {
  it('observes the roster with the hook marker state, and reports a failed read', async () => {
    marker('Stop', 7);
    const exec = vi.fn<Exec>().mockResolvedValueOnce(ran({ stdout: JSON.stringify([ENTRY]) })).mockResolvedValueOnce(ran({ code: 1, stderr: 'boom' }));
    const claude = runner(exec);

    expect(await claude.observe([session()])).toEqual({ sessions: [{ sessionId: 's1', state: 'idle', detail: null, interactive: false }] });
    expect(await claude.observe([session()])).toEqual({ error: 'boom' });
    expect(exec).toHaveBeenCalledWith('claude', ['agents', '--json'], expect.anything());
  });

  it('reads markers only while hooks are on', () => {
    marker('UserPromptSubmit', 9);

    expect(runner(vi.fn<Exec>()).markers([session()]).get(session().nativeSessionId!)).toEqual({ at: 9, observed: { state: 'running', detail: null }, recheck: false });
    expect(runner(vi.fn<Exec>(), { hooks: () => false }).markers([session()]).size).toBe(0);
  });

  it('tells a background process from an interactive one, and a session without a short ID from both', async () => {
    const exec = vi.fn<Exec>().mockResolvedValueOnce(ran({ stdout: JSON.stringify([ENTRY]) })).mockResolvedValueOnce(ran({ stdout: JSON.stringify([{ ...ENTRY, kind: 'interactive' }]) }));
    const claude = runner(exec);

    expect(await claude.isBackground({ sessionId: 's1', shortId: '1a2b3c4d' })).toBe(true);
    expect(await claude.isBackground({ sessionId: 's1', shortId: '1a2b3c4d' })).toBe(false);
    expect(await claude.isBackground({ sessionId: 's1', shortId: null })).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('stops with claude stop, and refuses a session that has not started', async () => {
    const exec = vi.fn<Exec>().mockResolvedValue(ran({}));
    const claude = runner(exec);

    expect(await claude.stop({ sessionId: 's1', shortId: '1a2b3c4d' }, 'operator')).toBeNull();
    expect(exec).toHaveBeenCalledWith('claude', ['stop', '1a2b3c4d'], expect.anything());
    expect(await claude.stop({ sessionId: 's1', shortId: null }, 'operator')).toEqual({ error: 'The session has not started yet.' });
  });

  it('reads the job state question again only when the file changes', () => {
    const claude = runner(vi.fn<Exec>());
    const path = jobStatePath(join(root, '.claude'), '1a2b3c4d');

    expect(claude.question(session())).toBeNull();
    expect(claude.question(session({ shortId: null }))).toBeNull();

    mkdirSync(join(path, '..'), { recursive: true });
    copyFileSync(join(FIXTURES, 'job-state-one-question.json'), path);
    utimesSync(path, 1000, 1000);
    const first = claude.question(session());

    expect(first).toEqual({ question: { text: 'Which fruit should I record?', options: expect.any(Array), parts: 1 }, version: '1000000' });

    // Same modification time: the cached read stands even though the content changed.
    writeFileSync(path, readFileSync(join(FIXTURES, 'job-state-two-questions.json')));
    utimesSync(path, 1000, 1000);
    expect(claude.question(session())).toEqual(first);

    utimesSync(path, 2000, 2000);
    expect(claude.question(session())?.question?.parts).toBe(2);

    // Forgotten when the session stops waiting: the next wait reads the file even at the same modification time.
    copyFileSync(join(FIXTURES, 'job-state-one-question.json'), path);
    utimesSync(path, 2000, 2000);
    expect(claude.question(session())?.question?.parts).toBe(2);
    claude.forgetQuestion({ sessionId: 's1', shortId: '1a2b3c4d' });
    expect(claude.question(session())?.question?.parts).toBe(1);
  });

  it('fails every session a stopped hub left starting', async () => {
    expect(await runner(vi.fn<Exec>()).reconcile([session({ state: 'starting', shortId: null })])).toEqual([{ sessionId: 's1', failed: 'The hub stopped while the session was starting.' }]);
  });

  it('reports a reply the service cannot take', async () => {
    expect(await runner(vi.fn<Exec>()).reply({ sessionId: 's1', shortId: '1a2b3c4d', question: 'Which fruit?', questionId: null, answer: 'Mango' })).toEqual({ error: "Claude's background service is not running." });
  });

  it('installs the hooks into the settings file, and reports a settings file it must not change', async () => {
    const settings = join(root, '.claude', 'settings.json');

    expect(await runner(vi.fn<Exec>()).installHooks()).toBeNull();
    expect(readFileSync(settings, 'utf8')).toContain('hook.mjs');

    writeFileSync(settings, '{ not json');
    expect(await runner(vi.fn<Exec>()).installHooks()).toMatch(/settings/i);
  });
});
