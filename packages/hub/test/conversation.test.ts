import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_PROMPT, Store } from '@switchboard/core';
import type { Session as StoredSession } from '@switchboard/core';
import { projectSlug } from '@switchboard/claude';
import { ConversationService, sessionView } from '../src/conversation.js';
import { windowOf } from '../src/dock.js';
import { WindowScopes } from '../src/windows.js';
import { NOW, item, session, snapshot } from './views.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-conversation-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const WINDOWS = 'C:/sb/windows';
const worktree = (path: string) => ({ id: 1, ticketId: 1, path, branch: null, linkedBy: 'report' as const });

/** Work items 1 (done) and 2 share a worktree, so one item window; 3 has its own. */
function world() {
  const done = item(1, { status: 'done', worktree: worktree('D:/w12'), sessions: [session({ id: 's1', workItemId: 1, cwd: 'D:/w12', state: 'ended' })] });
  const current = item(2, { ticketId: 1, ticket: { ...done.ticket }, worktree: worktree('D:/w12'), status: 'blocked', sessions: [session({ id: 's2', workItemId: 2, cwd: 'D:/w12', codeMode: true, nativeSessionId: 'n2', rulesVersion: 2 })] });
  const other = item(3, { worktree: worktree('D:/w3'), sessions: [session({ id: 's3', workItemId: 3, cwd: 'D:/w3', codeMode: true, nativeSessionId: 'n3', rulesVersion: 2 })] });
  const file = windowOf(current, WINDOWS)!.file;
  const otherFile = windowOf(other, WINDOWS)!.file;

  return { done, current, other, file, otherFile, view: snapshot([done, current, other]) };
}

function stored(store: Store, view: ReturnType<typeof world>): void {
  for (const one of [view.done, view.current, view.other]) {
    const ticket = store.ticket(one.ticketId) ?? store.insertTicket({ ...one.ticket, adhocKey: null } as never);

    store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: one.status, createdAt: NOW } as never);

    for (const held of one.sessions) {
      store.insertSession(held as StoredSession);
    }
  }
}

describe('WindowScopes', () => {
  it("binds a window to its file's newest work item that is not done, and shows it alone with an unnamed needs count", () => {
    const store = Store.open(':memory:');
    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => 'k1' });
    const { file, view } = world();
    const key = scopes.open(file, view);

    expect(scopes.scope(key)).toEqual({ kind: 'item', workItemId: 2, key: 'k1', title: 'Issue <1>', cwd: 'D:/w12', scopeGen: 1, sessionId: 's2' });

    const scoped = scopes.scoped(key, { ...view, held: [] });

    expect(scoped.workItems.map((one) => one.id)).toEqual([2]);
    expect(scoped.pool).toEqual([]);
    expect(scoped).not.toHaveProperty('held');
    // Item 2 is blocked, so it needs the operator; the count names no work item.
    expect(scoped.needsCount).toBe(1);
    // The sources' notes and errors can name other tickets.
    const noted = scopes.scoped(key, { ...view, notes: ['github: https://github.com/o/r/issues/9 belongs to zoho.'], errors: { ...view.errors, sources: { github: 'issue #9 failed' } } });

    expect(noted).not.toHaveProperty('notes');
    expect(noted.errors.sources).toEqual({});
    expect(store.windowBinding(file)).toEqual({ file, workItemId: 2, since: NOW, scopeGen: 1 });
  });

  it("moves a window to a new work item of its ticket, raising its scope generation, and keeps it across a reload", () => {
    const store = Store.open(':memory:');
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => `k${++keys}` });
    const { file, view, current } = world();
    const key = scopes.open(file, view);
    const next = item(4, { ticketId: 1, ticket: { ...current.ticket }, worktree: worktree('D:/w12'), sessions: [session({ id: 's4', workItemId: 4, cwd: 'D:/w12' })] });

    expect(scopes.update(view)).toEqual([]);
    expect(scopes.update(snapshot([...view.workItems, next]))).toEqual([key]);
    expect(scopes.scope(key)).toMatchObject({ workItemId: 4, scopeGen: 2, sessionId: 's4' });
    scopes.close(key);
    expect(scopes.scope(key)).toBeNull();
    expect(scopes.scope(scopes.open(file, snapshot([...view.workItems, next])))).toMatchObject({ workItemId: 4, scopeGen: 2 });
  });

  it("gives a folder window no work item, and lets a window read only its own ticket's History or one it was sent", () => {
    const store = Store.open(':memory:');
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => `k${++keys}` });
    const { file, view } = world();
    const folder = scopes.open(null, view);
    const window = scopes.open(file, view);

    expect(scopes.scope(folder)).toBeNull();
    expect(scopes.scoped(folder, view).workItems).toEqual([]);
    expect(scopes.allowsTicket(window, 1, view)).toBe(true);
    expect(scopes.allowsTicket(window, 3, view)).toBe(false);
    expect(scopes.allowsTicket(folder, 3, view)).toBe(false);
    scopes.grant(folder, 3);
    expect(scopes.allowsTicket(folder, 3, view)).toBe(true);
    expect(scopes.allowsTicket(scopes.open(null, view), 3, view)).toBe(false);
    expect(scopes.allowsTicket(window, 3, view)).toBe(false);
    expect(scopes.allowsTicket('forged', 1, view)).toBe(false);
  });
});

describe('WindowScopes after a restart', () => {
  it("keeps a window's History of a bound work item that has left the snapshot", () => {
    const store = Store.open(':memory:');
    const { file, current } = world();
    const ticket = store.insertTicket({ ...current.ticket, adhocKey: null } as never);
    const workItem = store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: 'done', createdAt: NOW } as never);

    store.setWindowBinding({ file, workItemId: workItem.id, since: NOW, scopeGen: 3 });

    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => 'k1' });
    const key = scopes.open(file, snapshot([]));

    expect(scopes.allowsTicket(key, ticket.id, snapshot([]))).toBe(true);
    expect(scopes.scope(key)).toMatchObject({ workItemId: workItem.id, scopeGen: 3 });
  });
});

describe('ConversationService', () => {
  function setup() {
    const store = Store.open(':memory:');
    const view = world();
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => `k${++keys}` });
    const projects = join(dir, 'projects');
    const logs: string[] = [];
    let id = 0;
    const service = new ConversationService({
      store,
      windows: scopes,
      projectsDir: projects,
      claudeConfig: join(dir, '.claude.json'),
      screen: async () => null,
      hooks: () => true,
      now: () => NOW,
      newId: () => String(++id),
      log: (line) => logs.push(line),
    });

    stored(store, view);

    const transcript = (cwd: string, native: string, lines: string[]): void => {
      mkdirSync(join(projects, projectSlug(cwd)), { recursive: true });
      writeFileSync(join(projects, projectSlug(cwd), `${native}.jsonl`), lines.map((line) => `${line}\n`).join(''));
    };
    const reply = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid, timestamp: new Date(NOW).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
    const open = (file: string) => {
      const key = scopes.open(file, view.view);
      const frames: Array<{ type: string; [field: string]: unknown }> = [];
      const stream = service.open(key, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }))!;

      return { key, frames, stream };
    };

    return { store, view, scopes, service, transcript, reply, open, logs };
  }

  it("says hello with the window's scope, its current session and its items, and sends each window only its own session's replies", async () => {
    const { view, service, transcript, reply, open } = setup();

    transcript('D:/w12', 'n2', [reply('a1', 'Mine.')]);
    transcript('D:/w3', 'n3', [reply('b1', 'Not yours.')]);

    const mine = open(view.file);
    const theirs = open(view.otherFile);

    expect(mine.frames).toMatchObject([{ v: 1, seq: 1, type: 'hello', protocol: 1, scope: { workItemId: 2, sessionId: 's2', scopeGen: 1 }, sessions: [{ id: 's2', state: 'running', conversation: 'full', rules: 'current' }], items: [], more: false }]);
    await service.poll();
    expect(mine.frames.slice(1)).toMatchObject([{ type: 'reply', reply: { sessionId: 's2', opening: 'Mine.', kind: 'reply', source: 'transcript' } }]);
    expect(theirs.frames.slice(1)).toMatchObject([{ type: 'reply', reply: { sessionId: 's3', opening: 'Not yours.' } }]);
    expect(JSON.stringify(mine.frames)).not.toContain('Not yours.');
    expect(JSON.stringify(theirs.frames)).not.toContain('Mine.');
    // The reply drops the store's work item and transcript fields.
    expect(mine.frames[1]!['reply']).not.toHaveProperty('workItemId');

    // A reconnect starts again from a hello with the items so far.
    mine.stream.close();
    expect(open(view.file).frames).toMatchObject([{ type: 'hello', items: [{ type: 'reply', opening: 'Mine.' }] }]);
  });

  it('refuses a stream for a key no window holds, and history for a forged session, another window or a stale scope generation', async () => {
    const { view, service, transcript, reply, open, store } = setup();

    transcript('D:/w12', 'n2', [reply('a1', 'One.'), reply('a2', 'Two.')]);
    await service.poll();

    const { key } = open(view.file);
    const other = open(view.otherFile).key;

    expect(service.open('forged', () => undefined)).toBeNull();
    expect(service.history({ window: key, scopeGen: 1, opId: 'o1', sessionId: 's3', before: null })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.history({ window: other, scopeGen: 1, opId: 'o2', sessionId: 's2', before: null })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.history({ window: 'forged', scopeGen: 1, opId: 'o3', sessionId: 's2', before: null })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.history({ window: key, scopeGen: 0, opId: 'o4', sessionId: 's2', before: null })).toEqual({ status: 409, body: { error: "The window's work item changed." } });
    expect(service.history({ window: key, scopeGen: 1, sessionId: 's2' })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, before, limit?}.' } });

    const page = service.history({ window: key, scopeGen: 1, opId: 'o5', sessionId: 's2', before: null, limit: 1 });

    expect(page).toMatchObject({ status: 200, body: { items: [{ opening: 'Two.' }], more: true } });
    expect(store.conversation('s2', null, 10).items).toHaveLength(2);
  });

  it("tells a window its session's new state once, and starts a moved window from a fresh hello", () => {
    const { view, service, open, store, scopes } = setup();
    const { frames, key } = open(view.file);

    service.sessionsChanged();
    service.sessionsChanged();
    store.updateSession('s2', { state: 'waiting', stateDetail: PERMISSION_PROMPT });
    service.sessionsChanged();
    expect(frames.filter((frame) => frame.type === 'session')).toMatchObject([{ session: { state: 'running' } }, { session: { state: 'waiting', waitingFor: 'permission' } }]);

    const next = item(4, { ticketId: 1, ticket: { ...view.current.ticket }, worktree: worktree('D:/w12'), sessions: [] });

    service.scopesChanged(scopes.update(snapshot([...view.view.workItems, next])));
    expect(frames.slice(-2)).toMatchObject([{ type: 'scope', scope: { workItemId: 4, scopeGen: 2, sessionId: null } }, { type: 'hello', scope: { key, workItemId: 4 }, sessions: [], items: [] }]);
  });
});

describe('sessionView', () => {
  it('names what the view can do with each kind of session', () => {
    expect(sessionView(session({ codeMode: true, state: 'ended', rulesVersion: 0 }), true, true)).toMatchObject({ state: 'ended', conversation: 'read-only', reason: 'The session has ended. Open it in the terminal to resume it.', rules: 'older' });
    expect(sessionView(session({ codeMode: true, state: 'idle' }), true, false)).toMatchObject({ conversation: 'read-only', reason: 'Switchboard cannot follow this session while sessions.installHooks is off.', rules: 'none' });
    expect(sessionView(session({ state: 'waiting', stateDetail: null }), false, true)).toMatchObject({ waitingFor: 'question', conversation: 'none', current: false });
    expect(sessionView(session({ codeMode: true, state: 'failed' }), true, true)).toMatchObject({ state: 'idle', conversation: 'full' });
  });
});
