import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core';
import type { HubMessage, VoiceMessage } from '@switchboard/voice';
import { PHONE_HAS_VOICE, PHONE_MIC_FRAME, PHONE_MIC_HERE, PHONE_PCM_FRAME, VOICE_RESTART_MS, VoiceControl } from '../src/voice.js';
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

  send(message: HubMessage): void {
    this.sent.push(message);
  }

  close(): void {}

  receive(message: VoiceMessage): void {
    this.#message(message);
  }

  drop(): void {
    this.#close(new Error('gone'));
  }
}

const scope = (key: string, workItemId: number, sessionId: string | null): WindowScope => ({ kind: 'item', key, folder: 'D:/w', title: 't', scopeGen: 1, conversations: [{ workItemId, primary: true }], workItemId, cwd: 'D:/w', sessionId });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const connections: FakeConnection[] = [];
  const windows = new Map<string, WindowScope>([
    ['pc', scope('pc', 1, 's1')],
    ['phone', scope('phone', 2, 's2')],
    ['tablet', scope('tablet', 2, 's2')],
  ]);
  const focusedPages = new Set<string>();
  let focused: string | null = 'pc';
  const toPhone: Array<Record<string, unknown> | Buffer> = [];
  const closed: string[] = [];
  const logs: string[] = [];
  let t = 1_000;
  const timers: Array<{ run: () => void; at: number; cleared: boolean }> = [];
  const control = new VoiceControl({
    link: {
      find: async () => {
        const next = new FakeConnection();

        connections.push(next);
        return next;
      },
      connected: () => connections.at(-1) ?? null,
      stop: () => undefined,
    },
    settings: () => ({ ...DEFAULT_SETTINGS.voice, enabled: true }),
    store: { reply: () => null, updateReply: () => undefined, message: () => null, markSeen: () => undefined },
    windows: { keys: () => [...windows.keys()], scope: (key) => windows.get(key) ?? null },
    focusedWindow: () => focused,
    pageFocused: (key) => focusedPages.has(key),
    remotePage: (key) => key === 'phone' || key === 'tablet',
    full: (sessionId) => ['s1', 's2'].includes(sessionId),
    replyChanged: () => undefined,
    notify: () => undefined,
    dockChanged: () => undefined,
    now: () => t,
    log: (line) => void logs.push(line),
    setTimer: (run, ms) => {
      const timer = { run, at: t + ms, cleared: false };

      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => void ((timer as { cleared: boolean }).cleared = true),
    phone: {
      send: (message) => toPhone.push(message) > 0,
      sendBinary: (data) => toPhone.push(data) > 0,
      close: (reason) => void closed.push(reason),
    },
  });
  const sentOf = <T extends HubMessage['type']>(type: T) => connections.at(-1)!.sent.filter((one) => one.type === type) as Array<Extract<HubMessage, { type: T }>>;

  /** The voice process stops and is started again a minute later. */
  const restart = async (): Promise<void> => {
    connections.at(-1)!.drop();
    t += VOICE_RESTART_MS;

    for (const timer of timers.filter((one) => !one.cleared && one.at <= t)) {
      timer.cleared = true;
      timer.run();
    }

    await settle();
  };

  return { control, connections, windows, focusedPages, focus: (key: string | null) => (focused = key), toPhone, closed, logs, sentOf, restart };
}

describe('VoiceControl with the voice on a phone (PRD R119)', () => {
  it('moves the voice to the phone and its conversation on its tap, and follows only the phone page\'s focus while it is there', async () => {
    const { control, connections, focusedPages, focus, sentOf, logs, restart } = setup();

    control.update();
    await settle();
    control.phoneOpened('phone');
    expect(control.device).toBe('phone');
    expect(sentOf('device')).toEqual([{ type: 'device', device: 'phone' }]);
    expect(sentOf('talk-here')).toEqual([{ type: 'talk-here', sessionId: 's2' }]);
    expect(logs).toContain('voice: device phone: a paired phone took the voice');

    // This computer's focused window is no focus while the phone has the voice; the phone page's own is.
    expect(sentOf('targets').at(-1)!.focus).toBeNull();
    focusedPages.add('phone');
    control.update();
    expect(sentOf('targets').at(-1)!.focus).toEqual({ sessionId: 's2', via: 'window' });
    focus('pc');
    control.terminalFocused('s1', 2_000);
    expect(sentOf('targets').at(-1)!.focus).toEqual({ sessionId: 's2', via: 'window' });

    // A dock click and a selection in a window on this computer leave it on the phone.
    expect(control.dockSelect(1)).toBe(PHONE_HAS_VOICE);
    control.selected('pc');
    expect(sentOf('talk-here')).toHaveLength(1);

    // A voice process started again is told where the voice is.
    await restart();
    expect(connections).toHaveLength(2);
    expect(connections[1]!.sent.slice(0, 2)).toEqual([{ type: 'settings', settings: { ...DEFAULT_SETTINGS.voice, enabled: true } }, { type: 'device', device: 'phone' }]);
  });

  it('relays playbacks to the phone as control messages and binary PCM frames, and the phone\'s reports back', async () => {
    const { control, connections, toPhone, sentOf } = setup();

    control.update();
    await settle();

    // Nothing goes to a phone that does not have the voice.
    connections[0]!.receive({ type: 'phone-play', id: 1 });
    expect(toPhone).toEqual([]);

    control.phoneOpened('phone');
    connections[0]!.receive({ type: 'phone-play', id: 7 });
    connections[0]!.receive({ type: 'phone-pcm', id: 7, pcm: Buffer.from([1, 2, 3, 4]).toString('base64') });
    connections[0]!.receive({ type: 'phone-end', id: 7 });
    connections[0]!.receive({ type: 'phone-flush', id: 7 });
    expect(toPhone).toEqual([{ type: 'play', id: 7 }, Buffer.from([PHONE_PCM_FRAME, 7, 0, 0, 0, 1, 2, 3, 4]), { type: 'end', id: 7 }, { type: 'flush', id: 7 }]);

    control.phoneMessage({ type: 'played', id: 7, ms: 120, done: false });
    // Malformed reports are dropped.
    control.phoneMessage({ type: 'played', id: -1, ms: 1, done: false });
    control.phoneMessage({ type: 'played', id: 7, ms: Number.NaN, done: false });
    control.phoneMessage({ type: 'played', id: 7, ms: 1 });
    control.phoneMessage({ type: 'other', id: 7, ms: 1, done: true });
    expect(sentOf('phone-played')).toEqual([{ type: 'phone-played', id: 7, ms: 120, done: false }]);
  });

  it('leaves the voice off when the phone leaves, and takes it back to this computer only by Talk here or the mic there', async () => {
    const { control, connections, toPhone, closed, sentOf, restart } = setup();

    control.update();
    await settle();
    expect(control.mic('pc', true)).toBeNull();
    control.phoneOpened('phone');
    expect(control.mic('phone', true)).toBeNull();
    expect(sentOf('mic').at(-1)).toEqual({ type: 'mic', on: true });
    control.phoneClosed('closed by the page');
    expect(control.device).toBe('none');
    expect(sentOf('device').at(-1)).toEqual({ type: 'device', device: 'none' });
    // The mic stays off for a voice process started later.
    await restart();
    expect(connections[1]!.sent.filter((one) => one.type === 'mic')).toEqual([]);
    expect(connections[1]!.sent.filter((one) => one.type === 'device')).toEqual([{ type: 'device', device: 'none' }]);
    // A late playback goes nowhere.
    connections[1]!.receive({ type: 'phone-play', id: 2 });
    expect(toPhone).toEqual([]);

    // Talk here on this computer brings it back.
    expect(control.talkHere('pc')).toBeNull();
    expect(control.device).toBe('computer');
    expect(sentOf('device').at(-1)).toEqual({ type: 'device', device: 'computer' });
    expect(closed).toEqual([]);

    // From the phone, Talk here on this computer closes the phone's socket with why.
    control.phoneOpened('phone');
    expect(control.mic('pc', true)).toBeNull();
    expect(control.device).toBe('computer');
    expect(closed).toEqual(['Voice moved to the computer.']);
    // The socket's close that follows changes nothing.
    control.phoneClosed('Voice moved to the computer.');
    expect(control.device).toBe('computer');
    // Talk here on the phone's own page keeps it there.
    control.phoneOpened('phone');
    control.talkHere('phone');
    expect(control.device).toBe('phone');
  });

  it('lets no other paired page take the voice, hands it over between phones, follows the phone page\'s own focus for a selection, and drops a stalled phone', async () => {
    const { control, connections, focusedPages, focus, sentOf, closed, logs } = setup();

    control.update();
    await settle();
    control.phoneOpened('phone');
    expect(control.talkHere('tablet')).toBe('The voice is on another device.');
    expect(control.device).toBe('phone');

    // A selection on the phone page moves the voice by the page's own focus, though a window on this computer was focused last.
    focus('pc');
    focusedPages.add('phone');
    const before = sentOf('talk-here').length;

    control.selected('phone');
    expect(sentOf('talk-here')).toHaveLength(before + 1);

    // Another phone taking over stops the first's playback first: none, then phone.
    control.phoneOpened('tablet');
    expect(sentOf('device').slice(-2)).toEqual([
      { type: 'device', device: 'none' },
      { type: 'device', device: 'phone' },
    ]);

    // The phone's reports go to the voice process only while a phone has the voice; a stall closes its socket.
    connections[0]!.receive({ type: 'phone-stalled', reason: 'The phone stopped playing the voice.' });
    expect(closed).toEqual(['The phone stopped playing the voice.']);
    expect(logs).toContain('voice: the phone stopped playing: The phone stopped playing the voice.');
    control.phoneClosed('The phone stopped playing the voice.');
    expect(control.device).toBe('none');
    control.phoneMessage({ type: 'played', id: 1, ms: 1, done: false });
    expect(sentOf('phone-played')).toEqual([]);
    // With none, a paired page still cannot bring the voice to this computer.
    expect(control.talkHere('phone')).toBe('Tap Voice on this phone to use the voice here.');
    expect(control.device).toBe('none');
  });

  it('relays the phone\'s microphone only while the voice process has its capture open, and its busy state, and keeps both for a restarted process', async () => {
    const { control, connections, toPhone, sentOf, restart } = setup();
    const frame = (...bytes: number[]) => Buffer.from([PHONE_MIC_FRAME, ...bytes]);

    control.update();
    await settle();
    // Before the phone has the voice, nothing of it is relayed.
    control.phoneAudio('phone', frame(1, 2));
    control.phoneMessage({ type: 'state', busy: false });
    connections[0]!.receive({ type: 'phone-capture', on: true });
    expect(sentOf('phone-mic')).toEqual([]);
    expect(sentOf('phone-state')).toEqual([]);
    expect(toPhone).toEqual([]);

    control.phoneOpened('phone');
    control.phoneMessage({ type: 'state', busy: false });
    control.phoneMessage({ type: 'state', busy: 'no' });
    expect(sentOf('phone-state')).toEqual([{ type: 'phone-state', busy: false }]);
    // Audio while capture is closed is dropped.
    control.phoneAudio('phone', frame(1, 2));
    expect(sentOf('phone-mic')).toEqual([]);

    connections[0]!.receive({ type: 'phone-capture', on: true });
    expect(toPhone.at(-1)).toEqual({ type: 'capture', on: true });
    control.phoneAudio('phone', frame(1, 2, 3, 4));
    // Another page's audio, another kind, half a sample or an empty frame are dropped.
    control.phoneAudio('tablet', frame(1, 2));
    control.phoneAudio('phone', Buffer.from([PHONE_PCM_FRAME, 1, 2]));
    control.phoneAudio('phone', frame(1, 2, 3));
    control.phoneAudio('phone', frame());
    expect(sentOf('phone-mic')).toEqual([{ type: 'phone-mic', pcm: Buffer.from([1, 2, 3, 4]).toString('base64') }]);

    // A restarted voice process is told the phone can be heard; the capture it had is closed on the phone.
    await restart();
    expect(toPhone.at(-1)).toEqual({ type: 'capture', on: false });
    expect(connections[1]!.sent.filter((one) => one.type === 'phone-state')).toEqual([{ type: 'phone-state', busy: false }]);
    control.phoneAudio('phone', frame(1, 2));
    expect(connections[1]!.sent.filter((one) => one.type === 'phone-mic')).toEqual([]);

    connections[1]!.receive({ type: 'phone-capture', on: false });
    expect(toPhone.at(-1)).toEqual({ type: 'capture', on: false });
  });

  it('turns the mic on only on the device that has the voice, and off with every move', async () => {
    const { control, connections, sentOf } = setup();

    control.update();
    await settle();
    // A paired page never turns on this computer's microphone, nor the phone's before it has the voice.
    expect(control.mic('phone', true)).toBe(PHONE_MIC_HERE);
    expect(control.mic('tablet', true)).toBe(PHONE_MIC_HERE);
    expect(sentOf('mic')).toEqual([]);

    expect(control.mic('pc', true)).toBeNull();
    // The phone taking the voice turns the mic off: it must be turned on there.
    control.phoneOpened('phone');
    expect(control.mic('tablet', true)).toBe(PHONE_MIC_HERE);
    expect(control.mic('phone', true)).toBeNull();
    expect(sentOf('mic').at(-1)).toEqual({ type: 'mic', on: true });

    // Mic off from the phone page goes through, once the voice is there.
    connections[0]!.receive({ type: 'active', gen: 5, sessionId: 's2', reason: 'talk-here' });
    expect(control.mic('phone', false)).toBeNull();
    expect(sentOf('mic').at(-1)).toEqual({ type: 'mic', on: false });
    expect(control.mic('phone', true)).toBeNull();

    // Taken back by Talk here on this computer: the mic is off there until turned on.
    expect(control.talkHere('pc')).toBeNull();
    expect(control.device).toBe('computer');
    control.phoneAudio('phone', Buffer.from([PHONE_MIC_FRAME, 1, 2]));
    expect(sentOf('phone-mic')).toEqual([]);
  });
});
