import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@switchboard/core';
import type { Exec, ExecResult } from '../src/exec.js';
import { ClaudeRunner, rosterDirectory } from '../src/sessionRunner.js';
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
    sleep: async () => {},
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
  it('observes the roster with the hook marker state, and reports a failed read', async () => {
    marker('Stop', 7);
    const exec = vi.fn<Exec>().mockResolvedValueOnce(ran({ stdout: JSON.stringify([ENTRY]) })).mockResolvedValueOnce(ran({ code: 1, stderr: 'boom' }));
    const claude = runner(exec);

    expect(await claude.observe([session()])).toEqual({ sessions: [{ sessionId: 's1', state: 'idle', detail: null, interactive: false }], forks: [] });
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

  it('rejoins an interrupted start only by its stored ID label and working directory', async () => {
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify([{ ...ENTRY, name: 'same title · s1' }]) }));
    expect(await runner(exec).reconcile([session({ state: 'starting', shortId: null, nativeSessionId: null })])).toEqual([{ sessionId: 's1', started: { shortId: '1a2b3c4d', nativeSessionId: '1a2b3c4d-0000-4000-8000-000000000000' } }]);
  });

  it('waits for registration, refuses ambiguity and does not adopt another label or directory', async () => {
    for (const entries of [[], [{ ...ENTRY, name: 'same title · s2' }], [{ ...ENTRY, name: 'same title · s1', cwd: 'D:/elsewhere' }], [{ ...ENTRY, name: 'same title · s1', pid: undefined }]]) {
      const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify(entries) }));
      expect(await runner(exec).reconcile([session({ state: 'starting', shortId: null, nativeSessionId: null })])).toEqual([{ sessionId: 's1', pending: 'Waiting for the Claude background session to appear in the roster.' }]);
    }
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify([{ ...ENTRY, name: 'same title · s1' }, { ...ENTRY, sessionId: 'another', name: 'same title · s1' }]) }));
    expect(await runner(exec).reconcile([session({ state: 'starting', shortId: null, nativeSessionId: null })])).toEqual([{ sessionId: 's1', pending: 'More than one Claude background session matches this start; inspect claude agents and stop the extra session so the original can be recovered.', attention: true }]);
  });

  it('keeps overdue or renamed starts owned and pending, and keeps failed reads pending', async () => {
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: '[]' }));
    expect(await runner(exec, { now: () => 120_000 }).reconcile([session({ state: 'starting', shortId: null, nativeSessionId: null })])).toEqual([{ sessionId: 's1', pending: 'The Claude start is still unconfirmed; inspect claude agents for the label ending · s1, then use Stop to clear this unconfirmed start if needed.', attention: true, clearable: true }]);
    exec.mockResolvedValue(ran({ code: 1, stderr: 'unavailable' }));
    expect(await runner(exec).reconcile([session({ state: 'starting' })])).toMatchObject([{ sessionId: 's1', pending: expect.any(String) }]);
  });

  it.each(['native', 'short'])('recovers a known %s identity after a rename', async identity => {
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify([{ ...ENTRY, name: 'renamed' }]) }));
    expect(await runner(exec).reconcile([session({ state: 'starting', ...(identity === 'native' ? { shortId: null } : { nativeSessionId: null }) })])).toEqual([{ sessionId: 's1', started: { shortId: '1a2b3c4d', nativeSessionId: '1a2b3c4d-0000-4000-8000-000000000000' } }]);
  });

  it('adopts a startup prompt only after two blocked reads of the same identity', async () => {
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify([{ ...ENTRY, pid: undefined, state: 'blocked', name: 'name · s1' }]) }));
    const claude = runner(exec);
    const starting = [session({ state: 'starting', shortId: null, nativeSessionId: null })];
    expect(await claude.reconcile(starting)).toMatchObject([{ pending: expect.any(String) }]);
    expect(await claude.reconcile(starting)).toEqual([{ sessionId: 's1', started: { shortId: '1a2b3c4d', nativeSessionId: '1a2b3c4d-0000-4000-8000-000000000000', startPrompt: true } }]);
  });

  it.skipIf(process.platform === 'win32')('recovers a real directory listed for a symlinked repository', async () => {
    const real = join(root, 'Repo');
    const link = join(root, 'link');
    mkdirSync(real); symlinkSync(real, link);
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify([{ ...ENTRY, cwd: real, name: 'name · s1' }]) }));
    expect(await runner(exec).reconcile([session({ state: 'starting', shortId: null, nativeSessionId: null, cwd: link })])).toMatchObject([{ started: { nativeSessionId: ENTRY.sessionId } }]);
  });

  it('compares recorded Windows and macOS directory spellings on any platform', async () => {
    expect(rosterDirectory('D:/Git/Repo/', 'win32')).toBe('d:\\git\\repo');
    expect(rosterDirectory('D:\\Git\\Repo\\', 'win32')).toBe('d:\\git\\repo');
    expect(rosterDirectory('C:/', 'win32')).toBe('c:\\');
    expect(rosterDirectory('/Repos/Repo/', 'darwin')).toBe('/repos/repo');
    expect(rosterDirectory('/', 'linux')).toBe('/');
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify([{ ...ENTRY, cwd: 'd:/GIT/WIDGETS/', name: 'name · s1' }]) }));
    expect(await runner(exec, { platform: 'win32' }).reconcile([session({ state: 'starting', shortId: null, nativeSessionId: null, cwd: 'D:\\git\\widgets\\' })])).toMatchObject([{ started: { shortId: '1a2b3c4d' } }]);
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
