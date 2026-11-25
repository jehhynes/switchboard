import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Exec } from '@switchboard/claude';
import { Store } from '@switchboard/core';
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

/** A page's source icon, which turns a source on or off as the list header posts it. */
const toggleSource = (app: HubApp, body: Record<string, unknown>) => app.post['/v1/conversation/page-source']!({ window: app.page!.opened(false), ...body });

/** The needs-you alerts the hub shows as system notifications; no test shows a real one. */
const systemAlerts = vi.hoisted(() => [] as Array<{ alerts: unknown[]; sound: boolean }>);

vi.mock('../src/systemAlerts.js', () => ({ systemNotifier: () => ({ notify: (alerts: unknown[], sound: boolean) => systemAlerts.push({ alerts: [...alerts], sound }) }) }));

let temp: ReturnType<typeof tempHome>;
let closers: (() => void | Promise<void>)[] = [];

beforeEach(() => {
  temp = tempHome();
  systemAlerts.length = 0;
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
    // Executable, since outside Windows the hub finds only a file it may run.
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
  async function start(log: (line: string) => void = () => {}) {
    const app = await createHubApp({ home: temp.home, log, deps: { exec: noCli } });
    closers.push(() => app.close());

    return app;
  }

  /** Makes a new work item start needing the operator: built once, then moved to the operator's turn and built again; resolves its ID. */
  const needingIn = (app: Awaited<ReturnType<typeof start>>) => async (title: string): Promise<number> => {
    const tick = () => new Promise((done) => setTimeout(done, 50));

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

    expect(logs.filter((line) => line.startsWith('settings.json: '))).toEqual(warnings.map((warning) => `settings.json: ${warning}`));
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

    expect(await app.post['/v1/conversation/page-poll']!({ window: page })).toEqual({ status: 409, body: { error: 'No source is polled. Turn one on in the header.' } });
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

  describe('plugin reloads', () => {
    /** A plugin module of `kind`; `delayMs` holds its import with a top-level await. */
    function writePlugin(name: string, kind: string, delayMs = 0): string {
      const dir = join(temp.home, 'plugins');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${name}.mjs`),
        `await new Promise((done) => setTimeout(done, ${delayMs}));\n` +
          `export default { kind: '${kind}', label: '${kind}', optionsError: (options, name) => (typeof options.userId === 'string' ? null : 'sources.' + name + '.userId must be set.'), ` +
          `create: (name) => ({ source: { name, keyOfBranch: () => null, context: async () => ({ context: '' }), poll: async () => ({ tickets: [] }) } }) };`,
      );

      return `~/plugins/${name}.mjs`;
    }

    const kinds = async (app: Awaited<ReturnType<typeof createHubApp>>) => ((await app.post['/v1/conversation/page-settings-read']!({})).body as { sourceKinds: string[] }).sourceKinds;
    const settingsError = (app: Awaited<ReturnType<typeof createHubApp>>) => (app.snapshot() as { errors: { settings: string | null } }).errors.settings;

    it('accepts settings after a plugin missing at startup has been built', async () => {
      const value = { plugins: ['~/plugins/later.mjs'], sessions: { installHooks: false }, sources: { later: { userId: '1' } } };
      writeSettings(value);
      const app = await start();

      expect(settingsError(app)).toContain('it could not be loaded');
      expect(await kinds(app)).toEqual(['github', 'zoho']);
      writePlugin('later', 'later');
      // Vitest caches missing dynamic imports; Node retries them.
      vi.resetModules();
      expect(await app.post['/v1/conversation/page-settings-check']!({ settings: value })).toMatchObject({ status: 200, body: { errors: [] } });
      const read = (await app.post['/v1/conversation/page-settings-read']!({})).body as { settings: { version: string }; configDir: string };
      expect(await app.post['/v1/conversation/page-settings-save']!({ value, version: read.settings.version, configDir: read.configDir })).toMatchObject({ status: 200, body: { saved: true } });
      await until(async () => (await kinds(app)).includes('later') ? true : null);
      expect(settingsError(app)).toBeNull();
    });

    it('keeps the plugins in force when the reloaded file is rejected (PRD R42)', async () => {
      const forum = writePlugin('forum', 'forum');
      writeSettings({ plugins: [forum], sessions: { installHooks: false }, sources: { forum: { userId: '1' } } });
      const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
      closers.push(() => app.close());

      writeSettings({ plugins: [], sessions: { installHooks: false }, sources: { forum: { userId: '1' }, zoho: { kind: 'github' } } });
      await until(() => settingsError(app));

      expect(settingsError(app)).toContain('sources.zoho: zoho is a source kind');
      expect(await kinds(app)).toEqual(['github', 'zoho', 'forum']);
    });

    it('applies the newest file when a later change arrives while an earlier plugin is still importing', async () => {
      const slow = writePlugin('slow', 'slow', 1500);
      const fast = writePlugin('fast', 'fast');
      writeSettings({ sessions: { installHooks: false } });
      const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
      closers.push(() => app.close());

      writeSettings({ plugins: [slow], sessions: { installHooks: false }, sources: { slow: { userId: '1' } } });
      await new Promise((done) => setTimeout(done, 600));
      writeSettings({ plugins: [fast], sessions: { installHooks: false }, sources: { fast: { userId: '1' } } });
      await until(async () => ((await kinds(app)).includes('fast') ? true : null));
      await new Promise((done) => setTimeout(done, 1500));

      expect(await kinds(app)).toEqual(['github', 'zoho', 'fast']);
      expect((app.snapshot() as { sourceStates: { name: string }[] }).sourceStates.map((source) => source.name)).toEqual(['fast']);
    });

    it('checks a save against the sources that are on once the draft plugin has imported', async () => {
      const slow = writePlugin('slow', 'slow', 800);
      writeSettings({ sessions: { installHooks: false }, sources: { zoho: { orgId: '1' } } });
      const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
      closers.push(() => app.close());
      const version = ((await app.post['/v1/conversation/page-settings-read']!({})).body as { settings: { version: string } }).settings.version;

      const saving = app.post['/v1/conversation/page-settings-save']!({ value: { plugins: [slow], sessions: { installHooks: false }, sources: { zoho: { orgId: '1' } } }, version });
      await new Promise((done) => setTimeout(done, 200));
      expect(await toggleSource(app, { name: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });

      expect(await saving).toMatchObject({ status: 409, body: { errors: [expect.stringMatching(/^sources\.zoho\./)] } });
    });
  });

  it('reads, reloads and writes settings and playbooks in a configDir outside the Switchboard home', async () => {
    const configDir = join(temp.home, 'repo', 'switchboard');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support', orgId: '1' } } }));
    writeSettings({ sessions: { installHooks: false } });
    const app = await createHubApp({ home: temp.home, configDir, log: () => {}, deps: { exec: noCli } });
    closers.push(() => app.close());

    expect((app.snapshot() as { sourceStates: unknown }).sourceStates).toEqual([{ name: 'zoho', kind: 'zoho', label: 'Zoho Desk', enabled: false }]);
    expect((app.snapshot() as { configDir: string }).configDir).toBe(configDir);

    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support', orgId: '1' } }, playbooks: { 'dev:develop': { description: 'Build it', template: 'Build.' } } }),
    );
    await until(() => ((app.snapshot() as { playbooks: unknown[] }).playbooks.length === 1 ? true : null));

    expect(await toggleSource(app, { name: 'zoho', kind: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect((app.snapshot() as { sourceStates: unknown }).sourceStates).toEqual([{ name: 'zoho', kind: 'zoho', label: 'Zoho Desk', enabled: true }]);
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

  it("tells every page's Settings to read again when settings.json changes", async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start();
    const pageFrames: string[] = [];

    app.conversation!(app.page!.opened(false), (frame) => pageFrames.push(frame));
    writeSettings({ sessions: { installHooks: false, concurrency: 3 } });
    await until(() => (pageFrames.some((frame) => frame.includes('\nevent: config\n')) ? true : null));
  });

  it('answers the Voice page\'s Enroll my voice with how enrolment stands, refusing a start while voice is off (architecture.md § Voice check and barge-in)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    mkdirSync(join(temp.home, '.switchboard', 'voice'), { recursive: true });
    writeFileSync(join(temp.home, '.switchboard', 'voice', 'voiceprint.json'), JSON.stringify({ at: '2026-11-20T10:00:00.000Z', windows: 20, vector: [1, 0], pitch: null }));
    const app = await start();
    const idle = { state: 'idle', endsAt: null, error: null, enrolledAt: '2026-11-20T10:00:00.000Z' };

    expect(await app.post['/v1/conversation/page-voice-enroll']!({ action: 'status' })).toEqual({ status: 200, body: { enrollment: idle } });
    expect(await app.post['/v1/conversation/page-voice-enroll']!({ action: 'start' })).toEqual({ status: 409, body: { error: 'Voice is off (voice.enabled).', enrollment: idle } });
    expect(await app.post['/v1/conversation/page-voice-enroll']!({ action: 'cancel' })).toEqual({ status: 200, body: { enrollment: idle } });
    expect(await app.post['/v1/conversation/page-voice-enroll']!({ action: 'finish' })).toEqual({ status: 400, body: { error: "Expected {action: 'start' | 'cancel' | 'status'}." } });
  });

  it("logs a page's Mic on timing in the hub log, with each step from the tap (architecture.md § Dictation)", async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const logs: string[] = [];
    const app = await start((line) => logs.push(line));
    const page = app.page!.opened();

    app.runtime.send({ type: 'adhoc', prompt: 'Fix the badge', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();
    expect(await app.post['/v1/conversation/select']!({ window: page, opId: 'o1', workItemId: 1 })).toMatchObject({ status: 200 });

    expect(await app.post['/v1/conversation/mic-timing']!({ window: page, steps: [{ step: 'hub answered', ms: 40 }, { step: 'voice confirmed', ms: 90 }], outcome: 'listening' })).toEqual({ status: 200, body: { done: true } });
    expect(logs.filter((line) => line.startsWith('voice: mic on tap'))).toEqual(["voice: mic on tap on this computer's page → listening: hub answered at 40 ms, voice confirmed at 90 ms"]);
  });

  it('reads, checks and saves settings.json with its playbooks for the Settings window, refusing a stale version', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start();
    const playbook = { description: 'Build it', reports: ['done'], template: 'Build {{ticket.title}}.' };
    const read = async () => (await app.post['/v1/conversation/page-settings-read']!({})).body as { settings: { version: string | null; value: unknown }; permissionModes: string[]; sourceKinds: string[]; inUse: Record<string, number> };
    const file = () => JSON.parse(readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8'));

    const first = await read();

    expect(first.settings.value).toEqual({ sessions: { installHooks: false } });
    expect('playbooks' in first).toBe(false);
    expect(first.sourceKinds).toEqual(['github', 'zoho']);
    expect((first as unknown as { sourceLabels: unknown }).sourceLabels).toEqual({ github: 'GitHub', zoho: 'Zoho Desk' });
    expect(first.permissionModes).toContain('auto');
    expect(first.inUse).toEqual({});
    expect((first as unknown as { configDir: string }).configDir).toBe(join(temp.home, '.switchboard'));

    expect(await app.post['/v1/conversation/page-settings-check']!({ settings: { sessions: { concurrency: 11 } } })).toMatchObject({ status: 200, body: { errors: [expect.stringContaining('sessions.concurrency')] } });
    expect(await app.post['/v1/conversation/page-settings-check']!({ settings: { playbooks: { 'dev:develop': { ...playbook, template: '{{nope}}' } } } })).toEqual({
      status: 200,
      body: { errors: ['playbooks.dev:develop: Unknown template variable: nope.'], warnings: [] },
    });
    expect(await app.post['/v1/conversation/page-settings-check']!({ settings: { playbooks: { 'dev:develop': playbook } } })).toEqual({ status: 200, body: { errors: [], warnings: [] } });
    expect(await app.post['/v1/conversation/page-settings-check']!({ settings: { playbooks: { 'dev:develop': { ...playbook, returnOf: ['dev:develop'] } } } })).toEqual({
      status: 200,
      body: { errors: ['playbooks.dev:develop: returnOf must list other playbook names, not dev:develop.'], warnings: [] },
    });
    expect(await app.post['/v1/conversation/page-settings-check']!({})).toEqual({ status: 400, body: { error: 'Expected {settings}.' } });

    const value = { sessions: { installHooks: false, concurrency: 3 }, playbooks: { 'dev:develop': playbook } };

    expect(await app.post['/v1/conversation/page-settings-save']!({ value, version: 'stale' })).toEqual({ status: 409, body: { errors: ['settings.json changed on disk after the editor read it. Discard your changes and open Settings again to load it.'] } });
    expect(await app.post['/v1/conversation/page-settings-save']!({ value: { ...value, playbooks: { 'dev:develop': { ...playbook, reports: ['nope'] } } }, version: first.settings.version })).toMatchObject({ status: 409 });
    expect(file()).toEqual({ sessions: { installHooks: false } });
    expect(await app.post['/v1/conversation/page-settings-save']!({ value, version: first.settings.version })).toEqual({ status: 200, body: { saved: true, version: (await read()).settings.version ?? 'unread' } });
    expect(file()).toEqual(value);
    await until(() => ((app.snapshot() as { playbooks: { name: string }[] }).playbooks.some((entry) => entry.name === 'dev:develop') ? true : null));

    expect(await app.post['/v1/conversation/page-settings-save']!({ version: null })).toEqual({ status: 400, body: { error: 'Expected {value, version}.' } });
    expect(await app.post['/v1/conversation/page-settings-save']!({ value: {}, version: null, configDir: 'D:/old' })).toEqual({
      status: 409,
      body: { errors: [`The config folder is now ${join(temp.home, '.switchboard')}, not D:/old. Settings reads it again; make your change there.`] },
    });
    expect(app.post['/config/delete']).toBeUndefined();
    // The Settings routes are page commands only.
    for (const path of ['/config/read', '/config/check', '/config/save', '/config/voice-enroll']) {
      expect(app.post[path]).toBeUndefined();
    }
    expect(await app.post['/v1/conversation/page-settings-save']!({ window: 'page-1', opId: 'o', value: {}, version: 'stale' })).toMatchObject({ status: 409 });
    // Voice on the computer takes only a page's key.
    expect(await app.post['/v1/conversation/page-voice-computer']!({})).toEqual({ status: 400, body: { error: 'Expected {window}.' } });
    expect(await app.post['/v1/conversation/page-voice-computer']!({ window: 'page-unknown' })).toEqual({ status: 403, body: { error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." } });
  });

  it('sets voice.briefReplies in settings.json for Brief replies, keeping the rest of the file but the old voice.expandReplies, and refuses a file it cannot save', async () => {
    writeSettings({ sessions: { installHooks: false }, voice: { voice: 'cedar' } });
    const app = await start();
    const path = join(temp.home, '.switchboard', 'settings.json');
    const file = () => JSON.parse(readFileSync(path, 'utf8'));
    const expand = app.post['/v1/conversation/brief-replies']!;

    expect(await expand({ window: 'page-1', on: true })).toEqual({ status: 200, body: { briefReplies: true } });
    expect(file()).toEqual({ sessions: { installHooks: false }, voice: { voice: 'cedar', briefReplies: true } });
    expect(await expand({ on: false })).toEqual({ status: 200, body: { briefReplies: false } });
    expect(file()).toEqual({ sessions: { installHooks: false }, voice: { voice: 'cedar', briefReplies: false } });
    // A file that still has the key Brief replies replaced loses it.
    writeSettings({ sessions: { installHooks: false }, voice: { voice: 'cedar', expandReplies: true } });
    expect(await expand({ on: true })).toEqual({ status: 200, body: { briefReplies: true } });
    expect(file()).toEqual({ sessions: { installHooks: false }, voice: { voice: 'cedar', briefReplies: true } });
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

  it('searches Done rows before the Done list for the page, for a page key only (PRD R63)', async () => {
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

    // The page's search further back finds the rows the snapshot left out, as the page's rows, for a page key only.
    const page = app.page!.opened();

    expect(await app.post['/v1/conversation/page-search']!({ window: page, text: 'signing KEY', since: 0 })).toMatchObject({ status: 200, body: { more: false, rows: [{ workItemId: 1, title: 'Rotate the signing key', host: null, search: expect.stringContaining('Rotate the signing key') }] } });
    expect((await app.post['/v1/conversation/page-search']!({ window: 'nobody', text: 'signing', since: 0 })).status).toBe(403);
    expect((await app.post['/v1/conversation/page-search']!({ window: page, text: 'signing' })).status).toBe(400);
    expect((await app.post['/v1/conversation/page-search']!({ window: page, text: 'signing', since: Number.NaN })).status).toBe(400);
    expect(await app.post['/v1/conversation/page-search']!({ window: page, text: 'signing', since: Date.now() - 30 * 86_400_000 })).toEqual({ status: 200, body: { rows: [], more: false } });
    // The page's New session form makes a task that waits for Start.
    expect(await app.post['/v1/conversation/page-new-session']!({ window: page, opId: 'p1', folder: temp.home, provider: 'claude', prompt: 'From the page', run: 'wait' })).toMatchObject({ status: 200, body: { run: 'wait' } });
    await app.runtime.settled();
    expect((app.snapshot() as { workItems: { ticket: { title: string } }[] }).workItems.map((one) => one.ticket.title)).toContain('From the page');
  });

  it('creates one standalone session or task from the page and keeps its recent folders, the newest first (PRD R122)', async () => {
    writeSettings({ sessions: { provider: 'codex' }, sources: { adhoc: { repoRoot: temp.home } } });
    const other = join(temp.home, 'other');
    mkdirSync(other, { recursive: true });
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
    closers.push(() => app.close());
    const page = app.page!.opened();
    const first = await app.post['/v1/conversation/page-new-session']!({ window: page, opId: 'one', folder: temp.home, provider: 'codex', model: 'gpt-6.2-sol' });
    expect(first).toMatchObject({ status: 200, body: { workItemId: 1, run: 'now' } });
    expect(await app.post['/v1/conversation/page-new-session']!({ window: page, opId: 'one', folder: temp.home, provider: 'claude' })).toEqual(first);
    expect((await app.post['/v1/conversation/page-new-session']!({ window: page, opId: 'two', folder: temp.home, provider: 'codex', model: null, prompt: 'Find the bug' })).status).toBe(200);
    expect((await app.post['/v1/conversation/page-new-session']!({ window: page, opId: 'three', folder: other, provider: 'codex', prompt: 'Sweep the logs', run: 'queue', model: 'gpt-6.2-sol' })).status).toBe(200);
    expect((await app.post['/v1/conversation/page-new-session']!({ window: page, opId: 'bad', folder: join(temp.home, 'gone'), provider: 'codex' })).status).toBe(400);
    expect((await app.post['/v1/conversation/page-new-session']!({ opId: 'four', folder: temp.home, provider: 'codex' })).status).toBe(403);
    for (const path of ['/dock/new-session', '/dock/folders']) {
      expect(app.post[path]).toBeUndefined();
    }
    const places = (await app.post['/v1/conversation/page-folders']!({ window: page })).body as { recent: string[] };
    expect(places.recent).toEqual([realpathSync.native(other), realpathSync.native(temp.home)]);
    const writer = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));
    expect(writer.workItem(1)).toMatchObject({ interactive: true, model: 'gpt-6.2-sol' });
    expect(writer.workItem(2)).toMatchObject({ interactive: true, taskPrompt: 'Find the bug' });
    expect(writer.workItem(3)).toMatchObject({ interactive: false, model: 'gpt-6.2-sol', taskPrompt: 'Sweep the logs' });
    writer.close();
  });

  it("starts the page's New conversation… as a new session of the work item it shows, keeping the earlier one (architecture.md § Web page)", async () => {
    writeSettings({ sessions: { provider: 'codex' }, sources: { adhoc: { repoRoot: temp.home } } });
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
    closers.push(() => app.close());
    const page = app.page!.opened();

    expect((await app.post['/v1/conversation/page-new-session']!({ window: page, opId: 'one', folder: temp.home, provider: 'codex', prompt: 'Find the bug' })).status).toBe(200);
    await app.runtime.settled();

    const writer = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));
    const first = writer.sessionsFor(1)[0]!;

    writer.updateSession(first.id, { state: 'idle' });

    const scopeGen = (await app.post['/v1/conversation/select']!({ window: page, opId: 's', workItemId: 1 })).body as { scopeGen: number };
    const made = await app.post['/v1/conversation/page-conversation']!({ window: page, scopeGen: scopeGen.scopeGen, opId: 'n', text: 'Start over', provider: 'codex' });

    expect(made).toMatchObject({ status: 200, body: { workItemId: 1 } });
    expect(writer.sessionsFor(1).map((one) => one.id)).toEqual([first.id, (made.body as { sessionId: string }).sessionId]);
    // No new work item: the conversation stays the one the operator had selected.
    expect(writer.workItem(2)).toBeNull();
    writer.close();
  });

  it("opens a listed row's link, runs a pool ticket's control and Open in VS Code for the page only as each row offers it now (architecture.md § Web page)", async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const opened: string[] = [];
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli }, launch: { openUrl: (url) => opened.push(url), openCode: (target) => { opened.push(`code ${target}`); } } });

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

    // Open in VS Code runs on the page's selected work item; an ad-hoc work item with no session has no window to open.
    expect(await app.post['/v1/conversation/select']!({ window: page, opId: 'o5', workItemId: 1 })).toMatchObject({ status: 200 });
    expect(await app.post['/v1/conversation/row-command']!({ window: page, scopeGen: 1, opId: 'o6', workItemId: 1, label: 'Open in VS Code' })).toEqual({ status: 409, body: { error: 'The work item no longer offers this.' } });
    expect(opened).toHaveLength(1);
  });

  it('opens VS Code on the work item for the page with its workspace file written and no command queued, and its report only on the page (architecture.md § Web page)', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const opened: string[] = [];
    let fail: string | null = null;
    let late: string | null = null;
    let held: Promise<void> | null = null;
    const openCode = (target: string): void | Promise<void> => {
      if (fail !== null) throw new Error(fail);
      if (late !== null) return Promise.reject(new Error(late));
      if (held !== null) {
        opened.push(target);
        return held;
      }
      opened.push(target);
    };
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli }, launch: { openUrl: () => { throw new Error('must not open a URL'); }, openCode } });

    closers.push(() => app.close());
    app.runtime.send({ type: 'adhoc', prompt: 'Fix the $5 badge', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();

    const worktree = join(temp.home, 'wt-101');
    const drafts = join(temp.home, 'drafts');
    const report = join(drafts, 'reply.md');

    mkdirSync(worktree, { recursive: true });
    mkdirSync(drafts, { recursive: true });
    writeFileSync(report, '# Reply\n');
    writeFileSync(join(drafts, 'other.md'), 'not the report');

    const ticketId = (app.snapshot() as { workItems: { ticket: { id: number } }[] }).workItems[0]!.ticket.id;
    const writer = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));

    writer.linkWorktree({ ticketId, path: worktree, branch: '101', linkedBy: 'report' });
    writer.updateWorkItem(1, { status: 'awaiting-approval', approvalReport: report });
    writer.close();
    // Another work item builds a snapshot with the worktree and the report.
    app.runtime.send({ type: 'adhoc', prompt: 'Something else', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();

    const page = app.page!.opened();
    const selected = await app.post['/v1/conversation/select']!({ window: page, opId: 's1', workItemId: 1 });
    const scopeGen = (selected.body as { scopeGen: number }).scopeGen;

    expect(await app.post['/v1/conversation/row-command']!({ window: page, scopeGen, opId: 'c1', workItemId: 1, label: 'Open in VS Code' })).toEqual({ status: 200, body: { done: true } });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/[\\/]\.switchboard[\\/]windows[\\/][^\\/]+\.code-workspace$/);

    // The hub writes the file itself; VS Code runs without any Switchboard extension, so nothing waits for a claim.
    const workspace = JSON.parse(readFileSync(opened[0]!, 'utf8')) as { folders: { path: string }[]; settings: Record<string, unknown> };

    expect(workspace.folders).toEqual([{ path: worktree }]);
    // The title ends with the window name, and a $ of the ticket title is the fullwidth ＄, which VS Code does not read as a variable.
    expect(String(workspace.settings['window.title'])).toMatch(/^Fix the ＄5 badge\$\{separator\}.*sb:[^ ]+$/);
    expect(workspace.settings['extensions.ignoreRecommendations']).toBe(true);
    expect(existsSync(join(temp.home, '.switchboard', 'window-queue.json'))).toBe(false);

    // Open report opens on the page: never VS Code, and the local-file route reads that one draft outside the work item's folders, no other.
    expect(await app.post['/v1/conversation/row-command']!({ window: page, scopeGen, opId: 'c2', workItemId: 1, label: 'Open report' })).toEqual({ status: 409, body: { error: 'Open report opens on the page.' } });
    expect(opened).toHaveLength(1);
    expect((await app.page!.localFile!(page, report, false))?.view).toMatchObject({ kind: 'markdown', contents: '# Reply\n' });
    expect(await app.page!.localFile!(page, join(drafts, 'other.md'), false)).toBeNull();
    expect(await app.page!.localFile!(page, drafts, false)).toBeNull();
    // A file that is one of the work item's artifacts says so, once its folder lists it, so the page shows its artifact's tab.
    const plan = join(worktree, '.wip', 'artifacts', 'w1', 'chat', 'plan.md');

    mkdirSync(join(plan, '..'), { recursive: true });
    writeFileSync(plan, '# Plan\n');
    await vi.waitFor(async () => expect((await app.page!.localFile!(page, plan, false))?.view).toMatchObject({ kind: 'markdown', artifact: 'chat/plan.md' }), { timeout: 5_000 });
    expect((await app.page!.localFile!(page, report, false))?.view).not.toHaveProperty('artifact');

    // A draft a session names inside the Switchboard home, which holds the hub's keys, never opens.
    const keys = join(temp.home, '.switchboard', 'hub-keys.md');
    const store = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));

    writeFileSync(keys, 'fake token');
    store.updateWorkItem(1, { approvalReport: keys });
    store.close();
    app.runtime.send({ type: 'adhoc', prompt: 'A third', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();
    expect(await app.page!.localFile!(page, keys, false)).toBeNull();

    // A VS Code that does not start says why.
    fail = 'Code.exe was not found beside code on PATH.';
    expect(await app.post['/v1/conversation/row-command']!({ window: page, scopeGen, opId: 'c3', workItemId: 1, label: 'Open in VS Code' })).toEqual({ status: 409, body: { error: 'VS Code did not start: Code.exe was not found beside code on PATH.' } });

    // Nor does one that is found but fails once it has been started, which answers 409 with the reason, not 200.
    fail = null;
    late = 'spawn C:\\VS Code\\Code.exe EACCES';
    expect(await app.post['/v1/conversation/row-command']!({ window: page, scopeGen, opId: 'c4', workItemId: 1, label: 'Open in VS Code' })).toEqual({ status: 409, body: { error: 'VS Code did not start: spawn C:\\VS Code\\Code.exe EACCES' } });

    // A repeat of an opId while VS Code is still starting waits for the same answer and starts it once, whether it starts or fails.
    late = null;
    for (const [opId, outcome] of [['c5', null], ['c6', 'spawn Code.exe EPERM']] as const) {
      let settle!: (error: Error | null) => void;
      held = new Promise<void>((resolve, reject) => { settle = (error) => (error === null ? resolve() : reject(error)); });
      const before = opened.length;
      const first = app.post['/v1/conversation/row-command']!({ window: page, scopeGen, opId, workItemId: 1, label: 'Open in VS Code' });
      const second = app.post['/v1/conversation/row-command']!({ window: page, scopeGen, opId, workItemId: 1, label: 'Open in VS Code' });
      await until(() => (opened.length > before ? true : null));
      settle(outcome === null ? null : new Error(outcome));
      const answers = await Promise.all([first, second]);
      expect(answers[0]).toEqual(outcome === null ? { status: 200, body: { done: true } } : { status: 409, body: { error: `VS Code did not start: ${outcome}` } });
      expect(answers[1]).toEqual(answers[0]);
      expect(opened.length - before).toBe(1);
      // Once answered, the opId keeps its answer and starts nothing.
      expect(await app.post['/v1/conversation/row-command']!({ window: page, scopeGen, opId, workItemId: 1, label: 'Open in VS Code' })).toEqual(answers[0]);
      expect(opened.length - before).toBe(1);
    }
    held = null;
  });

  it("opens a hosted conversation's Open in VS Code in its host's window, writing the host row's workspace file first, else in its own folder", async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const opened: string[] = [];
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli }, launch: { openUrl: () => {}, openCode: (target) => { opened.push(target); } } });

    closers.push(() => app.close());
    app.runtime.send({ type: 'adhoc', prompt: 'The host', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();

    const worktree = join(temp.home, 'wt-host');
    const aside = join(temp.home, 'aside');

    mkdirSync(worktree, { recursive: true });
    mkdirSync(aside, { recursive: true });

    const writer = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));
    const hostTicket = (app.snapshot() as Snapshot).workItems[0]!.ticket.id;

    writer.linkWorktree({ ticketId: hostTicket, path: worktree, branch: 'host', linkedBy: 'report' });
    writer.close();
    app.runtime.send({ type: 'adhoc', prompt: 'Rebuild', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();

    const hostFile = windowOf((app.snapshot() as Snapshot).workItems.find((one) => one.ticket.id === hostTicket)!, windowsDir(temp.home))!.file!;
    const store = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));
    const hosted = store.insertTicket({ source: 'adhoc', sourceKey: '90', ref: '#90', repo: '', sourceId: null, title: 'Aside', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: aside, hostWindow: hostFile });
    const gone = store.insertTicket({ source: 'adhoc', sourceKey: '91', ref: '#91', repo: '', sourceId: null, title: 'Orphan', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: aside, hostWindow: join(temp.home, 'gone.code-workspace') });
    const hostedItem = store.insertWorkItem({ ticketId: hosted.id, playbook: null, status: 'unstarted', createdAt: 1 } as never);
    const goneItem = store.insertWorkItem({ ticketId: gone.id, playbook: null, status: 'unstarted', createdAt: 2 } as never);

    store.close();
    app.runtime.send({ type: 'adhoc', prompt: 'Rebuild again', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();

    const page = app.page!.opened();
    let tries = 0;
    const run = async (workItemId: number) => {
      const selected = await app.post['/v1/conversation/select']!({ window: page, opId: `s${++tries}`, workItemId });

      return app.post['/v1/conversation/row-command']!({ window: page, scopeGen: (selected.body as { scopeGen: number }).scopeGen, opId: `c${tries}`, workItemId, label: 'Open in VS Code' });
    };

    // A host file that cannot be written refuses, rather than open another window.
    mkdirSync(hostFile, { recursive: true });
    expect((await run(hostedItem.id)).status).toBe(409);
    expect(opened).toEqual([]);
    rmSync(hostFile, { recursive: true });

    // The host's file was never written, since no list view went out; the hosted conversation writes it from the host's row and opens it.
    expect(await run(hostedItem.id)).toEqual({ status: 200, body: { done: true } });
    expect(opened).toEqual([hostFile]);
    expect((JSON.parse(readFileSync(hostFile, 'utf8')) as { folders: unknown }).folders).toEqual([{ path: worktree }]);
    // A host with no row and no file: the conversation's own folder.
    expect(await run(goneItem.id)).toEqual({ status: 200, body: { done: true } });
    expect(opened.at(-1)).toBe(aside);
  });

  it("moves a Ready for review row for the page as a drag does, and refuses a row or a place outside Ready for review (PRD R73)", async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });

    closers.push(() => app.close());

    for (const title of ['First', 'Second', 'Third', 'Unstarted']) {
      app.runtime.send({ type: 'adhoc', prompt: title, repoRoot: 'D:/scratch', start: false });
      await app.runtime.settled();
    }

    const writer = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));

    [1, 2, 3].forEach((id) => writer.updateWorkItem(id, { status: 'awaiting-approval', readyAt: id * 1000 }));
    writer.close();
    // Another work item builds a snapshot with the three ready.
    app.runtime.send({ type: 'adhoc', prompt: 'Rebuild', repoRoot: 'D:/scratch', start: false });
    await app.runtime.settled();

    const page = app.page!.opened();
    const order = () => {
      const reader = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));
      const ids = reader.readyWorkItems().map((item) => item.id);

      reader.close();
      return ids;
    };

    expect(order()).toEqual([1, 2, 3]);
    expect(await app.post['/v1/conversation/row-move']!({ window: page, opId: 'm1', workItemId: 3, after: null })).toEqual({ status: 200, body: { done: true } });
    expect(order()).toEqual([3, 1, 2]);
    expect(await app.post['/v1/conversation/row-move']!({ window: page, opId: 'm2', workItemId: 3, after: 1 })).toEqual({ status: 200, body: { done: true } });
    expect(order()).toEqual([1, 3, 2]);
    expect(await app.post['/v1/conversation/row-move']!({ window: page, opId: 'm3', workItemId: 4, after: null })).toEqual({ status: 409, body: { error: 'The work item is not in Ready for review.' } });
    expect(await app.post['/v1/conversation/row-move']!({ window: page, opId: 'm4', workItemId: 1, after: 4 })).toEqual({ status: 409, body: { error: 'The work item is not in Ready for review.' } });
    expect(await app.post['/v1/conversation/row-move']!({ window: page, opId: 'm5', workItemId: 1, after: 1 })).toEqual({ status: 409, body: { error: 'A work item cannot move after itself.' } });
    expect(order()).toEqual([1, 3, 2]);
  });

  it('shows each needs-you message on one surface: the installed page used last, else a system notification, sounding there only without the voice (PRD R65)', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const app = await start();
    const frames: string[] = [];
    const needing = needingIn(app);
    const pageNeeds = () => frames.filter((frame) => frame.includes('event: needs\n')).map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as Record<string, unknown>);

    // A browser tab is not the installed app, so with alerts.surface auto a system notification says it, opening the page at the work item.
    app.conversation!(app.page!.opened(false), (frame) => frames.push(frame));

    const first = await needing('Fix the badge');

    await until(() => (systemAlerts.length === 1 ? true : null));
    expect(systemAlerts).toEqual([{ alerts: [{ workItemId: first, title: 'Fix the badge', reason: 'Review, then approve', url: `http://127.0.0.1:47616/page/#w=${first}` }], sound: true }]);
    expect(pageNeeds()).toEqual([]);

    // The installed app that may not show notifications cannot alert either.
    const installed = app.page!.opened(true);

    app.conversation!(installed, (frame) => frames.push(frame));
    await needing('Add a test');
    await until(() => (systemAlerts.length === 2 ? true : null));
    expect(pageNeeds()).toEqual([]);

    // Once it may, it says it instead, with the sound, since the voice is off.
    expect(await app.post['/v1/conversation/page-focus']!({ window: installed, focused: false, notify: true })).toEqual({ status: 200, body: { focused: false } });
    expect(await app.post['/v1/conversation/page-focus']!({ window: installed, focused: false, notify: 'yes' })).toEqual({ status: 400, body: { error: 'Expected {window, focused, notify?}.' } });

    const second = await needing('Rename the field');

    expect(pageNeeds()).toEqual([expect.objectContaining({ type: 'needs', items: [{ workItemId: second, message: 'Switchboard: Rename the field — Review, then approve' }], sound: true })]);
    expect(systemAlerts).toHaveLength(2);
  });

  it('shows needs-you messages for the retired alerts.surface dock as for auto, and as system notifications for system even with a page that may notify (PRD R65)', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, alerts: { surface: 'dock' } });
    const dockApp = await start();
    const dockFrames: string[] = [];

    // With no installed page that may notify, a system notification says it.
    const first = await needingIn(dockApp)('Fix the badge');

    await until(() => (systemAlerts.length === 1 ? true : null));
    expect(systemAlerts[0]).toEqual({ alerts: [expect.objectContaining({ workItemId: first, title: 'Fix the badge' })], sound: true });

    // The installed page that may notify says it instead.
    const dockPage = dockApp.page!.opened(true);

    dockApp.conversation!(dockPage, (frame) => dockFrames.push(frame));
    expect(await dockApp.post['/v1/conversation/page-focus']!({ window: dockPage, focused: false, notify: true })).toEqual({ status: 200, body: { focused: false } });

    const shown = await needingIn(dockApp)('Rename the field');

    await until(() => (dockFrames.some((frame) => frame.includes('event: needs\n')) ? true : null));
    expect(dockFrames.find((frame) => frame.includes('event: needs\n'))).toContain(`"workItemId":${shown}`);
    expect(systemAlerts).toHaveLength(1);
    systemAlerts.length = 0;
    closers.pop();
    await dockApp.close();

    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, alerts: { surface: 'system' } });
    const app = await start();
    const frames: string[] = [];
    const installed = app.page!.opened(true);

    app.conversation!(installed, (frame) => frames.push(frame));
    expect(await app.post['/v1/conversation/page-focus']!({ window: installed, focused: false, notify: true })).toEqual({ status: 200, body: { focused: false } });
    // The server's page URL, once attached, is the one a click opens.
    app.attachPageUrl!(async () => 'http://127.0.0.1:5555/page/');

    const second = await needingIn(app)('Add a test');

    await until(() => (systemAlerts.length === 1 ? true : null));
    expect(systemAlerts[0]).toEqual({ alerts: [expect.objectContaining({ workItemId: second, url: `http://127.0.0.1:5555/page/#w=${second}` })], sound: true });
    expect(frames.some((frame) => frame.includes('event: needs\n'))).toBe(false);
  });

  it("passes the flow's refusal of the page's New session on, and makes no folder-hosted conversation", async () => {
    writeSettings({ sessions: { installHooks: false, codeMode: true }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const app = await start(() => {});

    app.runtime.send({ type: 'adhoc', prompt: 'Primary', repoRoot: 'D:/scratch', start: true });
    await app.runtime.settled();

    const page = app.page!.opened();

    expect(await app.post['/v1/conversation/page-new-session']!({ window: page, folder: temp.home, opId: 'd1', provider: 'claude' })).toEqual({ status: 409, body: { error: 'Claude sessions need sessions.installHooks.' } });
    expect(app.runtime.snapshot().workItems).toHaveLength(1);
  });
  it("shows the page no mic mark while no session is the voice target, and a voice problem as a note in the list's header (architecture.md § Voice)", async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, voice: { enabled: true } });
    const app = await start(() => {});

    app.runtime.send({ type: 'adhoc', prompt: 'Primary', repoRoot: 'D:/scratch', start: true });
    await app.runtime.settled();

    const key = app.page!.opened();
    const frames: string[] = [];
    const notes = () =>
      frames
        .filter((frame) => frame.includes('event: list\n') || frame.includes('event: hello\n'))
        .flatMap((frame) => (JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as { header?: { notes: string[] } }).header?.notes ?? []);

    app.conversation!(key, (frame) => frames.push(frame));
    // No session is the voice target, so no row has the mic mark.
    expect((app.page!.list() as Array<{ rows: Array<{ voice: unknown }> }>).flatMap((group) => group.rows).map((row) => row.voice)).toEqual([null]);
    expect(await app.post['/v1/conversation/select']!({ window: key, opId: 's', workItemId: 1 })).toMatchObject({ status: 200 });
    // No voice build is installed in this home, so the process cannot start: the page says so.
    await until(() => (notes().some((note) => note.startsWith('Voice: The voice process is not installed')) ? true : null));
    for (const path of ['/dock/select', '/dock/focus', '/dock/page', '/dock/click', '/dock/search', '/dock/show']) {
      expect(app.post[path]).toBeUndefined();
    }
  });

  it("pins a session's persona and clears the pin, refusing an unknown persona and any while voice is off (architecture.md § Personas)", async () => {
    const personas = [
      { id: 'nova', name: 'Nova', personality: 'Warm.' },
      { id: 'orion', name: 'Orion' },
    ];

    writeSettings({ sessions: { installHooks: false, codeMode: true }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, voice: { enabled: true, personas } });
    const app = await start(() => {});

    app.runtime.send({ type: 'adhoc', prompt: 'Primary', repoRoot: 'D:/scratch', start: true });
    await app.runtime.settled();

    const sessionId = app.runtime.snapshot().workItems[0]!.sessions.at(-1)!.id;
    const persona = () => {
      const session = app.runtime['deps'].store.session(sessionId)!;

      return [session.personaId, session.personaPinned === true];
    };

    expect(persona()).toEqual(['nova', false]);
    expect(app.runtime.send({ type: 'persona', sessionId, personaId: 'orion' }).refused).toBeNull();
    expect(persona()).toEqual(['orion', true]);
    expect(app.runtime.send({ type: 'persona', sessionId, personaId: null }).refused).toBeNull();
    expect(persona()[1]).toBe(false);
    expect(app.runtime.send({ type: 'persona', sessionId, personaId: 'vega' }).refused).toBe('No persona vega in voice.personas.');

    // Personas are part of voice.
    writeSettings({ sessions: { installHooks: false, codeMode: true }, sources: { adhoc: { repoRoot: 'D:/scratch' } }, voice: { enabled: false, personas } });
    await until(() => (app.runtime.send({ type: 'persona', sessionId, personaId: 'orion' }).refused !== null ? true : null));
    expect(app.runtime.send({ type: 'persona', sessionId, personaId: 'orion' }).refused).toBe('Voice is off (voice.enabled).');
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
    const server = await listenHub({ identity: { hub: 'switchboard', protocol: 1, version: 't', pid: 1 }, onShutdown: () => {}, post: app.post });
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
    const server = await listenHub({ identity: { hub: 'switchboard', protocol: 1, version: 't', pid: 1 }, onShutdown: () => {}, post: app.post });
    closers.push(() => server.close());
    const record = { protocol: 1, version: 't', build: 'b', configDir: 'C:/cfg', execPath: '', port: server.port, token: server.token, pid: 1, startedAt: '' };

    expect(await postToHub({ ...record, token: 'wrong' }, '/holder/list', {}, 5000)).toMatchObject({ status: 401 });
    expect(await postToHub(record, '/holder/list', {}, 5000)).toEqual({ status: 200, error: null, body: { held: [expect.objectContaining({ item: 'No work item', session: 'orphan-1', state: 'live', terminal: null, exited: false })], sessions: [expect.objectContaining({ session: 'orphan-1', key: 'adhoc 9', nativeSessionId: '9273f594-1111', state: 'live', orphan: true })], holder: connection.welcome, installed: 'cccccccccccccccc' } });
    expect(await postToHub({ ...record, token: 'wrong' }, '/holder/stop', { id: 'orphan-1' }, 5000)).toMatchObject({ status: 401 });
    expect(await postToHub(record, '/holder/stop', { id: '' }, 5000)).toMatchObject({ status: 400, error: 'Expected {id}.' });
    expect(await postToHub(record, '/holder/stop', { id: 'nope' }, 5000)).toMatchObject({ status: 404, error: 'No held session nope.' });
    expect(await postToHub(record, '/holder/open', {}, 5000)).toMatchObject({ status: 400, error: 'Expected {id}.' });
    expect(await postToHub(record, '/holder/open', { id: 'missing' }, 5000)).toMatchObject({ status: 404, error: 'No held session missing.' });
    expect(await postToHub(record, '/holder/open', { id: 'orphan-1' }, 5000)).toMatchObject({ status: 409, error: 'This held session has no terminal to open.' });
    expect(kills).toEqual([]);
    expect(await postToHub(record, '/holder/stop', { id: '9273f594' }, 5000)).toEqual({ status: 200, error: null, body: { stopped: 'orphan-1' } });
    expect(kills).toEqual(['orphan-1']);
    expect(await postToHub(record, '/holder/list', {}, 5000)).toEqual({ status: 200, error: null, body: { held: [], sessions: [], holder: connection.welcome, installed: 'cccccccccccccccc' } });
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

  it("runs hub.js with sessions.nodePath as a Code Mode session's terminal in the list view, and opens a held session's terminal in the terminal app (PRD R95)", async () => {
    writeSettings({ sessions: { installHooks: false, nodePath: '/opt/node/bin/node' }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
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
    const terminals: unknown[] = [];
    let terminalError: string | null = null;
    const app = await createHubApp({ home: temp.home, log: (line) => logs.push(line), launch: { openCode: () => { throw new Error('must not open VS Code'); }, openUrl: () => { throw new Error('must not open a URL'); }, openTerminal: (terminal) => { if (terminalError !== null) throw new Error(terminalError); terminals.push(terminal); } }, deps: { exec: node, holder: { connect: async () => connection, lockHeld: async () => true } } });
    closers.push(() => app.close());
    app.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/scratch', start: false });
    app.runtime['deps'].store.insertSession({
      id: 'held-1', workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/scratch', state: 'idle', stateAt: 0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 0, endedAt: null, released: false, releasing: false,
      question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, nativeSessionId: 'n-native', shortId: 'n-native', codeMode: true, launchId: 'l',
    });
    const run = { executable: '/opt/node/bin/node', args: [join(temp.home, '.switchboard', 'hub.js'), 'attach', 'held-1'] };

    expect(await app.post['/holder/open']!({ id: 'held-1', cwd: 'D:/forged', args: ['forged'] })).toEqual({ status: 200, body: { opening: true } });
    expect(terminals).toEqual([expect.objectContaining({ sessionId: 'held-1', cwd: 'D:/scratch', codeMode: true, ...run })]);
    terminalError = 'Windows Terminal is unavailable.';
    expect(await app.post['/holder/open']!({ id: 'held-1' })).toEqual({ status: 409, body: { error: 'The terminal did not start: Windows Terminal is unavailable.' } });
    expect(terminals).toHaveLength(1);
  });

  it('answers posts through the server', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start();
    const server = await listenHub({ identity: { hub: 'switchboard', protocol: 1, version: 't', pid: 1 }, onShutdown: () => {}, post: app.post });
    closers.push(() => server.close());
    const record = { protocol: 1, version: 't', build: 'b', configDir: 'C:/cfg', execPath: '', port: server.port, token: server.token, pid: 1, startedAt: '' };

    expect(await postToHub(record, '/report', { sessionId: 's1', kind: 'stage', stage: 'x' }, 5000)).toMatchObject({ status: 409, error: 'Unknown session s1.' });
    expect(await postToHub(record, '/report', { sessionId: 's1', kind: 'nope' }, 5000)).toMatchObject({ status: 400, error: 'Expected {sessionId, kind, stage|path|reason|prompt|label and target}.' });
    expect(await postToHub({ ...record, port: 1 }, '/report', {}, 1000)).toBeNull();
  });
});
