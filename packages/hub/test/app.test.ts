import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Exec } from '@switchboard/claude';
import { Store } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubApp, parseAction, parseReport } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { postToHub } from '../src/client.js';
import { listenHub } from '../src/server.js';
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
    expect(await app.post['/contract']!({ sessionId: 'n' })).toEqual({ status: 400, body: { error: 'Expected {nativeSessionId}.' } });
    expect(app.busy()).toBe(false);
    expect((app.snapshot() as { repoRoots: string[] }).repoRoots).toEqual(['D:/scratch']);
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

    expect(await app.post['/ticket']!({ sessionId, url: 'https://github.com/o/r/issues/1', nativeSessionId: native })).toEqual({ status: 409, body: { error: 'No enabled source has a ticket at https://github.com/o/r/issues/1.' } });
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

  it('returns a ticket\'s history, or that it is unchanged since a revision, and refuses an unknown ticket with 409 and a missing ticketId with 400 (PRD R59)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const store = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));

    store.insertTicket({ source: 'github', sourceKey: '7', ref: '#7', repo: '', sourceId: null, title: 'Seven', url: '', assigned: false, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
    store.close();

    const app = await start();
    const reply = await app.post['/history']!({ ticketId: 1 });

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ ticket: { id: 1, sourceKey: '7', title: 'Seven' }, workItems: [], poolTriages: [], events: [], revision: '0' });
    expect(await app.post['/history']!({ ticketId: 1, revision: '0' })).toEqual({ status: 200, body: { unchanged: true } });

    // A snooze is logged, so the revision a reader shows is stale and it gets the full history again.
    expect(await app.post['/action']!({ type: 'snooze', ticketId: 1, until: null })).toMatchObject({ status: 200 });

    const after = await app.post['/history']!({ ticketId: 1, revision: '0' });

    expect(after.body).toMatchObject({ events: [{ type: 'snooze', actor: 'operator', ticketId: 1 }] });
    expect(after.body).not.toHaveProperty('unchanged');
    expect(await app.post['/history']!({ ticketId: 2 })).toEqual({ status: 409, body: { error: 'Unknown ticket 2.' } });
    expect(await app.post['/history']!({ ticketId: 2, revision: '0' })).toEqual({ status: 409, body: { error: 'Unknown ticket 2.' } });
    expect(await app.post['/history']!({ ticketId: '1' })).toEqual({ status: 400, body: { error: 'Expected {ticketId, revision?}.' } });
    expect(await app.post['/history']!(null)).toEqual({ status: 400, body: { error: 'Expected {ticketId, revision?}.' } });
  });

  it('shows the dock only while a dock stream is connected, and tells it when the config files change', async () => {
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

    writeSettings({ sessions: { installHooks: false, concurrency: 3 } });
    await until(() => (sent.includes('config') ? true : null));
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

    expect(await app.post['/config/save']!({ value, version: 'stale' })).toEqual({ status: 409, body: { errors: ['settings.json changed on disk after the editor read it. Discard to load it.'] } });
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

  it('keeps the session and commands the dock left for a window when another hub replaces this one', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const logs: string[] = [];
    const file = 'C:/h/windows/gh-7.code-workspace';
    const first = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });

    expect(await first.post['/open']!({ sessionId: 'w-native', cwd: 'D:/git/widgets-wt/7-fix', workspace: file })).toMatchObject({ status: 200 });
    expect(await first.post['/window']!({ workspace: file, command: { type: 'openTabs' } })).toMatchObject({ status: 200 });
    first.close();

    const second = await start((line) => logs.push(line));

    expect(await second.post['/claim']!({ folder: 'D:/git/widgets-wt/7-fix', workspace: file, focused: true })).toEqual({ status: 200, body: { sessionId: 'w-native', provider: 'claude', commands: [{ type: 'openTabs' }] } });
    expect(await second.post['/claim']!({ folder: 'D:/git/widgets-wt/7-fix', workspace: file, focused: true })).toEqual({ status: 200, body: { sessionId: null, provider: null, commands: [] } });
    expect(logs.filter((line) => /claimed/.test(line))).toEqual([`session w-native claimed by ${file}`, `window commands claimed by ${file}: openTabs`]);

    // An open or command the hub cannot save is refused, so the dock reports it instead of a window waiting for it.
    mkdirSync(join(temp.home, '.switchboard', 'window-queue.json.tmp'));
    expect(await second.post['/open']!({ sessionId: 'x-native', cwd: 'D:/x', workspace: file })).toEqual({ status: 500, body: { error: 'The hub could not save the open; see its log.' } });
    expect(await second.post['/window']!({ workspace: file, command: { type: 'openTabs' } })).toEqual({ status: 500, body: { error: 'The hub could not save the command; see its log.' } });
  });

  it('answers posts through the server', async () => {
    writeSettings({ sessions: { installHooks: false, claudePath: '/opt/claude/bin/claude', codexPath: '/opt/codex/bin/codex' } });
    const logs: string[] = [];
    const app = await start((line) => logs.push(line));
    const claims: unknown[] = [];

    app.attachWindows?.((event, data) => claims.push({ event, data }));
    const server = await listenHub({ identity: { hub: 'switchboard', protocol: 1, version: 't', pid: 1 }, onShutdown: () => {}, post: app.post, snapshot: () => app.snapshot() });
    closers.push(() => server.close());
    const record = { protocol: 1, version: 't', build: 'b', configDir: 'C:/cfg', execPath: '', port: server.port, token: server.token, pid: 1, startedAt: '' };

    expect(await postToHub(record, '/action', { type: 'mark-done', workItemId: 1 }, 5000)).toMatchObject({ status: 409, error: 'Unknown work item 1.' });
    expect(await postToHub(record, '/report', { sessionId: 's1', kind: 'nope' }, 5000)).toMatchObject({ status: 400, error: 'Expected {sessionId, kind, stage|path|reason|prompt|label and target}.' });

    expect(await postToHub(record, '/open', { sessionId: 'abc-native', cwd: 'D:\\git\\widgets-wt\\7-fix' }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/claim', { folder: 'd:/git/widgets' }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [] } });
    expect(await postToHub(record, '/claim', { folder: 'd:/git/widgets-wt/7-fix/' }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: 'abc-native', provider: 'claude', commands: [] } });
    expect(await postToHub(record, '/claim', { folder: 'd:/git/widgets-wt/7-fix' }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [] } });
    expect(await postToHub(record, '/open', { sessionId: 'w-native', cwd: 'D:/git/widgets', workspace: 'C:/h/windows/gh-7.code-workspace' }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/claim', { folder: 'd:/git/widgets', workspace: null }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [] } });
    expect(await postToHub(record, '/claim', { folder: 'd:/git/widgets', workspace: 'C:/h/windows/gh-7.code-workspace' }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: 'w-native', provider: 'claude', commands: [] } });
    expect(await postToHub(record, '/open', { sessionId: 1 }, 5000)).toMatchObject({ status: 400, error: 'Expected {sessionId, cwd, workspace?}.' });
    expect(await postToHub(record, '/open', { sessionId: 'x', cwd: 'D:/x', workspace: 3 }, 5000)).toMatchObject({ status: 400 });
    expect(await postToHub(record, '/claim', {}, 5000)).toMatchObject({ status: 400, error: 'Expected {folder, workspace?, focused?}.' });
    expect(await postToHub(record, '/claim', { folder: '', focused: 'yes' }, 5000)).toMatchObject({ status: 400 });
    const settings = await postToHub(record, '/window', { workspace: null, command: { type: 'openUrl', url: 'D:/drafts/reply.md' } }, 5000);

    expect(settings).toMatchObject({ status: 200, body: { id: expect.any(Number) } });
    expect(await postToHub(record, '/window/withdraw', { id: (settings!.body as { id: number }).id }, 5000)).toMatchObject({ status: 200, body: { withdrawn: true } });
    expect(await postToHub(record, '/window/withdraw', { id: 'x' }, 5000)).toMatchObject({ status: 400, error: 'Expected {id}.' });
    expect(await postToHub(record, '/window', { workspace: null, command: { type: 'history', ticketId: 3, key: 'gh 3' } }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/window', { workspace: null, command: { type: 'log' } }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/window', { workspace: 'C:/h/w.code-workspace', command: { type: 'changes', path: 'D:/wt', key: 'gh 7', title: 'T' } }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/claim', { folder: '', workspace: null }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [] } });
    expect(await postToHub(record, '/claim', { folder: '', workspace: null, focused: true }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [{ type: 'history', ticketId: 3, key: 'gh 3' }, { type: 'log' }] } });
    expect(await postToHub(record, '/window', { workspace: 'C:/h/w.code-workspace', command: { type: 'openTabs' } }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/claim', { folder: 'D:/wt', workspace: 'C:/h/w.code-workspace' }, 5000)).toEqual({
      status: 200,
      error: null,
      body: { sessionId: null, provider: null, commands: [{ type: 'changes', path: 'D:/wt', key: 'gh 7', title: 'T' }, { type: 'openTabs' }] },
    });
    for (const [shortId, active] of [['abcd0007', false], [null, true]]) {
      const terminal = { type: 'terminal', sessionId: 'abc-native', cwd: 'D:/wt', name: 'gh 7', shortId, active };

      expect(await postToHub(record, '/window', { workspace: 'C:/h/w.code-workspace', command: terminal }, 5000)).toMatchObject({ status: 200 });
      // The claim adds the agent's CLI from the settings: Claude's for a command that names no provider.
      expect(await postToHub(record, '/claim', { folder: 'D:/wt', workspace: 'C:/h/w.code-workspace' }, 5000)).toMatchObject({ body: { commands: [{ ...terminal, executable: '/opt/claude/bin/claude' }] } });
    }
    const codexTerminal = { type: 'terminal', provider: 'codex', sessionId: 'thread-1', cwd: 'D:/wt', name: 'gh 7', shortId: null, active: false };
    expect(await postToHub(record, '/window', { workspace: 'C:/h/w.code-workspace', command: codexTerminal }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/claim', { folder: 'D:/wt', workspace: 'C:/h/w.code-workspace' }, 5000)).toMatchObject({ body: { commands: [{ ...codexTerminal, executable: '/opt/codex/bin/codex' }] } });
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
      'session abc-native left for D:\\git\\widgets-wt\\7-fix',
      'session abc-native claimed by d:/git/widgets-wt/7-fix/',
      'session w-native left for C:/h/windows/gh-7.code-workspace',
      'session w-native claimed by C:/h/windows/gh-7.code-workspace',
    ]);
    expect(logs.filter((line) => line.startsWith('window')).map((line) => line.replace(/\d+/, 'N'))).toEqual([
      'window command N openUrl left for any window',
      'window command N withdrawn',
      'window command N history left for any window',
      'window command N log left for any window',
      'window command N changes left for C:/h/w.code-workspace',
      'window commands claimed by a window with no folder: history, log',
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
    expect(claims).toEqual([
      { event: 'claim', data: { workspace: 'C:/h/windows/gh-7.code-workspace' } },
      ...Array.from({ length: 5 }, () => ({ event: 'claim', data: { workspace: 'C:/h/w.code-workspace' } })),
    ]);
  });
});
