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
import { dir, stored, pageOn, FakeHeld, settled, setupSend, fakeVoice } from './conversationFixtures.js';

describe('ConversationService send', { timeout: 20_000 }, () => {

  it("logs one provider's failing reads once and its recovery, whatever another provider's reads do", async () => {
    let failing = true;
    const adapter = { supports: () => false, poll: async () => { if (failing) throw new Error('The connection to Codex closed.'); }, readEnded: () => undefined, close: () => undefined } as unknown as ConversationAdapter;
    const { service, logs } = setupSend(new FakeHeld(), undefined, undefined, { adapters: () => [adapter] });
    const read = (): string[] => logs.filter((line) => line.startsWith('sessions: '));

    await service.poll();
    await service.poll();
    expect(read()).toEqual(['sessions: could not read conversations: The connection to Codex closed.']);
    failing = false;
    await service.poll();
    expect(read()).toEqual(['sessions: could not read conversations: The connection to Codex closed.', 'sessions: conversations readable again']);
    service.stop();
  });

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
    expect(service.continueAfterLimit('s2', 'Continue.')).toBe('The session has ended. Resume it to send a message.');
    expect(service.continueAfterLimit('nope', 'Continue.')).toBe('The session has ended.');
    expect(held.writes).toHaveLength(2);
  });

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
      expect.stringMatching(new RegExp(`^session s2: message ${dictatedId} sent, steps: last word → turn model decision 600 ms, decision → voice sent 200 ms, voice → hub 2 ms, queue 0 ms, guards \\d+ ms, paste→echo \\d+ ms, paste→Enter \\d+ ms, Enter→transcript \\d+ ms, \\d+ screen reads in \\d+ ms, \\d+ ms in all$`)),
    ]);

    // A typed message's line has the input steps only.
    dictatedId = '';
    expect(service.send(body(mine.key, { text: 'Typed', opId: 'op-typed' }))).toMatchObject({ status: 200 });
    await vi.waitFor(() => expect(logs.some((line) => /^session s2: message m-\d+ sent, steps: queue \d+ ms, guards/.test(line))).toBe(true));
    // A message sent quickly gets only a short debug line besides its steps (operator decision 2026-11-25).
    expect(logs.filter((line) => /^session s2: message sent/.test(line)).every((line) => /^session s2: message sent in \d+\.\d s$/.test(line))).toBe(true);
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
    expect(refused({ launch: 'launch-0' })).toEqual({ status: 409, body: { error: 'The session restarted while you typed. Send the message again.' } });
    held.cannotType_ = 'The terminal holder is from an older build and cannot type. To switch to this build, run hub.js holder stop --all.';
    expect(refused({})).toEqual({ status: 409, body: { error: held.cannotType_ } });
    held.cannotType_ = null;
    setHooks(false);
    expect(refused({})).toEqual({ status: 409, body: { error: 'Switchboard cannot track this session while Install hooks is off.' } });
    setHooks(true);
    store.updateSession('s2', { state: 'ended' });
    expect(refused({})).toEqual({ status: 409, body: { error: 'The session has ended. Resume it to send a message.' } });

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
    await settled(() => expect(logs).toContain('session s2: your message waits: a menu is open'));
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
      ['m-resumed', 'The session restarted while you typed. Send the message again.'],
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

});
