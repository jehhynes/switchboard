import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Exec } from '@switchboard/claude';
import { Store } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubApp, parseAction, parseReport } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { postToHub } from '../src/client.js';
import { listenHub } from '../src/server.js';
import { gitBashRoot, isPastePath, reportBody } from '../src/report.js';
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

const noCli: Exec = async (file, args) => {
  throw new Error(`unexpected call ${file} ${args.join(' ')}`);
};

function writeSettings(settings: unknown): void {
  mkdirSync(join(temp.home, '.switchboard'), { recursive: true });
  writeFileSync(join(temp.home, '.switchboard', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
}

describe('parseReport and reportBody', () => {
  it('reads the report commands', () => {
    expect(reportBody(['stage', 's1', 'Writing', 'tests'])).toEqual({ sessionId: 's1', kind: 'stage', stage: 'Writing tests' });
    expect(reportBody(['worktree', 's1', 'D:/wt/1'])).toEqual({ sessionId: 's1', kind: 'worktree', path: join('D:/wt/1') });
    expect(reportBody(['done', 's1'])).toEqual({ sessionId: 's1', kind: 'done' });
    expect(reportBody(['done', 's1', '--summary', 'All good'])).toEqual({ sessionId: 's1', kind: 'done' });
    expect(reportBody(['approval', 's1', '--prompt', '/review-pr pr:123 publish', '--summary', 'Ready', '--report', 'wt/review.md'])).toEqual({ sessionId: 's1', kind: 'approval', prompt: '/review-pr pr:123 publish', summary: 'Ready', report: resolve('wt/review.md') });
    expect(reportBody(['approval', 's1', '--prompt=/publish'])).toEqual({ sessionId: 's1', kind: 'approval', prompt: '/publish', summary: null, report: null });
    expect(reportBody(['link', 's1', '--label', 'PR #12', '--target', 'https://github.com/o/r/pull/12'])).toEqual({ sessionId: 's1', kind: 'link', label: 'PR #12', target: 'https://github.com/o/r/pull/12' });
    expect(reportBody(['playbook', 's1', 'dev:review-pr'])).toEqual({ sessionId: 's1', kind: 'playbook', playbook: 'dev:review-pr' });
  });

  it('restores a slash command that Git Bash rewrote under its root, and leaves other prompts alone', () => {
    const root = 'C:/Program Files/Git';

    expect(reportBody(['approval', 's1', '--prompt', 'C:/Program Files/Git/legacy-ship 16416'], root)).toMatchObject({ prompt: '/legacy-ship 16416' });
    expect(reportBody(['approval', 's1', '--prompt=c:/program files/git/publish'], root)).toMatchObject({ prompt: '/publish' });
    expect(reportBody(['approval', 's1', '--prompt', 'C:/Program Files/Git/legacy-ship 16416'])).toMatchObject({ prompt: 'C:/Program Files/Git/legacy-ship 16416' });
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

  it('reads a paste with an absolute file, turns a Git Bash drive path into a Windows one, and refuses a relative or missing file (R60)', () => {
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
    expect(reportBody(['task', 's1', '--prompt', 'C:/Program Files/Git/gc-plan 18942'], 'C:/Program Files/Git')).toMatchObject({ prompt: '/gc-plan 18942' });

    for (const argv of [['task', 's1'], ['task', 's1', '--prompt', ' '], ['task', 's1', '--prompt', 'x', '--repo'], ['task', 's1', '--prompt', 'x', '--repo='], ['task', 's1', '--prompt', 'x', '--title'], ['task', 's1', '--title', 'x']]) {
      expect(reportBody(argv)).toBeNull();
    }

    expect(parseReport({ sessionId: 's1', kind: 'task', prompt: 'Fix it' })).toEqual({ sessionId: 's1', kind: 'task', prompt: 'Fix it', repo: null, title: null });
    expect(parseReport({ sessionId: 's1', kind: 'task', prompt: 'Fix it', repo: 'D:\\git\\widgets', title: 'T' })).toEqual({ sessionId: 's1', kind: 'task', prompt: 'Fix it', repo: 'D:\\git\\widgets', title: 'T' });

    for (const patch of [{ prompt: '' }, { prompt: 3 }, { repo: 'git/widgets' }, { title: 2 }]) {
      expect(parseReport({ sessionId: 's1', kind: 'task', prompt: 'Fix it', ...patch })).toBeNull();
    }
  });

  it("reads a Codex session's question with its choices, and refuses one without text or with a bad choice", () => {
    expect(reportBody(['question', 's1', '--text', 'Which tree?', '--option', 'Oak', '--option=Birch'])).toEqual({ sessionId: 's1', kind: 'question', text: 'Which tree?', options: ['Oak', 'Birch'] });
    expect(reportBody(['question', 's1', '--text', 'Free text?'])).toEqual({ sessionId: 's1', kind: 'question', text: 'Free text?', options: [] });
    expect(reportBody(['question', 's1', '--text', ' '])).toBeNull();
    expect(reportBody(['question', 's1', '--option', 'Oak'])).toBeNull();

    expect(parseReport({ sessionId: 's1', kind: 'question', text: ' Which? ', options: [' Oak '] })).toEqual({ sessionId: 's1', kind: 'question', text: 'Which?', options: ['Oak'] });
    expect(parseReport({ sessionId: 's1', kind: 'question', text: 'Which?' })).toEqual({ sessionId: 's1', kind: 'question', text: 'Which?', options: [] });

    for (const patch of [{ text: '' }, { text: 3 }, { options: 'Oak' }, { options: [''] }, { options: [1] }]) {
      expect(parseReport({ sessionId: 's1', kind: 'question', text: 'Which?', ...patch })).toBeNull();
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
    expect(parseAction({ type: 'icebox', ticketId: 1 })).toBeNull();
    expect(parseAction({ type: 'restore', ticketId: 1 })).toEqual({ type: 'restore', ticketId: 1 });
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
    expect(parseAction({ type: 'poll', source: 'github', tickets: [] })).toBeNull();
  });

  it('keeps only the fields of an answer and of Open in Claude, and refuses them without a work item, the session, the question or a text answer (PRD R70)', () => {
    const answer = { type: 'answer', workItemId: 3, nativeSessionId: 'native-3', question: 'Which tree?', answer: 'Birch' };

    expect(parseAction({ ...answer, sessionId: 's1' })).toEqual({ ...answer, questionId: null });
    expect(parseAction({ ...answer, answer: '' })).toEqual({ ...answer, answer: '', questionId: null });
    expect(parseAction({ ...answer, questionId: 'q7' })).toEqual({ ...answer, questionId: 'q7' });
    expect(parseAction({ ...answer, questionId: 7 })).toBeNull();
    expect(parseAction({ type: 'open-question', workItemId: 3, nativeSessionId: 'native-3', sessionId: 's1', cwd: 'D:/wt' })).toEqual({ type: 'open-question', workItemId: 3, nativeSessionId: 'native-3' });

    for (const body of [
      { ...answer, answer: undefined },
      { ...answer, answer: 2 },
      { ...answer, question: undefined },
      { ...answer, nativeSessionId: undefined },
      { ...answer, workItemId: '3' },
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
    expect(await app.post['/action']!({ type: 'retry', workItemId: 1 })).toEqual({ status: 400, body: { error: 'Unknown action.' } });
    expect(await app.post['/action']!({ type: 'answer', workItemId: 9, nativeSessionId: 'n', question: 'Which?', answer: 'Birch' })).toEqual({ status: 409, body: { error: 'Unknown work item 9.' } });
    expect(await app.post['/action']!({ type: 'open-question', workItemId: 9, nativeSessionId: 'n' })).toEqual({ status: 409, body: { error: 'Unknown work item 9.' } });
    expect(await app.post['/action']!({ type: 'open-question', workItemId: 'x', nativeSessionId: 'n' })).toEqual({ status: 400, body: { error: 'Unknown action.' } });
    expect(await app.post['/report']!({ sessionId: 's9', kind: 'stage', stage: 'x' })).toEqual({ status: 409, body: { error: 'Unknown session s9.' } });
    expect(await app.post['/report']!({ kind: 'stage' })).toEqual({ status: 400, body: { error: 'Expected {sessionId, kind, stage|path|reason|prompt|label and target}.' } });
    expect(await app.post['/contract']!({ nativeSessionId: 'n' })).toEqual({ status: 404, body: { error: 'No Switchboard session has this Claude session ID.' } });
    expect(await app.post['/contract']!({ sessionId: 'n' })).toEqual({ status: 400, body: { error: 'Expected {nativeSessionId}.' } });
    expect(app.busy()).toBe(false);
    expect((app.snapshot() as { repoRoots: string[] }).repoRoots).toEqual(['D:/scratch']);
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

  it('turns a source on and off in the store, leaving settings.json alone, and refuses an unknown source', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support', orgId: '1' }, adhoc: { repoRoot: 'D:/scratch' } } });
    const text = readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8');
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
    const states = () => (app.snapshot() as { sourceStates: unknown }).sourceStates;
    const enabled = async () => ((await app.post['/config/read']!({})).body as { enabled: Record<string, boolean> }).enabled;

    expect(states()).toEqual([{ name: 'zoho', enabled: false }]);
    expect(await enabled()).toEqual({ zoho: false, adhoc: false });
    expect(await app.post['/sources']!({ name: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect(states()).toEqual([{ name: 'zoho', enabled: true }]);
    expect(await enabled()).toEqual({ zoho: true, adhoc: false });
    expect(readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8')).toBe(text);

    expect(await app.post['/sources']!({ name: 'forum', enabled: true })).toEqual({ status: 409, body: { error: 'settings.json has no source named forum.' } });
    expect(await app.post['/sources']!({ name: 'zoho', enabled: 'yes' })).toEqual({ status: 400, body: { error: 'Expected {name, enabled}.' } });
    app.close();

    // The state is kept in the store, so a new hub starts the source again.
    const again = await start();

    expect((again.snapshot() as { sourceStates: unknown }).sourceStates).toEqual([{ name: 'zoho', enabled: true }]);
  });

  it('tells an open Settings window to read again after a toggle, and not after a refused one', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support' } } });
    const app = await start();
    const sent: string[] = [];

    app.attachDock!((event) => {
      sent.push(event);
      return 1;
    });
    expect(await app.post['/sources']!({ name: 'forum', enabled: true })).toMatchObject({ status: 409 });
    expect(sent).not.toContain('config');
    expect(await app.post['/sources']!({ name: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect(sent).toContain('config');
  });

  it('checks an enabled source\'s own keys only while it is on, and refuses an enabled key in settings.json', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support' } } });
    const app = await start();
    const check = async (settings: unknown) => ((await app.post['/config/check']!({ settings })).body as { errors: string[] }).errors;

    expect(await check({ sources: { zoho: { repoRoot: 'D:/support' } } })).toEqual([]);
    expect(await app.post['/sources']!({ name: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
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

    expect((app.snapshot() as { sourceStates: unknown }).sourceStates).toEqual([{ name: 'zoho', enabled: false }]);
    expect((app.snapshot() as { configDir: string }).configDir).toBe(configDir);

    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ sessions: { installHooks: false }, sources: { zoho: { repoRoot: 'D:/support', orgId: '1' } }, playbooks: { 'dev:develop': { description: 'Build it', template: 'Build.' } } }),
    );
    await until(() => ((app.snapshot() as { playbooks: unknown[] }).playbooks.length === 1 ? true : null));

    expect(await app.post['/sources']!({ name: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect((app.snapshot() as { sourceStates: unknown }).sourceStates).toEqual([{ name: 'zoho', enabled: true }]);
    expect(JSON.parse(readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8'))).toEqual({ sessions: { installHooks: false } });
  });

  it('lists the URLs of tickets snoozed now, leaving out woken, unsnoozed and URL-less tickets (PRD R56)', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const store = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));
    const ticket = (sourceKey: string, url: string, snoozed: boolean, snoozedUntil: number | null) =>
      store.insertTicket({ source: 'github', sourceKey, ref: `#${sourceKey}`, sourceId: null, title: 't', url, assigned: true, pool: false, snoozed, snoozedUntil, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });

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
      store.insertTicket({ source: 'github', sourceKey, ref: `#${sourceKey}`, sourceId: null, title: 't', url: `https://github.com/O/r/issues/${sourceKey}`, assigned, pool, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });

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

    store.insertTicket({ source: 'github', sourceKey: '7', ref: '#7', sourceId: null, title: 'Seven', url: '', assigned: false, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
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

    expect(await app.post['/action']!({ type: 'adhoc', prompt: 'Look around', repoRoot: 'D:/scratch' })).toMatchObject({ status: 200 });
    await until(() => ((app.snapshot() as { workItems: { sessions: unknown[] }[] }).workItems[0]?.sessions.length ? true : null));

    const window = (app.dock() as { groups: { rows: { window: { name: string; file: string; title: string } | null }[] }[] }).groups.flatMap((group) => group.rows).find((row) => row.window !== null)!.window!;

    expect(window.file.startsWith(join(temp.home, '.switchboard', 'windows'))).toBe(true);
    expect(JSON.parse(readFileSync(window.file, 'utf8')).settings['window.title']).toBe(`${window.title}\${separator}\${activeEditorShort}\${separator}sb:${window.name}`);
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
    writeSettings({ sessions: { installHooks: false } });
    const logs: string[] = [];
    const app = await start((line) => logs.push(line));
    const claims: unknown[] = [];

    app.attachWindows?.((event, data) => claims.push({ event, data }));
    const server = await listenHub({ identity: { hub: 'switchboard', protocol: 1, version: 't', pid: 1 }, onShutdown: () => {}, post: app.post, snapshot: () => app.snapshot() });
    closers.push(() => server.close());
    const record = { protocol: 1, version: 't', build: 'b', configDir: 'C:/cfg', port: server.port, token: server.token, pid: 1, startedAt: '' };

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
    expect(await postToHub(record, '/window', { workspace: 'C:/h/w.code-workspace', command: { type: 'changes', path: 'D:/wt', key: 'gh 7', title: 'T' } }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/claim', { folder: '', workspace: null }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [] } });
    expect(await postToHub(record, '/claim', { folder: '', workspace: null, focused: true }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null, provider: null, commands: [{ type: 'history', ticketId: 3, key: 'gh 3' }] } });
    expect(await postToHub(record, '/window', { workspace: 'C:/h/w.code-workspace', command: { type: 'openTabs' } }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/claim', { folder: 'D:/wt', workspace: 'C:/h/w.code-workspace' }, 5000)).toEqual({
      status: 200,
      error: null,
      body: { sessionId: null, provider: null, commands: [{ type: 'changes', path: 'D:/wt', key: 'gh 7', title: 'T' }, { type: 'openTabs' }] },
    });
    for (const [shortId, active] of [['abcd0007', false], [null, true]]) {
      const terminal = { type: 'terminal', sessionId: 'abc-native', cwd: 'D:/wt', name: 'gh 7', shortId, active };

      expect(await postToHub(record, '/window', { workspace: 'C:/h/w.code-workspace', command: terminal }, 5000)).toMatchObject({ status: 200 });
      expect(await postToHub(record, '/claim', { folder: 'D:/wt', workspace: 'C:/h/w.code-workspace' }, 5000)).toMatchObject({ body: { commands: [terminal] } });
    }
    // Only the item window opens its tabs (PRD R72).
    expect(await postToHub(record, '/window', { workspace: null, command: { type: 'openTabs' } }, 5000)).toMatchObject({ status: 400, error: 'Expected {workspace, command} with a changes, terminal, history or openUrl command, or openTabs for a workspace.' });
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
      'window command N changes left for C:/h/w.code-workspace',
      'window commands claimed by a window with no folder: history',
      'window command N openTabs left for C:/h/w.code-workspace',
      'window commands claimed by C:/h/w.code-workspace: changes, openTabs',
      'window command N terminal left for C:/h/w.code-workspace',
      'window commands claimed by C:/h/w.code-workspace: terminal',
      'window command N terminal left for C:/h/w.code-workspace',
      'window commands claimed by C:/h/w.code-workspace: terminal',
    ]);
    // A window that is already in front gets no focus change, so each open and command left for a workspace tells that window to claim.
    expect(claims).toEqual([
      { event: 'claim', data: { workspace: 'C:/h/windows/gh-7.code-workspace' } },
      ...Array.from({ length: 4 }, () => ({ event: 'claim', data: { workspace: 'C:/h/w.code-workspace' } })),
    ]);
  });
});
