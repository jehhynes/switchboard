import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_PROMPT, Store, toneSection, toneVersion, windowFileKey } from '@switchboard/core';
import type { Interruption, Session as StoredSession } from '@switchboard/core';
import { projectSlug } from '@switchboard/claude';
import { ConversationService, sessionView, typedText } from '../src/conversation.js';
import type { ConversationServiceDeps, ConversationVoice, PersonaView } from '../src/conversation.js';
import { windowOf } from '../src/dock.js';
import { canonicalFolder, WindowScopes } from '../src/windows.js';
import { pageGroups } from '../src/page.js';
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
  const current = item(2, { ticketId: 1, ticket: { ...done.ticket }, worktree: worktree('D:/w12'), status: 'blocked', sessions: [session({ id: 's2', workItemId: 2, cwd: 'D:/w12', codeMode: true, nativeSessionId: 'n2' })] });
  const other = item(3, { worktree: worktree('D:/w3'), sessions: [session({ id: 's3', workItemId: 3, cwd: 'D:/w3', codeMode: true, nativeSessionId: 'n3' })] });
  const file = windowOf(current, WINDOWS)!.file!;
  const otherFile = windowOf(other, WINDOWS)!.file!;

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
    const all = world();
    const { file, view } = all;

    stored(store, all);

    const key = scopes.open(file, view);

    expect(scopes.scope(key)).toEqual({ kind: 'item', workItemId: 2, key: 'k1', folder: 'D:/w12', title: 'Issue <1>', cwd: 'D:/w12', scopeGen: 1, sessionId: 's2', conversations: [{ workItemId: 2, primary: true }] });

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
    expect(store.windowBinding(windowFileKey(file))).toEqual({ file: windowFileKey(file), workItemId: 2, since: NOW, scopeGen: 1, selectedWorkItemId: 2, selectedSessionId: 's2', ticketId: 1, title: 'Issue <1>' });
  });

  it("moves a window to a new work item of its ticket, raising its scope generation, and keeps it across a reload", () => {
    const store = Store.open(':memory:');
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => `k${++keys}` });
    const all = world();
    const { file, view, current } = all;

    stored(store, all);

    const key = scopes.open(file, view);
    const next = item(4, { ticketId: 1, ticket: { ...current.ticket }, worktree: worktree('D:/w12'), sessions: [session({ id: 's4', workItemId: 4, cwd: 'D:/w12' })] });

    store.insertWorkItem({ ticketId: 1, playbook: null, status: 'running', createdAt: NOW } as never);
    store.insertSession(next.sessions[0] as StoredSession);

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

    store.setWindowBinding({ file, workItemId: workItem.id, since: NOW, scopeGen: 3, selectedWorkItemId: workItem.id, selectedSessionId: null });

    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => 'k1' });
    const key = scopes.open(file, snapshot([]));

    expect(scopes.allowsTicket(key, ticket.id, snapshot([]))).toBe(true);
    expect(scopes.scope(key)).toMatchObject({ workItemId: workItem.id, scopeGen: 3 });
  });
});

describe('hosted conversations in a window (architecture.md § Window scope)', () => {
  function setup(made?: (hostWindow: string, folder: string, provider?: 'claude' | 'codex') => { workItemId: number } | { refused: string }) {
    const store = Store.open(':memory:');
    const view = world();
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => `k${++keys}` });
    const projects = join(dir, 'projects');
    const held = new FakeHeld();
    let id = 0;
    const service = new ConversationService({
      store,
      windows: scopes,
      projectsDir: projects,
      claudeConfig: join(dir, '.claude.json'),
      screen: async (session) => held.screen(session),
      input: held,
      hooks: () => true,
      now: () => NOW,
      newId: () => String(++id),
      ...(made === undefined ? {} : { newConversation: made }),
      log: () => {},
    });

    stored(store, view);

    /** An ad hoc conversation hosted by `file`, as the flow makes one, with its Code Mode session. */
    const host = (file: string, sessionId: string, status = 'running') => {
      const ticket = store.insertTicket({ source: 'adhoc', sourceKey: sessionId, ref: `#${sessionId}`, sourceId: null, title: 'New session', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: NOW, lastPolledAt: null, repoRoot: 'D:/w12', hostWindow: file });
      const workItem = store.insertWorkItem({ ticketId: ticket.id, playbook: null, status, createdAt: NOW } as never);

      store.insertSession(session({ id: sessionId, workItemId: workItem.id, cwd: 'D:/w12', codeMode: true, nativeSessionId: `n-${sessionId}`, state: 'idle' }) as StoredSession);

      return workItem.id;
    };
    const open = (file: string) => {
      const key = scopes.open(file, view.view);
      const frames: Array<{ type: string; [field: string]: unknown }> = [];

      service.open(key, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

      return { key, frames };
    };
    const transcript = (native: string, lines: string[]): void => {
      mkdirSync(join(projects, projectSlug('D:/w12')), { recursive: true });
      writeFileSync(join(projects, projectSlug('D:/w12'), `${native}.jsonl`), lines.map((line) => `${line}\n`).join(''));
    };

    return { store, view, scopes, service, host, open, transcript };
  }

  it("lists only the conversations its binding hosts, even for windows on one folder, and refuses the other window's", () => {
    const { view, scopes, service, host, open } = setup();
    // Both windows run in D:/w12, as Support work items share one folder; only the host link decides.
    const mineHosted = host(view.file, 'h1');
    const theirsHosted = host(view.otherFile, 'h2');
    const mine = open(view.file);
    const theirs = open(view.otherFile);

    expect(mine.frames[0]).toMatchObject({ type: 'hello', scope: { workItemId: 2, sessionId: 's2', conversations: [{ workItemId: 2, primary: true, title: 'Issue <1>' }, { workItemId: mineHosted, primary: false, title: 'New session', sessionId: 'h1', state: 'idle', conversation: 'full', unread: 0, provider: 'claude' }] } });
    expect((mine.frames[0]!['scope'] as { conversations: unknown[] }).conversations).toHaveLength(2);
    expect(scopes.scope(theirs.key)?.conversations).toEqual([{ workItemId: 3, primary: true }, { workItemId: theirsHosted, primary: false }]);
    expect(scopes.scoped(mine.key, view.view).workItems.map((item) => item.id)).toEqual([2]);

    // Selecting another window's conversation is refused and changes nothing.
    expect(service.select({ window: mine.key, scopeGen: 1, opId: 'o1', workItemId: theirsHosted })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.select({ window: mine.key, scopeGen: 1, opId: 'o2', workItemId: 3 })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(scopes.scope(mine.key)).toMatchObject({ workItemId: 2, scopeGen: 1 });

    // Selecting its own raises the scope generation, and the window starts from that conversation's hello.
    expect(service.select({ window: mine.key, scopeGen: 0, opId: 'o3', workItemId: mineHosted })).toEqual({ status: 200, body: { scopeGen: 2 } });
    expect(mine.frames.slice(-2)).toMatchObject([{ type: 'scope', scope: { workItemId: mineHosted, sessionId: 'h1', scopeGen: 2 } }, { type: 'hello', sessions: [{ id: 'h1' }], scope: { workItemId: mineHosted } }]);
    expect(theirs.frames.filter((frame) => frame.type === 'scope')).toEqual([]);

    // Commands name the selected conversation's session only; the other window's, or the earlier selection's, are refused.
    expect(service.history({ window: mine.key, scopeGen: 2, opId: 'o4', sessionId: 'h2', before: null })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.history({ window: mine.key, scopeGen: 2, opId: 'o5', sessionId: 's2', before: null })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.history({ window: mine.key, scopeGen: 1, opId: 'o6', sessionId: 'h1', before: null })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.seen({ window: theirs.key, scopeGen: 1, opId: 'o7', sessionId: 'h1', ids: [] })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.send({ window: theirs.key, scopeGen: 1, opId: 'o8', sessionId: 'h1', launch: null, text: 'hi' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
  });

  it('counts each conversation unread on its own and sends the dropdown when it changes, without moving the selection', async () => {
    const { view, service, host, open, transcript } = setup();
    const hosted = host(view.file, 'h1');
    const mine = open(view.file);
    const theirs = open(view.otherFile);

    transcript('n-h1', [JSON.stringify({ type: 'assistant', uuid: 'x1', timestamp: new Date(NOW).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Hosted reply.' }] } })]);
    await service.poll();

    expect(mine.frames.filter((frame) => frame.type === 'reply')).toEqual([]);
    expect(mine.frames.filter((frame) => frame.type === 'unread')).toEqual([expect.objectContaining({ workItemId: hosted, count: 1 })]);
    service.conversationsChanged();
    expect(mine.frames.filter((frame) => frame.type === 'conversations').at(-1)).toMatchObject({ conversations: [{ workItemId: 2, unread: 0 }, { workItemId: hosted, unread: 1 }] });
    expect(mine.frames.filter((frame) => frame.type === 'scope')).toEqual([]);
    expect(theirs.frames.filter((frame) => frame.type === 'unread' || frame.type === 'conversations')).toEqual([]);
  });

  it('passes a chosen provider once, validates it, and keeps the first choice on retry', () => {
    const calls: unknown[][] = [];
    const context = setup((host, folder, provider) => { calls.push([host, folder, provider]); return { workItemId: context.host(host, 'chosen') }; });
    const mine = context.open(context.view.file);
    for (const provider of [null, 'other', 7]) expect(context.service.newConversation({ window: mine.key, opId: 'invalid', provider }).status).toBe(400);
    const result = context.service.newConversation({ window: mine.key, opId: 'chosen', provider: 'codex' });
    expect(result.status).toBe(200);
    expect(calls).toEqual([[context.view.file, 'D:/w12', 'codex']]);
    expect(context.service.newConversation({ window: mine.key, opId: 'chosen', provider: 'claude' })).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(context.service.newConversation({ window: 'other', opId: 'forged', provider: 'codex' }).status).toBe(403);
  });

  it('makes a conversation once per opId, selects it in the window that made it, and passes a refusal on', () => {
    const calls: Array<[string, string]> = [];
    let refused: string | null = null;
    const made = (hostWindow: string, folder: string) => {
      calls.push([hostWindow, folder]);

      return refused !== null ? { refused } : { workItemId: context.host(hostWindow, `n${calls.length}`) };
    };
    const context = setup(made);
    const mine = context.open(context.view.file);
    const theirs = context.open(context.view.otherFile);
    const answer = context.service.newConversation({ window: mine.key, scopeGen: 1, opId: 'new-1' });

    expect(answer).toEqual({ status: 200, body: { workItemId: 4 } });
    expect(calls).toEqual([[context.view.file, 'D:/w12']]);
    expect(context.scopes.scope(mine.key)).toMatchObject({ workItemId: 4, sessionId: 'n1', scopeGen: 2 });
    expect(mine.frames.slice(-2)).toMatchObject([{ type: 'scope', scope: { workItemId: 4 } }, { type: 'hello', sessions: [{ id: 'n1' }] }]);
    expect(context.service.newConversation({ window: mine.key, scopeGen: 2, opId: 'new-1' })).toEqual({ status: 200, body: { workItemId: 4 } });
    expect(calls).toHaveLength(1);
    expect(context.scopes.holds(theirs.key, 4)).toBe(false);

    refused = 'New sessions need Code Mode (sessions.codeMode).';
    expect(context.service.newConversation({ window: mine.key, scopeGen: 2, opId: 'new-2' })).toEqual({ status: 409, body: { error: refused } });
    expect(context.service.newConversation({ window: 'forged', scopeGen: 2, opId: 'new-3' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(context.service.newConversation({ window: mine.key, opId: 7 }).status).toBe(400);
  });

  it("keeps a dock row's selection for a window not open yet, and moves an open window to it", () => {
    const { view, scopes, store, host } = setup();
    const hosted = host(view.file, 'h1');

    scopes.open(view.file, view.view);
    scopes.close(scopes.keys()[0]!);
    expect(scopes.selectFor(hosted, view.file)).toEqual({ keys: [], selected: true });
    expect(store.windowBinding(windowFileKey(view.file))).toMatchObject({ selectedWorkItemId: hosted, selectedSessionId: 'h1', scopeGen: 2 });

    const key = scopes.open(view.file, view.view);

    expect(scopes.scope(key)).toMatchObject({ workItemId: hosted, sessionId: 'h1', scopeGen: 2 });
    expect(scopes.selectFor(2, null)).toEqual({ keys: [key], selected: true });
    expect(scopes.scope(key)).toMatchObject({ workItemId: 2, scopeGen: 3 });
    expect(scopes.selectFor(hosted, view.file)).toEqual({ keys: [key], selected: true });
    expect(scopes.scope(key)).toMatchObject({ workItemId: hosted, scopeGen: 4 });

    // A done conversation's row is selected too, and listed while selected; another window's conversation is not.
    const done = host(view.file, 'h3', 'done');
    const theirs = host(view.otherFile, 'h4');

    expect(scopes.selectFor(done, view.file)).toEqual({ keys: [key], selected: true });
    expect(scopes.scope(key)).toMatchObject({ workItemId: done, sessionId: 'h3' });
    expect(scopes.scope(key)?.conversations.map((ref) => ref.workItemId)).toContain(done);
    expect(scopes.selectFor(theirs, view.file)).toEqual({ keys: [], selected: false });
    expect(scopes.scope(key)).toMatchObject({ workItemId: done });
  });

  it('keeps a done conversation while it is selected, and the hosted ones when the primary is deleted', () => {
    const { view, scopes, store, host } = setup();
    const hosted = host(view.file, 'h1');
    const done = host(view.file, 'h2', 'done');
    const key = scopes.open(view.file, view.view);

    expect(scopes.scope(key)?.conversations.map((ref) => ref.workItemId)).toEqual([2, hosted]);
    expect(scopes.select(key, done)).toBe(false);
    expect(scopes.select(key, hosted)).toBe(true);
    store.updateWorkItem(hosted, { status: 'done' });
    expect(scopes.update(view.view)).toEqual([]);
    expect(scopes.scope(key)?.conversations.map((ref) => ref.workItemId)).toEqual([2, hosted]);
    expect(scopes.select(key, 2)).toBe(true);
    expect(scopes.scope(key)?.conversations.map((ref) => ref.workItemId)).toEqual([2]);

    store.updateWorkItem(hosted, { status: 'running' });
    store.deleteWorkItem(2);
    expect(scopes.update(view.view)).toEqual([key]);
    expect(scopes.scope(key)).toMatchObject({ workItemId: hosted, title: 'Issue <1>', conversations: [{ workItemId: hosted, primary: false }] });

    // With no conversation left the window has no scope, but its binding keeps the ticket for History.
    store.updateWorkItem(hosted, { status: 'done' });
    expect(scopes.select(key, hosted)).toBe(true);
    store.deleteWorkItem(hosted);
    scopes.update(view.view);
    expect(scopes.scope(key)).toBeNull();
    expect(scopes.allowsTicket(key, 1)).toBe(true);
  });
});

const RULE = '─'.repeat(30);

/** The holder and runtime as typing sees them: a held session's input box, its writes, the transcript an Enter writes to, and reservations. */
class FakeHeld {
  clock = NOW;
  box = '';
  menu = false;
  rev = 0;
  cannotType_: string | null = null;
  readonly writes: string[] = [];
  readonly reservations: Array<{ sessionId: string; launch: string | null }> = [];
  released = 0;
  refuse: string | null = null;
  transcript: (session: string) => string | null = () => null;

  async screen(_session: string): Promise<{ data: string; cols: number; rows: number; rev: number; keyAt: number | null }> {
    return { data: [this.menu ? '❯ 1. Yes' : '', RULE, `❯ ${this.box === '' ? '\u001b[2mTry "fix it"\u001b[22m' : this.box}`, RULE].join('\r\n'), cols: 40, rows: 5, rev: this.rev, keyAt: null };
  }

  async reserve(sessionId: string, launch: string | null): Promise<{ release(): void } | { refused: string }> {
    this.reservations.push({ sessionId, launch });

    return this.refuse !== null ? { refused: this.refuse } : { release: () => void this.released++ };
  }

  async write(session: string, data: string): Promise<{ rev: number }> {
    this.writes.push(data);
    this.rev++;

    const paste = /^\u001b\[200~([\s\S]*)\u001b\[201~$/.exec(data);

    if (paste !== null) {
      this.box += paste[1]!;
    } else if (data === '\u0015') {
      this.box = this.box.endsWith('\n') ? this.box.slice(0, -1) : this.box.slice(0, this.box.lastIndexOf('\n') + 1);
    } else if (data === '\r' && this.box !== '') {
      const path = this.transcript(session);

      if (path !== null) {
        appendFileSync(path, `${JSON.stringify({ type: 'user', uuid: `typed-${this.rev}`, timestamp: new Date(this.clock).toISOString(), message: { role: 'user', content: this.box } })}\n`);
      }

      this.box = '';
      this.rev++;
    }

    return { rev: this.rev };
  }

  cannotType(): string | null {
    return this.cannotType_;
  }
}

describe('folder-hosted conversations (architecture.md § Window scope)', () => {
  function setup(made?: (hostWindow: string, folder: string, provider?: 'claude' | 'codex') => { workItemId: number } | { refused: string }) {
    const store = Store.open(':memory:');
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => `k${++keys}` });
    let id = 0;
    const service = new ConversationService({
      store,
      windows: scopes,
      projectsDir: join(dir, 'projects'),
      claudeConfig: join(dir, '.claude.json'),
      screen: async () => null,
      input: new FakeHeld(),
      hooks: () => true,
      now: () => NOW,
      newId: () => String(++id),
      ...(made === undefined ? {} : { newConversation: made }),
      log: () => {},
    });
    // Support runs every work item in one folder with no worktree: two item windows on it, and a link to it.
    const support = join(dir, 'support');
    const link = join(dir, 'support-link');
    const elsewhere = join(dir, 'elsewhere');

    mkdirSync(support);
    mkdirSync(elsewhere);
    symlinkSync(support, link, 'junction');

    const first = item(1, { sessions: [session({ id: 's1', workItemId: 1, cwd: support, codeMode: true, nativeSessionId: 'n1' })] });
    const second = item(2, { sessions: [session({ id: 's2', workItemId: 2, cwd: support, codeMode: true, nativeSessionId: 'n2' })] });
    const view = snapshot([first, second]);

    for (const one of [first, second]) {
      const ticket = store.insertTicket({ ...one.ticket, adhocKey: null } as never);

      store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: one.status, createdAt: NOW } as never);
      store.insertSession(one.sessions[0] as StoredSession);
    }

    /** An ad hoc conversation hosted by `host`, run in `folder`, as the flow makes one. */
    const host = (hostWindow: string, sessionId: string, folder = support) => {
      const ticket = store.insertTicket({ source: 'adhoc', sourceKey: sessionId, ref: `#${sessionId}`, sourceId: null, title: 'New session', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: NOW, lastPolledAt: null, repoRoot: folder, hostWindow });
      const workItem = store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: 'running', createdAt: NOW } as never);

      store.insertSession(session({ id: sessionId, workItemId: workItem.id, cwd: folder, codeMode: true, nativeSessionId: `n-${sessionId}`, state: 'idle' }) as StoredSession);

      return workItem.id;
    };
    const frames = (key: string) => {
      const seen: Array<{ type: string; [field: string]: unknown }> = [];

      service.open(key, (frame) => seen.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

      return seen;
    };

    return { store, scopes, service, view, support: canonicalFolder(support)!, link, elsewhere: canonicalFolder(elsewhere)!, files: [windowOf(first, WINDOWS)!.file!, windowOf(second, WINDOWS)!.file!], host, frames };
  }

  it("lists only the conversations its folder hosts, never the folder's item work, and item windows on that folder list none of them", () => {
    const { scopes, service, view, support, files, host, frames } = setup();
    const inFolder = host(support, 'f1');
    const inItem = host(files[0]!, 'a1');
    const folder = scopes.open(null, view, support);
    const item1 = scopes.open(files[0]!, view);
    const item2 = scopes.open(files[1]!, view);

    expect(scopes.scope(folder)).toEqual({ kind: 'folder', key: folder, folder: support, title: 'support', scopeGen: 1, conversations: [{ workItemId: inFolder, primary: false }], workItemId: inFolder, cwd: support, sessionId: 'f1' });
    expect(scopes.scoped(folder, view).workItems).toEqual([]);
    expect(scopes.scope(item1)?.conversations).toEqual([{ workItemId: 1, primary: true }, { workItemId: inItem, primary: false }]);
    expect(scopes.scope(item2)?.conversations).toEqual([{ workItemId: 2, primary: true }]);
    expect(frames(folder)[0]).toMatchObject({ type: 'hello', scope: { kind: 'folder', conversations: [{ workItemId: inFolder, title: 'New session', sessionId: 'f1' }] }, sessions: [{ id: 'f1' }] });

    // Neither side reaches the other's work: select, history and send are refused both ways.
    for (const [key, workItemId] of [[folder, 1], [folder, inItem], [item1, inFolder], [item2, inFolder]] as const) {
      expect(service.select({ window: key, scopeGen: 1, opId: `o-${key}-${workItemId}`, workItemId })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    }

    expect(service.history({ window: folder, scopeGen: 1, opId: 'h1', sessionId: 's1', before: null })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.history({ window: item1, scopeGen: 1, opId: 'h2', sessionId: 'f1', before: null })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.send({ window: item2, scopeGen: 1, opId: 'h3', sessionId: 'f1', launch: null, text: 'hi' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(scopes.allowsTicket(folder, 1, view)).toBe(false);
  });

  it('reaches one host from every spelling of the folder, by a link or in another case, and none from a path that is no folder', () => {
    const { scopes, view, support, link, host } = setup();
    const inFolder = host(support, 'f1');
    const spellings = [link, `${support}${sep}`, ...(process.platform === 'win32' ? [support.toUpperCase(), support.toLowerCase()] : [])];

    for (const spelling of spellings) {
      const key = scopes.open(null, view, spelling);

      expect(scopes.hostOf(key)).toBe(support);
      expect(scopes.scope(key)?.conversations).toEqual([{ workItemId: inFolder, primary: false }]);
    }

    expect(scopes.keysOf(support.toLowerCase())).toHaveLength(spellings.length);

    writeFileSync(join(dir, 'a.txt'), '');

    const missing = scopes.open(null, view, join(dir, 'missing'));
    const file = scopes.open(null, view, join(dir, 'a.txt'));

    expect(scopes.scope(missing)).toBeNull();
    expect(scopes.hostOf(missing)).toBeNull();
    expect(scopes.scope(scopes.open(null, view))).toBeNull();
    expect(scopes.scope(file)).toBeNull();
  });

  it('lists the conversations of a folder whose name has an uppercase letter outside ASCII', () => {
    const { scopes, view, host } = setup();
    const etage = join(dir, 'Étage');

    mkdirSync(etage);

    const canonical = canonicalFolder(etage)!;
    const hosted = host(canonical, 'e1', canonical);

    expect(scopes.scope(scopes.open(null, view, etage))).toMatchObject({ kind: 'folder', title: 'Étage', workItemId: hosted, conversations: [{ workItemId: hosted, primary: false }] });
  });

  it('keeps two folders that differ only in case apart where the file system has case, and refuses a folder named like a workspace file', () => {
    const { scopes, view, support, host } = setup();
    const shouting = host(support.toUpperCase(), 'f1');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect(scopes.scope(scopes.open(null, view, support))?.conversations).toEqual([]);
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(scopes.scope(scopes.open(null, view, support))?.conversations).toEqual([{ workItemId: shouting, primary: false }]);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }

    mkdirSync(join(dir, 'odd.code-workspace'));
    expect(canonicalFolder(join(dir, 'odd.code-workspace'))).toBeNull();
    expect(scopes.scope(scopes.open(null, view, join(dir, 'odd.code-workspace')))).toBeNull();
  });

  it('gives an empty folder a scope with no selection, and makes a conversation there hosted by the folder and run in it', () => {
    const calls: Array<[string, string]> = [];
    const context = setup((hostWindow, folder) => {
      calls.push([hostWindow, folder]);

      return { workItemId: context.host(hostWindow, `n${calls.length}`, folder) };
    });
    const { scopes, service, view, elsewhere, frames } = context;
    const key = scopes.open(null, view, elsewhere);
    const seen = frames(key);

    expect(scopes.scope(key)).toEqual({ kind: 'folder', key, folder: elsewhere, title: 'elsewhere', scopeGen: 0, conversations: [], workItemId: null, cwd: null, sessionId: null });
    expect(seen[0]).toMatchObject({ type: 'hello', scope: { kind: 'folder', conversations: [], workItemId: null }, sessions: [], items: [], status: null, artifacts: [] });
    expect(service.send({ window: key, scopeGen: 0, opId: 'x', sessionId: 's1', launch: null, text: 'hi' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });

    expect(service.newConversation({ window: key, scopeGen: 0, opId: 'new-1' })).toEqual({ status: 200, body: { workItemId: 3 } });
    expect(calls).toEqual([[elsewhere, elsewhere]]);
    expect(scopes.scope(key)).toMatchObject({ kind: 'folder', workItemId: 3, sessionId: 'n1', cwd: elsewhere, scopeGen: 1, conversations: [{ workItemId: 3, primary: false }] });
    expect(seen.slice(-2)).toMatchObject([{ type: 'scope', scope: { workItemId: 3 } }, { type: 'hello', sessions: [{ id: 'n1' }] }]);
    expect(service.newConversation({ window: key, scopeGen: 1, opId: 'new-1' })).toEqual({ status: 200, body: { workItemId: 3 } });
    expect(calls).toHaveLength(1);
  });

  it("keeps a dock row's selection for a folder window not open yet, selects it in an open one, and never in an item window on that folder", () => {
    const { scopes, store, view, support, link, files, host } = setup();
    const older = host(support, 'f1');
    const newer = host(support, 'f2');
    const folder = scopes.open(null, view, support);
    const item1 = scopes.open(files[0]!, view);

    expect(scopes.scope(folder)).toMatchObject({ workItemId: newer, scopeGen: 1 });
    expect(scopes.selectFor(older, support)).toEqual({ keys: [folder], selected: true });
    expect(scopes.scope(folder)).toMatchObject({ workItemId: older, scopeGen: 2 });
    expect(scopes.scope(item1)).toMatchObject({ workItemId: 1, scopeGen: 1 });

    scopes.close(folder);
    expect(scopes.selectFor(newer, support)).toEqual({ keys: [], selected: true });
    expect(store.windowBinding(windowFileKey(support))).toMatchObject({ workItemId: null, selectedWorkItemId: newer, selectedSessionId: 'f2', scopeGen: 3 });
    expect(scopes.scope(scopes.open(null, view, link))).toMatchObject({ kind: 'folder', workItemId: newer, scopeGen: 3 });
  });

  it('validates and passes the dock provider, retaining the first result on a changed-provider retry', () => {
    const calls: unknown[][] = [];
    const context = setup((host, folder, provider) => { calls.push([host, folder, provider]); return { workItemId: context.host(host, 'dock-provider', folder) }; });
    const { service, support, link } = context;
    for (const provider of [null, 'other', 7]) expect(service.dockConversation({ folder: support, opId: 'invalid', provider }).status).toBe(400);
    const result = service.dockConversation({ folder: link, opId: 'chosen', provider: 'codex' });
    expect(result.status).toBe(200);
    expect(calls).toEqual([[support, support, 'codex']]);
    expect(service.dockConversation({ folder: support, opId: 'chosen', provider: 'claude' })).toEqual(result);
    expect(calls).toHaveLength(1);
  });

  it('makes a dock conversation once per opId with no window open, selects it in the folder window that then opens, and never in an item window on that folder', () => {
    const calls: Array<[string, string]> = [];
    const context = setup((hostWindow, folder) => {
      calls.push([hostWindow, folder]);

      return { workItemId: context.host(hostWindow, `d${calls.length}`, folder) };
    });
    const { scopes, service, store, view, support, link, files, frames } = context;
    const item1 = scopes.open(files[0]!, view);
    const seen = frames(item1);

    // Asked by a link to the folder: hosted by and run in its canonical folder, and stored as that folder's selection before any window opens.
    expect(service.dockConversation({ folder: link, opId: 'dock-1' })).toEqual({ status: 200, body: { workItemId: 3, folder: support } });
    expect(calls).toEqual([[support, support]]);
    expect(store.windowBinding(windowFileKey(support))).toMatchObject({ workItemId: null, selectedWorkItemId: 3, selectedSessionId: 'd1', title: 'support' });

    // The response was lost: the retry, by another spelling, answers the same work item and makes none.
    expect(service.dockConversation({ folder: `${support}${sep}`, opId: 'dock-1' })).toEqual({ status: 200, body: { workItemId: 3, folder: support } });
    expect(calls).toHaveLength(1);

    const folder = scopes.open(null, view, support);

    expect(scopes.scope(folder)).toMatchObject({ kind: 'folder', workItemId: 3, sessionId: 'd1', conversations: [{ workItemId: 3, primary: false }] });
    expect(scopes.scope(item1)).toMatchObject({ workItemId: 1, conversations: [{ workItemId: 1, primary: true }] });
    expect(seen.filter((frame) => frame.type === 'scope')).toEqual([]);

    // A second one moves the open folder window to it.
    const moved = frames(folder);

    expect(service.dockConversation({ folder: support, opId: 'dock-2' })).toEqual({ status: 200, body: { workItemId: 4, folder: support } });
    expect(scopes.scope(folder)).toMatchObject({ workItemId: 4, conversations: [{ workItemId: 4, primary: false }, { workItemId: 3, primary: false }] });
    expect(moved.slice(-2)).toMatchObject([{ type: 'scope', scope: { workItemId: 4 } }, { type: 'hello', sessions: [{ id: 'd2' }] }]);
    expect(scopes.scope(item1)).toMatchObject({ workItemId: 1 });
  });

  it('refuses a dock conversation for a malformed body or a path that is no folder, and passes the flow\'s refusal on without storing a selection', () => {
    const { service, store, support } = setup(() => ({ refused: 'New sessions need Code Mode (sessions.codeMode).' }));

    writeFileSync(join(dir, 'a.txt'), '');

    for (const body of [{}, { folder: support }, { folder: support, opId: '' }, { folder: 7, opId: 'x' }, { folder: '', opId: 'x' }, { folder: support, opId: 'x'.repeat(201) }]) {
      expect(service.dockConversation(body)).toEqual({ status: 400, body: { error: 'Expected {folder, opId}.' } });
    }

    for (const path of [join(dir, 'missing'), join(dir, 'a.txt')]) {
      expect(service.dockConversation({ folder: path, opId: 'x' })).toEqual({ status: 400, body: { error: `${path} is not a folder a session can run in.` } });
    }

    expect(service.dockConversation({ folder: support, opId: 'x' })).toEqual({ status: 409, body: { error: 'New sessions need Code Mode (sessions.codeMode).' } });
    expect(store.windowBinding(windowFileKey(support))).toBeNull();
  });
});

describe('ConversationService', () => {
  function setup(held = new FakeHeld()) {
    const store = Store.open(':memory:');
    const view = world();
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => `k${++keys}` });
    const projects = join(dir, 'projects');
    const logs: string[] = [];
    let id = 0;
    const unreadChanges = { count: 0 };
    const service = new ConversationService({
      store,
      windows: scopes,
      projectsDir: projects,
      claudeConfig: join(dir, '.claude.json'),
      screen: async (session) => held.screen(session),
      input: held,
      hooks: () => true,
      now: () => held.clock,
      sleep: async (ms) => {
        held.clock += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
      newId: () => String(++id),
      unreadChanged: () => unreadChanges.count++,
      log: (line) => logs.push(line),
    });

    held.transcript = (session) => (session === 's2' ? join(projects, projectSlug('D:/w12'), 'n2.jsonl') : null);

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

    return { store, view, scopes, service, transcript, reply, open, logs, held, unreadChanges };
  }

  it("counts its session's unread replies and status, marks each seen on its own, and tells its own windows and the dock", async () => {
    const { view, service, transcript, reply, open, store, unreadChanges } = setup();

    const mine = open(view.file);
    const theirs = open(view.otherFile);

    expect(mine.frames[0]).toMatchObject({ type: 'hello', unread: 0 });
    transcript('D:/w12', 'n2', [reply('a1', 'One.'), reply('a2', 'Two.\n[status]\nDone.')]);
    transcript('D:/w3', 'n3', [reply('b1', 'Theirs.')]);
    await service.poll();

    expect(mine.frames.filter((frame) => frame.type === 'reply')).toMatchObject([{ reply: { opening: 'One.', unread: true } }, { reply: { opening: 'Two.', unread: true } }]);
    expect(mine.frames.filter((frame) => frame.type === 'reply')[0]!['reply']).not.toHaveProperty('seenAt');
    expect(mine.frames.filter((frame) => frame.type === 'status')).toMatchObject([{ status: { markdown: 'Done.', unread: true } }]);
    expect(mine.frames.filter((frame) => frame.type === 'unread').at(-1)).toMatchObject({ count: 3 });
    expect(theirs.frames.filter((frame) => frame.type === 'unread').at(-1)).toMatchObject({ count: 1 });
    // Each session's count changed, so the dock's rows are built again.
    expect(unreadChanges.count).toBeGreaterThanOrEqual(2);

    const [one, two] = store.conversation('s2', null, 10).items.map((item) => item.id);
    const statusId = store.latestStatus('s2')!.id;
    const before = { mine: mine.frames.length, theirs: theirs.frames.length, changes: unreadChanges.count };

    // Another window's item, an unknown ID, another session, a stale scope and a malformed body mark nothing.
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o1', sessionId: 's2', ids: [two, store.conversation('s3', null, 10).items[0]!.id] })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o2', sessionId: 's2', ids: ['forged'] })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o3', sessionId: 's3', ids: [] })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.seen({ window: theirs.key, scopeGen: 1, opId: 'o4', sessionId: 's2', ids: [two] })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.seen({ window: mine.key, scopeGen: 0, opId: 'o5', sessionId: 's2', ids: [two] })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o6', sessionId: 's2', ids: 'x' }).status).toBe(400);
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o7', sessionId: 's2', ids: Array.from({ length: 201 }, () => two) }).status).toBe(400);
    expect(store.unreadCount('s2')).toBe(3);
    expect(mine.frames.length).toBe(before.mine);

    // The second reply and the status are seen; the first stays unread.
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o8', sessionId: 's2', ids: [two, statusId] })).toEqual({ status: 200, body: { unread: 1 } });
    const after = mine.frames.slice(before.mine);

    expect(after.filter((frame) => frame.type === 'reply')).toMatchObject([{ reply: { id: two, unread: false } }]);
    expect(after.filter((frame) => frame.type === 'status')).toMatchObject([{ status: { id: statusId, unread: false } }]);
    expect(after.filter((frame) => frame.type === 'unread')).toMatchObject([{ count: 1 }]);
    expect(theirs.frames.length).toBe(before.theirs);
    expect(unreadChanges.count).toBe(before.changes + 1);
    expect(store.reply(one!)?.seenAt).toBeNull();

    // Marking again sends nothing new and leaves the dock alone.
    const again = mine.frames.length;

    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o8', sessionId: 's2', ids: [two] })).toEqual({ status: 200, body: { unread: 1 } });
    expect(mine.frames.length).toBe(again);
    expect(unreadChanges.count).toBe(before.changes + 1);

    // Any change counts again, as a message that pushes an unread reply past the retention limit.
    store.markSeen('s2', [one!], NOW);
    transcript('D:/w12', 'n2', [reply('a1', 'One.'), reply('a2', 'Two.\n[status]\nDone.'), JSON.stringify({ type: 'user', uuid: 'u3', timestamp: new Date(NOW).toISOString(), message: { role: 'user', content: 'Next?' } })]);
    await service.poll();
    expect(mine.frames.filter((frame) => frame.type === 'unread').at(-1)).toMatchObject({ count: 0 });
    expect(unreadChanges.count).toBe(before.changes + 2);
    store.updateReply(one!, { seenAt: null });

    // A reconnect's hello carries the count and each item's state.
    mine.stream.close();
    expect(open(view.file).frames[0]).toMatchObject({ type: 'hello', unread: 1, items: [{ id: one, unread: true }, { id: two, unread: false }, { type: 'message', text: 'Next?' }], status: { unread: false } });
  });

  it('reads a live session\'s transcript at once when the hub asks before a turn end, and nothing for an unknown session (PRD R103)', () => {
    const { service, transcript, reply, store } = setup();

    transcript('D:/w12', 'n2', [reply('a1', 'Which one?\n\n- A) This\n- B) That')]);
    service.readNow(['s2', 'forged']);

    expect(store.conversation('s2', null, 10).items).toMatchObject([{ type: 'reply', opening: 'Which one?\n\n- A) This\n- B) That' }]);
    expect(store.conversation('s3', null, 10).items).toEqual([]);
  });

  it("says hello with the window's scope, its current session and its items, and sends each window only its own session's replies", async () => {
    const { view, service, transcript, reply, open } = setup();

    transcript('D:/w12', 'n2', [reply('a1', 'Mine.')]);
    transcript('D:/w3', 'n3', [reply('b1', 'Not yours.')]);

    const mine = open(view.file);
    const theirs = open(view.otherFile);

    expect(mine.frames).toMatchObject([{ v: 1, seq: 1, type: 'hello', protocol: 1, scope: { workItemId: 2, sessionId: 's2', scopeGen: 1 }, sessions: [{ id: 's2', state: 'running', conversation: 'full' }], items: [], more: false }]);
    await service.poll();
    expect(mine.frames.slice(1)).toMatchObject([{ type: 'reply', reply: { sessionId: 's2', opening: 'Mine.', kind: 'reply', source: 'transcript' } }, { type: 'unread', count: 1 }]);
    expect(theirs.frames.slice(1)).toMatchObject([{ type: 'reply', reply: { sessionId: 's3', opening: 'Not yours.' } }, { type: 'unread', count: 1 }]);
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
    expect(service.history({ window: key, scopeGen: 0, opId: 'o4', sessionId: 's2', before: null })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.history({ window: key, scopeGen: 1, sessionId: 's2' })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, before, limit?}.' } });

    const page = service.history({ window: key, scopeGen: 1, opId: 'o5', sessionId: 's2', before: null, limit: 1 });

    expect(page).toMatchObject({ status: 200, body: { items: [{ opening: 'Two.' }], more: true } });
    expect(store.conversation('s2', null, 10).items).toHaveLength(2);
  });

  it("says hello with the stage before the session's first status, then each window its own session's latest status, once", async () => {
    const { view, service, transcript, reply, open, store } = setup();

    store.updateWorkItem(2, { stage: 'Reading the inbox code', stageAt: NOW - 60_000 });

    const mine = open(view.file);
    const theirs = open(view.otherFile);

    expect(mine.frames[0]).toMatchObject({ type: 'hello', status: { id: 'stage-2', sessionId: 's2', at: NOW - 60_000, markdown: 'Reading the inbox code', fallback: true } });
    // Item 3 has no stage, so its row is empty.
    expect(theirs.frames[0]).toMatchObject({ type: 'hello', status: null });

    // A changed stage reaches the window with the next snapshot, once.
    store.updateWorkItem(2, { stage: 'Writing the fix', stageAt: NOW });
    service.sessionsChanged();
    service.sessionsChanged();
    expect(mine.frames.filter((frame) => frame.type === 'status')).toMatchObject([{ status: { markdown: 'Writing the fix', fallback: true } }]);

    transcript('D:/w12', 'n2', [reply('a1', 'Fixed.\n[status]\n## Done\n- the badge')]);
    transcript('D:/w3', 'n3', [reply('b1', 'Theirs.\n[status]\nNot yours.')]);
    await service.poll();
    service.sessionsChanged();

    expect(mine.frames.filter((frame) => frame.type === 'status').at(-1)).toMatchObject({ status: { sessionId: 's2', markdown: '## Done\n- the badge', fallback: false } });
    expect(mine.frames.filter((frame) => frame.type === 'status')).toHaveLength(2);
    expect(mine.frames.find((frame) => frame.type === 'reply')).toMatchObject({ reply: { opening: 'Fixed.' } });
    expect(JSON.stringify(mine.frames)).not.toContain('Not yours.');
    expect(theirs.frames.filter((frame) => frame.type === 'status')).toMatchObject([{ status: { sessionId: 's3', markdown: 'Not yours.' } }]);
    // The store's work item and reply fields stay in the hub.
    const shown = mine.frames.filter((frame) => frame.type === 'status').at(-1)!['status'];

    expect(shown).not.toHaveProperty('workItemId');
    expect(shown).not.toHaveProperty('replyId');

    // A reconnect gets the latest status in its hello.
    mine.stream.close();
    expect(open(view.file).frames[0]).toMatchObject({ status: { markdown: '## Done\n- the badge', fallback: false } });
  });

  it("serves a window's earlier statuses newest first, and refuses another window's session, a forged key or a stale scope generation", async () => {
    const { view, service, transcript, reply, open } = setup();

    transcript('D:/w12', 'n2', [reply('a1', '[status]\nOne.'), reply('a2', '[status]\nTwo.'), reply('a3', '[status]\nThree.')]);
    transcript('D:/w3', 'n3', [reply('b1', '[status]\nTheirs.')]);
    await service.poll();

    const { key, frames } = open(view.file);
    const other = open(view.otherFile).key;
    const latest = (frames[0]!['status'] as { id: string; markdown: string });

    expect(latest.markdown).toBe('Three.');
    expect(service.statuses({ window: key, scopeGen: 1, opId: 'o1', sessionId: 's2', before: latest.id, limit: 1 })).toMatchObject({ status: 200, body: { statuses: [{ markdown: 'Two.', fallback: false }], more: true } });
    expect(service.statuses({ window: key, scopeGen: 1, opId: 'o2', sessionId: 's2', before: null })).toMatchObject({ status: 200, body: { statuses: [{ markdown: 'Three.' }, { markdown: 'Two.' }, { markdown: 'One.' }], more: false } });
    expect(service.statuses({ window: key, scopeGen: 1, opId: 'o3', sessionId: 's3', before: null })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.statuses({ window: other, scopeGen: 1, opId: 'o4', sessionId: 's2', before: null })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.statuses({ window: 'forged', scopeGen: 1, opId: 'o5', sessionId: 's2', before: null })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.statuses({ window: key, scopeGen: 0, opId: 'o6', sessionId: 's2', before: null })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.statuses({ window: key, scopeGen: 1, sessionId: 's2', before: 3 })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, before, limit?}.' } });
    // Another session's status as the cursor has nothing before it.
    const theirs = service.statuses({ window: other, scopeGen: 1, opId: 'o7', sessionId: 's3', before: null }) as { body: { statuses: Array<{ id: string }> } };

    expect(service.statuses({ window: key, scopeGen: 1, opId: 'o8', sessionId: 's2', before: theirs.body.statuses[0]!.id })).toEqual({ status: 200, body: { statuses: [], more: false } });
  });

  it("lists its session's slash commands from the transcript for the window's composer, and refuses another window's session, a forged key or a stale scope generation", async () => {
    const { view, service, transcript, reply, open } = setup();
    const listing = (initial: boolean, skills: Array<[string, string]>) =>
      JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content: skills.map(([name, description]) => `- ${name}: ${description}`).join('\n'), isInitial: initial, names: skills.map(([name]) => name) } });

    transcript('D:/w12', 'n2', [listing(true, [['hello7', 'Say hello seven'], ['init', 'Initialize a new CLAUDE.md file']]), reply('a1', 'Hi.'), listing(false, [['demo-video', 'Record a video']])]);
    transcript('D:/w3', 'n3', [listing(true, [['theirs', 'Not yours']])]);
    await service.poll();

    const { key } = open(view.file);
    const other = open(view.otherFile).key;

    expect(service.commands({ window: key, scopeGen: 1, opId: 'o1', sessionId: 's2' })).toEqual({
      status: 200,
      body: {
        commands: [
          { name: 'clear', description: 'Clear the conversation history and free up context' },
          { name: 'compact', description: 'Clear the conversation history but keep a summary in context. Optional: /compact [instructions]' },
          { name: 'hello7', description: 'Say hello seven' },
          { name: 'init', description: 'Initialize a new CLAUDE.md file' },
          { name: 'demo-video', description: 'Record a video' },
        ],
      },
    });
    expect(service.commands({ window: key, scopeGen: 1, opId: 'o2', sessionId: 's3' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.commands({ window: other, scopeGen: 1, opId: 'o3', sessionId: 's2' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.commands({ window: 'forged', scopeGen: 1, opId: 'o4', sessionId: 's2' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(service.commands({ window: key, scopeGen: 0, opId: 'o5', sessionId: 's2' })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.commands({ window: key, scopeGen: 1, sessionId: 7 })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId}.' } });
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

    store.insertWorkItem({ ticketId: 1, playbook: null, status: 'queued', createdAt: NOW } as never);
    service.scopesChanged(scopes.update(snapshot([...view.view.workItems, next])));
    expect(frames.slice(-2)).toMatchObject([{ type: 'scope', scope: { workItemId: 4, scopeGen: 2, sessionId: null } }, { type: 'hello', scope: { key, workItemId: 4 }, sessions: [], items: [] }]);
  });
});

describe('ConversationService send', { timeout: 20_000 }, () => {
  /** Waits for typing to settle: each screen read replays it in xterm, which waits on a real timer, so the wait has no budget of its own below the test's. */
  const settled = (check: () => void) => vi.waitFor(check, { timeout: 15_000 });

  function setupSend(held = new FakeHeld(), holderAnswerMs?: number, voice?: ConversationVoice, extra: Partial<ConversationServiceDeps> = {}) {
    const store = Store.open(':memory:');
    const view = world();
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => `k${++keys}` });
    const projects = join(dir, 'projects');
    const logs: string[] = [];
    let id = 0;
    let hooks = true;
    const make = () =>
      new ConversationService({
        store,
        windows: scopes,
        projectsDir: projects,
        claudeConfig: join(dir, '.claude.json'),
        screen: async (session) => held.screen(session),
        input: held,
        hooks: () => hooks,
        ...(holderAnswerMs === undefined ? {} : { holderAnswerMs }),
        now: () => held.clock,
        sleep: async (ms) => {
          held.clock += ms;
          await new Promise((resolve) => setImmediate(resolve));
        },
        newId: () => String(++id),
        ...(voice === undefined ? {} : { voice }),
        log: (line) => logs.push(line),
        ...extra,
      });
    const service = make();

    stored(store, view);
    store.updateSession('s2', { launchId: 'launch-1' });
    store.updateSession('s3', { launchId: 'launch-3' });
    mkdirSync(join(projects, projectSlug('D:/w12')), { recursive: true });
    writeFileSync(join(projects, projectSlug('D:/w12'), 'n2.jsonl'), '');
    held.transcript = (session) => (session === 's2' ? join(projects, projectSlug('D:/w12'), 'n2.jsonl') : null);

    const open = (file: string) => {
      const key = scopes.open(file, view.view);
      const frames: Array<{ type: string; [field: string]: unknown }> = [];

      service.open(key, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

      return { key, frames };
    };
    const body = (key: string, patch: Record<string, unknown> = {}) => ({ window: key, scopeGen: 1, opId: 'op-1', sessionId: 's2', launch: 'launch-1', text: 'Fix the build', ...patch });

    return { store, view, service, held, logs, open, body, make, scopes, setHooks: (on: boolean) => (hooks = on) };
  }

  it("types a message into the window's session, answers at once with it open, and shows it sent once the transcript has it, in its own window only", async () => {
    const { service, held, open, body, view, store } = setupSend();
    const mine = open(view.file);
    const theirs = open(view.otherFile);
    const answer = service.send(body(mine.key));

    expect(answer).toMatchObject({ status: 200, body: { message: { type: 'message', id: 'm-1', origin: 'typed', text: 'Fix the build', delivery: 'open', error: null } } });
    expect((answer.body as { message: object }).message).not.toHaveProperty('opId');
    await settled(() => expect(store.message('m-1')?.delivery).toBe('sent'));

    expect(held.writes).toEqual(['\u001b[200~Fix the build\u001b[201~', '\r']);
    expect(held.reservations).toEqual([{ sessionId: 's2', launch: 'launch-1' }]);
    expect(held.released).toBe(1);
    expect(mine.frames.filter((frame) => frame.type === 'message')).toMatchObject([{ message: { id: 'm-1', delivery: 'open' } }, { message: { id: 'm-1', delivery: 'sent' } }]);
    expect(theirs.frames.filter((frame) => frame.type === 'message')).toEqual([]);

    // The transcript's entry confirms the message in place, with no second copy.
    await service.poll();
    expect(store.conversation('s2', null, 10).items).toMatchObject([{ id: 'm-1', delivery: 'sent', transcriptUuid: 'typed-2' }]);

    // A retried command returns the first message and types nothing again; the stored message keeps when it was pasted, which the view never gets.
    expect(service.send(body(mine.key, { text: 'other words' }))).toMatchObject({ status: 200, body: { message: { id: 'm-1', text: 'Fix the build' } } });
    expect(held.writes).toHaveLength(2);
    expect(store.message('m-1')?.pastedAt).toEqual(expect.any(Number));
    expect(JSON.stringify(mine.frames)).not.toContain('pastedAt');
  });

  /** A voice that records what the conversation layer asks of it. */
  function fakeVoice(spoken = { spoken: true, expressive: false }) {
    const calls: string[] = [];
    const voice: ConversationVoice = {
      shown: (key) => ({ enabled: true, here: key === 'k1', mic: 'off', speaking: null, speakReplies: true, error: null, recognizer: null }),
      settings: () => ({ expandReplies: true }),
      spokenFor: (sessionId, command) => {
        calls.push(`spokenFor ${sessionId} ${command}`);
        return command ? { spoken: false, expressive: false } : spoken;
      },
      replyChanged: (reply) => void calls.push(`reply ${reply.opening}`),
      talkHere: (key) => (key === 'k1' ? null : 'Voice is off (voice.enabled).'),
      stopSpeaking: () => 'Voice is not in this window.',
      setSpeakReplies: (on) => void calls.push(`speak-replies ${on}`),
      replay: (_key, replyId) => (replyId === 'r-x' ? 'Not in this window.' : null),
      update: () => void calls.push('update'),
      selected: (key) => void calls.push(`selected ${key}`),
      expressive: () => true,
    };

    return { voice, calls };
  }

  it('types [spoken] before a message whose reply will be heard, keeps the text without it, and confirms it by its tagged line (architecture.md § Voice)', async () => {
    const { voice, calls } = fakeVoice({ spoken: true, expressive: true });
    const { service, held, open, body, view, store } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(view.file);

    expect(mine.frames[0]).toMatchObject({ type: 'hello', voice: { enabled: true, here: true, mic: 'off' }, settings: { expandReplies: true } });
    expect(service.send(body(mine.key, { text: '/x why' }))).toMatchObject({ status: 200, body: { message: { id: 'm-1', text: '/x why', spokenRequested: true } } });
    await settled(() => expect(store.message('m-1')?.delivery).toBe('sent'));
    expect(held.writes[0]).toBe('\u001b[200~[spoken] [expressive] \\/x why\u001b[201~');
    await service.poll();
    expect(store.conversation('s2', null, 10).items).toMatchObject([{ id: 'm-1', text: '/x why', transcriptUuid: 'typed-2', spokenRequested: true }]);

    // A slash command chosen from the list goes untagged.
    expect(service.send(body(mine.key, { opId: 'op-2', text: '/compact', command: true }))).toMatchObject({ status: 200, body: { message: { spokenRequested: false } } });
    await settled(() => expect(store.message('m-2')?.delivery).toBe('sent'));
    expect(held.writes[2]).toBe('\u001b[200~/compact\u001b[201~');
    expect(calls.filter((call) => call.startsWith('spokenFor'))).toEqual(['spokenFor s2 false', 'spokenFor s2 true']);
  });

  it("lists the personas and pins one to the window's session only, with the header showing it at once (architecture.md § Personas)", () => {
    const nova = { id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm.' } as const;
    let personas: PersonaView = { enabled: true, personas: [nova], playbookPersonas: {} };
    const pins: string[] = [];
    let store!: Store;
    const { service, open, view, ...rest } = setupSend(new FakeHeld(), undefined, undefined, {
      personas: () => personas,
      pinPersona: (sessionId, personaId) => {
        if (personaId === 'vega') {
          return 'No persona vega in voice.personas.';
        }

        pins.push(`${sessionId} ${personaId}`);
        store.updateSession(sessionId, { personaId, personaPinned: personaId !== null });
        return null;
      },
    });

    store = rest.store;

    const mine = open(view.file);
    const theirs = open(view.otherFile);
    let op = 0;
    const command = (name: 'persona' | 'personas', patch: Record<string, unknown> = {}, window = mine.key) => service.personaCommand(name, { window, scopeGen: 1, opId: `o${++op}`, ...patch });

    expect(mine.frames[0]).toMatchObject({ type: 'hello', sessions: [{ id: 's2', persona: null }] });
    expect(command('personas')).toEqual({ status: 200, body: { personas: [{ id: 'nova', name: 'Nova' }] } });
    expect(command('persona', { sessionId: 's2', personaId: 'nova' })).toEqual({ status: 200, body: { persona: { id: 'nova', name: 'Nova', pinned: true, tonePending: true } } });
    expect(mine.frames.at(-1)).toMatchObject({ type: 'session', session: { id: 's2', persona: { name: 'Nova', pinned: true } } });
    expect(theirs.frames.filter((frame) => frame.type === 'session')).toMatchObject([{ session: { id: 's3', persona: null } }]);
    expect(command('persona', { sessionId: 's2', personaId: null })).toMatchObject({ status: 200, body: { persona: null } });
    // A repeated opId answers the first result and pins nothing again.
    expect(command('persona', { sessionId: 's2', personaId: 'nova', opId: 'o2' })).toEqual({ status: 200, body: { persona: { id: 'nova', name: 'Nova', pinned: true, tonePending: true } } });
    expect(store.session('s2')).toMatchObject({ personaId: null, personaPinned: false });

    // Another window's session, a stale generation, an unknown persona, a malformed body and voice off are refused.
    expect(command('persona', { sessionId: 's3', personaId: 'nova' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(command('persona', { sessionId: 's3', personaId: 'nova' }, theirs.key)).toMatchObject({ status: 200 });
    expect(command('persona', { sessionId: 's2', personaId: 'nova', scopeGen: 0 })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(command('persona', { sessionId: 's2', personaId: 'vega' })).toEqual({ status: 409, body: { error: 'No persona vega in voice.personas.' } });
    expect(command('persona', { sessionId: 's2' })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, personaId}.' } });
    personas = { ...personas, enabled: false };
    expect(command('personas')).toEqual({ status: 200, body: { personas: [] } });
    expect(command('persona', { sessionId: 's2', personaId: 'nova' })).toEqual({ status: 409, body: { error: 'Voice is off (voice.enabled).' } });
    expect(pins).toEqual(['s2 nova', 's2 null', 's3 nova']);
  });

  it('gives the fragments log a dictated message the transcript confirmed before its typing ended', async () => {
    const { voice, calls } = fakeVoice({ spoken: false, expressive: false });
    const held = new FakeHeld();
    const pieces = [{ text: 'fix the build', score: null, f0: null, dropped: false }];
    let dictatedId = '';

    voice.delivered = (message) => void calls.push(`delivered ${message.id} ${message.delivery}`);

    const { service, open, view, store } = setupSend(held, undefined, voice);
    const mine = open(view.file);
    const write = held.write.bind(held);

    // The transcript reader confirms the dictated message as its Enter goes in, before its typing ends.
    held.write = async (session, data) => {
      const result = await write(session, data);

      if (data === '\r' && dictatedId !== '') {
        store.updateMessage(dictatedId, { delivery: 'sent' });
      }

      return result;
    };

    const sent = service.dictate(mine.key, 's2', 'fix the build', pieces, false);

    dictatedId = 'message' in sent ? sent.message.id : '';
    await vi.waitFor(() => expect(calls).toContain(`delivered ${dictatedId} sent`));
  });

  it('logs one timing line per typed message, with the voice\'s steps for a dictated one', async () => {
    const { voice, calls } = fakeVoice({ spoken: false, expressive: false });
    const held = new FakeHeld();
    const pieces = [{ text: 'fix the build', score: null, f0: null, dropped: false }];
    let dictatedId = '';

    voice.delivered = (message) => void calls.push(`delivered ${message.id} ${message.delivery}`);
    voice.timing = (id) => (id === dictatedId ? 'last word → turn model decision 600 ms, decision → voice sent 200 ms, voice → hub 2 ms' : null);

    const { service, open, body, view, store, logs } = setupSend(held, undefined, voice);
    const mine = open(view.file);
    const write = held.write.bind(held);

    // The transcript reader confirms the dictated message as its Enter goes in, before its typing ends.
    held.write = async (session, data) => {
      const result = await write(session, data);

      if (data === '\r' && dictatedId !== '') {
        store.updateMessage(dictatedId, { delivery: 'sent' });
      }

      return result;
    };

    const sent = service.dictate(mine.key, 's2', 'fix the build', pieces, false);

    dictatedId = 'message' in sent ? sent.message.id : '';
    await vi.waitFor(() => expect(calls).toContain(`delivered ${dictatedId} sent`));
    expect(logs.filter((line) => line.includes(`message ${dictatedId}`))).toEqual([
      expect.stringMatching(new RegExp(`^session s2: message ${dictatedId} sent: last word → turn model decision 600 ms, decision → voice sent 200 ms, voice → hub 2 ms, queue 0 ms, guards \\d+ ms, paste→echo \\d+ ms, paste→Enter \\d+ ms, Enter→transcript \\d+ ms, \\d+ screen reads in \\d+ ms, \\d+ ms in all$`)),
    ]);

    // A typed message's line has the input steps only.
    dictatedId = '';
    expect(service.send(body(mine.key, { text: 'Typed', opId: 'op-typed' }))).toMatchObject({ status: 200 });
    await vi.waitFor(() => expect(logs.some((line) => /^session s2: message m-\d+ sent: queue \d+ ms, guards/.test(line))).toBe(true));
  });

  it('types a draft that holds dictation as a [voice] message with its pieces, and the voice\'s turns and [partial] parts with their tags (architecture.md § Dictation)', async () => {
    const { voice, calls } = fakeVoice({ spoken: true, expressive: false });
    const pieces = [{ text: 'fix the build', score: null, f0: null, dropped: false }];
    let held = pieces as typeof pieces | null;

    voice.dictated = (key) => {
      calls.push(`dictated ${key}`);
      const taken = held;

      held = null;
      return taken;
    };
    voice.delivered = (message) => void calls.push(`delivered ${message.id} ${message.delivery}`);

    const { service, held: holder, open, body, view, store } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(view.file);

    expect(service.send(body(mine.key, { text: 'Fix the build, please' }))).toMatchObject({ status: 200, body: { message: { id: 'm-1', origin: 'voice', pieces, spokenRequested: true } } });
    await settled(() => expect(store.message('m-1')?.delivery).toBe('sent'));
    expect(holder.writes[0]).toBe('\u001b[200~[spoken] [voice] Fix the build, please\u001b[201~');
    expect(calls).toContain('delivered m-1 sent');

    // The voice's own turn, and a [partial] part, which never asks for a spoken reply.
    expect(service.dictate(mine.key, 's2', 'and the tests', pieces, true)).toMatchObject({ message: { id: 'm-3', origin: 'voice', partial: true, spokenRequested: false } });
    await settled(() => expect(store.message('m-3')?.delivery).toBe('sent'));
    expect(holder.writes.at(-2)).toBe('\u001b[200~[voice] [partial] and the tests\u001b[201~');
    expect(service.dictate(mine.key, 's2', 'too', pieces, false)).toMatchObject({ message: { origin: 'voice', spokenRequested: true } });

    // Into the session through its terminal window, with no window key: typed the same way; one for an unknown session is refused to no window.
    const sent = service.dictate(null, 's2', 'from the terminal', pieces, false);

    expect(sent).toMatchObject({ message: { origin: 'voice', spokenRequested: true } });
    // The queue types in order, so this, the last message, settling means none is still typing when the test's folder is removed.
    await settled(() => expect(store.message((sent as { message: { id: string } }).message.id)?.delivery).toBe('sent'));
    expect(holder.writes).toContain('\u001b[200~[spoken] [voice] from the terminal\u001b[201~');
    const before = mine.frames.length;

    expect(service.dictate(null, 'nope', 'hello', pieces, false)).toEqual({ refused: 'The session has ended. Open it in the terminal to resume it.' });
    expect(mine.frames).toHaveLength(before);

    // Refused for another session than the window's, before anything is stored, with a refused message to the window only.
    expect(service.dictate(mine.key, 's3', 'hello', pieces, false)).toEqual({ refused: "The voice's session is no longer this window's." });
    expect(mine.frames.filter((frame) => frame.type === 'message' && (frame.message as { delivery: string }).delivery === 'refused')).toMatchObject([
      { message: { origin: 'voice', text: 'hello', delivery: 'refused', error: "The voice's session is no longer this window's." } },
    ]);
    expect(store.conversation('s3', null, 10).items).toEqual([]);
    expect(service.voiceCommand('composer', { window: mine.key, scopeGen: 1, opId: 'o', focused: 'yes', draft: '' })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, focused, draft}.' } });
  });

  it('types a dictated message that spoke over a reply with its interruption note after the tags, stores the reply, and retypes it the same (architecture.md § Voice check and barge-in)', async () => {
    const { voice } = fakeVoice({ spoken: true, expressive: false });
    const pieces = [{ text: 'hold on', score: 0.9, f0: 110, dropped: false }];
    const interrupted = { replyId: 'r1', said: 'The session token', rest: 'is refreshed in two places.' };
    let held: Interruption | null = interrupted;

    voice.dictated = () => pieces;
    voice.interruption = () => {
      const taken = held;

      held = null;
      return taken;
    };

    const { service, held: holder, open, body, view, store } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(view.file);

    expect(service.send(body(mine.key, { text: 'hold on' }))).toMatchObject({ status: 200, body: { message: { id: 'm-1', origin: 'voice', interrupted } } });
    await settled(() => expect(store.message('m-1')?.delivery).toBe('sent'));
    expect(holder.writes[0]).toBe('\u001b[200~[spoken] [voice] [heard all of your reply but: "is refreshed in two places."] hold on\u001b[201~');
    expect(store.message('m-1')).toMatchObject({ text: 'hold on', interrupted });
    expect(typedText(store.message('m-1')!, false, true)).toBe('[spoken] [voice] [heard all of your reply but: "is refreshed in two places."] hold on');

    // The voice's own turn names the reply it spoke over; a [partial] part never does.
    const part = service.dictate(mine.key, 's2', 'wait', pieces, true, interrupted);

    expect(part).toMatchObject({ message: { partial: true } });
    expect(part).not.toHaveProperty('message.interrupted');
    expect(service.dictate(mine.key, 's2', 'stop', pieces, false, { replyId: 'r2', said: '', rest: 'Done.' })).toMatchObject({ message: { interrupted: { replyId: 'r2' } } });
    await settled(() => expect(holder.writes.some((write) => write.includes('[voice] [interrupted your reply before its first words] stop'))).toBe(true));
    // A typed message holds no dictation, and so names no reply.
    voice.dictated = () => null;
    held = interrupted;
    const typed = service.send(body(mine.key, { text: 'typed', opId: 'o-typed' }));

    expect(typed).toMatchObject({ status: 200, body: { message: { origin: 'typed', text: 'typed' } } });
    expect(typed).not.toHaveProperty('body.message.interrupted');
    expect(held).toEqual(interrupted);
    // The last message settling means none is still typing when the test's folder is removed.
    await settled(() => expect(store.message((typed.body as { message: { id: string } }).message.id)?.delivery).toBe('sent'));
  });

  it('runs the voice commands for the window only: Talk here, Stop speaking, Speak replies and Replay, with their refusals', () => {
    const { voice, calls } = fakeVoice();
    const { service, open, view } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(view.file);
    const theirs = open(view.otherFile);
    const command = (name: Parameters<typeof service.voiceCommand>[0], patch: Record<string, unknown> = {}, window = mine.key) => service.voiceCommand(name, { window, scopeGen: 1, opId: 'o', ...patch });

    expect(command('talk-here')).toEqual({ status: 200, body: { done: true } });
    expect(command('talk-here', {}, theirs.key)).toEqual({ status: 409, body: { error: 'Voice is off (voice.enabled).' } });
    expect(command('talk-here', {}, 'forged')).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(command('talk-here', { scopeGen: 0 })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(command('stop-speaking')).toEqual({ status: 409, body: { error: 'Voice is not in this window.' } });
    expect(command('speak-replies', { on: false })).toEqual({ status: 200, body: { on: false } });
    expect(command('speak-replies')).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, on}.' } });
    expect(command('replay', { replyId: 'r-1' })).toEqual({ status: 200, body: { done: true } });
    // The mic and the composer reach the voice; a hub with no mic says so.
    expect(command('mic', { on: true })).toEqual({ status: 409, body: { error: 'This hub has no voice.' } });
    voice.mic = (key, on) => (key === mine.key ? (calls.push(`mic ${on}`), null) : 'Voice is off (voice.enabled).');
    voice.composer = (key, focused, draft) => void calls.push(`composer ${focused} ${draft}`);
    expect(command('mic', { on: true })).toEqual({ status: 200, body: { on: true } });
    expect(command('mic', { on: true }, theirs.key)).toEqual({ status: 409, body: { error: 'Voice is off (voice.enabled).' } });
    expect(command('mic')).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, on}.' } });
    expect(command('composer', { focused: true, draft: 'fix' })).toEqual({ status: 200, body: { done: true } });
    expect(calls.slice(-2)).toEqual(['mic true', 'composer true fix']);
    expect(command('replay', { replyId: 'r-x' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(command('replay')).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, replyId}.' } });
    expect(service.voiceCommand('talk-here', { window: mine.key, scopeGen: 1 })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId}.' } });
    expect(calls).toContain('speak-replies false');
    // Selecting a conversation tells the voice, which moves at once when the window has the focus.
    expect(service.select({ window: mine.key, scopeGen: 1, opId: 'sel', workItemId: 2 }).status).toBe(200);
    expect(calls).toContain(`selected ${mine.key}`);

    // Without voice, the commands are not part of the hub.
    const plain = setupSend();
    const key = plain.open(plain.view.file).key;

    expect(plain.service.voiceCommand('talk-here', { window: key, scopeGen: plain.scopes.scope(key)!.scopeGen, opId: 'o' })).toEqual({ status: 404, body: { error: 'This hub has no voice.' } });
  });

  it('tells the voice of each reply, sends a reply again when its speech changed, and sends voice events to one window', async () => {
    const { voice, calls } = fakeVoice();
    const { service, open, view, store } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(view.file);
    const theirs = open(view.otherFile);

    writeFileSync(join(dir, 'projects', projectSlug('D:/w12'), 'n2.jsonl'), `${JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: new Date(NOW).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '[speak]Done.[/speak] More.' }] } })}\n`);
    await service.poll();
    expect(calls).toContain('reply Done. More.');

    const reply = store.conversation('s2', null, 10).items[0]!;

    expect(mine.frames.filter((frame) => frame.type === 'reply').at(-1)).toMatchObject({ reply: { speak: 'Done.', tone: null, spoken: { state: 'none', atMs: null, saidChars: null } } });
    expect(mine.frames.filter((frame) => frame.type === 'reply').at(-1)!['reply']).not.toHaveProperty('spokenState');
    store.updateReply(reply.id, { spokenState: 'playing', spokenAtMs: 0, saidChars: 0 });
    service.replyUpdated(reply.id);
    service.replyUpdated('gone');
    expect(mine.frames.filter((frame) => frame.type === 'reply').at(-1)).toMatchObject({ reply: { id: reply.id, spoken: { state: 'playing', atMs: 0 } } });
    service.notify(mine.key, 'progress', { replyId: reply.id, chars: 3, atMs: 150 });
    expect(mine.frames.at(-1)).toMatchObject({ type: 'progress', replyId: reply.id, chars: 3, atMs: 150 });
    expect(theirs.frames.some((frame) => frame.type === 'progress' || JSON.stringify(frame).includes('Done.'))).toBe(false);
  });

  it('refuses a malformed command, another window, a forged session, a stale scope, an empty or long text, and a session that cannot take it', async () => {
    const { service, held, open, body, view, store, setHooks } = setupSend();
    const { key } = open(view.file);
    const other = open(view.otherFile).key;
    const refused = (patch: Record<string, unknown>, window = key) => service.send(body(window, patch));

    expect(service.send({ window: key, scopeGen: 1, sessionId: 's2', text: 'x' })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, text, command?}.' } });
    expect(refused({}, 'forged')).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(refused({ sessionId: 's3', launch: 'launch-3' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(refused({}, other)).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(refused({ scopeGen: 0 })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(refused({ text: '  \n ' })).toEqual({ status: 400, body: { error: 'The message is empty.' } });
    expect(refused({ text: 'x'.repeat(10_001) })).toEqual({ status: 400, body: { error: 'The message is longer than 10,000 characters.' } });
    expect(refused({ launch: 'launch-0' })).toEqual({ status: 409, body: { error: 'The session was resumed since the view showed it; send the message again.' } });
    held.cannotType_ = 'The terminal holder is from an older build and cannot type. To switch to this build, run hub.js holder stop --all.';
    expect(refused({})).toEqual({ status: 409, body: { error: held.cannotType_ } });
    held.cannotType_ = null;
    setHooks(false);
    expect(refused({})).toEqual({ status: 409, body: { error: 'Switchboard cannot follow this session while sessions.installHooks is off.' } });
    setHooks(true);
    store.updateSession('s2', { state: 'ended' });
    expect(refused({})).toEqual({ status: 409, body: { error: 'The session has ended. Open it in the terminal to resume it.' } });

    expect(store.conversation('s2', null, 10).items).toEqual([]);
    expect(held.writes).toEqual([]);
  });

  it('types a slash command chosen from the list as it is, refuses one that is not a single /name line, and escapes a message that starts with a slash', async () => {
    const { service, held, open, body, view, store } = setupSend();
    const { key } = open(view.file);

    expect(service.send(body(key, { opId: 'op-c0', text: '/compact\nnow', command: true }))).toEqual({ status: 400, body: { error: 'A slash command is one line that starts with /name.' } });
    expect(service.send(body(key, { opId: 'op-c1', text: 'compact now', command: true }))).toEqual({ status: 400, body: { error: 'A slash command is one line that starts with /name.' } });
    expect(service.send(body(key, { opId: 'op-c2', text: '/compact', command: 'yes' }))).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, text, command?}.' } });
    expect(held.writes).toEqual([]);

    expect(service.send(body(key, { opId: 'op-c3', text: '/compact keep the plan', command: true }))).toMatchObject({ status: 200, body: { message: { id: 'm-1', text: '/compact keep the plan' } } });
    await settled(() => expect(store.message('m-1')?.delivery).toBe('sent'));
    expect(service.send(body(key, { opId: 'op-c4', text: '/compact keep the plan', command: false }))).toMatchObject({ status: 200 });
    await settled(() => expect(store.message('m-2')?.delivery).toBe('sent'));

    expect(held.writes).toEqual(['\u001b[200~/compact keep the plan\u001b[201~', '\r', '\u001b[200~\\/compact keep the plan\u001b[201~', '\r']);
  });

  it('types nothing when the session ends while the message waits on a menu, and says why', async () => {
    const { service, held, open, body, view, store, logs } = setupSend();
    const { key, frames } = open(view.file);

    held.menu = true;
    service.send(body(key));
    await settled(() => expect(logs).toContain('session s2: a message waits, a menu is open'));
    store.updateSession('s2', { state: 'ended' });
    await settled(() => expect(store.message('m-1')).toBeNull());

    // It leaves the conversation; its last event tells the window why, with its text, so the composer can take it back.
    expect(frames.at(-1)).toMatchObject({ type: 'message', message: { id: 'm-1', text: 'Fix the build', delivery: 'not-sent', error: 'The session has ended. Open it in the terminal to resume it.' } });
    expect(store.conversation('s2', null, 10).items).toEqual([]);
    // The same command again is refused with why, and types nothing.
    store.updateSession('s2', { state: 'idle' });
    expect(service.send(body(key))).toEqual({ status: 409, body: { error: 'The session has ended. Open it in the terminal to resume it.' } });
    expect(held.writes).toEqual([]);
    expect(held.reservations).toEqual([]);
    expect(logs).toContain('session s2: message m-1 not-sent: The session has ended. Open it in the terminal to resume it.');
  });

  it('types nothing into a session a newer one replaced, or one the reservation refuses', async () => {
    const { service, held, open, body, view, store, logs, scopes } = setupSend();
    const { key, frames } = open(view.file);

    held.refuse = 'The session has ended. Open it in the terminal to resume it.';
    service.send(body(key));
    await settled(() => expect(store.message('m-1')).toBeNull());
    held.refuse = null;

    held.menu = true;
    service.send(body(key, { opId: 'op-2' }));
    store.insertSession({ ...(store.session('s2') as StoredSession), id: 's2b', nativeSessionId: 'n2b', startedAt: NOW + 1 });
    // The window has moved on to the newer session, yet it still hears that its message was not sent.
    vi.spyOn(scopes, 'showing').mockReturnValue([]);
    held.menu = false;
    await settled(() => expect(store.message('m-2')).toBeNull());
    expect(frames.at(-1)).toMatchObject({ type: 'message', message: { id: 'm-2', delivery: 'not-sent', text: 'Fix the build' } });
    expect(logs).toContain('session s2: message m-2 not-sent: A newer session of this work item started; the message was not sent.');
    expect(held.writes).toEqual([]);
  });

  it("types dictation from an older session's own terminal window, which a newer session of its work item does not stop (voice-design decision 9)", async () => {
    const { service, held, store } = setupSend();

    store.insertSession({ ...(store.session('s2') as StoredSession), id: 's2b', nativeSessionId: 'n2b', startedAt: NOW + 1 });
    expect(service.dictate(null, 's2', 'run the tests', [{ text: 'run the tests', score: null, f0: null, dropped: false }], false)).toMatchObject({ message: { origin: 'voice' } });
    await settled(() => expect(held.writes).toContain('\u001b[200~[voice] run the tests\u001b[201~'));
    expect(held.reservations).toEqual([{ sessionId: 's2', launch: 'launch-1' }]);
  });

  it("replays an opId only within the window's current session and scope generation", () => {
    const { service, open, body, view, store } = setupSend();
    const { key } = open(view.file);

    // A message an earlier session of the work item got with this opId.
    store.addMessage({ id: 'm-earlier', sessionId: 's1', workItemId: 2, at: NOW, origin: 'typed', text: 'old', transcriptUuid: null, provisional: false, withdrawn: false, delivery: 'sent', error: null, opId: 'op-1', pastedAt: NOW });
    expect(service.send(body(key, { scopeGen: 0 }))).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.send(body(key))).toMatchObject({ status: 200, body: { message: { id: 'm-1', text: 'Fix the build' } } });
    // The same command again answers the current session's message, not the earlier session's, and adds none.
    expect(service.send(body(key))).toMatchObject({ status: 200, body: { message: { id: 'm-1' } } });
    expect(store.conversation('s2', null, 10).items).toHaveLength(1);
  });

  it('fails a message whose screen read or write the holder does not answer, releasing its reservation', async () => {
    const held = new FakeHeld();
    const { service, open, body, view, store, logs } = setupSend(held, 50);
    const { key } = open(view.file);
    const write = held.write.bind(held);

    // The paste is never answered, and the input box does not hold it, so it counts as sent; its transcript line places it if it lands.
    held.write = () => new Promise(() => undefined);
    service.send(body(key));
    await settled(() => expect(store.message('m-1')?.delivery).toBe('sent'));
    expect(store.message('m-1')?.error).toBeNull();
    expect(held.released).toBe(1);

    // A screen read that is never answered: nothing was typed.
    held.write = write;
    held.screen = () => new Promise(() => undefined);
    service.send(body(key, { opId: 'op-2' }));
    await settled(() => expect(store.message('m-2')).toBeNull());
    expect(logs).toContain('session s2: message m-2 not-sent: The terminal holder did not answer.');
  });

  it('keeps a queue that holds a message after its session leaves the live list, so a second message waits behind the first', async () => {
    const { service, held, open, body, view, store } = setupSend();
    const { key } = open(view.file);

    held.menu = true;
    service.send(body(key));
    // The session is still starting, which the transcript poll leaves out.
    store.updateSession('s2', { state: 'starting' });
    await service.poll();
    service.send(body(key, { opId: 'op-2', text: 'Second' }));
    store.updateSession('s2', { state: 'running' });
    held.menu = false;
    await settled(() => expect(store.message('m-2')?.delivery).toBe('sent'));
    expect(held.writes).toEqual(['\u001b[200~Fix the build\u001b[201~', '\r', '\u001b[200~Second\u001b[201~', '\r']);
  });

  it('settles a spoken message a stopped hub left open by the text it typed, tags included', async () => {
    const { voice } = fakeVoice();
    const { store, make, held, scopes, view } = setupSend(new FakeHeld(), undefined, voice);

    store.addMessage({ id: 'm-spoken', sessionId: 's2', workItemId: 2, at: NOW, origin: 'typed', text: 'half typed', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'op-s', pastedAt: NOW, launch: 'launch-1', spokenRequested: true });
    held.box = '[spoken] [expressive] half typed';

    const service = make();

    service.open(scopes.open(view.file, view.view), () => undefined);
    await settled(() => expect(store.message('m-spoken')).toBeNull());
    service.stop();
    // The box held exactly what was typed, so it was cleared.
    expect(held.writes).toEqual(['\u0015']);
    expect(held.box).toBe('');
  });

  it('settles messages a stopped hub left open once a window shows their session: never typed again, cleared only in their launch, and given back to its composer', async () => {
    const { store, make, held, logs, scopes, view } = setupSend();
    const typed = { sessionId: 's2', workItemId: 2, at: NOW, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open' as const, error: null };
    const stream = (service: ConversationService) => {
      const frames: Array<{ type: string; [field: string]: unknown }> = [];

      service.open(scopes.open(view.file, view.view), (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

      return frames;
    };
    const given = (frames: Array<{ type: string; [field: string]: unknown }>) =>
      frames.filter((frame) => frame.type === 'message').map((frame) => ({ ...(frame['message'] as { id: string; delivery: string; error: string }), giveBack: frame['giveBack'] }));

    store.addMessage({ ...typed, id: 'm-untyped', text: 'never pasted', opId: 'op-a', pastedAt: null, launch: 'launch-1' });
    store.addMessage({ ...typed, id: 'm-held', text: 'half typed', opId: 'op-b', pastedAt: NOW, launch: 'launch-1' });
    held.box = 'half typed';

    const service = make();

    // Nothing is settled before a window that can take the text back connects.
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.message('m-held')?.delivery).toBe('open');

    const frames = stream(service);

    await settled(() => expect(store.message('m-held')).toBeNull());
    service.stop();
    expect(store.message('m-untyped')).toBeNull();
    expect(held.writes).toEqual(['\u0015']);
    expect(held.box).toBe('');
    expect(held.reservations.at(-1)).toEqual({ sessionId: 's2', launch: 'launch-1' });
    expect(given(frames)).toMatchObject([
      { id: 'm-untyped', delivery: 'not-sent', error: 'Switchboard restarted before typing the message. Send it again.', giveBack: true },
      { id: 'm-held', delivery: 'not-sent', error: 'Claude Code did not take the message, so Switchboard cleared it from the input box. Send it again.', giveBack: true },
    ]);
    expect(logs).toContain('session s2: message m-held left open by a stopped hub is settled from the transcript and the screen');

    // One typed into an earlier launch of the session, or by a hub that kept no launch, is never cleared.
    held.box = 'other launch';
    store.addMessage({ ...typed, id: 'm-resumed', text: 'other launch', opId: 'op-c', pastedAt: NOW, launch: 'launch-0' });
    store.addMessage({ ...typed, id: 'm-old', text: 'other launch', opId: 'op-d', pastedAt: NOW });

    const next = make();
    const later = stream(next);

    await settled(() => expect([store.message('m-resumed'), store.message('m-old')]).toEqual([null, null]));
    next.stop();
    expect(held.box).toBe('other launch');
    expect(held.writes).toEqual(['\u0015']);
    expect(given(later).map((one) => [one.id, one.error]).sort()).toEqual([
      ['m-old', 'Switchboard restarted while the message was being typed and could not read its input box: check the terminal before sending it again.'],
      ['m-resumed', 'The session was resumed since the view showed it; send the message again.'],
    ]);

    // A window that closed while its message was settled gets it back when a window shows the session again.
    held.box = 'closed early';
    store.addMessage({ ...typed, id: 'm-closed', text: 'closed early', opId: 'op-f', pastedAt: NOW, launch: 'launch-1' });

    const fourth = make();
    const shortFrames: Array<{ type: string; [field: string]: unknown }> = [];
    const short = fourth.open(scopes.open(view.file, view.view), (frame) => shortFrames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

    short!.close();
    await settled(() => expect(store.message('m-closed')).toBeNull());
    expect(held.box).toBe('');
    expect(given(shortFrames)).toEqual([]);
    expect(given(stream(fourth)).map((one) => [one.id, one.delivery, one.giveBack])).toEqual([['m-closed', 'not-sent', true]]);
    fourth.stop();

    // One the box no longer holds was sent.
    held.box = '';
    store.addMessage({ ...typed, id: 'm-gone', text: 'went through', opId: 'op-e', pastedAt: NOW, launch: 'launch-1' });

    const third = make();

    stream(third);
    await settled(() => expect(store.message('m-gone')?.delivery).toBe('sent'));
    third.stop();
  });
});

describe('sessionView', () => {
  it('names what the view can do with each kind of session', () => {
    expect(sessionView(session({ codeMode: true, state: 'ended' }), true, true)).toMatchObject({ state: 'ended', conversation: 'read-only', reason: 'The session has ended. Open it in the terminal to resume it.' });
    expect(sessionView(session({ codeMode: true, state: 'idle' }), true, false)).toMatchObject({ conversation: 'read-only', reason: 'Switchboard cannot follow this session while sessions.installHooks is off.' });
    expect(sessionView(session({ state: 'waiting', stateDetail: null }), false, true)).toMatchObject({ waitingFor: 'question', conversation: 'none', current: false });
    expect(sessionView(session({ codeMode: true, state: 'failed' }), true, true)).toMatchObject({ state: 'idle', conversation: 'full' });
  });

  it("shows the session's persona while voice is on, and its tone section pending until the prompt has the current one (architecture.md § Personas)", () => {
    const nova = { id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm.' } as const;
    const settings: PersonaView = { enabled: true, personas: [nova], playbookPersonas: {} };
    const delivered = toneVersion(toneSection(nova));

    expect(sessionView(session({ codeMode: true, personaId: 'nova', personaVersion: delivered }), true, true, settings).persona).toEqual({ id: 'nova', name: 'Nova', pinned: false, tonePending: false });
    expect(sessionView(session({ codeMode: true, personaId: 'nova', personaVersion: null, personaPinned: true }), true, true, settings).persona).toEqual({ id: 'nova', name: 'Nova', pinned: true, tonePending: true });
    // An ended session gets the current section when it resumes.
    expect(sessionView(session({ codeMode: true, state: 'ended', personaId: 'nova', personaVersion: null }), true, true, settings).persona?.tonePending).toBe(false);
    // None with voice off, no persona, one gone from the roster, or no settings.
    expect(sessionView(session({ codeMode: true, personaId: 'nova' }), true, true, { ...settings, enabled: false }).persona).toBeNull();
    expect(sessionView(session({ codeMode: true, personaId: null }), true, true, settings).persona).toBeNull();
    expect(sessionView(session({ codeMode: true, personaId: 'vega' }), true, true, settings).persona).toBeNull();
    expect(sessionView(session({ codeMode: true, personaId: 'nova' }), true, true).persona).toBeNull();
  });
});

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
    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => `k${++keys}` });
    const held = new FakeHeld();
    const service = new ConversationService({ store, windows: scopes, projectsDir: join(dir, 'projects'), claudeConfig: join(dir, '.claude.json'), screen: async (one) => held.screen(one), input: held, hooks: () => true, now: () => NOW, newId: () => 'id', log: () => {} });

    stored(store, view);

    const open = (file: string | null) => {
      const key = scopes.open(file, view.view);
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

    return { w12, w3, view, service, open, put, scopes };
  }

  it("lists the window's work item's artifacts in hello, sends its changes to its windows only, and stops watching when its last stream closes", async () => {
    const { w12, w3, view, service, open, put } = setup();

    put(w12, 2, 'chat/plan.md', '---\nkind: plan\ntitle: The plan\n---\n', 2_000_000);
    // The earlier work item of the same worktree, and another work item, have their own folders.
    put(w12, 1, 'chat/old.md', '# Old', 2_000_000);
    put(w3, 3, 'chat/other.md', '# Other', 2_000_000);

    const mine = open(view.file);
    const other = open(view.otherFile);
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
    expect(open(view.file).frames[0]).toMatchObject({ artifacts: [{ path: 'chat/late.md' }, { path: 'chat/comparison-engines.md' }] });
    expect(service.watching().sort()).toEqual([2, 3]);
    service.stop();
    expect(service.watching()).toEqual([]);
  });

  it("stops watching a work item's folder when its window's key closes, even while its conversation stream stays open", () => {
    const { view, service, open, scopes } = setup();
    const mine = open(view.file);

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
    const scopes = new WindowScopes({ store, windows: WINDOWS, now: () => NOW, newKey: () => `k${++keys}` });
    const held = new FakeHeld();
    const focus: Array<[string, boolean]> = [];
    let id = 0;
    const service = new ConversationService({
      store,
      windows: scopes,
      projectsDir: join(dir, 'projects'),
      claudeConfig: join(dir, '.claude.json'),
      screen: async (session) => held.screen(session),
      input: held,
      hooks: () => true,
      now: () => NOW,
      newId: () => String(++id),
      pageGroups: () => pageGroups(view.view, WINDOWS),
      pageFocused: (key, focused) => focus.push([key, focused]),
      log: () => {},
    });

    stored(store, view);
    scopes.update(view.view);

    const openPage = () => {
      const key = scopes.openPage();
      const frames: Array<{ type: string; [field: string]: unknown }> = [];

      service.open(key, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

      return { key, frames };
    };

    return { store, view, scopes, service, openPage, focus };
  }

  it('starts a page unbound with its key and list, binds it to any work item it selects, and holds it to that work item', () => {
    const { scopes, service, openPage, view } = setup();
    const page = openPage();

    expect(scopes.isPage(page.key)).toBe(true);
    expect(page.frames[0]).toMatchObject({ type: 'hello', scope: null, key: page.key, groups: [{ kind: 'item', title: 'Issue <3>', conversations: [{ workItemId: 3 }] }, { kind: 'item', conversations: [{ workItemId: 2 }] }] });
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
    // A page hosts nothing, and its binding is never stored.
    expect(service.newConversation({ window: page.key, opId: 'o4' }).status).toBe(403);
    expect(scopes.hostOf(page.key)).toBeNull();
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

    expect(service.pageList().find((group) => group.conversations.some((entry) => entry.workItemId === 2))?.conversations.map((entry) => entry.workItemId)).toEqual([2, hosted.id]);
    service.select({ window: page.key, opId: 'o', workItemId: hosted.id });
    expect(scopes.scope(page.key)?.conversations).toEqual([{ workItemId: 2, primary: true }, { workItemId: hosted.id, primary: false }]);
    // Done while selected, it stays in its host's group.
    const done = snapshot([...view.view.workItems.filter((one) => one.id !== hosted.id), item(hosted.id, { ticketId: ticket.id, status: 'done', ticket: { ...view.current.ticket, id: ticket.id, title: 'Side chat', hostWindow: view.file } })]);

    store.updateWorkItem(hosted.id, { status: 'done' });
    view.view = done;
    scopes.update(done);
    expect(scopes.scope(page.key)?.conversations).toEqual([{ workItemId: 2, primary: true }, { workItemId: hosted.id, primary: false }]);
    expect(service.pageList().flatMap((group) => group.conversations.map((entry) => entry.workItemId))).not.toContain(hosted.id);
    expect(service.select({ window: page.key, opId: 'o', workItemId: 2 }).status).toBe(200);
    expect(scopes.scope(page.key)).toMatchObject({ workItemId: 2, scopeGen: 2 });
  });

  it("reports a page's focus only for a page key, and ends the page's key with its stream", () => {
    const { scopes, service, openPage, view, focus } = setup();
    const page = openPage();
    const window = scopes.open(view.file, view.view);

    expect(service.pageFocus({ window: page.key, focused: true })).toEqual({ status: 200, body: { focused: true } });
    expect(service.pageFocus({ window, focused: true }).status).toBe(403);
    expect(service.pageFocus({ window: page.key }).status).toBe(400);
    expect(focus).toEqual([[page.key, true]]);

    scopes.close(page.key);
    expect(scopes.isPage(page.key)).toBe(false);
    expect(service.select({ window: page.key, opId: 'o', workItemId: 2 }).status).toBe(403);
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
