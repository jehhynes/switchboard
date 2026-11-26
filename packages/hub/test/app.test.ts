import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Exec } from '@switchboard/claude';
import { CodexRunner } from '@switchboard/codex';
import { Store } from '@switchboard/core';
import type { SessionRunner } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHubApp, parseAction, parseReport } from '../src/app.js';
import { windowOf, windowsDir } from '../src/dock.js';
import { loadConfig } from '../src/config.js';
import { postToHub } from '../src/client.js';
import { listenHub } from '../src/server.js';
import type { Snapshot } from '../src/snapshot.js';
import { gitBashRoot, handledBody, isPastePath, registerTitle, reportBody, ticketBody } from '../src/report.js';
import { tempHome, until } from './helpers.js';
import type { HubApp } from '../src/serve.js';
import type { RuntimeDeps } from '../src/runtime.js';
import { toggleSource, temp, closers, noCli, writeSettings, start } from './appFixtures.js';

/** The needs-you alerts the hub shows as system notifications; no test shows a real one. */
const systemAlerts = vi.hoisted(() => [] as Array<{ alerts: unknown[]; sound: boolean }>);

vi.mock('../src/systemAlerts.js', () => ({ systemNotifier: () => ({ notify: (alerts: unknown[], sound: boolean) => systemAlerts.push({ alerts: [...alerts], sound }) }) }));

beforeEach(() => {
  systemAlerts.length = 0;
});

describe('parseReport and reportBody', () => {
  it('parses handled registration and conditional release, refusing missing values', () => {
    expect(handledBody(['handled', 's1', 'https://github.com/o/r/issues/1'])).toEqual({ sessionId: 's1', url: 'https://github.com/o/r/issues/1', releaseKey: null });
    expect(handledBody(['handled', 's1', 'https://github.com/o/r/issues/1', '--release=I:A'])).toMatchObject({ releaseKey: 'I:A' });
    for (const args of [[], ['handled'], ['handled', '--session', 'https://x'], ['handled', 's1', 'file:///x'], ['handled', 's1', 'https://x', '--release'], ['handled', 's1', 'https://x', '--release=']]) expect(handledBody(args)).toBeNull();
  });
  it('reads the report commands', () => {
    expect(reportBody(['stage', 's1', 'Writing', 'tests'])).toEqual({ sessionId: 's1', kind: 'stage', stage: 'Writing tests' });
    expect(reportBody(['worktree', 's1', 'D:/wt/1'])).toEqual({ sessionId: 's1', kind: 'worktree', path: resolve('D:/wt/1') });
    expect(reportBody(['done', 's1'])).toEqual({ sessionId: 's1', kind: 'done' });
    expect(reportBody(['done', 's1', '--summary', 'All good'])).toEqual({ sessionId: 's1', kind: 'done' });
    expect(reportBody(['approval', 's1', '--prompt', '/review-pr pr:123 publish', '--summary', 'Ready', '--report', 'wt/review.md'])).toEqual({ sessionId: 's1', kind: 'approval', prompt: '/review-pr pr:123 publish', summary: 'Ready', report: resolve('wt/review.md') });
    expect(reportBody(['approval', 's1', '--prompt=/publish'])).toEqual({ sessionId: 's1', kind: 'approval', prompt: '/publish', summary: null, report: null });
    expect(reportBody(['link', 's1', '--label', 'PR #12', '--target', 'https://github.com/o/r/pull/12'])).toEqual({ sessionId: 's1', kind: 'link', label: 'PR #12', target: 'https://github.com/o/r/pull/12' });
    expect(reportBody(['playbook', 's1', 'dev:review-pr'])).toEqual({ sessionId: 's1', kind: 'playbook', playbook: 'dev:review-pr' });
  });

  it('restores a slash command that Git Bash rewrote under its root, and leaves other prompts alone', () => {
    const root = 'C:/Program Files/Git';

    expect(reportBody(['approval', 's1', '--prompt', 'C:/Program Files/Git/sb-ship 16416'], root)).toMatchObject({ prompt: '/sb-ship 16416' });
    expect(reportBody(['approval', 's1', '--prompt=c:/program files/git/publish'], root)).toMatchObject({ prompt: '/publish' });
    expect(reportBody(['approval', 's1', '--prompt', 'C:/Program Files/Git/sb-ship 16416'])).toMatchObject({ prompt: 'C:/Program Files/Git/sb-ship 16416' });
    expect(reportBody(['approval', 's1', '--prompt', 'C:/Program Files/Gitlab/run'], root)).toMatchObject({ prompt: 'C:/Program Files/Gitlab/run' });
    expect(reportBody(['approval', 's1', '--prompt', 'Post the reply in C:/Program Files/Git/x'], root)).toMatchObject({ prompt: 'Post the reply in C:/Program Files/Git/x' });
  });

  it('asks cygpath for the Git Bash root only under Git Bash', () => {
    const calls: string[][] = [];
    const run = (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return 'C:/Program Files/Git/\n';
    };

    expect(gitBashRoot({}, run)).toBeNull();
    expect(calls).toEqual([]);
    expect(gitBashRoot({ MSYSTEM: 'MINGW64' }, run)).toBe('C:/Program Files/Git');
    expect(calls).toEqual([['cygpath', '-m', '/']]);
    expect(gitBashRoot({ MSYSTEM: 'MINGW64' }, () => '/\n')).toBeNull();
    expect(gitBashRoot({ MSYSTEM: 'MINGW64' }, () => {
      throw new Error('cygpath not found');
    })).toBeNull();
  });

  it('rejects bad usage', () => {
    for (const argv of [[], ['stage'], ['stage', 's1'], ['blocked', 's1', '--reason', 'x'], ['approval', 's1'], ['approval', 's1', '--summary', 'x'], ['approval', 's1', '--prompt', '/p', '--report', ''], ['approval', 's1', '--prompt', '/p', '--report'], ['approval', 's1', '--prompt', '/p', '--report', '--summary', 'Ready'], ['approval', 's1', '--prompt', '/p', '--report='], ['finish', 's1'], ['done', '--summary'], ['link', 's1', '--label', 'x'], ['link', 's1', '--target', 'https://x'], ['link', 's1', '--label', '', '--target', 'https://x'], ['link', 's1', '--label', 'x', '--target', 'vscode://x'], ['link', 's1', '--label', 'Case', '--target', 'cases/1/case.md'], ['link', 's1', '--target', '--label', 'Case'], ['playbook', 's1']]) {
      expect(reportBody(argv)).toBeNull();
    }
  });

  it.runIf(process.platform !== 'win32')('reads a paste with an absolute POSIX file and refuses a relative, Windows or missing file (R60)', () => {
    expect(reportBody(['paste', 's1', '--label', 'Customer reply', '--file', '/home/op/case/draft-reply.md'])).toEqual({ sessionId: 's1', kind: 'paste', label: 'Customer reply', file: '/home/op/case/draft-reply.md' });

    for (const argv of [['paste', 's1', '--label', 'Reply', '--file', 'cases/reply.md'], ['paste', 's1', '--label', 'Reply', '--file', 'D:\\case\\reply.md'], ['paste', 's1', '--label', 'Reply']]) {
      expect(reportBody(argv)).toBeNull();
    }
  });

  it.runIf(process.platform === 'win32')('reads a paste with an absolute file, turns a Git Bash drive path into a Windows one, and refuses a relative or missing file (R60)', () => {
    expect(reportBody(['paste', 's1', '--label', 'Customer reply', '--file', 'D:\\case\\draft-reply.md'])).toEqual({ sessionId: 's1', kind: 'paste', label: 'Customer reply', file: 'D:\\case\\draft-reply.md' });
    expect(reportBody(['paste', 's1', '--label=Private note', '--file=\\\\server\\share\\note.md'])).toEqual({ sessionId: 's1', kind: 'paste', label: 'Private note', file: '\\\\server\\share\\note.md' });
    expect(reportBody(['paste', 's1', '--label', 'Reply', '--file', '/d/git/support/reply.md'], 'C:/Program Files/Git')).toMatchObject({ file: 'D:/git/support/reply.md' });
    expect(reportBody(['paste', 's1', '--label', 'Reply', '--file', 'D:/git/support/reply.md'], 'C:/Program Files/Git')).toMatchObject({ file: 'D:/git/support/reply.md' });

    // Outside Git Bash, `/d/…` is not a Windows path; `\x` and `D:x` depend on the reader's current drive or directory.
    for (const argv of [['paste', 's1', '--label', 'Reply'], ['paste', 's1', '--label', 'Reply', '--file'], ['paste', 's1', '--label', 'Reply', '--file', 'cases/reply.md'], ['paste', 's1', '--label', 'Reply', '--file', '/d/git/support/reply.md'], ['paste', 's1', '--label', 'Reply', '--file', '\\case\\reply.md'], ['paste', 's1', '--label', 'Reply', '--file', 'D:case\\reply.md'], ['paste', 's1', '--file', 'D:\\reply.md'], ['paste', 's1', '--label', ' ', '--file', 'D:\\reply.md'], ['paste', 's1', '--label', '--file', 'D:\\reply.md']]) {
      expect(reportBody(argv)).toBeNull();
    }

    expect(parseReport({ sessionId: 's1', kind: 'paste', label: ' Customer reply ', file: 'D:\\case\\draft-reply.md' })).toEqual({ sessionId: 's1', kind: 'paste', label: 'Customer reply', file: 'D:\\case\\draft-reply.md' });
    for (const body of [{ label: 'Reply' }, { label: 'Reply', file: 'case/reply.md' }, { label: 'Reply', file: '\\case\\reply.md' }, { label: 'Reply', file: 3 }, { file: 'D:\\reply.md' }, { label: '', file: 'D:\\reply.md' }]) {
      expect(parseReport({ sessionId: 's1', kind: 'paste', ...body })).toBeNull();
    }
  });

  it('takes a paste file only when it names one file wherever it is read (R60)', () => {
    expect(['D:\\case\\reply.md', 'd:/case/reply.md', '\\\\server\\share\\reply.md', '//server/share/reply.md'].map((path) => isPastePath(path, 'win32'))).toEqual([true, true, true, true]);
    expect(['\\case\\reply.md', '/case/reply.md', 'D:case\\reply.md', 'case\\reply.md', '\\\\', 3].map((path) => isPastePath(path, 'win32'))).toEqual([false, false, false, false, false, false]);
    expect(['/home/me/reply.md', 'home/me/reply.md', 'D:\\case\\reply.md'].map((path) => isPastePath(path, 'linux'))).toEqual([true, false, false]);
  });

  it('reads a task report, resolving its repo and restoring a slash command Git Bash rewrote, and refuses bad usage (PRD R68)', () => {
    expect(reportBody(['task', 's1', '--prompt', 'Fix CartTests', '--repo', 'D:/git/widgets', '--title', 'Flaky tests'])).toEqual({ sessionId: 's1', kind: 'task', prompt: 'Fix CartTests', repo: resolve('D:/git/widgets'), title: 'Flaky tests' });
    expect(reportBody(['task', 's1', '--prompt=Fix it'])).toEqual({ sessionId: 's1', kind: 'task', prompt: 'Fix it', repo: null, title: null });
    expect(reportBody(['task', 's1', '--prompt', 'C:/Program Files/Git/sb-plan 18942'], 'C:/Program Files/Git')).toMatchObject({ prompt: '/sb-plan 18942' });

    for (const argv of [['task', 's1'], ['task', 's1', '--prompt', ' '], ['task', 's1', '--prompt', 'x', '--repo'], ['task', 's1', '--prompt', 'x', '--repo='], ['task', 's1', '--prompt', 'x', '--title'], ['task', 's1', '--title', 'x']]) {
      expect(reportBody(argv)).toBeNull();
    }

    expect(parseReport({ sessionId: 's1', kind: 'task', prompt: 'Fix it' })).toEqual({ sessionId: 's1', kind: 'task', prompt: 'Fix it', repo: null, title: null });
    expect(parseReport({ sessionId: 's1', kind: 'task', prompt: 'Fix it', repo: 'D:\\git\\widgets', title: 'T' })).toEqual({ sessionId: 's1', kind: 'task', prompt: 'Fix it', repo: 'D:\\git\\widgets', title: 'T' });

    for (const patch of [{ prompt: '' }, { prompt: 3 }, { repo: 'git/widgets' }, { title: 2 }]) {
      expect(parseReport({ sessionId: 's1', kind: 'task', prompt: 'Fix it', ...patch })).toBeNull();
    }
  });

  it('reads the register title in either flag form and refuses a missing or blank one (PRD R81)', () => {
    expect(registerTitle(['--title', 'Fix the badge'])).toBe('Fix the badge');
    expect(registerTitle(['--title=Fix it'])).toBe('Fix it');

    for (const argv of [[], ['--title'], ['--title', ' '], ['--title='], ['--title', '--home']]) {
      expect(registerTitle(argv)).toBeNull();
    }
  });

  it('reads a ticket report with or without a playbook, and refuses one without a session, an http(s) URL or a playbook value (PRD R83)', () => {
    expect(ticketBody(['ticket', 's1', 'https://github.com/o/r/issues/115'])).toEqual({ sessionId: 's1', url: 'https://github.com/o/r/issues/115', playbook: null });
    expect(ticketBody(['ticket', 's1', 'https://github.com/o/r/issues/115', '--playbook', 'dev:develop'])).toEqual({ sessionId: 's1', url: 'https://github.com/o/r/issues/115', playbook: 'dev:develop' });
    expect(ticketBody(['ticket', 's1', 'https://github.com/o/r/issues/115', '--playbook=dev:develop'])).toMatchObject({ playbook: 'dev:develop' });

    for (const argv of [['ticket'], ['ticket', '--playbook', 'x'], ['ticket', 's1'], ['ticket', 's1', 'github.com/o/r/issues/1'], ['ticket', 's1', 'https://github.com/o/r/issues/1', '--playbook'], ['ticket', 's1', 'https://github.com/o/r/issues/1', '--playbook='], ['ticket', 's1', 'https://github.com/o/r/issues/1', '--playbook', ''], ['stage', 's1', 'https://x']]) {
      expect(ticketBody(argv)).toBeNull();
    }
  });

  it("reads a Codex session's question, ignores the choices an earlier contract passed, and refuses one without text", () => {
    expect(reportBody(['question', 's1', '--text', 'Which tree?', '--option', 'Oak'])).toEqual({ sessionId: 's1', kind: 'question', text: 'Which tree?' });
    expect(reportBody(['question', 's1', '--text', ' '])).toBeNull();
    expect(reportBody(['question', 's1', '--option', 'Oak'])).toBeNull();

    expect(parseReport({ sessionId: 's1', kind: 'question', text: ' Which? ', options: [' Oak '] })).toEqual({ sessionId: 's1', kind: 'question', text: 'Which?' });

    for (const text of ['', ' ', 3]) {
      expect(parseReport({ sessionId: 's1', kind: 'question', text })).toBeNull();
    }
  });

  it('validates report and action bodies', () => {
    expect(parseReport({ sessionId: 's1', kind: 'stage', stage: 'x' })).toEqual({ sessionId: 's1', kind: 'stage', stage: 'x' });
    expect(parseReport({ sessionId: 's1', kind: 'done' })).toEqual({ sessionId: 's1', kind: 'done' });
    expect(parseReport({ sessionId: 's1', kind: 'playbook', playbook: 'dev:review-pr' })).toEqual({ sessionId: 's1', kind: 'playbook', playbook: 'dev:review-pr' });
    expect(parseReport({ sessionId: 's1', kind: 'playbook', playbook: '' })).toBeNull();
    expect(parseReport({ sessionId: 's1', kind: 'stage', stage: '' })).toBeNull();
    expect(parseReport({ sessionId: 's1', kind: 'done', summary: 'ignored' })).toEqual({ sessionId: 's1', kind: 'done' });
    expect(parseReport({ sessionId: 's1', kind: 'approval', prompt: '/publish' })).toEqual({ sessionId: 's1', kind: 'approval', prompt: '/publish', summary: null, report: null });
    expect(parseReport({ sessionId: 's1', kind: 'approval', prompt: '/publish', report: 'D:\\wt\\review.md' })).toMatchObject({ report: 'D:\\wt\\review.md' });
    expect(parseReport({ sessionId: 's1', kind: 'approval', prompt: '/publish', summary: 2 })).toBeNull();
    expect(parseReport({ sessionId: 's1', kind: 'approval', prompt: '/publish', report: 'wt/review.md' })).toBeNull();
    expect(parseReport({ sessionId: 's1', kind: 'blocked', reason: 'Stuck.' })).toBeNull();
    expect(parseReport({ sessionId: 's1', kind: 'link', label: ' PR ', target: 'https://github.com/o/r/pull/1' })).toEqual({ sessionId: 's1', kind: 'link', label: 'PR', target: 'https://github.com/o/r/pull/1' });
    for (const target of ['D:\\cases\\case.md', '/cases/case.md', 'cases/case.md', 'javascript:alert(1)', 'vscode://x', 'https://', 3]) {
      expect(parseReport({ sessionId: 's1', kind: 'link', label: 'x', target })).toBeNull();
    }
    expect(parseReport({ sessionId: 's1', kind: 'link', label: ' ', target: 'https://x' })).toBeNull();
    expect(parseAction({ type: 'snooze', ticketId: 1, until: null })).toEqual({ type: 'snooze', ticketId: 1, until: null });
    expect(parseAction({ type: 'snooze', ticketId: 1, until: 1_800_000_000_000 })).toEqual({ type: 'snooze', ticketId: 1, until: 1_800_000_000_000 });
    expect(parseAction({ type: 'snooze', ticketId: 1 })).toBeNull();
    expect(parseAction({ type: 'snooze', ticketId: 1, until: 'tomorrow' })).toBeNull();
    expect(parseAction({ type: 'snooze', ticketId: 1, until: null, comment: 'Waiting on the release.' })).toEqual({ type: 'snooze', ticketId: 1, until: null, comment: 'Waiting on the release.' });
    expect(parseAction({ type: 'snooze', ticketId: 1, until: null, comment: null })).toEqual({ type: 'snooze', ticketId: 1, until: null, comment: null });
    expect(parseAction({ type: 'snooze', ticketId: 1, until: null, comment: 7 })).toBeNull();
    expect(parseAction({ type: 'comment', workItemId: 3, text: 'Waiting on Dana.', sessionId: 'x' })).toEqual({ type: 'comment', workItemId: 3, text: 'Waiting on Dana.' });
    expect(parseAction({ type: 'comment', workItemId: 3 })).toBeNull();
    expect(parseAction({ type: 'comment', workItemId: '3', text: 'Hi' })).toBeNull();
    expect(parseAction({ type: 'icebox', ticketId: 1 })).toBeNull();
    // Pinning a persona was removed (operator decision 2026-11-26).
    expect(parseAction({ type: 'persona', sessionId: 's1', personaId: 'nova' })).toBeNull();
    expect(parseAction({ type: 'restore', ticketId: 1 })).toEqual({ type: 'restore', ticketId: 1 });
    expect(parseAction({ type: 'run-schedule', name: 'cleanup', workItemId: 3 })).toEqual({ type: 'run-schedule', name: 'cleanup' });
    expect(parseAction({ type: 'run-schedule', name: 3 })).toBeNull();
    expect(parseAction({ type: 'delete', workItemId: 3 })).toEqual({ type: 'delete', workItemId: 3 });
    expect(parseAction({ type: 'move', workItemId: 2, after: 5, sessionId: 's1' })).toEqual({ type: 'move', workItemId: 2, after: 5 });
    expect(parseAction({ type: 'move', workItemId: 2, after: null })).toEqual({ type: 'move', workItemId: 2, after: null });
    expect(parseAction({ type: 'move', workItemId: 2 })).toBeNull();
    expect(parseAction({ type: 'move', workItemId: 2, after: '5' })).toBeNull();
    expect(parseAction({ type: 'reset-position', workItemId: 2 })).toEqual({ type: 'reset-position', workItemId: 2 });
    expect(parseReport({ kind: 'stage', stage: 'x' })).toBeNull();
    expect(parseReport('text')).toBeNull();
    expect(parseAction({ type: 'approve', workItemId: 1 })).toEqual({ type: 'approve', workItemId: 1 });
    expect(parseAction({ type: 'start', workItemId: 1 })).toEqual({ type: 'start', workItemId: 1 });
    expect(parseAction({ type: 'start', workItemId: 1, guidance: 'Be brief.' })).toEqual({ type: 'start', workItemId: 1, guidance: 'Be brief.' });
    expect(parseAction({ type: 'pick', ticketId: 1, guidance: null })).toEqual({ type: 'pick', ticketId: 1, guidance: null });
    expect(parseAction({ type: 'start', workItemId: 1, guidance: 7 })).toBeNull();
    expect(parseAction({ type: 'pick', ticketId: 1, guidance: ['x'] })).toBeNull();
    expect(parseAction({ type: 'start', workItemId: 1, guidance: '', playbook: 'dev:other' })).toEqual({ type: 'start', workItemId: 1, guidance: '', playbook: 'dev:other' });
    expect(parseAction({ type: 'pick', ticketId: 1, playbook: 7 })).toBeNull();
    expect(parseAction({ type: 'start', workItemId: 1, prompt: 'Write hello.txt' })).toEqual({ type: 'start', workItemId: 1, prompt: 'Write hello.txt' });
    expect(parseAction({ type: 'start', workItemId: 1, prompt: 7 })).toBeNull();
    expect(parseAction({ type: 'poll', source: 'github', tickets: [] })).toBeNull();
  });

  it('refuses Open in Claude or Codex, which Switchboard no longer offers (PRD R93), and an answer', () => {
    for (const body of [
      { type: 'answer', workItemId: 3, nativeSessionId: 'native-3', question: 'Which tree?', answer: 'Birch' },
      { type: 'open-question', workItemId: 3, nativeSessionId: 'native-3' },
      { type: 'open-question', workItemId: 3 },
    ]) {
      expect(parseAction(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe('session provider metadata', () => {
  it('returns the configured provider without starting a session or changing settings', async () => {
    const claude = join(temp.home, 'claude.exe');
    // Executable, as Linux requires of a CLI.
    writeFileSync(claude, '', { mode: 0o755 });
    writeSettings({ sessions: { provider: 'codex', installHooks: false, claudePath: claude, codexPath: join(temp.home, 'missing', 'codex.exe') } });
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
    closers.push(() => app.close());
    expect(await app.post['/v1/conversation/providers']!({})).toMatchObject({ status: 200, body: { defaultProvider: 'codex', installed: ['claude'], models: { claude: expect.any(String), codex: expect.any(String) } } });
    const before = readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8');
    expect(await app.post['/v1/conversation/providers']!({})).toMatchObject({ body: { defaultProvider: 'codex' } });
    expect(readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8')).toBe(before);
  });
});

describe('loadConfig', () => {
  it('uses defaults without a settings file, keeps the previous settings on an invalid file, and lists playbook errors', () => {
    const fresh = loadConfig(join(temp.home, '.switchboard'));
    expect(fresh.settingsError).toBeNull();
    expect(fresh.settings.sessions.concurrency).toBe(2);

    writeSettings({ sessions: { concurrency: 3 } });
    const valid = loadConfig(join(temp.home, '.switchboard'));
    expect(valid.settings.sessions.concurrency).toBe(3);

    writeSettings({ sessions: { concurrency: 11 } });
    const invalid = loadConfig(join(temp.home, '.switchboard'), valid);
    expect(invalid.settings.sessions.concurrency).toBe(3);
    expect(invalid.settingsError).toBe('sessions.concurrency must be a whole number from 1 to 10.');

    writeSettings({ playbooks: { 'dev:bad': { description: 'Bad' } } });
    expect(loadConfig(join(temp.home, '.switchboard')).playbookErrors).toEqual([{ name: 'dev:bad', error: 'The prompt template is empty.' }]);
  });
});

describe('createHubApp', () => {
  it('serves actions and reports, refusing what does not apply', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const app = await start();

    expect(await app.post['/report']!({ sessionId: 's9', kind: 'stage', stage: 'x' })).toEqual({ status: 409, body: { error: 'Unknown session s9.' } });
    expect(await app.post['/report']!({ kind: 'stage' })).toEqual({ status: 400, body: { error: 'Expected {sessionId, kind, stage|path|reason|prompt|label and target}.' } });
    expect(await app.post['/contract']!({ nativeSessionId: 'n' })).toEqual({ status: 404, body: { error: 'No Switchboard session has this Claude session ID.' } });
    expect(await app.post['/contract']!({ sessionId: 'n' })).toEqual({ status: 400, body: { error: 'Expected {nativeSessionId, source?} with source compact or resume.' } });
    expect(await app.post['/contract']!({ nativeSessionId: 'n', source: 'startup' })).toEqual({ status: 400, body: { error: 'Expected {nativeSessionId, source?} with source compact or resume.' } });
    expect(await app.post['/contract']!({ nativeSessionId: 'n', source: 'resume' })).toEqual({ status: 404, body: { error: 'No Switchboard session has this Claude session ID.' } });
    expect(app.busy()).toBe(false);
    expect((app.snapshot() as { repoRoots: string[] }).repoRoots).toEqual(['D:/scratch']);
  });

  it('serves the web page to the remote hosts and logins of its settings, adding Tailscale\'s once it answers, and logs why not (PRD R115)', async () => {
    writeSettings({ sessions: { installHooks: false }, web: { remoteHosts: ['extra.example.net'], remoteLogins: ['a@example.com'], tailscale: true } });

    const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.tail1.ts.net.', UserID: 7 }, User: { '7': { LoginName: 'Alex@Example.com' } } });
    const lines: string[] = [];
    const exec = async (file: string, args: string[]) => (file === 'tailscale' ? { code: 0, stdout: status, stderr: '', missing: false, timedOut: false } : noCli(file, args, { timeoutMs: 0 }));
    const app = await createHubApp({ home: temp.home, log: (line) => lines.push(line), deps: { exec } });

    await until(() => (app.page!.remote!().hosts.length === 2 ? true : null));
    expect(app.page!.remote!()).toEqual({ hosts: ['pc.tail1.ts.net', 'extra.example.net'], logins: ['a@example.com', 'alex@example.com'] });
    expect(lines).toContain('page: served to other devices as https://pc.tail1.ts.net through tailscale serve');
    // The Tailscale login is personal, so the log leaves it out.
    expect(lines.join('\n')).not.toContain('alex@example.com');
    await app.close();

    writeSettings({ sessions: { installHooks: false }, web: { remoteHosts: ['extra.example.net'] } });

    const unset: string[] = [];
    const plain = await createHubApp({ home: temp.home, log: (line) => unset.push(line), deps: { exec: noCli } });

    closers.push(() => plain.close());
    expect(plain.page!.remote!()).toEqual({ hosts: ['extra.example.net'], logins: [] });
    expect(unset).toContain('page: web.remoteHosts is set but web.remoteLogins is empty, so no other device is let in');
  });

  it('reads the remote hosts, logins and web.tailscale again when settings.json changes, and has the server end the remote pages they no longer allow (PRD R115)', async () => {
    writeSettings({ sessions: { installHooks: false } });

    const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.tail1.ts.net.', UserID: 7 }, User: { '7': { LoginName: 'Alex@Example.com' } } });
    const lines: string[] = [];
    let asked = 0;
    const exec = async (file: string, args: string[]) => (file === 'tailscale' ? (asked++, { code: 0, stdout: status, stderr: '', missing: false, timedOut: false }) : noCli(file, args, { timeoutMs: 0 }));
    const app = await createHubApp({ home: temp.home, log: (line) => lines.push(line), deps: { exec } });
    let changed = 0;

    closers.push(() => app.close());
    app.attachRemote!(() => changed++);
    expect(app.page!.remote!()).toEqual({ hosts: [], logins: [] });

    writeSettings({ sessions: { installHooks: false }, web: { remoteHosts: ['extra.example.net'], remoteLogins: ['a@example.com'] } });
    await until(() => (app.page!.remote!().hosts.length === 1 ? true : null));
    expect(app.page!.remote!()).toEqual({ hosts: ['extra.example.net'], logins: ['a@example.com'] });
    expect(changed).toBe(1);
    expect(asked).toBe(0);

    writeSettings({ sessions: { installHooks: false }, web: { remoteHosts: ['extra.example.net'], remoteLogins: ['a@example.com'], tailscale: true } });
    await until(() => (app.page!.remote!().hosts.length === 2 ? true : null));
    expect(app.page!.remote!()).toEqual({ hosts: ['pc.tail1.ts.net', 'extra.example.net'], logins: ['a@example.com', 'alex@example.com'] });
    expect(lines).toContain('page: served to other devices as https://pc.tail1.ts.net through tailscale serve');
    // The Tailscale login is personal, so the log leaves it out.
    expect(lines.join('\n')).not.toContain('alex@example.com');

    // A change of the lists with web.tailscale still on keeps Tailscale's name and owner while it asks again.
    writeSettings({ sessions: { installHooks: false }, web: { remoteLogins: ['a@example.com'], tailscale: true } });
    await until(() => (asked === 2 ? true : null));
    expect(app.page!.remote!()).toEqual({ hosts: ['pc.tail1.ts.net'], logins: ['a@example.com', 'alex@example.com'] });

    // A change elsewhere in the file reads nothing again; the page's config event shows the reload ran.
    const before = changed;
    const frames: string[] = [];

    app.conversation!(app.page!.opened(false), (frame) => frames.push(frame));
    writeSettings({ sessions: { installHooks: false, concurrency: 3 }, web: { remoteLogins: ['a@example.com'], tailscale: true } });
    await until(() => (frames.some((frame) => frame.includes('\nevent: config\n')) ? true : null));
    expect(changed).toBe(before);
    expect(asked).toBe(2);

    writeSettings({ sessions: { installHooks: false } });
    await until(() => (app.page!.remote!().hosts.length === 0 ? true : null));
    expect(app.page!.remote!()).toEqual({ hosts: [], logins: [] });
    expect(lines).toContain('page: not served to other devices');
    expect(changed).toBeGreaterThan(before);
  });

  it('retires native pane commands even with an old setting', async () => {
    writeSettings({ sessions: { installHooks: false }, web: { chromePane: true } });
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
    closers.push(() => app.close());
    for (const command of ['pane-pair', 'pane-open', 'pane-rect']) expect(app.post[`/v1/conversation/${command}`]).toBeUndefined();
  });

  it("loads retired settings, logs a warning for each, and returns them from Settings' check", async () => {
    const retired = { sessions: { installHooks: false }, dock: { openVSCode: 'review', openTerminal: 'auto', openIn: 'web' }, alerts: { surface: 'dock' }, web: { chromePane: true } };
    const warnings = [
      'dock.openVSCode is no longer used and can be removed.',
      'dock.openTerminal is no longer used and can be removed.',
      'dock.openIn is no longer used and can be removed.',
      'web.chromePane is no longer used and can be removed.',
      'alerts.surface dock is no longer used and can be removed; it now works as auto.',
    ];

    writeSettings(retired);
    const logs: string[] = [];
    const app = await start((line) => logs.push(line));

    // One line for the settings no longer used, so a start says it once; others keep their own line.
    expect(logs.filter((line) => line.startsWith('settings: '))).toEqual(['settings: settings.json has settings no longer used: dock.openVSCode, dock.openTerminal, dock.openIn, web.chromePane. Remove them.', `settings: settings.json: ${warnings[4]}`]);
    expect((app.snapshot() as { errors: { settings: string | null } }).errors.settings).toBeNull();
    expect(await app.post['/v1/conversation/page-settings-check']!({ settings: retired })).toEqual({ status: 200, body: { errors: [], warnings } });
    expect(await app.post['/v1/conversation/page-settings-check']!({ settings: { sessions: { installHooks: false } } })).toEqual({ status: 200, body: { errors: [], warnings: [] } });
  });

  it('has no route for VS Code windows or the dock, which no longer connect: no claim, open, window command, background session, Open in Switchboard, window History, Expand replies, action, source toggle or poll', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start();

    for (const route of ['/claim', '/open', '/open/withdraw', '/window', '/window/withdraw', '/background', '/background/check', '/open-url', '/history', '/v1/conversation/open-file', '/v1/conversation/new-conversation', '/v1/conversation/expand-replies', '/action', '/sources', '/poll']) {
      expect(app.post[route], route).toBeUndefined();
    }

    expect(existsSync(join(temp.home, '.switchboard', 'window-queue.json'))).toBe(false);
  });
  it('registers a session the Claude roster lists, answering its key and contract, and refuses a bad body (PRD R81)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const native = '9273f594-1111-4222-8333-444455556666';
    const roster: Exec = async (file, args) => {
      if (file === 'claude' && args.join(' ') === 'agents --json') {
        return { code: 0, stdout: JSON.stringify([{ sessionId: native, pid: 7, kind: 'interactive', status: 'busy', cwd: 'D:/git/widgets' }]), stderr: '', missing: false, timedOut: false };
      }

      return noCli(file, args, { timeoutMs: 0 });
    };
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: roster } });
    closers.push(() => app.close());

    expect(await app.post['/register']!({ nativeSessionId: native })).toEqual({ status: 400, body: { error: 'Expected {nativeSessionId, title}.' } });
    expect(await app.post['/register']!({ nativeSessionId: '', title: 'x' })).toEqual({ status: 400, body: { error: 'Expected {nativeSessionId, title}.' } });
    expect(await app.post['/register']!({ nativeSessionId: 'not-listed', title: 'x' })).toEqual({ status: 409, body: { error: 'Claude does not list session not-listed as running.' } });

    const registered = await app.post['/register']!({ nativeSessionId: native, title: 'Fix the badge' });

    expect(registered).toEqual({ status: 200, body: { key: 'adhoc 1', already: false, contract: expect.stringContaining('Report to Switchboard with these commands:') } });
    expect(await app.post['/contract']!({ nativeSessionId: native })).toEqual({ status: 200, body: { contract: (registered.body as { contract: string }).contract } });
    expect(app.busy()).toBe(true);

    // The ticket route (PRD R83): a bad body is refused before any lookup, and a URL no enabled source has is refused by the runtime.
    for (const body of [{ url: 'https://github.com/o/r/issues/1' }, { sessionId: 's1' }, { sessionId: 's1', url: 'github.com/o/r/issues/1' }, { sessionId: 's1', url: 'https://x', playbook: 3 }, { sessionId: 's1', url: 'https://x', playbook: '' }]) {
      expect(await app.post['/ticket']!(body)).toEqual({ status: 400, body: { error: 'Expected {sessionId, url, playbook?}.' } });
    }

    const sessionId = app.runtime.snapshot().workItems[0]!.sessions[0]!.id;

    expect(await app.post['/ticket']!({ sessionId, url: 'https://github.com/o/r/issues/1', nativeSessionId: native })).toEqual({ status: 409, body: { error: 'No enabled source has https://github.com/o/r/issues/1 on its board.' } });
  });

  it('registers and releases a handled assignment through the HTTP route, refusing bad requests', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { github: { repoRoot: '' } } });
    const url = 'https://github.com/o/r/issues/7';
    const source = { name: 'github', poll: async () => ({ tickets: [] }), keyOfBranch: () => null, context: async () => ({ context: '' }), assignmentAt: async () => ({ ticket: { sourceKey: '7', ref: '#7', repo: '', title: 'Fix', url, open: true }, assignmentKey: 'I:A', assigned: false }) };
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli, makeSource: () => ({ source }) } });
    closers.push(() => app.close());
    await toggleSource(app, { name: 'github', enabled: true });
    app.runtime.send({ type: 'register', nativeSessionId: 'native', shortId: 'native', cwd: 'D:/repo', title: 'Prepare fix' });
    const sessionId = app.runtime.snapshot().workItems[0]!.sessions[0]!.id;
    for (const body of [{}, { sessionId, url: 'file:///x' }, { sessionId, url, releaseKey: '' }, { sessionId, url, releaseKey: 1 }]) {
      expect((await app.post['/handled']!(body)).status).toBe(400);
    }
    expect(await app.post['/handled']!({ sessionId, url })).toEqual({ status: 200, body: { assignmentKey: 'I:A' } });
    expect((await app.post['/handled']!({ sessionId, url, releaseKey: 'wrong' })).status).toBe(409);
    expect(await app.post['/handled']!({ sessionId, url, releaseKey: 'I:A' })).toEqual({ status: 200, body: { assignmentKey: null } });
  });

  it('reloads settings and playbooks when settings.json changes', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start();

    writeSettings({ sessions: { installHooks: false }, playbooks: { 'dev:develop': { description: 'Build it', template: 'Build.' } } });

    await until(() => ((app.snapshot() as { playbooks: unknown[] }).playbooks.length === 1 ? true : null));

    writeSettings('{ broken');
    await until(() => ((app.snapshot() as { errors: { settings: string | null } }).errors.settings?.startsWith('settings.json is not valid JSON') ? true : null));
  });

  it("polls the sources that are on at the page's Refresh sources, and refuses when none is", async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { github: { repoRoot: '' } } });
    let polls = 0;
    const makeSource = () => ({ source: { name: 'github', poll: async () => (polls++, { tickets: [] }), keyOfBranch: () => null, context: async () => ({ context: '' }) } });
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli, makeSource } });
    closers.push(() => app.close());

    const page = app.page!.opened(false);

    expect(await app.post['/v1/conversation/page-poll']!({ window: page })).toEqual({ status: 409, body: { error: 'No source is on. Turn one on in the list header.' } });
    expect(await toggleSource(app, { name: 'github', enabled: true })).toEqual({ status: 200, body: { done: true } });
    // A refresh while a read is in flight does not read again, so the first read finishes first.
    await new Promise((done) => setImmediate(done));
    expect(polls).toBe(1);

    expect(await app.post['/v1/conversation/page-poll']!({ window: page })).toEqual({ status: 200, body: { done: true } });
    expect(polls).toBe(2);
  });

  it('turns a source on and off in the store, leaving settings.json alone, and refuses an unknown source', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support', orgId: '1' }, adhoc: { repoRoot: 'D:/scratch' } } });
    const text = readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8');
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
    const states = () => (app.snapshot() as { sourceStates: unknown }).sourceStates;
    const enabled = async () => ((await app.post['/v1/conversation/page-settings-read']!({})).body as { enabled: Record<string, boolean> }).enabled;

    expect(states()).toEqual([{ name: 'zoho', kind: 'zoho', label: 'Zoho Desk', enabled: false }]);
    expect(await enabled()).toEqual({ zoho: false, adhoc: false });
    expect(await toggleSource(app, { name: 'zoho', kind: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect(states()).toEqual([{ name: 'zoho', kind: 'zoho', label: 'Zoho Desk', enabled: true }]);
    expect(await enabled()).toEqual({ zoho: true, adhoc: false });
    expect(readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8')).toBe(text);

    expect(await toggleSource(app, { name: 'forum', kind: 'forum', enabled: true })).toEqual({ status: 409, body: { error: 'settings.json has no source named forum.' } });
    expect(await toggleSource(app, { name: 'zoho', enabled: 'yes' })).toEqual({ status: 400, body: { error: 'Expected {window, name, enabled}.' } });
    app.close();

    // The state is kept in the store, so a new hub starts the source again.
    const again = await start();

    expect((again.snapshot() as { sourceStates: unknown }).sourceStates).toEqual([{ name: 'zoho', kind: 'zoho', label: 'Zoho Desk', enabled: true }]);
  });

  it("tells an open page's Settings to read again after a toggle, and not after a refused one", async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support' } } });
    const app = await start();
    const frames: string[] = [];
    const configs = () => frames.filter((frame) => frame.includes('\nevent: config\n')).length;

    app.conversation!(app.page!.opened(false), (frame) => frames.push(frame));
    expect(await toggleSource(app, { name: 'forum', kind: 'forum', enabled: true })).toMatchObject({ status: 409 });
    expect(configs()).toBe(0);
    expect(await toggleSource(app, { name: 'zoho', kind: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect(configs()).toBe(1);
  });

  it('checks an enabled source\'s own keys only while it is on, and refuses an enabled key in settings.json', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support' } } });
    const app = await start();
    const check = async (settings: unknown) => ((await app.post['/v1/conversation/page-settings-check']!({ settings })).body as { errors: string[] }).errors;

    expect(await check({ sources: { zoho: { repoRoot: 'D:/support' } } })).toEqual([]);
    expect(await toggleSource(app, { name: 'zoho', kind: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect(await check({ sources: { zoho: { repoRoot: 'D:/support' } } })).toEqual([expect.stringMatching(/^sources\.zoho\./)]);
    expect(await check({ sources: { zoho: { enabled: true } } })).toEqual(["sources.zoho.enabled is not a setting; turn a source on and off in the list's header."]);
  });

  it('loads the source plugins settings name, polls a pool source through one, and checks a draft that names another (PRD R1)', async () => {
    const plugins = join(temp.home, 'plugins');
    mkdirSync(plugins, { recursive: true });
    const module = (kind: string) =>
      `export default { kind: '${kind}', label: 'Forum ${kind}', icon: { viewBox: '0 0 24 24', path: 'M0 0H24V24H0Z' }, fields: [{ key: 'userId', label: 'User ID', type: 'text' }], ` +
      `optionsError: (options, name) => (typeof options.userId === 'string' ? null : 'sources.' + name + '.userId must be set.'), ` +
      `create: (name) => ({ source: { name, keyOfBranch: () => null, context: async () => ({ context: '' }), ` +
      `poll: async () => ({ tickets: [{ sourceKey: '7', ref: 'T7', sourceId: null, title: 'Topic 7', url: 'https://forum.example/t/7', assigned: false, pool: true, sortAt: null, repo: '' }] }) } }) };`;
    writeFileSync(join(plugins, 'forum.mjs'), module('forum'));
    writeFileSync(join(plugins, 'desk.mjs'), module('desk'));
    writeSettings({ plugins: ['~/plugins/forum.mjs'], sessions: { installHooks: false }, sources: { forum: { userId: '1' } } });
    const app = await start();
    const read = (await app.post['/v1/conversation/page-settings-read']!({})).body as { sourceKinds: string[]; sourceLabels: Record<string, string>; sourceFields: Record<string, unknown> };

    expect(read.sourceKinds).toEqual(['github', 'zoho', 'forum']);
    expect(read.sourceLabels['forum']).toBe('Forum forum');
    expect(read.sourceFields).toEqual({ forum: [{ key: 'userId', label: 'User ID', type: 'text' }] });
    expect((app.snapshot() as { sourceStates: unknown }).sourceStates).toEqual([{ name: 'forum', kind: 'forum', label: 'Forum forum', icon: { viewBox: '0 0 24 24', path: 'M0 0H24V24H0Z' }, enabled: false }]);
    const frames: string[] = [];
    app.conversation!(app.page!.opened(false), (frame) => frames.push(frame));
    const hello = frames.find((frame) => frame.includes('event: hello\n'))!;
    expect(JSON.parse(hello.slice(hello.indexOf('data: ') + 6)).header.sources[0].icon).toEqual({ viewBox: '0 0 24 24', path: 'M0 0H24V24H0Z' });

    expect(await toggleSource(app, { name: 'forum', enabled: true })).toEqual({ status: 200, body: { done: true } });
    await until(() => ((app.snapshot() as { pool: { ticket: { title: string } }[] }).pool.find((entry) => entry.ticket.title === 'Topic 7') ?? null));
    expect((app.snapshot() as { pool: { ticket: { source: string; pool: boolean } }[] }).pool[0]!.ticket).toMatchObject({ source: 'forum', pool: true });

    const check = async (settings: unknown) => ((await app.post['/v1/conversation/page-settings-check']!({ settings })).body as { errors: string[] }).errors;

    expect(await check({ plugins: ['~/plugins/forum.mjs', '~/plugins/desk.mjs'], sources: { forum: { userId: '1' }, desk: {} } })).toEqual([]);
    expect(await check({ plugins: ['~/plugins/forum.mjs', '~/plugins/desk.mjs'], sources: { forum: {} } })).toEqual(['sources.forum.userId must be set.']);
    expect(await check({ plugins: ['~/plugins/gone.mjs'], sources: { forum: {} } })).toEqual([
      expect.stringMatching(/^plugins: ~\/plugins\/gone\.mjs: it could not be loaded: /),
      expect.stringMatching(/^sources\.forum: Switchboard has no source kind forum\. plugins: ~\/plugins\/gone\.mjs: /),
    ]);
    // The draft's plugins are not put in force by a check.
    expect(((await app.post['/v1/conversation/page-settings-read']!({})).body as { sourceKinds: string[] }).sourceKinds).toEqual(['github', 'zoho', 'forum']);
  });

});
