import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core';
import type { ConversationReply, Persona, VoiceSettings } from '@switchboard/core';
import type { HubMessage, VoiceMessage } from '@switchboard/voice';
import { OPEN_ITS_WINDOW, VOICE_LINGER_MS, VOICE_RESTART_MS, VoiceControl } from '../src/voice.js';
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
    store: {
      reply: (id) => replies.get(id) ?? null,
      updateReply: (id, patch) => void replies.set(id, { ...replies.get(id)!, ...patch }),
      message: (id) => messages.get(id) ?? null,
      markSeen: (_sessionId, ids) => void seen.push(...ids),
    },
    windows: { keys: () => [...windows.keys()], scope: (key) => windows.get(key) ?? null },
    focusedWindow: () => focused,
    full: (sessionId) => full.has(sessionId),
    persona: (sessionId) => personas.get(sessionId) ?? null,
    replyChanged: (id) => void changedReplies.push(`${id} ${replies.get(id)?.spokenState}`),
    notify: (key, type, payload) => void notified.push({ key, type, payload }),
    dockChanged: () => void dockChanges++,
    now: () => t,
    log: () => undefined,
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

  it('starts nothing while voice.enabled is off, and shows the dock why the process cannot run, trying again a minute later', async () => {
    const off = setup({ enabled: false });

    off.windows.set('k1', scope('k1', 1, 's1'));
    off.control.update();
    await off.settle();
    expect(off.connections).toEqual([]);
    expect(off.control.view('k1')).toEqual({ enabled: false, here: false, mic: 'off', speaking: null, speakReplies: true, error: null });

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
    expect(connections[0]!.sent.filter((one) => one.type === 'cancel').at(-1)).toEqual({ type: 'cancel', replyId: 'r4' });
    expect(control.view('k1').speakReplies).toBe(false);
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
    expect(control.talkHere('k2')).toBe('The voice speaks only for a live session.');
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
    expect(control.replay('k1', 'r5')).toBe('This reply has no spoken passage.');
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
    control.needsYou([1], 1);
    control.needsYou([], null);
    expect(connections[0]!.sent.filter((one) => one.type === 'earcon')).toEqual([]);
    control.needsYou([1, 2], 1);
    expect(connections[0]!.sent.filter((one) => one.type === 'earcon')).toEqual([{ type: 'earcon', kind: 'needs-you' }]);
    setSettings({ needsYouSound: false });
    control.needsYou([2], 1);
    expect(connections[0]!.sent.filter((one) => one.type === 'earcon')).toHaveLength(1);
  });

  it('fails what was offered when the process stops, shows the dock, reports playback trouble only to the window it is in, and passes settings on', async () => {
    const { control, connections, windows, reply, replies, notified, settle, advance, setSettings } = setup();

    windows.set('k1', scope('k1', 1, 's1'));
    windows.set('k2', scope('k2', 2, 's2'));
    control.update();
    await settle();
    connections[0]!.receive({ type: 'active', gen: 1, sessionId: 's1', reason: 'focus' });
    connections[0]!.receive({ type: 'audio', mic: 'off', engine: 'decibri', device: null, error: 'no device' });
    // Playback trouble is the voice's: the dock shows it, no window does.
    expect(control.view('k1').error).toBeNull();
    expect(control.view('k2').error).toBeNull();
    expect(control.dockError()).toBe('no device');

    setSettings({ expandReplies: true, voice: 'cedar' });
    control.settingsChanged();
    expect(connections[0]!.sent.filter((one) => one.type === 'settings').at(-1)).toMatchObject({ settings: { voice: 'cedar' } });
    expect(notified.filter((one) => one.type === 'settings').map((one) => one.key)).toEqual(['k1', 'k2']);
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
});
