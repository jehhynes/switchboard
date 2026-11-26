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
import { temp, closers, noCli, fakeCodex, writeSettings, start } from './appFixtures.js';

/** The needs-you alerts the hub shows as system notifications; no test shows a real one. */
const systemAlerts = vi.hoisted(() => [] as Array<{ alerts: unknown[]; sound: boolean }>);

vi.mock('../src/systemAlerts.js', () => ({ systemNotifier: () => ({ notify: (alerts: unknown[], sound: boolean) => systemAlerts.push({ alerts: [...alerts], sound }) }) }));

beforeEach(() => {
  systemAlerts.length = 0;
});

describe('createHubApp', () => {
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
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli, runners: fakeCodex() } });
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
    const app = await createHubApp({ home: temp.home, log: () => {}, deps: { exec: noCli, runners: fakeCodex() } });
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

});
