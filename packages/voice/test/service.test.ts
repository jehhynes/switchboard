import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core/settings';
import type { VoiceMessage } from '../src/protocol.js';
import { FOCUS_DEBOUNCE_MS } from '../src/routing.js';
import { VoiceService } from '../src/service.js';
import { Clock, FakeOutput, FakeTts, settle } from './fakes.js';

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
  it('greets a hub with the target and playback state, and configures speech from the settings', () => {
    const { tts, service } = setup();

    expect(service.greeting()).toEqual([
      { type: 'active', gen: 0, sessionId: null, reason: 'gone' },
      { type: 'audio', mic: 'off', engine: 'fake', device: null, error: null },
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

    service.receive({ type: 'speak', gen: 0, replyId: 'old', sessionId: 's1', text: 'Old.', tone: null, turn: null });
    service.receive({ type: 'speak', gen: 1, replyId: 'other', sessionId: 's2', text: 'Other.', tone: null, turn: null });
    expect(tts.requests).toEqual([]);
    expect(logs).toContain('reply old dropped: generation 0 is not 1');

    service.receive({ type: 'speak', gen: 1, replyId: 'r1', sessionId: 's1', text: 'One.', tone: 'calm', turn: 'm1' });
    service.receive({ type: 'speak', gen: 1, replyId: 'r2', sessionId: 's1', text: 'Two.', tone: null, turn: 'm1' });
    expect(tts.requests.map((one) => [one.text, one.tone])).toEqual([['One.', 'calm']]);
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
    service.receive({ type: 'speak', gen: 1, replyId: 'r1', sessionId: 's1', text: 'One.', tone: null, turn: null });
    await settle();
    service.receive({ type: 'speak', gen: 1, replyId: 'r2', sessionId: 's1', text: 'Two.', tone: null, turn: null });
    await settle();
    output.fail = null;
    service.receive({ type: 'speak', gen: 1, replyId: 'r3', sessionId: 's1', text: 'Three.', tone: null, turn: null });
    await settle();
    tts.requests.at(-1)!.finish();
    await settle();
    expect(sent.filter((one) => one.type === 'audio').map((one) => (one as { error: string | null }).error)).toEqual(['no device', null]);
  });
});
