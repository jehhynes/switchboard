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
import { SessionConversation } from '@switchboard/conversation';
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
      log: (line) => logs.push(line),
    });
    const logs: string[] = [];
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

    return { store, view, scopes, service, host, open, transcript, titles, logs };
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

  it('reads the title of a transcript the conversation cannot read, and the sessions after it, logging the failure once', async () => {
    const context = setup();
    const first = context.host(context.view.file, 'big');
    const second = context.host(context.view.file, 'small');
    context.transcript('n-big', [JSON.stringify({ type: 'ai-title', aiTitle: 'Too big to read' })]);
    context.transcript('n-small', [JSON.stringify({ type: 'ai-title', aiTitle: 'Read after it' })]);
    // As for a transcript over V8's string limit, which the conversation's read cannot decode (mechanics M165).
    const read = SessionConversation.prototype.readTranscript;
    const spy = vi.spyOn(SessionConversation.prototype, 'readTranscript').mockImplementation(function (this: SessionConversation, path) {
      if (this.sessionId === 'big') throw new RangeError('Cannot create a string longer than 0x1fffffe8 characters');
      read.call(this, path);
    });

    try {
      await context.service.poll();
      context.transcript('n-big', [JSON.stringify({ type: 'ai-title', aiTitle: 'Too big to read' }), JSON.stringify({ type: 'custom-title', customTitle: 'Renamed' })]);
      await context.service.poll();
    } finally {
      spy.mockRestore();
    }

    expect(context.titles).toEqual([
      { workItemId: first, title: 'Too big to read', origin: 'provider-auto' },
      { workItemId: second, title: 'Read after it', origin: 'provider-auto' },
      { workItemId: first, title: 'Renamed', origin: 'provider-manual' },
    ]);
    expect(context.logs.filter((line) => line.includes('conversation read failed'))).toEqual(['session big conversation read failed: RangeError: Cannot create a string longer than 0x1fffffe8 characters']);
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

describe('sessionView', () => {
  it('marks a running session whose turn ended with background tasks as in no turn, and no other', () => {
    expect(sessionView(session({ codeMode: true, state: 'running', stateDetail: BACKGROUND_DETAIL }), true, true)).toMatchObject({ state: 'running', background: { agents: 0, shells: 0, other: 0 } });
    expect(sessionView(session({ codeMode: true, state: 'running', stateDetail: null }), true, true)).toMatchObject({ state: 'running', background: null });
    expect(sessionView(session({ codeMode: true, state: 'idle', stateDetail: BACKGROUND_DETAIL }), true, true)).toMatchObject({ state: 'idle', background: null });
  });

  it('names what the view can do with each kind of session', () => {
    expect(sessionView(session({ codeMode: true, state: 'ended' }), true, true)).toMatchObject({ state: 'ended', conversation: 'read-only', reason: 'The session has ended. Resume it to send a message.' });
    expect(sessionView(session({ codeMode: true, state: 'idle' }), true, false)).toMatchObject({ conversation: 'read-only', reason: 'Switchboard cannot track this session while Install hooks is off.' });
    expect(sessionView(session({ state: 'waiting', stateDetail: null }), false, true)).toMatchObject({ waitingFor: 'question', conversation: 'none', current: false });
    expect(sessionView(session({ codeMode: true, state: 'failed' }), true, true)).toMatchObject({ state: 'idle', conversation: 'full' });
    // An ended registered session resumes in the holder, so the page offers Resume; while it runs in the operator's window it has no conversation (PRD R81).
    expect(sessionView(session({ registered: true, state: 'ended' }), true, true)).toMatchObject({ conversation: 'read-only', reason: 'The session has ended. Resume it to send a message.' });
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
    // A provider's throttle is told apart from a usage limit, so the page names it Rate limited.
    expect(sessionView(session({ codeMode: true, state: 'failed', rateLimit: { ...limit, kind: 'throttle' } }), true, true).limit).toEqual({ until: NOW + 3_600_000, retry: false, throttle: true });
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
