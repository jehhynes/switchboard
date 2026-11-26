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

describe('createHubApp', () => {
  describe('plugin reloads', () => {
    /** Import progress of the plugin modules writePlugin writes, which run in this process. */
    const progress = globalThis as unknown as { pluginGates?: Record<string, Promise<void>>; pluginStages?: Record<string, 'importing' | 'imported'> };

    /** Holds the import of the plugin named `name` at a top-level await until the function it returns is called. */
    function gate(name: string): () => void {
      let open = (): void => undefined;

      (progress.pluginGates ??= {})[name] = new Promise<void>((done) => (open = done));
      return () => open();
    }

    const stage = (name: string) => progress.pluginStages?.[name] ?? null;

    afterEach(() => {
      delete progress.pluginGates;
      delete progress.pluginStages;
    });

    /** A plugin module of `kind`, whose import waits at a gate() of its name and records its stage. */
    function writePlugin(name: string, kind: string): string {
      const dir = join(temp.home, 'plugins');
      const stages = `(globalThis.pluginStages ??= {})[${JSON.stringify(name)}]`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${name}.mjs`),
        `${stages} = 'importing';\nawait globalThis.pluginGates?.[${JSON.stringify(name)}];\n${stages} = 'imported';\n` +
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
      const slow = writePlugin('slow', 'slow');
      const fast = writePlugin('fast', 'fast');
      const release = gate('slow');
      writeSettings({ sessions: { installHooks: false } });
      const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
      closers.push(() => app.close());

      writeSettings({ plugins: [slow], sessions: { installHooks: false }, sources: { slow: { userId: '1' } } });
      await until(() => (stage('slow') === 'importing' ? true : null));
      writeSettings({ plugins: [fast], sessions: { installHooks: false }, sources: { fast: { userId: '1' } } });
      await until(async () => ((await kinds(app)).includes('fast') ? true : null));
      release();
      await until(() => (stage('slow') === 'imported' ? true : null));
      // The earlier reload resumes once its import ends; a window of a few turns of the event loop shows it applies nothing.
      await new Promise((done) => setTimeout(done, 50));

      expect(await kinds(app)).toEqual(['github', 'zoho', 'fast']);
      expect((app.snapshot() as { sourceStates: { name: string }[] }).sourceStates.map((source) => source.name)).toEqual(['fast']);
    });

    it('checks a save against the sources that are on once the draft plugin has imported', async () => {
      const slow = writePlugin('slow', 'slow');
      const release = gate('slow');
      writeSettings({ sessions: { installHooks: false }, sources: { zoho: { orgId: '1' } } });
      const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli } });
      closers.push(() => app.close());
      const version = ((await app.post['/v1/conversation/page-settings-read']!({})).body as { settings: { version: string } }).settings.version;

      const saving = app.post['/v1/conversation/page-settings-save']!({ value: { plugins: [slow], sessions: { installHooks: false }, sources: { zoho: { orgId: '1' } } }, version });
      await until(() => (stage('slow') === 'importing' ? true : null));
      expect(await toggleSource(app, { name: 'zoho', enabled: true })).toEqual({ status: 200, body: { done: true } });
      release();

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

});
