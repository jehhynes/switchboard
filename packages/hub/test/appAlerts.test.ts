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
import { temp, closers, noCli, writeSettings, start, needingIn } from './appFixtures.js';

/** The needs-you alerts the hub shows as system notifications; no test shows a real one. */
const systemAlerts = vi.hoisted(() => [] as Array<{ alerts: unknown[]; sound: boolean }>);

vi.mock('../src/systemAlerts.js', () => ({ systemNotifier: () => ({ notify: (alerts: unknown[], sound: boolean) => systemAlerts.push({ alerts: [...alerts], sound }) }) }));

beforeEach(() => {
  systemAlerts.length = 0;
});

describe('createHubApp', () => {
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
