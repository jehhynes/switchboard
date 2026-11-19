import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_RULES_VERSION, PERMISSION_PROMPT, Store } from '@switchboard/core';
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
  const current = item(2, { ticketId: 1, ticket: { ...done.ticket }, worktree: worktree('D:/w12'), status: 'blocked', sessions: [session({ id: 's2', workItemId: 2, cwd: 'D:/w12', codeMode: true, nativeSessionId: 'n2', rulesVersion: CONVERSATION_RULES_VERSION })] });
  const other = item(3, { worktree: worktree('D:/w3'), sessions: [session({ id: 's3', workItemId: 3, cwd: 'D:/w3', codeMode: true, nativeSessionId: 'n3', rulesVersion: CONVERSATION_RULES_VERSION })] });
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

describe('ConversationService', () => {
  function setup(held = new FakeHeld()) {
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
      screen: async (session) => held.screen(session),
      input: held,
      hooks: () => true,
      now: () => held.clock,
      sleep: async (ms) => {
        held.clock += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
      newId: () => String(++id),
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

    return { store, view, scopes, service, transcript, reply, open, logs, held };
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
    expect(service.statuses({ window: key, scopeGen: 0, opId: 'o6', sessionId: 's2', before: null })).toEqual({ status: 409, body: { error: "The window's work item changed." } });
    expect(service.statuses({ window: key, scopeGen: 1, sessionId: 's2', before: 3 })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, before, limit?}.' } });
    // Another session's status as the cursor has nothing before it.
    const theirs = service.statuses({ window: other, scopeGen: 1, opId: 'o7', sessionId: 's3', before: null }) as { body: { statuses: Array<{ id: string }> } };

    expect(service.statuses({ window: key, scopeGen: 1, opId: 'o8', sessionId: 's2', before: theirs.body.statuses[0]!.id })).toEqual({ status: 200, body: { statuses: [], more: false } });
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

describe('ConversationService send', () => {
  function setupSend(held = new FakeHeld(), holderAnswerMs?: number) {
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
        log: (line) => logs.push(line),
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
    await vi.waitFor(() => expect(store.message('m-1')?.delivery).toBe('sent'));

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

  it('refuses a malformed command, another window, a forged session, a stale scope, an empty or long text, and a session that cannot take it', async () => {
    const { service, held, open, body, view, store, setHooks } = setupSend();
    const { key } = open(view.file);
    const other = open(view.otherFile).key;
    const refused = (patch: Record<string, unknown>, window = key) => service.send(body(window, patch));

    expect(service.send({ window: key, scopeGen: 1, sessionId: 's2', text: 'x' })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, text}.' } });
    expect(refused({}, 'forged')).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(refused({ sessionId: 's3', launch: 'launch-3' })).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(refused({}, other)).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(refused({ scopeGen: 0 })).toEqual({ status: 409, body: { error: "The window's work item changed." } });
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

  it('types nothing when the session ends while the message waits on a menu, and says why', async () => {
    const { service, held, open, body, view, store, logs } = setupSend();
    const { key, frames } = open(view.file);

    held.menu = true;
    service.send(body(key));
    await vi.waitFor(() => expect(logs).toContain('session s2: a message waits, a menu is open'));
    store.updateSession('s2', { state: 'ended' });
    await vi.waitFor(() => expect(store.message('m-1')).toBeNull());

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
    await vi.waitFor(() => expect(store.message('m-1')).toBeNull());
    held.refuse = null;

    held.menu = true;
    service.send(body(key, { opId: 'op-2' }));
    store.insertSession({ ...(store.session('s2') as StoredSession), id: 's2b', nativeSessionId: 'n2b', startedAt: NOW + 1 });
    // The window has moved on to the newer session, yet it still hears that its message was not sent.
    vi.spyOn(scopes, 'showing').mockReturnValue([]);
    held.menu = false;
    await vi.waitFor(() => expect(store.message('m-2')).toBeNull());
    expect(frames.at(-1)).toMatchObject({ type: 'message', message: { id: 'm-2', delivery: 'not-sent', text: 'Fix the build' } });
    expect(logs).toContain('session s2: message m-2 not-sent: A newer session of this work item started; the message was not sent.');
    expect(held.writes).toEqual([]);
  });

  it("replays an opId only within the window's current session and scope generation", () => {
    const { service, open, body, view, store } = setupSend();
    const { key } = open(view.file);

    // A message an earlier session of the work item got with this opId.
    store.addMessage({ id: 'm-earlier', sessionId: 's1', workItemId: 2, at: NOW, origin: 'typed', text: 'old', transcriptUuid: null, provisional: false, withdrawn: false, delivery: 'sent', error: null, opId: 'op-1', pastedAt: NOW });
    expect(service.send(body(key, { scopeGen: 0 }))).toEqual({ status: 409, body: { error: "The window's work item changed." } });
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

    // The paste is never answered: it may have reached the session.
    held.write = () => new Promise(() => undefined);
    service.send(body(key));
    await vi.waitFor(() => expect(store.message('m-1')?.delivery).toBe('uncertain'));
    expect(store.message('m-1')?.error).toBe('The terminal holder did not answer.');
    expect(held.released).toBe(1);

    // A screen read that is never answered: nothing was typed.
    held.write = write;
    held.screen = () => new Promise(() => undefined);
    service.send(body(key, { opId: 'op-2' }));
    await vi.waitFor(() => expect(store.message('m-2')).toBeNull());
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
    await vi.waitFor(() => expect(store.message('m-2')?.delivery).toBe('sent'));
    expect(held.writes).toEqual(['\u001b[200~Fix the build\u001b[201~', '\r', '\u001b[200~Second\u001b[201~', '\r']);
  });

  it('settles a message a stopped hub left open as uncertain, and never types it again', () => {
    const { store, make, held, logs } = setupSend();

    store.addMessage({ id: 'm-left', sessionId: 's2', workItemId: 2, at: NOW, origin: 'typed', text: 'half typed', transcriptUuid: null, provisional: false, withdrawn: false, delivery: 'open', error: null, opId: 'op-left', pastedAt: NOW });
    make();
    expect(store.message('m-left')).toMatchObject({ delivery: 'uncertain', error: 'Switchboard restarted while the message was being typed; check the terminal.' });
    expect(held.writes).toEqual([]);
    expect(logs).toEqual(['session s2: message m-left left open by a stopped hub is uncertain']);
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
