import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core';
import type { HubMessage, VoiceMessage } from '@switchboard/voice';
import type { ConversationReply } from '@switchboard/core';
import { NOT_RESUMED, PHONE_HAS_VOICE, PHONE_MIC_FRAME, PHONE_MIC_HERE, PHONE_PCM_FRAME, PHONE_RESUME_MS, VOICE_RESTART_MS, VoiceControl, parseVoiceHandover } from '../src/voice.js';
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
    alertText: (sessionId) => ({ title: `Item of ${sessionId}`, detail: 'Done.' }),
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

  /** Runs the timers due after `ms`. */
  const advance = (ms: number): void => {
    t += ms;

    for (const timer of timers.filter((one) => !one.cleared && one.at <= t)) {
      timer.cleared = true;
      timer.run();
    }
  };

  return { control, connections, windows, focusedPages, focus: (key: string | null) => (focused = key), toPhone, closed, logs, sentOf, restart, advance };
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
    // What the phone's output took goes along for the voice's lead; a bad one is left out.
    control.phoneMessage({ type: 'played', id: 7, ms: 130, done: false, out: 430 });
    control.phoneMessage({ type: 'played', id: 7, ms: 140, done: false, out: -5 });
    expect(sentOf('phone-played')).toEqual([
      { type: 'phone-played', id: 7, ms: 120, done: false },
      { type: 'phone-played', id: 7, ms: 130, done: false, out: 430 },
      { type: 'phone-played', id: 7, ms: 140, done: false },
    ]);
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
    expect(closed).toEqual(['Voice is now on the computer running Switchboard.']);
    // The socket's close that follows changes nothing.
    control.phoneClosed('Voice is now on the computer running Switchboard.');
    expect(control.device).toBe('computer');
    // Talk here on the phone's own page keeps it there.
    control.phoneOpened('phone');
    control.talkHere('phone');
    expect(control.device).toBe('phone');
  });

  it('counts the phone lost only when the operator did not choose its leaving, and carries that over a hub restart', async () => {
    const { control, connections, logs } = setup();

    control.update();
    await settle();
    expect(control.phoneLost).toBe(false);

    // The socket closing with no word from the page, as a dropped connection: lost.
    control.phoneOpened('phone');
    control.phoneClosed('closed by the page');
    expect([control.device, control.phoneLost]).toEqual(['none', true]);
    expect(logs).toContain('voice: device none: the phone left unexpectedly: closed by the page');
    expect(parseVoiceHandover(control.handoverState())?.phoneLost).toBe(true);
    // Talk here on this computer ends it.
    expect(control.talkHere('pc')).toBeNull();
    expect(control.phoneLost).toBe(false);

    // Voice off on the phone: its page says it leaves before the socket closes.
    control.phoneOpened('phone');
    control.phoneMessage({ type: 'leave' });
    control.phoneClosed('closed by the page');
    expect([control.device, control.phoneLost]).toEqual(['none', false]);
    expect(logs).toContain('voice: device none: the phone left: closed by the page');
    expect(control.handoverState()).not.toHaveProperty('phoneLost');

    // A page hidden when its socket closes, as when the app is closed; a page shown again counts as before.
    control.phoneOpened('phone');
    control.phoneMessage({ type: 'visibility', hidden: true });
    control.phoneClosed('closed by the page');
    expect(control.phoneLost).toBe(false);
    control.phoneOpened('phone');
    control.phoneMessage({ type: 'visibility', hidden: true });
    control.phoneMessage({ type: 'visibility', hidden: false });
    control.phoneClosed('The page stopped answering.');
    expect(control.phoneLost).toBe(true);

    // The hub's own refusal (a sign-out, a forbidden device, voice turned off, the page closed) is the operator's choice.
    control.phoneOpened('phone');
    control.phoneClosed('This device was signed out.', true);
    expect(control.phoneLost).toBe(false);

    // A stalled phone is closed by the hub with its refusal code, yet lost.
    control.phoneOpened('phone');
    connections[0]!.receive({ type: 'phone-stalled', reason: 'Voice stopped because playback on this device stopped progressing.' });
    control.phoneClosed('Voice stopped because playback on this device stopped progressing.', true);
    expect(control.phoneLost).toBe(true);

    // A leave from a page that does not hold the voice changes nothing.
    control.phoneMessage({ type: 'leave' });
    expect(control.phoneLost).toBe(true);

    // Another phone taking the voice over is no loss.
    control.phoneOpened('phone');
    control.phoneOpened('tablet', 'tablet-hash');
    expect([control.device, control.phoneLost]).toEqual(['phone', false]);

    // A hub that took over: a phone that does not come back in time is lost; a handed-over loss stays one, a chosen leave does not.
    const handed = control.handoverState();
    const next = setup();

    next.control.restore(handed);
    next.control.update();
    await settle();
    expect([next.control.device, next.control.phoneLost]).toEqual(['phone', false]);
    next.advance(PHONE_RESUME_MS);
    expect([next.control.device, next.control.phoneLost]).toEqual(['none', true]);

    const lost = setup();

    lost.control.restore({ ...handed, device: 'none', phoneHash: null, phoneLost: true });
    expect([lost.control.device, lost.control.phoneLost]).toEqual(['none', true]);

    const left = setup();

    left.control.restore({ ...handed, device: 'none', phoneHash: null });
    expect([left.control.device, left.control.phoneLost]).toEqual(['none', false]);
  });

  it('lets no other paired page take the voice, hands it over between phones, follows the phone page\'s own focus for a selection, and drops a stalled phone', async () => {
    const { control, connections, focusedPages, focus, sentOf, closed, logs } = setup();

    control.update();
    await settle();
    control.phoneOpened('phone');
    expect(control.talkHere('tablet')).toBe('Voice is on another device.');
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
    connections[0]!.receive({ type: 'phone-stalled', reason: 'Voice stopped because playback on this device stopped progressing.' });
    expect(closed).toEqual(['Voice stopped because playback on this device stopped progressing.']);
    expect(logs).toContain('voice: the phone stopped playing: Voice stopped because playback on this device stopped progressing.');
    control.phoneClosed('Voice stopped because playback on this device stopped progressing.');
    expect(control.device).toBe('none');
    control.phoneMessage({ type: 'played', id: 1, ms: 1, done: false });
    expect(sentOf('phone-played')).toEqual([]);
    // With none, a paired page still cannot bring the voice to this computer.
    expect(control.talkHere('phone')).toBe('Select Voice on this device to start voice here.');
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

  it('alerts and plays the needs-you sound on the phone only while its page is in front, by the phone page\'s focus, not this computer\'s', async () => {
    const { control, focusedPages, focus, sentOf, advance } = setup();
    const run = (kinds: Record<string, 'running' | 'idle'>) => control.sessionsChanged(Object.entries(kinds).map(([sessionId, kind]) => ({ sessionId, workItemId: Number(sessionId.slice(1)), kind })));

    control.update();
    await settle();
    control.phoneOpened('phone');
    // This computer's window shows s1; the phone page shows s2 and is hidden.
    focus('pc');
    run({ s1: 'running', s2: 'running', s3: 'running' });
    expect(run({ s1: 'idle', s2: 'running', s3: 'running' })).toEqual([]);
    expect(control.needsYou([1], null)).toBe(false);
    advance(60_000);
    expect(sentOf('alert')).toEqual([]);
    expect(sentOf('earcon')).toEqual([]);

    // In front, the phone hears them; this computer's focused window does not keep s1's alert back.
    focusedPages.add('phone');
    run({ s1: 'running', s2: 'running', s3: 'running' });
    expect(run({ s1: 'idle', s2: 'idle', s3: 'running' })).toEqual([1]);
    advance(60_000);
    expect(sentOf('alert').map((one) => one.sessionId)).toEqual(['s1']);
    expect(control.needsYou([1], null)).toBe(true);

    // An alert waiting when the phone page goes behind is not sent.
    run({ s1: 'running', s2: 'idle', s3: 'running' });
    run({ s1: 'running', s2: 'idle', s3: 'idle' });
    focusedPages.delete('phone');
    advance(60_000);
    expect(sentOf('alert').map((one) => one.sessionId)).toEqual(['s1']);

    // A hidden phone page does not sound the needs-you message in the voice's place, nor does another page in front.
    expect(control.pageMaySound('phone')).toBe(false);
    focusedPages.add('tablet');
    focusedPages.add('pc');
    expect(control.pageMaySound('tablet')).toBe(false);
    expect(control.pageMaySound('pc')).toBe(false);
    focusedPages.add('phone');
    expect(control.pageMaySound('phone')).toBe(true);
    focusedPages.delete('phone');

    // With no device after the phone left, nothing is alerted.
    control.phoneClosed('closed by the page');
    focusedPages.add('phone');
    expect(control.needsYou([1], null)).toBe(false);
    expect(control.pageMaySound('pc')).toBe(false);
    focusedPages.delete('phone');
    expect(control.pageMaySound('phone')).toBe(false);
  });

  it('shows the voice off only on this computer after the phone left, and lets no message typed on a paired page take it back', async () => {
    const { control, connections, sentOf } = setup();

    control.update();
    await settle();
    control.phoneOpened('phone');
    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's2', reason: 'talk-here' });
    expect(control.view('phone').deviceOff).toBeUndefined();
    control.phoneClosed('closed by the page');

    // The phone's page is told nothing of this computer's voice; a message typed there leaves the voice off.
    expect(control.view('phone')).toMatchObject({ here: true });
    expect(control.view('phone').deviceOff).toBeUndefined();
    expect(control.spokenFor('s2', false, 'phone').spoken).toBe(true);
    expect(control.device).toBe('none');
    expect(sentOf('device').at(-1)).toEqual({ type: 'device', device: 'none' });

    // A window on this computer showing the target says the voice is off.
    connections[0]!.receive({ type: 'active', gen: 2, sessionId: 's1', reason: 'talk-here' });
    expect(control.view('pc')).toMatchObject({ here: true, deviceOff: true });
  });

  it('keeps the voice off when a hub started again finds the voice process still on the phone, whose socket closed with the old hub', async () => {
    const { control, connections, sentOf, logs, closed } = setup();

    control.update();
    await settle();
    connections[0]!.receive({ type: 'device', device: 'phone' });
    expect(control.device).toBe('none');
    expect(sentOf('device')).toEqual([{ type: 'device', device: 'none' }]);
    expect(logs).toContain('voice: device none: the voice process had the phone when the hub connected');
    expect(closed).toEqual([]);
    // The phone's socket closed with the hub that stopped: lost. A process that had none was off already, maybe by the operator's choice.
    expect(control.phoneLost).toBe(true);

    const fresh = setup();

    fresh.control.update();
    await settle();
    fresh.connections[0]!.receive({ type: 'device', device: 'none' });
    expect([fresh.control.device, fresh.control.phoneLost]).toEqual(['none', false]);

    // A phone that took the voice in this hub is not moved by the greeting of a process that reconnects.
    control.phoneOpened('phone');
    connections[0]!.receive({ type: 'device', device: 'none' });
    expect(control.device).toBe('phone');
  });

  it('takes the voice back to this computer with Voice on the computer, only from this computer\'s page', async () => {
    const { control, closed, sentOf } = setup();

    control.update();
    await settle();
    expect(control.toComputer('pc')).toBe('The voice is already on this computer.');
    // On this computer any page may sound, focused or not.
    expect(control.pageMaySound('pc')).toBe(true);
    control.phoneOpened('phone');
    expect(control.toComputer('phone')).toBe('Select Voice on the computer on the computer running Switchboard.');
    expect(control.device).toBe('phone');
    expect(control.toComputer('pc')).toBeNull();
    expect(control.device).toBe('computer');
    expect(sentOf('device').at(-1)).toEqual({ type: 'device', device: 'computer' });
    expect(closed).toEqual(['Voice is now on the computer running Switchboard.']);

    // After the phone left, too.
    control.phoneOpened('phone');
    control.phoneClosed('closed by the page');
    expect(control.toComputer('pc')).toBeNull();
    expect(control.device).toBe('computer');
  });
});

/** One hub of a restart: its own connection to the voice process, windows and pages, and replies; the voice process outlives it. */
function hubOf(windowList: WindowScope[], remote: string[]) {
  const connections: FakeConnection[] = [];
  const windows = new Map(windowList.map((one) => [one.key, one]));
  const focusedPages = new Set<string>();
  const replies = new Map<string, ConversationReply>();
  const toPhone: Array<Record<string, unknown> | Buffer> = [];
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
    store: { reply: (id) => replies.get(id) ?? null, updateReply: () => undefined, message: () => ({ spokenRequested: true }), markSeen: () => undefined },
    windows: { keys: () => [...windows.keys()], scope: (key) => windows.get(key) ?? null },
    focusedWindow: () => 'pc',
    pageFocused: (key) => focusedPages.has(key),
    remotePage: (key) => remote.includes(key),
    repliesSince: (sessionId, since) => [...replies.values()].filter((one) => one.sessionId === sessionId && one.at >= since),
    full: (sessionId) => ['s1', 's2'].includes(sessionId),
    session: (sessionId) => ({ workItemId: sessionId === 's1' ? 1 : 2, cwd: null }),
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
      close: () => undefined,
    },
  });
  const sentOf = <T extends HubMessage['type']>(type: T) => connections.at(-1)!.sent.filter((one) => one.type === type) as Array<Extract<HubMessage, { type: T }>>;
  const reply = (id: string, sessionId: string): ConversationReply => {
    const one = { id, sessionId, kind: 'reply', source: 'transcript', speak: 'Done.', opening: 'Done.', answers: `m-${id}`, rewrittenBy: null, withdrawn: false, spokenState: 'none', tone: null, at: t } as unknown as ConversationReply;

    replies.set(id, one);
    return one;
  };
  const advance = (ms: number): void => {
    t += ms;

    for (const timer of timers.filter((one) => !one.cleared && one.at <= t)) {
      timer.cleared = true;
      timer.run();
    }
  };

  return { control, connections, windows, focusedPages, toPhone, logs, sentOf, reply, advance };
}

/** What the voice process tells a hub that connects: its target, its capture and its device, which it kept while no hub was connected. */
function greet(connection: FakeConnection, gen: number, sessionId: string | null, device: 'computer' | 'phone' | 'none'): void {
  connection.receive({ type: 'active', gen, sessionId, reason: sessionId === null ? 'gone' : 'focus' });
  connection.receive({ type: 'audio', mic: 'listening', engine: 'phone', device: 'phone', recognizer: 'gpu', error: null });
  connection.receive({ type: 'device', device });
}

describe('VoiceControl across a hub restart with the voice on a phone (architecture.md § Hub lifecycle)', () => {
  /** A hub whose phone has the voice, the mic on and the phone's capture open, for session s2 at generation 5; and what it hands over. */
  async function handedOver() {
    const old = hubOf([scope('pc', 1, 's1'), scope('phone', 2, 's2')], ['phone']);

    old.control.update();
    await settle();
    old.control.phoneOpened('phone', 'hash-1');
    old.connections[0]!.receive({ type: 'active', gen: 5, sessionId: 's2', reason: 'talk-here' });
    expect(old.control.mic('phone', true)).toBeNull();
    old.connections[0]!.receive({ type: 'phone-capture', on: true });
    old.connections[0]!.receive({ type: 'audio', mic: 'listening', engine: 'phone', device: 'phone', recognizer: 'gpu', error: null });
    old.control.phoneMessage({ type: 'state', busy: false });

    return { old, handed: JSON.parse(JSON.stringify(old.control.handOver())) as unknown };
  }

  it('hands over the device, sign-in, target, mic and Speak replies, then sends the voice process nothing as its phone socket and windows close', async () => {
    const { old, handed } = await handedOver();
    const sent = old.connections[0]!.sent.length;

    expect(handed).toEqual({ device: 'phone', phoneHash: 'hash-1', target: { gen: 5, sessionId: 's2' }, speakReplies: true, micOn: true, mic: 'listening', phoneCapture: true, phoneBusy: false, at: 1_000, held: [] });
    expect(parseVoiceHandover(handed)).toEqual(handed);

    // The old hub stops: its phone socket closes and its windows leave, which before the fix told the voice process the phone left.
    old.control.phoneClosed('Switchboard is restarting.');
    old.windows.clear();
    old.control.windowClosed('pc');
    old.control.windowClosed('phone');
    old.control.close();
    expect(old.connections[0]!.sent).toHaveLength(sent);
    expect(old.connections).toHaveLength(1);
    expect(old.control.device).toBe('phone');
    expect(old.logs.filter((line) => line.includes('the phone left'))).toEqual([]);
    expect(old.control.resumable('hash-1')).toBe(NOT_RESUMED);
  });

  it('keeps the voice on the phone through the restart, moves nothing to this computer meanwhile, and lets the phone take it back without a tap', async () => {
    const { handed } = await handedOver();
    // The hub that takes over: this computer's window comes back focused at once; the phone's page comes back later with a new key.
    const next = hubOf([scope('pc', 1, 's1')], ['phone-2']);

    next.control.restore(handed);
    expect(next.logs).toContain(`voice: device phone: waiting up to ${PHONE_RESUME_MS / 1000} seconds for the phone to take the voice back after the hub restart`);
    await settle();
    greet(next.connections[0]!, 5, 's2', 'phone');
    next.control.update();

    // Nothing moves the voice: the device the process kept stands, the target stays one though nothing shows it, and the focused window is no focus.
    expect(next.control.device).toBe('phone');
    expect(next.sentOf('device')).toEqual([{ type: 'device', device: 'phone' }]);
    expect(next.sentOf('targets').at(-1)).toEqual({ type: 'targets', targets: [{ sessionId: 's1', workItemId: 1, repo: null }, { sessionId: 's2', workItemId: 2, repo: null }], focus: null });
    next.control.selected('pc');
    expect(next.sentOf('talk-here')).toEqual([]);
    expect(next.sentOf('mic')).toEqual([{ type: 'mic', on: true, restore: true }]);
    expect(next.control.target).toBe('s2');
    expect(next.control.view('pc').deviceOff).toBeUndefined();
    expect(next.control.restartBlocker()).toBe('the phone has not taken the voice back since the last restart');
    expect(next.control.resumable('hash-2')).toBe(NOT_RESUMED);
    expect(next.control.resumable('hash-1')).toBeNull();

    // A reply that asked to be heard meanwhile waits for the phone rather than play to nobody.
    next.control.replyChanged(next.reply('r1', 's2'));
    expect(next.sentOf('speak')).toEqual([]);

    // The phone's page is back with a new key and opens the voice socket again from the same sign-in.
    next.windows.set('phone-2', scope('phone-2', 2, 's2'));
    next.focusedPages.add('phone-2');
    next.control.phoneOpened('phone-2', 'hash-1');
    expect(next.logs).toContain('voice: device phone: the phone took the voice back after the hub restart');
    expect(next.toPhone).toEqual([{ type: 'capture', on: true }]);
    expect(next.sentOf('device')).toHaveLength(1);
    expect(next.sentOf('mic')).toHaveLength(1);
    expect(next.sentOf('talk-here')).toEqual([]);
    expect(next.sentOf('speak').map((one) => [one.replyId, one.gen])).toEqual([['r1', 5]]);
    expect(next.sentOf('targets').at(-1)!.focus).toEqual({ sessionId: 's2', via: 'window' });
    expect(next.control.micLive).toBe(true);
    expect(next.control.view('phone-2')).toMatchObject({ here: true, mic: 'listening' });

    // The phone's audio is relayed again, as the voice process still has its capture open.
    next.control.phoneAudio('phone-2', Buffer.from([PHONE_MIC_FRAME, 1, 0]));
    expect(next.sentOf('phone-mic')).toHaveLength(1);

    // The wait is over: its end changes nothing.
    next.advance(PHONE_RESUME_MS);
    expect(next.control.device).toBe('phone');
    expect(next.control.resumable('hash-1')).toBe(NOT_RESUMED);
  });

  it('keeps the target while the phone is back before its page shows a conversation, and offers the replies that came while the hubs changed over', async () => {
    const { handed } = await handedOver();
    const next = hubOf([scope('pc', 1, 's1')], ['phone-2']);

    // A reply the hub before saw too late to offer, and one that comes before this hub has its voice process.
    next.reply('r0', 's2');
    next.control.restore(handed);
    next.control.replyChanged(next.reply('r1', 's2'));
    await settle();
    greet(next.connections[0]!, 5, 's2', 'phone');
    expect(next.sentOf('speak')).toEqual([]);

    // The phone's page is back, its stream not yet showing a conversation: the target stays one.
    next.windows.set('phone-2', scope('phone-2', 2, null));
    next.control.phoneOpened('phone-2', 'hash-1');
    next.control.update();
    expect(next.sentOf('targets').at(-1)!.targets.map((one) => one.sessionId)).toEqual(['s1', 's2']);
    expect(next.sentOf('talk-here')).toEqual([]);
    expect(next.sentOf('speak').map((one) => one.replyId).sort()).toEqual(['r0', 'r1']);

    // Once it shows its conversation, that is what keeps the target.
    next.windows.set('phone-2', scope('phone-2', 2, 's2'));
    next.control.update();
    expect(next.sentOf('targets').at(-1)!.targets.map((one) => one.sessionId)).toEqual(['s1', 's2']);
    next.windows.set('phone-2', scope('phone-2', 1, 's1'));
    next.control.update();
    expect(next.sentOf('targets').at(-1)!.targets.map((one) => one.sessionId)).toEqual(['s1']);
  });

  it('turns the voice off, never onto this computer, when the phone does not come back in time', async () => {
    const { handed } = await handedOver();
    // This computer has a window on the voice target's session too, which shows the voice off at the end.
    const next = hubOf([scope('pc', 1, 's1'), scope('pc-2', 2, 's2')], ['phone-2']);

    next.control.restore(handed);
    await settle();
    greet(next.connections[0]!, 5, 's2', 'phone');
    next.control.replyChanged(next.reply('r1', 's2'));
    next.advance(PHONE_RESUME_MS - 1);
    expect(next.control.device).toBe('phone');
    next.advance(1);
    expect(next.control.device).toBe('none');
    expect(next.logs).toContain(`voice: device none: the phone did not take the voice back within ${PHONE_RESUME_MS / 1000} seconds of the hub restart`);
    expect(next.sentOf('device').map((one) => one.device)).toEqual(['phone', 'none']);
    expect(next.control.view('pc-2')).toMatchObject({ here: true, deviceOff: true });
    expect(next.control.micLive).toBe(false);
    // The held reply goes to the voice process, which skips it with no device; the restart no longer waits.
    expect(next.sentOf('speak').map((one) => one.replyId)).toEqual(['r1']);
    expect(next.control.resumable('hash-1')).toBe(NOT_RESUMED);

    // A tap on the phone takes it as before.
    next.windows.set('phone-2', scope('phone-2', 2, 's2'));
    next.control.phoneOpened('phone-2', 'hash-1');
    expect(next.control.device).toBe('phone');
  });

  it('lets Talk here on this computer take the voice back during the wait, ending it, and keeps an unknown phone off', async () => {
    const { handed } = await handedOver();
    const next = hubOf([scope('pc', 1, 's1')], []);

    next.control.restore(handed);
    await settle();
    greet(next.connections[0]!, 5, 's2', 'phone');
    expect(next.control.talkHere('pc')).toBeNull();
    expect(next.control.device).toBe('computer');
    expect(next.control.resumable('hash-1')).toBe(NOT_RESUMED);
    next.advance(PHONE_RESUME_MS);
    expect(next.control.device).toBe('computer');

    // A phone whose sign-in the handover does not name, and a voice process replaced meanwhile that starts on this computer: the voice is off.
    const unknown = hubOf([scope('pc', 1, 's1')], []);

    unknown.control.restore({ ...(handed as Record<string, unknown>), phoneHash: null });
    await settle();
    greet(unknown.connections[0]!, 0, null, 'computer');
    expect(unknown.control.device).toBe('none');
    expect(unknown.sentOf('device').map((one) => one.device)).toEqual(['none', 'none']);
    expect(parseVoiceHandover({ device: 'phone' })).toBeNull();

    // On this computer, a reply that comes before the voice process connects waits for it without holding a restart back, and goes to the next hub.
    const computer = hubOf([scope('pc', 1, 's2')], []);

    computer.reply('r9', 's2');
    computer.control.restore({ ...(handed as Record<string, unknown>), device: 'computer', phoneHash: null, held: ['r9'] });
    computer.control.replyChanged(computer.reply('r1', 's2'));
    expect(computer.control.restartBlocker()).toBeNull();
    expect(computer.control.handoverState().held).toEqual(['r9', 'r1']);
    await settle();
    expect(computer.sentOf('speak').map((one) => one.replyId).sort()).toEqual(['r1', 'r9']);
    expect(computer.control.device).toBe('computer');
    expect(parseVoiceHandover(null)).toBeNull();
  });
});
