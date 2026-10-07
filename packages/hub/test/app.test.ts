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
    expect(parseReport({ kind: 'stage', stage: 'x' })).toBeNull();
    expect(parseReport('text')).toBeNull();
    expect(parseAction({ type: 'approve', workItemId: 1 })).toEqual({ type: 'approve', workItemId: 1 });
    expect(parseAction({ type: 'start', workItemId: 1 })).toEqual({ type: 'start', workItemId: 1 });
    expect(parseAction({ type: 'poll', source: 'github', tickets: [] })).toBeNull();
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

    writeSettings({ sessions: { concurrency: 9 } });
    const invalid = loadConfig(join(temp.home, '.switchboard'), valid.settings);
    expect(invalid.settings.sessions.concurrency).toBe(3);
    expect(invalid.settingsError).toBe('sessions.concurrency must be a whole number from 1 to 4.');

    mkdirSync(join(temp.home, '.switchboard', 'playbooks', 'dev'), { recursive: true });
    writeFileSync(join(temp.home, '.switchboard', 'playbooks', 'dev', 'bad.md'), 'no front matter');
    expect(loadConfig(join(temp.home, '.switchboard')).playbookErrors).toEqual([{ file: 'dev/bad.md', error: 'The file must start with front matter between --- lines.' }]);
  });
});

describe('createHubApp', () => {
  async function start() {
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
    closers.push(() => app.close());

    return app;
  }

  it('serves actions and reports, refusing what does not apply', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { adhoc: { repoRoot: 'D:/scratch' } } });
    const app = await start();

    expect(await app.post['/action']!({ type: 'approve', workItemId: 9 })).toEqual({ status: 409, body: { error: 'Unknown work item 9.' } });
    expect(await app.post['/action']!({ type: 'poll' })).toEqual({ status: 400, body: { error: 'Unknown action.' } });
    expect(await app.post['/report']!({ sessionId: 's9', kind: 'stage', stage: 'x' })).toEqual({ status: 409, body: { error: 'Unknown session s9.' } });
    expect(await app.post['/report']!({ kind: 'stage' })).toEqual({ status: 400, body: { error: 'Expected {sessionId, kind, stage|path|reason|prompt|label and target}.' } });
    expect(app.busy()).toBe(false);
    expect((app.snapshot() as { repoRoots: string[] }).repoRoots).toEqual(['D:/scratch']);
  });

  it('reloads settings and playbooks when they change', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start();
    let changes = 0;
    app.onChange(() => changes++);

    mkdirSync(join(temp.home, '.switchboard', 'playbooks', 'dev'), { recursive: true });
    writeFileSync(join(temp.home, '.switchboard', 'playbooks', 'dev', 'develop.md'), '---\ndescription: Build it\n---\nBuild.');

    await until(() => ((app.snapshot() as { playbooks: unknown[] }).playbooks.length === 1 ? true : null));

    writeSettings('{ broken');
    await until(() => ((app.snapshot() as { errors: { settings: string | null } }).errors.settings?.startsWith('settings.json is not valid JSON') ? true : null));
    expect(changes).toBeGreaterThan(0);
  });

  it('turns a source on and off in settings.json, keeping its other settings, and refuses an unknown source', async () => {
    writeSettings({ sessions: { installHooks: false }, sources: { zoho: { enabled: true, repoRoot: 'D:/support', orgId: '1' }, adhoc: { repoRoot: 'D:/scratch' } } });
    const app = await start();
    const states = () => (app.snapshot() as { sourceStates: unknown }).sourceStates;
    const file = () => JSON.parse(readFileSync(join(temp.home, '.switchboard', 'settings.json'), 'utf8'));

    expect(states()).toEqual([{ name: 'zoho', enabled: true }]);
    expect(await app.post['/sources']!({ name: 'zoho', enabled: false })).toEqual({ status: 200, body: { done: true } });
    expect(file().sources.zoho).toEqual({ enabled: false, repoRoot: 'D:/support', orgId: '1' });
    await until(() => (JSON.stringify(states()) === '[{"name":"zoho","enabled":false}]' ? true : null));

    expect(await app.post['/sources']!({ name: 'forum', enabled: true })).toEqual({ status: 409, body: { error: 'settings.json has no source named forum.' } });
    expect(await app.post['/sources']!({ name: 'zoho', enabled: 'yes' })).toEqual({ status: 400, body: { error: 'Expected {name, enabled}.' } });
  });

  it('reads, reloads and writes settings and playbooks in a configDir outside the Switchboard home', async () => {
    const configDir = join(temp.home, 'repo', 'switchboard');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ sessions: { installHooks: false }, sources: { zoho: { enabled: true, repoRoot: 'D:/support', orgId: '1' } } }));
    writeSettings({ sessions: { installHooks: false } });
    const app = await createHubApp({ home: temp.home, configDir, log: () => {}, deps: { exec: noCli } });
    closers.push(() => app.close());

    expect((app.snapshot() as { sourceStates: unknown }).sourceStates).toEqual([{ name: 'zoho', enabled: true }]);
    expect((app.snapshot() as { configDir: string }).configDir).toBe(configDir);

    mkdirSync(join(configDir, 'playbooks', 'dev'), { recursive: true });
    writeFileSync(join(configDir, 'playbooks', 'dev', 'develop.md'), '---\ndescription: Build it\n---\nBuild.');
    await until(() => ((app.snapshot() as { playbooks: unknown[] }).playbooks.length === 1 ? true : null));

    expect(await app.post['/sources']!({ name: 'zoho', enabled: false })).toEqual({ status: 200, body: { done: true } });
    expect(JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')).sources.zoho.enabled).toBe(false);
    await until(() => (JSON.stringify((app.snapshot() as { sourceStates: unknown }).sourceStates) === '[{"name":"zoho","enabled":false}]' ? true : null));
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

  it('answers posts through the server', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start();
    const server = await listenHub({ identity: { hub: 'switchboard', protocol: 1, version: 't', pid: 1 }, onShutdown: () => {}, post: app.post, snapshot: () => app.snapshot() });
    closers.push(() => server.close());
    const record = { protocol: 1, version: 't', build: 'b', configDir: 'C:/cfg', port: server.port, token: server.token, pid: 1, startedAt: '' };

    expect(await postToHub(record, '/action', { type: 'mark-done', workItemId: 1 }, 5000)).toMatchObject({ status: 409, error: 'Unknown work item 1.' });
    expect(await postToHub(record, '/report', { sessionId: 's1', kind: 'nope' }, 5000)).toMatchObject({ status: 400, error: 'Expected {sessionId, kind, stage|path|reason|prompt|label and target}.' });

    expect(await postToHub(record, '/open', { sessionId: 'abc-native', cwd: 'D:\\git\\widgets-wt\\7-fix' }, 5000)).toMatchObject({ status: 200 });
    expect(await postToHub(record, '/claim', { folder: 'd:/git/widgets' }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null } });
    expect(await postToHub(record, '/claim', { folder: 'd:/git/widgets-wt/7-fix/' }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: 'abc-native' } });
    expect(await postToHub(record, '/claim', { folder: 'd:/git/widgets-wt/7-fix' }, 5000)).toEqual({ status: 200, error: null, body: { sessionId: null } });
    expect(await postToHub(record, '/open', { sessionId: 1 }, 5000)).toMatchObject({ status: 400, error: 'Expected {sessionId, cwd}.' });
    expect(await postToHub(record, '/claim', {}, 5000)).toMatchObject({ status: 400, error: 'Expected {folder}.' });
    expect(await postToHub({ ...record, port: 1 }, '/action', {}, 1000)).toBeNull();
  });
});
