import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core';
import type { ConversationMessage, ConversationReply, Interruption, Piece, VoiceSettings } from '@switchboard/core';
import type { HubMessage, VoiceMessage } from '@switchboard/voice';
import { FRAGMENT_FLUSH_MS, VoiceControl } from '../src/voice.js';
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

const scope = (key: string, workItemId: number, sessionId: string | null, cwd = 'D:/w'): WindowScope => ({ kind: 'item', key, folder: 'D:/w', title: 't', scopeGen: 1, conversations: [{ workItemId, primary: true }], workItemId, cwd, sessionId });

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
    fragmentsDir: dir,
    replyChanged: () => undefined,
    notify: (key, type, payload) => void notified.push({ key, type, payload }),
    dockChanged: () => undefined,
    now: () => t,
    log: () => undefined,
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

  return { control, connection, windows, notified, dictated, busy, advance, settle, piece, end, fragments, refuse: (why: string | null) => (refuse = why), focus: (key: string | null) => (focused = key), setLastReply: (text: string) => (lastReply = text) };
}

const events = (notified: Array<{ key: string; type: string; payload: Record<string, unknown> }>, type: string) => notified.filter((one) => one.type === type).map((one) => [one.key, one.payload]);

describe('VoiceControl dictation', () => {
  it('turns the mic on in a window by moving the voice there, and refuses turning it off from a window it is not in', async () => {
    const { control, connection } = await setup();

    expect(control.mic('k2', true)).toBeNull();
    expect(connection.sent.slice(-2)).toEqual([
      { type: 'talk-here', sessionId: 's2' },
      { type: 'mic', on: true },
    ]);
    expect(control.mic('k2', false)).toBe('Voice is not in this window.');
    expect(control.mic('k1', false)).toBeNull();
    expect(connection.sent.at(-1)).toEqual({ type: 'mic', on: false });
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
    expect(control.dictated('k1', 's1')).toBeNull();
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
    expect(control.dictated('k1', 's1')).toMatchObject([{ text: 'rename it' }, { text: 'and more' }]);
    expect(control.dictated('k1', 's1')).toBeNull();
    control.composer('k1', false, 'x');
    control.composer('k1', false, ' ');
    expect(control.dictated('k1', 's1')).toBeNull();
    connection.receive({ type: 'words', gen: 0, utteranceId: 'u9', sessionId: 's1', text: 'old' });
    expect(events(notified, 'words')).toEqual([]);
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
    expect(control.dictated('k1', 's2')).toBeNull();
    windows.set('k1', scope('k1', 3, 's3'));
    control.composer('k1', false, '');
    expect(control.dictated('k1', 's3')).toBeNull();
    expect(control.dictated('k1', 's1')).toMatchObject([{ text: 'one' }, { text: 'two' }]);
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
    connection.receive({ type: 'audio', mic: 'listening', engine: 'decibri', device: null, recognizer: null, error: null });
    expect(control.view('k1')).not.toHaveProperty('halfDuplex');
    expect(notified.at(-1)).toMatchObject({ key: 'k1', type: 'voice' });
    expect(notified.at(-1)!.payload.voice).not.toHaveProperty('halfDuplex');
    control.replyChanged({ id: 'r1', sessionId: 's1', kind: 'reply', source: 'transcript', withdrawn: false, rewrittenBy: null, speak: null, spokenState: 'none', answers: null } as unknown as ConversationReply);
  });
  it('types dictation into the target\'s terminal while it is in front, with no window event, and drops a cut-off utterance there', async () => {
    const { control, connection, notified, dictated, piece, end, fragments, focus } = await setup();

    // The terminal of k1's session came to the front; VS Code reported its blur.
    focus(null);
    control.terminalFocused('s1', 1);
    expect(connection.sent.filter((one) => one.type === 'targets').at(-1)).toMatchObject({ focus: { sessionId: 's1', via: 'terminal' } });
    connection.receive({ type: 'words', gen: 1, utteranceId: 'u1', sessionId: 's1', text: 'run the' });
    piece('run the');
    piece('tests');
    end();
    expect(dictated).toEqual([{ key: null, sessionId: 's1', text: 'run the tests', partial: false, pieces: [expect.objectContaining({ text: 'run the' }), expect.objectContaining({ text: 'tests' })] }]);
    expect(notified.filter((one) => one.type !== 'voice')).toEqual([]);
    expect(fragments().map((one) => `${String(one.event)} ${String(one.text)}`)).toEqual(['heard run the', 'heard tests', 'submitted run the', 'submitted tests']);

    // Cut off: its words are not kept for the next utterance.
    piece('stale', 'u2');
    end(false, 'u2');
    piece('commit it', 'u3');
    end(true, 'u3');
    expect(dictated.map((one) => [one.key, one.text])).toEqual([
      [null, 'run the tests'],
      [null, 'commit it'],
    ]);
    // k1's own composer holds nothing of it.
    expect(control.dictated('k1', 's1')).toBeNull();
  });

  it('keeps dictating into the terminal with the focus in another app when no window shows the session, and into a window that shows it', async () => {
    const { control, windows, dictated, piece, end, focus } = await setup();

    focus(null);
    control.terminalFocused('s1', 1);
    control.terminalFocused(null, 1);
    // A window shows s1, so dictation goes to it, as in slice 10.
    piece('one');
    end();
    expect(dictated.at(-1)).toMatchObject({ key: 'k1', text: 'one' });

    // With k1 closed, the voice came to s1 from its terminal, so dictation goes there.
    windows.delete('k1');
    control.windowClosed('k1');
    piece('two', 'u2');
    end(true, 'u2');
    expect(dictated.at(-1)).toMatchObject({ key: null, text: 'two' });
  });

  it('drops the words heard for a terminal when the voice process stops, so the next utterance after its restart types only its own', async () => {
    const { control, connection, dictated, piece, end, focus, advance, settle } = await setup();

    focus(null);
    control.terminalFocused('s1', 1);
    piece('discard this');
    connection.drop();
    advance(60_000);
    await settle();
    connection.receive({ type: 'active', gen: 2, sessionId: 's1', reason: 'focus' });
    piece('run the tests', 'u2', 2);
    end(true, 'u2', 2);
    expect(dictated.map((one) => [one.key, one.text])).toEqual([[null, 'run the tests']]);
  });

  it('logs a refused terminal turn without sending a window anything', async () => {
    const { control, notified, piece, end, fragments, focus, refuse } = await setup();

    focus(null);
    control.terminalFocused('s1', 1);
    refuse('The session ended.');
    piece('hello');
    end();
    expect(notified.filter((one) => one.type !== 'voice')).toEqual([]);
    expect(fragments().filter((one) => one.event === 'refused')).toMatchObject([{ text: 'hello', error: 'The session ended.' }]);
  });

  it('sends the reply a spoken turn spoke over with its message, and keeps it with a draft left unsent until Enter sends it', async () => {
    const { control, dictated, piece, end } = await setup();
    const interrupted = { replyId: 'r1', said: 'The session token', rest: 'is refreshed in two places.' };

    control.composer('k1', false, '');
    piece('hold on');
    end(true, 'u1', 1, interrupted);
    expect(dictated).toEqual([{ key: 'k1', sessionId: 's1', text: 'hold on', partial: false, pieces: [expect.objectContaining({ text: 'hold on' })], interrupted }]);
    expect(control.interruption('k1', 's1')).toBeNull();

    // Cut short by the composer taking the focus: Enter sends it, naming the reply once.
    piece('wait', 'u2');
    control.composer('k1', true, 'wait');
    end(false, 'u2', 1, interrupted);
    expect(dictated).toHaveLength(1);
    expect(control.dictated('k1', 's1')).toMatchObject([{ text: 'wait' }]);
    expect(control.interruption('k1', 's1')).toEqual(interrupted);
    expect(control.interruption('k1', 's1')).toBeNull();

    // An emptied draft no longer names it; an utterance that kept nothing names nothing.
    piece('again', 'u3');
    end(false, 'u3', 1, interrupted);
    control.composer('k1', false, '');
    expect(control.interruption('k1', 's1')).toBeNull();
    end(false, 'u4', 1, interrupted);
    expect(control.interruption('k1', 's1')).toBeNull();
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
});
