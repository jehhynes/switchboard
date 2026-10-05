import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Exec } from '@switchboard/claude';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubApp, parseAction, parseReport } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { postToHub } from '../src/client.js';
import { listenHub } from '../src/server.js';
import { reportBody } from '../src/report.js';
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
    expect(reportBody(['blocked', 's1', '--reason=Needs access'])).toEqual({ sessionId: 's1', kind: 'blocked', reason: 'Needs access' });
    expect(reportBody(['approval', 's1', '--prompt', '/review-pr pr:123 publish', '--summary', 'Ready'])).toEqual({ sessionId: 's1', kind: 'approval', prompt: '/review-pr pr:123 publish', summary: 'Ready' });
    expect(reportBody(['approval', 's1', '--prompt=/publish'])).toEqual({ sessionId: 's1', kind: 'approval', prompt: '/publish', summary: null });
    expect(reportBody(['link', 's1', '--label', 'PR #12', '--target', 'https://github.com/o/r/pull/12'])).toEqual({ sessionId: 's1', kind: 'link', label: 'PR #12', target: 'https://github.com/o/r/pull/12' });
    expect(reportBody(['link', 's1', '--label=Case', '--target=cases/1/case.md'])).toEqual({ sessionId: 's1', kind: 'link', label: 'Case', target: resolve('cases/1/case.md') });
  });

  it('rejects bad usage', () => {
    for (const argv of [[], ['stage'], ['stage', 's1'], ['blocked', 's1'], ['approval', 's1'], ['approval', 's1', '--summary', 'x'], ['blocked', 's1', '--reason', ''], ['finish', 's1'], ['done', '--summary'], ['link', 's1', '--label', 'x'], ['link', 's1', '--target', 'https://x'], ['link', 's1', '--label', '', '--target', 'https://x'], ['link', 's1', '--label', 'x', '--target', 'vscode://x'], ['link', 's1', '--target', '--label', 'Case']]) {
      expect(reportBody(argv)).toBeNull();
    }
  });

  it('validates report and action bodies', () => {
    expect(parseReport({ sessionId: 's1', kind: 'stage', stage: 'x' })).toEqual({ sessionId: 's1', kind: 'stage', stage: 'x' });
    expect(parseReport({ sessionId: 's1', kind: 'done' })).toEqual({ sessionId: 's1', kind: 'done' });
    expect(parseReport({ sessionId: 's1', kind: 'stage', stage: '' })).toBeNull();
    expect(parseReport({ sessionId: 's1', kind: 'done', summary: 'ignored' })).toEqual({ sessionId: 's1', kind: 'done' });
    expect(parseReport({ sessionId: 's1', kind: 'approval', prompt: '/publish' })).toEqual({ sessionId: 's1', kind: 'approval', prompt: '/publish', summary: null });
    expect(parseReport({ sessionId: 's1', kind: 'approval', prompt: '/publish', summary: 2 })).toBeNull();
    expect(parseReport({ sessionId: 's1', kind: 'link', label: ' PR ', target: 'https://github.com/o/r/pull/1' })).toEqual({ sessionId: 's1', kind: 'link', label: 'PR', target: 'https://github.com/o/r/pull/1' });
    expect(parseReport({ sessionId: 's1', kind: 'link', label: 'Case', target: 'D:\\cases\\case.md' })).toMatchObject({ target: 'D:\\cases\\case.md' });
    for (const target of ['cases/case.md', 'javascript:alert(1)', 'vscode://x', 'https://', 3]) {
      expect(parseReport({ sessionId: 's1', kind: 'link', label: 'x', target })).toBeNull();
    }
    expect(parseReport({ sessionId: 's1', kind: 'link', label: ' ', target: 'https://x' })).toBeNull();
    expect(parseAction({ type: 'icebox', ticketId: 1 })).toEqual({ type: 'icebox', ticketId: 1 });
    expect(parseReport({ kind: 'stage', stage: 'x' })).toBeNull();
    expect(parseReport('text')).toBeNull();
    expect(parseAction({ type: 'approve', workItemId: 1 })).toEqual({ type: 'approve', workItemId: 1 });
    expect(parseAction({ type: 'start', workItemId: 1 })).toEqual({ type: 'start', workItemId: 1 });
    expect(parseAction({ type: 'poll', source: 'github', tickets: [] })).toBeNull();
  });
});

describe('loadConfig', () => {
  it('uses defaults without a settings file, keeps the previous settings on an invalid file, and lists playbook errors', () => {
    const fresh = loadConfig(temp.home);
    expect(fresh.settingsError).toBeNull();
    expect(fresh.settings.sessions.concurrency).toBe(2);

    writeSettings({ sessions: { concurrency: 3 } });
    const valid = loadConfig(temp.home);
    expect(valid.settings.sessions.concurrency).toBe(3);

    writeSettings({ sessions: { concurrency: 9 } });
    const invalid = loadConfig(temp.home, valid.settings);
    expect(invalid.settings.sessions.concurrency).toBe(3);
    expect(invalid.settingsError).toBe('sessions.concurrency must be a whole number from 1 to 4.');

    mkdirSync(join(temp.home, '.switchboard', 'playbooks', 'dev'), { recursive: true });
    writeFileSync(join(temp.home, '.switchboard', 'playbooks', 'dev', 'bad.md'), 'no front matter');
    expect(loadConfig(temp.home).playbookErrors).toEqual([{ file: 'dev/bad.md', error: 'The file must start with front matter between --- lines.' }]);
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

  it('answers posts through the server', async () => {
    writeSettings({ sessions: { installHooks: false } });
    const app = await start();
    const server = await listenHub({ identity: { hub: 'switchboard', protocol: 1, version: 't', pid: 1 }, onShutdown: () => {}, post: app.post, snapshot: () => app.snapshot() });
    closers.push(() => server.close());
    const record = { protocol: 1, version: 't', build: 'b', port: server.port, token: server.token, pid: 1, startedAt: '' };

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
