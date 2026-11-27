import { appendFileSync, closeSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundDetail, CONVERSATION_RETENTION, PERMISSION_PROMPT, Store, toneSection, toneVersion } from '@switchboard/core';
import type { ConversationMessage, Interruption, Session as StoredSession } from '@switchboard/core';
import { BACKGROUND_DETAIL, projectSlug } from '@switchboard/claude';
import { ConversationService, MIC_TIMING_MAX_MS, MIC_TIMING_STEPS, refusal, sessionView, typedText } from '../src/conversation.js';
import type { ConversationServiceDeps, ConversationVoice } from '../src/conversation.js';
import type { ConversationAdapter, ConversationChanged } from '../src/conversationAdapter.js';
import type { InputOutcome } from '@switchboard/conversation';
import { dockView, windowOf } from '../src/dock.js';
import { canonicalFolder } from '../src/folders.js';
import { WindowScopes } from '../src/windows.js';
import type { WindowScope } from '../src/windows.js';
import type { Snapshot, WorkItemView } from '../src/snapshot.js';
import { pageList } from '../src/page.js';
import { questionIndex } from '../src/questions.js';
import { questionCardOpen } from '../src/runtime.js';
import type { PageHeader } from '../src/page.js';
import { NOW, item, session, snapshot } from './views.js';
import { openPageFile } from '../src/localFiles.js';
import { dir, WINDOWS, worktree, world, stored, pageOn, FakeHeld } from './conversationFixtures.js';

describe('ConversationService artifacts', () => {
  /** World 2 and 3 as in `world`, with their sessions in this test's folder, so their artifact folders are real. */
  function setup() {
    const w12 = join(dir, 'w12');
    const w3 = join(dir, 'w3');
    const done = item(1, { status: 'done', worktree: worktree(w12), sessions: [session({ id: 's1', workItemId: 1, cwd: w12, state: 'ended' })] });
    const current = item(2, { ticketId: 1, ticket: { ...done.ticket }, worktree: worktree(w12), status: 'blocked', sessions: [session({ id: 's2', workItemId: 2, cwd: w12, codeMode: true, nativeSessionId: 'n2' })] });
    const other = item(3, { worktree: worktree(w3), sessions: [session({ id: 's3', workItemId: 3, cwd: w3, codeMode: true, nativeSessionId: 'n3' })] });
    const view = { done, current, other, file: windowOf(current, WINDOWS)!.file!, otherFile: windowOf(other, WINDOWS)!.file!, view: snapshot([done, current, other]) };
    const store = Store.open(':memory:');
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, newKey: () => `k${++keys}` });
    const held = new FakeHeld();
    const logged: string[] = [];
    let changed: ConversationChanged | null = null;
    const service = new ConversationService({
      adapters: (one) => {
        changed = one;
        return [];
      },
      store,
      windows: scopes,
      projectsDir: join(dir, 'projects'),
      claudeConfig: join(dir, '.claude.json'),
      screen: async (one) => held.screen(one),
      input: held,
      hooks: () => true,
      now: () => NOW,
      newId: () => 'id',
      switchboardHome: join(dir, 'home'),
      log: (line) => logged.push(line),
    });

    stored(store, view);
    scopes.update(view.view);

    const openPage = (workItemId: number) => {
      const key = scopes.openPage();
      const frames: Array<{ type: string; [field: string]: unknown }> = [];

      service.open(key, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));
      service.select({ window: key, opId: 'o', workItemId });

      return { key, frames };
    };
    const tag = (sessionId: string, artifacts: Array<{ path: string; title?: string; kind?: string }>) => changed!(sessionId, { type: 'artifacts', replyId: 'r1', artifacts: artifacts.map((one) => ({ title: null, kind: null, ...one })) });

    const open = (workItemId: number | null) => {
      const key = workItemId === null ? scopes.openPage() : pageOn(scopes, view.view, workItemId);
      const frames: Array<{ type: string; [field: string]: unknown }> = [];
      const stream = service.open(key, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }))!;

      return { key, frames, stream };
    };
    const put = (cwd: string, workItemId: number, name: string, text: string, mtime: number) => {
      const path = join(cwd, '.wip', 'artifacts', `w${workItemId}`, ...name.split('/'));

      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
      utimesSync(path, mtime / 1000, mtime / 1000);

      return path;
    };

    return { w12, w3, view, service, open, put, scopes, store, openPage, tag, logged };
  }

  it("lists the files a reply's artifact tags name on its work item's pages only, follows their changes, and serves only them and the files under their folders", async () => {
    const { service, store, openPage, tag, logged } = setup();
    const real = realpathSync.native(dir);
    const report = join(real, 'research', 'report', 'summary.md');
    const page = join(real, 'w12', 'plans', 'page.html');

    for (const [path, text] of [[report, '---\nkind: research\ntitle: Speech engines\n---\n'], [page, '<title>Page</title>'], [join(real, 'w12', 'plans', 'page', 'a.png'), ''], [join(real, 'w12', 'plans', 'secret.txt'), ''], [join(real, 'w12', '.git', 'config'), ''], [join(real, 'home', 'hub.json'), '{}'], [join(real, 'w12', '.wip', 'artifacts', 'w2', 'chat', 'copy.md'), '']] as const) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
    }

    utimesSync(report, 2_000, 2_000);
    utimesSync(page, 3_000, 3_000);
    utimesSync(join(real, 'w12', '.wip', 'artifacts', 'w2', 'chat', 'copy.md'), 1_000, 1_000);

    const mine = openPage(2);
    const others = openPage(3);

    tag('s2', [{ path: report.replaceAll('\\', '/') }, { path: 'plans/page.html', title: 'The page', kind: 'demo' }, { path: 'plans/missing.md' }, { path: '.git/config' }, { path: join(real, 'home', 'hub.json') }, { path: '.wip/artifacts/w2/chat/copy.md' }, { path: 'plans' }]);

    expect(store.externalArtifacts(2).map((one) => one.path)).toEqual([report, page]);
    expect(logged).toEqual(expect.arrayContaining([
      'session s2: artifact tag "plans/missing.md" ignored: no such file',
      'session s2: artifact tag ".git/config" ignored: in a .git folder',
      `session s2: artifact tag ${JSON.stringify(join(real, 'home', 'hub.json'))} ignored: in the Switchboard home`,
      'session s2: artifact tag ".wip/artifacts/w2/chat/copy.md" ignored: in the artifact folder, which lists it already',
      'session s2: artifact tag "plans" ignored: not a file',
    ]));
    expect(mine.frames.filter((frame) => frame.type === 'artifact').map((frame) => (frame['artifact'] as { path: string }).path)).toEqual(['@1/summary.md', '@2/page.html']);
    expect(others.frames.filter((frame) => frame.type === 'artifact')).toEqual([]);

    // A page's hello lists them among the folder's artifacts, newest first.
    expect(service.hello(mine.key)['artifacts']).toEqual([
      { path: '@2/page.html', owner: 'external', kind: 'demo', title: 'The page', ext: 'html', type: 'html', updatedAt: 3_000_000, file: page.replaceAll('\\', '/') },
      { path: '@1/summary.md', owner: 'external', kind: 'research', title: 'Speech engines', ext: 'md', type: 'markdown', updatedAt: 2_000_000, file: report.replaceAll('\\', '/') },
      expect.objectContaining({ path: 'chat/copy.md' }),
    ]);

    // A served file comes open, checked as the file listed; the route's stream closes it.
    const served = (name: string) => {
      const file = service.artifactFile(mine.key, name);

      if (file?.fd !== undefined) {
        closeSync(file.fd);
      }

      return file;
    };

    expect(served('@1/summary.md')).toEqual({ path: report, mime: 'text/markdown; charset=utf-8', sandboxed: false, fd: expect.any(Number), size: readFileSync(report).length });
    expect(served('@2/page.html')).toMatchObject({ path: page, sandboxed: true });
    expect(served('@2/page/a.png')).toMatchObject({ path: join(real, 'w12', 'plans', 'page', 'a.png'), mime: 'image/png', size: 0 });
    // The operator's decision: any file under the tagged file's folder, never .git, the Switchboard home, or a parent segment.
    expect(served('@2/secret.txt')).toMatchObject({ path: join(real, 'w12', 'plans', 'secret.txt') });
    expect(service.artifactFile(mine.key, '@2/page/../secret.txt')).toBeNull();
    expect(service.artifactFile(mine.key, '@2/../.git/config')).toBeNull();
    writeFileSync(join(real, 'top.md'), '# Top');
    tag('s2', [{ path: join(real, 'top.md') }]);
    expect(store.externalArtifacts(2).map((one) => one.path)).toEqual([report, page, join(real, 'top.md')]);
    expect(served('@3/w12/plans/secret.txt')).toMatchObject({ path: join(real, 'w12', 'plans', 'secret.txt') });
    expect(service.artifactFile(mine.key, '@3/home/hub.json')).toBeNull();
    expect(service.artifactFile(mine.key, '@3/w12/.git/config')).toBeNull();
    expect(service.artifactFile(mine.key, '@9/summary.md')).toBeNull();
    expect(service.artifactFile(others.key, '@1/summary.md')).toBeNull();

    // A tag naming a kept file again changes nothing, and a file that goes is removed.
    const sent = mine.frames.length;

    tag('s2', [{ path: report }]);
    expect(mine.frames).toHaveLength(sent);
    rmSync(report);
    await vi.waitFor(() => expect(mine.frames.at(-1)).toMatchObject({ type: 'artifact', artifact: { path: '@1/summary.md' }, removed: true }), { timeout: 5_000 });
    expect(served('@1/summary.md')).toBeNull();
    service.stop();
  });

  it("names the artifact a local file is by real path, through another spelling, a junction or a symlink, and a tagged file, on its work item's pages only", async () => {
    const { service, openPage, put, tag, w12 } = setup();
    const plan = put(w12, 2, 'chat/plan.md', '# Plan', 1_000_000);
    const summary = join(realpathSync.native(dir), 'research', 'summary.md');

    mkdirSync(join(summary, '..'), { recursive: true });
    writeFileSync(summary, '# Summary');
    writeFileSync(join(w12, 'readme.md'), '');
    symlinkSync(join(w12, '.wip', 'artifacts'), join(dir, 'alias'), 'junction');

    const mine = openPage(2);
    const others = openPage(3);
    const roots = { cwd: w12, folders: [dir], sessionIds: [] };
    const named = async (key: string, target: string) => (await openPageFile(roots, target, (real) => service.pageArtifactAt(key, real)))?.view.artifact ?? null;

    tag('s2', [{ path: summary }]);
    expect(await named(mine.key, plan)).toBe('chat/plan.md');
    expect(await named(mine.key, '.wip/artifacts/w2/chat/../chat/plan.md')).toBe('chat/plan.md');
    expect(await named(mine.key, join(dir, 'alias', 'w2', 'chat', 'plan.md'))).toBe('chat/plan.md');
    expect(await named(mine.key, summary)).toBe('@1/summary.md');

    if (process.platform === 'win32') {
      expect(await named(mine.key, plan.toUpperCase())).toBe('chat/plan.md');
    }

    try {
      symlinkSync(plan, join(w12, 'plan-link.md'), 'file');
      expect(await named(mine.key, 'plan-link.md')).toBe('chat/plan.md');
    } catch (error) {
      // Windows makes a file symlink only with Developer Mode or as an administrator.
      if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
    }

    // Any other file is no artifact, and another work item's page names none of these.
    expect(await named(mine.key, 'readme.md')).toBeNull();
    expect(await named(others.key, plan)).toBeNull();
    expect(await named(others.key, summary)).toBeNull();
    expect(service.pageArtifactAt('k99', realpathSync.native(plan))).toBeNull();
  });

  it('names a listed artifact that links to a deeper file of its artifact folder, and a file another artifact links to by its own name', async () => {
    const { service, openPage, put, w12 } = setup();
    const plan = put(w12, 2, 'chat/plan.md', '# Plan', 1_000_000);
    const deep = put(w12, 2, 'chat/notes/deep/real.md', '# Deep', 1_000_000);
    const folder = join(w12, '.wip', 'artifacts', 'w2');

    try {
      symlinkSync(deep, join(folder, 'chat', 'linked.md'), 'file');
      symlinkSync(plan, join(folder, 'chat', 'same.md'), 'file');
    } catch (error) {
      // Windows makes a file symlink only with Developer Mode or as an administrator.
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') return;
      throw error;
    }

    const mine = openPage(2);
    const roots = { cwd: w12, folders: [dir], sessionIds: [] };
    const named = async (target: string) => (await openPageFile(roots, target, (real) => service.pageArtifactAt(mine.key, real)))?.view.artifact ?? null;

    expect(await named(deep)).toBe('chat/linked.md');
    expect(await named(join(folder, 'chat', 'linked.md'))).toBe('chat/linked.md');
    expect(await named(plan)).toBe('chat/plan.md');
    expect(await named(join(folder, 'chat', 'same.md'))).toBe('chat/plan.md');
  });

  it("lists the window's work item's artifacts in hello, sends its changes to its windows only, and stops watching when its last stream closes", async () => {
    const { w12, w3, view, service, open, put } = setup();

    put(w12, 2, 'chat/plan.md', '---\nkind: plan\ntitle: The plan\n---\n', 2_000_000);
    // The earlier work item of the same worktree, and another work item, have their own folders.
    put(w12, 1, 'chat/old.md', '# Old', 2_000_000);
    put(w3, 3, 'chat/other.md', '# Other', 2_000_000);

    const mine = open(2);
    const other = open(3);
    const folder = open(null);

    expect(mine.frames[0]).toMatchObject({ type: 'hello', artifactsDir: join(w12, '.wip', 'artifacts', 'w2'), artifacts: [{ path: 'chat/plan.md', owner: 'chat', kind: 'plan', title: 'The plan', ext: 'md', type: 'markdown', updatedAt: 2_000_000 }] });
    expect(other.frames[0]).toMatchObject({ type: 'hello', artifactsDir: join(w3, '.wip', 'artifacts', 'w3'), artifacts: [{ path: 'chat/other.md' }] });
    expect(folder.frames[0]).toMatchObject({ type: 'hello', scope: null, artifactsDir: null, artifacts: [] });

    put(w12, 2, 'chat/comparison-engines.md', '# Engines', 3_000_000);
    await vi.waitFor(() => expect(mine.frames.filter((frame) => frame.type === 'artifact')).toEqual([expect.objectContaining({ artifact: expect.objectContaining({ path: 'chat/comparison-engines.md', title: 'Engines', updatedAt: 3_000_000 }) })]));
    rmSync(join(w12, '.wip', 'artifacts', 'w2', 'chat', 'plan.md'));
    await vi.waitFor(() => expect(mine.frames.at(-1)).toMatchObject({ type: 'artifact', artifact: { path: 'chat/plan.md' }, removed: true }));
    expect(other.frames.filter((frame) => frame.type === 'artifact')).toEqual([]);
    expect(folder.frames.filter((frame) => frame.type === 'artifact')).toEqual([]);

    mine.stream.close();
    expect(service.watching()).toEqual([3]);
    put(w12, 2, 'chat/late.md', '# Late', 4_000_000);
    await new Promise((done) => setTimeout(done, 400));
    expect(mine.frames.filter((frame) => frame.type === 'artifact')).toHaveLength(2);

    // A window that opens again lists what the folder holds now.
    expect(open(2).frames[0]).toMatchObject({ artifacts: [{ path: 'chat/late.md' }, { path: 'chat/comparison-engines.md' }] });
    expect(service.watching().sort()).toEqual([2, 3]);
    service.stop();
    expect(service.watching()).toEqual([]);
  });

  it("stops watching a work item's folder when its window's key closes, even while its conversation stream stays open", () => {
    const { view, service, open, scopes } = setup();
    const mine = open(2);

    expect(service.watching()).toEqual([2]);
    scopes.close(mine.key);
    service.windowClosed();
    expect(service.watching()).toEqual([]);
    service.stop();
  });
});

describe('the web page in the window scope rule (architecture.md § Web page)', () => {
  function setup() {
    const store = Store.open(':memory:');
    const view = world();
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, newKey: () => `k${++keys}` });
    const held = new FakeHeld();
    const focus: Array<[string, boolean]> = [];
    let id = 0;
    const service = new ConversationService({
      store,
      windows: scopes,
      projectsDir: join(dir, 'projects'),
      codexHome: join(dir, 'codex'),
      claudeConfig: join(dir, '.claude.json'),
      screen: async (session) => held.screen(session),
      input: held,
      hooks: () => true,
      now: () => NOW,
      newId: () => String(++id),
      pageList: () => pageList(dockView(view.view, NOW, WINDOWS), view.view),
      pageFocused: (key, focused) => focus.push([key, focused]),
      pageHeader: () => header,
      setSource: (name, enabled) => {
        sourceCalls.push([name, enabled]);
        return name === 'gone' ? 'No source is named gone.' : null;
      },
      pollSources: () => pollRefusal,
      restartHolder: (detail) => {
        restarts.push(detail);
        return pollRefusal;
      },
      runSchedule: (name) => {
        events.push({ type: 'run-schedule', name });
        return name === 'refused' ? { refused: 'nightly already has an open work item.' } : { workItemId: 70 + events.length };
      },
      newStandalone: (folder, provider, model, prompt) => {
        created.push({ kind: 'session', folder, provider, model, prompt });
        return prompt === 'refuse' ? { refused: 'Code Mode sessions need hooks.' } : { workItemId: 50 + created.length };
      },
      newTask: (folder, provider, model, prompt, start) => {
        created.push({ kind: 'task', folder, provider, model, prompt, start });
        return { workItemId: 50 + created.length };
      },
      folderRoots: () => roots,
      rememberFolder: (folder) => remembered.push(folder),
      rowAction: (workItemId, label, snooze) => {
        actions.push([workItemId, label, snooze]);
        return label === 'Approve' ? 'This work item can no longer do that.' : null;
      },
      rowPaste: async (_workItemId, label) => (label === 'Reply' ? 'Dear Ana' : null),
      uploads: join(dir, 'uploads'),
      rowCommand: async (workItemId, label) => {
        commands.push([workItemId, label]);
        return label === 'Open report' ? null : 'This work item can no longer do that.';
      },
      rowMove: (workItemId, after) => {
        moves.push([workItemId, after]);
        return workItemId === 8 ? 'The work item is not in Ready for review.' : null;
      },
      poolAction: (ticketId, label, extra) => {
        pools.push([ticketId, label, extra]);
        return label === 'Start' ? null : 'The ticket no longer offers this.';
      },
      rowOpen: (rowKey, url) => {
        opens.push([rowKey, url]);
        return url === 'https://gone.test/' ? 'The work item no longer links to this.' : null;
      },
      resumeSession: async (sessionId) => {
        resumed.push(sessionId);
        return resumeRefusal;
      },
      log: () => {},
    });
    const actions: Array<[number, string, { until: number | null; comment: string | null; text?: string | null; choice?: string | null }]> = [];
    const sourceCalls: Array<[string, boolean]> = [];
    const events: Array<Record<string, unknown>> = [];
    const created: Array<Record<string, unknown>> = [];
    const remembered: string[] = [];
    const roots = { recent: [] as string[], repoRoots: [] as string[], worktrees: [] as string[] };
    let pollRefusal: string | null = null;
    const refusePoll = (why: string | null) => void (pollRefusal = why);
    const restarts: Array<string | undefined> = [];
    let header: PageHeader = { notices: [], sources: [{ kind: 'github', label: 'GitHub', enabled: true, title: 'gh: on\nClick to stop polling gh', sources: [{ name: 'gh', enabled: true }] }], repoRoots: ['D:/w1'], schedules: [{ name: 'nightly', playbook: 'dev:sweep' }] };
    const setHeader = (next: typeof header) => void (header = next);
    const opens: Array<[string, string]> = [];
    const pools: Array<[number, string, unknown]> = [];
    const moves: Array<[number, number | null]> = [];
    const commands: Array<[number, string]> = [];
    const resumed: string[] = [];
    let resumeRefusal: string | null = null;
    const refuseResume = (why: string | null) => void (resumeRefusal = why);

    stored(store, view);
    scopes.update(view.view);

    const openPage = () => {
      const key = scopes.openPage();
      const frames: Array<{ type: string; [field: string]: unknown }> = [];

      service.open(key, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

      return { key, frames };
    };

    return { store, view, scopes, service, openPage, focus, actions, opens, commands, pools, moves, resumed, refuseResume, held, sourceCalls, setHeader, events, refusePoll, restarts, created, remembered, roots };
  }

  it("runs the list header's Restart and resume for a page key only, answering the hub's refusal (architecture.md § Restarting the holder)", () => {
    const { service, openPage, refusePoll, restarts, scopes, view } = setup();
    const page = openPage();
    const window = 'forged';

    expect(service.pageHolderRestart({ window: page.key, detail: 'Restarting stops the held session.' })).toEqual({ status: 200, body: { started: true } });
    refusePoll('The terminal holder is already restarting.');
    expect(service.pageHolderRestart({ window: page.key })).toEqual({ status: 409, body: { error: 'The terminal holder is already restarting.' } });
    expect(service.pageHolderRestart({ window }).status).toBe(403);
    expect(service.pageHolderRestart({}).status).toBe(400);
    expect(restarts).toEqual(['Restarting stops the held session.', undefined]);
  });

  it("runs More Actions' Refresh sources and Run a schedule now for a page key, in schedules the header offers only", () => {
    const { service, openPage, events, refusePoll, scopes, view } = setup();
    const page = openPage();
    const window = 'forged';

    expect(service.pagePoll({ window: page.key })).toEqual({ status: 200, body: { done: true } });
    refusePoll('Every source is off.');
    expect(service.pagePoll({ window: page.key })).toEqual({ status: 409, body: { error: 'Every source is off.' } });
    expect(service.pagePoll({ window }).status).toBe(403);

    expect(service.pageAdhoc({ window: page.key, opId: 'a7', schedule: 'nightly' })).toEqual({ status: 200, body: { done: true, workItemId: 71 } });
    expect(events.at(-1)).toEqual({ type: 'run-schedule', name: 'nightly' });
    // A retry runs nothing more.
    expect(service.pageAdhoc({ window: page.key, opId: 'a7', schedule: 'nightly' })).toEqual({ status: 200, body: { done: true, workItemId: 71 } });
    expect(service.pageAdhoc({ window: page.key, opId: 'a8', schedule: 'weekly' })).toEqual({ status: 400, body: { error: 'No schedule is named weekly.' } });
    // A prompt is the New session form's, no longer page-adhoc's.
    expect(service.pageAdhoc({ window: page.key, opId: 'a9', prompt: 'Look around', repoRoot: 'D:/w1', start: true, provider: 'codex' }).status).toBe(400);
    expect(service.pageAdhoc({ window, opId: 'a10', schedule: 'nightly' }).status).toBe(403);
    expect(events).toHaveLength(1);
  });

  it('makes the New session form\'s conversation or task in a folder the hub checks, once per opId, and remembers the folder (PRD R122)', () => {
    const { service, openPage, created, remembered, scopes, view } = setup();
    const page = openPage();
    const window = 'forged';
    const folder = join(dir, 'work');

    mkdirSync(folder, { recursive: true });

    // Empty: a conversation now; the page selects it.
    expect(service.newSession({ window: page.key, opId: 's1', folder, provider: 'codex', model: ' gpt-6.2-sol ' })).toEqual({ status: 200, body: { workItemId: 51, folder: realpathSync.native(folder), run: 'now' } });
    expect(created.at(-1)).toEqual({ kind: 'session', folder: realpathSync.native(folder), provider: 'codex', model: 'gpt-6.2-sol', prompt: null });
    expect(remembered).toEqual([realpathSync.native(folder)]);
    expect(service.newSession({ window: page.key, opId: 's1', folder, provider: 'claude' }).status).toBe(200);
    expect(created).toHaveLength(1);
    // A first message as the conversation's first turn, or a task queued or waiting.
    expect(service.newSession({ window: page.key, opId: 's2', folder, provider: 'claude', prompt: '  Find the bug  ', run: 'now' })).toMatchObject({ status: 200, body: { run: 'now' } });
    expect(created.at(-1)).toMatchObject({ kind: 'session', prompt: 'Find the bug' });
    expect(service.newSession({ window: page.key, opId: 's3', folder, provider: 'claude', prompt: 'Sweep', run: 'queue' })).toMatchObject({ status: 200, body: { run: 'queue' } });
    expect(created.at(-1)).toMatchObject({ kind: 'task', prompt: 'Sweep', start: true, model: null });
    expect(service.newSession({ window: page.key, opId: 's4', folder, provider: 'claude', prompt: 'Later', run: 'wait', model: 'opus' })).toMatchObject({ status: 200, body: { run: 'wait' } });
    expect(created.at(-1)).toMatchObject({ kind: 'task', prompt: 'Later', start: false, model: 'opus' });
    // A task needs a message; bad fields, a key that is not a page's, a missing or relative folder and the flow's refusal create nothing.
    expect(service.newSession({ window: page.key, opId: 's5', folder, provider: 'claude', prompt: ' ', run: 'wait' })).toEqual({ status: 400, body: { error: 'A task needs a first message.' } });
    for (const bad of [{ provider: 'gpt' }, { run: 'later' }, { model: ' ' }, { prompt: 7 }, { opId: '' }]) {
      expect(service.newSession({ window: page.key, opId: 's6', folder, provider: 'claude', ...bad }).status).toBe(400);
    }
    expect(service.newSession({ window, opId: 's7', folder, provider: 'claude' }).status).toBe(403);
    expect(service.newSession({ opId: 's7', folder, provider: 'claude' }).status).toBe(403);
    expect(service.newSession({ window: page.key, opId: 's8', folder: join(dir, 'gone'), provider: 'claude' })).toEqual({ status: 400, body: { error: `${join(dir, 'gone')} is not a folder a session can run in.` } });
    expect(service.newSession({ window: page.key, opId: 's9', folder: 'work', provider: 'claude' }).status).toBe(400);
    expect(service.newSession({ window: page.key, opId: 's10', folder, provider: 'claude', prompt: 'refuse' })).toEqual({ status: 409, body: { error: 'Code Mode sessions need hooks.' } });
    expect(created).toHaveLength(5);
  });

  it('keeps a paired device to folders in the recent folders, repo roots and worktrees, and lists folders without dot folders, build output or links out (PRD R122)', async () => {
    const { service, openPage, created, roots } = setup();
    const page = openPage();
    const root = join(dir, 'repo');
    const outside = join(dir, 'outside');

    for (const one of [join(root, 'src'), join(root, 'Docs'), join(root, '.git'), join(root, 'node_modules'), join(root, 'inner'), outside]) {
      mkdirSync(one, { recursive: true });
    }

    writeFileSync(join(root, 'README.md'), '');
    symlinkSync(outside, join(root, 'away'), 'junction');
    symlinkSync(join(root, 'inner'), join(root, 'near'), 'junction');
    roots.repoRoots = [root, join(dir, 'missing')];

    // This computer's page may use any folder; a paired device's only those under the roots, and no link out of them.
    expect(service.newSession({ window: page.key, opId: 'r1', folder: outside, provider: 'claude' }).status).toBe(200);
    expect(service.newSession({ window: page.key, opId: 'r2', folder: outside, provider: 'claude', remote: true })).toMatchObject({ status: 400, body: { error: expect.stringContaining('is not in a recent folder, a repo root or a worktree') } });
    expect(service.newSession({ window: page.key, opId: 'r3', folder: join(root, 'away'), provider: 'claude', remote: true }).status).toBe(400);
    expect(service.newSession({ window: page.key, opId: 'r4', folder: join(root, 'src'), provider: 'claude', remote: true }).status).toBe(200);
    expect(created).toHaveLength(2);

    // The starting places: folders that exist, and the home folder and drives on this computer's page only.
    const local = (await service.pageFolders({ window: page.key })).body as { repoRoots: string[]; computer: string[] };
    expect(local.repoRoots).toEqual([root]);
    expect(local.computer[0]).toBe(homedir());
    expect(((await service.pageFolders({ window: page.key, remote: true })).body as { computer: string[] }).computer).toEqual([]);

    // A listing: subfolders by name, links in only where they stay inside on a paired device, and no parent above a root there.
    const listed = (await service.pageFolders({ window: page.key, path: root })).body as { path: string; parent: string | null; folders: { name: string }[] };
    expect(listed.folders.map((one) => one.name)).toEqual(['away', 'Docs', 'inner', 'near', 'src']);
    expect(listed.parent).toBe(realpathSync.native(dir));
    const remote = (await service.pageFolders({ window: page.key, path: root, remote: true })).body as { parent: string | null; folders: { name: string }[] };
    expect(remote.folders.map((one) => one.name)).toEqual(['Docs', 'inner', 'near', 'src']);
    expect(remote.parent).toBeNull();
    expect(((await service.pageFolders({ window: page.key, path: join(root, 'src'), remote: true })).body as { parent: string }).parent).toBe(realpathSync.native(root));
    expect(await service.pageFolders({ window: page.key, path: outside, remote: true })).toMatchObject({ status: 400 });
    expect(await service.pageFolders({ window: page.key, path: join(root, 'README.md') })).toMatchObject({ status: 400, body: { error: expect.stringContaining('is not a folder') } });
    expect((await service.pageFolders({ window: 'nobody' })).status).toBe(403);
  });

  it("sends the list's header with the list, again when only the header changes, and turns a source on or off for a page key only", () => {
    const { service, openPage, sourceCalls, setHeader, scopes, view } = setup();
    const page = openPage();

    expect(page.frames[0]).toMatchObject({ type: 'hello', header: { sources: [{ kind: 'github', label: 'GitHub', enabled: true, sources: [{ name: 'gh', enabled: true }] }] } });
    service.conversationsChanged();
    expect(page.frames.filter((frame) => frame.type === 'list')).toEqual([]);

    // A source turned off changes only the header, which still reaches the page.
    setHeader({ notices: [], sources: [{ kind: 'github', label: 'GitHub', enabled: false, title: 'gh: not polled', sources: [{ name: 'gh', enabled: false }] }], repoRoots: [], schedules: [] });
    service.conversationsChanged();
    expect(page.frames.at(-1)).toMatchObject({ type: 'list', header: { sources: [{ enabled: false }] } });
    expect(page.frames.at(-1)!['groups']).toBeInstanceOf(Array);

    // A voice problem changes the bell's notices outside a build; `pageListChanged` sends it, and nothing when nothing changed.
    const voice = { id: 'voice', class: 'action' as const, text: 'Voice: the voice process stopped.', at: 1, dismissible: false };
    setHeader({ notices: [voice], sources: [], repoRoots: [], schedules: [] });
    service.pageListChanged();
    expect(page.frames.at(-1)).toMatchObject({ type: 'list', header: { notices: [voice] } });
    const sent = page.frames.length;

    service.pageListChanged();
    expect(page.frames).toHaveLength(sent);

    expect(service.pageSource({ window: page.key, name: 'gh', enabled: true })).toEqual({ status: 200, body: { done: true } });
    expect(service.pageSource({ window: page.key, name: 'gone', enabled: true })).toEqual({ status: 409, body: { error: 'No source is named gone.' } });
    expect(service.pageSource({ window: page.key, name: 'gh', enabled: 'yes' }).status).toBe(400);
    // A window's key, or none, cannot turn sources on or off through the page's command.
    const window = 'forged';

    expect(service.pageSource({ window, name: 'gh', enabled: false }).status).toBe(403);
    expect(service.pageSource({ window: 'nobody', name: 'gh', enabled: false }).status).toBe(403);
    expect(sourceCalls).toEqual([['gh', true], ['gone', true]]);
  });

  it("keeps a page's tabs for its work item in the store, sends them in hello and to the other pages showing it, and refuses another work item", () => {
    const { service, openPage, scopes, view, store } = setup();
    const workItemId = store.workItems(0)[0]!.id;
    const page = openPage();
    const phone = openPage();
    const elsewhere = openPage();

    expect(scopes.select(page.key, workItemId)).toBe(true);
    expect(scopes.select(phone.key, workItemId)).toBe(true);
    expect(service.hello(page.key)['tabs']).toBeNull();

    expect(service.pageTabs({ window: page.key, workItemId, tab: 'artifact:chat/plan.md' })).toEqual({ status: 200, body: { tabs: { tab: 'artifact:chat/plan.md', closed: [] } } });
    expect(service.pageTabs({ window: page.key, workItemId, close: { path: 'chat/old.md', updatedAt: 5, extra: 1 } })).toEqual({ status: 200, body: { tabs: { tab: 'artifact:chat/plan.md', closed: [{ path: 'chat/old.md', updatedAt: 5 }] } } });
    // One artifact at a time: a second device closing another keeps the first, and reopening drops only its own.
    expect(service.pageTabs({ window: phone.key, workItemId, close: { path: 'chat/b.md', updatedAt: 6 } }).body).toEqual({ tabs: { tab: 'artifact:chat/plan.md', closed: [{ path: 'chat/old.md', updatedAt: 5 }, { path: 'chat/b.md', updatedAt: 6 }] } });
    expect(service.pageTabs({ window: phone.key, workItemId, reopen: 'chat/b.md' }).body).toEqual({ tabs: { tab: 'artifact:chat/plan.md', closed: [{ path: 'chat/old.md', updatedAt: 5 }] } });
    expect(store.pageTabs(workItemId)).toEqual({ tab: 'artifact:chat/plan.md', closed: [{ path: 'chat/old.md', updatedAt: 5 }] });
    expect(service.hello(phone.key)['tabs']).toEqual({ tab: 'artifact:chat/plan.md', closed: [{ path: 'chat/old.md', updatedAt: 5 }] });
    // Every page showing the work item hears each change, the sender too, in the order the hub took them; a page elsewhere does not.
    expect(phone.frames.filter((frame) => frame.type === 'tabs')).toHaveLength(4);
    expect(page.frames.filter((frame) => frame.type === 'tabs')).toHaveLength(4);
    expect(page.frames.filter((frame) => frame.type === 'tabs').at(-1)).toMatchObject({ workItemId, tabs: { closed: [{ path: 'chat/old.md', updatedAt: 5 }] } });
    expect(elsewhere.frames.filter((frame) => frame.type === 'tabs')).toEqual([]);
    // The sender's `tabs` carries its request's opId, so it knows the event that first holds its change; the other pages' carry none.
    service.pageTabs({ window: page.key, workItemId, reopen: 'chat/old.md', opId: 'op-1' });
    expect(page.frames.filter((frame) => frame.type === 'tabs').at(-1)).toMatchObject({ workItemId, opId: 'op-1', tabs: { closed: [] } });
    expect(phone.frames.filter((frame) => frame.type === 'tabs').at(-1)).not.toHaveProperty('opId');

    expect(service.pageTabs({ window: elsewhere.key, workItemId, tab: 'console' }).status).toBe(403);
    expect(service.pageTabs({ window: 'forged', workItemId, tab: 'console' }).status).toBe(403);
    // Status or Browser is kept for every work item, and comes in each page's hello.
    expect(service.pageTabs({ window: page.key, workItemId, openOn: 'browser' }).status).toBe(200);
    expect(store.pagePref('openOn')).toBe('browser');
    expect(service.hello(phone.key)['openOn']).toBe('browser');
    expect(service.pageTabs({ window: page.key, workItemId, openOn: 'history' }).status).toBe(200);
    expect(store.pagePref('openOn')).toBe('history');
    // Status, from before History took its place, is kept as History, and one kept before reads as History.
    service.pageTabs({ window: page.key, workItemId, openOn: 'browser' });
    expect(service.pageTabs({ window: page.key, workItemId, openOn: 'status' }).status).toBe(200);
    expect(store.pagePref('openOn')).toBe('history');
    store.setPagePref('openOn', 'status');
    expect(service.hello(phone.key)['openOn']).toBe('history');
    expect(service.pageTabs({ window: page.key, workItemId, tab: 'status' }).status).toBe(400);
    expect(service.pageTabs({ window: page.key, workItemId, openOn: 'console' }).status).toBe(400);
    expect(service.pageTabs({ window: page.key, workItemId, tab: 'conversation' }).status).toBe(400);
    expect(service.pageTabs({ window: page.key, workItemId, close: { path: 3 } }).status).toBe(400);
    expect(service.pageTabs({ window: page.key, workItemId, reopen: '' }).status).toBe(400);
    expect(service.pageTabs({ window: page.key, workItemId: 'x', tab: 'console' }).status).toBe(400);
    expect(store.pageTabs(workItemId)!.tab).toBe('artifact:chat/plan.md');
  });

  it("answers a page's History of a ticket the store knows, with the chips' categories, for a page key only", () => {
    const { service, openPage, scopes, view, store } = setup();
    const page = openPage();
    const window = 'forged';
    const ticketId = view.view.workItems[0]!.ticket.id;
    const answer = service.pageHistory({ window: page.key, ticketId });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ view: { key: expect.any(String), title: store.ticket(ticketId)!.title, sections: expect.any(Array) }, categories: expect.arrayContaining([{ key: 'you', label: 'You', icon: 'account' }]) });
    expect(service.pageHistory({ window: page.key, ticketId: 999 })).toEqual({ status: 409, body: { error: 'Unknown ticket 999.' } });
    expect(service.pageHistory({ window: page.key, ticketId: 'one' }).status).toBe(400);
    expect(service.pageHistory({ window, ticketId }).status).toBe(403);
  });

  it("sends the page that raises alerts, and no other page or window, the work items that started needing the operator with their needs-you message (PRD R65)", () => {
    const { service, openPage, scopes, view } = setup();
    const page = openPage();
    const other = openPage();
    const window = 'forged';
    const frames: Array<{ type: string }> = [];

    service.open(window, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));
    service.pageNeeds(page.key, [{ workItemId: 2, message: 'gh 2 is waiting for your answer.' }], true);
    expect(page.frames.at(-1)).toMatchObject({ type: 'needs', items: [{ workItemId: 2, message: 'gh 2 is waiting for your answer.' }], sound: true });
    expect(other.frames.some((frame) => frame.type === 'needs')).toBe(false);
    // A window key is never sent one.
    service.pageNeeds(window, [{ workItemId: 2, message: 'gh 2 is waiting for your answer.' }], false);
    expect(frames.some((frame) => frame.type === 'needs')).toBe(false);
  });

  it('starts a page unbound with its key and list, binds it to any work item it selects, and holds it to that work item', () => {
    const { scopes, service, openPage, view } = setup();
    const page = openPage();

    expect(scopes.isPage(page.key)).toBe(true);
    expect(page.frames[0]).toMatchObject({ type: 'hello', scope: null, key: page.key });
    // The list is the list view's groups, with its rows of the work items.
    const listed = (page.frames[0]!['groups'] as Array<{ key: string; rows: Array<{ workItemId: number; title: string }> }>).flatMap((group) => group.rows);

    expect(listed.map((row) => row.workItemId).sort()).toEqual([1, 2, 3]);
    // A done work item is listed in Done.
    expect((page.frames[0]!['groups'] as Array<{ key: string; rows: Array<{ workItemId: number }> }>).find((group) => group.key === 'done')?.rows.map((row) => row.workItemId)).toEqual([1]);
    expect(listed.find((row) => row.workItemId === 3)?.title).toBe('Issue <3>');
    expect(service.send({ window: page.key, scopeGen: 0, opId: 'o', sessionId: 's2', launch: null, text: 'hi' }).status).toBe(403);

    // Any work item, where a window may select only its own conversations.
    expect(service.select({ window: page.key, opId: 'o1', workItemId: 3 })).toEqual({ status: 200, body: { scopeGen: 1 } });
    expect(scopes.scope(page.key)).toMatchObject({ kind: 'page', workItemId: 3, sessionId: 's3', cwd: 'D:/w3', conversations: [{ workItemId: 3, primary: true }] });
    expect(page.frames.map((frame) => frame.type)).toEqual(['hello', 'scope', 'hello']);
    expect(page.frames[2]).toMatchObject({ scope: { kind: 'page', workItemId: 3 }, key: page.key });

    // From then on the scope rule holds: another work item's session is refused.
    expect(service.history({ window: page.key, scopeGen: 1, opId: 'o2', sessionId: 's2', before: null }).status).toBe(403);
    expect(service.history({ window: page.key, scopeGen: 1, opId: 'o2', sessionId: 's3', before: null }).status).toBe(200);
    expect(service.select({ window: page.key, opId: 'o3', workItemId: 99 }).status).toBe(403);
    expect(view.view.workItems).toHaveLength(3);
  });

  it('lists a hosted conversation with its host, and gives the page the host group as its conversations', () => {
    const { store, scopes, service, openPage, view } = setup();
    const ticket = store.insertTicket({ source: 'adhoc', sourceKey: 'h', ref: '#h', sourceId: null, title: 'Side chat', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: NOW, lastPolledAt: null, repoRoot: 'D:/w12', hostWindow: view.file });
    const hosted = store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: 'running', createdAt: NOW } as never);
    const snap = snapshot([...view.view.workItems, item(hosted.id, { ticketId: ticket.id, ticket: { ...view.current.ticket, id: ticket.id, title: 'Side chat', hostWindow: view.file } })]);

    view.view = snap;
    scopes.update(snap);

    const page = openPage();

    // The hosted conversation is listed in the group the list view puts it in, under its host's name, as its host is.
    expect(service.pageList().flatMap((group) => group.rows).find((row) => row.workItemId === hosted.id)).toMatchObject({ title: 'Side chat', host: expect.any(String) });
    expect(service.pageList().map((group) => group.key)).not.toContain('conversations');
    service.select({ window: page.key, opId: 'o', workItemId: hosted.id });
    expect(scopes.scope(page.key)?.conversations).toEqual([{ workItemId: 2, primary: true }, { workItemId: hosted.id, primary: false }]);
    // Done while selected, it stays in its host's group.
    const done = snapshot([...view.view.workItems.filter((one) => one.id !== hosted.id), item(hosted.id, { ticketId: ticket.id, status: 'done', ticket: { ...view.current.ticket, id: ticket.id, title: 'Side chat', hostWindow: view.file } })]);

    store.updateWorkItem(hosted.id, { status: 'done' });
    view.view = done;
    scopes.update(done);
    expect(scopes.scope(page.key)?.conversations).toEqual([{ workItemId: 2, primary: true }, { workItemId: hosted.id, primary: false }]);
    expect(service.select({ window: page.key, opId: 'o', workItemId: 2 }).status).toBe(200);
    expect(scopes.scope(page.key)).toMatchObject({ workItemId: 2, scopeGen: 2 });
  });

  it("reports a page's focus only for a page key, and ends the page's key with its stream", () => {
    const { scopes, service, openPage, view, focus } = setup();
    const page = openPage();
    const window = 'forged';

    expect(service.pageFocus({ window: page.key, focused: true })).toEqual({ status: 200, body: { focused: true } });
    expect(service.pageFocus({ window, focused: true }).status).toBe(403);
    expect(service.pageFocus({ window: page.key }).status).toBe(400);
    expect(focus).toEqual([[page.key, true]]);

    scopes.close(page.key);
    expect(scopes.isPage(page.key)).toBe(false);
    expect(service.select({ window: page.key, opId: 'o', workItemId: 2 }).status).toBe(403);
  });

  it("runs a row action only on the page's selected work item, for a page key and its scope generation, once per opId", async () => {
    const { scopes, service, openPage, view, actions } = setup();
    const page = openPage();
    const window = 'forged';

    expect(service.rowAction({ window: page.key, scopeGen: 0, opId: 'a', workItemId: 3, label: 'Start' }).status).toBe(403);
    service.select({ window: page.key, opId: 'o', workItemId: 3 });

    expect(service.rowAction({ window: page.key, scopeGen: 1, opId: 'a', workItemId: 2, label: 'Start' }).status).toBe(403);
    expect(service.rowAction({ window, scopeGen: 1, opId: 'a', workItemId: 2, label: 'Start' }).status).toBe(403);
    expect(service.rowAction({ window: page.key, scopeGen: 0, opId: 'a', workItemId: 3, label: 'Start' })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.rowAction({ window: page.key, scopeGen: 1, opId: 'a', workItemId: 3, label: 'Snooze…', until: 'soon' }).status).toBe(400);
    // A control is named by its label, never by its action type.
    expect(service.rowAction({ window: page.key, scopeGen: 1, opId: 'a', workItemId: 3, action: 'start' }).status).toBe(400);
    expect(actions).toEqual([]);

    expect(service.rowAction({ window: page.key, scopeGen: 1, opId: 'a', workItemId: 3, label: 'Snooze…', until: 5, comment: '  later ' })).toEqual({ status: 200, body: { done: true } });
    expect(service.rowAction({ window: page.key, scopeGen: 1, opId: 'a', workItemId: 3, label: 'Snooze…', until: 5 })).toEqual({ status: 200, body: { done: true } });
    expect(service.rowAction({ window: page.key, scopeGen: 1, opId: 'b', workItemId: 3, label: 'Approve' })).toEqual({ status: 409, body: { error: 'This work item can no longer do that.' } });
    expect(service.rowAction({ window: page.key, scopeGen: 1, opId: 'c', workItemId: 3, label: 'Add comment…', text: 'Asked Ana', choice: null }).status).toBe(200);
    expect(service.rowAction({ window: page.key, scopeGen: 1, opId: 'd', workItemId: 3, label: 'Add comment…', text: 5 }).status).toBe(400);
    expect(service.rowAction({ window: page.key, scopeGen: 1, opId: 'd', workItemId: 3, label: 'Add comment…', text: 'x'.repeat(100_001) }).status).toBe(400);
    expect(actions).toEqual([
      [3, 'Snooze…', { until: 5, comment: 'later', text: null, choice: null }],
      [3, 'Approve', { until: null, comment: null, text: null, choice: null }],
      [3, 'Add comment…', { until: null, comment: null, text: 'Asked Ana', choice: null }],
    ]);

    expect(await service.rowPaste({ window: page.key, scopeGen: 1, opId: 'c', workItemId: 3, label: 'Reply' })).toEqual({ status: 200, body: { text: 'Dear Ana' } });
    expect((await service.rowPaste({ window: page.key, scopeGen: 1, opId: 'c', workItemId: 3, label: 'Other' })).status).toBe(409);
    expect((await service.rowPaste({ window: page.key, scopeGen: 1, opId: 'c', workItemId: 2, label: 'Reply' })).status).toBe(403);
  });

  it("writes a file the page attaches only for its selected conversation's session that can take a message, at its scope generation", () => {
    const { store, scopes, service, openPage, view } = setup();
    const page = openPage();
    const window = 'forged';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

    expect(service.pageUpload(page.key, 0, 'a.png', png).status).toBe(403);
    service.select({ window: page.key, opId: 'o', workItemId: 3 });
    expect(service.pageUpload(window, 1, 'a.png', png).status).toBe(403);
    expect(service.pageUpload(page.key, 0, 'a.png', png)).toEqual({ status: 409, body: { error: "The window's conversation changed." } });

    const written = service.pageUpload(page.key, 1, 'a.png', png);
    const path = (written.body as { path: string }).path;

    expect(written).toEqual({ status: 200, body: { path: expect.stringMatching(/[\\/]uploads[\\/]pasted-\d{8}-\d{6}-[0-9a-f]{6}\.png$/), image: true } });
    expect(readFileSync(path)).toEqual(png);
    expect(service.pageUpload(page.key, 1, 'notes.png', Buffer.from('hello'))).toEqual({ status: 400, body: { error: 'notes.png is not a PNG, JPEG, GIF or WebP image.' } });

    // A session the page cannot talk to takes no file.
    store.updateSession('s3', { codeMode: false });
    expect(service.pageUpload(page.key, 1, 'b.txt', Buffer.from('b'))).toMatchObject({ status: 409 });
  });

  it("runs Open in VS Code only on the page's selected work item, for its scope generation, once per opId", async () => {
    const { scopes, service, openPage, view, commands } = setup();
    const page = openPage();
    const window = 'forged';

    expect((await service.rowCommand({ window: page.key, scopeGen: 0, opId: 'a', workItemId: 3, label: 'Open report' })).status).toBe(403);
    service.select({ window: page.key, opId: 'o', workItemId: 3 });
    expect((await service.rowCommand({ window: page.key, scopeGen: 1, opId: 'a', workItemId: 2, label: 'Open report' })).status).toBe(403);
    expect((await service.rowCommand({ window, scopeGen: 1, opId: 'a', workItemId: 2, label: 'Open report' })).status).toBe(403);
    expect((await service.rowCommand({ window: page.key, scopeGen: 0, opId: 'a', workItemId: 3, label: 'Open report' })).status).toBe(409);
    expect((await service.rowCommand({ window: page.key, scopeGen: 1, opId: 'a', workItemId: 3 })).status).toBe(400);
    expect(commands).toEqual([]);
    expect(await service.rowCommand({ window: page.key, scopeGen: 1, opId: 'a', workItemId: 3, label: 'Open report' })).toEqual({ status: 200, body: { done: true } });
    expect(await service.rowCommand({ window: page.key, scopeGen: 1, opId: 'a', workItemId: 3, label: 'Open report' })).toEqual({ status: 200, body: { done: true } });
    expect(await service.rowCommand({ window: page.key, scopeGen: 1, opId: 'b', workItemId: 3, label: 'History' })).toEqual({ status: 409, body: { error: 'This work item can no longer do that.' } });
    expect(commands).toEqual([[3, 'Open report'], [3, 'History']]);
  });

  it("opens a listed row's link for a page key on any work item, not only the selected one, once per opId, and says why not", () => {
    const { scopes, service, openPage, view, opens } = setup();
    const page = openPage();
    const window = 'forged';

    expect(service.rowOpen({ window, opId: 'a', workItemId: 2, url: 'https://x.test/' }).status).toBe(403);
    expect(service.rowOpen({ window: page.key, opId: 'a', workItemId: 2 }).status).toBe(400);
    expect(service.rowOpen({ window: page.key, opId: '', workItemId: 2, url: 'https://x.test/' }).status).toBe(400);
    expect(opens).toEqual([]);
    // No select first: a pill opens on an unselected row.
    expect(service.rowOpen({ window: page.key, opId: 'a', workItemId: 2, url: 'https://x.test/' })).toEqual({ status: 200, body: { opened: true } });
    expect(service.rowOpen({ window: page.key, opId: 'a', workItemId: 2, url: 'https://x.test/' })).toEqual({ status: 200, body: { opened: true } });
    expect(service.rowOpen({ window: page.key, opId: 'b', workItemId: 3, url: 'https://gone.test/' })).toEqual({ status: 409, body: { error: 'The work item no longer links to this.' } });
    // A pool ticket's row, by its ticket.
    expect(service.rowOpen({ window: page.key, opId: 'c', ticketId: 9, url: 'https://x.test/9' }).status).toBe(200);
    expect(service.rowOpen({ window: page.key, opId: 'd', ticketId: 9, workItemId: 2, url: 'https://x.test/9' }).status).toBe(400);
    expect(opens).toEqual([['item:2', 'https://x.test/'], ['item:3', 'https://gone.test/'], ['ticket:9', 'https://x.test/9']]);
  });

  it("runs a pool ticket's control for a page key without a selection, once per opId, and says why not", () => {
    const { scopes, service, openPage, view, pools } = setup();
    const page = openPage();
    const window = 'forged';

    expect(service.poolAction({ window, opId: 'a', ticketId: 9, label: 'Start' }).status).toBe(403);
    expect(service.poolAction({ window: page.key, opId: 'a', ticketId: '9', label: 'Start' }).status).toBe(400);
    expect(service.poolAction({ window: page.key, opId: 'a', ticketId: 9, label: 'Start', text: 7 }).status).toBe(400);
    expect(pools).toEqual([]);
    expect(service.poolAction({ window: page.key, opId: 'a', ticketId: 9, label: 'Start' })).toEqual({ status: 200, body: { done: true } });
    expect(service.poolAction({ window: page.key, opId: 'a', ticketId: 9, label: 'Start' })).toEqual({ status: 200, body: { done: true } });
    expect(service.poolAction({ window: page.key, opId: 'b', ticketId: 9, label: 'Start with guidance…', text: 'Use staging', choice: 'dev:fix' })).toEqual({ status: 409, body: { error: 'The ticket no longer offers this.' } });
    expect(pools).toEqual([
      [9, 'Start', { until: null, comment: null, text: null, choice: null }],
      [9, 'Start with guidance…', { until: null, comment: null, text: 'Use staging', choice: 'dev:fix' }],
    ]);
  });

  it("moves a dragged Ready for review row for a page key without a selection, once per opId, and says why not (PRD R73)", () => {
    const { scopes, service, openPage, view, moves } = setup();
    const page = openPage();
    const window = 'forged';

    expect(service.rowMove({ window, opId: 'a', workItemId: 3, after: null }).status).toBe(403);
    expect(service.rowMove({ window: page.key, opId: 'a', workItemId: '3', after: null }).status).toBe(400);
    expect(service.rowMove({ window: page.key, opId: 'a', workItemId: 3 }).status).toBe(400);
    expect(service.rowMove({ window: page.key, opId: 'a', workItemId: 3, after: 1.5 }).status).toBe(400);
    expect(service.rowMove({ window: page.key, opId: '', workItemId: 3, after: null }).status).toBe(400);
    expect(moves).toEqual([]);
    expect(service.rowMove({ window: page.key, opId: 'a', workItemId: 3, after: 4 })).toEqual({ status: 200, body: { done: true } });
    expect(service.rowMove({ window: page.key, opId: 'a', workItemId: 3, after: 4 })).toEqual({ status: 200, body: { done: true } });
    expect(service.rowMove({ window: page.key, opId: 'b', workItemId: 3, after: null })).toEqual({ status: 200, body: { done: true } });
    expect(service.rowMove({ window: page.key, opId: 'c', workItemId: 8, after: 3 })).toEqual({ status: 409, body: { error: 'The work item is not in Ready for review.' } });
    expect(moves).toEqual([[3, 4], [3, null], [8, 3]]);
  });

  it("resumes the page's own current session once it has ended, and only that", async () => {
    const { store, scopes, service, openPage, view, resumed, refuseResume } = setup();
    const page = openPage();
    const window = 'forged';

    service.select({ window: page.key, opId: 'o', workItemId: 3 });
    expect((await service.resume({ window: page.key, scopeGen: 1, opId: 'r', sessionId: 's3' })).body).toEqual({ error: 'The session has not ended.' });
    store.updateSession('s3', { state: 'ended' });
    expect((await service.resume({ window: page.key, scopeGen: 1, opId: 'r', sessionId: 's2' })).status).toBe(403);
    expect((await service.resume({ window: page.key, scopeGen: 0, opId: 'r', sessionId: 's3' })).status).toBe(409);
    expect((await service.resume({ window, scopeGen: 1, opId: 'r', sessionId: 's3' })).status).toBe(403);
    expect(resumed).toEqual([]);

    expect(await service.resume({ window: page.key, scopeGen: 1, opId: 'r', sessionId: 's3' })).toEqual({ status: 200, body: { resumed: true } });
    refuseResume('Session s3 still has 1 process from its previous run (pid 9). Stop them or wait for them to end.');
    expect(await service.resume({ window: page.key, scopeGen: 1, opId: 'r2', sessionId: 's3' })).toEqual({ status: 409, body: { error: 'Session s3 still has 1 process from its previous run (pid 9). Stop them or wait for them to end.' } });
    expect(resumed).toEqual(['s3', 's3']);
  });

  it("lists a work item's earlier sessions on the page's dropdown, newest first, and shows one read-only on request (architecture.md § Web page)", async () => {
    const { store, scopes, service, openPage, view } = setup();
    const page = openPage();
    const window = 'forged';
    const later = (id: string, kind: 'setup' | 'task', at: number) => store.insertSession(session({ id, workItemId: 3, kind, shortId: id, cwd: 'D:/w3', codeMode: true, nativeSessionId: `n-${id}`, state: 'idle', startedAt: at }) as StoredSession);
    const entry = () => service.scopeView(scopes.scope(page.key))!.conversations[0]!;

    // s3 was the setup run, in the repository's root; Approve, a retry or a reopen starts another session of the same work item.
    store.updateSession('s3', { kind: 'setup', shortId: 's3', state: 'ended', startedAt: NOW - 3_000, cwd: 'D:/repo' });
    later('s4', 'task', NOW - 2_000);
    later('s5', 'task', NOW - 1_000);
    // s5's transcript has names: Claude Code's latest /rename (custom-title) wins over its latest ai-title, earlier or later.
    const transcript = join(dir, 'projects', 'D--w3', 'n-s5.jsonl');

    mkdirSync(join(dir, 'projects', 'D--w3'), { recursive: true });
    writeFileSync(transcript, [{ type: 'ai-title', aiTitle: 'Badge count work' }, { type: 'custom-title', customTitle: 'Badge fix' }, { type: 'ai-title', aiTitle: 'Later automatic title' }].map((line) => JSON.stringify(line) + '\n').join(''));
    // A session is named by its first message that stands, cut to a sentence, never by its ID; one with none by its kind.
    const message = (id: string, sessionId: string, text: string, withdrawn = false) => store.addMessage({ id, sessionId, workItemId: 3, at: NOW, origin: 'typed', text, transcriptUuid: null, provisional: false, withdrawn, delivery: 'sent', error: null, opId: id, pastedAt: NOW });
    message('m4a', 's4', 'Dropped draft', true);
    message('m4b', 's4', 'Please fix the badge count. Then run the tests.');
    message('m4c', 's4', 'And the dock too');
    service.select({ window: page.key, opId: 'o', workItemId: 3 });
    expect(scopes.scope(page.key)).toMatchObject({ workItemId: 3, sessionId: 's5' });
    expect(scopes.scope(page.key)!.earlier).toBeUndefined();
    expect(entry()).toMatchObject({ workItemId: 3, sessionId: 's5' });
    expect(entry().sessions).toEqual([
      { sessionId: 's4', title: 'fix the badge count', state: 'idle', startedAt: NOW - 2_000, provider: 'claude' },
      { sessionId: 's3', title: 'Setup session', state: 'ended', startedAt: NOW - 3_000, provider: 'claude' },
    ]);
    // The current session is named as the earlier ones are, by its CLI's name for it.
    expect(entry().sessionTitle).toBe('Badge fix');
    // Its start, where the earlier sessions' timelines end on the page.
    expect(entry().sessionStartedAt).toBe(NOW - 1_000);

    // A Codex thread by its latest name in Codex's session index, once it has one; a rename reaches the page's dropdown on the next poll.
    const codexIndex = join(dir, 'codex', 'session_index.jsonl');
    const named = () => page.frames.filter((frame) => frame.type === 'conversations').length;

    mkdirSync(join(dir, 'codex'), { recursive: true });
    store.updateSession('s4', { provider: 'codex' });
    writeFileSync(codexIndex, JSON.stringify({ id: 'n-s4', thread_name: 'Fix the badge', updated_at: '' }) + '\n');
    const before = named();

    await service.poll();
    expect(named()).toBe(before + 1);
    expect(entry()).toMatchObject({ sessionTitle: 'Badge fix', sessions: [{ sessionId: 's4', title: 'Fix the badge', provider: 'codex' }, { sessionId: 's3', title: 'Setup session' }] });
    appendFileSync(transcript, JSON.stringify({ type: 'custom-title', customTitle: 'Badge count, renamed' }) + '\n');
    appendFileSync(codexIndex, JSON.stringify({ id: 'n-s4', thread_name: 'Badge, take two', updated_at: '' }) + '\n');
    await service.poll();
    expect(named()).toBe(before + 2);
    expect(page.frames.at(-1)).toMatchObject({ type: 'conversations', conversations: [{ sessionTitle: 'Badge count, renamed', sessions: [{ title: 'Badge, take two' }, { title: 'Setup session' }] }] });
    // Nothing renamed, nothing sent.
    await service.poll();
    expect(named()).toBe(before + 2);

    // The page opens the ended setup session read-only.
    expect(service.select({ window: page.key, opId: 'o', workItemId: 3, sessionId: 's3' }).status).toBe(200);
    const shown = scopes.scope(page.key)!;
    const hello = service.hello(page.key) as { scope: { earlier?: boolean; sessionId: string }; sessions: Array<{ id: string; conversation: string; reason: string | null }> };

    // The work item's folder stays the current session's, so its artifacts and changes stay its own.
    expect(shown).toMatchObject({ workItemId: 3, sessionId: 's3', earlier: true, cwd: 'D:/w3' });
    expect(hello.scope).toMatchObject({ sessionId: 's3', earlier: true });
    expect(hello.sessions).toMatchObject([{ id: 's3', conversation: 'read-only', reason: 'This is an earlier session of the work item, shown read-only.' }]);
    // An earlier session that still runs, as an older held one can, is read-only too: nothing types into it, resumes it or pins it.
    expect(service.select({ window: page.key, opId: 'o', workItemId: 3, sessionId: 's4' }).status).toBe(200);
    const gen = scopes.scope(page.key)!.scopeGen;

    expect((service.hello(page.key) as { sessions: Array<{ conversation: string }> }).sessions[0]!.conversation).toBe('read-only');
    expect(service.send({ window: page.key, scopeGen: gen, opId: 'm', sessionId: 's4', launch: null, text: 'hi' })).toEqual({ status: 409, body: { error: 'This is an earlier session of the work item, shown read-only.' } });
    expect((await service.resume({ window: page.key, scopeGen: gen, opId: 'r', sessionId: 's4' })).body).toEqual({ error: 'This is an earlier session of the work item, shown read-only.' });
    expect(service.pageUpload(page.key, gen, 'a.txt', Buffer.from('a')).body).toEqual({ error: 'This is an earlier session of the work item, shown read-only.' });
    expect(service.dictate(page.key, 's4', 'hi', [], false)).toEqual({ refused: 'This is an earlier session of the work item, shown read-only.' });
    // Reading it is allowed.
    expect(service.history({ window: page.key, scopeGen: gen, sessionId: 's4', before: null }).status).toBe(200);
    expect(service.states({ window: page.key, scopeGen: gen, sessionId: 's4', before: null }).status).toBe(200);

    // A newer session keeps the page on the one it chose; the dropdown lists the session that was current.
    later('s6', 'task', NOW);
    scopes.update(view.view);
    expect(scopes.scope(page.key)).toMatchObject({ sessionId: 's4', earlier: true });
    expect(entry().sessions!.map((one) => one.sessionId)).toEqual(['s5', 's4', 's3']);

    // The current session again, by naming it or none; another work item's session, or a session from another window, is refused.
    expect(service.select({ window: page.key, opId: 'o', workItemId: 3, sessionId: 's6' }).status).toBe(200);
    expect(scopes.scope(page.key)).toMatchObject({ sessionId: 's6' });
    expect(scopes.scope(page.key)!.earlier).toBeUndefined();
    expect(service.select({ window: page.key, opId: 'o', workItemId: 3, sessionId: 's2' }).status).toBe(403);
    expect(service.select({ window: page.key, opId: 'o', workItemId: 3, sessionId: 5 }).status).toBe(400);
    expect(service.select({ window, opId: 'o', workItemId: 2, sessionId: 's2' }).status).toBe(403);
    expect(service.select({ window: page.key, opId: 'o', workItemId: 3, sessionId: 's5' }).status).toBe(200);
    expect(service.select({ window: page.key, opId: 'o', workItemId: 3 }).status).toBe(200);
    expect(scopes.scope(page.key)).toMatchObject({ sessionId: 's6' });
  });

  it("shows the page its session's permission prompt from the screen and presses only that prompt's keys, under the input reservation", async () => {
    const { store, service, openPage, held } = setup();
    const page = openPage();
    const prompt = readFileSync(join(import.meta.dirname, '..', '..', 'conversation', 'test', 'fixtures', 'prompts', 'permission.txt'), 'utf8').split('\n');
    const ask = (body: Record<string, unknown> = {}) => service.prompt({ window: page.key, scopeGen: 1, opId: 'p', sessionId: 's3', ...body });
    const press = (key: string, opId: string, id: string) => service.promptKey({ window: page.key, scopeGen: 1, opId, sessionId: 's3', launch: null, prompt: id, key });

    service.select({ window: page.key, opId: 'o', workItemId: 3 });
    held.shown = prompt;
    expect((await ask()).body).toEqual({ error: 'The session is not waiting on a prompt.' });
    store.updateSession('s3', { state: 'waiting', stateDetail: PERMISSION_PROMPT });

    const shown = ((await ask()).body as { prompt: { id: string; options: Array<{ key: string }> } }).prompt;

    expect(shown.options.map((option) => option.key)).toEqual(['1', '2', '3', '4']);
    expect((await ask({ sessionId: 's2' })).status).toBe(403);
    expect((await ask({ scopeGen: 0 })).status).toBe(409);

    // A key for a prompt the screen no longer shows, a choice it lacks, or right after a terminal key is never written.
    expect((await press('1', 'k1', 'stale')).body).toEqual({ error: 'The terminal shows something else now. Answer there, or try again here.' });
    expect((await press('7', 'k2', shown.id)).body).toEqual({ error: 'The prompt has no such choice.' });
    expect((await press('next', 'k3', shown.id)).status).toBe(409);
    held.keyAt = NOW - 500;
    expect((await press('1', 'k4', shown.id)).body).toEqual({ error: 'A key was just typed in the terminal. Try again in a moment.' });
    expect((await press('Enter', 'k5', shown.id)).status).toBe(400);
    expect(held.writes).toEqual([]);

    held.keyAt = null;
    // A retry while the first is still pressing gets its answer and presses nothing more.
    expect(await Promise.all([press('1', 'k6', shown.id), press('1', 'k6', shown.id)])).toEqual([{ status: 200, body: { done: true } }, { status: 200, body: { done: true } }]);
    expect(await press('escape', 'k7', shown.id)).toEqual({ status: 200, body: { done: true } });
    expect(held.writes).toEqual(['1', '\u001b']);
    expect(held.reservations.length).toBe(held.released);
    expect(held.reservations.at(-1)).toEqual({ sessionId: 's3', launch: null });

    held.refuse = 'The session is ending.';
    expect((await press('1', 'k8', shown.id)).body).toEqual({ error: 'The session is ending.' });
    expect(held.writes).toHaveLength(2);
  });

  it("starts New conversation…'s session in the work item the page shows, with the draft's first message, once per opId (architecture.md § Web page)", () => {
    const made: Array<[number, string, string | undefined]> = [];
    let refuse: string | null = null;
    const store = Store.open(':memory:');
    const view = world();
    const scopes = new WindowScopes({ store, windows: WINDOWS, newKey: () => 'pk' });
    const service = new ConversationService({
      store,
      windows: scopes,
      projectsDir: join(dir, 'projects'),
      claudeConfig: join(dir, '.claude.json'),
      screen: async () => null,
      input: new FakeHeld(),
      hooks: () => true,
      now: () => NOW,
      newId: () => 'id',
      newItemSession: (workItemId, prompt, provider) => {
        if (refuse !== null) return { refused: refuse };
        made.push([workItemId, prompt, provider]);
        return { sessionId: `new-${made.length}` };
      },
      log: () => {},
    });

    stored(store, view);
    scopes.update(view.view);

    const page = scopes.openPage();

    expect(service.pageConversation({ window: page, scopeGen: 0, opId: 'n', text: 'Hi' }).status).toBe(403);
    service.select({ window: page, opId: 'o', workItemId: 3 });
    expect(service.pageConversation({ window: page, scopeGen: 0, opId: 'n', text: 'Hi' }).status).toBe(409);
    expect(service.pageConversation({ window: page, scopeGen: 1, opId: 'n', text: 'Hi', provider: 'gpt' }).status).toBe(400);
    expect(service.pageConversation({ window: page, scopeGen: 1, opId: 'n' }).status).toBe(400);
    expect(service.pageConversation({ window: page, scopeGen: 1, opId: 'n', text: '  ' })).toEqual({ status: 400, body: { error: 'Write the first message of the new conversation.' } });
    expect(made).toEqual([]);

    // The work item is the page's, never one it names; the flow's refusal comes back as it is.
    refuse = 'A session of this work item is in a turn.';
    expect(service.pageConversation({ window: page, scopeGen: 1, opId: 'r', text: 'Hi', workItemId: 2 })).toEqual({ status: 409, body: { error: refuse } });
    refuse = null;
    expect(service.pageConversation({ window: page, scopeGen: 1, opId: 'n', text: 'Why did it fail?', provider: 'codex', workItemId: 2 })).toEqual({ status: 200, body: { workItemId: 3, sessionId: 'new-1' } });
    expect(made).toEqual([[3, 'Why did it fail?', 'codex']]);
    // The page shows the new session, its work item's current one, with a new scope generation.
    expect(scopes.scope(page)).toMatchObject({ workItemId: 3, scopeGen: 2 });
    expect(scopes.scope(page)!.earlier).not.toBe(true);

    // A retry of the same send starts nothing more, even after the scope moved on.
    expect(service.pageConversation({ window: page, scopeGen: 1, opId: 'n', text: 'Why did it fail?', provider: 'codex' })).toEqual({ status: 200, body: { workItemId: 3, sessionId: 'new-1' } });
    expect(made).toHaveLength(1);

    // So does one from the page reconnected under a new key and scope generation, while it shows the same work item.
    const again = scopes.openPage();

    service.select({ window: again, opId: 'o2', workItemId: 3 });
    expect(service.pageConversation({ window: again, scopeGen: scopes.scope(again)!.scopeGen, opId: 'n', text: 'Why did it fail?' })).toEqual({ status: 200, body: { workItemId: 3, sessionId: 'new-1' } });
    expect(made).toHaveLength(1);
    // A page showing another work item gets no answer of it, and a stale scope generation is refused as any other.
    service.select({ window: again, opId: 'o3', workItemId: 2 });
    expect(service.pageConversation({ window: again, scopeGen: 0, opId: 'n', text: 'Why did it fail?' }).status).toBe(409);
    expect(made).toHaveLength(1);
  });

  it("unbinds a page whose work item was deleted, raising its scope generation", () => {
    const { store, scopes, service, openPage, view } = setup();
    const page = openPage();

    service.select({ window: page.key, opId: 'o', workItemId: 3 });
    store.deleteWorkItem(3);
    expect(scopes.update(view.view)).toContain(page.key);
    expect(scopes.scope(page.key)).toBeNull();
  });

  it("serves a page only its selected work item's artifacts and files", async () => {
    const { service, openPage, store } = setup();
    const page = openPage();
    const folder = join(dir, 'w3');

    mkdirSync(join(folder, '.wip', 'artifacts', 'w3', 'chat'), { recursive: true });
    mkdirSync(join(folder, '.wip', 'artifacts', 'w2', 'chat'), { recursive: true });
    writeFileSync(join(folder, '.wip', 'artifacts', 'w3', 'chat', 'plan.md'), '# Plan');
    writeFileSync(join(folder, '.wip', 'artifacts', 'w2', 'chat', 'other.md'), '# Other');
    writeFileSync(join(folder, 'readme.md'), '');
    store.insertSession(session({ id: 's3b', workItemId: 3, cwd: folder, codeMode: true }) as StoredSession);

    expect(service.artifactFile(page.key, 'chat/plan.md')).toBeNull();
    expect(await service.files(page.key, '')).toBeNull();
    service.select({ window: page.key, opId: 'o', workItemId: 3 });
    expect(service.artifactFile(page.key, 'chat/plan.md')).toMatchObject({ mime: 'text/markdown; charset=utf-8' });
    expect(service.artifactFile(page.key, 'chat/other.md')).toBeNull();
    expect(service.artifactFile(page.key, '../w2/chat/other.md')).toBeNull();
    expect(await service.files(page.key, 'readme')).toEqual([{ path: 'readme.md', dir: false }]);
  });
});
