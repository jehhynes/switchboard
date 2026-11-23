import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@switchboard/core';
import type { Exec, ExecResult } from '../src/exec.js';
import { ClaudeRunner, NOT_HELD } from '../src/sessionRunner.js';
import type { ClaudeRunnerDeps } from '../src/sessionRunner.js';

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
    released: false, releasing: false, question: null, retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null,
    reports: ['stage'],
    ...patch,
  };
}

function runner(exec: Exec, patch: Partial<ClaudeRunnerDeps> = {}): ClaudeRunner {
  return new ClaudeRunner({
    claudePath: () => 'claude',
    exec,
    now: () => 0,
    home: join(root, '.switchboard'),
    claudeSettings: join(root, '.claude', 'settings.json'),
    hooks: () => true,
    nodePath: () => 'node',
    ...patch,
  });
}

function marker(event: string, at: number): void {
  mkdirSync(join(root, '.switchboard', 'activity'), { recursive: true });
  writeFileSync(join(root, '.switchboard', 'activity', `${session().nativeSessionId}.json`), JSON.stringify({ v: 1, sessionId: session().nativeSessionId, event, at, notificationType: null, source: null, toolName: null, backgroundTasks: 0, error: null, errorMessage: null }));
}

const ENTRY = { id: '1a2b3c4d', sessionId: '1a2b3c4d-0000-4000-8000-000000000000', pid: 5, kind: 'background', cwd: 'D:/git/widgets', state: 'working' };

describe('ClaudeRunner', () => {
  it('observes a session in a tab with the hook marker state, never one in the background service, and reports a failed read', async () => {
    marker('Stop', 7);
    const exec = vi
      .fn<Exec>()
      .mockResolvedValueOnce(ran({ stdout: JSON.stringify([{ ...ENTRY, kind: 'interactive' }]) }))
      .mockResolvedValueOnce(ran({ stdout: JSON.stringify([ENTRY]) }))
      .mockResolvedValueOnce(ran({ code: 1, stderr: 'boom' }));
    const claude = runner(exec);

    expect(await claude.observe([session()])).toEqual({ sessions: [{ sessionId: 's1', state: 'idle', detail: null, interactive: true }], forks: [] });
    expect(await claude.observe([session()])).toEqual({ sessions: [], forks: [] });
    expect(await claude.observe([session()])).toEqual({ error: 'boom' });
    expect(exec).toHaveBeenCalledWith('claude', ['agents', '--json'], expect.anything());
  });

  describe('forks', () => {
    const FORK = '9e8d7c6b-0000-4000-8000-000000000002';
    const fork = { pid: 9, cwd: 'D:\\git\\widgets', kind: 'interactive', sessionId: FORK, status: 'idle' };

    async function transcripts(): Promise<void> {
      const project = join(root, '.claude', 'projects', 'D--git-widgets');
      mkdirSync(project, { recursive: true });
      copyFileSync(join(import.meta.dirname, 'fixtures', 'fork-plain-original.jsonl'), join(project, `${session().nativeSessionId}.jsonl`));
      // The fork's file is created after the session's own, as Fork conversation writes it.
      await new Promise((done) => setTimeout(done, 20));
      copyFileSync(join(import.meta.dirname, 'fixtures', 'fork-plain-copy.jsonl'), join(project, `${FORK}.jsonl`));
    }

    it("observes a session's live fork from the transcripts in Claude's projects directory", async () => {
      await transcripts();
      const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify([fork]) }));

      expect(await runner(exec).observe([session({ state: 'ended' })])).toEqual({ sessions: [], forks: [{ sessionId: 's1', nativeSessionId: FORK, shortId: '9e8d7c6b', state: 'idle', detail: null }] });
    });

    it('tells how a copy relates to the session, and finds the session a fork belongs to', async () => {
      await transcripts();
      const claude = runner(vi.fn<Exec>());

      expect(claude.relation(FORK, session())).toBe('newer');
      expect(claude.relation(session().nativeSessionId!, session({ nativeSessionId: FORK, retiredIds: [session().nativeSessionId!] }))).toBe('older');
      expect(claude.relation(FORK, session({ nativeSessionId: FORK }))).toBe('unrelated');
      expect(claude.relation(FORK, session({ nativeSessionId: null }))).toBe('unrelated');
      expect(claude.forkOf(FORK, [session()])?.id).toBe('s1');
      expect(claude.forkOf('ffffffff-0000-4000-8000-000000000000', [session()])).toBeNull();
    });
  });

  it('reads markers only while hooks are on', () => {
    marker('UserPromptSubmit', 9);

    expect(runner(vi.fn<Exec>()).markers([session()]).get(session().nativeSessionId!)).toEqual({ at: 9, cwd: null, observed: { state: 'running', detail: null }, recheck: false });
    expect(runner(vi.fn<Exec>(), { hooks: () => false }).markers([session()]).size).toBe(0);
  });

  it('starts, stops and releases no session, since every Claude session Switchboard starts is held (PRD R93)', async () => {
    const exec = vi.fn<Exec>();
    const claude = runner(exec);

    expect(await claude.start({ type: 'start-session', sessionId: 's1', workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/git/widgets', prompt: 'p', contract: 'c', name: 'n', permissionMode: 'auto', model: null })).toEqual({ error: NOT_HELD });
    expect(await claude.stop({ sessionId: 's1', shortId: '1a2b3c4d' }, 'operator')).toEqual({ error: NOT_HELD });
    expect(await claude.isBackground({ sessionId: 's1', shortId: '1a2b3c4d' })).toBe(false);
    expect(await claude.reconcile([session({ state: 'starting', shortId: null, nativeSessionId: null })])).toEqual([{ sessionId: 's1', failed: 'The hub stopped while the session was starting.' }]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('installs the hooks into the settings file, and reports a settings file it must not change', async () => {
    const settings = join(root, '.claude', 'settings.json');

    expect(await runner(vi.fn<Exec>()).installHooks()).toBeNull();
    expect(readFileSync(settings, 'utf8')).toContain('hook.mjs');

    writeFileSync(settings, '{ not json');
    expect(await runner(vi.fn<Exec>()).installHooks()).toMatch(/settings/i);
  });
});

describe('ClaudeRunner.live (PRD R81)', () => {
  const NATIVE = '9273f594-1111-4222-8333-444455556666';

  it('finds the session the roster lists with a process by its full native ID, with its directory, and a tab by its first 8 characters', async () => {
    const roster = [
      { sessionId: '9273f594-ffff-4fff-8fff-ffffffffffff', pid: 1, kind: 'interactive', cwd: 'D:/other' },
      { sessionId: NATIVE, pid: 2, kind: 'interactive', status: 'busy', cwd: 'D:/git/widgets' },
    ];
    const exec = vi.fn<Exec>(async () => ran({ stdout: JSON.stringify(roster) }));

    expect(await runner(exec).live(NATIVE)).toEqual({ shortId: '9273f594', cwd: 'D:/git/widgets' });
    expect(exec).toHaveBeenCalledWith('claude', ['agents', '--json'], expect.anything());
  });

  it("takes a background entry's short ID, and finds no session without a process or not listed", async () => {
    const listed = async (entries: unknown[]) => runner(async () => ran({ stdout: JSON.stringify(entries) })).live(NATIVE);

    expect(await listed([{ id: 'bg123456', sessionId: NATIVE, pid: 3, kind: 'background', cwd: 'D:/git/widgets' }])).toEqual({ shortId: 'bg123456', cwd: 'D:/git/widgets' });
    expect(await listed([{ sessionId: NATIVE, kind: 'interactive', cwd: 'D:/git/widgets' }])).toBeNull();
    expect(await listed([])).toBeNull();
  });

  it('answers a failed roster read with its error', async () => {
    const result = await runner(async () => ran({ code: 1, stderr: 'boom' })).live(NATIVE);

    expect(result).toMatchObject({ error: expect.stringContaining('boom') });
  });
});
