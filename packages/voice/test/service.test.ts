import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core/settings';
import type { VoiceMessage } from '../src/protocol.js';
import { FOCUS_DEBOUNCE_MS } from '../src/routing.js';
import { VoiceService } from '../src/service.js';
import { Clock, FakeOutput, FakeTts, settle } from './fakes.js';

/** The settings' voice, as the hub sends it for a session with no persona. */
const VOICE = { voice: 'marin', style: 'none', personality: null } as const;

function setup() {
  const clock = new Clock();
  const tts = new FakeTts();
  const output = new FakeOutput();
  const sent: VoiceMessage[] = [];
  const logs: string[] = [];
  const service = new VoiceService({ tts, output, send: (message) => sent.push(message), now: clock.now, log: (line) => logs.push(line), setTimer: clock.setTimer, clearTimer: clock.clearTimer, every: clock.every });

  return { clock, tts, output, sent, logs, service };
}

describe('VoiceService', () => {
  it('passes the mic, the composer\'s focus, the context, heard tags and the target to dictation, reports capture\'s state, and feeds it the audio played', async () => {
    const clock = new Clock();
    const tts = new FakeTts();
    const output = new FakeOutput();
    const sent: VoiceMessage[] = [];
    const calls: string[] = [];
    let hooks!: { changed(): void; spoke(): void; send(message: VoiceMessage): void; playedUntil(): number };
    let state: 'off' | 'listening' = 'off';
    let halfDuplex: string | null = null;
    const service = new VoiceService({
      tts,
      output,
      send: (message) => sent.push(message),
      heard: (heard, meant) => calls.push(`heard ${heard}=${meant}`),
      dictation: (given) => {
        hooks = given;
        return {
          get state() {
            return state;
          },
          get halfDuplex() {
            return halfDuplex;
          },
          error: null,
          mic: (on: boolean) => calls.push(`mic ${on}`),
          typing: (on: boolean) => calls.push(`typing ${on}`),
          context: (sessionId: string, lastReply: string) => calls.push(`context ${sessionId} ${lastReply}`),
          target: (gen: number, sessionId: string | null, repo: string | null) => calls.push(`target ${gen} ${sessionId} ${repo}`),
          reference: (pcm: Buffer) => calls.push(`reference ${pcm.length}`),
          settingsChanged: () => calls.push('settings'),
          close: () => calls.push('close'),
        } as unknown as import('../src/dictation.js').Dictation;
      },
      now: clock.now,
      log: () => undefined,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      every: clock.every,
    });

    service.receive({ type: 'settings', settings: { ...DEFAULT_SETTINGS.voice, enabled: true, inputDevice: 'Headset' } });
    service.receive({ type: 'mic', on: true });
    service.receive({ type: 'typing', on: true });
    service.receive({ type: 'context', sessionId: 's1', lastReply: 'Done.' });
    service.receive({ type: 'heard', heard: 'a llama', meant: 'Ollama' });
    service.receive({ type: 'targets', targets: [{ sessionId: 's1', workItemId: 1, repo: 'acme/app' }], focus: null });
    service.receive({ type: 'talk-here', sessionId: 's1' });
    expect(calls).toEqual(['settings', 'mic true', 'typing true', 'context s1 Done.', 'heard a llama=Ollama', 'target 1 s1 acme/app']);

    // Turning voice off in the settings stops capture, whatever the mic was set to.
    service.receive({ type: 'settings', settings: { ...DEFAULT_SETTINGS.voice, enabled: false } });
    expect(calls.slice(-2)).toEqual(['settings', 'mic false']);
    service.receive({ type: 'settings', settings: { ...DEFAULT_SETTINGS.voice, enabled: true, inputDevice: 'Headset' } });

    state = 'listening';
    hooks.changed();
    expect(sent.at(-1)).toEqual({ type: 'audio', mic: 'listening', engine: 'fake', device: 'Headset', recognizer: null, error: null });
    halfDuplex = 'no echo cancellation on Remote Audio';
    hooks.changed();
    expect(sent.at(-1)).toEqual({ type: 'audio', mic: 'listening', engine: 'fake', device: 'Headset', recognizer: null, error: null, halfDuplex: 'no echo cancellation on Remote Audio' });
    hooks.send({ type: 'words', gen: 1, utteranceId: 'u', sessionId: 's1', text: 'hi' });
    expect(sent.at(-1)).toMatchObject({ type: 'words', text: 'hi' });

    // Speech restarts the away count: with no window focused, Talk here times out two minutes after the last speech.
    clock.advance(100_000);
    hooks.spoke();
    clock.advance(100_000);
    expect(sent.filter((one) => one.type === 'active').at(-1)).toMatchObject({ sessionId: 's1' });
    clock.advance(20_000);
    expect(sent.filter((one) => one.type === 'active').at(-1)).toMatchObject({ sessionId: null, reason: 'gone' });
    expect(calls.at(-1)).toBe('target 2 null null');

    service.receive({ type: 'talk-here', sessionId: 's1' });
    expect(hooks.playedUntil()).toBe(-Infinity);
    service.receive({ type: 'speak', gen: 3, replyId: 'r1', sessionId: 's1', text: 'One.', tone: null, turn: null, ...VOICE });
    expect(hooks.playedUntil()).toBe(Infinity);
    tts.requests[0]!.audio(480);
    await settle();
    expect(calls).toContain('reference 480');

    // The rest goes to the canceller as it plays, not as it is written.
    const referenced = () => calls.filter((call) => call.startsWith('reference ')).reduce((sum, call) => sum + Number(call.slice('reference '.length)), 0);

    tts.requests[0]!.audio(48_000);
    await settle();
    expect(referenced()).toBe(960);
    clock.advance(500);
    expect(referenced()).toBe(960 + 500 * 48);
    clock.advance(1000);
    expect(referenced()).toBe(480 + 48_000);
    service.close();
    expect(calls.at(-1)).toBe('close');
  });

  it('greets a hub with the target and playback state, and configures speech from the settings', () => {
    const { tts, service } = setup();

    expect(service.greeting()).toEqual([
      { type: 'active', gen: 0, sessionId: null, reason: 'gone' },
      { type: 'audio', mic: 'off', engine: 'fake', device: null, recognizer: null, error: null },
    ]);
    service.receive({ type: 'settings', settings: { ...DEFAULT_SETTINGS.voice, enabled: true, voice: 'cedar', speed: 1.5, outputDevice: 'USB' } });
    expect(tts.configured).toEqual([{ voice: 'cedar', style: 'none', speed: 1.5, expressive: false }]);
    expect(service.greeting()[1]).toMatchObject({ device: 'USB' });
  });

  it('speaks only a reply of the current generation for the target, and stops, cancels and chimes on request', async () => {
    const { clock, tts, output, sent, logs, service } = setup();

    service.receive({ type: 'targets', targets: [{ sessionId: 's1', workItemId: 1 }], focus: { sessionId: 's1', via: 'window' } });
    clock.advance(FOCUS_DEBOUNCE_MS);
    expect(sent).toEqual([{ type: 'active', gen: 1, sessionId: 's1', reason: 'focus' }]);
    expect(tts.warmed).toBe(1);

    service.receive({ type: 'speak', gen: 0, replyId: 'old', sessionId: 's1', text: 'Old.', tone: null, turn: null, ...VOICE });
    service.receive({ type: 'speak', gen: 1, replyId: 'other', sessionId: 's2', text: 'Other.', tone: null, turn: null, ...VOICE });
    expect(tts.requests).toEqual([]);
    expect(logs).toContain('reply old dropped: generation 0 is not 1');

    service.receive({ type: 'speak', gen: 1, replyId: 'r1', sessionId: 's1', text: 'One.', tone: 'calm', turn: 'm1', voice: 'cedar', style: 'pair', personality: 'Warm.' });
    service.receive({ type: 'speak', gen: 1, replyId: 'r2', sessionId: 's1', text: 'Two.', tone: null, turn: 'm1', ...VOICE });
    expect(tts.requests.map((one) => [one.text, one.tone, one.as])).toEqual([['One.', 'calm', { voice: 'cedar', style: 'pair', personality: 'Warm.' }]]);
    service.receive({ type: 'cancel', replyId: 'r2' });
    service.receive({ type: 'stop' });
    expect(sent.filter((one) => one.type === 'speech').map((one) => `${(one as { replyId: string }).replyId} ${(one as { state: string }).state}`)).toEqual(['r2 skipped', 'r1 interrupted']);
    service.receive({ type: 'earcon', kind: 'needs-you' });
    await settle();
    expect(output.playbacks.at(-1)!.drained).toBe(true);

    service.receive({ type: 'talk-here', sessionId: 'nope' });
    expect(logs).toContain('talk here refused: session nope is not a voice target');
    service.receive({ type: 'talk-here', sessionId: 's1' });
    service.receive({ type: 'shutdown' });
    service.close();
    expect(tts.closed).toBe(true);
  });

  it('reports a playback error once, and clears it when a reply plays again', async () => {
    const { clock, tts, output, sent, service } = setup();

    service.receive({ type: 'targets', targets: [{ sessionId: 's1', workItemId: 1 }], focus: { sessionId: 's1', via: 'window' } });
    clock.advance(FOCUS_DEBOUNCE_MS);
    output.fail = new Error('no device');
    service.receive({ type: 'speak', gen: 1, replyId: 'r1', sessionId: 's1', text: 'One.', tone: null, turn: null, ...VOICE });
    await settle();
    service.receive({ type: 'speak', gen: 1, replyId: 'r2', sessionId: 's1', text: 'Two.', tone: null, turn: null, ...VOICE });
    await settle();
    output.fail = null;
    service.receive({ type: 'speak', gen: 1, replyId: 'r3', sessionId: 's1', text: 'Three.', tone: null, turn: null, ...VOICE });
    await settle();
    tts.requests.at(-1)!.finish();
    await settle();
    expect(sent.filter((one) => one.type === 'audio').map((one) => (one as { error: string | null }).error)).toEqual(['no device', null]);
  });
  it('gives dictation the reply playing and stops it for a barge-in with the words heard, and learns each reply voice from its first 3 s of audio', async () => {
    const clock = new Clock();
    const tts = new FakeTts();
    const output = new FakeOutput();
    const sent: VoiceMessage[] = [];
    const learnt: Array<{ voice: string; samples: number }> = [];
    let hooks!: Parameters<NonNullable<ConstructorParameters<typeof VoiceService>[0]['dictation']>>[0];
    const service = new VoiceService({
      tts,
      output,
      send: (message) => sent.push(message),
      voiceprint: { learnVoice: (voice: string, samples: Float32Array) => learnt.push({ voice, samples: samples.length }) } as unknown as import('../src/voiceprint.js').Voiceprint,
      dictation: (given) => {
        hooks = given;
        return { state: 'off', error: null, target: () => undefined, reference: () => undefined, settingsChanged: () => undefined, close: () => undefined } as unknown as import('../src/dictation.js').Dictation;
      },
      now: clock.now,
      log: () => undefined,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      every: clock.every,
    });

    service.receive({ type: 'settings', settings: { ...DEFAULT_SETTINGS.voice, enabled: true } });
    service.receive({ type: 'targets', targets: [{ sessionId: 's1', workItemId: 1 }], focus: null });
    service.receive({ type: 'talk-here', sessionId: 's1' });
    expect(hooks.playing()).toBeNull();
    expect(hooks.interrupt()).toBeNull();
    service.receive({ type: 'speak', gen: 1, replyId: 'r1', sessionId: 's1', text: 'Fixed the login flow.', tone: null, turn: 'm1', voice: 'cedar', style: 'none', personality: null });
    expect(hooks.playing()).toEqual({ replyId: 'r1', text: 'Fixed the login flow.', voice: 'cedar' });
    await settle();
    tts.requests[0]!.audio(96_000);
    await settle();
    expect(learnt).toEqual([]);
    tts.requests[0]!.audio(96_000);
    await settle();
    // 3 s of 24 kHz audio, as 16 kHz samples, once per reply.
    expect(learnt).toEqual([{ voice: 'cedar', samples: 48_000 }]);
    tts.requests[0]!.audio(96_000);
    await settle();
    expect(learnt).toHaveLength(1);
    // 5 s of the 6 s written: 18 of the passage's 21 characters, the cut word not heard.
    clock.advance(5_000);
    expect(hooks.interrupt()).toEqual({ replyId: 'r1', said: 'Fixed the login', rest: 'flow.' });
    expect(sent.filter((one) => one.type === 'speech').map((one) => (one as { state: string }).state)).toEqual(['playing', 'interrupted']);
    expect(hooks.playing()).toBeNull();
  });

  it('passes enrol commands to dictation, and fails a start without capture', () => {
    const { service, sent } = setup();

    service.receive({ type: 'enroll', action: 'cancel' });
    service.receive({ type: 'enroll', action: 'start' });
    expect(sent).toEqual([{ type: 'enrollment', state: 'failed', error: 'Capture is not available.' }]);

    const calls: string[] = [];
    const withCapture = new VoiceService({
      tts: new FakeTts(),
      output: new FakeOutput(),
      send: () => undefined,
      dictation: () => ({ state: 'off', error: null, enroll: (action: string) => calls.push(action), close: () => undefined }) as unknown as import('../src/dictation.js').Dictation,
      now: () => 0,
      log: () => undefined,
    });

    withCapture.receive({ type: 'enroll', action: 'start' });
    withCapture.receive({ type: 'enroll', action: 'cancel' });
    expect(calls).toEqual(['start', 'cancel']);
  });
});
