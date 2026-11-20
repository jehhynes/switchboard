import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONVERSATION_RETENTION, MIGRATIONS, Store } from '../src/index.js';
import type { ConversationReply } from '../src/index.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const reply = (id: string, at: number, patch: Partial<ConversationReply> = {}): Omit<ConversationReply, 'ord' | 'seenAt'> => ({
  id, sessionId: 's1', workItemId: 1, at, kind: 'reply', answers: null, opening: id, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: null, ...patch,
});

/** A reply's speech fields as the store keeps them before any speech. */
const unspoken = { speak: null, tone: null, spokenState: 'none', spokenAtMs: null, saidChars: null } as const;

describe('conversation store', () => {
  it('keeps whether a message asked for a spoken reply, and a reply\'s passage, tone line and speech', () => {
    const store = Store.open(':memory:');

    store.addMessage({ id: 'm1', sessionId: 's1', workItemId: 1, at: 10, origin: 'typed', text: 'hi', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'o', pastedAt: null, spokenRequested: true });
    store.addMessage({ id: 'm2', sessionId: 's1', workItemId: 1, at: 11, origin: 'typed', text: 'hi', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'p', pastedAt: null });
    store.addReply(reply('r1', 20, { speak: 'Done.', tone: 'calm' }));
    store.addReply(reply('r2', 21));

    expect(store.message('m1')?.spokenRequested).toBe(true);
    expect(store.message('m2')?.spokenRequested).toBe(false);
    expect(store.reply('r1')).toMatchObject({ speak: 'Done.', tone: 'calm', spokenState: 'none', spokenAtMs: null, saidChars: null });
    expect(store.reply('r2')).toMatchObject(unspoken);
    store.updateReply('r1', { spokenState: 'interrupted', spokenAtMs: 7000, saidChars: 40 });
    expect(store.reply('r1')).toMatchObject({ spokenState: 'interrupted', spokenAtMs: 7000, saidChars: 40 });
  });

  it("keeps a session's statuses in the order read, updates one in place, pages them newest first and keeps the newest CONVERSATION_RETENTION", () => {
    const store = Store.open(':memory:');
    const status = (id: string, sessionId = 's1', markdown = id) => store.setStatus({ id, sessionId, workItemId: 1, replyId: `r-${id}`, at: 10, markdown });

    expect(store.latestStatus('s1')).toBeNull();
    status('a');
    status('b');
    status('other', 's2');
    status('c');
    // A later line of the same reply updates its status and keeps its place.
    status('a', 's1', 'a, longer');

    expect(store.status('a')).toEqual({ id: 'a', sessionId: 's1', workItemId: 1, replyId: 'r-a', at: 10, markdown: 'a, longer', seenAt: null });
    expect(store.latestStatus('s1')?.id).toBe('c');
    expect(store.statuses('s1', null, 2)).toMatchObject({ statuses: [{ id: 'c' }, { id: 'b' }], more: true });
    expect(store.statuses('s1', 'b', 5)).toMatchObject({ statuses: [{ id: 'a' }], more: false });
    // A cursor that is gone, or another session's, has nothing before it.
    expect(store.statuses('s1', 'gone', 5)).toEqual({ statuses: [], more: false });
    expect(store.statuses('s1', 'other', 5)).toEqual({ statuses: [], more: false });

    for (let index = 0; index < CONVERSATION_RETENTION; index++) {
      status(`n${index}`);
    }

    expect(store.status('c')).toBeNull();
    expect(store.status('n0')).not.toBeNull();
    expect(store.status('other')).not.toBeNull();
    expect(store.statuses('s1', null, CONVERSATION_RETENTION + 5).statuses).toHaveLength(CONVERSATION_RETENTION);
  });

  it('lists messages and replies in the order they were added, whatever their times, and pages older ones', () => {
    const store = Store.open(':memory:');

    store.addReply(reply('r1', 30));
    store.addMessage({ id: 'm1', sessionId: 's1', workItemId: 1, at: 10, origin: 'terminal', text: 'hi', transcriptUuid: 'u', provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
    store.addReply(reply('r2', 20, { withdrawn: true }));
    store.addReply(reply('other', 15, { sessionId: 's2' }));

    expect(store.conversation('s1', null, 10)).toEqual({
      items: [
        { type: 'reply', ...reply('r1', 30), ...unspoken, ord: 1, seenAt: null },
        { type: 'message', id: 'm1', sessionId: 's1', workItemId: 1, at: 10, origin: 'terminal', text: 'hi', transcriptUuid: 'u', provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null, launch: null, spokenRequested: false, ord: 2 },
        { type: 'reply', ...reply('r2', 20, { withdrawn: true }), ...unspoken, ord: 3, seenAt: null },
      ],
      more: false,
    });
    expect(store.conversation('s1', 'r2', 1)).toMatchObject({ items: [{ id: 'm1' }], more: true });
    expect(store.conversation('s1', 'm1', 5)).toMatchObject({ items: [{ id: 'r1' }], more: false });
    // A cursor that is gone, or another session's, has nothing before it.
    expect(store.conversation('s1', 'deleted', 5)).toEqual({ items: [], more: false });
    expect(store.conversation('s2', 'r2', 5)).toEqual({ items: [], more: false });
    store.updateReply('r1', { rewrittenBy: 'r2', withdrawn: true });
    expect(store.reply('r1')).toMatchObject({ rewrittenBy: 'r2', withdrawn: true });
    expect(store.latestReplies('s1', 1).map((one) => one.id)).toEqual(['r2']);
    expect(store.latestMessageId('s1')).toBe('m1');
    expect(store.hasTranscriptEntry('s1', 'u')).toBe(true);
    expect(store.hasTranscriptEntry('s2', 'u')).toBe(false);
  });

  it('puts items not in the transcript yet after those in it, in the order first seen, and moves each to the end when its line is read', () => {
    const store = Store.open(':memory:');
    const message = (id: string, provisional: boolean) => store.addMessage({ id, sessionId: 's1', workItemId: 1, at: 1, origin: 'terminal', text: id, transcriptUuid: null, provisional, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
    const ids = () => store.conversation('s1', null, 10).items.map((item) => item.id);

    message('m1', false);
    message('sent', true);
    store.addReply(reply('screen', 2, { source: 'screen' }));
    store.addReply(reply('r1', 3));
    expect(ids()).toEqual(['m1', 'r1', 'sent', 'screen']);
    expect(store.provisionalMessages('s1').map((one) => one.id)).toEqual(['sent']);
    expect(store.latestMessageId('s1')).toBe('m1');

    // Paging crosses from the items not in the transcript to those in it.
    expect(store.conversation('s1', 'sent', 1)).toMatchObject({ items: [{ id: 'r1' }], more: true });
    expect(store.conversation('s1', 'screen', 5).items.map((item) => item.id)).toEqual(['m1', 'r1', 'sent']);

    // The reply's line is read first, then the message's.
    store.updateReply('screen', { source: 'transcript' });
    store.placeLast('screen');
    store.updateMessage('sent', { provisional: false, transcriptUuid: 'q1', at: 9 });
    store.placeLast('sent');
    expect(ids()).toEqual(['m1', 'r1', 'screen', 'sent']);
    expect(store.message('sent')).toMatchObject({ provisional: false, withdrawn: false, transcriptUuid: 'q1', at: 9 });
    expect(store.latestMessageId('s1')).toBe('sent');

    store.updateMessage('m1', { withdrawn: true });
    expect(store.message('m1')?.withdrawn).toBe(true);
    expect(store.message('gone')).toBeNull();
  });

  it('counts a withdrawn item as in the transcript, leaves withdrawn items out of a page before its limit, and finds the replies before one', () => {
    const store = Store.open(':memory:');
    const ids = (withdrawn = true) => store.conversation('s1', null, 10, withdrawn).items.map((item) => item.id);

    store.addReply(reply('r1', 1));
    store.addMessage({ id: 'gone', sessionId: 's1', workItemId: 1, at: 2, origin: 'terminal', text: 'x', transcriptUuid: null, provisional: true, withdrawn: true, delivery: null, error: null, opId: null, pastedAt: null });
    store.addReply(reply('screen', 3, { source: 'screen' }));
    store.addReply(reply('dead', 4, { source: 'screen', withdrawn: true }));
    store.addReply(reply('r2', 5));
    expect(ids()).toEqual(['r1', 'gone', 'dead', 'r2', 'screen']);
    expect(ids(false)).toEqual(['r1', 'r2', 'screen']);
    expect(store.conversation('s1', 'screen', 1, false)).toMatchObject({ items: [{ id: 'r2' }], more: true });

    // A rewrite's target is a reply before it; a screen copy still waiting comes after every transcript reply.
    expect(store.latestReplies('s1', 10, 'r2').map((one) => one.id)).toEqual(['dead', 'r1']);
    expect(store.latestReplies('s1', 10, 'screen').map((one) => one.id)).toEqual(['r2', 'dead', 'r1']);
    expect(store.latestReplies('s1', 10).map((one) => one.id)).toEqual(['screen', 'r2', 'dead', 'r1']);
    expect(store.latestReplies('s1', 10, 'unknown')).toEqual([]);
  });

  it(`keeps a session's newest ${CONVERSATION_RETENTION} items, and deletes a work item's conversation with it`, () => {
    const store = Store.open(':memory:');

    for (let at = 1; at <= CONVERSATION_RETENTION + 2; at++) {
      store.addReply(reply(`r${at}`, at));
    }

    const kept = store.conversation('s1', null, CONVERSATION_RETENTION + 10);

    expect(kept.items).toHaveLength(CONVERSATION_RETENTION);
    expect(kept.items[0]).toMatchObject({ id: 'r3' });

    // Items of one time are pruned to the exact count, oldest added first.
    for (let index = 0; index < CONVERSATION_RETENTION + 1; index++) {
      store.addReply(reply(`same${index}`, 1, { sessionId: 's9' }));
    }

    const same = store.conversation('s9', null, CONVERSATION_RETENTION + 10).items;

    expect(same).toHaveLength(CONVERSATION_RETENTION);
    expect(same[0]).toMatchObject({ id: 'same1' });
    expect(store.latestMessageId('s1')).toBeNull();
    store.setCheckpoint({ sessionId: 's1', transcript: 'a.jsonl', offset: 5, lastUuid: 'u', lastAt: 3 });
    expect(store.checkpoint('s1')).toEqual({ sessionId: 's1', transcript: 'a.jsonl', offset: 5, lastUuid: 'u', lastAt: 3 });
    store.setCheckpoint({ sessionId: 's1', transcript: 'b.jsonl', offset: 0, lastUuid: null, lastAt: 3 });
    expect(store.checkpoint('s1')).toMatchObject({ transcript: 'b.jsonl', offset: 0 });
  });

  it("drops a deleted work item's messages, replies, statuses and checkpoints", () => {
    const store = Store.open(':memory:');
    const ticket = store.insertTicket({ source: 'adhoc', sourceKey: '1', ref: '#1', sourceId: null, title: 't', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' } as never);
    const item = store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: 'running', createdAt: 0 } as never);

    store.insertSession({ id: 's1', workItemId: item.id, kind: 'task', provider: 'claude', nativeSessionId: null, shortId: null, cwd: 'D:/w', state: 'running', stateAt: 0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 0, endedAt: null, released: false, releasing: false, question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null });
    store.addReply(reply('r1', 1, { workItemId: item.id }));
    store.addMessage({ id: 'm1', sessionId: 's1', workItemId: item.id, at: 1, origin: 'terminal', text: 'x', transcriptUuid: null, provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
    store.setCheckpoint({ sessionId: 's1', transcript: 'a', offset: 1, lastUuid: null, lastAt: null });
    store.setStatus({ id: 'st1', sessionId: 's1', workItemId: item.id, replyId: 'r1', at: 1, markdown: 'x' });
    store.setStatus({ id: 'st2', sessionId: 's9', workItemId: item.id + 1, replyId: 'r9', at: 1, markdown: 'y' });
    store.deleteWorkItem(item.id);

    expect(store.conversation('s1', null, 10).items).toEqual([]);
    expect(store.checkpoint('s1')).toBeNull();
    expect(store.latestStatus('s1')).toBeNull();
    expect(store.latestStatus('s9')?.id).toBe('st2');
  });

  it('keeps a typed message with its delivery and opId, finds those still awaiting the transcript, and lists open ones after a restart', () => {
    const store = Store.open(':memory:');
    const typed = { sessionId: 's1', workItemId: 1, origin: 'typed' as const, transcriptUuid: null, error: null, pastedAt: 1, provisional: true, withdrawn: false };

    store.addMessage({ ...typed, id: 'm1', at: 1, text: 'one', delivery: 'open', opId: 'op1', launch: 'launch-1' });
    store.addMessage({ ...typed, id: 'm2', at: 2, text: 'two', delivery: 'not-sent', opId: 'op2', error: 'The session has ended.' });
    store.addMessage({ ...typed, id: 'm3', at: 3, text: 'three', delivery: 'sent', opId: 'op3' });
    store.addMessage({ ...typed, id: 'm4', at: 4, text: 'four', delivery: 'sent', opId: 'op4', transcriptUuid: 'u4' });
    store.addMessage({ ...typed, id: 'm5', at: 5, text: 'five', delivery: 'open', opId: 'op5', sessionId: 's2' });
    store.addMessage({ ...typed, id: 'm6', at: 6, text: 'six', delivery: 'open', opId: 'op6', pastedAt: null });

    expect(store.messageByOpId('s1', 'op2')).toMatchObject({ id: 'm2', delivery: 'not-sent', error: 'The session has ended.' });
    expect(store.messageByOpId('s1', 'nope')).toBeNull();
    // A message that was not sent can be removed.
    store.deleteMessage('m2');
    expect(store.message('m2')).toBeNull();
    store.addMessage({ ...typed, id: 'm2', at: 2, text: 'two', delivery: 'not-sent', opId: 'op2', error: 'The session has ended.' });
    // An opId is looked up within its session.
    expect(store.messageByOpId('s1', 'op5')).toBeNull();
    expect(store.messageByOpId('s2', 'op5')).toMatchObject({ id: 'm5' });
    // m6 waits to be pasted, so no transcript entry can be its yet.
    expect(store.typedAwaitingTranscript('s1').map((one) => one.id)).toEqual(['m1', 'm3']);
    store.updateMessage('m3', { delivery: 'sent', transcriptUuid: 'u3' });
    expect(store.message('m3')).toMatchObject({ delivery: 'sent', transcriptUuid: 'u3', error: null });
    expect(store.typedAwaitingTranscript('s1').map((one) => one.id)).toEqual(['m1']);
    // The hub settles these itself, so listing them changes nothing.
    expect(store.openMessages().map((one) => [one.id, one.delivery, one.pastedAt, one.launch])).toEqual([['m1', 'open', 1, 'launch-1'], ['m5', 'open', 1, null], ['m6', 'open', null, null]]);
    expect(store.openMessages()).toHaveLength(3);
  });

  it('counts unread replies the timeline shows and the latest status, and marks each seen on its own', () => {
    const store = Store.open(':memory:');

    store.addReply(reply('r1', 1));
    store.addReply(reply('r2', 2));
    // Neither a withdrawn screen copy, a rewritten reply, a status-only reply, a note nor another session's reply counts.
    store.addReply(reply('gone', 3, { source: 'screen', withdrawn: true }));
    store.addReply(reply('old', 4, { rewrittenBy: 'new' }));
    store.addReply(reply('new', 5, { replaces: 'old' }));
    store.addReply(reply('only-status', 6, { opening: '' }));
    store.addReply(reply('note', 7, { kind: 'note' }));
    store.addReply(reply('aside', 8, { kind: 'aside' }));
    store.addReply(reply('theirs', 9, { sessionId: 's2' }));
    expect(store.unreadCount('s1')).toBe(4);
    expect(store.reply('r1')?.seenAt).toBeNull();

    // Only the latest status counts; one that a newer status replaced no longer shows.
    store.setStatus({ id: 'st1', sessionId: 's1', workItemId: 1, replyId: 'r1', at: 1, markdown: 'one' });
    store.setStatus({ id: 'st2', sessionId: 's1', workItemId: 1, replyId: 'r2', at: 2, markdown: 'two' });
    expect(store.unreadCount('s1')).toBe(5);

    // Marking one leaves the earlier ones unread, and a second mark keeps the first time.
    expect(store.markSeen('s1', ['r2', 'st2', 'r2'], 50)).toEqual({ replies: ['r2'], statuses: ['st2'] });
    expect(store.reply('r2')?.seenAt).toBe(50);
    expect(store.reply('r1')?.seenAt).toBeNull();
    expect(store.status('st2')?.seenAt).toBe(50);
    expect(store.unreadCount('s1')).toBe(3);
    expect(store.markSeen('s1', ['r2'], 60)).toEqual({ replies: [], statuses: [] });
    expect(store.reply('r2')?.seenAt).toBe(50);
    // A later line of the seen status keeps it seen.
    store.setStatus({ id: 'st2', sessionId: 's1', workItemId: 1, replyId: 'r2', at: 2, markdown: 'two, longer' });
    expect(store.status('st2')).toMatchObject({ markdown: 'two, longer', seenAt: 50 });

    // Another session's item, or an unknown ID, marks nothing.
    expect(store.markSeen('s1', ['r1', 'theirs'], 70)).toBeNull();
    expect(store.markSeen('s1', ['r1', 'nope'], 70)).toBeNull();
    expect(store.reply('r1')?.seenAt).toBeNull();
    expect(store.markSeen('s1', [], 70)).toEqual({ replies: [], statuses: [] });
    expect(store.unreadCount('nobody')).toBe(0);
  });

  it('counts the replies and statuses from before unread was kept as seen', () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'store-seen-'));

    dirs.push(dir);

    const path = join(dir, 'switchboard.db');
    const db = new DatabaseSync(path);

    // The schema as it was before seenAt, with a reply and a status.
    const before = MIGRATIONS.findIndex((migration) => migration.includes('ADD COLUMN seenAt'));

    db.exec('BEGIN');
    for (const migration of MIGRATIONS.slice(0, before)) {
      db.exec(migration);
    }
    db.exec(`PRAGMA user_version = ${before}`);
    db.exec("INSERT INTO replies (ord, id, sessionId, workItemId, at, kind, answers, opening, source, replaces, rewrittenBy, withdrawn, transcriptUuid) VALUES (1, 'r1', 's1', 1, 10, 'reply', NULL, 'Old.', 'transcript', NULL, NULL, 0, NULL)");
    db.exec("INSERT INTO statuses (id, sessionId, workItemId, replyId, at, markdown) VALUES ('st1', 's1', 1, 'r1', 10, 'Old.')");
    db.exec('COMMIT');
    db.close();

    const store = Store.open(path);

    expect(store.reply('r1')?.seenAt).toBe(10);
    expect(store.status('st1')?.seenAt).toBe(10);
    expect(store.unreadCount('s1')).toBe(0);
    store.close();
  });

  it('counts a typed message left uncertain by an earlier hub as sent, keeping its place', () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'store-uncertain-'));

    dirs.push(dir);

    const path = join(dir, 'switchboard.db');
    const db = new DatabaseSync(path);
    const before = MIGRATIONS.findIndex((migration) => migration.includes("WHERE delivery = 'uncertain'"));

    db.exec('BEGIN');
    for (const migration of MIGRATIONS.slice(0, before)) {
      db.exec(migration);
    }
    db.exec(`PRAGMA user_version = ${before}`);
    db.exec("INSERT INTO messages (ord, id, sessionId, workItemId, at, origin, text, transcriptUuid, provisional, withdrawn, delivery, error, opId, pastedAt) VALUES (1, 'm1', 's1', 1, 10, 'typed', 'Hello', NULL, 0, 0, 'uncertain', 'The transcript does not show the message.', 'op1', 10)");
    db.exec("INSERT INTO messages (ord, id, sessionId, workItemId, at, origin, text, transcriptUuid, provisional, withdrawn, delivery, error, opId, pastedAt) VALUES (2, 'm2', 's1', 1, 11, 'typed', 'Open', NULL, 1, 0, 'open', NULL, 'op2', NULL)");
    db.exec('COMMIT');
    db.close();

    const store = Store.open(path);

    expect(before).toBeGreaterThan(0);
    expect(store.message('m1')).toMatchObject({ delivery: 'sent', error: null, provisional: false });
    expect(store.message('m2')).toMatchObject({ delivery: 'open' });
    store.close();
  });

  it('keeps window bindings by file', () => {
    const store = Store.open(':memory:');

    store.setWindowBinding({ file: 'w.code-workspace', workItemId: 3, since: 1, scopeGen: 1 });
    store.setWindowBinding({ file: 'w.code-workspace', workItemId: 4, since: 2, scopeGen: 2 });
    expect(store.windowBinding('w.code-workspace')).toEqual({ file: 'w.code-workspace', workItemId: 4, since: 2, scopeGen: 2, selectedWorkItemId: null, selectedSessionId: null, ticketId: null, title: null });
    store.setWindowBinding({ file: 'w.code-workspace', workItemId: 4, since: 2, scopeGen: 3, selectedWorkItemId: 9, selectedSessionId: 's9', ticketId: 5, title: 'Fix it' });
    expect(store.windowBinding('w.code-workspace')).toEqual({ file: 'w.code-workspace', workItemId: 4, since: 2, scopeGen: 3, selectedWorkItemId: 9, selectedSessionId: 's9', ticketId: 5, title: 'Fix it' });
    expect(store.windowBinding('other')).toBeNull();
  });

  it('opens a migrated database read-only, refuses writes, and refuses one of another schema version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-ro-'));

    dirs.push(dir);

    const path = join(dir, 'switchboard.db');
    const writer = Store.open(path);

    writer.addReply(reply('r1', 1));

    const reader = Store.openReadOnly(path);

    expect(reader.conversation('s1', null, 5).items).toHaveLength(1);
    expect(() => reader.addReply(reply('r2', 2))).toThrow(/readonly/i);
    reader.close();
    writer.close();

    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const old = new DatabaseSync(path);

    old.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
    old.close();
    expect(() => Store.openReadOnly(path)).toThrow(`The database is schema version ${MIGRATIONS.length - 1}, not ${MIGRATIONS.length}.`);
  });
});
