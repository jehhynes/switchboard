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
import { stored, FakeHeld, settled, setupSend } from './conversationFixtures.js';

describe('ConversationService send', { timeout: 20_000 }, () => {
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
