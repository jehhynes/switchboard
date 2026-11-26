import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core';
import type { ConversationMessage, ConversationReply, Interruption, Piece, VoiceSettings } from '@switchboard/core';
import type { HubMessage, VoiceMessage } from '@switchboard/voice';
import { FRAGMENT_FLUSH_MS, HELD_AFTER_NOTE, HELD_NOTE, VoiceControl } from '../src/voice.js';
import type { VoiceConnection } from '../src/voiceLink.js';
import type { WindowScope } from '../src/windows.js';

class FakeConnection implements VoiceConnection {
  readonly welcome = { protocol: 1, build: 'b', pid: 1 };
  readonly compatible = true;
  readonly sent: HubMessage[] = [];
  #message: (message: VoiceMessage) => void = () => undefined;
  #close: (error: Error) => void = () => undefined;

  onMessage(listener: (message: VoiceMessage) => void): void {
    this.#message = listener;
  }

  onClose(listener: (error: Error) => void): void {
    this.#close = listener;
  }

  drop(): void {
    this.#close(new Error('gone'));
  }

  send(message: HubMessage): void {
    this.sent.push(message);
  }

  close(): void {}

  receive(message: VoiceMessage): void {
    this.#message(message);
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voice-dictation-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const scope = (key: string, workItemId: number, sessionId: string | null, cwd = 'D:/w'): WindowScope => ({ kind: 'page', key, folder: 'D:/w', title: 't', scopeGen: 1, conversations: [{ workItemId, primary: true }], workItemId, cwd, sessionId });

async function setup(patch: Partial<VoiceSettings> = {}) {
  const settings: VoiceSettings = { ...DEFAULT_SETTINGS.voice, enabled: true, ...patch };
  let t = Date.UTC(2026, 10, 20, 12);
  const timers: Array<{ run: () => void; at: number; cleared: boolean; every: number | null }> = [];
  const connection = new FakeConnection();
  const windows = new Map<string, WindowScope>([
    ['k1', scope('k1', 1, 's1')],
    ['k2', scope('k2', 2, 's2', 'D:/other')],
  ]);
  const notified: Array<{ key: string; type: string; payload: Record<string, unknown> }> = [];
  const dictated: Array<{ key: string | null; sessionId: string; text: string; pieces: Piece[]; partial: boolean; interrupted?: Interruption }> = [];
  const busy = new Set<string>();
  let refuse: string | null = null;
  let focused: string | null = 'k1';
  let lastReply: string | null = 'Which port?';
  let card: (text: string) => { say: string } | null = () => null;
  const cardHeard: string[] = [];
  const logs: string[] = [];
  const levels = new Map<string, string>();
  const control = new VoiceControl({
    link: { find: async () => connection, connected: () => connection, stop: () => undefined },
    settings: () => settings,
    store: { reply: () => null, updateReply: () => undefined, message: () => null, markSeen: () => undefined },
    windows: { keys: () => [...windows.keys()], scope: (key) => windows.get(key) ?? null },
    focusedWindow: () => focused,
    full: () => true,
    session: (sessionId) => ({ workItemId: Number(sessionId.slice(1)), cwd: 'D:/w' }),
    busy: (sessionId) => busy.has(sessionId),
    lastReply: () => lastReply,
    originRepo: async (cwd) => (cwd === 'D:/w' ? 'acme/app' : null),
    dictate: (key, sessionId, text, pieces, partial, interrupted) => {
      dictated.push({ key, sessionId, text, pieces, partial, ...(interrupted == null ? {} : { interrupted }) });
      return refuse === null ? { message: { id: `m${dictated.length}` } as ConversationMessage } : { refused: refuse };
    },
    cardUtterance: (_key, _sessionId, text) => {
      cardHeard.push(text);
      return card(text);
    },
    fragmentsDir: dir,
    replyChanged: () => undefined,
    notify: (key, type, payload) => void notified.push({ key, type, payload }),
    dockChanged: () => undefined,
    now: () => t,
    log: (line, level) => {
      logs.push(line);
      levels.set(line, level ?? 'info');
    },
    setTimer: (run, ms) => {
      const timer = { run, at: t + ms, cleared: false, every: null };

      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => void ((timer as { cleared: boolean }).cleared = true),
    every: (run, ms) => {
      const timer = { run, at: t + ms, cleared: false, every: ms };

      timers.push(timer);
      return { stop: () => void (timer.cleared = true) };
    },
  });
  const advance = (ms: number): void => {
    const until = t + ms;

    for (;;) {
      const due = timers.filter((one) => !one.cleared && one.at <= until).sort((a, b) => a.at - b.at)[0];

      if (due === undefined) {
        break;
      }

      t = due.at;

      if (due.every === null) {
        due.cleared = true;
      } else {
        due.at += due.every;
      }

      due.run();
    }

    t = until;
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  control.update();
  await settle();
  // The voice speaks for k1's session.
  connection.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'focus' });

  const piece = (text: string, utteranceId = 'u1', gen = 1): void =>
    connection.receive({ type: 'piece', gen, utteranceId, sessionId: 's1', pieceId: `p-${text}`, text, score: null, f0: null, dropped: false });
  const end = (final = true, utteranceId = 'u1', gen = 1, interrupted: Interruption | null = null): void => connection.receive({ type: 'utterance', gen, utteranceId, sessionId: 's1', text: '', final, interrupted });
  const fragments = (): Array<Record<string, unknown>> =>
    readdirSync(dir)
      .flatMap((file) => readFileSync(join(dir, file), 'utf8').trim().split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  return { control, connection, windows, notified, dictated, busy, advance, settle, piece, end, fragments, logs, levels, cardHeard, setCard: (run: typeof card) => (card = run), refuse: (why: string | null) => (refuse = why), focus: (key: string | null) => (focused = key), setLastReply: (text: string) => (lastReply = text) };
}

// A draft's `added` piece and its number are left out here; the tests of a focused page's composer read them.
const events = (notified: Array<{ key: string; type: string; payload: Record<string, unknown> }>, type: string) =>
  notified.filter((one) => one.type === type).map((one) => [one.key, Object.fromEntries(Object.entries(one.payload).filter(([name]) => name !== 'added' && name !== 'piece'))]);

describe('VoiceControl dictation', () => {
  it('applies a whole utterance that is a card command to the open card instead of sending it, and says the reply (PRD R103)', async () => {
    const { connection, dictated, piece, end, cardHeard, setCard, notified } = await setup();

    setCard((text) => (text === 'bee' ? { say: 'B. Question 2 of 2. Keep the route?' } : null));
    piece('bee');
    end();

    expect(cardHeard).toEqual(['bee']);
    expect(dictated).toEqual([]);
    const said = connection.sent.filter((message) => message.type === 'speak');

    expect(said).toMatchObject([{ type: 'speak', sessionId: 's1', text: 'B. Question 2 of 2. Keep the route?' }]);
    // Its own turn, so the voice process skips it for a newer answer rather than read it late.
    expect(said[0]).toMatchObject({ turn: (said[0] as { replyId: string }).replyId });
    expect(notified.filter((one) => one.type === 'draft').at(-1)).toMatchObject({ key: 'k1', payload: { text: '' } });

    // Anything else is dictation, sent as a message, and leaves the questions open.
    piece('fix the login flow', 'u2');
    end(true, 'u2');
    expect(dictated).toMatchObject([{ key: 'k1', sessionId: 's1', text: 'fix the login flow' }]);
  });

  it('turns the mic on in a window by moving the voice there, and refuses turning it off from a window it is not in', async () => {
    const { control, connection } = await setup();

    expect(control.mic('k2', true)).toBeNull();
    expect(connection.sent.slice(-2)).toEqual([
      { type: 'talk-here', sessionId: 's2' },
      { type: 'mic', on: true },
    ]);
    expect(control.mic('k2', false)).toBe("Voice is not on this page's session. Select Talk here to use it.");
    expect(control.mic('k1', false)).toBeNull();
    expect(connection.sent.at(-1)).toEqual({ type: 'mic', on: false });
  });

  it('logs how long Mic on took from the command to the voice process listening, and a page\'s own steps', async () => {
    const { control, connection, advance, logs, levels } = await setup();
    const audio = (mic: string): void => connection.receive({ type: 'audio', mic, recognizer: 'gpu', error: null } as unknown as VoiceMessage);

    expect(control.mic('k1', true)).toBeNull();
    advance(300);
    audio('starting');
    advance(5_200);
    audio('listening');
    // Once: later states are not the start's.
    audio('hearing');
    expect(logs.filter((line) => line.startsWith('voice: mic on'))).toEqual(['voice: mic on from this computer → listening in 5500 ms']);
    expect(levels.get('voice: mic on from this computer → listening in 5500 ms')).toBe('debug');
    // On again while it listens times nothing.
    expect(control.mic('k1', true)).toBeNull();
    audio('typing');
    expect(logs.filter((line) => line.startsWith('voice: mic on'))).toHaveLength(1);

    control.micTiming('k1', [{ step: 'hub answered', ms: 40 }, { step: 'voice confirmed', ms: 5_540 }], 'listening');
    expect(logs.slice(-2)).toEqual(["voice: mic on from this computer's page; listening after 5.5 s", 'voice: mic on steps from the tap: hub answered at 40 ms, voice confirmed at 5540 ms']);
    expect(levels.get("voice: mic on from this computer's page; listening after 5.5 s")).toBe('info');
    control.micTiming('k1', [{ step: 'hub answered', ms: 40 }], 'unavailable');
    expect(levels.get("voice: mic on from this computer's page; unavailable after 0.0 s")).toBe('warn');
  });

  it('keeps the mic off once the voice process turned it off for a locked computer, also for a process started again', async () => {
    const { control, connection, advance, settle } = await setup();

    expect(control.mic('k1', true)).toBeNull();
    connection.receive({ type: 'mic-off', reason: 'locked' });
    connection.drop();

    const before = connection.sent.length;

    advance(60_000);
    await settle();
    expect(connection.sent.slice(before).map((one) => one.type)).toContain('settings');
    expect(connection.sent.slice(before).filter((one) => one.type === 'mic')).toEqual([]);
    // Off, so turning it off from a window the voice is not in is not refused.
    expect(control.mic('k2', false)).toBeNull();
  });

  it('restores the mic to a voice process started again, marked as a restore, so a lock the hub did not hear keeps it off', async () => {
    const { control, connection, advance, settle } = await setup();

    expect(control.mic('k1', true)).toBeNull();
    connection.drop();

    const before = connection.sent.length;

    advance(60_000);
    await settle();
    expect(connection.sent.slice(before).filter((one) => one.type === 'mic')).toEqual([{ type: 'mic', on: true, restore: true }]);
    // The process answers that it turned the mic off on its own: the hub's mic goes off.
    connection.receive({ type: 'mic-off', reason: 'locked' });
    expect(control.mic('k2', false)).toBeNull();
  });

  it('sends each target\'s repository once its remote is read, the here window\'s composer focus, and the target\'s last reply', async () => {
    const { control, connection, settle } = await setup();

    await settle();
    expect(connection.sent.filter((one) => one.type === 'targets').at(-1)).toMatchObject({ targets: [{ sessionId: 's1', repo: 'acme/app' }, { sessionId: 's2', repo: null }] });
    expect(connection.sent).toContainEqual({ type: 'context', sessionId: 's1', lastReply: 'Which port?' });
    control.composer('k2', true, 'draft');
    expect(connection.sent.filter((one) => one.type === 'typing').at(-1)).toEqual({ type: 'typing', on: false });
    control.composer('k1', true, '');
    expect(connection.sent.filter((one) => one.type === 'typing').at(-1)).toEqual({ type: 'typing', on: true });
    control.composer('k1', false, '');
    expect(connection.sent.filter((one) => one.type === 'typing').at(-1)).toEqual({ type: 'typing', on: false });
  });

  it('forgets the last reply sent for a session that left the targets, so it sends it again when the session returns', async () => {
    const { control, connection, windows, settle } = await setup();
    const contexts = (): HubMessage[] => connection.sent.filter((one) => one.type === 'context');

    await settle();
    expect(contexts()).toEqual([{ type: 'context', sessionId: 's1', lastReply: 'Which port?' }]);
    // The same reply is not sent twice while the session stays a target.
    connection.receive({ type: 'active', gen: 2, sessionId: 's1', reason: 'focus' });
    expect(contexts()).toHaveLength(1);

    const k1 = windows.get('k1')!;

    windows.delete('k1');
    control.update();
    expect(connection.sent.filter((one) => one.type === 'targets').at(-1)).toMatchObject({ targets: [{ sessionId: 's2' }] });
    windows.set('k1', k1);
    control.update();
    connection.receive({ type: 'active', gen: 3, sessionId: 's1', reason: 'focus' });
    expect(contexts()).toEqual([
      { type: 'context', sessionId: 's1', lastReply: 'Which port?' },
      { type: 'context', sessionId: 's1', lastReply: 'Which port?' },
    ]);
  });

  it('shows live words and joins pieces to the draft in the here window, and sends the whole draft once at a spoken turn\'s end while the composer is unfocused', async () => {
    const { control, connection, notified, dictated, piece, end, fragments } = await setup();

    control.composer('k1', false, 'Also,');
    connection.receive({ type: 'words', gen: 1, utteranceId: 'u1', sessionId: 's1', text: 'fix the' });
    piece('fix the');
    piece('login flow');
    expect(events(notified, 'words')).toEqual([['k1', { messageId: 'u1', text: 'fix the' }]]);
    expect(events(notified, 'draft')).toEqual([
      ['k1', { text: 'Also, fix the', sessionId: 's1' }],
      ['k1', { text: 'Also, fix the login flow', sessionId: 's1' }],
    ]);
    end();
    expect(dictated).toEqual([{ key: 'k1', sessionId: 's1', text: 'Also, fix the login flow', partial: false, pieces: [expect.objectContaining({ text: 'fix the' }), expect.objectContaining({ text: 'login flow' })] }]);
    expect(events(notified, 'draft').at(-1)).toEqual(['k1', { text: '', sessionId: 's1' }]);
    expect(fragments().map((one) => `${String(one.event)} ${String(one.text)} ${String(one.messageId)}`)).toEqual(['heard fix the null', 'heard login flow null', 'submitted fix the m1', 'submitted login flow m1']);
    expect(control.take('k1', 's1')?.pieces ?? null).toBeNull();
  });

  it('keeps the voice\'s steps of a message turn detection ended for its timing line, once, and none for one ended without them', async () => {
    const { control, connection, advance, piece } = await setup();

    piece('fix the build');
    advance(5);
    const at = Date.UTC(2026, 10, 20, 12) + 5;

    connection.receive({ type: 'utterance', gen: 1, utteranceId: 'u1', sessionId: 's1', text: 'fix the build', final: true, interrupted: null, timing: { lastWordAt: at - 900, decidedAt: at - 300, endedAt: at - 20, endedBy: 'turn model' } });
    expect(control.timing('m1')).toBe('last word → turn model decision 600 ms, decision → voice sent 280 ms, voice → hub 20 ms');
    expect(control.timing('m1')).toBeNull();

    piece('and the tests', 'u2');
    connection.receive({ type: 'utterance', gen: 1, utteranceId: 'u2', sessionId: 's1', text: 'and the tests', final: true, interrupted: null });
    expect(control.timing('m2')).toBeNull();
  });

  it('shows live words in every window and page showing the target session, while the draft goes to the one window dictation picked', async () => {
    const { connection, windows, notified, piece } = await setup();

    windows.set('page', scope('page', 1, 's1'));
    connection.receive({ type: 'words', gen: 1, utteranceId: 'u1', sessionId: 's1', text: 'fix the' });
    piece('fix the');
    connection.receive({ type: 'words', gen: 1, utteranceId: 'u1', sessionId: 's1', text: '' });
    expect(events(notified, 'words')).toEqual([
      ['k1', { messageId: 'u1', text: 'fix the' }],
      ['page', { messageId: 'u1', text: 'fix the' }],
      ['k1', { messageId: 'u1', text: '' }],
      ['page', { messageId: 'u1', text: '' }],
    ]);
    expect(events(notified, 'draft')).toEqual([['k1', { text: 'fix the', sessionId: 's1' }]]);
  });

  it('leaves the draft unsent while the composer has the focus, after a cut, or for an older generation, and Enter then sends it as a voice message', async () => {
    const { control, connection, dictated, piece, end, notified } = await setup();

    control.composer('k1', true, '');
    piece('rename it');
    end();
    piece('and more', 'u2');
    end(false, 'u2');
    piece('late', 'u3', 0);
    expect(dictated).toEqual([]);
    expect(events(notified, 'draft').at(-1)).toEqual(['k1', { text: 'rename it and more', sessionId: 's1' }]);
    expect(control.take('k1', 's1')?.pieces ?? null).toMatchObject([{ text: 'rename it' }, { text: 'and more' }]);
    expect(control.take('k1', 's1')?.pieces ?? null).toBeNull();
    control.composer('k1', false, 'x');
    control.composer('k1', false, ' ');
    expect(control.take('k1', 's1')?.pieces ?? null).toBeNull();
    connection.receive({ type: 'words', gen: 0, utteranceId: 'u9', sessionId: 's1', text: 'old' });
    expect(events(notified, 'words')).toEqual([]);
  });

  it("keeps listening while a page's composer that asks to listen has the focus: each piece joins its draft, no turn or [partial] sends it, and Send does (architecture.md § Dictation)", async () => {
    const { control, connection, dictated, piece, end, notified, busy, advance } = await setup();
    const typing = () => connection.sent.filter((one) => one.type === 'typing').at(-1);

    control.composer('k1', true, 'Also,', true);
    // Capture keeps running; the process is told only that no spoken alert's answer may take a turn meanwhile.
    expect(typing()).toEqual({ type: 'typing', on: true, listen: true });
    busy.add('s1');
    piece('rename it');
    advance(FRAGMENT_FLUSH_MS + 1_000);
    piece('and the tests');
    end();
    expect(dictated).toEqual([]);
    expect(notified.filter((one) => one.type === 'draft').map((one) => one.payload)).toEqual([
      { text: 'Also, rename it', sessionId: 's1', added: 'rename it', piece: expect.any(Number) },
      { text: 'Also, rename it and the tests', sessionId: 's1', added: 'and the tests', piece: expect.any(Number) },
    ]);
    expect(control.take('k1', 's1')?.pieces ?? null).toMatchObject([{ text: 'rename it' }, { text: 'and the tests' }]);

    // A composer that does not ask to listen stops the voice process listening while it has the focus, as the Conversation view's does.
    control.composer('k1', true, '');
    expect(typing()).toEqual({ type: 'typing', on: true });
    control.composer('k1', true, '', true);
    expect(typing()).toEqual({ type: 'typing', on: true, listen: true });

    // Unfocused, a turn's end sends the draft on its own again.
    control.composer('k1', false, '', true);
    piece('ship it', 'u2');
    end(true, 'u2');
    expect(dictated).toMatchObject([{ key: 'k1', text: 'ship it', partial: false }]);
  });

  it('sends a long message as [partial] parts every 10 seconds while its session works, and the rest at the end', async () => {
    const { busy, dictated, piece, end, advance } = await setup();

    piece('first');
    advance(FRAGMENT_FLUSH_MS);
    busy.add('s1');
    advance(1_000);
    // One settled piece stays in the draft, so the message that ends the utterance always has words to carry.
    expect(dictated).toEqual([]);
    piece('second');
    advance(1_000);
    expect(dictated.map((one) => [one.text, one.partial])).toEqual([['first', true]]);
    piece('third');
    advance(FRAGMENT_FLUSH_MS - 1_000);
    expect(dictated).toHaveLength(1);
    advance(1_000);
    expect(dictated.map((one) => [one.text, one.partial])).toEqual([
      ['first', true],
      ['second', true],
    ]);
    end();
    expect(dictated.at(-1)).toMatchObject({ text: 'third', partial: false });
  });

  it('sends no [partial] part while another app records, and keeps one draft per conversation', async () => {
    const { control, connection, windows, busy, dictated, piece, advance } = await setup();

    busy.add('s1');
    piece('one');
    piece('two');
    connection.receive({ type: 'audio', mic: 'paused-other-app', engine: 'decibri', device: null, recognizer: null, error: null });
    advance(FRAGMENT_FLUSH_MS + 2_000);
    expect(dictated).toEqual([]);
    expect(control.take('k1', 's2')?.pieces ?? null).toBeNull();
    windows.set('k1', scope('k1', 3, 's3'));
    control.composer('k1', false, '');
    expect(control.take('k1', 's3')?.pieces ?? null).toBeNull();
    expect(control.take('k1', 's1')?.pieces ?? null).toMatchObject([{ text: 'one' }, { text: 'two' }]);
  });

  it('keeps a refused turn\'s draft and logs it refused', async () => {
    const { dictated, piece, end, fragments, refuse, notified } = await setup();

    refuse('The session has ended.');
    piece('hello');
    end();
    expect(dictated).toHaveLength(1);
    expect(events(notified, 'draft')).toEqual([['k1', { text: 'hello', sessionId: 's1' }]]);
    expect(fragments().map((one) => `${String(one.event)} ${String(one.error ?? '')}`)).toEqual(['heard ', 'refused The session has ended.']);
  });

  it('passes heard tags to the glossary, logs a dictated message\'s delivery, and shows the mic only where the voice is', async () => {
    const { control, connection, fragments, notified } = await setup();

    control.heard([{ heard: 'a llama', meant: 'Ollama' }]);
    expect(connection.sent.at(-1)).toEqual({ type: 'heard', heard: 'a llama', meant: 'Ollama' });
    control.delivered({ id: 'm1', sessionId: 's1', origin: 'voice', delivery: 'sent', error: null, pieces: [{ text: 'hi', score: null, f0: null, dropped: false }] } as ConversationMessage);
    control.delivered({ id: 'm2', sessionId: 's1', origin: 'typed', delivery: 'sent', error: null } as ConversationMessage);
    expect(fragments()).toEqual([expect.objectContaining({ event: 'sent', messageId: 'm1', text: 'hi' })]);
    connection.receive({ type: 'audio', mic: 'unavailable', engine: 'decibri', device: null, recognizer: null, error: 'No speech recognition model in m.' });
    expect(control.view('k1')).toMatchObject({ here: true, mic: 'unavailable', error: 'No speech recognition model in m.' });
    expect(control.view('k2')).toMatchObject({ here: false, mic: 'off', error: null });
    expect(control.view('k1')).not.toHaveProperty('halfDuplex');

    // Half-duplex capture says why only in the window the voice is in, and the window hears of it when it changes.
    const sent = notified.length;

    connection.receive({ type: 'audio', mic: 'listening', engine: 'decibri', device: null, recognizer: null, error: null, halfDuplex: 'no echo cancellation on Remote Audio' });
    expect(control.view('k1')).toMatchObject({ here: true, mic: 'listening', halfDuplex: 'no echo cancellation on Remote Audio' });
    expect(control.view('k2')).not.toHaveProperty('halfDuplex');
    expect(notified.slice(sent)).toEqual([expect.objectContaining({ key: 'k1', type: 'voice', payload: { voice: expect.objectContaining({ halfDuplex: 'no echo cancellation on Remote Audio' }) } })]);
    // Full duplex with no echo cancellation says why, as the echo check decided, also only here.
    connection.receive({ type: 'audio', mic: 'listening', engine: 'decibri', device: null, recognizer: null, error: null, fullDuplex: 'echo check: no echo detected' });
    expect(control.view('k1')).toMatchObject({ here: true, mic: 'listening', fullDuplex: 'echo check: no echo detected' });
    expect(control.view('k1')).not.toHaveProperty('halfDuplex');
    expect(control.view('k2')).not.toHaveProperty('fullDuplex');
    expect(notified.at(-1)).toMatchObject({ key: 'k1', type: 'voice', payload: { voice: expect.objectContaining({ fullDuplex: 'echo check: no echo detected' }) } });
    connection.receive({ type: 'audio', mic: 'listening', engine: 'decibri', device: null, recognizer: null, error: null });
    expect(control.view('k1')).not.toHaveProperty('halfDuplex');
    expect(control.view('k1')).not.toHaveProperty('fullDuplex');
    expect(notified.at(-1)).toMatchObject({ key: 'k1', type: 'voice' });
    expect(notified.at(-1)!.payload.voice).not.toHaveProperty('halfDuplex');
    control.replyChanged({ id: 'r1', sessionId: 's1', kind: 'reply', source: 'transcript', withdrawn: false, rewrittenBy: null, speak: null, spokenState: 'none', answers: null } as unknown as ConversationReply);
  });
  it('sends the reply a spoken turn spoke over with its message, and keeps it with a draft left unsent until Enter sends it', async () => {
    const { control, dictated, piece, end } = await setup();
    const interrupted = { replyId: 'r1', said: 'The session token', rest: 'is refreshed in two places.' };

    control.composer('k1', false, '');
    piece('hold on');
    end(true, 'u1', 1, interrupted);
    expect(dictated).toEqual([{ key: 'k1', sessionId: 's1', text: 'hold on', partial: false, pieces: [expect.objectContaining({ text: 'hold on' })], interrupted }]);
    expect(control.take('k1', 's1')).toBeNull();

    // Cut short by the composer taking the focus: Enter sends it, naming the reply once.
    piece('wait', 'u2');
    control.composer('k1', true, 'wait');
    end(false, 'u2', 1, interrupted);
    expect(dictated).toHaveLength(1);
    expect(control.take('k1', 's1')).toEqual({ pieces: [expect.objectContaining({ text: 'wait' })], interrupted });
    expect(control.take('k1', 's1')).toBeNull();

    // An emptied draft no longer names it; an utterance that kept nothing names nothing.
    piece('again', 'u3');
    end(false, 'u3', 1, interrupted);
    control.composer('k1', false, '');
    end(false, 'u4', 1, interrupted);
    piece('later', 'u5');
    expect(control.take('k1', 's1')).toEqual({ pieces: [expect.objectContaining({ text: 'later' })], interrupted: null });
  });
});

describe('VoiceControl dictation sent from the composer (architecture.md § Dictation)', () => {
  /** The last piece number a page saw, from the hub's last `draft` that joined one. */
  const lastPiece = (notified: Array<{ type: string; payload: Record<string, unknown> }>): number => notified.filter((one) => one.type === 'draft' && typeof one.payload.piece === 'number').at(-1)!.payload.piece as number;
  const lastDraft = (notified: Array<{ type: string; payload: Record<string, unknown> }>): string => notified.filter((one) => one.type === 'draft').at(-1)!.payload.text as string;

  it('numbers each piece in its draft event, rising across page keys and from the hub clock, so an earlier number is never above a later piece', async () => {
    const { control, windows, notified, piece, focus } = await setup();

    piece('one');
    const first = lastPiece(notified);

    expect(first).toBeGreaterThanOrEqual(Date.UTC(2026, 10, 20, 12));
    piece('two');
    expect(lastPiece(notified)).toBe(first + 1);
    // Another page key for the same session numbers on from the same count.
    windows.set('k3', scope('k3', 1, 's1'));
    focus('k3');
    piece('three', 'u2');
    expect(notified.at(-1)).toMatchObject({ key: 'k3', payload: { piece: first + 2 } });
  });

  it('tags a send with its dictation whether the focus update posted during it comes before or after it, and an update posted before it that comes after it is ignored', async () => {
    const { control, connection, notified, dictated, piece, end } = await setup();
    const typing = () => connection.sent.filter((one) => one.type === 'typing').at(-1);

    // Before: the page's box has the focus and holds a typed word and a piece; Send (seq 3) is overtaken by a blur posted after it (seq 4).
    control.composer('k1', true, 'Also,', true, 2);
    piece('rename it');
    const seen = lastPiece(notified);

    control.composer('k1', false, null, true, 4);
    expect(typing()).toEqual({ type: 'typing', on: false });
    expect(control.take('k1', 's1', seen, 3)).toEqual({ pieces: [expect.objectContaining({ text: 'rename it' })], interrupted: null });
    // The page's update with its draft before Send (seq 2) comes last: it is ignored, so the sent text does not come back as the draft.
    control.composer('k1', true, 'Also, rename it', true, 2);
    expect(typing()).toEqual({ type: 'typing', on: false });
    piece('next', 'u2');
    expect(lastDraft(notified)).toBe('next');
    end(true, 'u2');
    expect(dictated.at(-1)).toMatchObject({ text: 'next' });

    // After: Send (seq 6) reaches the hub first, then the focus update posted after it (seq 7): the message is tagged the same, and the
    // update leaves the emptied draft alone.
    control.composer('k1', true, 'Fix', true, 5);
    piece('the build', 'u3');
    expect(control.take('k1', 's1', lastPiece(notified), 6)).toEqual({ pieces: [expect.objectContaining({ text: 'the build' })], interrupted: null });
    control.composer('k1', true, null, true, 7);
    piece('more', 'u4');
    expect(lastDraft(notified)).toBe('more');
    expect(control.take('k1', 's1', lastPiece(notified), 8)?.pieces).toEqual([expect.objectContaining({ text: 'more' })]);
  });

  it("keeps as the next draft the pieces joined after the last one the page had when it sent, with the reply they spoke over", async () => {
    const { control, notified, piece, end } = await setup();
    const interrupted = { replyId: 'r1', said: 'The session token', rest: 'is refreshed.' };

    control.composer('k1', true, '', true, 1);
    piece('fix it');
    const seen = lastPiece(notified);

    // A piece the hub joined before it took the send, whose draft event the page had not seen: it is not in the sent text.
    piece('and the tests', 'u2');
    end(false, 'u2', 1, interrupted);
    // The reply it spoke over goes with it, not with the message sent before it.
    expect(control.take('k1', 's1', seen, 2)).toEqual({ pieces: [expect.objectContaining({ text: 'fix it' })], interrupted: null });
    piece('too', 'u3');
    expect(lastDraft(notified)).toBe('and the tests too');
    expect(control.take('k1', 's1', lastPiece(notified), 3)).toEqual({ pieces: [expect.objectContaining({ text: 'and the tests' }), expect.objectContaining({ text: 'too' })], interrupted });
    // A reply spoken over by a piece the page had goes with its message; a later piece kept names none.
    piece('stop', 'u5');
    end(false, 'u5', 1, interrupted);
    const stop = lastPiece(notified);

    piece('then retry', 'u6');
    expect(control.take('k1', 's1', stop, 4)).toEqual({ pieces: [expect.objectContaining({ text: 'stop' })], interrupted });
    expect(control.take('k1', 's1', lastPiece(notified), 5)).toEqual({ pieces: [expect.objectContaining({ text: 'then retry' })], interrupted: null });
    // None of its pieces seen: the message holds no dictation, and they all stay.
    piece('later', 'u4');
    expect(control.take('k1', 's1', 0, 4)).toBeNull();
    expect(control.take('k1', 's1')?.pieces).toEqual([expect.objectContaining({ text: 'later' })]);
  });

  it('keeps a piece when an empty draft posted before it arrives later', async () => {
    const { control, notified, piece } = await setup();

    control.composer('k1', true, '', true, 1, 0);
    piece('keep this');
    const seen = lastPiece(notified);
    control.composer('k1', true, '', true, 2, 0);
    expect(control.take('k1', 's1', seen, 3)?.pieces).toEqual([expect.objectContaining({ text: 'keep this' })]);
  });

  it('keeps a send tagged with its dictation whether an empty draft reaches the hub before or after it, and keeps later speech for the next draft', async () => {
    const { control, notified, piece } = await setup();

    // Before: the box, emptied (seq 1), is told empty again (seq 2) before its piece reached the page; that update reaches the hub after the
    // piece but before the send (seq 3), and keeps the piece it does not hold.
    control.composer('k1', true, '', true, 1, 0);
    piece('fix the build');
    const first = lastPiece(notified);

    control.composer('k1', true, '', true, 2, 0);
    expect(control.take('k1', 's1', first, 3)).toEqual({ pieces: [expect.objectContaining({ text: 'fix the build' })], interrupted: null });

    // After: the same empty update (seq 4) reaches the hub only after the send (seq 5) took the piece: it is ignored, and speech heard after
    // the send stays as the next draft.
    piece('and lint', 'u2');
    const second = lastPiece(notified);

    expect(control.take('k1', 's1', second, 5)).toEqual({ pieces: [expect.objectContaining({ text: 'and lint' })], interrupted: null });
    piece('then deploy', 'u3');
    control.composer('k1', true, '', true, 4, 0);

    // The page's own empty draft once the hub took the message (seq 6) names the last piece it had, so a piece joined after it stays too.
    piece('carefully', 'u4');
    expect(lastDraft(notified)).toBe('then deploy carefully');
    control.composer('k1', false, '', true, 6, second);
    expect(control.take('k1', 's1', lastPiece(notified), 7)?.pieces).toEqual([expect.objectContaining({ text: 'then deploy' }), expect.objectContaining({ text: 'carefully' })]);
  });

  it('applies a draft older than a focus that came first, leaving the newer focus, and keeps the unnumbered contract', async () => {
    const { control, connection, notified, piece } = await setup();
    const typing = () => connection.sent.filter((one) => one.type === 'typing').at(-1);

    control.composer('k1', false, null, true, 6);
    control.composer('k1', true, 'typed', true, 5);
    expect(typing()).toEqual({ type: 'typing', on: false });
    piece('more');
    expect(lastDraft(notified)).toBe('typed more');
    // A composer without seq is applied whole, as before: an empty draft drops its dictation.
    control.composer('k1', true, '', true);
    expect(typing()).toEqual({ type: 'typing', on: true, listen: true });
    expect(control.take('k1', 's1')).toBeNull();
  });
});

describe('VoiceControl enrolment', () => {
  async function enrolSetup(windows: number) {
    const settings: VoiceSettings = { ...DEFAULT_SETTINGS.voice, enabled: true };
    const connection = new FakeConnection();
    const logs: string[] = [];
    let docks = 0;
    let finds = 0;
    let found: VoiceConnection | { error: string } = connection;
    const control = new VoiceControl({
      link: {
        find: async () => {
          finds++;
          return found;
        },
        connected: () => connection,
        stop: () => undefined,
      },
      settings: () => settings,
      store: { reply: () => null, updateReply: () => undefined, message: () => null, markSeen: () => undefined },
      windows: { keys: () => (windows > 0 ? ['k1'] : []), scope: (key) => (windows > 0 && key === 'k1' ? scope('k1', 1, 's1') : null) },
      focusedWindow: () => null,
      full: () => true,
      enrolledAt: () => '2026-11-20T10:00:00.000Z',
      replyChanged: () => undefined,
      notify: () => undefined,
      dockChanged: () => void docks++,
      now: () => 1_000,
      log: (line) => void logs.push(line),
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    control.update();
    await settle();
    return { control, connection, settings, logs, settle, docks: () => docks, finds: () => finds, fail: (error: string) => (found = { error }) };
  }

  it('starts the voice process for an enrolment with no window open, has it record, and shows the recording until it ends', async () => {
    const { control, connection, settle, finds, logs } = await enrolSetup(0);

    expect(finds()).toBe(0);
    expect(control.enrollment()).toEqual({ state: 'idle', endsAt: null, error: null, enrolledAt: '2026-11-20T10:00:00.000Z' });
    expect(control.enroll('start')).toBeNull();
    expect(control.enrollment().state).toBe('starting');
    await settle();
    expect(finds()).toBe(1);
    expect(connection.sent.filter((one) => one.type === 'enroll')).toEqual([{ type: 'enroll', action: 'start' }]);
    connection.receive({ type: 'enrollment', state: 'recording', error: null });
    expect(control.enrollment()).toMatchObject({ state: 'recording', endsAt: 61_000 });
    // A second start while recording changes nothing.
    expect(control.enroll('start')).toBeNull();
    expect(connection.sent.filter((one) => one.type === 'enroll')).toHaveLength(1);
    control.enroll('cancel');
    expect(connection.sent.at(-1)).toEqual({ type: 'enroll', action: 'cancel' });
    connection.receive({ type: 'enrollment', state: 'cancelled', error: null });
    expect(control.enrollment()).toMatchObject({ state: 'cancelled', endsAt: null });
    connection.receive({ type: 'enrollment', state: 'failed', error: 'The recording was too short: speak for at least 9 seconds.' });
    expect(control.enrollment()).toMatchObject({ state: 'failed', error: 'The recording was too short: speak for at least 9 seconds.' });
    expect(logs).toContain('voice: enrolment failed: The recording was too short: speak for at least 9 seconds.');
  });

  it('refuses an enrolment with voice off, cancels one still starting, fails one whose process cannot start, and cancels one when voice is turned off', async () => {
    const off = await enrolSetup(1);

    off.settings.enabled = false;
    expect(off.control.enroll('start')).toBe('Voice is off (voice.enabled).');
    off.settings.enabled = true;

    const starting = await enrolSetup(0);

    starting.fail('The voice process is not installed.');
    starting.control.enroll('start');
    starting.control.enroll('cancel');
    expect(starting.control.enrollment().state).toBe('cancelled');

    const failing = await enrolSetup(0);

    failing.fail('The voice process is not installed.');
    failing.control.enroll('start');
    await failing.settle();
    expect(failing.control.enrollment()).toMatchObject({ state: 'failed', error: 'The voice process is not installed.' });

    const connected = await enrolSetup(1);

    connected.control.enroll('start');
    connected.control.enroll('cancel');
    expect(connected.connection.sent.filter((one) => one.type === 'enroll')).toEqual([
      { type: 'enroll', action: 'start' },
      { type: 'enroll', action: 'cancel' },
    ]);
    connected.connection.receive({ type: 'enrollment', state: 'recording', error: null });
    connected.connection.receive({ type: 'enrollment', state: 'cancelled', error: null });
    expect(connected.control.enrollment().state).toBe('cancelled');

    const running = await enrolSetup(1);

    running.control.enroll('start');
    expect(running.connection.sent.at(-1)).toEqual({ type: 'enroll', action: 'start' });
    running.connection.receive({ type: 'enrollment', state: 'recording', error: null });
    running.settings.enabled = false;
    running.control.settingsChanged();
    expect(running.connection.sent.filter((one) => one.type === 'enroll').at(-1)).toEqual({ type: 'enroll', action: 'cancel' });
    expect(running.docks()).toBeGreaterThan(0);
  });
  it('keeps a spoken turn in the draft during a room hold, says so in its window and the mic, sends no [partial], and holds it after the hold until sent or emptied', async () => {
    const { control, connection, notified, dictated, busy, piece, end, fragments, advance } = await setup();
    const audio = (roomHold?: number): void => connection.receive({ type: 'audio', mic: 'hearing', engine: 'decibri', device: null, recognizer: null, error: null, ...(roomHold === undefined ? {} : { roomHold }) });

    control.composer('k1', false, '');
    audio(Date.UTC(2026, 10, 20, 12, 1));
    expect(control.view('k1')).toMatchObject({ here: true, roomHold: true });
    expect(control.view('k2')).not.toHaveProperty('roomHold');
    busy.add('s1');
    piece('honey the oven');
    piece('is on');
    advance(FRAGMENT_FLUSH_MS + 1_000);
    expect(dictated).toEqual([]);
    end();
    expect(dictated).toEqual([]);
    expect(events(notified, 'held')).toEqual([['k1', { sessionId: 's1', note: HELD_NOTE }]]);
    expect(events(notified, 'draft').at(-1)).toEqual(['k1', { text: 'honey the oven is on', sessionId: 's1' }]);
    expect(fragments().filter((one) => one.event === 'held').map((one) => one.text)).toEqual(['honey the oven', 'is on']);

    // The hold lapses: a later turn joins the held draft, which still waits for Enter.
    audio();
    expect(control.view('k1')).not.toHaveProperty('roomHold');
    piece('run the tests', 'u2');
    end(true, 'u2');
    expect(dictated).toEqual([]);
    expect(events(notified, 'held').at(-1)).toEqual(['k1', { sessionId: 's1', note: HELD_AFTER_NOTE }]);
    expect(control.take('k1', 's1')?.pieces ?? null).toHaveLength(3);

    // Sent by Enter, the draft is free again: the next turn sends on its own.
    piece('and lint', 'u3');
    end(true, 'u3');
    expect(dictated.map((one) => one.text)).toEqual(['and lint']);
  });

  it("holds a turn that ends during a room hold while a listening composer has the focus, so leaving the box does not send it with the next turn", async () => {
    const { control, connection, notified, dictated, piece, end } = await setup();

    control.composer('k1', true, '', true);
    connection.receive({ type: 'audio', mic: 'hearing', engine: 'decibri', device: null, recognizer: null, error: null, roomHold: Date.UTC(2026, 10, 20, 12, 1) });
    piece('not for you');
    end();
    expect(events(notified, 'held')).toEqual([['k1', { sessionId: 's1', note: HELD_NOTE }]]);
    connection.receive({ type: 'audio', mic: 'hearing', engine: 'decibri', device: null, recognizer: null, error: null });
    control.composer('k1', false, 'not for you', true);
    piece('fix it', 'u2');
    end(true, 'u2');
    expect(dictated).toEqual([]);
  });

  it('logs a spoken command in the hub log and the fragments log, and sends it nowhere', async () => {
    const { connection, notified, dictated, fragments } = await setup();
    const sent = notified.length;

    connection.receive({ type: 'command', command: 'stop-listening', text: 'stop listening', sessionId: 's1', utteranceId: 'u1', score: 0.8, f0: 110 });
    connection.receive({ type: 'command', command: 'start-listening', text: 'start listening', sessionId: null, utteranceId: null, score: null, f0: null });
    expect(dictated).toEqual([]);
    expect(notified.slice(sent)).toEqual([]);
    expect(fragments()).toEqual([
      expect.objectContaining({ event: 'command', sessionId: 's1', utteranceId: 'u1', text: 'stop listening', score: 0.8, f0: 110 }),
      expect.objectContaining({ event: 'command', sessionId: '', utteranceId: null, text: 'start listening' }),
    ]);
  });

  it('frees a held draft the operator empties, and drops a held turn for a terminal', async () => {
    const { control, connection, dictated, piece, end, focus } = await setup();

    control.composer('k1', false, '');
    connection.receive({ type: 'audio', mic: 'hearing', engine: 'decibri', device: null, recognizer: null, error: null, roomHold: Date.UTC(2026, 10, 20, 12, 1) });
    piece('not for you');
    end();
    connection.receive({ type: 'audio', mic: 'hearing', engine: 'decibri', device: null, recognizer: null, error: null });
    control.composer('k1', false, '');
    piece('fix it', 'u2');
    end(true, 'u2');
    expect(dictated.map((one) => one.text)).toEqual(['fix it']);

    // An expired hold the process has not ended yet holds nothing.
    connection.receive({ type: 'audio', mic: 'hearing', engine: 'decibri', device: null, recognizer: null, error: null, roomHold: Date.UTC(2026, 10, 20, 11) });
    expect(control.view('k1')).not.toHaveProperty('roomHold');
  });
});
