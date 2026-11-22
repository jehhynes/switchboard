import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Exec } from '@switchboard/claude';
import { PANE_EXTENSION_ID, Store } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHubApp, parseAction, parseReport } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { postToHub } from '../src/client.js';
import { listenHub } from '../src/server.js';
import type { Snapshot } from '../src/snapshot.js';
import { gitBashRoot, handledBody, isPastePath, registerTitle, reportBody, ticketBody } from '../src/report.js';
import { tempHome, until } from './helpers.js';

let temp: ReturnType<typeof tempHome>;
let closers: (() => void | Promise<void>)[] = [];

beforeEach(() => {
  temp = tempHome();
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }

  temp.remove();
});

/** Answers only the hub's Node.js check. */
const noCli: Exec = async (file, args) => {
  if (file === 'node' && args.join(' ') === '--version') {
    return { code: 0, stdout: 'v24.0.0\n', stderr: '', missing: false, timedOut: false };
  }

  throw new Error(`unexpected call ${file} ${args.join(' ')}`);
};

function writeSettings(settings: unknown): void {
  mkdirSync(join(temp.home, '.switchboard'), { recursive: true });
  writeFileSync(join(temp.home, '.switchboard', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
}

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

  it('keeps only the fields of Open in Claude, refuses it without a work item or the session, and refuses an answer (PRD R70)', () => {
    expect(parseAction({ type: 'open-question', workItemId: 3, nativeSessionId: 'native-3', sessionId: 's1', cwd: 'D:/wt' })).toEqual({ type: 'open-question', workItemId: 3, nativeSessionId: 'native-3' });

    for (const body of [
      { type: 'answer', workItemId: 3, nativeSessionId: 'native-3', question: 'Which tree?', answer: 'Birch' },
      { type: 'open-question', workItemId: 3 },
      { type: 'open-question', workItemId: 1.5, nativeSessionId: 'native-3' },
    ]) {
      expect(parseAction(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe('session provider metadata', () => {
  it('returns the configured provider without starting a session or changing settings', async () => {
    const claude = join(temp.home, 'claude.exe');
    writeFileSync(claude, '');
    writeSettings({ sessions: { provider: 'codex', installHooks: false, claudePath: claude, codexPath: join(temp.home, 'missing', 'codex.exe') } });
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
    closers.push(() => app.close());
    expect(await app.post['/v1/conversation/providers']!({})).toEqual({ status: 200, body: { defaultProvider: 'codex', installed: ['claude'] } });
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
  async function start(log: (line: string) => void = () => {}) {
    const app = await createHubApp({ home: temp.home, log, deps: { exec: noCli } });
    closers.push(() => app.close());

    return app;
  }

  it('serves actions and reports, refusing what does not apply', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const app = await start();

    expect(await app.post['/action']!({ type: 'approve', workItemId: 9 })).toEqual({ status: 409, body: { error: 'Unknown work item 9.' } });
    expect(await app.post['/action']!({ type: 'poll' })).toEqual({ status: 400, body: { error: 'Unknown action.' } });
    expect(await app.post['/action']!({ type: 'retriage', workItemId: 1 })).toEqual({ status: 400, body: { error: 'Unknown action.' } });
    expect(await app.post['/action']!({ type: 'answer', workItemId: 9, nativeSessionId: 'n', question: 'Which?', answer: 'Birch' })).toEqual({ status: 400, body: { error: 'Unknown action.' } });
    expect(await app.post['/action']!({ type: 'open-question', workItemId: 9, nativeSessionId: 'n' })).toEqual({ status: 409, body: { error: 'Unknown work item 9.' } });
    expect(await app.post['/action']!({ type: 'open-question', workItemId: 'x', nativeSessionId: 'n' })).toEqual({ status: 400, body: { error: 'Unknown action.' } });
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

    const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.tail1.ts.net.', UserID: 7 }, User: { '7': { LoginName: 'alex@example.com' } } });
    const lines: string[] = [];
    const exec = async (file: string, args: string[]) => (file === 'tailscale' ? { code: 0, stdout: status, stderr: '', missing: false, timedOut: false } : noCli(file, args, { timeoutMs: 0 }));
    const app = await createHubApp({ home: temp.home, log: (line) => lines.push(line), deps: { exec } });

    await until(() => (app.page!.remote!().hosts.length === 2 ? true : null));
    expect(app.page!.remote!()).toEqual({ hosts: ['pc.tail1.ts.net', 'extra.example.net'], logins: ['a@example.com', 'alex@example.com'] });
    expect(lines).toContain('web page: served as https://pc.tail1.ts.net to the Tailscale login alex@example.com through tailscale serve');
    await app.close();

    writeSettings({ sessions: { installHooks: false }, web: { remoteHosts: ['extra.example.net'] } });

    const unset: string[] = [];
    const plain = await createHubApp({ home: temp.home, log: (line) => unset.push(line), deps: { exec: noCli } });

    closers.push(() => plain.close());
    expect(plain.page!.remote!()).toEqual({ hosts: ['extra.example.net'], logins: [] });
    expect(unset).toContain('web page: web.remoteHosts is set but web.remoteLogins is empty, so no remote device is let in');
  });

  it('reads the remote hosts, logins and web.tailscale again when settings.json changes, and has the server end the remote pages they no longer allow (PRD R115)', async () => {
    writeSettings({ sessions: { installHooks: false } });

    const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.tail1.ts.net.', UserID: 7 }, User: { '7': { LoginName: 'alex@example.com' } } });
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
    expect(lines).toContain('web page: served as https://pc.tail1.ts.net to the Tailscale login alex@example.com through tailscale serve');

    // A change of the lists with web.tailscale still on keeps Tailscale's name and owner while it asks again.
    writeSettings({ sessions: { installHooks: false }, web: { remoteLogins: ['a@example.com'], tailscale: true } });
    await until(() => (asked === 2 ? true : null));
    expect(app.page!.remote!()).toEqual({ hosts: ['pc.tail1.ts.net'], logins: ['a@example.com', 'alex@example.com'] });

    // A change elsewhere in the file reads nothing again.
    const before = changed;

    writeSettings({ sessions: { installHooks: false, concurrency: 3 }, web: { remoteLogins: ['a@example.com'], tailscale: true } });
    await new Promise((done) => setTimeout(done, 500));
    expect(changed).toBe(before);
    expect(asked).toBe(2);

    writeSettings({ sessions: { installHooks: false } });
    await until(() => (app.page!.remote!().hosts.length === 0 ? true : null));
    expect(app.page!.remote!()).toEqual({ hosts: [], logins: [] });
    expect(lines).toContain('web page: not served to other devices');
    expect(changed).toBeGreaterThan(before);
  });

  it('gives a page, and only a page, a pairing token for the Chrome extension while the Chrome pane is on (PRD R113)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const off = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
    const offPage = off.page!.opened();

    expect(await off.post['/v1/conversation/pane-pair']!({ window: offPage })).toEqual({ status: 409, body: { error: 'The Chrome pane is off. Turn on Chrome pane in the dock’s Settings, General page.' } });
    await off.close();

    writeSettings({ sessions: { installHooks: false }, web: { chromePane: true } });
    let helperStarts = 0;
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli }, startPaneHelper: async () => (helperStarts++, { error: 'not in tests' }) });
    closers.push(() => app.close());
    const page = app.page!.opened();
    const paired = await app.post['/v1/conversation/pane-pair']!({ window: page });

    expect(paired).toMatchObject({ status: 200, body: { extensionId: PANE_EXTENSION_ID, token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) } });
    expect(await app.post['/v1/conversation/pane-pair']!({ window: 'nobody' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(await app.post['/v1/conversation/pane-pair']!({})).toEqual({ status: 400, body: { error: 'Expected {window}.' } });

    // The page's column drives the pane; the dock takes no part in it.
    const dock: Array<[string, unknown]> = [];

    app.attachDock!((event, data) => (dock.push([event, data]), 1));
    expect(await app.post['/v1/conversation/pane-rect']!({ window: page, rect: { left: 1300, top: 40, width: 600, height: 900, dpr: 1, innerWidth: 1900, innerHeight: 1000 } })).toEqual({ status: 200, body: { done: true } });
    expect(await app.post['/v1/conversation/pane-rect']!({ window: 'nobody', rect: null })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(await app.post['/v1/conversation/pane-rect']!({ window: page, rect: 'wide' })).toEqual({ status: 400, body: { error: 'Expected {window, rect}.' } });
    expect(app.post['/dock/pane']).toBeUndefined();
    expect(dock.filter(([event]) => event === 'pane')).toEqual([]);
    // No extension is paired, so no page needs the helper and none starts.
    expect(helperStarts).toBe(0);
  });

  it("takes a web link for the Chrome pane only from a page with a selected work item, an http or https URL, and a paired extension (architecture.md § Pane state)", async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, web: { chromePane: true } });
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli }, startPaneHelper: async () => ({ error: 'not in tests' }) });

    closers.push(() => app.close());

    const page = app.page!.opened();
    const open = (body: unknown) => app.post['/v1/conversation/pane-open']!(body);

    expect(await open({ window: page, url: 'https://example.com/' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(await open({ window: 'nobody', url: 'https://example.com/' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });

    for (const url of ['javascript:alert(1)', 'file:///C:/x', 'https://', `https://a.test/${'x'.repeat(2048)}`, 3]) {
      expect(await open({ window: page, url })).toEqual({ status: 400, body: { error: 'Expected {window, url} with an http or https URL.' } });
    }

    app.runtime.send({ type: 'adhoc', prompt: 'Fix the badge', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();
    expect(await app.post['/v1/conversation/select']!({ window: page, opId: 'o1', workItemId: 1 })).toMatchObject({ status: 200 });
    // No extension is paired, so the page opens the link itself.
    expect(await open({ window: page, url: 'https://example.com/' })).toEqual({ status: 409, body: { error: 'The Chrome pane is not connected.' } });
  });

  it('refuses Continue in Background with a bad body, and answers the roster’s refusal (PRD R89)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const roster: Exec = async (file, args) =>
      file === 'claude' && args.join(' ') === 'agents --json --all'
        ? { code: 0, stdout: JSON.stringify([{ sessionId: 'n', kind: 'background', state: 'done', cwd: 'D:/git/widgets', name: 'My tab' }]), stderr: '', missing: false, timedOut: false }
        : noCli(file, args, { timeoutMs: 0 });
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: roster } });
    closers.push(() => app.close());

    expect(await app.post['/background']!({ label: 'My tab', workItemIds: [1] })).toEqual({ status: 400, body: { error: 'Expected {label, hostPid, workItemIds}.' } });
    expect(await app.post['/background']!({ label: '', hostPid: 1, workItemIds: [1] })).toEqual({ status: 400, body: { error: 'Expected {label, hostPid, workItemIds}.' } });
    expect(await app.post['/background']!({ label: 'My tab', hostPid: 1, workItemIds: ['1'] })).toEqual({ status: 400, body: { error: 'Expected {label, hostPid, workItemIds}.' } });
    expect(await app.post['/background']!({ label: 'My tab', hostPid: 1, workItemIds: [1] })).toEqual({ status: 409, body: { error: "This session is not one of Switchboard's work items." } });
    expect(await app.post['/background']!({ label: 'Other tab', hostPid: 1, workItemIds: [1] })).toEqual({ status: 409, body: { error: "This session is not one of Switchboard's work items." } });
    // A null label is the Claude sidebar.
    expect(await app.post['/background']!({ label: null, hostPid: 1, workItemIds: [1] })).toEqual({ status: 409, body: { error: "This session is not one of Switchboard's work items." } });
    expect(await app.post['/background']!({ label: 7, hostPid: 1, workItemIds: [1] })).toEqual({ status: 400, body: { error: 'Expected {label, hostPid, workItemIds}.' } });
    // No move waits for this process.
    expect(await app.post['/background/check']!({ hostPid: 1, pid: 7 })).toEqual({ status: 409, body: { error: 'The move is no longer waiting for the window to close.' } });
    expect(await app.post['/background/check']!({ hostPid: 1 })).toEqual({ status: 400, body: { error: 'Expected {hostPid, pid}.' } });
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
    await app.post['/sources']!({ name: 'github', enabled: true });
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
    let changes = 0;
    app.onChange(() => changes++);

    writeSettings({ sessions: { installHooks: false }, playbooks: { 'dev:develop': { description: 'Build it', template: 'Build.' } } });

    await until(() => ((app.snapshot() as { playbooks: unknown[] }).playbooks.length === 1 ? true : null));

    writeSettings('{ broken');
    await until(() => ((app.snapshot() as { errors: { settings: string | null } }).errors.settings?.startsWith('settings.json is not valid JSON') ? true : null));
    expect(changes).toBeGreaterThan(0);
  });

  it('polls the sources that are on at POST /poll, and refuses when none is', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { github: { repoRoot: '' } } });
    let polls = 0;
    const makeSource = () => ({ source: { name: 'github', poll: async () => (polls++, { tickets: [] }), keyOfBranch: () => null, context: async () => ({ context: '' }) } });
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli, makeSource } });
    closers.push(() => app.close());

    expect(await app.post['/poll']!({})).toEqual({ status: 409, body: { error: 'No source is polled. Turn one on in the header.' } });
    expect(await app.post['/sources']!({ name: 'github', enabled: true })).toEqual({ status: 200, body: { done: true } });
    // A refresh while a read is in flight does not read again, so the first read finishes first.
    await new Promise((done) => setImmediate(done));
    expect(polls).toBe(1);

    expect(await app.post['/poll']!({})).toEqual({ status: 200, body: { done: true } });
    expect(polls).toBe(2);
  });

  it('turns a source on and off in the store, leaving settings.json alone, and refuses an unknown source', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support', orgId: '1' }, adhoc: { repoRoot: 'D:/scratch' } } });
    const text = readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8');
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
    const states = () => (app.snapshot() as { sourceStates: unknown }).sourceStates;
    const enabled = async () => ((await app.post['/config/read']!({})).body as { enabled: Record<string, boolean> }).enabled;

    expect(states()).toEqual([{ name: 'zoho', kind: 'zoho', enabled: false }]);
    expect(await enabled()).toEqual({ zoho: false, adhoc: false });
    expect(await app.post['/sources']!({ name: 'zoho', kind: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect(states()).toEqual([{ name: 'zoho', kind: 'zoho', enabled: true }]);
    expect(await enabled()).toEqual({ zoho: true, adhoc: false });
    expect(readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8')).toBe(text);

    expect(await app.post['/sources']!({ name: 'forum', kind: 'forum', enabled: true })).toEqual({ status: 409, body: { error: 'settings.json has no source named forum.' } });
    expect(await app.post['/sources']!({ name: 'zoho', enabled: 'yes' })).toEqual({ status: 400, body: { error: 'Expected {name, enabled}.' } });
    app.close();

    // The state is kept in the store, so a new hub starts the source again.
    const again = await start();

    expect((again.snapshot() as { sourceStates: unknown }).sourceStates).toEqual([{ name: 'zoho', kind: 'zoho', enabled: true }]);
  });

  it('tells an open Settings window to read again after a toggle, and not after a refused one', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support' } } });
    const app = await start();
    const sent: string[] = [];

    app.attachDock!((event) => {
      sent.push(event);
      return 1;
    });
    expect(await app.post['/sources']!({ name: 'forum', kind: 'forum', enabled: true })).toMatchObject({ status: 409 });
    expect(sent).not.toContain('config');
    expect(await app.post['/sources']!({ name: 'zoho', kind: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect(sent).toContain('config');
  });

  it('checks an enabled source\'s own keys only while it is on, and refuses an enabled key in settings.json', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support' } } });
    const app = await start();
    const check = async (settings: unknown) => ((await app.post['/config/check']!({ settings })).body as { errors: string[] }).errors;

    expect(await check({ sources: { zoho: { repoRoot: 'D:/support' } } })).toEqual([]);
    expect(await app.post['/sources']!({ name: 'zoho', kind: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect(await check({ sources: { zoho: { repoRoot: 'D:/support' } } })).toEqual([expect.stringMatching(/^sources\.zoho\./)]);
    expect(await check({ sources: { zoho: { enabled: true } } })).toEqual(["sources.zoho.enabled is not a setting; turn a source on and off in the dock's header."]);
  });

  it('reads, reloads and writes settings and playbooks in a configDir outside the Switchboard home', async () => {
    const configDir = join(temp.home, 'repo', 'switchboard');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support', orgId: '1' } } }));
    writeSettings({ sessions: { installHooks: false } });
    const app = await createHubApp({ home: temp.home, configDir, log: () => {}, deps: { exec: noCli } });
    closers.push(() => app.close());

    expect((app.snapshot() as { sourceStates: unknown }).sourceStates).toEqual([{ name: 'zoho', kind: 'zoho', enabled: false }]);
    expect((app.snapshot() as { configDir: string }).configDir).toBe(configDir);

    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support', orgId: '1' } }, playbooks: { 'dev:develop': { description: 'Build it', template: 'Build.' } } }),
    );
    await until(() => ((app.snapshot() as { playbooks: unknown[] }).playbooks.length === 1 ? true : null));

    expect(await app.post['/sources']!({ name: 'zoho', kind: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect((app.snapshot() as { sourceStates: unknown }).sourceStates).toEqual([{ name: 'zoho', kind: 'zoho', enabled: true }]);
    expect(JSON.parse(readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8'))).toEqual({ sessions: { installHooks: false } });
  });

  it('lists the URLs of tickets snoozed now, leaving out woken, unsnoozed and URL-less tickets (PRD R56)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const store = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));
    const ticket = (sourceKey: string, url: string, snoozed: boolean, snoozedUntil: number | null) =>
      store.insertTicket({ source: 'github', sourceKey, ref: `#${sourceKey}`, repo: '', sourceId: null, title: 't', url, assigned: true, pool: false, snoozed, snoozedUntil, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });

    ticket('1', 'https://github.com/o/r/issues/1', true, null);
    ticket('2', 'https://github.com/o/r/issues/2', true, 2000);
    ticket('3', 'https://github.com/o/r/issues/3', true, 1000);
    ticket('4', 'https://github.com/o/r/issues/4', false, null);
    ticket('5', '', true, null);
    store.close();

    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli, now: () => 1000 } });
    closers.push(() => app.close());

    expect(app.snoozedUrls()).toEqual(['https://github.com/o/r/issues/1', 'https://github.com/o/r/issues/2']);
  });

  it('snoozes and unsnoozes an assigned or pool ticket by URL, ignoring case, and finds no ticket out of scope (PRD R66)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const store = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));
    const ticket = (sourceKey: string, assigned: boolean, pool: boolean) =>
      store.insertTicket({ source: 'github', sourceKey, ref: `#${sourceKey}`, repo: '', sourceId: null, title: 't', url: `https://github.com/O/r/issues/${sourceKey}`, assigned, pool, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });

    ticket('1', true, false);
    ticket('2', false, true);
    ticket('3', false, false);
    store.close();

    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli, now: () => 1000 } });
    closers.push(() => app.close());

    expect(app.snoozeUrl('https://github.com/o/r/issues/1', 5000)).toEqual({ refused: null });
    expect(app.snoozeUrl('https://github.com/O/r/issues/2', null)).toEqual({ refused: null });
    expect(app.snoozeUrl('https://github.com/O/r/issues/3', null)).toBeNull();
    expect(app.snoozeUrl('https://github.com/O/r/issues/1', 1000)).toEqual({ refused: 'The snooze time has passed.' });
    expect(app.snoozedUrls()).toEqual(['https://github.com/O/r/issues/1', 'https://github.com/O/r/issues/2']);

    expect(app.unsnoozeUrl('https://github.com/o/r/issues/1')).toEqual({ refused: null });
    expect(app.unsnoozeUrl('https://github.com/O/r/issues/3')).toBeNull();
    expect(app.snoozedUrls()).toEqual(['https://github.com/O/r/issues/2']);
  });

  it('returns a ticket\'s history to a window the dock sent it to, or that it is unchanged since a revision, and refuses another window with 403, an unknown ticket with 409 and a missing ticketId with 400 (PRD R59)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const store = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));

    store.insertTicket({ source: 'github', sourceKey: '7', ref: '#7', repo: '', sourceId: null, title: 'Seven', url: '', assigned: false, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
    store.close();

    const app = await start();
    const window = app.windowOpened!(null);
    const other = app.windowOpened!(join(temp.home, 'other.code-workspace'));

    // A window reads only its own work item's History, or one whose History command it claimed (architecture.md § Window scope).
    expect(await app.post['/history']!({ window, ticketId: 1 })).toEqual({ status: 403, body: { error: 'Not in this window.' } });

    for (const ticketId of [1, 2]) {
      expect(await app.post['/window']!({ workspace: null, command: { type: 'history', ticketId, key: '#7' } })).toMatchObject({ status: 200 });
    }

    expect(await app.post['/claim']!({ folder: '', focused: true, window })).toMatchObject({ body: { commands: [{ type: 'history', ticketId: 1 }, { type: 'history', ticketId: 2 }] } });

    // A claim with no key a window holds leaves History commands for the next claim.
    expect(await app.post['/window']!({ workspace: null, command: { type: 'history', ticketId: 1, key: '#7' } })).toMatchObject({ status: 200 });
    expect(await app.post['/claim']!({ folder: '', focused: true, window: 'stale' })).toMatchObject({ body: { commands: [] } });
    expect(await app.post['/claim']!({ folder: '', focused: true, window })).toMatchObject({ body: { commands: [{ type: 'history', ticketId: 1 }] } });

    // Another folder window that claimed nothing gets nothing.
    const bystander = app.windowOpened!(null);

    expect(await app.post['/history']!({ window: bystander, ticketId: 1 })).toEqual({ status: 403, body: { error: 'Not in this window.' } });

    const reply = await app.post['/history']!({ window, ticketId: 1 });

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ ticket: { id: 1, sourceKey: '7', title: 'Seven' }, workItems: [], poolTriages: [], events: [], revision: '0' });
    expect(await app.post['/history']!({ window, ticketId: 1, revision: '0' })).toEqual({ status: 200, body: { unchanged: true } });
    expect(await app.post['/history']!({ window: other, ticketId: 1 })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(await app.post['/history']!({ window: 'forged', ticketId: 1 })).toEqual({ status: 403, body: { error: 'Not in this window.' } });

    // A snooze is logged, so the revision a reader shows is stale and it gets the full history again.
    expect(await app.post['/action']!({ type: 'snooze', ticketId: 1, until: null })).toMatchObject({ status: 200 });

    const after = await app.post['/history']!({ window, ticketId: 1, revision: '0' });

    expect(after.body).toMatchObject({ events: [{ type: 'snooze', actor: 'operator', ticketId: 1 }] });
    expect(after.body).not.toHaveProperty('unchanged');
    expect(await app.post['/history']!({ window, ticketId: 2 })).toEqual({ status: 409, body: { error: 'Unknown ticket 2.' } });
    expect(await app.post['/history']!({ window, ticketId: 2, revision: '0' })).toEqual({ status: 409, body: { error: 'Unknown ticket 2.' } });
    expect(await app.post['/history']!({ window, ticketId: '1' })).toEqual({ status: 400, body: { error: 'Expected {window, ticketId, revision?}.' } });
    expect(await app.post['/history']!({ ticketId: 1 })).toEqual({ status: 400, body: { error: 'Expected {window, ticketId, revision?}.' } });
    expect(await app.post['/history']!(null)).toEqual({ status: 400, body: { error: 'Expected {window, ticketId, revision?}.' } });
  });

  it('leaves a History command a claim with no window key cannot take queued as it was, so the dock can withdraw it, it expires on time and it goes to its own window (PRD R71)', async () => {
    writeSettings({ sessions: { installHooks: false } });

    let now = Date.UTC(2026, 9, 3, 12);
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli, now: () => now } });
    closers.push(() => app.close());

    const leave = async (workspace: string | null) => {
      const reply = await app.post['/window']!({ workspace, command: { type: 'history', ticketId: 1, key: '#7' } });

      expect(reply).toMatchObject({ status: 200 });
      return (reply.body as { id: number }).id;
    };
    const elsewhere = join(temp.home, 'elsewhere.code-workspace');
    const other = join(temp.home, 'other.code-workspace');

    // The dock withdraws the command by the ID it was given after a claim with no key passed it over.
    const id = await leave(null);

    expect(await app.post['/claim']!({ folder: '', focused: true, window: 'stale' })).toMatchObject({ body: { commands: [] } });
    expect(await app.post['/window/withdraw']!({ id })).toEqual({ status: 200, body: { withdrawn: true } });
    expect(await app.post['/claim']!({ folder: '', focused: true, window: app.windowOpened!(null) })).toMatchObject({ body: { commands: [] } });

    // The command expires two minutes after the dock left it, not after the claim that passed it over.
    await leave(null);
    now += 2 * 60_000 - 1;
    expect(await app.post['/claim']!({ folder: '', focused: true, window: 'stale' })).toMatchObject({ body: { commands: [] } });
    now += 2;
    expect(await app.post['/claim']!({ folder: '', focused: true, window: app.windowOpened!(null) })).toMatchObject({ body: { commands: [] } });

    // A command left for any focused window still goes to one after an item window with no key passed it over.
    await leave(null);
    expect(await app.post['/claim']!({ folder: '', workspace: elsewhere, focused: true })).toMatchObject({ body: { commands: [] } });
    expect(await app.post['/claim']!({ folder: '', workspace: other, focused: true, window: app.windowOpened!(other) })).toMatchObject({ body: { commands: [{ type: 'history', ticketId: 1 }] } });

    // A command left for one item window does not go to another after a claim with no key passed it over.
    await leave(elsewhere);
    expect(await app.post['/claim']!({ folder: '', workspace: elsewhere, focused: true })).toMatchObject({ body: { commands: [] } });
    expect(await app.post['/claim']!({ folder: '', workspace: other, focused: true, window: app.windowOpened!(other) })).toMatchObject({ body: { commands: [] } });
    expect(await app.post['/claim']!({ folder: '', workspace: elsewhere, focused: true, window: app.windowOpened!(elsewhere) })).toMatchObject({ body: { commands: [{ type: 'history', ticketId: 1 }] } });
  });

  it("answers the row of an Open in Switchboard URL, which the window that got it cannot see, and refuses a URL no row has (PRD R69)", async () => {
    writeSettings({ sessions: { installHooks: false } });
    const store = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));
    const ticket = store.insertTicket({ source: 'adhoc', sourceKey: '7', ref: '#7', repo: '', sourceId: null, title: 'Seven', url: 'https://github.com/o/r/issues/7', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });

    store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: 'blocked', createdAt: 1 } as never);
    store.close();

    const app = await start();

    expect(await app.post['/open-url']!({ url: 'https://github.com/O/r/issues/7/' })).toMatchObject({ status: 200, body: { row: { key: 'item:1', title: 'Seven' } } });
    expect(await app.post['/open-url']!({ url: 'https://github.com/o/r/issues/8' })).toEqual({ status: 404, body: { error: 'Switchboard has no work item for https://github.com/o/r/issues/8' } });
    expect(await app.post['/open-url']!({ url: '' })).toEqual({ status: 400, body: { error: 'Expected {url}.' } });
  });

  it('shows the dock only while a dock stream is connected, and tells it and every page when the config files change', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start();
    const sent: string[] = [];

    expect(await app.post['/dock/show']!({})).toEqual({ status: 409, body: { error: 'The dock is not running.' } });
    app.attachDock!((event) => {
      sent.push(event);
      return 1;
    });
    expect(await app.post['/dock/show']!({})).toEqual({ status: 200, body: { shown: true } });
    expect(sent).toEqual(['show']);

    // A page's Settings reads the file again too, and a window that is not a page is not told.
    const pageFrames: string[] = [];
    const windowFrames: string[] = [];

    app.conversation!(app.page!.opened(false), (frame) => pageFrames.push(frame));
    app.conversation!(app.windowOpened!(null), (frame) => windowFrames.push(frame));
    writeSettings({ sessions: { installHooks: false, concurrency: 3 } });
    await until(() => (sent.includes('config') ? true : null));
    await until(() => (pageFrames.some((frame) => frame.includes('\nevent: config\n')) ? true : null));
    expect(windowFrames.some((frame) => frame.includes('\nevent: config\n'))).toBe(false);
  });

  it('answers the Voice page\'s Enroll my voice with how enrolment stands, refusing a start while voice is off (architecture.md § Voice check and barge-in)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    mkdirSync(join(temp.home, '.switchboard', 'voice'), { recursive: true });
    writeFileSync(join(temp.home, '.switchboard', 'voice', 'voiceprint.json'), JSON.stringify({ at: '2026-11-20T10:00:00.000Z', windows: 20, vector: [1, 0], pitch: null }));
    const app = await start();
    const idle = { state: 'idle', endsAt: null, error: null, enrolledAt: '2026-11-20T10:00:00.000Z' };

    expect(await app.post['/config/voice-enroll']!({ action: 'status' })).toEqual({ status: 200, body: { enrollment: idle } });
    expect(await app.post['/config/voice-enroll']!({ action: 'start' })).toEqual({ status: 409, body: { error: 'Voice is off (voice.enabled).', enrollment: idle } });
    expect(await app.post['/config/voice-enroll']!({ action: 'cancel' })).toEqual({ status: 200, body: { enrollment: idle } });
    expect(await app.post['/config/voice-enroll']!({ action: 'finish' })).toEqual({ status: 400, body: { error: "Expected {action: 'start' | 'cancel' | 'status'}." } });
  });

  it('reads, checks and saves settings.json with its playbooks for the Settings window, refusing a stale version', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start();
    const playbook = { description: 'Build it', reports: ['done'], template: 'Build {{ticket.title}}.' };
    const read = async () => (await app.post['/config/read']!({})).body as { settings: { version: string | null; value: unknown }; permissionModes: string[]; sourceKinds: string[]; inUse: Record<string, number> };
    const file = () => JSON.parse(readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8'));

    const first = await read();

    expect(first.settings.value).toEqual({ sessions: { installHooks: false } });
    expect('playbooks' in first).toBe(false);
    expect(first.sourceKinds).toEqual(['github', 'zoho', 'forum']);
    expect(first.permissionModes).toContain('auto');
    expect(first.inUse).toEqual({});
    expect((first as unknown as { configDir: string }).configDir).toBe(join(temp.home, '.switchboard'));

    expect(await app.post['/config/check']!({ settings: { sessions: { concurrency: 11 } } })).toMatchObject({ status: 200, body: { errors: [expect.stringContaining('sessions.concurrency')] } });
    expect(await app.post['/config/check']!({ settings: { playbooks: { 'dev:develop': { ...playbook, template: '{{nope}}' } } } })).toEqual({
      status: 200,
      body: { errors: ['playbooks.dev:develop: Unknown template variable: nope.'] },
    });
    expect(await app.post['/config/check']!({ settings: { playbooks: { 'dev:develop': playbook } } })).toEqual({ status: 200, body: { errors: [] } });
    expect(await app.post['/config/check']!({ settings: { playbooks: { 'dev:develop': { ...playbook, returnOf: ['dev:develop'] } } } })).toEqual({
      status: 200,
      body: { errors: ['playbooks.dev:develop: returnOf must list other playbook names, not dev:develop.'] },
    });
    expect(await app.post['/config/check']!({})).toEqual({ status: 400, body: { error: 'Expected {settings}.' } });

    const value = { sessions: { installHooks: false, concurrency: 3 }, playbooks: { 'dev:develop': playbook } };

    expect(await app.post['/config/save']!({ value, version: 'stale' })).toEqual({ status: 409, body: { errors: ['settings.json changed on disk after the editor read it. Discard your changes and open Settings again to load it.'] } });
    expect(await app.post['/config/save']!({ value: { ...value, playbooks: { 'dev:develop': { ...playbook, reports: ['nope'] } } }, version: first.settings.version })).toMatchObject({ status: 409 });
    expect(file()).toEqual({ sessions: { installHooks: false } });
    expect(await app.post['/config/save']!({ value, version: first.settings.version })).toEqual({ status: 200, body: { saved: true, version: (await read()).settings.version ?? 'unread' } });
    expect(file()).toEqual(value);
    await until(() => ((app.snapshot() as { playbooks: { name: string }[] }).playbooks.some((entry) => entry.name === 'dev:develop') ? true : null));

    expect(await app.post['/config/save']!({ version: null })).toEqual({ status: 400, body: { error: 'Expected {value, version}.' } });
    expect(await app.post['/config/save']!({ value: {}, version: null, configDir: 'D:/old' })).toEqual({
      status: 409,
      body: { errors: [`The config folder is now ${join(temp.home, '.switchboard')}, not D:/old. Settings reads it again; make your change there.`] },
    });
    expect(app.post['/config/delete']).toBeUndefined();
    // The web page's Settings posts the same routes as page commands.
    expect(app.post['/v1/conversation/page-settings-read']).toBe(app.post['/config/read']);
    expect(app.post['/v1/conversation/page-settings-check']).toBe(app.post['/config/check']);
    expect(app.post['/v1/conversation/page-settings-save']).toBe(app.post['/config/save']);
    expect(app.post['/v1/conversation/page-voice-enroll']).toBe(app.post['/config/voice-enroll']);
    expect(await app.post['/v1/conversation/page-settings-save']!({ window: 'page-1', opId: 'o', value: {}, version: 'stale' })).toMatchObject({ status: 409 });
    // Voice on the computer takes only a page's key.
    expect(await app.post['/v1/conversation/page-voice-computer']!({})).toEqual({ status: 400, body: { error: 'Expected {window}.' } });
    expect(await app.post['/v1/conversation/page-voice-computer']!({ window: 'page-unknown' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
  });

  it('sets voice.expandReplies in settings.json for Expand replies, keeping the rest of the file, and refuses a file it cannot save', async () => {
    writeSettings({ sessions: { installHooks: false }, voice: { voice: 'cedar' } });
    const app = await start();
    const path = join(temp.home, '.switchboard', 'settings.json');
    const file = () => JSON.parse(readFileSync(path, 'utf8'));
    const expand = app.post['/v1/conversation/expand-replies']!;

    expect(await expand({ window: 'page-1', on: true })).toEqual({ status: 200, body: { expandReplies: true } });
    expect(file()).toEqual({ sessions: { installHooks: false }, voice: { voice: 'cedar', expandReplies: true } });
    expect(await expand({ on: false })).toEqual({ status: 200, body: { expandReplies: false } });
    expect(file()).toEqual({ sessions: { installHooks: false }, voice: { voice: 'cedar', expandReplies: false } });

    expect(await expand({ on: 'yes' })).toEqual({ status: 400, body: { error: 'Expected {on}.' } });
    expect(await expand(null)).toEqual({ status: 400, body: { error: 'Expected {on}.' } });

    // A file Settings could not save either is left as it is.
    writeSettings({ sessions: { installHooks: false, concurrency: 11 } });
    expect(await expand({ on: true })).toMatchObject({ status: 409, body: { error: expect.stringContaining('sessions.concurrency') } });
    expect(file()).toEqual({ sessions: { installHooks: false, concurrency: 11 } });
    writeSettings('{ not json');
    expect(await expand({ on: true })).toMatchObject({ status: 409, body: { error: expect.stringContaining('settings.json is not valid JSON') } });
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
    writeSettings({ sessions: { installHooks: false }, voice: [] });
    expect(await expand({ on: true })).toMatchObject({ status: 409, body: { error: expect.stringContaining('voice') } });
    expect(file()).toEqual({ sessions: { installHooks: false }, voice: [] });
    writeSettings('[]');
    expect(await expand({ on: true })).toEqual({ status: 409, body: { error: 'settings.json is not a JSON object. Fix it in Settings.' } });
  });

  it('writes each item window\'s workspace file when it builds the dock view', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const app = await start();

    expect(await app.post['/action']!({ type: 'adhoc', prompt: 'Look around', repoRoot: 'D:/scratch', start: true })).toMatchObject({ status: 200 });
    await until(() => ((app.snapshot() as { workItems: { sessions: unknown[] }[] }).workItems[0]?.sessions.length ? true : null));

    const window = (app.dock() as { groups: { rows: { window: { name: string; file: string; title: string } | null }[] }[] }).groups.flatMap((group) => group.rows).find((row) => row.window !== null)!.window!;

    expect(window.file.startsWith(join(temp.home, '.switchboard', 'windows'))).toBe(true);
    expect(JSON.parse(readFileSync(window.file, 'utf8')).settings['window.title']).toBe(`${window.title}\${separator}\${activeEditorShort}\${separator}sb:${window.name}`);
  });

  it('names the agent CLI on each terminal the dock view carries with dock.openVSCode review (PRD R28, R71)', async () => {
    writeSettings({ sessions: { installHooks: false, claudePath: '/opt/claude/bin/claude' }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, dock: { openVSCode: 'review' } });
    const done = { code: 0, stderr: '', missing: false, timedOut: false };
    // `claude --bg` starts a session the roster lists as running in its background process (mechanics M5).
    const bg: Exec = async (file, args) => {
      if (file === 'node' && args.join(' ') === '--version') {
        return { ...done, stdout: 'v24.0.0\n' };
      }

      if (args[0] === '--bg') {
        return { ...done, stdout: 'backgrounded · 00000001 · name\n' };
      }

      return { ...done, stdout: args[0] === 'agents' ? JSON.stringify([{ id: '00000001', sessionId: '00000001-native', pid: 101, kind: 'background', cwd: 'D:/scratch', state: 'working' }]) : '' };
    };
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: bg } });

    closers.push(() => app.close());

    expect(await app.post['/action']!({ type: 'adhoc', prompt: 'Look around', repoRoot: 'D:/scratch', start: true })).toMatchObject({ status: 200 });
    await until(() => ((app.snapshot() as { workItems: { sessions: { shortId: string | null }[] }[] }).workItems[0]?.sessions[0]?.shortId ? true : null));

    const shown = (app.dock() as { groups: { rows: { open: { type: string; executable?: string; args?: string[] } | null; terminal: { executable?: string } | null }[] }[] }).groups.flatMap((group) => group.rows)[0]!;

    expect(shown.open).toMatchObject({ type: 'terminal', executable: '/opt/claude/bin/claude' });
    expect(shown.open?.args?.[0]).toBe('attach');
    expect(shown.terminal).toMatchObject({ executable: '/opt/claude/bin/claude' });
  });

  it('searches Done rows before the Done list for the dock, and selects one it found (PRD R63)', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const app = await start();

    app.runtime.send({ type: 'adhoc', prompt: 'Rotate the signing key', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();
    const writer = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));
    const old = Date.now() - 90 * 86_400_000;

    writer.updateWorkItem(1, { status: 'done', doneAt: old, doneReason: 'operator' });
    writer.close();
    // Another work item builds a snapshot without the old one.
    app.runtime.send({ type: 'adhoc', prompt: 'Something else', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();

    const found = await app.post['/dock/search']!({ text: 'signing KEY', since: 0 });

    expect(found).toMatchObject({ status: 200, body: { more: false, rows: [{ key: 'item:1', title: 'Rotate the signing key' }] } });
    expect(await app.post['/dock/search']!({ text: 'signing', since: Date.now() - 30 * 86_400_000 })).toEqual({ status: 200, body: { rows: [], more: false } });
    expect(await app.post['/dock/select']!({ rowKey: 'item:1' })).toMatchObject({ status: 200 });
    expect(await app.post['/dock/select']!({ rowKey: 'item:9' })).toEqual({ status: 404, body: { error: 'No work item has that row.' } });

    // The web page's search further back finds the same rows, as the page's rows, for a page key only.
    const page = app.page!.opened();

    expect(await app.post['/v1/conversation/page-search']!({ window: page, text: 'signing KEY', since: 0 })).toMatchObject({ status: 200, body: { more: false, rows: [{ workItemId: 1, title: 'Rotate the signing key', host: null, search: expect.stringContaining('Rotate the signing key') }] } });
    expect((await app.post['/v1/conversation/page-search']!({ window: 'nobody', text: 'signing', since: 0 })).status).toBe(403);
    expect((await app.post['/v1/conversation/page-search']!({ window: page, text: 'signing' })).status).toBe(400);
    // The page's New ad-hoc session creates a work item in a repo root, as the dock's does.
    expect(await app.post['/v1/conversation/page-adhoc']!({ window: page, opId: 'p1', prompt: 'From the page', repoRoot: 'D:/scratch', start: false, provider: 'claude' })).toEqual({ status: 200, body: { done: true } });
    await app.runtime.settled();
    expect((app.snapshot() as { workItems: { ticket: { title: string } }[] }).workItems.map((one) => one.ticket.title)).toContain('From the page');

    for (const body of [{}, { text: 'x' }, { text: 3, since: 0 }, { text: 'x', since: 'now' }, { text: 'x', since: Number.NaN }]) {
      expect(await app.post['/dock/search']!(body)).toEqual({ status: 400, body: { error: 'Expected {text, since}, the search text and the epoch milliseconds to search from.' } });
    }
  });

  it("opens a listed row's link, runs a pool ticket's control and a VS Code control for the page only as each row offers it now (architecture.md § Web page)", async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const opened: string[] = [];
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli }, launch: { openUrl: (url) => opened.push(url), openCode: (target) => opened.push(`code ${target}`) } });

    closers.push(() => app.close());
    app.runtime.send({ type: 'adhoc', prompt: 'Fix the badge', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();

    const ticketId = (app.snapshot() as { workItems: { ticket: { id: number } }[] }).workItems[0]!.ticket.id;
    const writer = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));

    writer.addLink({ ticketId, label: 'PR #5', target: 'https://github.com/o/r/pull/5', reportedAt: 1, mentioned: false });
    writer.close();
    // Another work item builds a snapshot with the link.
    app.runtime.send({ type: 'adhoc', prompt: 'Something else', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();

    const page = app.page!.opened();

    expect(await app.post['/v1/conversation/row-open']!({ window: page, opId: 'o1', workItemId: 1, url: 'https://github.com/o/r/pull/5' })).toEqual({ status: 200, body: { opened: true } });
    expect(opened).toEqual(['https://github.com/o/r/pull/5']);
    expect(await app.post['/v1/conversation/row-open']!({ window: page, opId: 'o2', workItemId: 1, url: 'https://evil.test/' })).toEqual({ status: 409, body: { error: 'The work item no longer links to this.' } });
    expect(await app.post['/v1/conversation/row-open']!({ window: page, opId: 'o3', workItemId: 99, url: 'https://github.com/o/r/pull/5' })).toEqual({ status: 409, body: { error: 'The work item is gone.' } });
    expect(await app.post['/v1/conversation/pool-action']!({ window: page, opId: 'o4', ticketId: 99, label: 'Start' })).toEqual({ status: 409, body: { error: 'The ticket is no longer in the pool.' } });

    // A VS Code control runs on the page's selected work item; an ad-hoc work item with no session has no window to open.
    expect(await app.post['/v1/conversation/select']!({ window: page, opId: 'o5', workItemId: 1 })).toMatchObject({ status: 200 });
    expect(await app.post['/v1/conversation/row-command']!({ window: page, scopeGen: 1, opId: 'o6', workItemId: 1, label: 'Open in VS Code' })).toEqual({ status: 409, body: { error: 'The work item no longer offers this.' } });
    expect(opened).toHaveLength(1);
  });

  it('forwards a click to the dock only while a dock that runs clicks is connected (PRD R65, R69)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start();
    const clicks: unknown[] = [];

    expect(await app.post['/dock/click']!({ rowKey: 'item:7' })).toEqual({ status: 409, body: { error: 'The dock is not running.' } });
    app.attachDockClick!((data) => {
      clicks.push(data);
      return true;
    });
    expect(await app.post['/dock/click']!({ rowKey: 'item:7' })).toEqual({ status: 202, body: { sent: true } });
    expect(clicks).toEqual([{ rowKey: 'item:7' }]);
    expect(await app.post['/dock/click']!({ rowKey: 7 })).toEqual({ status: 400, body: { error: 'Expected {rowKey}.' } });
    expect(clicks).toHaveLength(1);
  });

  it('shows each needs-you message on one surface: the installed page used last, else the dock, sounding there only without the voice (PRD R65)', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const app = await start();
    const dock: Array<[string, unknown]> = [];
    const frames: string[] = [];
    const tick = () => new Promise((done) => setTimeout(done, 50));
    // A new work item, built once, then moved to the operator's turn and built again, so the hub sees it start needing the operator.
    const needing = async (title: string): Promise<number> => {
      app.runtime.send({ type: 'adhoc', prompt: title, repoRoot: 'D:/scratch', start: false });
      await app.runtime.settled();
      await tick();

      const id = (app.snapshot() as { workItems: { id: number; ticket: { title: string } }[] }).workItems.find((one) => one.ticket.title === title)!.id;
      const writer = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));

      writer.updateWorkItem(id, { status: 'awaiting-approval' });
      writer.close();
      app.runtime.send({ type: 'adhoc', prompt: `${title} (rebuild)`, repoRoot: 'D:/scratch', start: false });
      await app.runtime.settled();
      await tick();
      return id;
    };
    const pageNeeds = () => frames.filter((frame) => frame.includes('event: needs\n')).map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as Record<string, unknown>);

    app.attachDock!((event, data) => (dock.push([event, data]), 1));
    // A browser tab is not the installed app, so with alerts.surface auto the dock says it.
    app.conversation!(app.page!.opened(false), (frame) => frames.push(frame));

    const first = await needing('Fix the badge');

    expect(dock.filter(([event]) => event === 'needs')).toEqual([['needs', { items: [{ rowKey: `item:${first}`, message: 'Switchboard: Fix the badge — Review, then approve' }] }]]);
    expect(pageNeeds()).toEqual([]);

    // The installed app that may not show notifications cannot alert either.
    const installed = app.page!.opened(true);

    app.conversation!(installed, (frame) => frames.push(frame));
    await needing('Add a test');
    expect(dock.filter(([event]) => event === 'needs')).toHaveLength(2);
    expect(pageNeeds()).toEqual([]);

    // Once it may, it says it instead, with the sound, since the voice is off.
    expect(await app.post['/v1/conversation/page-focus']!({ window: installed, focused: false, notify: true })).toEqual({ status: 200, body: { focused: false } });
    expect(await app.post['/v1/conversation/page-focus']!({ window: installed, focused: false, notify: 'yes' })).toEqual({ status: 400, body: { error: 'Expected {window, focused, notify?}.' } });

    const second = await needing('Rename the field');

    expect(pageNeeds()).toEqual([expect.objectContaining({ type: 'needs', items: [{ workItemId: second, message: 'Switchboard: Rename the field — Review, then approve' }], sound: true })]);
    expect(dock.filter(([event]) => event === 'needs')).toHaveLength(2);
  });

  it('shows a dock row in the installed page used last, or answers the page at its work item with none open (architecture.md § Dock)', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, dock: { openIn: 'web' } });
    const app = await start();

    app.runtime.send({ type: 'adhoc', prompt: 'Fix the badge', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();

    const id = (app.snapshot() as { workItems: { id: number }[] }).workItems[0]!.id;
    const context = { pageUrl: async () => 'http://127.0.0.1:47616/page/' };
    expect((app.dock() as { openIn?: string }).openIn).toBe('web');
    // A browser tab is not the installed app, so the dock opens the page at the work item.
    app.page!.opened(false);
    expect(await app.post['/dock/page']!({ rowKey: `item:${id}` }, context)).toEqual({ status: 200, body: { url: `http://127.0.0.1:47616/page/#w=${id}` } });

    const older = app.page!.opened(true);
    const newer = app.page!.opened(true);
    const olderFrames: string[] = [];
    const newerFrames: string[] = [];

    app.conversation!(older, (frame) => olderFrames.push(frame));
    app.conversation!(newer, (frame) => newerFrames.push(frame));

    const shown = await app.post['/dock/page']!({ rowKey: `item:${id}` }, context);
    const marker = (shown.body as { marker: string }).marker;
    const showsIn = (frames: string[]) => frames.filter((frame) => frame.includes('event: show\n')).map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as Record<string, unknown>);

    expect(shown).toEqual({ status: 200, body: { marker: expect.stringMatching(/^[0-9a-f]{12}$/) } });
    expect(showsIn(newerFrames)).toEqual([expect.objectContaining({ type: 'show', workItemId: id, marker })]);
    expect(showsIn(olderFrames)).toEqual([]);
    // The installed page that gained focus last takes over.
    expect(await app.post['/v1/conversation/page-focus']!({ window: older, focused: true })).toMatchObject({ status: 200 });
    await app.post['/dock/page']!({ rowKey: `item:${id}` }, context);
    expect(showsIn(olderFrames)).toHaveLength(1);
    expect(showsIn(newerFrames)).toHaveLength(1);

    expect(await app.post['/dock/page']!({ rowKey: 'item:999' }, context)).toEqual({ status: 404, body: { error: 'No work item has that row.' } });
    expect(await app.post['/dock/page']!({ rowKey: 3 }, context)).toEqual({ status: 400, body: { error: 'Expected {rowKey}.' } });
  });

  it('refuses a conversation from a window with no work item or while the flow refuses it, and selects a dock row (architecture.md § Hosted conversations)', async () => {
    writeSettings({ sessions: { installHooks: false, codeMode: true }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const app = await start(() => {});

    // A window with no work item has no conversation to host one.
    expect(await app.post['/v1/conversation/new-conversation']!({ window: app.windowOpened!(join(temp.home, 'w.code-workspace')), scopeGen: 0, opId: 'n0' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });

    app.runtime.send({ type: 'adhoc', prompt: 'Primary', repoRoot: 'D:/scratch', start: true });
    await app.runtime.settled();

    const row = (app.dock() as { groups: { rows: { key: string; window: { file: string } | null }[] }[] }).groups.flatMap((group) => group.rows)[0]!;
    const window = app.windowOpened!(row.window!.file);

    // Code Mode sessions need hooks: the flow's refusal comes back on the command, and nothing is made.
    expect(await app.post['/v1/conversation/new-conversation']!({ window, scopeGen: 1, opId: 'n1' })).toEqual({ status: 409, body: { error: 'Code Mode sessions need sessions.installHooks.' } });
    expect(app.runtime.snapshot().workItems).toHaveLength(1);
    expect(await app.post['/dock/select']!({ rowKey: row.key })).toEqual({ status: 200, body: { selected: true } });
    expect(await app.post['/dock/select']!({})).toEqual({ status: 400, body: { error: 'Expected {rowKey}.' } });
    expect(await app.post['/dock/select']!({ rowKey: 'nope' })).toEqual({ status: 404, body: { error: 'No work item has that row.' } });

    // The dock's New session takes a folder with no window open, and gets the flow's refusal the same way.
    expect(await app.post['/dock/new-conversation']!({ folder: temp.home, opId: 'd1' })).toEqual({ status: 409, body: { error: 'Code Mode sessions need sessions.installHooks.' } });
    expect(await app.post['/dock/new-conversation']!([])).toEqual({ status: 400, body: { error: 'Expected {folder, opId}.' } });
    expect(app.runtime.snapshot().workItems).toHaveLength(1);
  });

  it('shows the dock the voice target\'s mic mark and a voice problem as a note, and answers a row click with why the voice did not move (architecture.md § Voice)', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, voice: { enabled: true } });
    const app = await start(() => {});

    app.runtime.send({ type: 'adhoc', prompt: 'Primary', repoRoot: 'D:/scratch', start: true });
    await app.runtime.settled();

    const rows = () => (app.dock() as { notes: string[]; groups: { rows: { key: string; window: { file: string } | null; voice: { glyph: string; title: string } | null }[] }[] }).groups.flatMap((group) => group.rows);
    const row = rows()[0]!;

    // No session is the voice target, so no row has the mic mark.
    expect(row.voice).toBeNull();
    const key = app.windowOpened!(row.window!.file);

    // No voice build is installed in this home, so the process cannot start: the dock says so, no window does.
    await until(() => ((app.dock() as { notes: string[] }).notes.some((note) => note.startsWith('Voice: The voice process is not installed')) ? true : null));
    // Its session is not a live, observed one, since hooks are off; with its window closed there is none to talk to.
    expect(await app.post['/dock/select']!({ rowKey: row.key })).toEqual({ status: 200, body: { selected: true, voice: 'Voice is not available for this session.' } });
    app.windowClosed!(key);
    expect(await app.post['/dock/select']!({ rowKey: row.key })).toEqual({ status: 200, body: { selected: false, voice: 'Open a window for this session to use voice.' } });

    // The dock reports a session's terminal window in front, or none.
    const sessionId = app.runtime.snapshot().workItems[0]!.sessions[0]!.id;

    expect(await app.post['/dock/focus']!({ sessionId })).toEqual({ status: 200, body: { focus: sessionId } });
    expect(await app.post['/dock/focus']!({ sessionId: null })).toEqual({ status: 200, body: { focus: null } });
    expect(await app.post['/dock/focus']!({ sessionId: 'nope' })).toEqual({ status: 404, body: { error: 'No session has that ID.' } });
    expect(await app.post['/dock/focus']!({ sessionId, at: Date.now() })).toEqual({ status: 200, body: { focus: sessionId } });
    expect(await app.post['/dock/focus']!({ sessionId: '' })).toEqual({ status: 400, body: { error: 'Expected {sessionId, at?}, a session ID or null and the epoch milliseconds of the change.' } });
    expect(await app.post['/dock/focus']!({ sessionId, at: 'now' })).toEqual({ status: 400, body: { error: 'Expected {sessionId, at?}, a session ID or null and the epoch milliseconds of the change.' } });
    expect(await app.post['/dock/focus']!([])).toEqual({ status: 400, body: { error: 'Expected {sessionId, at?}, a session ID or null and the epoch milliseconds of the change.' } });
  });

  it("gives a Code Mode row a Persona menu with the session's persona checked, which pins through /action, and none with voice off (architecture.md § Personas)", async () => {
    const personas = [
      { id: 'nova', name: 'Nova', personality: 'Warm.' },
      { id: 'orion', name: 'Orion' },
    ];

    writeSettings({ sessions: { installHooks: false, codeMode: true }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, voice: { enabled: true, personas } });
    const app = await start(() => {});

    app.runtime.send({ type: 'adhoc', prompt: 'Primary', repoRoot: 'D:/scratch', start: true });
    await app.runtime.settled();

    type Control = { label: string; action: Record<string, unknown>; group?: string; checked?: boolean };
    const menu = () => (app.dock() as { groups: { rows: { controls: Control[] }[] }[] }).groups.flatMap((group) => group.rows)[0]!.controls.filter((control) => control.group === 'Persona');
    const sessionId = app.runtime.snapshot().workItems[0]!.sessions.at(-1)!.id;

    expect(menu().map((control) => [control.label, control.checked])).toEqual([
      ['Nova', true],
      ['Orion', false],
    ]);
    expect(menu()[1]!.action).toEqual({ type: 'persona', sessionId, personaId: 'orion' });

    expect(await app.post['/action']!(menu()[1]!.action)).toEqual({ status: 200, body: { done: true } });
    expect(menu().map((control) => [control.label, control.checked])).toEqual([
      ['Nova', false],
      ['Orion (pinned)', true],
      ['Clear pin', false],
    ]);
    expect(await app.post['/action']!(menu()[2]!.action)).toEqual({ status: 200, body: { done: true } });
    expect(menu().map((control) => control.label)).toEqual(['Nova', 'Orion']);
    expect(await app.post['/action']!({ type: 'persona', sessionId, personaId: 'vega' })).toEqual({ status: 409, body: { error: 'No persona vega in voice.personas.' } });
    expect(await app.post['/action']!({ type: 'persona', sessionId, personaId: 3 })).toEqual({ status: 400, body: { error: 'Unknown action.' } });

    // Personas are part of voice.
    writeSettings({ sessions: { installHooks: false, codeMode: true }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, voice: { enabled: false, personas } });
    await until(() => (menu().length === 0 ? true : null));
    expect(await app.post['/action']!({ type: 'persona', sessionId, personaId: 'orion' })).toEqual({ status: 409, body: { error: 'Voice is off (voice.enabled).' } });
  });

  it('gives a row no Persona menu with an empty roster', async () => {
    writeSettings({ sessions: { installHooks: false, codeMode: true }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, voice: { enabled: true } });
    const app = await start(() => {});

    app.runtime.send({ type: 'adhoc', prompt: 'Primary', repoRoot: 'D:/scratch', start: true });
    await app.runtime.settled();

    const controls = (app.dock() as { groups: { rows: { controls: Array<{ group?: string }> }[] }[] }).groups.flatMap((group) => group.rows)[0]!.controls;

    expect(controls.length).toBeGreaterThan(0);
    expect(controls.some((control) => control.group !== undefined)).toBe(false);
  });

  it('opens a folder-hosted session only in a folder window on that folder, never in an item window that holds the folder (architecture.md § Window scope)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start(() => {});
    const nudged: unknown[] = [];

    app.attachWindows?.((_event, _data, keys) => nudged.push(keys));

    const support = join(temp.home, 'support');

    mkdirSync(support);

    const host = realpathSync.native(support);
    const store = app.runtime['deps'].store as Store;
    const ticket = store.insertTicket({ source: 'adhoc', sourceKey: 'f1', ref: '#f1', sourceId: null, title: 'New session', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: 0, lastPolledAt: null, repoRoot: host, hostWindow: host });
    const workItem = store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: 'running', createdAt: 0 } as never);

    store.insertSession({
      id: 'f-1', workItemId: workItem.id, kind: 'task', provider: 'claude', cwd: host, state: 'idle', stateAt: 0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 0, endedAt: null, released: false, releasing: false,
      question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, nativeSessionId: 'f-native', shortId: 'f-native', codeMode: false, launchId: 'l',
    });

    const itemFile = join(temp.home, 'w.code-workspace');
    const item = app.windowOpened!(itemFile);
    const folder = app.windowOpened!(null, process.platform === 'win32' ? support.toUpperCase() : support);

    // Asked from the item window, the open waits for the folder window, and only its streams hear the nudge.
    expect(await app.post['/open']!({ sessionId: 'f-native', cwd: host, window: item })).toEqual({ status: 200, body: { recorded: true, id: expect.any(Number), workspace: host, here: false } });
    expect(nudged).toEqual([[folder]]);
    expect(await app.post['/claim']!({ folder: host, workspace: itemFile, focused: true, window: item })).toMatchObject({ body: { sessionId: null } });
    expect(await app.post['/claim']!({ folder: host, focused: true, window: folder })).toMatchObject({ body: { sessionId: 'f-native' } });

    // Asked from the folder window, the open is its own, and an item window named as the destination is refused.
    expect(await app.post['/open']!({ sessionId: 'f-native', cwd: host, window: folder })).toEqual({ status: 200, body: { recorded: true, id: expect.any(Number), workspace: host, here: true } });
    expect(await app.post['/open']!({ sessionId: 'f-native', cwd: host, workspace: itemFile })).toEqual({ status: 409, body: { error: 'The session opens only in its own window.' } });
    expect(await app.post['/open']!({ sessionId: 'f-native', cwd: host, workspace: support })).toMatchObject({ status: 200, body: { workspace: host, here: false } });

    // A dock click that did not reach the folder window withdraws its open, so a folder window that connects later opens nothing.
    const left = (await app.post['/open']!({ sessionId: 'f-native', cwd: host, workspace: support })).body as { id: number };

    expect(await app.post['/open/withdraw']!({ id: left.id })).toEqual({ status: 200, body: { withdrawn: true } });
    expect(await app.post['/open/withdraw']!({ id: left.id })).toEqual({ status: 200, body: { withdrawn: false } });
    expect(await app.post['/open/withdraw']!({ id: 'x' })).toEqual({ status: 400, body: { error: 'Expected {id}.' } });
    expect(await app.post['/claim']!({ folder: host, focused: true, window: folder })).toMatchObject({ body: { sessionId: null } });
  });

  it('keeps the session and commands the dock left for a window when another hub replaces this one', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const logs: string[] = [];
    const file = 'C:/h/windows/gh-7.code-workspace';
    const first = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });

    expect(await first.post['/open']!({ sessionId: 'w-native', cwd: 'D:/git/widgets-wt/7-fix', workspace: file })).toMatchObject({ status: 200 });
    expect(await first.post['/window']!({ workspace: file, command: { type: 'openTabs' } })).toMatchObject({ status: 200 });
    first.close();

    const second = await start((line) => logs.push(line));
    const window = second.windowOpened!(file);

    expect(await second.post['/claim']!({ folder: 'D:/git/widgets-wt/7-fix', workspace: file, focused: true, window })).toEqual({ status: 200, body: { sessionId: 'w-native', provider: 'claude', commands: [{ type: 'openTabs' }] } });
    expect(await second.post['/claim']!({ folder: 'D:/git/widgets-wt/7-fix', workspace: file, focused: true, window })).toEqual({ status: 200, body: { sessionId: null, provider: null, commands: [] } });
    expect(logs.filter((line) => /claimed/.test(line))).toEqual([`session w-native claimed by ${file}`, `window commands claimed by ${file}: openTabs`]);

    // An open or command the hub cannot save is refused, so the dock reports it instead of a window waiting for it.
    mkdirSync(join(temp.home, '.switchboard', 'window-queue.json.tmp'));
    expect(await second.post['/open']!({ sessionId: 'x-native', cwd: 'D:/x', workspace: file })).toEqual({ status: 500, body: { error: 'The hub could not save the open; see its log.' } });
    expect(await second.post['/window']!({ workspace: file, command: { type: 'openTabs' } })).toEqual({ status: 500, body: { error: 'The hub could not save the command; see its log.' } });
  });

  it('attaches to a held session through the server, refusing a request without the token, a bad body and an unknown session (PRD R95)', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const logs: string[] = [];
    const connection = {
      welcome: { protocol: 1, build: 'b', pid: 4243 },
      compatible: true,
      spawn: async () => ({ session: 's', pid: 1 }),
      list: async () => [{ session: 'held-1', label: 'l', pid: 9, cwd: 'D:/scratch', startedAt: 0, lastInputAt: null, lastOutputAt: null, exitedAt: null, exitCode: null, clients: 0, memoryBytes: null }],
      kill: async () => 0,
      screen: async () => ({ head: '', text: '' }),
      shutdown: async () => {},
      onClose: () => {},
      close: () => {},
    };

    writeFileSync(join(temp.home, '.switchboard', 'holder.json'), JSON.stringify({ protocol: 1, build: 'b', port: 4100, token: 'holder-token', pid: 4243, startedAt: '2026-11-18T00:00:00.000Z' }));
    const app = await createHubApp({ home: temp.home, log: (line) => logs.push(line), codeModeIdleMs: 60_000, deps: { exec: noCli, holder: { connect: async () => connection, lockHeld: async () => true } } });
    closers.push(() => app.close());
    const server = await listenHub({ identity: { hub: 'switchboard', protocol: 1, version: 't', pid: 1 }, onShutdown: () => {}, post: app.post, snapshot: () => app.snapshot() });
    closers.push(() => server.close());
    const record = { protocol: 1, version: 't', build: 'b', configDir: 'C:/cfg', execPath: '', port: server.port, token: server.token, pid: 1, startedAt: '' };

    app.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/scratch', start: false });
    app.runtime['deps'].store.insertSession({
      id: 'held-1', workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/scratch', state: 'idle', stateAt: 0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 0, endedAt: null, released: false, releasing: false,
      question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, nativeSessionId: 'n', shortId: 'n', codeMode: true, launchId: 'l',
    });

    expect(logs).toContain('Code Mode idle limit: 60000 ms');
    expect(await postToHub({ ...record, token: 'wrong' }, '/attach', { sessionId: 'held-1' }, 5000)).toMatchObject({ status: 401 });
    expect(await postToHub(record, '/attach', { sessionId: '' }, 5000)).toMatchObject({ status: 400, error: 'Expected {sessionId}.' });
    expect(await postToHub(record, '/attach', { sessionId: 'nope' }, 5000)).toMatchObject({ status: 404, error: 'No session nope.' });
    expect(await postToHub(record, '/attach', { sessionId: 'held-1' }, 5000)).toEqual({ status: 200, error: null, body: { port: 4100, token: 'holder-token', session: 'held-1' } });
  });

  it('lists and stops held sessions through the server, refusing a request without the token, a bad body and an unknown ID (PRD R94)', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const kills: string[] = [];
    const entry = { session: 'orphan-1', label: 'switchboard · ad-hoc · adhoc 9 9273f594-1111', pid: 9, cwd: 'D:/scratch', startedAt: 0, lastInputAt: null, lastOutputAt: null, exitedAt: null, exitCode: null, clients: 0, memoryBytes: null };
    const connection = {
      welcome: { protocol: 1, build: 'b', pid: 4243 },
      compatible: true,
      spawn: async () => ({ session: 's', pid: 1 }),
      list: async () => (kills.length === 0 ? [entry] : []),
      kill: async (session: string) => {
        kills.push(session);
        return 0;
      },
      screen: async () => ({ head: '', text: '' }),
      shutdown: async () => {
        lock = false;
      },
      onClose: () => {},
      close: () => {},
    };
    let lock = true;

    writeFileSync(join(temp.home, '.switchboard', 'holder.json'), JSON.stringify({ protocol: 1, build: 'b', port: 4100, token: 'holder-token', pid: 4243, startedAt: '2026-11-18T00:00:00.000Z' }));
    mkdirSync(join(temp.home, '.switchboard', 'holder', 'cccccccccccccccc'), { recursive: true });
    writeFileSync(join(temp.home, '.switchboard', 'holder', 'cccccccccccccccc', 'holder.js'), '');
    writeFileSync(join(temp.home, '.switchboard', 'holder', 'current.json'), JSON.stringify({ build: 'cccccccccccccccc' }));
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli, holder: { connect: async () => (lock ? connection : Promise.reject(new Error('refused'))), lockHeld: async () => lock, killTree: async () => ({ error: 'not in tests' }), launch: () => {} } } });
    closers.push(() => app.close());
    const server = await listenHub({ identity: { hub: 'switchboard', protocol: 1, version: 't', pid: 1 }, onShutdown: () => {}, post: app.post, snapshot: () => app.snapshot() });
    closers.push(() => server.close());
    const record = { protocol: 1, version: 't', build: 'b', configDir: 'C:/cfg', execPath: '', port: server.port, token: server.token, pid: 1, startedAt: '' };

    expect(await postToHub({ ...record, token: 'wrong' }, '/holder/list', {}, 5000)).toMatchObject({ status: 401 });
    expect(await postToHub(record, '/holder/list', {}, 5000)).toEqual({ status: 200, error: null, body: { sessions: [expect.objectContaining({ session: 'orphan-1', key: 'adhoc 9', nativeSessionId: '9273f594-1111', state: 'live', orphan: true })], holder: connection.welcome, installed: 'cccccccccccccccc' } });
    expect(await postToHub({ ...record, token: 'wrong' }, '/holder/stop', { id: 'orphan-1' }, 5000)).toMatchObject({ status: 401 });
    expect(await postToHub(record, '/holder/stop', { id: '' }, 5000)).toMatchObject({ status: 400, error: 'Expected {id}.' });
    expect(await postToHub(record, '/holder/stop', { id: 'nope' }, 5000)).toMatchObject({ status: 404, error: 'No held session nope.' });
    expect(kills).toEqual([]);
    expect(await postToHub(record, '/holder/stop', { id: '9273f594' }, 5000)).toEqual({ status: 200, error: null, body: { stopped: 'orphan-1' } });
    expect(kills).toEqual(['orphan-1']);
    expect(await postToHub(record, '/holder/list', {}, 5000)).toEqual({ status: 200, error: null, body: { sessions: [], holder: connection.welcome, installed: 'cccccccccccccccc' } });
    // The holder's build b is not the installed one, so a restart starts; it ends the holder, whose installed build is incomplete here.
    expect(await postToHub({ ...record, token: 'wrong' }, '/holder/restart', {}, 5000)).toMatchObject({ status: 401 });
    // A confirmation the view no longer asks is refused, so no session is interrupted unnamed.
    expect(await postToHub(record, '/holder/restart', { detail: 'Restarting stops the held session.' }, 5000)).toMatchObject({ status: 409, error: 'The held sessions changed since you were asked. Press Restart and resume again to see them.' });
    expect(lock).toBe(true);
    expect(await postToHub(record, '/holder/restart', {}, 5000)).toEqual({ status: 200, error: null, body: { started: true } });
    expect(await postToHub(record, '/holder/restart', {}, 5000)).toMatchObject({ status: 409 });
    await vi.waitFor(() => expect((app.snapshot() as Snapshot).holder?.restart).toMatchObject({ state: 'done', resumed: 0, error: expect.stringContaining('The terminal holder is not installed') as unknown }));
    expect(lock).toBe(false);
  });

  it('turns a claimed open of a Code Mode session into its attach terminal and runs hub.js with sessions.nodePath in the dock view (PRD R95)', async () => {
    writeSettings({ sessions: { installHooks: false, nodePath: '/opt/node/bin/node' }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, dock: { openTerminal: 'app' } });
    const logs: string[] = [];
    const entry = { session: 'held-1', label: 'l', pid: 9, cwd: 'D:/scratch', startedAt: 0, lastInputAt: null, lastOutputAt: null, exitedAt: null, exitCode: null, clients: 0, memoryBytes: null };
    const connection = {
      welcome: { protocol: 1, build: 'b', pid: 4243 },
      compatible: true,
      spawn: async () => ({ session: 's', pid: 1 }),
      list: async () => [entry],
      kill: async () => 0,
      screen: async () => ({ head: '', text: '' }),
      shutdown: async () => {},
      onClose: () => {},
      close: () => {},
    };

    writeFileSync(join(temp.home, '.switchboard', 'holder.json'), JSON.stringify({ protocol: 1, build: 'b', port: 4100, token: 'holder-token', pid: 4243, startedAt: '2026-11-18T00:00:00.000Z' }));
    const node: Exec = async (file, args, options) => noCli(file === '/opt/node/bin/node' ? 'node' : file, args, options);
    const app = await createHubApp({ home: temp.home, log: (line) => logs.push(line), deps: { exec: node, holder: { connect: async () => connection, lockHeld: async () => true } } });
    closers.push(() => app.close());
    app.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/scratch', start: false });
    app.runtime['deps'].store.insertSession({
      id: 'held-1', workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/scratch', state: 'idle', stateAt: 0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 0, endedAt: null, released: false, releasing: false,
      question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, nativeSessionId: 'n-native', shortId: 'n-native', codeMode: true, launchId: 'l',
    });
    // The session opens only in its own window, whose file the dock's row names.
    const file = (app.dock() as { groups: { rows: { window: { file: string } | null }[] }[] }).groups.flatMap((group) => group.rows)[0]!.window!.file;
    const run = { executable: '/opt/node/bin/node', args: [join(temp.home, '.switchboard', 'hub.js'), 'attach', 'held-1'] };
    const attach = { type: 'terminal', provider: 'claude', sessionId: 'held-1', cwd: 'D:/scratch', shortId: 'n-native', active: false, codeMode: true, ...run };

    // The dock's click names the Switchboard session ID, and a Claude session ID, as History's link would send, finds the same session.
    const window = app.windowOpened!(file);

    for (const sessionId of ['held-1', 'n-native']) {
      expect(await app.post['/open']!({ sessionId, cwd: 'D:/scratch', workspace: file })).toMatchObject({ status: 200 });
      expect(await app.post['/claim']!({ folder: 'D:/scratch', workspace: file, window })).toEqual({ status: 200, body: { sessionId: null, provider: null, commands: [expect.objectContaining(attach)] } });
    }

    expect(logs).toContain(`session held-1 claimed by ${file} as its attach terminal`);
    // Another window's file is no destination for this session, and a window holding no conversation of it gets its own window named.
    expect(await app.post['/open']!({ sessionId: 'held-1', cwd: 'D:/scratch', workspace: 'C:/h/windows/zoho-2.code-workspace' })).toEqual({ status: 409, body: { error: 'The session opens only in its own window.' } });
    expect(await app.post['/open']!({ sessionId: 'held-1', cwd: 'D:/scratch', window: app.windowOpened!('C:/h/windows/zoho-2.code-workspace') })).toEqual({ status: 200, body: { recorded: true, id: expect.any(Number), workspace: file, here: false } });
    expect(await app.post['/claim']!({ folder: 'D:/scratch', window: app.windowOpened!('C:/h/windows/zoho-2.code-workspace') })).toMatchObject({ body: { sessionId: null, commands: [] } });
    expect(await app.post['/claim']!({ folder: 'D:/scratch', window })).toMatchObject({ body: { commands: [expect.objectContaining(attach)] } });

    // A window command the dock left gets the same run.
    expect(await app.post['/window']!({ workspace: file, command: { type: 'terminal', provider: 'claude', sessionId: 'held-1', cwd: 'D:/scratch', name: 'adhoc 1', shortId: 'n-native', active: false, codeMode: true } })).toMatchObject({ status: 200 });
    expect(await app.post['/claim']!({ folder: 'D:/elsewhere', workspace: file })).toMatchObject({ body: { commands: [] } });
    expect(await app.post['/claim']!({ folder: 'D:/elsewhere', workspace: file, window })).toMatchObject({ body: { commands: [expect.objectContaining(run)] } });

    await app.post['/holder/list']!({});
    const view = app.dock() as { groups: { rows: { terminal: Record<string, unknown> | null }[] }[]; held?: { terminal: Record<string, unknown> | null }[] };

    expect(view.groups.flatMap((group) => group.rows)[0]?.terminal).toMatchObject(run);
    expect(view.held?.[0]?.terminal).toMatchObject(run);
  });

  it('turns a claimed open of an ended registered session into its attach terminal, which resumes it in the holder (PRD R81)', async () => {
    writeSettings({ sessions: { installHooks: false, nodePath: '/opt/node/bin/node' }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, dock: { openTerminal: 'app' } });
    const node: Exec = async (file, args, options) => noCli(file === '/opt/node/bin/node' ? 'node' : file, args, options);
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: node } });
    closers.push(() => app.close());
    app.runtime.send({ type: 'adhoc', prompt: 'registered', repoRoot: 'D:/scratch', start: false });
    app.runtime['deps'].store.insertSession({
      id: 'reg-1', workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/scratch', state: 'ended', stateAt: 0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 0, endedAt: 0, released: true, releasing: false,
      question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, nativeSessionId: 'r-native', shortId: 'r-native', codeMode: false, launchId: null, registered: true,
    });
    const file = (app.dock() as { groups: { rows: { window: { file: string } | null }[] }[] }).groups.flatMap((group) => group.rows)[0]!.window!.file;
    const window = app.windowOpened!(file);

    expect(await app.post['/open']!({ sessionId: 'reg-1', cwd: 'D:/scratch', workspace: file })).toMatchObject({ status: 200 });
    expect(await app.post['/claim']!({ folder: 'D:/scratch', workspace: file, window })).toEqual({
      status: 200,
      body: { sessionId: null, provider: null, commands: [expect.objectContaining({ type: 'terminal', sessionId: 'reg-1', codeMode: true, args: [join(temp.home, '.switchboard', 'hub.js'), 'attach', 'reg-1'] })] },
    });
  });

  it('answers posts through the server', async () => {
    writeSettings({ sessions: { installHooks: false, claudePath: '/opt/claude/bin/claude', codexPath: '/opt/codex/bin/codex' } });
    const logs: string[] = [];
    const app = await start((line) => logs.push(line));
    const claims: unknown[] = [];

    app.attachWindows?.((event, data, keys) => claims.push({ event, data, keys }));
    const server = await listenHub({ identity: { hub: 'switchboard', protocol: 1, version: 't', pid: 1 }, onShutdown: () => {}, post: app.post, snapshot: () => app.snapshot() });
    closers.push(() => server.close());
    const record = { protocol: 1, version: 't', build: 'b', configDir: 'C:/cfg', execPath: '', port: server.port, token: server.token, pid: 1, startedAt: '' };

    expect(await postToHub(record, '/action', { type: 'mark-done', workItemId: 1 }, 5000)).toMatchObject({ status: 409, error: 'Unknown work item 1.' });
    expect(await postToHub(record, '/report', { sessionId: 's1', kind: 'nope' }, 5000)).toMatchObject({ status: 400, error: 'Expected {sessionId, kind, stage|path|reason|prompt|label and target}.' });

    // An open names its destination window; one the hub cannot place is refused, and a folder or a workspace a claim names is no destination.
    expect(await postToHub(record, '/open', { sessionId: 'abc-native', cwd: 'D:\\git\\widgets-wt\\7-fix' }, 5000)).toMatchObject({ status: 409, error: 'The session has no window to open it in.' });
    // The nudge goes only to the keys of the destination window's streams, by any spelling of its file.
    const gh7 = app.windowOpened!('c:\\h\\windows\\GH-7.code-workspace');

    app.windowOpened!('C:/h/windows/gh-8.code-workspace');
    expect(await postToHub(record, '/open', { sessionId: 'w-native', cwd: 'D:/git/widgets', workspace: 'C:/h/windows/gh-7.code-workspace' }, 5000)).toMatchObject({ status: 200, body: { recorded: true, workspace: 'C:/h/windows/gh-7.code-workspace', here: false } });
    expect(claims).toEqual([{ event: 'claim', data: { workspace: 'C:/h/windows/gh-7.code-workspace' }, keys: [gh7] }]);
    expect(await postToHub(record, '/claim', { folder: 'd:/git/widgets', workspace: 'C:/h/windows/gh-7.code-workspace' }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [] } });
    expect(await postToHub(record, '/claim', { folder: 'd:/git/widgets', workspace: 'C:/h/windows/gh-7.code-workspace', window: app.windowOpened!('C:/h/windows/gh-8.code-workspace') }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [] } });
    expect(await postToHub(record, '/claim', { folder: 'd:/git/widgets', workspace: null, window: app.windowOpened!('c:\\h\\windows\\GH-7.code-workspace') }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: 'w-native', provider: 'claude', commands: [] } });
    expect(await postToHub(record, '/open', { sessionId: 1 }, 5000)).toMatchObject({ status: 400, error: 'Expected {sessionId, cwd, workspace?, window?}.' });
    expect(await postToHub(record, '/open', { sessionId: 'x', cwd: 'D:/x', workspace: 3 }, 5000)).toMatchObject({ status: 400 });
    expect(await postToHub(record, '/claim', {}, 5000)).toMatchObject({ status: 400, error: 'Expected {folder, workspace?, focused?, window?}.' });
    expect(await postToHub(record, '/claim', { folder: '', focused: 'yes' }, 5000)).toMatchObject({ status: 400 });
    const settings = await postToHub(record, '/window', { workspace: null, command: { type: 'openUrl', url: 'D:/drafts/reply.md' } }, 5000);

    expect(settings).toMatchObject({ status: 200, body: { id: expect.any(Number) } });
    expect(await postToHub(record, '/window/withdraw', { id: (settings!.body as { id: number }).id }, 5000)).toMatchObject({ status: 200, body: { withdrawn: true } });
    expect(await postToHub(record, '/window/withdraw', { id: 'x' }, 5000)).toMatchObject({ status: 400, error: 'Expected {id}.' });
    expect(await postToHub(record, '/window', { workspace: null, command: { type: 'history', ticketId: 3, key: 'gh 3' } }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/window', { workspace: null, command: { type: 'log' } }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/window', { workspace: 'C:/h/w.code-workspace', command: { type: 'changes', path: 'D:/wt', key: 'gh 7', title: 'T' } }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/claim', { folder: '', workspace: null }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [] } });
    // A History command waits for a claim that names a window key, so the window that takes it can read that History.
    expect(await postToHub(record, '/claim', { folder: '', workspace: null, focused: true }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [{ type: 'log' }] } });
    expect(await postToHub(record, '/claim', { folder: '', workspace: null, focused: true, window: app.windowOpened!(null) }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [{ type: 'history', ticketId: 3, key: 'gh 3' }] } });
    expect(await postToHub(record, '/window', { workspace: 'C:/h/w.code-workspace', command: { type: 'openTabs' } }, 5000)).toMatchObject({ status: 200 });
    // Commands left for a window go only to the window its key binds, never to one that only names the workspace.
    expect(await postToHub(record, '/claim', { folder: 'D:/wt', workspace: 'C:/h/w.code-workspace' }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [] } });
    expect(await postToHub(record, '/claim', { folder: 'D:/wt', workspace: 'C:/h/w.code-workspace', window: app.windowOpened!(null) }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [] } });
    expect(await postToHub(record, '/claim', { folder: 'D:/wt', workspace: null, window: app.windowOpened!('C:/h/w.code-workspace') }, 5000)).toEqual({
      status: 200,
      error: null,
      body: { sessionId: null, provider: null, commands: [{ type: 'changes', path: 'D:/wt', key: 'gh 7', title: 'T' }, { type: 'openTabs' }] },
    });
    const bound = app.windowOpened!('C:/h/w.code-workspace');

    for (const [shortId, active] of [['abcd0007', false], [null, true]]) {
      const terminal = { type: 'terminal', sessionId: 'abc-native', cwd: 'D:/wt', name: 'gh 7', shortId, active };

      expect(await postToHub(record, '/window', { workspace: 'C:/h/w.code-workspace', command: terminal }, 5000)).toMatchObject({ status: 200 });
      // The claim adds the agent's CLI from the settings: Claude's for a command that names no provider.
      expect(await postToHub(record, '/claim', { folder: 'D:/wt', workspace: 'C:/h/w.code-workspace', window: bound }, 5000)).toMatchObject({ body: { commands: [{ ...terminal, executable: '/opt/claude/bin/claude' }] } });
    }
    const codexTerminal = { type: 'terminal', provider: 'codex', sessionId: 'thread-1', cwd: 'D:/wt', name: 'gh 7', shortId: null, active: false };
    expect(await postToHub(record, '/window', { workspace: 'C:/h/w.code-workspace', command: codexTerminal }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/claim', { folder: 'D:/wt', workspace: 'C:/h/w.code-workspace', window: bound }, 5000)).toMatchObject({ body: { commands: [{ ...codexTerminal, executable: '/opt/codex/bin/codex' }] } });
    // Only the item window opens its tabs (PRD R72).
    expect(await postToHub(record, '/window', { workspace: null, command: { type: 'openTabs' } }, 5000)).toMatchObject({ status: 400, error: 'Expected {workspace, command} with a changes, terminal, history, log or openUrl command, or openTabs for a workspace.' });
    const terminal = { type: 'terminal', sessionId: 'abc-native', cwd: 'D:/wt', name: 'gh 7', shortId: null, active: false };
    for (const command of [
      { type: 'settings' },
      { type: 'sourceControl', path: 'D:/wt' },
      { type: 'attach', shortId: 'a' },
      { ...terminal, sessionId: '' },
      { ...terminal, cwd: undefined },
      { ...terminal, name: 7 },
      { ...terminal, shortId: '' },
      { ...terminal, shortId: undefined },
      { ...terminal, active: 'yes' },
      { ...terminal, active: undefined },
      { type: 'history', ticketId: 'x', key: 'gh 3' },
      { type: 'changes', path: 'D:/wt', key: '' },
      { type: 'openUrl' },
      null,
    ]) {
      expect(await postToHub(record, '/window', { workspace: null, command }, 5000)).toMatchObject({ status: 400 });
    }
    expect(await postToHub(record, '/window', { workspace: 7, command: { type: 'openUrl', url: 'D:/x.md' } }, 5000)).toMatchObject({ status: 400 });
    expect(await postToHub({ ...record, port: 1 }, '/action', {}, 1000)).toBeNull();
    // The log shows each command left, withdrawn and claimed, and no claim that took nothing.
    expect(logs.filter((line) => line.startsWith('session'))).toEqual([
      'session w-native left for C:/h/windows/gh-7.code-workspace',
      'session w-native claimed by c:\\h\\windows\\GH-7.code-workspace',
    ]);
    expect(logs.filter((line) => line.startsWith('window')).map((line) => line.replace(/\d+/, 'N'))).toEqual([
      'window command N openUrl left for any window',
      'window command N withdrawn',
      'window command N history left for any window',
      'window command N log left for any window',
      'window command N changes left for C:/h/w.code-workspace',
      'window commands claimed by a window with no folder: log',
      'window commands claimed by a window with no folder: history',
      'window command N openTabs left for C:/h/w.code-workspace',
      'window commands claimed by C:/h/w.code-workspace: changes, openTabs',
      'window command N terminal left for C:/h/w.code-workspace',
      'window commands claimed by C:/h/w.code-workspace: terminal',
      'window command N terminal left for C:/h/w.code-workspace',
      'window commands claimed by C:/h/w.code-workspace: terminal',
      'window command N terminal left for C:/h/w.code-workspace',
      'window commands claimed by C:/h/w.code-workspace: terminal',
    ]);
    // A window that is already in front gets no focus change, so each open and command left for a workspace tells that window to claim.
    // Each nudge goes only to its destination window's streams.
    expect(claims.map((claim) => (claim as { data: unknown }).data)).toEqual([{ workspace: 'C:/h/windows/gh-7.code-workspace' }, ...Array.from({ length: 5 }, () => ({ workspace: 'C:/h/w.code-workspace' }))]);
    expect((claims[0] as { keys: string[] }).keys).toEqual([gh7]);
  });
});
