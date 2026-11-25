import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONVERSATION_RETENTION, MIGRATIONS, Store, TURN_SLACK_MS } from '../src/index.js';
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
  it('keeps the questions a message answered, null for one stored without them, and the dismissed questions until a message tells the session (PRD R103)', () => {
    const store = Store.open(':memory:');
    const answers = [{ replyId: 'r1', slug: 'port-choice', letters: ['B'], other: '', via: 'card' as const }, { replyId: 'r1', slug: 'keep-route', letters: [], other: '', via: 'card' as const, dismissed: true }];

    store.addMessage({ id: 'm1', sessionId: 's1', workItemId: 1, at: 10, origin: 'typed', text: '[answers]', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'o', pastedAt: null, answers });
    store.addMessage({ id: 'm2', sessionId: 's1', workItemId: 1, at: 11, origin: 'typed', text: 'hi', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'p', pastedAt: null, answers: [] });
    store.addMessage({ id: 'm3', sessionId: 's1', workItemId: 1, at: 12, origin: 'terminal', text: 'hi', transcriptUuid: 'support', provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });

    expect(store.message('m1')?.answers).toEqual(answers);
    expect(store.message('m2')?.answers).toEqual([]);
    expect(store.message('m3')).not.toHaveProperty('answers');
    expect(Object.fromEntries(store.conversation('s1', null, 10).items.map((item) => [item.id, item.type === 'message' ? (item.answers ?? null) : undefined]))).toEqual({ m1: answers, m2: [], m3: null });

    store.addDismissal('s1', 'r1', 'keep-route', 20);
    store.addDismissal('s1', 'r1', 'keep-route', 30);
    store.addDismissal('s1', 'r2', 'colour', 25);
    store.addDismissal('s2', 'r9', 'other-session', 26);
    store.addDismissal('s1', 'r3', 'after-item', 27, 'm2');
    expect(store.dismissals('s1')).toEqual([{ replyId: 'r1', slug: 'keep-route', at: 20, afterId: null, reportedIn: null }, { replyId: 'r2', slug: 'colour', at: 25, afterId: null, reportedIn: null }, { replyId: 'r3', slug: 'after-item', at: 27, afterId: 'm2', reportedIn: null }]);
    store.reportDismissals('s1', [{ replyId: 'r1', slug: 'keep-route' }], 'm1');
    expect(store.dismissals('s1').map((one) => one.reportedIn)).toEqual(['m1', null, null]);
    expect(store.dismissals('s2')).toHaveLength(1);
    // A message that was not sent told nothing.
    store.unreportDismissals('s1', 'm1');
    expect(store.dismissals('s1').map((one) => one.reportedIn)).toEqual([null, null, null]);
  });

  it('advances a session\'s conversation revision on each write to its items, dismissals or carried questions, and on no read (PRD R103)', () => {
    const store = Store.open(':memory:');
    const revisions: string[] = [];
    const step = (write: () => void) => {
      const before = store.conversationRevision('s1');
      const other = store.conversationRevision('s2');

      write();
      revisions.push(store.conversationRevision('s1'));
      expect(store.conversationRevision('s1')).not.toBe(before);
      expect(store.conversationRevision('s2')).toBe(other);
    };

    step(() => store.addMessage({ id: 'm1', sessionId: 's1', workItemId: 1, at: 10, origin: 'typed', text: 'hi', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'o', pastedAt: null }));
    step(() => store.updateMessage('m1', { delivery: 'sent' }));
    step(() => store.placeLast('m1'));
    step(() => store.addReply(reply('r1', 20)));
    step(() => store.updateReply('r1', { rewrittenBy: 'r2' }));
    step(() => store.addDismissal('s1', 'r1', 'port-choice', 30));
    step(() => store.reportDismissals('s1', [{ replyId: 'r1', slug: 'port-choice' }], 'm1'));
    step(() => store.unreportDismissals('s1', 'm1'));
    step(() => store.setQuestionCarry('s1', [{ key: 'reply:r0#old' }]));
    step(() => store.deleteMessage('m1'));
    expect(new Set(revisions).size).toBe(revisions.length);

    const now = store.conversationRevision('s1');

    store.conversation('s1', null, 10);
    store.dismissals('s1');
    store.questionCarry('s1');
    expect(store.conversationRevision('s1')).toBe(now);
  });

  it('hands the items retention deletes to beforePrune, oldest first, and keeps carried questions until replaced (PRD R103)', () => {
    const store = Store.open(':memory:');
    const pruned: string[][] = [];

    store.beforePrune = (sessionId, items) => pruned.push([sessionId, ...items.map((item) => item.id)]);

    for (let index = 0; index < CONVERSATION_RETENTION; index++) {
      store.addReply(reply(`r${index}`, index));
    }

    expect(pruned).toEqual([]);
    store.addReply(reply('next', 1000));
    store.addReply(reply('again', 1001));
    expect(pruned).toEqual([['s1', 'r0'], ['s1', 'r1']]);

    expect(store.questionCarry('s1')).toEqual([]);
    store.setQuestionCarry('s1', [{ key: 'reply:r0#port-choice', state: 'open' }]);
    expect(store.questionCarry('s1')).toEqual([{ key: 'reply:r0#port-choice', state: 'open' }]);
    expect(store.questionCarry('s2')).toEqual([]);
    store.setQuestionCarry('s1', []);
    expect(store.questionCarry('s1')).toEqual([]);
  });

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

  it('keeps a dictated message\'s pieces and [partial] mark, leaves both out of other messages, and matches voice messages as typed ones', () => {
    const store = Store.open(':memory:');
    const pieces = [{ text: 'fix the', score: null, f0: null, dropped: false }, { text: 'login flow', score: null, f0: null, dropped: false }];

    store.addMessage({ id: 'v1', sessionId: 's1', workItemId: 1, at: 10, origin: 'voice', text: 'fix the login flow', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'o', pastedAt: 12, pieces });
    store.addMessage({ id: 'v2', sessionId: 's1', workItemId: 1, at: 11, origin: 'voice', text: 'and the', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'p', pastedAt: 13, partial: true, pieces: pieces.slice(0, 1) });
    store.addMessage({ id: 't1', sessionId: 's1', workItemId: 1, at: 12, origin: 'typed', text: 'hi', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'q', pastedAt: 14 });

    expect(store.message('v1')).toMatchObject({ origin: 'voice', pieces });
    expect(store.message('v1')?.partial).toBeUndefined();
    expect(store.message('v2')).toMatchObject({ partial: true, pieces: pieces.slice(0, 1) });
    expect(store.message('t1')).not.toHaveProperty('pieces');
    expect(store.message('t1')).not.toHaveProperty('partial');
    expect(store.typedAwaitingTranscript('s1').map((message) => message.id)).toEqual(['v1', 'v2', 't1']);
  });

  it('keeps the reply a dictated message spoke over with what was heard of it, and leaves it out of other messages', () => {
    const store = Store.open(':memory:');
    const interrupted = { replyId: 'r1', said: 'The session token', rest: 'is refreshed in two places.' };

    store.addMessage({ id: 'v1', sessionId: 's1', workItemId: 1, at: 10, origin: 'voice', text: 'hold on', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'o', pastedAt: null, interrupted });
    store.addMessage({ id: 'v2', sessionId: 's1', workItemId: 1, at: 11, origin: 'voice', text: 'and then', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'p', pastedAt: null });

    expect(store.message('v1')?.interrupted).toEqual(interrupted);
    expect(store.message('v2')).not.toHaveProperty('interrupted');
  });

  it("keeps a session's statuses in the order read, updates one in place, pages them newest first and keeps the newest CONVERSATION_RETENTION", () => {
    const store = Store.open(':memory:');
    const state = (id: string, sessionId = 's1', body: string | null = id) => store.setState({ id, sessionId, workItemId: 1, replyId: `r-${id}`, at: 10, headline: `h-${id}`, body });

    expect(store.latestState('s1')).toBeNull();
    state('a');
    state('b');
    state('other', 's2');
    state('c');
    // A later line of the same reply updates its state and keeps its place.
    state('a', 's1', 'a, longer');

    // No session row: its turn cannot be established, so the state is stored turn-ended.
    expect(store.state('a')).toEqual({ id: 'a', sessionId: 's1', workItemId: 1, replyId: 'r-a', at: 10, headline: 'h-a', body: 'a, longer', turnEnded: true, seenAt: null });
    expect(store.latestState('s1')?.id).toBe('c');
    expect(store.workItemState(1)?.id).toBe('c');
    expect(store.workItemState(2)).toBeNull();
    expect(store.states('s1', null, 2)).toMatchObject({ states: [{ id: 'c' }, { id: 'b' }], more: true });
    expect(store.states('s1', 'b', 5)).toMatchObject({ states: [{ id: 'a' }], more: false });
    // A cursor that is gone, or another session's, has nothing before it.
    expect(store.states('s1', 'gone', 5)).toEqual({ states: [], more: false });
    expect(store.states('s1', 'other', 5)).toEqual({ states: [], more: false });

    for (let index = 0; index < CONVERSATION_RETENTION; index++) {
      state(`n${index}`);
    }

    expect(store.state('c')).toBeNull();
    expect(store.state('n0')).not.toBeNull();
    expect(store.state('other')).not.toBeNull();
    expect(store.states('s1', null, CONVERSATION_RETENTION + 5).states).toHaveLength(CONVERSATION_RETENTION);
  });

  it("stores a state current only during its session's turn, and ends it when the turn or the session ends", () => {
    const store = Store.open(':memory:');
    const ticket = store.insertTicket({ source: 'adhoc', sourceKey: '1', ref: '#1', sourceId: null, title: 't', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' } as never);
    const item = store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: 'running', createdAt: 0 } as never);
    const session = (id: string, state: 'running' | 'idle' | 'waiting', turnAt: number | null) =>
      store.insertSession({ id, workItemId: item.id, kind: 'task', provider: 'claude', nativeSessionId: null, shortId: null, cwd: 'D:/w', state, stateAt: 0, turnAt, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 0, endedAt: null, released: false, releasing: false, question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null });
    const state = (id: string, sessionId: string, at: number) => store.setState({ id, sessionId, workItemId: item.id, replyId: null, at, headline: id, body: null });

    session('run', 'running', 100_000);
    session('idle', 'idle', 100_000);
    session('wait', 'waiting', null);
    state('now', 'run', 100_000);
    // Codex history gives a turn's whole second, so a little before the turn began still counts as the turn's.
    state('slack', 'run', 100_000 - TURN_SLACK_MS);
    // Replayed from an earlier turn.
    state('older', 'run', 100_000 - TURN_SLACK_MS - 1);
    state('late', 'idle', 200_000);
    state('waiting', 'wait', 1);

    expect([store.state('now'), store.state('slack'), store.state('older'), store.state('late'), store.state('waiting')].map((one) => one?.turnEnded)).toEqual([false, false, true, true, false]);

    // A move between running and waiting is the same turn; the turn's end ends every state of the session, and only that session's.
    store.updateSession('run', { state: 'waiting' });
    expect(store.state('now')?.turnEnded).toBe(false);
    store.updateSession('run', { state: 'idle' });
    expect(store.state('now')?.turnEnded).toBe(true);
    expect(store.state('waiting')?.turnEnded).toBe(false);
    store.updateSession('wait', { state: 'ended' });
    expect(store.state('waiting')?.turnEnded).toBe(true);

    // An update in place keeps its turn ended.
    state('now', 'run', 100_000);
    expect(store.state('now')?.turnEnded).toBe(true);
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
    store.setState({ id: 'st1', sessionId: 's1', workItemId: item.id, replyId: 'r1', at: 1, headline: 'x', body: null });
    store.setState({ id: 'stage-1', sessionId: null, workItemId: item.id, replyId: null, at: 1, headline: 'x', body: null });
    store.setState({ id: 'st2', sessionId: 's9', workItemId: item.id + 1, replyId: 'r9', at: 1, headline: 'y', body: null });
    store.deleteWorkItem(item.id);

    expect(store.conversation('s1', null, 10).items).toEqual([]);
    expect(store.checkpoint('s1')).toBeNull();
    expect(store.latestState('s1')).toBeNull();
    expect(store.state('stage-1')).toBeNull();
    expect(store.latestState('s9')?.id).toBe('st2');
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

    // Only the latest state counts; one that a newer state replaced no longer shows.
    store.setState({ id: 'st1', sessionId: 's1', workItemId: 1, replyId: 'r1', at: 1, headline: 'one', body: 'one' });
    store.setState({ id: 'st2', sessionId: 's1', workItemId: 1, replyId: 'r2', at: 2, headline: 'two', body: 'two' });
    expect(store.unreadCount('s1')).toBe(5);

    // Marking one leaves the earlier ones unread, and a second mark keeps the first time.
    expect(store.markSeen('s1', ['r2', 'st2', 'r2'], 50)).toEqual({ replies: ['r2'], states: ['st2'] });
    expect(store.reply('r2')?.seenAt).toBe(50);
    expect(store.reply('r1')?.seenAt).toBeNull();
    expect(store.state('st2')?.seenAt).toBe(50);
    expect(store.unreadCount('s1')).toBe(3);
    expect(store.markSeen('s1', ['r2'], 60)).toEqual({ replies: [], states: [] });
    expect(store.reply('r2')?.seenAt).toBe(50);
    // A later line that changes only the headline keeps the state seen; one that changes the body marks it unread again.
    store.setState({ id: 'st2', sessionId: 's1', workItemId: 1, replyId: 'r2', at: 2, headline: 'two, longer', body: 'two' });
    expect(store.state('st2')).toMatchObject({ headline: 'two, longer', seenAt: 50 });
    store.setState({ id: 'st2', sessionId: 's1', workItemId: 1, replyId: 'r2', at: 2, headline: 'two, longer', body: 'two, more' });
    expect(store.state('st2')?.seenAt).toBeNull();
    // Nor does a headline-only line clear a body still unread.
    store.setState({ id: 'st2', sessionId: 's1', workItemId: 1, replyId: 'r2', at: 2, headline: 'two, again', body: 'two, more' });
    expect(store.state('st2')?.seenAt).toBeNull();
    expect(store.unreadCount('s1')).toBe(4);
    store.markSeen('s1', ['st2'], 55);

    // A new state is unread only with a body unlike the latest one's: a headline alone, as from a stage report, or the same body is stored seen.
    store.setState({ id: 'st3', sessionId: 's1', workItemId: 1, replyId: null, at: 3, headline: 'three', body: null });
    store.setState({ id: 'st4', sessionId: 's1', workItemId: 1, replyId: 'r4', at: 4, headline: 'four', body: null });
    expect(store.state('st3')?.seenAt).toBe(3);
    store.setState({ id: 'st5', sessionId: 's1', workItemId: 1, replyId: 'r5', at: 5, headline: 'five', body: 'two, more' });
    expect(store.state('st5')?.seenAt).toBe(5);
    expect(store.unreadCount('s1')).toBe(3);

    // Another session's item, or an unknown ID, marks nothing.
    expect(store.markSeen('s1', ['r1', 'theirs'], 70)).toBeNull();
    expect(store.markSeen('s1', ['r1', 'nope'], 70)).toBeNull();
    expect(store.reply('r1')?.seenAt).toBeNull();
    expect(store.markSeen('s1', [], 70)).toEqual({ replies: [], states: [] });
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
    expect(store.state('st1')).toMatchObject({ headline: 'Old.', body: null, seenAt: 10 });
    expect(store.unreadCount('s1')).toBe(0);
    store.close();
  });

  it("turns statuses and work items' stages into states, keeping each session's order", () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'store-states-'));

    dirs.push(dir);

    const path = join(dir, 'switchboard.db');
    const db = new DatabaseSync(path);
    const before = MIGRATIONS.findIndex((migration) => migration.includes('CREATE TABLE states'));

    db.exec('BEGIN');
    for (const migration of MIGRATIONS.slice(0, before)) {
      db.exec(migration);
    }
    db.exec(`PRAGMA user_version = ${before}`);
    db.exec("INSERT INTO tickets (id, source, sourceKey, title, url, assigned, pool, snoozed, repoRoot) VALUES (1, 'adhoc', '1', 't', '', 1, 0, 0, '')");
    const item = (id: number, stage: string | null, stageAt: number | null) =>
      db.prepare("INSERT INTO workItems (id, ticketId, playbook, status, stage, stageAt, createdAt, statusAt) VALUES (?, 1, NULL, 'running', ?, ?, 0, 5)").run(id, stage, stageAt);
    // 1: a stage newer than its status; 2: a stage older than its status; 3: a stage with no time and no status; 4: no stage.
    item(1, '2/5 fixing tests', 300);
    item(2, 'old stage', 50);
    item(3, '  ', null);
    item(4, null, null);
    db.prepare('UPDATE workItems SET stage = ? WHERE id = 3').run('reviewing');
    const status = (id: string, workItemId: number, at: number, markdown: string, seenAt: number | null) =>
      db.prepare('INSERT INTO statuses (id, sessionId, workItemId, replyId, at, markdown, seenAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, `s${workItemId}`, workItemId, `r-${id}`, at, markdown, seenAt);
    // Read out of time order: the one read last stays the latest.
    status('st-a', 1, 200, '## **Where it stands**\n\n- one\n- two', null);
    status('st-b', 1, 100, 'Single line', 100);
    status('st-c', 2, 100, '\n\n- Bullet headline\r\nrest', null);
    db.exec('COMMIT');
    db.close();

    const store = Store.open(path);

    expect(store.state('st-a')).toEqual({ id: 'st-a', sessionId: 's1', workItemId: 1, replyId: 'r-st-a', at: 200, headline: 'Where it stands', body: '- one\n- two', turnEnded: true, seenAt: null });
    expect(store.state('st-b')).toMatchObject({ headline: 'Single line', body: null, seenAt: 100 });
    expect(store.state('st-c')).toMatchObject({ headline: 'Bullet headline', body: 'rest' });
    expect(store.latestState('s1')?.id).toBe('st-b');
    // A stage newer than the work item's newest status is kept with no session, seen and turn-ended; an older one is dropped.
    expect(store.workItemState(1)).toEqual({ id: 'stage-1', sessionId: null, workItemId: 1, replyId: null, at: 300, headline: '2/5 fixing tests', body: null, turnEnded: true, seenAt: 300 });
    expect(store.workItemState(2)?.id).toBe('st-c');
    expect(store.workItemState(3)).toMatchObject({ id: 'stage-3', at: 5, headline: 'reviewing' });
    expect(store.workItemState(4)).toBeNull();
    expect(store.workItem(1)).not.toHaveProperty('stage');
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
