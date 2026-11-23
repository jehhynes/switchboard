import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core';
import type { ConversationReply, Persona, VoiceSettings } from '@switchboard/core';
import type { HubMessage, VoiceMessage } from '@switchboard/voice';
import { ALERT_DELAY_MS, OPEN_ITS_WINDOW, SPEAKER_GLYPH, VOICE_GLYPH, VOICE_LINGER_MS, VOICE_RESTART_MS, VoiceControl, alertDetail, alertKind, speechOf, voiceMark } from '../src/voice.js';
import type { VoiceConnection } from '../src/voiceLink.js';
import type { WindowScope } from '../src/windows.js';

class FakeConnection implements VoiceConnection {
  readonly welcome = { protocol: 1, build: 'b', pid: 1 };
  readonly compatible = true;
  readonly sent: HubMessage[] = [];
  #message: (message: VoiceMessage) => void = () => undefined;
  #close: (error: Error) => void = () => undefined;
  closed = false;

  onMessage(listener: (message: VoiceMessage) => void): void {
    this.#message = listener;
  }

  onClose(listener: (error: Error) => void): void {
    this.#close = listener;
  }

  send(message: HubMessage): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  receive(message: VoiceMessage): void {
    this.#message(message);
  }

  drop(): void {
    this.#close(new Error('gone'));
  }
}

const scope = (key: string, workItemId: number, sessionId: string | null): WindowScope => ({ kind: 'item', key, folder: 'D:/w', title: 't', scopeGen: 1, conversations: [{ workItemId, primary: true }], workItemId, cwd: 'D:/w', sessionId });

function setup(patch: Partial<VoiceSettings> = { enabled: true }) {
  let settings: VoiceSettings = { ...DEFAULT_SETTINGS.voice, ...patch };
  let t = 1_000_000;
  const timers: Array<{ run: () => void; at: number; cleared: boolean }> = [];
  const connections: FakeConnection[] = [];
  let found: FakeConnection | { error: string } | null = null;
  let stops = 0;
  const replies = new Map<string, ConversationReply>();
  const messages = new Map<string, { spokenRequested?: boolean }>();
  const windows = new Map<string, WindowScope | null>();
  const full = new Set<string>(['s1', 's2']);
  const personas = new Map<string, Persona>();
  const notified: Array<{ key: string; type: string; payload: Record<string, unknown> }> = [];
  const changedReplies: string[] = [];
  const seen: string[] = [];
  let focused: string | null = null;
  let dockChanges = 0;
  const logs: string[] = [];
  const control = new VoiceControl({
    link: {
      find: async () => {
        const next = found ?? new FakeConnection();

        if (!('error' in next)) {
          connections.push(next);
        }

        return next;
      },
      connected: () => connections.at(-1) ?? null,
      stop: () => void stops++,
    },
    settings: () => settings,
    viewSettings: () => ({ briefReplies: settings.briefReplies, expandReplies: !settings.briefReplies, diffLayout: 'stacked', diffWrap: 'on' }),
    store: {
      reply: (id) => replies.get(id) ?? null,
      updateReply: (id, patch) => void replies.set(id, { ...replies.get(id)!, ...patch }),
      message: (id) => messages.get(id) ?? null,
      markSeen: (_sessionId, ids) => void seen.push(...ids),
    },
    windows: { keys: () => [...windows.keys()], scope: (key) => windows.get(key) ?? null },
    focusedWindow: () => focused,
    full: (sessionId) => full.has(sessionId),
    session: (sessionId) => (['s1', 's2', 's3'].includes(sessionId) ? { workItemId: Number(sessionId.slice(1)), cwd: 'D:/w' } : null),
    persona: (sessionId) => personas.get(sessionId) ?? null,
    cardSpeech: (_sessionId, replyId) => (replyId === 'r-card' ? { id: 'card:r-card#port-choice', text: 'Question 1 of 1. Which port? A: 8765. B: 8799. Or say Other.' } : null),
    alertText: (sessionId, cause) => (sessionId === 's9' ? null : { title: 'Fix the badge', detail: `${cause} of ${sessionId}` }),
    replyChanged: (id) => void changedReplies.push(`${id} ${replies.get(id)?.spokenState}`),
    notify: (key, type, payload) => void notified.push({ key, type, payload }),
    dockChanged: () => void dockChanges++,
    now: () => t,
    log: (line) => void logs.push(line),
    setTimer: (run, ms) => {
      const timer = { run, at: t + ms, cleared: false };

      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => void ((timer as { cleared: boolean }).cleared = true),
  });
  const advance = (ms: number): void => {
    t += ms;

    for (const timer of timers.filter((one) => !one.cleared && one.at <= t)) {
      timer.cleared = true;
      timer.run();
    }
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const reply = (id: string, patch: Partial<ConversationReply> = {}): ConversationReply => {
    const made: ConversationReply = { id, sessionId: 's1', workItemId: 1, at: t, kind: 'reply', answers: 'm1', opening: 'Done. More.', source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: null, ord: 1, seenAt: null, speak: 'Done.', tone: null, spokenState: 'none', spokenAtMs: null, saidChars: null, ...patch };

    replies.set(id, made);
    return made;
  };

  messages.set('m1', { spokenRequested: true });
  messages.set('m0', { spokenRequested: false });

  return {
    control,
    connections,
    windows,
    full,
    personas,
    notified,
    changedReplies,
    seen,
    replies,
    reply,
    advance,
    settle,
    stops: () => stops,
    logs,
    dockChanges: () => dockChanges,
    focus: (key: string | null) => (focused = key),
    setFound: (one: FakeConnection | { error: string } | null) => (found = one),
    setSettings: (next: Partial<VoiceSettings>) => (settings = { ...settings, ...next }),
  };
}

describe('VoiceControl', () => {
  it('sends the focused window\'s session as a target again once it is live again, as after a resume', async () => {
    const { control, connections, windows, full, settle, focus } = setup();

    windows.set('k1', scope('k1', 1, 's1'));
    focus('k1');
    control.update();
    await settle();
    full.delete('s1');
    control.update();
    full.add('s1');
    control.update();
    expect(connections[0]!.sent.filter((message) => message.type === 'targets')).toEqual([
      { type: 'targets', targets: [{ sessionId: 's1', workItemId: 1, repo: null }], focus: { sessionId: 's1', via: 'window' } },
      { type: 'targets', targets: [], focus: { sessionId: 's1', via: 'window' } },
      { type: 'targets', targets: [{ sessionId: 's1', workItemId: 1, repo: null }], focus: { sessionId: 's1', via: 'window' } },
    ]);
  });

  it('starts the voice process while a scoped window is connected, sends it the settings, the targets and the focus, and stops it 10 minutes after', async () => {
    const { control, connections, windows, advance, settle, stops, focus } = setup();

    control.update();
    await settle();
    expect(connections).toHaveLength(0);

    windows.set('k1', scope('k1', 1, 's1'));
    windows.set('k2', scope('k2', 2, 's2'));
    windows.set('k3', scope('k3', 3, 's3'));
    focus('k1');
    control.update();
    await settle();
    expect(connections).toHaveLength(1);
    expect(connections[0]!.sent).toEqual([
      { type: 'settings', settings: { ...DEFAULT_SETTINGS.voice, enabled: true } },
      // s3 is not a live session, so it is no target.
      {
        type: 'targets',
        targets: [
          { sessionId: 's1', workItemId: 1, repo: null },
          { sessionId: 's2', workItemId: 2, repo: null },
        ],
        focus: { sessionId: 's1', via: 'window' },
      },
      // No window's composer has the focus.
      { type: 'typing', on: false },
    ]);

    // Nothing changed, so nothing is sent again; the focus leaving every window is sent.
    control.update();
    focus(null);
    control.update();
    expect(connections[0]!.sent.slice(3)).toEqual([
      {
        type: 'targets',
        targets: [
          { sessionId: 's1', workItemId: 1, repo: null },
          { sessionId: 's2', workItemId: 2, repo: null },
        ],
        focus: null,
      },
    ]);

    windows.clear();
    control.update();
    advance(VOICE_LINGER_MS - 1);
    expect(stops()).toBe(0);
    advance(1);
    expect(stops()).toBe(1);
  });

  it('starts the voice process for a session terminal window in front with no window connected, keeps its session a target while the focus is away, and stops after the away drop', async () => {
    const { control, connections, full, advance, settle, stops } = setup();

    control.terminalFocused('s1', 1);
    await settle();
    expect(connections).toHaveLength(1);
    expect(connections[0]!.sent.filter((message) => message.type === 'targets')).toEqual([
      { type: 'targets', targets: [{ sessionId: 's1', workItemId: 1, repo: null }], focus: { sessionId: 's1', via: 'terminal' } },
    ]);

    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'focus' });
    expect(control.target).toBe('s1');
    expect(control.spokenFor('s1', false).spoken).toBe(true);

    // The terminal leaves the front: its session stays a target, so the voice process keeps it until its away timeout.
    control.terminalFocused(null, 1);
    expect(connections[0]!.sent.at(-1)).toEqual({ type: 'targets', targets: [{ sessionId: 's1', workItemId: 1, repo: null }], focus: null });
    advance(VOICE_LINGER_MS);
    expect(stops()).toBe(0);

    // The away timeout dropped the target: nothing wants the process, which stops 10 minutes later.
    connections[0]!.receive({ type: 'active', gen: 2, sessionId: null, reason: 'gone' });
    advance(VOICE_LINGER_MS - 1);
    expect(stops()).toBe(0);
    advance(1);
    expect(stops()).toBe(1);

    // A session that ended is forgotten as a terminal target.
    full.delete('s1');
    control.update();
    expect(control.spokenFor('s1', false).spoken).toBe(false);
  });

  it('sends the terminal focus over a window that has not reported its blur, never a terminal session that is not live, and forgets an ended one', async () => {
    const { control, connections, windows, full, settle, focus } = setup();

    windows.set('k2', scope('k2', 2, 's2'));
    focus('k2');
    control.update();
    await settle();
    control.terminalFocused('s1', 1);
    expect(connections[0]!.sent.at(-1)).toEqual({
      type: 'targets',
      targets: [
        { sessionId: 's2', workItemId: 2, repo: null },
        { sessionId: 's1', workItemId: 1, repo: null },
      ],
      focus: { sessionId: 's1', via: 'terminal' },
    });

    // s3 is not live: its terminal is the focus, so the voice leaves s1 and s2, but s3 is no target.
    control.terminalFocused('s3', 1);
    expect(connections[0]!.sent.at(-1)).toEqual({
      type: 'targets',
      targets: [
        { sessionId: 's2', workItemId: 2, repo: null },
        { sessionId: 's1', workItemId: 1, repo: null },
      ],
      focus: { sessionId: 's3', via: 'terminal' },
    });

    // s1 ended while its terminal was behind: it is no longer a target. The window's focus counts again once the terminal left.
    full.delete('s1');
    control.terminalFocused(null, 1);
    expect(connections[0]!.sent.at(-1)).toEqual({ type: 'targets', targets: [{ sessionId: 's2', workItemId: 2, repo: null }], focus: { sessionId: 's2', via: 'window' } });

    // Resumed, it is a target again only once its terminal comes to the front again.
    full.add('s1');
    control.update();
    expect(connections[0]!.sent.at(-1)).toEqual({ type: 'targets', targets: [{ sessionId: 's2', workItemId: 2, repo: null }], focus: { sessionId: 's2', via: 'window' } });
  });

  it('orders terminal and window focus reports by when they happened, so a late report never undoes a newer one', async () => {
    const { control, connections, windows, settle, focus } = setup();
    const lastFocus = () => connections[0]!.sent.filter((one) => one.type === 'targets').at(-1)!;

    windows.set('k2', scope('k2', 2, 's2'));
    control.update();
    await settle();
    control.terminalFocused('s1', 200);
    // k2 gained the focus at 100, before the terminal, but its report came after.
    focus('k2');
    control.windowGained(100);
    control.update();
    expect(lastFocus()).toMatchObject({ focus: { sessionId: 's1', via: 'terminal' } });
    // A late terminal report older than the last change is dropped too.
    control.terminalFocused(null, 150);
    expect(lastFocus()).toMatchObject({ focus: { sessionId: 's1', via: 'terminal' } });
    // k2 gained it again after the terminal: the window's focus counts.
    control.windowGained(300);
    expect(lastFocus()).toMatchObject({ focus: { sessionId: 's2', via: 'window' } });
    control.terminalFocused('s1', 250);
    expect(lastFocus()).toMatchObject({ focus: { sessionId: 's2', via: 'window' } });
  });

  it('starts nothing while voice.enabled is off, and shows the dock why the process cannot run, trying again a minute later', async () => {
    const off = setup({ enabled: false });

    off.windows.set('k1', scope('k1', 1, 's1'));
    off.control.update();
    await off.settle();
    expect(off.connections).toEqual([]);
    expect(off.control.view('k1')).toEqual({ enabled: false, here: false, mic: 'off', speaking: null, speakReplies: true, error: null, recognizer: null });

    const failing = setup();

    failing.setFound({ error: 'The voice process is not installed.' });
    failing.windows.set('k1', scope('k1', 1, 's1'));
    failing.control.update();
    await failing.settle();
    expect(failing.control.dockError()).toBe('The voice process is not installed.');
    expect(failing.dockChanges()).toBe(1);
    // A window never shows it: the problem is not this window's.
    expect(failing.control.view('k1').error).toBeNull();
    failing.setFound(null);
    failing.advance(VOICE_RESTART_MS);
    await failing.settle();
    expect(failing.connections).toHaveLength(1);
    expect(failing.control.dockError()).toBeNull();
  });

  it("mirrors the voice target, tells only the window it is in that it is here, and asks for spoken replies only for the target's session", async () => {
    const { control, connections, windows, notified, settle } = setup();

    windows.set('k1', scope('k1', 1, 's1'));
    windows.set('k2', scope('k2', 2, 's2'));
    control.update();
    await settle();
    expect(control.spokenFor('s1', false)).toEqual({ spoken: false, expressive: false });
    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'focus' });
    expect(control.target).toBe('s1');
    expect(control.view('k1')).toMatchObject({ here: true });
    expect(control.view('k2')).toMatchObject({ here: false });
    expect(notified.filter((one) => one.type === 'voice').map((one) => [one.key, (one.payload['voice'] as { here: boolean }).here])).toEqual([
      ['k1', false],
      ['k2', false],
      ['k1', true],
    ]);
    expect(control.spokenFor('s1', false)).toEqual({ spoken: true, expressive: false });
    expect(control.spokenFor('s1', true)).toEqual({ spoken: false, expressive: false });
    expect(control.spokenFor('s2', false)).toEqual({ spoken: false, expressive: false });
    control.setSpeakReplies(false);
    expect(control.spokenFor('s1', false).spoken).toBe(false);
  });

  it("offers a reply's passage once when it answers a spoken message in the target's session, records its speech, and marks a reply heard whole seen", async () => {
    const { control, connections, windows, reply, replies, changedReplies, seen, notified, settle } = setup();

    windows.set('k1', scope('k1', 1, 's1'));
    control.update();
    await settle();
    connections[0]!.receive({ type: 'active', gen: 2, sessionId: 's1', reason: 'talk-here' });

    // Not offered: a screen copy, an unasked reply, another session's, one with no passage, an aside.
    control.replyChanged(reply('r0', { source: 'screen' }));
    // Every reply has a primary response now, so one answering a message without [spoken] is never offered for it.
    control.replyChanged(reply('r0', { answers: 'm0' }));
    control.replyChanged(reply('r0', { sessionId: 's2' }));
    control.replyChanged(reply('r0', { speak: null }));
    control.replyChanged(reply('r0', { kind: 'aside' }));
    expect(connections[0]!.sent.filter((one) => one.type === 'speak')).toEqual([]);

    control.replyChanged(reply('r1', { speak: '**Done**, see [the plan](a.md).', tone: 'calm' }));
    control.replyChanged(replies.get('r1')!);
    expect(connections[0]!.sent.filter((one) => one.type === 'speak')).toEqual([
      { type: 'speak', gen: 2, replyId: 'r1', sessionId: 's1', text: 'Done, see the plan.', tone: 'calm', turn: 'm1', voice: 'marin', style: 'none', personality: null },
    ]);
    expect(replies.get('r1')!.spokenState).toBe('queued');

    connections[0]!.receive({ type: 'speech', gen: 2, replyId: 'r1', sessionId: 's1', state: 'playing', atMs: 0, said: 0 });
    expect(control.view('k1').speaking).toBe('r1');
    connections[0]!.receive({ type: 'progress', gen: 2, replyId: 'r1', sessionId: 's1', chars: 4, atMs: 300 });
    expect(notified.at(-1)).toEqual({ key: 'k1', type: 'progress', payload: { replyId: 'r1', chars: 4, atMs: 300 } });
    // A report of an older generation or of a reply never offered changes nothing.
    connections[0]!.receive({ type: 'speech', gen: 1, replyId: 'r1', sessionId: 's1', state: 'failed', atMs: null, said: null });
    connections[0]!.receive({ type: 'speech', gen: 2, replyId: 'r9', sessionId: 's1', state: 'played', atMs: 1, said: 1 });
    connections[0]!.receive({ type: 'speech', gen: 2, replyId: 'r1', sessionId: 's1', state: 'played', atMs: 900, said: 19 });
    expect(replies.get('r1')).toMatchObject({ spokenState: 'played', spokenAtMs: 900, saidChars: 19 });
    expect(control.view('k1').speaking).toBeNull();
    expect(seen).toEqual([]);

    control.replyChanged(reply('r2', { speak: 'All of it.', opening: 'All of it.' }));
    connections[0]!.receive({ type: 'speech', gen: 2, replyId: 'r2', sessionId: 's1', state: 'played', atMs: 500, said: 10 });
    expect(seen).toEqual(['r2']);
    expect(changedReplies).toEqual(['r1 queued', 'r1 playing', 'r1 played', 'r2 queued', 'r2 played', 'r2 played']);
  });

  it("logs what became of each offered reply's speech, with its session, voice and duration", async () => {
    const { control, connections, windows, reply, settle, logs } = setup();
    const speech = (): string[] => logs.filter((line) => line.startsWith('voice: reply '));

    windows.set('k1', scope('k1', 1, 's1'));
    control.update();
    await settle();
    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'focus' });
    control.replyChanged(reply('r1'));
    control.replyChanged(reply('r2'));
    control.replyChanged(reply('r3'));
    connections[0]!.receive({ type: 'speech', gen: 1, replyId: 'r1', sessionId: 's1', state: 'playing', atMs: 0, said: 0 });
    connections[0]!.receive({ type: 'speech', gen: 1, replyId: 'r1', sessionId: 's1', state: 'played', atMs: 1200, said: 5 });
    connections[0]!.receive({ type: 'speech', gen: 1, replyId: 'r2', sessionId: 's1', state: 'playing', atMs: 0, said: 0 });
    connections[0]!.receive({ type: 'progress', gen: 1, replyId: 'r2', sessionId: 's1', chars: 3, atMs: 450 });
    // A cancel reports no position; the last progress says how far it played. Why it was skipped goes in the outcome.
    connections[0]!.receive({ type: 'speech', gen: 1, replyId: 'r2', sessionId: 's1', state: 'skipped', atMs: null, said: null, reason: 'cancelled by the hub' });
    connections[0]!.receive({ type: 'speech', gen: 1, replyId: 'r3', sessionId: 's1', state: 'playing', atMs: 0, said: 0 });
    connections[0]!.receive({ type: 'progress', gen: 1, replyId: 'r3', sessionId: 's1', chars: 2, atMs: 300 });
    // A report of another generation is no outcome.
    connections[0]!.receive({ type: 'speech', gen: 0, replyId: 'r3', sessionId: 's1', state: 'failed', atMs: null, said: null });
    connections[0]!.receive({ type: 'active', gen: 2, sessionId: null, reason: 'focus' });
    connections[0]!.receive({ type: 'active', gen: 3, sessionId: 's1', reason: 'focus' });
    control.replyChanged(reply('r4'));
    connections[0]!.drop();
    expect(speech()).toEqual([
      'voice: reply r1 of session s1 played, voice marin, 1200 ms played, 5 characters said',
      'voice: reply r2 of session s1 skipped (cancelled by the hub), voice marin, 450 ms played, 3 characters said',
      'voice: reply r3 of session s1 stopped: voice moved, voice marin, 300 ms played, 2 characters said',
      'voice: reply r4 of session s1 failed: the voice process stopped, voice marin, 0 ms played, 0 characters said',
    ]);
  });

  it('keeps the voice off when a hub started again finds the voice process with no device, says so in the window, and takes it back with a typed message, Talk here or Voice on the computer', async () => {
    const { control, connections, windows, reply, settle, logs, focus } = setup();
    const sent = (type: string): HubMessage[] => connections[0]!.sent.filter((one) => one.type === type);

    windows.set('k1', scope('k1', 1, 's1'));
    focus('k1');
    control.update();
    await settle();
    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'talk-here' });
    // A hub on this computer and a process on this computer agree: nothing changes.
    connections[0]!.receive({ type: 'device', device: 'computer' });
    expect(control.device).toBe('computer');
    expect(sent('device')).toEqual([]);
    expect(control.view('k1').deviceOff).toBeUndefined();

    // The phone left before this hub started, so the process it connects to greets it with no device (PRD R119, decision 1).
    connections[0]!.receive({ type: 'device', device: 'none' });
    expect(control.device).toBe('none');
    expect(sent('device')).toEqual([{ type: 'device', device: 'none' }]);
    expect(logs).toContain('voice: device none: the voice process had no device when the hub connected');
    expect(control.view('k1')).toMatchObject({ here: true, mic: 'off', deviceOff: true });

    // The reply it skips says why.
    control.replyChanged(reply('r1'));
    connections[0]!.receive({ type: 'speech', gen: 1, replyId: 'r1', sessionId: 's1', state: 'skipped', atMs: null, said: null, reason: 'no device: the phone that had the voice left' });
    expect(logs).toContain('voice: reply r1 of session s1 skipped (no device: the phone that had the voice left), voice marin, 0 ms played, 0 characters said');

    // A message typed with no window, or to a session that is not the target, leaves it off.
    expect(control.spokenFor('s1', false, null).spoken).toBe(true);
    expect(control.spokenFor('s2', false, 'k1').spoken).toBe(false);
    expect(control.device).toBe('none');

    // A message typed in this computer's window to the target takes it back, with the mic still off, so its reply is heard.
    expect(control.spokenFor('s1', false, 'k1')).toEqual({ spoken: true, expressive: false });
    expect(control.device).toBe('computer');
    expect(sent('device').at(-1)).toEqual({ type: 'device', device: 'computer' });
    expect(sent('mic')).toEqual([]);
    expect(control.view('k1').deviceOff).toBeUndefined();

    expect(sent('device')).toEqual([
      { type: 'device', device: 'none' },
      { type: 'device', device: 'computer' },
    ]);

    // Talk here takes it back, and so does Voice on the computer, each in a hub that started again the same way.
    for (const take of [(one: VoiceControl) => one.talkHere('k1'), (one: VoiceControl) => one.toComputer('k1')]) {
      const again = setup();

      again.windows.set('k1', scope('k1', 1, 's1'));
      again.focus('k1');
      again.control.update();
      await again.settle();
      again.connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'talk-here' });
      again.connections[0]!.receive({ type: 'device', device: 'none' });
      expect(again.control.view('k1').deviceOff).toBe(true);
      expect(take(again.control)).toBeNull();
      expect(again.control.device).toBe('computer');
      expect(again.connections[0]!.sent.filter((one) => one.type === 'device').at(-1)).toEqual({ type: 'device', device: 'computer' });
      expect(again.connections[0]!.sent.filter((one) => one.type === 'mic')).toEqual([]);
    }

    expect(sent('mic')).toEqual([]);
  });

  it('keeps the voice on this computer when Talk here comes before the greeting of a process that kept no device', async () => {
    const { control, connections, windows, settle, logs, focus, advance } = setup();

    windows.set('k1', scope('k1', 1, 's1'));
    focus('k1');
    control.update();
    await settle();
    expect(control.talkHere('k1')).toBeNull();
    connections[0]!.receive({ type: 'device', device: 'none' });
    expect(control.device).toBe('computer');
    expect(connections[0]!.sent.filter((one) => one.type === 'device')).toEqual([{ type: 'device', device: 'computer' }]);
    expect(logs).toContain("voice: device computer: the voice process had no device when the hub connected, and is told this hub's device");

    // Once this hub chose the device, a process that reconnects with an older one is told the hub's, whichever it is.
    connections[0]!.drop();
    advance(VOICE_RESTART_MS);
    await settle();
    connections[1]!.receive({ type: 'device', device: 'none' });
    expect(control.device).toBe('computer');
    expect(connections[1]!.sent.filter((one) => one.type === 'device')).toEqual([{ type: 'device', device: 'computer' }]);
  });

  it('keeps the voice on this computer when it is taken back from none while a process that kept none reconnects, before its greeting', async () => {
    const { control, connections, windows, settle, focus, advance } = setup();

    windows.set('k1', scope('k1', 1, 's1'));
    focus('k1');
    control.update();
    await settle();
    connections[0]!.receive({ type: 'device', device: 'none' });
    expect(control.device).toBe('none');
    connections[0]!.drop();
    advance(VOICE_RESTART_MS);
    await settle();
    // Voice on the computer while the new connection's greeting is still to come.
    expect(control.toComputer('k1')).toBeNull();
    connections[1]!.receive({ type: 'device', device: 'none' });
    expect(control.device).toBe('computer');
    expect(connections[1]!.sent.filter((one) => one.type === 'device')).toEqual([
      { type: 'device', device: 'none' },
      { type: 'device', device: 'computer' },
      { type: 'device', device: 'computer' },
    ]);
  });

  it('marks what was offered stopped by a move, cancels a rewritten reply, and cancels all on Speak replies off', async () => {
    const { control, connections, windows, reply, replies, settle } = setup();

    windows.set('k1', scope('k1', 1, 's1'));
    control.update();
    await settle();
    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'focus' });
    control.replyChanged(reply('r1'));
    control.replyChanged(reply('r2'));
    control.replyChanged({ ...replies.get('r2')!, rewrittenBy: 'r3' });
    expect(connections[0]!.sent.filter((one) => one.type === 'cancel')).toEqual([{ type: 'cancel', replyId: 'r2' }]);
    connections[0]!.receive({ type: 'active', gen: 2, sessionId: null, reason: 'focus' });
    expect(replies.get('r1')!.spokenState).toBe('stopped-moved');
    expect(replies.get('r2')!.spokenState).toBe('stopped-moved');

    connections[0]!.receive({ type: 'active', gen: 3, sessionId: 's1', reason: 'focus' });
    control.replyChanged(reply('r4'));
    control.setSpeakReplies(false);
    expect(connections[0]!.sent.filter((one) => one.type === 'cancel').at(-1)).toEqual({ type: 'cancel', replyId: 'r4', off: true });
    expect(control.view('k1').speakReplies).toBe(false);
  });

  it('cancels every reply offered as Speak replies off, which the voice process stops at once, playing or not yet reported playing', async () => {
    const { control, connections, windows, reply, settle } = setup();

    windows.set('k1', scope('k1', 1, 's1'));
    control.update();
    await settle();
    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'focus' });
    control.replyChanged(reply('r1'));
    control.replyChanged(reply('r2'));
    connections[0]!.receive({ type: 'speech', gen: 1, replyId: 'r1', sessionId: 's1', state: 'playing', atMs: 0, said: 0 });
    expect(control.view('k1').speaking).toBe('r1');
    const before = connections[0]!.sent.length;

    control.setSpeakReplies(false);
    // No `stop`, which would drop the alert lines waiting too.
    expect(connections[0]!.sent.slice(before)).toEqual([{ type: 'cancel', replyId: 'r1', off: true }, { type: 'cancel', replyId: 'r2', off: true }]);
  });

  it('runs Talk here, Stop speaking and Replay only where they apply, and turns a dock row click into Talk here', async () => {
    const { control, connections, windows, full, reply, settle, focus } = setup();

    windows.set('k1', scope('k1', 1, 's1'));
    windows.set('k2', scope('k2', 2, 's2'));
    windows.set('k0', scope('k0', 9, null));
    expect(control.talkHere('k1')).toBe('The voice process is starting.');
    control.update();
    await settle();
    expect(control.talkHere('k0')).toBe('This window has no session to talk to.');
    full.delete('s2');
    expect(control.talkHere('k2')).toBe('Voice is not available for this session.');
    expect(control.talkHere('k1')).toBeNull();
    expect(connections[0]!.sent.at(-1)).toEqual({ type: 'talk-here', sessionId: 's1' });

    expect(control.stopSpeaking('k1')).toBe('Voice is not in this window.');
    expect(control.replay('k1', 'r1')).toBe('Not in this window.');
    reply('r1');
    expect(control.replay('k1', 'r1')).toBe('Voice is not in this window.');
    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'talk-here' });
    expect(control.stopSpeaking('k1')).toBeNull();
    expect(connections[0]!.sent.at(-1)).toEqual({ type: 'stop' });
    expect(control.replay('k2', 'r1')).toBe('Not in this window.');
    reply('r5', { speak: null });
    expect(control.replay('k1', 'r5')).toBe('This reply has nothing to read aloud.');
    expect(control.replay('k1', 'r1')).toBeNull();
    expect(connections[0]!.sent.at(-1)).toMatchObject({ type: 'speak', replyId: 'r1', gen: 1 });
    // Not again while it is spoken.
    expect(control.replay('k1', 'r1')).toBe('This reply is being spoken.');
    expect(connections[0]!.sent.filter((one) => one.type === 'speak')).toHaveLength(1);

    // Selecting a conversation in the focused window is Talk here at once; in another window it waits for the focus.
    const talks = () => connections[0]!.sent.filter((one) => one.type === 'talk-here').length;
    const before = talks();

    control.selected('k2');
    expect(talks()).toBe(before);
    focus('k1');
    control.selected('k1');
    expect(talks()).toBe(before + 1);

    expect(control.dockSelect(7)).toBe(OPEN_ITS_WINDOW);
    expect(control.dockSelect(1)).toBeNull();
  });

  it('plays the needs-you sound only for a work item other than the voice target\'s, and only while it is on', async () => {
    const { control, connections, windows, settle, setSettings } = setup();

    windows.set('k1', scope('k1', 1, 's1'));
    control.update();
    await settle();
    expect(control.needsYou([1], 1)).toBe(false);
    expect(control.needsYou([], null)).toBe(false);
    expect(connections[0]!.sent.filter((one) => one.type === 'earcon')).toEqual([]);
    // It says whether it played, so a web page that raises the alert does not sound as well.
    expect(control.needsYou([1, 2], 1)).toBe(true);
    expect(connections[0]!.sent.filter((one) => one.type === 'earcon')).toEqual([{ type: 'earcon', kind: 'needs-you' }]);
    setSettings({ needsYouSound: false });
    expect(control.needsYou([2], 1)).toBe(false);
    expect(connections[0]!.sent.filter((one) => one.type === 'earcon')).toHaveLength(1);
  });

  it('fails what was offered when the process stops, shows the dock, reports playback trouble only to the window it is in, and passes settings on', async () => {
    const { control, connections, windows, reply, replies, notified, settle, advance, setSettings } = setup();

    windows.set('k1', scope('k1', 1, 's1'));
    windows.set('k2', scope('k2', 2, 's2'));
    control.update();
    await settle();
    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'focus' });
    connections[0]!.receive({ type: 'audio', mic: 'off', engine: 'decibri', device: null, recognizer: null, error: 'no device' });
    // Playback trouble is the voice's: the dock shows it, no window does.
    expect(control.view('k1').error).toBeNull();
    expect(control.view('k2').error).toBeNull();
    expect(control.dockError()).toBe('no device');
    // Where recognition runs goes only to the window the voice is in.
    connections[0]!.receive({ type: 'audio', mic: 'listening', engine: 'decibri', device: null, recognizer: 'gpu', error: 'no device' });
    expect([control.view('k1').recognizer, control.view('k2').recognizer]).toEqual(['gpu', null]);
    expect(notified.filter((one) => one.type === 'voice' && one.key === 'k1').at(-1)).toMatchObject({ payload: { voice: { recognizer: 'gpu' } } });

    setSettings({ briefReplies: true, voice: 'cedar' });
    control.settingsChanged();
    expect(connections[0]!.sent.filter((one) => one.type === 'settings').at(-1)).toMatchObject({ settings: { voice: 'cedar' } });
    expect(notified.filter((one) => one.type === 'settings').map((one) => one.key)).toEqual(['k1', 'k2']);
    // Each window and page gets every setting it reads, the diff viewer's too.
    expect(notified.filter((one) => one.type === 'settings').at(-1)).toMatchObject({ payload: { settings: { briefReplies: true, diffLayout: 'stacked', diffWrap: 'on' } } });
    expect(connections[0]!.sent.filter((one) => one.type === 'stop')).toEqual([]);

    // Turning voice off stops what plays.
    setSettings({ enabled: false });
    control.settingsChanged();
    expect(connections[0]!.sent.at(-1)).toEqual({ type: 'stop' });
    setSettings({ enabled: true });

    control.replyChanged(reply('r1'));
    connections[0]!.drop();
    expect(replies.get('r1')!.spokenState).toBe('failed');
    expect(control.target).toBeNull();
    expect(control.dockError()).toBe('The voice process stopped; it is started again within a minute.');
    advance(VOICE_RESTART_MS);
    await settle();
    expect(connections).toHaveLength(2);
    control.windowClosed('k2');
    control.close();
    expect(connections[1]!.closed).toBe(true);
  });

  it("speaks a reply in its session's persona's voice, style and personality, read at each offer (architecture.md § Personas)", async () => {
    const { control, connections, windows, reply, personas, settle } = setup({ enabled: true, voice: 'sage', style: 'upbeat' });
    const spoken = () => connections[0]!.sent.filter((one) => one.type === 'speak').map((one) => one.type === 'speak' && [one.voice, one.style, one.personality]);

    windows.set('k1', scope('k1', 1, 's1'));
    control.update();
    await settle();
    connections[0]!.receive({ type: 'active', gen: 2, sessionId: 's1', reason: 'talk-here' });

    control.replyChanged(reply('r1'));
    personas.set('s1', { id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm.' });
    control.replyChanged(reply('r2'));
    personas.set('s1', { id: 'orion', name: 'Orion', voice: 'ash', style: 'deadpan', personality: '' });
    control.replyChanged(reply('r3'));

    expect(spoken()).toEqual([
      ['sage', 'upbeat', null],
      ['cedar', 'pair', 'Warm.'],
      ['ash', 'deadpan', null],
    ]);
  });

  it("offers a reply's open card's current question right after its passage, in the same turn, and again with a Replay (PRD R103)", async () => {
    const { control, connections, windows, reply, settle } = setup({ enabled: true });
    const speaks = () => connections[0]!.sent.flatMap((one) => (one.type === 'speak' ? [[one.replyId, one.text, one.turn]] : []));

    windows.set('k1', scope('k1', 1, 's1'));
    control.update();
    await settle();
    connections[0]!.receive({ type: 'active', gen: 2, sessionId: 's1', reason: 'talk-here' });

    const asked = reply('r-card');

    control.replyChanged(asked);
    expect(speaks()).toEqual([
      ['r-card', expect.any(String), asked.answers],
      ['card:r-card#port-choice', 'Question 1 of 1. Which port? A: 8765. B: 8799. Or say Other.', asked.answers],
    ]);
    // A reply with no open question gets no card item.
    control.replyChanged(reply('r-plain'));
    expect(speaks().map(([id]) => id)).toEqual(['r-card', 'card:r-card#port-choice', 'r-plain']);
  });
});

describe('spoken alerts in the hub', () => {
  it('reads a session\'s kind from its state and what it waits on', () => {
    expect(alertKind({ state: 'running', stateDetail: null })).toBe('running');
    expect(alertKind({ state: 'starting', stateDetail: null })).toBe('running');
    expect(alertKind({ state: 'idle', stateDetail: null })).toBe('idle');
    expect(alertKind({ state: 'idle', stateDetail: 'question-card' })).toBe('question');
    expect(alertKind({ state: 'waiting', stateDetail: null })).toBe('question');
    expect(alertKind({ state: 'waiting', stateDetail: 'permission-prompt' })).toBe('permission');
    expect(alertKind({ state: 'waiting', stateDetail: 'start-prompt' })).toBe('other');
    expect(alertKind({ state: 'failed', stateDetail: 'error' })).toBe('other');
  });

  it('reads the speak passage, else the reply, else the status, as speech cut at a sentence, and says a wait in the terminal is there', () => {
    expect(alertDetail('turn-finished', false, { speak: 'The **badge** counts.', opening: 'Long text.' }, 'Status')).toBe('The badge counts.');
    expect(alertDetail('turn-finished', false, { speak: null, opening: 'Fixed `badge.ts`.\n\nAll green.' }, null)).toBe('Fixed badge.ts. All green.');
    expect(alertDetail('question', false, { speak: null, opening: ' ' }, '## Which colour?')).toBe('Which colour?');
    // A primary response that opens with a list has nothing the voice reads, so the alert reads the reply, without its question markup.
    expect(alertDetail('turn-finished', false, { speak: '[withdraw: old-one]\n\n- Updated the parser.', opening: '[withdraw: old-one]\n\n- Updated the parser.' }, null)).toBe('Updated the parser.');
    expect(alertDetail('question', false, null, null)).toBe('It is waiting for your answer.');
    expect(alertDetail('turn-finished', false, null, null)).toBe('It has no reply to read.');
    expect(alertDetail('question', true, { speak: 'x', opening: 'x' }, null)).toBe('It is waiting for your answer in its terminal.');
    expect(alertDetail('permission', false, { speak: 'x', opening: 'x' }, null)).toBe('It is waiting for your permission in its terminal.');
    // A session idle on open questions reads its passage, then the count and the current question (PRD R103).
    expect(alertDetail('question', false, { speak: 'Two decisions.', opening: 'x' }, null, { count: 2, first: 'Which port? A: 8765. Or say Other.' })).toBe('Two decisions. It has 2 questions; the first: Which port? A: 8765. Or say Other.');
    expect(alertDetail('question', false, { speak: 'One.', opening: 'x' }, null, { count: 1, first: 'Which?' })).toBe('One. It has one question; it is: Which?');
    expect(alertDetail('permission', false, { speak: 'x', opening: 'x' }, null, { count: 1, first: 'Which?' })).toBe('It is waiting for your permission in its terminal.');

    const long = `${'One sentence here. '.repeat(30)}`;
    const cut = alertDetail('turn-finished', false, { speak: null, opening: long }, null);

    expect(cut.length).toBeLessThanOrEqual(400);
    expect(cut.endsWith('here.')).toBe(true);
    expect(alertDetail('turn-finished', false, { speak: null, opening: 'word '.repeat(200) }, null)).toMatch(/word…$/);
  });

  it('alerts a session out of focus that finishes a turn or starts waiting, after a delay, in its persona\'s voice, and cancels one whose cause passes', async () => {
    const { control, connections, windows, focus, settle, advance, personas, logs } = setup({ enabled: true, operatorName: 'Alex' });
    const alerts = () => connections[0]!.sent.filter((message) => message.type === 'alert' || message.type === 'alert-cancel');
    const run = (kinds: Record<string, 'running' | 'idle' | 'question' | 'permission' | 'other'>) =>
      control.sessionsChanged(Object.entries(kinds).map(([sessionId, kind]) => ({ sessionId, workItemId: Number(sessionId.slice(1)), kind })));

    windows.set('k1', scope('k1', 1, 's1'));
    focus('k1');
    control.update();
    await settle();
    personas.set('s2', { id: 'tinker', name: 'Tinker', voice: 'cedar', style: 'pair', personality: 'Dry.' });

    // The first sight of a session waiting alerts nothing.
    expect(run({ s1: 'running', s2: 'running', s3: 'question' })).toEqual([]);

    // The focused conversation finishing alerts nothing; another does, after the delay.
    expect(run({ s1: 'idle', s2: 'idle', s3: 'question' })).toEqual([2]);
    expect(alerts()).toEqual([]);
    advance(ALERT_DELAY_MS);
    expect(alerts()).toEqual([
      { type: 'alert', alertId: expect.any(String), sessionId: 's2', cause: 'turn-finished', title: 'Fix the badge', persona: 'Tinker', detail: 'turn-finished of s2', voice: 'cedar', style: 'pair', personality: 'Dry.' },
    ]);
    const first = (alerts()[0] as { alertId: string }).alertId;

    // It starts again: the alert is cancelled. A permission prompt alerts, in the settings' voice without a persona.
    run({ s1: 'idle', s2: 'running', s3: 'question' });
    expect(alerts().at(-1)).toEqual({ type: 'alert-cancel', alertId: first });
    personas.clear();
    expect(run({ s1: 'idle', s2: 'permission', s3: 'question' })).toEqual([2]);
    advance(ALERT_DELAY_MS);
    expect(alerts().at(-1)).toMatchObject({ type: 'alert', sessionId: 's2', cause: 'permission', persona: null, voice: 'marin', style: 'none', personality: null });

    // The process ended it: no cancel goes when its cause passes.
    const second = (alerts().at(-1) as { alertId: string }).alertId;

    connections[0]!.receive({ type: 'alert-done', alertId: second, sessionId: 's2', outcome: 'unanswered' });
    expect(logs).toContain(`voice: alert ${second} for session s2 unanswered`);
    run({ s1: 'idle', s2: 'running', s3: 'question' });
    expect(alerts().at(-1)).toMatchObject({ type: 'alert', alertId: second });

    // A change within the delay sends nothing, nor does a session that left.
    expect(run({ s1: 'idle', s2: 'question', s3: 'question' })).toEqual([2]);
    run({ s1: 'idle', s2: 'running', s3: 'question' });
    advance(ALERT_DELAY_MS);
    expect(alerts()).toHaveLength(3);
    run({ s1: 'idle', s2: 'question', s3: 'question' });
    run({ s1: 'idle', s3: 'question' });
    advance(ALERT_DELAY_MS);
    expect(alerts()).toHaveLength(3);

    // A sent alert of a session that ended is cancelled.
    run({ s1: 'idle', s2: 'running', s3: 'running' });
    run({ s1: 'idle', s2: 'running', s3: 'idle' });
    advance(ALERT_DELAY_MS);
    const third = (alerts().at(-1) as { alertId: string; sessionId: string });
    expect(third.sessionId).toBe('s3');
    run({ s1: 'idle', s2: 'running' });
    expect(alerts().at(-1)).toEqual({ type: 'alert-cancel', alertId: third.alertId });
  });

  it('sends no alert for an event turned off, with spoken alerts or voice off, for the voice target, or for a session the store does not have', async () => {
    const { control, connections, windows, focus, settle, advance, setSettings } = setup({ enabled: true, alertOn: { finished: true, question: false, permission: true } });
    const alerts = () => connections[0]!.sent.filter((message) => message.type === 'alert');
    const run = (kinds: Record<string, 'running' | 'idle' | 'question' | 'permission'>) =>
      control.sessionsChanged(Object.entries(kinds).map(([sessionId, kind]) => ({ sessionId, workItemId: Number(sessionId.slice(1)), kind })));

    windows.set('k1', scope('k1', 1, 's1'));
    windows.set('k2', scope('k2', 2, 's2'));
    control.update();
    await settle();
    run({ s1: 'running', s2: 'running', s9: 'running' });
    expect(run({ s1: 'question', s2: 'running', s9: 'idle' })).toEqual([9]);
    advance(ALERT_DELAY_MS);
    expect(alerts()).toEqual([]);

    // The voice target gets none, focused or not.
    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's2', reason: 'talk-here' });
    expect(run({ s1: 'question', s2: 'idle', s9: 'idle' })).toEqual([]);

    setSettings({ spokenAlerts: false });
    expect(run({ s1: 'permission', s2: 'idle', s9: 'idle' })).toEqual([]);
    setSettings({ spokenAlerts: true, enabled: false });
    expect(run({ s1: 'running', s2: 'idle', s9: 'idle' })).toEqual([]);
    expect(run({ s1: 'idle', s2: 'idle', s9: 'idle' })).toEqual([]);

    // Turned off between the change and the send, nothing goes.
    setSettings({ enabled: true });
    run({ s1: 'running', s2: 'idle', s9: 'idle' });
    expect(run({ s1: 'idle', s2: 'idle', s9: 'idle' })).toEqual([1]);
    setSettings({ spokenAlerts: false });
    advance(ALERT_DELAY_MS);
    expect(alerts()).toEqual([]);
    focus(null);
  });

  it('says the mic is on where the voice is only while it is turned on and capture runs, and tells the dock when that changes (PRD R109)', async () => {
    const { control, connections, windows, settle, dockChanges } = setup({ enabled: true });

    windows.set('k1', scope('k1', 1, 's1'));
    control.update();
    await settle();
    control.talkHere('k1');
    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'talk-here' });
    expect(control.micLive).toBe(false);

    const before = dockChanges();

    expect(control.mic('k1', true)).toBeNull();
    // Turned on, but capture has not started: not on yet.
    expect(control.micLive).toBe(false);
    connections[0]!.receive({ type: 'audio', mic: 'listening', engine: 'decibri', device: null, recognizer: 'cpu', error: null });
    expect(control.micLive).toBe(true);
    expect(dockChanges()).toBe(before + 1);
    // Hearing is still on, with no new mark.
    connections[0]!.receive({ type: 'audio', mic: 'hearing', engine: 'decibri', device: null, recognizer: 'cpu', error: null });
    expect(dockChanges()).toBe(before + 1);

    // The idle timeout stops capture: no longer on.
    connections[0]!.receive({ type: 'audio', mic: 'idle-off', engine: 'decibri', device: null, recognizer: 'cpu', error: null });
    expect(control.micLive).toBe(false);
    expect(dockChanges()).toBe(before + 2);
    connections[0]!.receive({ type: 'audio', mic: 'listening', engine: 'decibri', device: null, recognizer: 'cpu', error: null });

    // Mic off is off at once, before the process answers.
    expect(control.mic('k1', false)).toBeNull();
    expect(control.micLive).toBe(false);
    expect(dockChanges()).toBe(before + 4);
  });
});

describe('speechOf', () => {
  const spokenTextOf = (text: string): string => text.replace(/\s+/g, ' ').trim();

  it("reads a reply's primary response as the view shows it, without question markup, up to its first list, table or code block", () => {
    expect(speechOf('Fixed it.\n\n[withdraw: old-one]\n\nMore after.')).not.toContain('withdraw');
    expect(spokenTextOf(speechOf('Fixed it.\n\n[withdraw: old-one]\n\nMore after.'))).toBe('Fixed it. More after.');
    expect(speechOf('Fixed it.\n\n1. Ship it? {#ship}\n   - A) Yes')).toBe('Fixed it.');
    expect(speechOf('1. Ship it? {#ship}\n   - A) Yes')).toBe('');
  });
});

describe('voiceMark', () => {
  it('marks the voice target\'s row with the mic while the mic is on, else the speaker, saying where the voice is', () => {
    expect(voiceMark(true, false)).toEqual({ glyph: VOICE_GLYPH, title: 'Voice is set to this session. Mic on.' });
    expect(voiceMark(false, false)).toEqual({ glyph: SPEAKER_GLYPH, title: 'Voice is set to this session. Mic off.' });
    expect(voiceMark(true, true)).toEqual({ glyph: VOICE_GLYPH, title: 'Voice is on a paired device for this session. Mic on.' });
    expect(voiceMark(false, true).glyph).toBe(SPEAKER_GLYPH);
    expect(SPEAKER_GLYPH).not.toBe(VOICE_GLYPH);
  });
});
