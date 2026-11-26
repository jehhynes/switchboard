import { appendFileSync, closeSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundDetail, CONVERSATION_RETENTION, PERMISSION_PROMPT, Store, toneSection, toneVersion } from '@switchboard/core';
import type { ConversationMessage, Interruption, Session as StoredSession } from '@switchboard/core';
import { BACKGROUND_DETAIL, projectSlug } from '@switchboard/claude';
import { ConversationService, MIC_TIMING_MAX_MS, MIC_TIMING_STEPS, refusal, sessionView, typedText } from '../src/conversation.js';
import type { ConversationServiceDeps, ConversationVoice, PersonaView } from '../src/conversation.js';
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


/** A page key showing the work item, as a page has once it selected it (architecture.md § Web page). */
function pageOn(scopes: WindowScopes, view: Snapshot, workItemId: number): string {
  scopes.update(view);

  const key = scopes.openPage();

  scopes.select(key, workItemId);
  return key;
}

describe('hosted conversations on the page (architecture.md § Window scope)', () => {
  function setup() {
    const store = Store.open(':memory:');
    const view = world();
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, newKey: () => `k${++keys}` });
    const projects = join(dir, 'projects');
    const held = new FakeHeld();
    let id = 0;
    const titles: Array<{ workItemId: number; title: string; origin: string }> = [];
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
      providerTitle: (workItemId, title, origin) => titles.push({ workItemId, title, origin }),
      log: () => {},
    });
    const hosted: WorkItemView[] = [];

    stored(store, view);

    /** An ad hoc conversation hosted by `host`, a workspace file or a folder, as the flow made one, with its Code Mode session. */
    const host = (hostWindow: string, sessionId: string, status = 'running') => {
      const ticket = store.insertTicket({ source: 'adhoc', sourceKey: sessionId, ref: `#${sessionId}`, sourceId: null, title: 'New session', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: NOW, lastPolledAt: null, repoRoot: 'D:/w12', hostWindow });
      const workItem = store.insertWorkItem({ ticketId: ticket.id, playbook: null, status, createdAt: NOW } as never);
      const one = session({ id: sessionId, workItemId: workItem.id, cwd: 'D:/w12', codeMode: true, nativeSessionId: `n-${sessionId}`, state: 'idle' });

      store.insertSession(one as StoredSession);
      hosted.push(item(workItem.id, { ticketId: ticket.id, status: status as WorkItemView['status'], ticket: { ...view.current.ticket, ...ticket }, worktree: null, focus: null, sessions: [one] }));

      return workItem.id;
    };
    const open = (workItemId: number) => {
      const key = pageOn(scopes, snapshot([...view.view.workItems, ...hosted]), workItemId);
      const frames: Array<{ type: string; [field: string]: unknown }> = [];

      service.open(key, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

      return { key, frames };
    };
    const transcript = (native: string, lines: string[]): void => {
      mkdirSync(join(projects, projectSlug('D:/w12')), { recursive: true });
      writeFileSync(join(projects, projectSlug('D:/w12'), `${native}.jsonl`), lines.map((line) => `${line}\n`).join(''));
    };

    return { store, view, scopes, service, host, open, transcript, titles };
  }

  it('reads Claude automatic and manual titles from the transcript', async () => {
    const context = setup();
    const id = context.host(context.view.file, 'titles');
    context.transcript('n-titles', [JSON.stringify({ type: 'ai-title', aiTitle: 'Investigate build failure' })]);
    await context.service.poll();
    expect(context.titles).toEqual([{ workItemId: id, title: 'Investigate build failure', origin: 'provider-auto' }]);
    context.transcript('n-titles', [JSON.stringify({ type: 'ai-title', aiTitle: 'Investigate build failure' }), JSON.stringify({ type: 'custom-title', customTitle: 'Investigate build failure' })]);
    await context.service.poll();
    expect(context.titles.at(-1)).toEqual({ workItemId: id, title: 'Investigate build failure', origin: 'provider-manual' });
    context.transcript('n-titles', [JSON.stringify({ type: 'ai-title', aiTitle: 'Investigate build failure' }), JSON.stringify({ type: 'custom-title', customTitle: 'Build regression' })]);
    await context.service.poll();
    expect(context.titles.at(-1)).toEqual({ workItemId: id, title: 'Build regression', origin: 'provider-manual' });
  });

  it("lists a hosted conversation with its host's work item, and refuses another page's sessions and a stale scope generation", () => {
    const { view, scopes, service, host, open } = setup();
    // Both work items run in D:/w12, as Support work items share one folder; only the host link decides.
    const mineHosted = host(view.file, 'h1');
    const theirsHosted = host(view.otherFile, 'h2');
    const mine = open(2);
    const theirs = open(3);

    expect(mine.frames[0]).toMatchObject({ type: 'hello', scope: { kind: 'page', workItemId: 2, sessionId: 's2', conversations: [{ workItemId: 2, primary: true, title: 'Issue <1>' }, { workItemId: mineHosted, primary: false, title: 'New session', sessionId: 'h1', state: 'idle', conversation: 'full', unread: 0, provider: 'claude' }] } });
    expect((mine.frames[0]!['scope'] as { conversations: unknown[] }).conversations).toHaveLength(2);
    expect(scopes.scope(theirs.key)?.conversations).toEqual([{ workItemId: 3, primary: true }, { workItemId: theirsHosted, primary: false }]);

    // Selecting its hosted conversation raises the scope generation, and the page starts from that conversation's hello.
    expect(service.select({ window: mine.key, scopeGen: 1, opId: 'o1', workItemId: mineHosted })).toEqual({ status: 200, body: { scopeGen: 2 } });
    expect(mine.frames.slice(-2)).toMatchObject([{ type: 'scope', scope: { workItemId: mineHosted, sessionId: 'h1', scopeGen: 2 } }, { type: 'hello', sessions: [{ id: 'h1' }], scope: { workItemId: mineHosted } }]);
    expect(theirs.frames.filter((frame) => frame.type === 'scope')).toEqual([]);

    // Commands name the shown session only; the other page's, the earlier selection's, or one sent at an older generation are refused.
    expect(service.history({ window: mine.key, scopeGen: 2, opId: 'o2', sessionId: 'h2', before: null })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.history({ window: mine.key, scopeGen: 2, opId: 'o3', sessionId: 's2', before: null })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.history({ window: mine.key, scopeGen: 1, opId: 'o4', sessionId: 'h1', before: null })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.seen({ window: theirs.key, scopeGen: 1, opId: 'o5', sessionId: 'h1', ids: [] })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.send({ window: theirs.key, scopeGen: 1, opId: 'o6', sessionId: 'h1', launch: null, text: 'hi' })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.select({ window: 'forged', scopeGen: 1, opId: 'o7', workItemId: 2 })).toEqual({ status: 403, body: { error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." } });
    expect(service.select({ window: mine.key, scopeGen: 2, opId: 'o8', workItemId: 999 })).toEqual({ status: 403, body: { error: 'Switchboard has no such work item, or that session is not one of its sessions.' } });
  });

  it("gives a folder-hosted conversation's page only that folder's conversations, never the item work in the folder, and refuses each the other's sessions", () => {
    const { scopes, service, view, host, open } = setup();
    const inFolder = host('D:/git/support', 'f1');
    const inItem = host(view.file, 'a1');
    const folder = open(inFolder);
    const itemPage = open(2);

    expect(scopes.scope(folder.key)).toMatchObject({ kind: 'page', workItemId: inFolder, sessionId: 'f1', conversations: [{ workItemId: inFolder, primary: false }] });
    expect(scopes.scope(itemPage.key)?.conversations).toEqual([{ workItemId: 2, primary: true }, { workItemId: inItem, primary: false }]);
    expect(service.history({ window: folder.key, scopeGen: 1, opId: 'h1', sessionId: 's2', before: null })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.history({ window: itemPage.key, scopeGen: 1, opId: 'h2', sessionId: 'f1', before: null })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.send({ window: itemPage.key, scopeGen: 1, opId: 'h3', sessionId: 'f1', launch: null, text: 'hi' })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
  });

  it('counts each conversation unread on its own and sends the dropdown when it changes, without moving the selection', async () => {
    const { view, service, host, open, transcript } = setup();
    const hosted = host(view.file, 'h1');
    const mine = open(2);
    const theirs = open(3);

    transcript('n-h1', [JSON.stringify({ type: 'assistant', uuid: 'x1', timestamp: new Date(NOW).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Hosted reply.' }] } })]);
    await service.poll();

    expect(mine.frames.filter((frame) => frame.type === 'reply')).toEqual([]);
    expect(mine.frames.filter((frame) => frame.type === 'unread')).toEqual([expect.objectContaining({ workItemId: hosted, count: 1 })]);
    service.conversationsChanged();
    expect(mine.frames.filter((frame) => frame.type === 'conversations').at(-1)).toMatchObject({ conversations: [{ workItemId: 2, unread: 0 }, { workItemId: hosted, unread: 1 }] });
    expect(mine.frames.filter((frame) => frame.type === 'scope')).toEqual([]);
    expect(theirs.frames.filter((frame) => frame.type === 'unread' || frame.type === 'conversations')).toEqual([]);
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
  /** A whole screen to show instead of the input box, and when a terminal last typed. */
  shown: string[] | null = null;
  keyAt: number | null = null;

  async screen(_session: string): Promise<{ data: string; cols: number; rows: number; rev: number; keyAt: number | null }> {
    if (this.shown !== null) {
      return { data: this.shown.join('\r\n'), cols: 110, rows: this.shown.length, rev: this.rev, keyAt: this.keyAt };
    }

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

describe('refusal', () => {
  const shown: WindowScope = { kind: 'page', key: 'p', folder: null, title: 'T', scopeGen: 2, conversations: [], workItemId: 1, cwd: null, sessionId: 's1' };

  it('says which scope fact failed: a key no page holds, a page with nothing open, another session, or a stale generation', () => {
    expect(refusal({ known: false, scope: null }, 2, 's1')).toEqual({ status: 403, body: { error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." } });
    expect(refusal({ known: true, scope: null }, 2, 's1')).toEqual({ status: 403, body: { error: 'This page has no work item open, so that was not done. Open one and try again.' } });
    expect(refusal({ known: true, scope: shown }, 2, 's2')).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(refusal({ known: true, scope: shown }, 1, 's1')).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(refusal({ known: true, scope: shown }, 2, 's1')).toBeNull();
  });
});

describe('canonicalFolder', () => {
  it('gives every spelling of a folder, by a link or in another case, its one real path, and none to a path that is no folder or is named like a workspace file', () => {
    const support = join(dir, 'Support');
    const link = join(dir, 'support-link');

    mkdirSync(support);
    symlinkSync(support, link, 'junction');

    const real = canonicalFolder(support)!;

    for (const spelling of [link, `${support}${sep}`, ...(process.platform === 'win32' ? [support.toUpperCase(), support.toLowerCase()] : [])]) {
      expect(canonicalFolder(spelling)).toBe(real);
    }

    writeFileSync(join(dir, 'a.txt'), '');
    mkdirSync(join(dir, 'odd.code-workspace'));
    expect(canonicalFolder(join(dir, 'missing'))).toBeNull();
    expect(canonicalFolder(join(dir, 'a.txt'))).toBeNull();
    expect(canonicalFolder(join(dir, 'odd.code-workspace'))).toBeNull();
  });
});

describe('ConversationService', () => {
  function setup(held = new FakeHeld()) {
    const store = Store.open(':memory:');
    const view = world();
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, newKey: () => `k${++keys}` });
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
    const open = (workItemId: number) => {
      const key = pageOn(scopes, view.view, workItemId);
      const frames: Array<{ type: string; [field: string]: unknown }> = [];
      const stream = service.open(key, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }))!;

      return { key, frames, stream };
    };

    return { store, view, scopes, service, transcript, reply, open, logs, held };
  }

  it("counts its session's unread replies and status, marks each seen on its own, and tells its own windows", async () => {
    const { view, service, transcript, reply, open, store } = setup();

    const mine = open(2);
    const theirs = open(3);

    expect(mine.frames[0]).toMatchObject({ type: 'hello', unread: 0 });
    transcript('D:/w12', 'n2', [reply('a1', 'One.'), reply('a2', 'Two.\n[state]\nDone\nAll green.')]);
    transcript('D:/w3', 'n3', [reply('b1', 'Theirs.')]);
    await service.poll();

    expect(mine.frames.filter((frame) => frame.type === 'reply')).toMatchObject([{ reply: { opening: 'One.', unread: true } }, { reply: { opening: 'Two.', unread: true } }]);
    expect(mine.frames.filter((frame) => frame.type === 'reply')[0]!['reply']).not.toHaveProperty('seenAt');
    expect(mine.frames.filter((frame) => frame.type === 'state')).toMatchObject([{ state: { headline: 'Done', body: 'All green.', unread: true } }]);
    expect(mine.frames.filter((frame) => frame.type === 'unread').at(-1)).toMatchObject({ count: 3 });
    expect(theirs.frames.filter((frame) => frame.type === 'unread').at(-1)).toMatchObject({ count: 1 });

    const [one, two] = store.conversation('s2', null, 10).items.map((item) => item.id);
    const statusId = store.latestState('s2')!.id;
    const before = { mine: mine.frames.length, theirs: theirs.frames.length };

    // Another window's item, an unknown ID, another session, a stale scope and a malformed body mark nothing.
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o1', sessionId: 's2', ids: [two, store.conversation('s3', null, 10).items[0]!.id] })).toEqual({ status: 403, body: { error: 'That reply or status is not in the session this page shows.' } });
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o2', sessionId: 's2', ids: ['forged'] })).toEqual({ status: 403, body: { error: 'That reply or status is not in the session this page shows.' } });
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o3', sessionId: 's3', ids: [] })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.seen({ window: theirs.key, scopeGen: 1, opId: 'o4', sessionId: 's2', ids: [two] })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.seen({ window: mine.key, scopeGen: 0, opId: 'o5', sessionId: 's2', ids: [two] })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o6', sessionId: 's2', ids: 'x' }).status).toBe(400);
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o7', sessionId: 's2', ids: Array.from({ length: 201 }, () => two) }).status).toBe(400);
    expect(store.unreadCount('s2')).toBe(3);
    expect(mine.frames.length).toBe(before.mine);

    // The second reply and the state are seen; the first stays unread.
    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o8', sessionId: 's2', ids: [two, statusId] })).toEqual({ status: 200, body: { unread: 1 } });
    const after = mine.frames.slice(before.mine);

    expect(after.filter((frame) => frame.type === 'reply')).toMatchObject([{ reply: { id: two, unread: false } }]);
    expect(after.filter((frame) => frame.type === 'state')).toMatchObject([{ state: { id: statusId, unread: false } }]);
    expect(after.filter((frame) => frame.type === 'unread')).toMatchObject([{ count: 1 }]);
    expect(theirs.frames.length).toBe(before.theirs);
    expect(store.reply(one!)?.seenAt).toBeNull();

    // Marking again sends nothing new.
    const again = mine.frames.length;

    expect(service.seen({ window: mine.key, scopeGen: 1, opId: 'o8', sessionId: 's2', ids: [two] })).toEqual({ status: 200, body: { unread: 1 } });
    expect(mine.frames.length).toBe(again);

    // Any change counts again, as a message that pushes an unread reply past the retention limit.
    store.markSeen('s2', [one!], NOW);
    transcript('D:/w12', 'n2', [reply('a1', 'One.'), reply('a2', 'Two.\n[state]\nDone\nAll green.'), JSON.stringify({ type: 'user', uuid: 'u3', timestamp: new Date(NOW).toISOString(), message: { role: 'user', content: 'Next?' } })]);
    await service.poll();
    expect(mine.frames.filter((frame) => frame.type === 'unread').at(-1)).toMatchObject({ count: 0 });
    store.updateReply(one!, { seenAt: null });

    // A reconnect's hello carries the count and each item's state.
    mine.stream.close();
    expect(open(2).frames[0]).toMatchObject({ type: 'hello', unread: 1, items: [{ id: one, unread: true }, { id: two, unread: false }, { type: 'message', text: 'Next?' }], state: { unread: false } });
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

    const mine = open(2);
    const theirs = open(3);

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
    expect(open(2).frames).toMatchObject([{ type: 'hello', items: [{ type: 'reply', opening: 'Mine.' }] }]);
  });

  it('refuses a stream for a key no window holds, and history for a forged session, another window or a stale scope generation', async () => {
    const { view, service, transcript, reply, open, store } = setup();

    transcript('D:/w12', 'n2', [reply('a1', 'One.'), reply('a2', 'Two.')]);
    await service.poll();

    const { key } = open(2);
    const other = open(3).key;

    expect(service.open('forged', () => undefined)).toBeNull();
    expect(service.history({ window: key, scopeGen: 1, opId: 'o1', sessionId: 's3', before: null })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.history({ window: other, scopeGen: 1, opId: 'o2', sessionId: 's2', before: null })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.history({ window: 'forged', scopeGen: 1, opId: 'o3', sessionId: 's2', before: null })).toEqual({ status: 403, body: { error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." } });
    expect(service.history({ window: key, scopeGen: 0, opId: 'o4', sessionId: 's2', before: null })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.history({ window: key, scopeGen: 1, sessionId: 's2' })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, before, limit?}.' } });

    const page = service.history({ window: key, scopeGen: 1, opId: 'o5', sessionId: 's2', before: null, limit: 1 });

    expect(page).toMatchObject({ status: 200, body: { items: [{ opening: 'Two.' }], more: true } });
    expect(store.conversation('s2', null, 10).items).toHaveLength(2);
  });

  it("says hello with the stage before the session's first status, then each window its own session's latest status, once", async () => {
    const { view, service, transcript, reply, open, store } = setup();

    store.setState({ id: 'stage-s2-1', sessionId: 's2', workItemId: 2, replyId: null, at: NOW - 60_000, headline: 'Reading the inbox code', body: null });

    const mine = open(2);
    const theirs = open(3);

    expect(mine.frames[0]).toMatchObject({ type: 'hello', state: { id: 'stage-s2-1', sessionId: 's2', at: NOW - 60_000, headline: 'Reading the inbox code', body: null, unread: false } });
    // Item 3 has no state.
    expect(theirs.frames[0]).toMatchObject({ type: 'hello', state: null });

    // A new stage reaches the window with the next snapshot, once.
    store.setState({ id: 'stage-s2-2', sessionId: 's2', workItemId: 2, replyId: null, at: NOW, headline: 'Writing the fix', body: null });
    service.sessionsChanged();
    service.sessionsChanged();
    expect(mine.frames.filter((frame) => frame.type === 'state')).toMatchObject([{ state: { headline: 'Writing the fix' } }]);

    transcript('D:/w12', 'n2', [reply('a1', 'Fixed.\n[state]\n## Done\n- the badge')]);
    transcript('D:/w3', 'n3', [reply('b1', 'Theirs.\n[state]\nNot yours.')]);
    await service.poll();
    service.sessionsChanged();

    expect(mine.frames.filter((frame) => frame.type === 'state').at(-1)).toMatchObject({ state: { sessionId: 's2', headline: 'Done', body: '- the badge', unread: true } });
    expect(mine.frames.filter((frame) => frame.type === 'state')).toHaveLength(2);
    expect(mine.frames.find((frame) => frame.type === 'reply')).toMatchObject({ reply: { opening: 'Fixed.' } });
    expect(JSON.stringify(mine.frames)).not.toContain('Not yours.');
    expect(theirs.frames.filter((frame) => frame.type === 'state')).toMatchObject([{ state: { sessionId: 's3', headline: 'Not yours.' } }]);
    // The store's work item, reply and turn fields stay in the hub.
    const shown = mine.frames.filter((frame) => frame.type === 'state').at(-1)!['state'];

    expect(shown).not.toHaveProperty('workItemId');
    expect(shown).not.toHaveProperty('replyId');
    expect(shown).not.toHaveProperty('turnEnded');

    // A reconnect gets the latest state in its hello.
    mine.stream.close();
    expect(open(2).frames[0]).toMatchObject({ state: { headline: 'Done', body: '- the badge' } });

    // A state of another session of the work item, or one the migration carried over, stands in for a session with none, never unread.
    store.setState({ id: 'other', sessionId: 's9', workItemId: 3, replyId: 'r9', at: NOW, headline: 'Earlier session', body: 'Unread there.' });
    expect(store.state('other')?.seenAt).toBeNull();
    expect(service.state({ workItemId: 3, sessionId: 's-new' } as never)).toMatchObject({ id: 'other', headline: 'Earlier session', stale: 'session', unread: false });
  });

  it("sends a window its state again when its session's turn ends, dimmed", async () => {
    const { service, transcript, reply, open, store } = setup();

    store.updateSession('s2', { state: 'running' });
    transcript('D:/w12', 'n2', [reply('a1', 'Working.\n[state]\nfixing tests')]);
    await service.poll();

    const mine = open(2);

    expect(mine.frames[0]).toMatchObject({ state: { headline: 'fixing tests', stale: null } });
    store.updateSession('s2', { state: 'idle' });
    service.sessionsChanged();
    expect(mine.frames.filter((frame) => frame.type === 'state').at(-1)).toMatchObject({ state: { headline: 'fixing tests', stale: 'turn' } });
    store.updateSession('s2', { state: 'ended' });
    service.sessionsChanged();
    expect(mine.frames.filter((frame) => frame.type === 'state').at(-1)).toMatchObject({ state: { headline: 'fixing tests', stale: 'session' } });
  });

  it("serves a window's earlier statuses newest first, and refuses another window's session, a forged key or a stale scope generation", async () => {
    const { view, service, transcript, reply, open } = setup();

    transcript('D:/w12', 'n2', [reply('a1', '[state]\nOne.'), reply('a2', '[state]\nTwo.'), reply('a3', '[state]\nThree.')]);
    transcript('D:/w3', 'n3', [reply('b1', '[state]\nTheirs.')]);
    await service.poll();

    const { key, frames } = open(2);
    const other = open(3).key;
    const latest = (frames[0]!['state'] as { id: string; headline: string });

    expect(latest.headline).toBe('Three.');
    expect(service.states({ window: key, scopeGen: 1, opId: 'o1', sessionId: 's2', before: latest.id, limit: 1 })).toMatchObject({ status: 200, body: { states: [{ headline: 'Two.' }], more: true } });
    expect(service.states({ window: key, scopeGen: 1, opId: 'o2', sessionId: 's2', before: null })).toMatchObject({ status: 200, body: { states: [{ headline: 'Three.' }, { headline: 'Two.' }, { headline: 'One.' }], more: false } });
    expect(service.states({ window: key, scopeGen: 1, opId: 'o3', sessionId: 's3', before: null })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.states({ window: other, scopeGen: 1, opId: 'o4', sessionId: 's2', before: null })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.states({ window: 'forged', scopeGen: 1, opId: 'o5', sessionId: 's2', before: null })).toEqual({ status: 403, body: { error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." } });
    expect(service.states({ window: key, scopeGen: 0, opId: 'o6', sessionId: 's2', before: null })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.states({ window: key, scopeGen: 1, sessionId: 's2', before: 3 })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, before, limit?}.' } });
    // Another session's state as the cursor has nothing before it.
    const theirs = service.states({ window: other, scopeGen: 1, opId: 'o7', sessionId: 's3', before: null }) as { body: { states: Array<{ id: string }> } };

    expect(service.states({ window: key, scopeGen: 1, opId: 'o8', sessionId: 's2', before: theirs.body.states[0]!.id })).toEqual({ status: 200, body: { states: [], more: false } });
  });

  it("lists its session's slash commands from the transcript for the window's composer, and refuses another window's session, a forged key or a stale scope generation", async () => {
    const { view, service, transcript, reply, open } = setup();
    const listing = (initial: boolean, skills: Array<[string, string]>) =>
      JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content: skills.map(([name, description]) => `- ${name}: ${description}`).join('\n'), isInitial: initial, names: skills.map(([name]) => name) } });

    transcript('D:/w12', 'n2', [listing(true, [['hello7', 'Say hello seven'], ['init', 'Initialize a new CLAUDE.md file']]), reply('a1', 'Hi.'), listing(false, [['demo-video', 'Record a video']])]);
    transcript('D:/w3', 'n3', [listing(true, [['theirs', 'Not yours']])]);
    await service.poll();

    const { key } = open(2);
    const other = open(3).key;

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
    expect(service.commands({ window: key, scopeGen: 1, opId: 'o2', sessionId: 's3' })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.commands({ window: other, scopeGen: 1, opId: 'o3', sessionId: 's2' })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(service.commands({ window: 'forged', scopeGen: 1, opId: 'o4', sessionId: 's2' })).toEqual({ status: 403, body: { error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." } });
    expect(service.commands({ window: key, scopeGen: 0, opId: 'o5', sessionId: 's2' })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(service.commands({ window: key, scopeGen: 1, sessionId: 7 })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId}.' } });
  });

it("sends a window its session's context size from the transcript, again only when a main-chain request changes it (architecture.md § Context meter)", async () => {
    const { view, service, transcript, open } = setup();
    const usage = (uuid: string, tokens: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: 'assistant', uuid, timestamp: new Date(NOW).toISOString(), ...extra, message: { model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2, cache_creation_input_tokens: 1_000, cache_read_input_tokens: tokens, output_tokens: 98 } } });
    const lines = [usage('a1', 100_000)];

    transcript('D:/w12', 'n2', lines);
    const { frames, key } = open(2);

    expect(frames[0]).toMatchObject({ type: 'hello', sessions: [{ id: 's2', context: { used: 101_100, window: 200_000, compactAt: 167_000, model: 'claude-sonnet-4-6' } }] });
    // The first poll may send the session the hello already carried; a poll that reads nothing new sends nothing.
    await service.poll();
    const sent = frames.filter((frame) => frame.type === 'session').length;

    await service.poll();
    // A subagent's request is not the session's context.
    lines.push(usage('a2', 150_000, { isSidechain: true }));
    transcript('D:/w12', 'n2', lines);
    await service.poll();
    expect(frames.filter((frame) => frame.type === 'session')).toHaveLength(sent);

    lines.push(usage('a3', 150_000));
    transcript('D:/w12', 'n2', lines);
    await service.poll();
    await service.poll();
    expect(frames.filter((frame) => frame.type === 'session').slice(sent)).toMatchObject([{ session: { id: 's2', context: { used: 151_100, window: 200_000, compactAt: 167_000 } } }]);

    // A request that builds the session's view without sending it does not count as the window having the new size.
    lines.push(usage('a4', 160_000));
    transcript('D:/w12', 'n2', lines);
    expect(service.send({ window: key, scopeGen: 1, opId: 'op-x', sessionId: 's2', launch: 'other', text: 'x' }).status).toBe(409);
    await service.poll();
    expect(frames.filter((frame) => frame.type === 'session').at(-1)).toMatchObject({ session: { context: { used: 161_100 } } });

    // A compaction leaves the size its boundary gives.
    lines.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 151_100, postTokens: 20_000 } }));
    transcript('D:/w12', 'n2', lines);
    await service.poll();
    expect(frames.filter((frame) => frame.type === 'session').at(-1)).toMatchObject({ session: { context: { used: 20_000 } } });
  });

  it('marks the context unknown for a session with no transcript yet', () => {
    const { view, open } = setup();
    const { frames } = open(2);

    expect(frames[0]).toMatchObject({ type: 'hello', sessions: [{ id: 's2', context: null }] });
  });

  it("tells a page its session's new state once", () => {
    const { service, open, store } = setup();
    const { frames } = open(2);

    service.sessionsChanged();
    service.sessionsChanged();
    store.updateSession('s2', { state: 'waiting', stateDetail: PERMISSION_PROMPT });
    service.sessionsChanged();
    expect(frames.filter((frame) => frame.type === 'session')).toMatchObject([{ session: { state: 'running' } }, { session: { state: 'waiting', waitingFor: 'permission' } }]);
  });
});

describe('ConversationService send', { timeout: 20_000 }, () => {
  /** Waits for typing to settle: each screen read replays it in xterm, which waits on a real timer, so the wait has no budget of its own below the test's. */
  const settled = (check: () => void) => vi.waitFor(check, { timeout: 15_000 });

  function setupSend(held = new FakeHeld(), holderAnswerMs?: number, voice?: ConversationVoice, extra: Partial<ConversationServiceDeps> = {}) {
    const store = Store.open(':memory:');
    const view = world();
    let keys = 0;
    const scopes = new WindowScopes({ store, windows: WINDOWS, newKey: () => `k${++keys}` });
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

    const open = (workItemId: number) => {
      const key = pageOn(scopes, view.view, workItemId);
      const frames: Array<{ type: string; [field: string]: unknown }> = [];

      service.open(key, (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

      return { key, frames };
    };
    const body = (key: string, patch: Record<string, unknown> = {}) => ({ window: key, scopeGen: 1, opId: 'op-1', sessionId: 's2', launch: 'launch-1', text: 'Fix the build', ...patch });

    return { store, view, service, held, logs, open, body, make, scopes, setHooks: (on: boolean) => (hooks = on) };
  }

  it("types a message into the window's session, answers at once with it open, and shows it sent once the transcript has it, in its own window only", async () => {
    const { service, held, open, body, view, store } = setupSend();
    const mine = open(2);
    const theirs = open(3);
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

  it("types the hub's continue text after a usage limit through the same guarded input, with no window, and refuses a session it cannot type into (architecture.md § Rate limits)", async () => {
    const { service, held, store } = setupSend();

    expect(service.continueAfterLimit('s2', 'Continue.')).toBeNull();
    await settled(() => expect(store.conversation('s2', null, 10).items.at(-1)).toMatchObject({ origin: 'typed', text: 'Continue.', delivery: 'sent' }));
    expect(held.writes).toEqual(['\u001b[200~Continue.\u001b[201~', '\r']);
    expect(held.reservations).toEqual([{ sessionId: 's2', launch: 'launch-1' }]);

    store.updateSession('s2', { state: 'ended' });
    expect(service.continueAfterLimit('s2', 'Continue.')).toBe('The session has ended. Resume continues it.');
    expect(service.continueAfterLimit('nope', 'Continue.')).toBe('The session has ended.');
    expect(held.writes).toHaveLength(2);
  });

  /** A voice that records what the conversation layer asks of it. */
  function fakeVoice(spoken = { spoken: true, expressive: false }) {
    const calls: string[] = [];
    const voice: ConversationVoice = {
      shown: (key) => ({ enabled: true, here: key === 'k1', mic: 'off', speaking: null, speakReplies: true, error: null, recognizer: null }),
      settings: () => ({ briefReplies: true, expandReplies: false, diffLayout: 'auto', diffWrap: 'auto' }),
      spokenFor: (sessionId, command, key) => {
        calls.push(`spokenFor ${sessionId} ${command} ${key ?? 'none'}`);
        return command ? { spoken: false, expressive: false } : spoken;
      },
      replyChanged: (reply) => void calls.push(`reply ${reply.opening}`),
      talkHere: (key) => (key === 'k1' ? null : 'Voice is off (voice.enabled).'),
      stopSpeaking: () => "Voice is not on this page's session. Select Talk here to use it.",
      setSpeakReplies: (on) => void calls.push(`speak-replies ${on}`),
      replay: (_key, replyId) => (replyId === 'r-x' ? 'That reply is not in the session this page shows, so it was not read again.' : null),
      update: () => void calls.push('update'),
      selected: (key) => void calls.push(`selected ${key}`),
      expressive: () => true,
    };

    return { voice, calls };
  }

  it('types [spoken] before a message whose reply will be heard, keeps the text without it, and confirms it by its tagged line (architecture.md § Voice)', async () => {
    const { voice, calls } = fakeVoice({ spoken: true, expressive: true });
    const { service, held, open, body, view, store } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(2);

    expect(mine.frames[0]).toMatchObject({ type: 'hello', voice: { enabled: true, here: true, mic: 'off' }, settings: { briefReplies: true } });
    expect(service.send(body(mine.key, { text: '/x why' }))).toMatchObject({ status: 200, body: { message: { id: 'm-1', text: '/x why', spokenRequested: true } } });
    await settled(() => expect(store.message('m-1')?.delivery).toBe('sent'));
    expect(held.writes[0]).toBe('\u001b[200~[spoken] [expressive] \\/x why\u001b[201~');
    await service.poll();
    expect(store.conversation('s2', null, 10).items).toMatchObject([{ id: 'm-1', text: '/x why', transcriptUuid: 'typed-2', spokenRequested: true }]);

    // A slash command chosen from the list goes untagged.
    expect(service.send(body(mine.key, { opId: 'op-2', text: '/compact', command: true }))).toMatchObject({ status: 200, body: { message: { spokenRequested: false } } });
    await settled(() => expect(store.message('m-2')?.delivery).toBe('sent'));
    expect(held.writes[2]).toBe('\u001b[200~/compact\u001b[201~');
    // A typed message names the window it came from, which can take the voice back to this computer.
    expect(calls.filter((call) => call.startsWith('spokenFor'))).toEqual([`spokenFor s2 false ${mine.key}`, `spokenFor s2 true ${mine.key}`]);
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

    const mine = open(2);
    const theirs = open(3);
    let op = 0;
    const command = (name: 'persona' | 'personas', patch: Record<string, unknown> = {}, window = mine.key) => service.personaCommand(name, { window, scopeGen: 1, opId: `o${++op}`, ...patch });

    expect(mine.frames[0]).toMatchObject({ type: 'hello', sessions: [{ id: 's2', persona: null }] });
    expect(command('personas')).toEqual({ status: 200, body: { personas: [{ id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm.' }] } });
    expect(command('persona', { sessionId: 's2', personaId: 'nova' })).toEqual({ status: 200, body: { persona: { id: 'nova', name: 'Nova', pinned: true, tonePending: true } } });
    expect(mine.frames.at(-1)).toMatchObject({ type: 'session', session: { id: 's2', persona: { name: 'Nova', pinned: true } } });
    expect(theirs.frames.filter((frame) => frame.type === 'session')).toMatchObject([{ session: { id: 's3', persona: null } }]);
    expect(command('persona', { sessionId: 's2', personaId: null })).toMatchObject({ status: 200, body: { persona: null } });
    // A repeated opId answers the first result and pins nothing again.
    expect(command('persona', { sessionId: 's2', personaId: 'nova', opId: 'o2' })).toEqual({ status: 200, body: { persona: { id: 'nova', name: 'Nova', pinned: true, tonePending: true } } });
    expect(store.session('s2')).toMatchObject({ personaId: null, personaPinned: false });

    // Another window's session, a stale generation, an unknown persona, a malformed body and voice off are refused.
    expect(command('persona', { sessionId: 's3', personaId: 'nova' })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
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
    const mine = open(2);
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
    const mine = open(2);
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

    voice.take = (key, _sessionId, heard, seq) => {
      calls.push(`take ${key} ${heard} ${seq}`);
      const taken = held;

      held = null;
      return taken === null ? null : { pieces: taken, interrupted: null };
    };
    voice.delivered = (message) => void calls.push(`delivered ${message.id} ${message.delivery}`);

    const { service, held: holder, open, body, view, store } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(2);

    // The send says which pieces its text holds (`heard`) and orders itself after the composer's updates (`composerSeq`).
    expect(service.send(body(mine.key, { text: 'Fix the build, please', heard: 7, composerSeq: 3 }))).toMatchObject({ status: 200, body: { message: { id: 'm-1', origin: 'voice', pieces, spokenRequested: true } } });
    expect(calls).toContain(`take ${mine.key} 7 3`);
    await settled(() => expect(store.message('m-1')?.delivery).toBe('sent'));
    expect(holder.writes[0]).toBe('\u001b[200~[spoken] [voice] Fix the build, please\u001b[201~');
    expect(calls).toContain('delivered m-1 sent');

    // The voice's own turn, and a [partial] part, which never asks for a spoken reply.
    expect(service.dictate(mine.key, 's2', 'and the tests', pieces, true)).toMatchObject({ message: { id: 'm-3', origin: 'voice', partial: true, spokenRequested: false } });
    await settled(() => expect(store.message('m-3')?.delivery).toBe('sent'));
    expect(holder.writes.at(-2)).toBe('\u001b[200~[voice] [partial] and the tests\u001b[201~');
    const sent = service.dictate(mine.key, 's2', 'too', pieces, false);

    expect(sent).toMatchObject({ message: { origin: 'voice', spokenRequested: true } });
    // The queue types in order, so this, the last message, settling means none is still typing when the test's folder is removed.
    await settled(() => expect(store.message((sent as { message: { id: string } }).message.id)?.delivery).toBe('sent'));
    expect(holder.writes).toContain('\u001b[200~[spoken] [voice] too\u001b[201~');

    // Refused for another session than the window's, before anything is stored, with a refused message to the window only.
    expect(service.dictate(mine.key, 's3', 'hello', pieces, false)).toEqual({ refused: "The voice's session is no longer this window's." });
    expect(mine.frames.filter((frame) => frame.type === 'message' && (frame.message as { delivery: string }).delivery === 'refused')).toMatchObject([
      { message: { origin: 'voice', text: 'hello', delivery: 'refused', error: "The voice's session is no longer this window's." } },
    ]);
    expect(store.conversation('s3', null, 10).items).toEqual([]);
    expect(service.voiceCommand('composer', { window: mine.key, scopeGen: 1, opId: 'o', focused: 'yes', draft: '' })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, focused, draft?, listen?, seq?, heard?}.' } });
  });

  it("takes the window's draft only with a message it accepts: never for a refusal, a repeat, a card's answers or a bad number, and a slash command goes untagged (architecture.md § Dictation)", async () => {
    const { voice, calls } = fakeVoice({ spoken: false, expressive: false });
    const pieces = [{ text: 'compact it', score: null, f0: null, dropped: false }];

    voice.take = (key, sessionId, heard, seq) => (calls.push(`take ${key} ${sessionId} ${heard} ${seq}`), { pieces, interrupted: null });

    const { service, held: holder, open, body, store } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(2);
    const takes = () => calls.filter((call) => call.startsWith('take'));

    expect(service.send(body(mine.key, { text: 'x', scopeGen: 0, heard: 1, composerSeq: 1 })).status).toBe(409);
    expect(service.send(body(mine.key, { text: 'x', heard: -1 })).status).toBe(400);
    expect(service.send(body(mine.key, { text: 'x', composerSeq: 'two' })).status).toBe(400);
    expect(service.send(body(mine.key, { text: ' ', heard: 1 })).status).toBe(400);
    expect(takes()).toEqual([]);

    // A slash command takes the draft, as the box empties, but its pieces do not tag it.
    expect(service.send(body(mine.key, { text: '/compact', command: true, heard: 2, composerSeq: 2 }))).toMatchObject({ status: 200, body: { message: { origin: 'typed' } } });
    expect(takes()).toEqual([`take ${mine.key} s2 2 2`]);
    await settled(() => expect(store.message('m-1')?.delivery).toBe('sent'));
    expect(holder.writes[0]).toBe('\u001b[200~/compact\u001b[201~');
    // Sent again with the same opId, as after a lost answer: the first message, and nothing taken again.
    expect(service.send(body(mine.key, { text: '/compact', command: true, heard: 3, composerSeq: 3 }))).toMatchObject({ status: 200, body: { message: { id: 'm-1' } } });
    expect(takes()).toHaveLength(1);

    // A card's answers are not the draft, which stays.
    store.setPagePref('questionsLedgerSince', '1');
    store.addReply({ id: 'q1', sessionId: 's2', workItemId: store.session('s2')!.workItemId, at: NOW, kind: 'reply', answers: null, opening: '1. Which port? {#port-choice}\n   - A) 8765\n   - B) 8799', source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: 'q1' });
    const answered = service.send(body(mine.key, { opId: 'op-card', text: undefined, answers: [{ card: 'reply:q1', slug: 'port-choice', letters: ['B'], other: '' }], heard: 4, composerSeq: 4 }));

    expect(answered.status).toBe(200);
    expect(takes()).toHaveLength(1);
    await settled(() => expect(store.message((answered.body as { message: { id: string } }).message.id)?.delivery).toBe('sent'));
  });

  it("passes a page's Mic on timing to the voice for the hub log, and refuses a malformed or unknown one (architecture.md § Dictation)", () => {
    const { voice } = fakeVoice();
    const timed: unknown[] = [];

    voice.micTiming = (key, steps, outcome) => void timed.push({ key, steps, outcome });

    const { service, open, view } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(2);
    const steps = [{ step: 'microphone allowed', ms: 2_400 }, { step: 'hub answered', ms: 2_600 }];

    expect(service.voiceCommand('mic-timing', { window: mine.key, steps, outcome: 'listening\nnext\u001b[31m line' })).toEqual({ status: 200, body: { done: true } });
    // No control character reaches the log.
    expect(timed).toEqual([{ key: mine.key, steps, outcome: 'listening next [31m line' }]);

    for (const bad of [
      { window: 'nobody', steps, outcome: 'listening' },
      { window: mine.key, steps: [{ step: 'Bad<b>', ms: 1 }], outcome: 'listening' },
      { window: mine.key, steps: [{ step: 'late', ms: MIC_TIMING_MAX_MS + 1 }], outcome: 'listening' },
      { window: mine.key, steps: Array.from({ length: MIC_TIMING_STEPS + 1 }, () => ({ step: 'step', ms: 1 })), outcome: 'listening' },
      { window: mine.key, steps, outcome: 'x'.repeat(201) },
    ]) {
      expect(service.voiceCommand('mic-timing', bad).status).toBe(400);
    }

    expect(timed).toHaveLength(1);
  });

  it('types a dictated message that spoke over a reply with its interruption note after the tags, stores the reply, and retypes it the same (architecture.md § Voice check and barge-in)', async () => {
    const { voice } = fakeVoice({ spoken: true, expressive: false });
    const pieces = [{ text: 'hold on', score: 0.9, f0: 110, dropped: false }];
    const interrupted = { replyId: 'r1', said: 'The session token', rest: 'is refreshed in two places.' };
    let held: Interruption | null = interrupted;

    voice.take = () => {
      const taken = held;

      held = null;
      return { pieces, interrupted: taken };
    };

    const { service, held: holder, open, body, view, store } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(2);

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
    voice.take = () => null;
    held = interrupted;
    const typed = service.send(body(mine.key, { text: 'typed', opId: 'o-typed' }));

    expect(typed).toMatchObject({ status: 200, body: { message: { origin: 'typed', text: 'typed' } } });
    expect(typed).not.toHaveProperty('body.message.interrupted');
    expect(held).toEqual(interrupted);
    // The last message settling means none is still typing when the test's folder is removed.
    await settled(() => expect(store.message((typed.body as { message: { id: string } }).message.id)?.delivery).toBe('sent'));
  });

  it('runs the voice commands for the window only: Talk here, Stop speaking, Spoken replies and Replay, with their refusals', () => {
    const { voice, calls } = fakeVoice();
    const { service, open, view } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(2);
    const theirs = open(3);
    const command = (name: Parameters<typeof service.voiceCommand>[0], patch: Record<string, unknown> = {}, window = mine.key) => service.voiceCommand(name, { window, scopeGen: 1, opId: 'o', ...patch });

    expect(command('talk-here')).toEqual({ status: 200, body: { done: true } });
    expect(command('talk-here', {}, theirs.key)).toEqual({ status: 409, body: { error: 'Voice is off (voice.enabled).' } });
    expect(command('talk-here', {}, 'forged')).toEqual({ status: 403, body: { error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." } });
    expect(command('talk-here', { scopeGen: 0 })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(command('stop-speaking')).toEqual({ status: 409, body: { error: "Voice is not on this page's session. Select Talk here to use it." } });
    expect(command('speak-replies', { on: false })).toEqual({ status: 200, body: { on: false } });
    expect(command('speak-replies')).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, on}.' } });
    expect(command('replay', { replyId: 'r-1' })).toEqual({ status: 200, body: { done: true } });
    // The mic and the composer reach the voice; a hub with no mic says so.
    expect(command('mic', { on: true })).toEqual({ status: 409, body: { error: 'This hub has no voice.' } });
    voice.mic = (key, on) => (key === mine.key ? (calls.push(`mic ${on}`), null) : 'Voice is off (voice.enabled).');
    voice.composer = (key, focused, draft, listen, seq) => void calls.push(`composer ${focused} ${draft}${listen === true ? ' listen' : ''}${seq === undefined ? '' : ` seq ${seq}`}`);
    expect(command('mic', { on: true })).toEqual({ status: 200, body: { on: true } });
    expect(command('mic', { on: true }, theirs.key)).toEqual({ status: 409, body: { error: 'Voice is off (voice.enabled).' } });
    expect(command('mic')).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, on}.' } });
    expect(command('composer', { focused: true, draft: 'fix' })).toEqual({ status: 200, body: { done: true } });
    expect(calls.slice(-2)).toEqual(['mic true', 'composer true fix']);
    // The web page's composer keeps dictation listening while it has the focus; anything but a boolean is refused.
    expect(command('composer', { focused: true, draft: 'fix', listen: true })).toEqual({ status: 200, body: { done: true } });
    expect(calls.at(-1)).toBe('composer true fix listen');
    // A page's update while its message is on its way carries no draft, and each is numbered; a bad draft or number is refused.
    expect(command('composer', { focused: false, listen: true, seq: 4 })).toEqual({ status: 200, body: { done: true } });
    expect(calls.at(-1)).toBe('composer false null listen seq 4');
    for (const bad of [{ listen: 'yes' }, { draft: 3 }, { draft: 'x'.repeat(10_001) }, { seq: -1 }, { seq: 1.5 }, { seq: '2' }]) {
      expect(command('composer', { focused: true, draft: 'fix', ...bad })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, focused, draft?, listen?, seq?, heard?}.' } });
    }
    expect(command('replay', { replyId: 'r-x' })).toEqual({ status: 403, body: { error: 'That reply is not in the session this page shows, so it was not read again.' } });
    expect(command('replay')).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, replyId}.' } });
    expect(service.voiceCommand('talk-here', { window: mine.key, scopeGen: 1 })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId}.' } });
    expect(calls).toContain('speak-replies false');
    // Selecting a conversation tells the voice, which moves at once when the window has the focus.
    expect(service.select({ window: mine.key, scopeGen: 1, opId: 'sel', workItemId: 2 }).status).toBe(200);
    expect(calls).toContain(`selected ${mine.key}`);

    // Without voice, the commands are not part of the hub.
    const plain = setupSend();
    const key = plain.open(2).key;

    expect(plain.service.voiceCommand('talk-here', { window: key, scopeGen: plain.scopes.scope(key)!.scopeGen, opId: 'o' })).toEqual({ status: 404, body: { error: 'This hub has no voice.' } });
  });

  it('tells the voice of each reply, sends a reply again when its speech changed, and sends voice events to one window', async () => {
    const { voice, calls } = fakeVoice();
    const { service, open, view, store } = setupSend(new FakeHeld(), undefined, voice);
    const mine = open(2);
    const theirs = open(3);

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
    const { key } = open(2);
    const other = open(3).key;
    const refused = (patch: Record<string, unknown>, window = key) => service.send(body(window, patch));

    expect(service.send({ window: key, scopeGen: 1, sessionId: 's2', text: 'x' })).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, text | answers: [{card, slug, letters, other}], command?, heard?, composerSeq?}.' } });
    expect(refused({}, 'forged')).toEqual({ status: 403, body: { error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." } });
    expect(refused({ sessionId: 's3', launch: 'launch-3' })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(refused({}, other)).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } });
    expect(refused({ scopeGen: 0 })).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
    expect(refused({ text: '  \n ' })).toEqual({ status: 400, body: { error: 'The message is empty.' } });
    expect(refused({ text: 'x'.repeat(10_001) })).toEqual({ status: 400, body: { error: 'The message is longer than 10,000 characters.' } });
    expect(refused({ launch: 'launch-0' })).toEqual({ status: 409, body: { error: 'The session was resumed since the view showed it; send the message again.' } });
    held.cannotType_ = 'The terminal holder is from an older build and cannot type. To switch to this build, run hub.js holder stop --all.';
    expect(refused({})).toEqual({ status: 409, body: { error: held.cannotType_ } });
    held.cannotType_ = null;
    setHooks(false);
    expect(refused({})).toEqual({ status: 409, body: { error: 'Switchboard cannot track this session while Install hooks is off.' } });
    setHooks(true);
    store.updateSession('s2', { state: 'ended' });
    expect(refused({})).toEqual({ status: 409, body: { error: 'The session has ended. Resume continues it.' } });

    expect(store.conversation('s2', null, 10).items).toEqual([]);
    expect(held.writes).toEqual([]);
  });

  it('types a slash command chosen from the list as it is, refuses one that is not a single /name line, and escapes a message that starts with a slash', async () => {
    const { service, held, open, body, view, store } = setupSend();
    const { key } = open(2);

    expect(service.send(body(key, { opId: 'op-c0', text: '/compact\nnow', command: true }))).toEqual({ status: 400, body: { error: 'A slash command is one line that starts with /name.' } });
    expect(service.send(body(key, { opId: 'op-c1', text: 'compact now', command: true }))).toEqual({ status: 400, body: { error: 'A slash command is one line that starts with /name.' } });
    expect(service.send(body(key, { opId: 'op-c2', text: '/compact', command: 'yes' }))).toEqual({ status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, text | answers: [{card, slug, letters, other}], command?, heard?, composerSeq?}.' } });
    expect(held.writes).toEqual([]);

    expect(service.send(body(key, { opId: 'op-c3', text: '/compact keep the plan', command: true }))).toMatchObject({ status: 200, body: { message: { id: 'm-1', text: '/compact keep the plan' } } });
    await settled(() => expect(store.message('m-1')?.delivery).toBe('sent'));
    expect(service.send(body(key, { opId: 'op-c4', text: '/compact keep the plan', command: false }))).toMatchObject({ status: 200 });
    await settled(() => expect(store.message('m-2')?.delivery).toBe('sent'));

    expect(held.writes).toEqual(['\u001b[200~/compact keep the plan\u001b[201~', '\r', '\u001b[200~\\/compact keep the plan\u001b[201~', '\r']);
  });

  it('types nothing when the session ends while the message waits on a menu, and says why', async () => {
    const { service, held, open, body, view, store, logs } = setupSend();
    const { key, frames } = open(2);

    held.menu = true;
    service.send(body(key));
    await settled(() => expect(logs).toContain('session s2: a message waits, a menu is open'));
    store.updateSession('s2', { state: 'ended' });
    await settled(() => expect(store.message('m-1')).toBeNull());

    // It leaves the conversation; its last event tells the window why, with its text, so the composer can take it back.
    expect(frames.at(-1)).toMatchObject({ type: 'message', message: { id: 'm-1', text: 'Fix the build', delivery: 'not-sent', error: 'The session has ended.' } });
    expect(store.conversation('s2', null, 10).items).toEqual([]);
    // The same command again is refused with why, and types nothing.
    store.updateSession('s2', { state: 'idle' });
    expect(service.send(body(key))).toEqual({ status: 409, body: { error: 'The session has ended.' } });
    expect(held.writes).toEqual([]);
    expect(held.reservations).toEqual([]);
    expect(logs).toContain('session s2: message m-1 not-sent: The session has ended.');
  });

  it('types nothing into a session a newer one replaced, or one the reservation refuses', async () => {
    const { service, held, open, body, view, store, logs, scopes } = setupSend();
    const { key, frames } = open(2);

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

  it("replays an opId only within the window's current session and scope generation", () => {
    const { service, open, body, view, store } = setupSend();
    const { key } = open(2);

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
    const { key } = open(2);
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
    const { key } = open(2);

    held.menu = true;
    service.send(body(key));
    // The session is still starting, which the transcript poll leaves out.
    store.updateSession('s2', { state: 'starting' });
    await service.poll();
    service.send(body(key, { opId: 'op-2', text: 'Second' }));
    store.updateSession('s2', { state: 'running' });
    held.menu = false;
    await settled(() => expect(store.message('m-2')?.delivery).toBe('sent'));
    // The second joined the first in the queue it was kept in, so both went as one paste.
    expect(held.writes).toEqual(['\u001b[200~Fix the build\n\nSecond\u001b[201~', '\r']);
    expect(store.message('m-1')?.delivery).toBe('sent');
  });

  it("types messages for the same launch that queue behind one another as one, keeps the continue text apart, and confirms each by the joined line", async () => {
    const { service, held, open, body, store, logs } = setupSend();
    const { key } = open(2);

    held.menu = true;
    service.send(body(key));
    expect(service.continueAfterLimit('s2', 'Continue.')).toBeNull();
    service.send(body(key, { opId: 'op-2', text: 'Second' }));
    service.send(body(key, { opId: 'op-3', text: '/third' }));
    held.menu = false;
    const items = () => store.conversation('s2', null, 10).items as Array<{ id: string; text: string; delivery: string; transcriptUuid: string | null }>;

    await settled(() => expect(items().map((item) => [item.text, item.delivery])).toEqual([['Fix the build', 'sent'], ['Continue.', 'sent'], ['Second', 'sent'], ['/third', 'sent']]));
    expect(held.writes.filter((write) => write !== '\r')).toEqual(['\u001b[200~Fix the build\u001b[201~', '\u001b[200~Continue.\u001b[201~', '\u001b[200~Second\n\n\\/third\u001b[201~']);
    expect(logs).toContain('session s2: a new message joins the message waiting to be typed, to go as one');

    const [second, third] = items().slice(2).map((item) => store.message(item.id)!);

    expect(second!.pastedAt).toBe(third!.pastedAt);

    // The joined line confirms both messages in place, with no terminal copy.
    await service.poll();
    expect(items().map((item) => [item.text, item.transcriptUuid])).toEqual([
      ['Fix the build', 'typed-2'],
      ['Continue.', 'typed-5'],
      ['Second', 'typed-8'],
      ['/third', 'typed-8'],
    ]);
  });

  it('settles a spoken message a stopped hub left open by the text it typed, tags included', async () => {
    const { voice } = fakeVoice();
    const { store, make, held, scopes, view } = setupSend(new FakeHeld(), undefined, voice);

    store.addMessage({ id: 'm-spoken', sessionId: 's2', workItemId: 2, at: NOW, origin: 'typed', text: 'half typed', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'op-s', pastedAt: NOW, launch: 'launch-1', spokenRequested: true });
    held.box = '[spoken] [expressive] half typed';

    const service = make();

    service.open(pageOn(scopes, view.view, 2), () => undefined);
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

      service.open(pageOn(scopes, view.view, 2), (frame) => frames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

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

    // Messages a stopped hub left wait for a window, not for this hub, so they do not hold off a hub restart; one this hub stores does until sent.
    expect(service.sending()).toBe(false);
    store.addMessage({ ...typed, id: 'm-new', text: 'new', opId: 'op-n', pastedAt: null, launch: 'launch-1' });
    expect(service.sending()).toBe(true);
    store.updateMessage('m-new', { delivery: 'sent' });
    expect(service.sending()).toBe(false);

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
    const short = fourth.open(pageOn(scopes, view.view, 2), (frame) => shortFrames.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { type: string }));

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

  it('settles messages a stopped hub left pasted together as the one text they were typed as', async () => {
    const { store, make, held, logs, scopes, view } = setupSend();
    const typed = { sessionId: 's2', workItemId: 2, at: NOW, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open' as const, error: null, pastedAt: NOW, launch: 'launch-1' };

    store.addMessage({ ...typed, id: 'm-first', text: 'first half', opId: 'op-a' });
    store.addMessage({ ...typed, id: 'm-second', text: 'second half', opId: 'op-b' });
    // The box wraps the joined text, so it holds exactly what was typed.
    held.box = 'first half second half';

    const service = make();

    service.open(pageOn(scopes, view.view, 2), () => undefined);
    await settled(() => expect([store.message('m-first'), store.message('m-second')]).toEqual([null, null]));
    service.stop();
    expect(held.writes).toEqual(['\u0015']);
    expect(held.box).toBe('');
    expect(logs).toContain('session s2: messages m-first, m-second left open by a stopped hub are settled from the transcript and the screen');
    expect(logs.filter((line) => line.includes('not-sent: Claude Code did not take the message, so Switchboard cleared it'))).toHaveLength(2);
  });

  it("settles another provider's messages a stopped hub left open one by one, whatever their paste time", async () => {
    const resolved: string[][] = [];
    const adapter = {
      supports: () => true,
      poll: async () => undefined,
      readEnded: () => undefined,
      send: () => undefined,
      resolve: (message: ConversationMessage, text: string, done: (outcome: InputOutcome) => void) => {
        resolved.push([message.id, text]);
        done(message.id === 'm-first' ? { delivery: 'sent' } : { delivery: 'not-sent', error: 'Not in its history.' });
      },
      commands: () => [],
      cannotSend: () => null,
      close: () => undefined,
    } as unknown as ConversationAdapter;
    const { store, make, scopes, view } = setupSend(new FakeHeld(), undefined, undefined, { adapters: () => [adapter] });
    const typed = { sessionId: 's2', workItemId: 2, at: NOW, origin: 'typed' as const, transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open' as const, error: null, pastedAt: NOW, launch: 'launch-1' };

    store.updateSession('s2', { codeMode: false });
    store.addMessage({ ...typed, id: 'm-first', text: 'first', opId: 'op-a' });
    store.addMessage({ ...typed, id: 'm-second', text: 'second', opId: 'op-b' });

    const service = make();

    service.open(pageOn(scopes, view.view, 2), () => undefined);
    await settled(() => expect(store.message('m-second')).toBeNull());
    service.stop();
    expect(resolved).toEqual([['m-first', 'first'], ['m-second', 'second']]);
    expect(store.message('m-first')?.delivery).toBe('sent');
  });

  describe('question cards (PRD R103)', () => {
    const ASK = 'Two decisions:\n\n1. **Port.** Which port? {#port-choice}\n   - A) 8765 (recommended) — the default.\n   - B) 8799 — free on this machine.\n2. Keep the old route? {#keep-route}\n   - A) Keep it\n   - B) Remove it';
    const ask = (store: Store, id = 'q1', opening = ASK) =>
      store.addReply({ id, sessionId: 's2', workItemId: store.session('s2')!.workItemId, at: NOW, kind: 'reply', answers: null, opening, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: id });
    const card = (patch: Record<string, unknown> = {}) => ({ card: 'reply:q1', slug: 'port-choice', letters: ['B'], other: '', ...patch });
    const setupCards = () => {
      const context = setupSend();

      // Every reply here follows the rules after the cutover.
      context.store.setPagePref('questionsLedgerSince', '1');
      ask(context.store);
      return context;
    };
    const messageOf = (answer: { body: unknown }) => (answer.body as { message: { id: string; text: string } }).message;

    it("counts a work item's waiting questions for its list row, as the chip does, and sends the pages their list again when the count changes (PRD R103)", () => {
      let counter: ConversationService | null = null;
      const item2 = (status = 'running') => ({ status, sessions: [{ id: 's2' }] });
      const context = setupSend(new FakeHeld(), undefined, undefined, {
        pageList: () => [{ key: 'progress', title: 'In progress', glyph: '', empty: null, rows: [{ workItemId: 2, questions: counter!.waitingQuestions(item2()) } as never] }],
      });
      const { service, store, open, body } = context;

      counter = service;
      store.setPagePref('questionsLedgerSince', '1');
      ask(store);

      // A page that connects while a card waits is listed with its count; the dismissal of a question then lists the new count.
      const mine = open(2);
      const listed = () => mine.frames.flatMap((frame) => (Array.isArray(frame['groups']) ? [(frame['groups'] as Array<{ rows: Array<{ questions: number }> }>)[0]!.rows[0]!.questions] : []));

      expect(listed()).toEqual([2]);
      expect(service.questionsView('s2').open).toBe(2);

      // A later card adds its questions, which reach this page though another page's hello listed them first.
      ask(store, 'q2', '1. Another? {#another-one}\n   - A) x\n   - B) y');
      const theirs = open(2);

      service.questionsChangedNow('s2');
      expect(listed()).toEqual([2, 3]);
      expect(theirs.frames.filter((frame) => Array.isArray(frame['groups']))).toHaveLength(1);

      // A card draft changes no count and sends no list.
      expect(service.cardCommand('card-draft', { window: mine.key, scopeGen: 1, opId: 'd1', sessionId: 's2', card: 'reply:q1', draft: { step: 'keep-route', picks: {} } }).status).toBe(200);
      expect(listed()).toEqual([2, 3]);

      // A partial answer leaves the card's other question waiting.
      expect(service.send(body(mine.key, { text: undefined, answers: [card()] })).status).toBe(200);
      service.questionsChangedNow('s2');
      expect(listed()).toEqual([2, 3, 2]);

      // A dismissal, then a withdrawal, clear the rest.
      expect(service.cardCommand('card-dismiss', { window: mine.key, scopeGen: 1, opId: 'x1', sessionId: 's2', card: 'reply:q1', slug: 'keep-route' }).status).toBe(200);
      expect(listed()).toEqual([2, 3, 2, 1]);
      ask(store, 'q3', 'Not needed after all.\n\n[withdraw: another-one]');
      service.questionsChangedNow('s2');
      expect(listed()).toEqual([2, 3, 2, 1, 0]);
      expect(service.questionsView('s2').open).toBe(0);

      // A page whose hello listed a question that is withdrawn before the change settles gets the list again, though the count is back where it was.
      ask(store, 'q4', '1. Last one? {#last-one}\n   - A) x\n   - B) y');
      const late = open(2);

      ask(store, 'q5', 'Never mind.\n\n[withdraw: last-one]');
      service.questionsChangedNow('s2');
      expect(late.frames.flatMap((frame) => (Array.isArray(frame['groups']) ? [(frame['groups'] as Array<{ rows: Array<{ questions: number }> }>)[0]!.rows[0]!.questions] : []))).toEqual([1, 0]);
      expect(listed()).toEqual([2, 3, 2, 1, 0]);
    });

    it('counts no waiting questions on a done work item or for a session the page cannot answer, but does for an ended thread a message resumes (PRD R103)', () => {
      const { service, store } = setupCards();
      const running = { status: 'running', sessions: [{ id: 's2' }] };

      expect(service.waitingQuestions(running)).toBe(2);
      expect(service.waitingQuestions({ status: 'done', sessions: [{ id: 's2' }] })).toBe(0);
      expect(service.waitingQuestions({ status: 'running', sessions: [] })).toBe(0);

      // An ended Code Mode session is read-only until Resume; an ended app-server thread takes a message, which resumes it.
      store.updateSession('s2', { state: 'ended' });
      expect(service.waitingQuestions(running)).toBe(0);
      store.updateSession('s2', { codeMode: false, execution: 'app-server', provider: 'codex' });
      expect(service.waitingQuestions(running)).toBe(2);
    });

    it("keeps a session's count while its conversation is unchanged, so a list build reads no ledger again (PRD R103)", () => {
      const { service, store } = setupCards();
      const running = { status: 'running', sessions: [{ id: 's2' }] };

      expect(service.waitingQuestions(running)).toBe(2);

      const reads = vi.spyOn(store, 'conversation');

      // More sessions than the question index keeps leave its ledger out; the count stays without a read.
      for (let index = 0; index < 40; index++) {
        questionIndex(store).ledger(`other-${index}`);
      }

      reads.mockClear();
      expect(service.waitingQuestions(running)).toBe(2);
      expect(reads.mock.calls.filter(([id]) => id === 's2')).toHaveLength(0);
      store.addDismissal('s2', 'q1', 'keep-route', NOW);
      expect(service.waitingQuestions(running)).toBe(1);
    });

    it('counts the questions of an answer that becomes unconfirmed as waiting again, until a line confirms it (PRD R103)', () => {
      const { service, store, open, body } = setupCards();
      const running = { status: 'running', sessions: [{ id: 's2' }] };
      const mine = open(2);

      expect(service.waitingQuestions(running)).toBe(2);
      const answer = messageOf(service.send(body(mine.key, { text: undefined, answers: [card()] })));

      store.updateMessage(answer.id, { delivery: 'sent' });
      expect(service.waitingQuestions(running)).toBe(1);
      store.updateMessage(answer.id, { delivery: 'unconfirmed', error: 'Not in the transcript.' });
      expect(service.waitingQuestions(running)).toBe(2);
      store.updateMessage(answer.id, { delivery: 'sent', error: null });
      expect(service.waitingQuestions(running)).toBe(1);
    });

    it('builds one ledger per conversation change, shared with the runtime, and reads it again only once the conversation changes', () => {
      const { service, store, open, view } = setupCards();
      const mine = open(2);
      const reads = vi.spyOn(store, 'conversation');
      const draft = { step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: null } } };

      // A draft's check and its broadcast to the windows share one read, made after the conversation last changed.
      ask(store, 'q0', 'Working on it.');
      expect(service.cardCommand('card-draft', { window: mine.key, scopeGen: 1, opId: 'd1', sessionId: 's2', card: 'reply:q1', draft }).status).toBe(200);
      expect(reads.mock.calls.filter(([id]) => id === 's2')).toHaveLength(1);
      expect(service.ledger('s2')).toBe(questionIndex(store).ledger('s2'));
      expect(questionCardOpen(store, 's2', 1)).toBe(true);
      expect(reads.mock.calls.filter(([id]) => id === 's2')).toHaveLength(1);

      // A change to the conversation, or a dismissal, reads it again.
      const before = service.ledger('s2');

      ask(store, 'q2', '1. Another? {#another-one}\n   - A) x\n   - B) y');
      expect(service.ledger('s2')).not.toBe(before);
      expect(service.ledger('s2').open).toContain('reply:q2#another-one');
      const asked = service.ledger('s2');

      store.addDismissal('s2', 'q2', 'another-one', NOW);
      expect(service.ledger('s2')).not.toBe(asked);
      expect(service.ledger('s2').questions.get('reply:q2#another-one')?.state).toBe('dismissed');
    });

    it('sends the cards carried past retention as the ledger has them, while a question is open or an answer is being sent (PRD R103)', () => {
      const { service, store, open, body, view } = setupCards();
      const mine = open(2);
      const carried = () => (service.questionsView('s2').carried ?? []).map((one) => [one.key, one.state]);

      expect(service.questionsView('s2').carried).toEqual([]);

      for (let index = 0; index < CONVERSATION_RETENTION + 5; index++) {
        store.addReply({ id: `a${index}`, sessionId: 's2', workItemId: store.session('s2')!.workItemId, at: NOW, kind: 'aside', answers: null, opening: 'Step.', source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: `a${index}` });
      }

      expect(store.reply('q1')).toBeNull();
      const view2 = service.questionsView('s2');

      expect(view2.carried!.map((one) => [one.card, one.replyId, one.question.slug, one.question.options.map((option) => option.label), one.state])).toEqual([
        ['reply:q1', 'q1', 'port-choice', ['8765', '8799'], 'open'],
        ['reply:q1', 'q1', 'keep-route', ['Keep it', 'Remove it'], 'open'],
      ]);
      expect(view2.oldest).toBe('reply:q1');
      // The window's hello carries them too.
      expect((open(2).frames[0] as { questions?: { carried?: unknown[] } }).questions?.carried).toHaveLength(2);

      // Answered in part, the card keeps both questions as they stand.
      const sent = messageOf(service.send(body(mine.key, { text: undefined, answers: [card()] })));

      expect(carried()).toEqual([
        ['reply:q1#port-choice', 'answered'],
        ['reply:q1#keep-route', 'open'],
      ]);
      // With none open, it stays only while an answer is still being sent.
      expect(service.cardCommand('card-dismiss', { window: mine.key, scopeGen: 1, opId: 'x1', sessionId: 's2', card: 'reply:q1', slug: 'keep-route' }).status).toBe(200);
      expect(store.message(sent.id)?.delivery).toBe('open');
      expect(carried()).toEqual([
        ['reply:q1#port-choice', 'answered'],
        ['reply:q1#keep-route', 'dismissed'],
      ]);
      store.updateMessage(sent.id, { delivery: 'sent' });
      expect(carried()).toEqual([]);
    });

    it('tells the session of a dismissal whose question retention deleted, with the next answer', () => {
      const { service, store, open, body, view } = setupCards();
      const mine = open(2);

      expect(service.cardCommand('card-dismiss', { window: mine.key, scopeGen: 1, opId: 'x1', sessionId: 's2', card: 'reply:q1', slug: 'keep-route' }).status).toBe(200);

      for (let index = 0; index < CONVERSATION_RETENTION + 5; index++) {
        store.addReply({ id: `a${index}`, sessionId: 's2', workItemId: store.session('s2')!.workItemId, at: NOW, kind: 'aside', answers: null, opening: 'Step.', source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: `a${index}` });
      }

      expect(store.reply('q1')).toBeNull();
      expect(service.questionsView('s2')).toMatchObject({ open: 1, oldest: 'reply:q1' });

      const sent = messageOf(service.send(body(mine.key, { text: undefined, answers: [card()] })));

      expect(store.message(sent.id)?.answers).toEqual([
        { replyId: 'q1', slug: 'port-choice', letters: ['B'], other: '', via: 'card' },
        { replyId: 'q1', slug: 'keep-route', letters: [], other: '', via: 'card', dismissed: true },
      ]);
      expect(store.dismissals('s2')[0]?.reportedIn).toBe(sent.id);
    });

    it('tells a dismissal again with the next answer when the answer message that told it is unconfirmed', () => {
      const { service, store, open, body } = setupCards();
      const mine = open(2);

      service.cardCommand('card-dismiss', { window: mine.key, scopeGen: 1, opId: 'x1', sessionId: 's2', card: 'reply:q1', slug: 'keep-route' });
      const first = messageOf(service.send(body(mine.key, { text: undefined, answers: [card()] })));

      expect(store.dismissals('s2')[0]?.reportedIn).toBe(first.id);
      store.updateMessage(first.id, { delivery: 'unconfirmed', error: 'Not in the transcript.' });

      const second = messageOf(service.send(body(mine.key, { text: undefined, answers: [card()], opId: 'op-second' })));

      expect(store.message(second.id)?.answers).toContainEqual({ replyId: 'q1', slug: 'keep-route', letters: [], other: '', via: 'card', dismissed: true });
      expect(store.dismissals('s2')[0]?.reportedIn).toBe(second.id);
    });

    it('tells a dismissal again after retention when the answer message that told it comes back not sent', () => {
      const { service, store, open, body, view } = setupCards();
      const mine = open(2);

      service.cardCommand('card-dismiss', { window: mine.key, scopeGen: 1, opId: 'x1', sessionId: 's2', card: 'reply:q1', slug: 'keep-route' });
      const first = messageOf(service.send(body(mine.key, { text: undefined, answers: [card()] })));

      expect(store.dismissals('s2')[0]?.reportedIn).toBe(first.id);
      expect(store.message(first.id)?.delivery).toBe('open');

      for (let index = 0; index < CONVERSATION_RETENTION + 5; index++) {
        store.addReply({ id: `a${index}`, sessionId: 's2', workItemId: store.session('s2')!.workItemId, at: NOW, kind: 'aside', answers: null, opening: 'Step.', source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: `a${index}` });
      }

      expect(store.reply('q1')).toBeNull();
      store.updateMessage(first.id, { delivery: 'not-sent' });
      store.unreportDismissals('s2', first.id);
      expect(service.questionsView('s2').open).toBe(1);

      const again = messageOf(service.send(body(mine.key, { opId: 'op-2', text: undefined, answers: [card()] })));

      expect(store.message(again.id)?.answers?.map((one) => [one.slug, one.dismissed === true])).toEqual([
        ['port-choice', false],
        ['keep-route', true],
      ]);
    });

    it('writes the [answers] message a Send posts, stores its links, and types it', async () => {
      const { service, store, open, body, held, view } = setupCards();
      const mine = open(2);
      const answer = service.send(body(mine.key, { text: undefined, answers: [card({ other: 'unless it is taken' }), card({ slug: 'keep-route', letters: [], other: ' keep it,\n for now ' })] }));

      expect(answer.status).toBe(200);
      expect(messageOf(answer).text).toBe('[answers]\n- port-choice: Which port? → B) 8799; Comment: unless it is taken\n- keep-route: Keep the old route? → Comment: keep it, for now');
      expect(store.message(messageOf(answer).id)?.answers).toEqual([
        { replyId: 'q1', slug: 'port-choice', letters: ['B'], other: 'unless it is taken', via: 'card' },
        { replyId: 'q1', slug: 'keep-route', letters: [], other: 'keep it, for now', via: 'card' },
      ]);
      await settled(() => expect(held.writes.join('')).toContain('[answers]'));
      expect(service.ledger('s2').open).toEqual([]);
    });

    it('refuses answers to a question no longer open, a malformed answer, a command with answers, and a Send with nothing picked', () => {
      const { service, store, open, body, view } = setupCards();
      const mine = open(2);

      expect(service.send(body(mine.key, { text: undefined, answers: [card({ letters: ['Z'] })] })).status).toBe(400);
      expect(service.send(body(mine.key, { text: undefined, answers: [] })).status).toBe(400);
      // Two rows for one question are refused, whatever their picks.
      expect(service.send(body(mine.key, { text: undefined, answers: [card(), card({ letters: ['B'] })] })).status).toBe(400);
      expect(service.send(body(mine.key, { text: undefined, answers: [card()], command: true })).status).toBe(400);
      expect(service.send(body(mine.key, { text: undefined, answers: [card({ letters: [], other: ' ' })] }))).toEqual({ status: 409, body: { error: 'Pick an answer first.' } });
      expect(service.send(body(mine.key, { text: undefined, answers: [card({ slug: 'no-such-question' })] }))).toEqual({ status: 409, body: { error: 'That question is no longer in the conversation.' } });
      expect(service.send(body(mine.key, { text: undefined, answers: [card()] })).status).toBe(200);
      // A second Send of the same question, from another window or page.
      expect(service.send(body(mine.key, { opId: 'op-2', text: undefined, answers: [card()] }))).toEqual({ status: 409, body: { error: 'Already answered.' } });

      ask(store, 'q2', 'Settled.\n[withdraw: keep-route — not needed]');
      expect(service.send(body(mine.key, { opId: 'op-3', text: undefined, answers: [card({ slug: 'keep-route', letters: ['A'] })] }))).toEqual({ status: 409, body: { error: 'That question was withdrawn.' } });
      ask(store, 'q3', '1. Which port now? {#port-choice}\n   - A) 1\n   - B) 2');
      ask(store, 'q4', '1. Which port again? {#port-choice}\n   - A) 1\n   - B) 2');
      expect(service.send(body(mine.key, { opId: 'op-4', text: undefined, answers: [card({ card: 'reply:q3', letters: ['A'] })] }))).toEqual({ status: 409, body: { error: 'That question was replaced; answer the new one.' } });
    });

    it('resolves a typed message once, when it is stored, and never again after a later reply', () => {
      const { service, store, open, body, view } = setupCards();
      const mine = open(2);
      const typed = messageOf(service.send(body(mine.key, { text: 'port-choice A, keep-route: B' })));

      expect(store.message(typed.id)?.answers).toEqual([
        { replyId: 'q1', slug: 'port-choice', letters: ['A'], other: '', via: 'typed' },
        { replyId: 'q1', slug: 'keep-route', letters: ['B'], other: '', via: 'typed' },
      ]);
      // The same slug asked again opens a new question; the stored answer stays with the first.
      ask(store, 'q2', '1. Which port, really? {#port-choice}\n   - A) 1\n   - B) 2');
      expect(service.ledger('s2').questions.get('reply:q1#port-choice')?.answer?.messageId).toBe(typed.id);
      expect(service.ledger('s2').open).toEqual(['reply:q2#port-choice']);

      // A message that answers nothing is stored with no links and leaves the question open.
      const other = messageOf(service.send(body(mine.key, { opId: 'op-2', text: 'Hold off on the route for now.' })));

      expect(store.message(other.id)?.answers).toEqual([]);
      expect(service.ledger('s2').open).toEqual(['reply:q2#port-choice']);
      // A lone letter answers the current question of the card the operator works in.
      expect(service.cardCommand('card-draft', { window: mine.key, scopeGen: 1, opId: 'd1', sessionId: 's2', card: 'reply:q2', draft: { step: 'port-choice', picks: {} } }).status).toBe(200);
      const lone = messageOf(service.send(body(mine.key, { opId: 'op-3', text: 'b' })));

      expect(store.message(lone.id)?.answers).toEqual([{ replyId: 'q2', slug: 'port-choice', letters: ['B'], other: '', via: 'typed' }]);
    });

    it('keeps each card\'s draft for every window, sends it in hello and as questions events, and refuses a malformed one', () => {
      const { service, open, view } = setupCards();
      const mine = open(2);
      const draft = { step: 'keep-route', picks: { 'port-choice': { letters: ['A'], other: null }, 'keep-route': { letters: [], other: 'later' } } };

      expect((mine.frames[0] as { questions?: { open: number; oldest: string } }).questions).toMatchObject({ sessionId: 's2', since: 1, open: 2, oldest: 'reply:q1', drafts: {}, dismissed: [] });
      expect(service.cardCommand('card-draft', { window: mine.key, scopeGen: 1, opId: 'd1', sessionId: 's2', card: 'reply:q1', draft })).toEqual({ status: 200, body: { done: true } });
      expect(mine.frames.filter((frame) => frame.type === 'questions').at(-1)).toMatchObject({ questions: { drafts: { 'reply:q1': draft } } });
      expect(service.hello(mine.key)['questions']).toMatchObject({ drafts: { 'reply:q1': draft } });

      const refused = (patch: Record<string, unknown>) => service.cardCommand('card-draft', { window: mine.key, scopeGen: 1, opId: 'd2', sessionId: 's2', card: 'reply:q1', draft, ...patch }).status;

      expect(refused({ draft: { step: 'Bad Slug', picks: {} } })).toBe(400);
      expect(refused({ draft: { step: null, picks: { 'port-choice': { letters: ['a'], other: null } } } })).toBe(400);
      expect(refused({ card: 'status:x' })).toBe(400);
      expect(refused({ card: 'reply:nothing' })).toBe(409);
      expect(refused({ scopeGen: 9 })).toBe(409);
      expect(refused({ window: 'forged' })).toBe(403);
    });

    it('dismisses an open question, tells the session with the next answer message, and ends the wait', async () => {
      const settledFor: string[] = [];
      const context = setupSend(new FakeHeld(), undefined, undefined, { questionsSettled: (id) => settledFor.push(id) });
      const { service, store, open, body, view } = context;

      store.setPagePref('questionsLedgerSince', '1');
      ask(store);
      const mine = open(2);
      const dismiss = (slug: string) => service.cardCommand('card-dismiss', { window: mine.key, scopeGen: 1, opId: `x-${slug}`, sessionId: 's2', card: 'reply:q1', slug });

      expect(dismiss('keep-route')).toEqual({ status: 200, body: { done: true } });
      expect(dismiss('keep-route')).toEqual({ status: 409, body: { error: 'That question was dismissed.' } });
      expect(dismiss('no-such-one')).toEqual({ status: 409, body: { error: 'That question is not on this card.' } });
      expect(settledFor).toEqual(['s2']);
      expect(service.ledger('s2').open).toEqual(['reply:q1#port-choice']);

      const sent = messageOf(service.send(body(mine.key, { text: undefined, answers: [card()] })));

      expect(sent.text).toBe('[answers]\n- port-choice: Which port? → B) 8799\n- keep-route: Keep the old route? → No answer (dismissed)');
      expect(store.dismissals('s2')).toEqual([{ replyId: 'q1', slug: 'keep-route', at: expect.any(Number), afterId: 'q1', reportedIn: sent.id }]);
      // A told dismissal is not told again.
      ask(store, 'q2', '1. Another? {#another-one}\n   - A) x\n   - B) y');
      expect(messageOf(service.send(body(mine.key, { opId: 'op-2', text: undefined, answers: [card({ card: 'reply:q2', slug: 'another-one', letters: ['A'] })] }))).text).toBe('[answers]\n- another-one: Another? → A) x');
    });

    it('falls back to the oldest open card for a lone letter, moves a pick to a question asked again, and refuses answers over the length limit', () => {
      const { service, store, open, body, view } = setupCards();
      const mine = open(2);
      const draft = (card: string, value: unknown) => service.cardCommand('card-draft', { window: mine.key, scopeGen: 1, opId: `d-${card}`, sessionId: 's2', card, draft: value });

      // The operator worked in q1, whose questions are then all answered; a lone letter goes to the open card q2.
      expect(draft('reply:q1', { step: 'port-choice', picks: { 'port-choice': { letters: ['A'], other: null } } }).status).toBe(200);
      ask(store, 'q2', '1. Which colour? {#colour-choice}\n   - A) Red\n   - B) Blue');
      service.send(body(mine.key, { text: undefined, answers: [card(), card({ slug: 'keep-route', letters: ['A'] })] }));
      expect(service.currentQuestion('s2')).toMatchObject({ card: 'reply:q2', slug: 'colour-choice' });

      // A pick moves to the same question asked again when its options match.
      expect(draft('reply:q2', { step: 'colour-choice', picks: { 'colour-choice': { letters: ['B'], other: null } } }).status).toBe(200);
      ask(store, 'q3', '1. Which colour, really? {#colour-choice}\n   - A) Red\n   - B) Blue');
      expect(service.questionsView('s2').drafts['reply:q3']).toEqual({ step: null, picks: { 'colour-choice': { letters: ['B'], other: null } } });
      ask(store, 'q4', '1. Which colour now? {#colour-choice}\n   - A) Green\n   - B) Grey');
      expect(service.questionsView('s2').drafts['reply:q4']).toBeUndefined();

      expect(service.send(body(mine.key, { opId: 'op-9', text: undefined, answers: [card({ card: 'reply:q4', slug: 'colour-choice', letters: [], other: 'x'.repeat(9_990) })] }))).toEqual({ status: 409, body: { error: 'The answers are longer than 10,000 characters.' } });
    });

    it('keeps a card\'s draft while its answer is being sent, so an answer that comes back not sent keeps its picks', () => {
      const { service, store, open, body, view } = setupCards();
      const mine = open(2);
      const draft = { step: 'keep-route', picks: { 'port-choice': { letters: ['B'], other: null }, 'keep-route': { letters: ['A'], other: null } } };

      service.cardCommand('card-draft', { window: mine.key, scopeGen: 1, opId: 'd1', sessionId: 's2', card: 'reply:q1', draft });
      const sent = messageOf(service.send(body(mine.key, { text: undefined, answers: [card(), card({ slug: 'keep-route', letters: ['A'] })] })));

      expect(store.message(sent.id)?.delivery).toBe('open');
      expect(service.questionsView('s2').drafts['reply:q1']).toEqual(draft);
      // Once it is sent, the draft of a card with nothing open goes.
      store.updateMessage(sent.id, { delivery: 'sent' });
      expect(service.questionsView('s2').drafts['reply:q1']).toBeUndefined();
    });

    it('applies the card grammar to the draft by voice, reads the next question, and sends after the last answer', () => {
      const { service, store, open, view } = setupCards();
      const mine = open(2);

      expect(service.cardSpeech('s2', 'q1')).toEqual({ id: 'card:q1#port-choice', text: 'Question 1 of 2. Port. Which port? A: 8765, recommended: the default. B: 8799: free on this machine. Or say Comment and your words.' });
      expect(service.cardUtterance(mine.key, 's2', 'fix the login flow')).toBeNull();
      expect(service.cardUtterance(mine.key, 's2', 'repeat')).toEqual({ say: service.cardSpeech('s2', 'q1')!.text });
      expect(service.cardUtterance(mine.key, 's2', 'the fourth one')).toEqual({ say: 'There is no such option.' });
      expect(service.cardUtterance(mine.key, 's2', 'send')).toEqual({ say: 'Nothing to send yet. Pick an answer first.' });
      expect(service.cardUtterance(mine.key, 's2', 'the recommended one')).toEqual({ say: 'A. Question 2 of 2. Keep the old route? A: Keep it. B: Remove it. Or say Comment and your words.' });
      expect(service.drafts('s2').get('reply:q1')).toEqual({ step: 'keep-route', picks: { 'port-choice': { letters: ['A'], other: null } } });
      expect(service.cardUtterance(mine.key, 's2', 'back')?.say).toMatch(/^Question 1 of 2/);
      expect(service.cardUtterance(mine.key, 's2', 'next')?.say).toMatch(/^Question 2 of 2/);
      // A pick that answers the last question waits, so a comment can follow it; saying the pick again keeps it.
      expect(service.cardUtterance(mine.key, 's2', 'B')).toEqual({ say: 'B. Say send, or say Comment and your words.' });
      expect(service.cardUtterance(mine.key, 's2', 'B')).toEqual({ say: 'B. Say send, or say Comment and your words.' });
      expect(service.drafts('s2').get('reply:q1')?.picks['keep-route']).toEqual({ letters: ['B'], other: null });
      expect(service.cardUtterance(mine.key, 's2', 'Comment')).toEqual({ say: 'Say Comment and then your words.' });
      expect(service.cardUtterance(mine.key, 's2', 'Comment, keep it for a week.')).toEqual({ say: 'Comment added. Sending 2 answers.' });

      const sent = store.conversation('s2', null, 10).items.filter((item) => item.type === 'message').at(-1)!;

      expect(sent).toMatchObject({ origin: 'voice', text: '[answers]\n- port-choice: Which port? → A) 8765\n- keep-route: Keep the old route? → B) Remove it; Comment: keep it for a week' });
      expect((sent as { answers?: Array<{ via: string }> }).answers?.map((one) => one.via)).toEqual(['voice', 'voice']);
      expect(service.cardSpeech('s2', 'q1')).toBeNull();
      expect(service.cardUtterance(mine.key, 's2', 'B')).toBeNull();
    });

    it('sends a one-question card by voice on "send" after its pick, and a comment alone, said as the older "other", at once', () => {
      const { service, store, open } = setupCards();
      const mine = open(2);
      const last = (): unknown => store.conversation('s2', null, 10).items.filter((item) => item.type === 'message').at(-1);

      ask(store, 'q2', '1. Ship it today? {#ship-today}\n   - A) Ship now — tag the release\n   - B) Wait — after the review');
      // The operator works in the first card.
      service.cardCommand('card-draft', { window: mine.key, scopeGen: 1, opId: 'd1', sessionId: 's2', card: 'reply:q1', draft: { step: 'port-choice', picks: {} } });
      expect(service.cardUtterance(mine.key, 's2', 'Other, neither port')).toEqual({ say: expect.stringMatching(/^Comment added\. Question 2 of 2/) });
      expect(service.cardUtterance(mine.key, 's2', 'A')).toEqual({ say: 'A. Say send, or say Comment and your words.' });
      expect(last()).toBeUndefined();
      expect(service.cardUtterance(mine.key, 's2', 'send')).toEqual({ say: 'Sending 2 answers.' });
      expect(last()).toMatchObject({ text: '[answers]\n- port-choice: Which port? → Comment: neither port\n- keep-route: Keep the old route? → A) Keep it' });
      // The one-question card is current now: its pick waits for send too.
      expect(service.cardUtterance(mine.key, 's2', 'B')).toEqual({ say: 'B. Say send, or say Comment and your words.' });
      expect(service.cardUtterance(mine.key, 's2', 'send')).toEqual({ say: 'Sending one answer.' });
      expect(last()).toMatchObject({ text: '[answers]\n- ship-today: Ship it today? → B) Wait' });
    });
  });

});

describe('sessionView', () => {
  it('marks a running session whose turn ended with background tasks as in no turn, and no other', () => {
    expect(sessionView(session({ codeMode: true, state: 'running', stateDetail: BACKGROUND_DETAIL }), true, true)).toMatchObject({ state: 'running', background: { agents: 0, shells: 0, other: 0 } });
    expect(sessionView(session({ codeMode: true, state: 'running', stateDetail: null }), true, true)).toMatchObject({ state: 'running', background: null });
    expect(sessionView(session({ codeMode: true, state: 'idle', stateDetail: BACKGROUND_DETAIL }), true, true)).toMatchObject({ state: 'idle', background: null });
  });

  it('names what the view can do with each kind of session', () => {
    expect(sessionView(session({ codeMode: true, state: 'ended' }), true, true)).toMatchObject({ state: 'ended', conversation: 'read-only', reason: 'The session has ended. Resume continues it.' });
    expect(sessionView(session({ codeMode: true, state: 'idle' }), true, false)).toMatchObject({ conversation: 'read-only', reason: 'Switchboard cannot track this session while Install hooks is off.' });
    expect(sessionView(session({ state: 'waiting', stateDetail: null }), false, true)).toMatchObject({ waitingFor: 'question', conversation: 'none', current: false });
    expect(sessionView(session({ codeMode: true, state: 'failed' }), true, true)).toMatchObject({ state: 'idle', conversation: 'full' });
    // An ended registered session resumes in the holder, so the page offers Resume; while it runs in the operator's window it has no conversation (PRD R81).
    expect(sessionView(session({ registered: true, state: 'ended' }), true, true)).toMatchObject({ conversation: 'read-only', reason: 'The session has ended. Resume continues it.' });
    expect(sessionView(session({ registered: true, state: 'idle' }), true, true)).toMatchObject({ conversation: 'none' });
  });

  it('counts the background work a turn left running, from the state detail of its Stop (mechanics M124)', () => {
    expect(sessionView(session({ codeMode: true, state: 'running', stateDetail: backgroundDetail(['subagent', 'subagent', 'shell']) }), true, true).background).toEqual({ agents: 2, shells: 1, other: 0 });
    expect(sessionView(session({ codeMode: true, state: 'running', stateDetail: null }), true, true).background).toBeNull();
    expect(sessionView(session({ codeMode: true, state: 'idle', stateDetail: null }), true, true).background).toBeNull();
  });

  it('carries when a held session waiting on its limit resumes: the reset Claude Code waits for, else the next attempt (architecture.md § Rate limits)', () => {
    const limit = { kind: 'usage' as const, window: 'five_hour', resetsAt: NOW + 3_600_000, exact: true, cli: true, message: null, since: NOW, at: NOW, launchId: 'l', attempts: 0, nextAt: NOW + 3_780_000 };

    expect(sessionView(session({ codeMode: true, state: 'failed', rateLimit: limit }), true, true).limit).toEqual({ until: NOW + 3_600_000, retry: false });
    expect(sessionView(session({ codeMode: true, state: 'failed', rateLimit: { ...limit, attempts: 1 } }), true, true).limit).toEqual({ until: NOW + 3_780_000, retry: true });
    expect(sessionView(session({ codeMode: true, state: 'running', rateLimit: limit }), true, true).limit).toBeNull();
    expect(sessionView(session({ state: 'failed', rateLimit: limit }), true, true).limit).toBeNull();
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

  it('lets the header pin a persona to a Code Mode or app-server session without one, only with voice on and a roster (architecture.md § Personas)', () => {
    const nova = { id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm.' } as const;
    const settings: PersonaView = { enabled: true, personas: [nova], playbookPersonas: {} };

    // A session from before the roster, an app-server one, an ended one and one whose persona left the roster can take a pin.
    expect(sessionView(session({ codeMode: true, personaId: null }), true, true, settings)).toMatchObject({ persona: null, canPin: true });
    expect(sessionView(session({ execution: 'app-server', personaId: null }), true, true, settings)).toMatchObject({ persona: null, canPin: true });
    expect(sessionView(session({ codeMode: true, state: 'ended', personaId: null }), true, true, settings).canPin).toBe(true);
    expect(sessionView(session({ codeMode: true, personaId: 'vega' }), true, true, settings)).toMatchObject({ persona: null, canPin: true });
    expect(sessionView(session({ codeMode: true, personaId: 'nova' }), true, true, settings).canPin).toBe(true);
    // Not a background or registered session, which the flow refuses to pin, nor with voice off, an empty roster or no settings.
    expect(sessionView(session({ personaId: null }), true, true, settings).canPin).toBe(false);
    expect(sessionView(session({ codeMode: true }), true, true, { ...settings, enabled: false }).canPin).toBe(false);
    expect(sessionView(session({ codeMode: true }), true, true, { ...settings, personas: [] }).canPin).toBe(false);
    expect(sessionView(session({ codeMode: true }), true, true).canPin).toBe(false);
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
        return label === 'Approve' ? 'The work item no longer offers this.' : null;
      },
      rowPaste: async (_workItemId, label) => (label === 'Reply' ? 'Dear Ana' : null),
      uploads: join(dir, 'uploads'),
      rowCommand: async (workItemId, label) => {
        commands.push([workItemId, label]);
        return label === 'Open report' ? null : 'The work item no longer offers this.';
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
    let header: PageHeader = { notes: [], sources: [{ kind: 'github', label: 'GitHub', enabled: true, title: 'gh: polled\nClick to stop polling gh', sources: [{ name: 'gh', enabled: true }] }], repoRoots: ['D:/w1'], schedules: [{ name: 'nightly', playbook: 'dev:sweep' }] };
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
    setHeader({ notes: [], sources: [{ kind: 'github', label: 'GitHub', enabled: false, title: 'gh: not polled', sources: [{ name: 'gh', enabled: false }] }], repoRoots: [], schedules: [] });
    service.conversationsChanged();
    expect(page.frames.at(-1)).toMatchObject({ type: 'list', header: { sources: [{ enabled: false }] } });
    expect(page.frames.at(-1)!['groups']).toBeInstanceOf(Array);

    // A voice problem changes the list's notes outside a build; `pageListChanged` sends it, and nothing when nothing changed.
    setHeader({ notes: ['Voice: the voice process stopped.'], heldNote: '1 held session without a work item', sources: [], repoRoots: [], schedules: [] });
    service.pageListChanged();
    expect(page.frames.at(-1)).toMatchObject({ type: 'list', header: { notes: ['Voice: the voice process stopped.'], heldNote: '1 held session without a work item' } });
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
    expect(service.rowAction({ window: page.key, scopeGen: 1, opId: 'b', workItemId: 3, label: 'Approve' })).toEqual({ status: 409, body: { error: 'The work item no longer offers this.' } });
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
    expect(await service.rowCommand({ window: page.key, scopeGen: 1, opId: 'b', workItemId: 3, label: 'History' })).toEqual({ status: 409, body: { error: 'The work item no longer offers this.' } });
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
