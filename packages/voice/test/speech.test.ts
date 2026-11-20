import { describe, expect, it } from 'vitest';
import { needsYouChime } from '../src/output.js';
import type { VoiceMessage } from '../src/protocol.js';
import { PROGRESS_MS, Speech } from '../src/speech.js';
import type { SpeechItem } from '../src/speech.js';
import { Clock, FakeOutput, FakeTts, settle } from './fakes.js';

function setup() {
  const clock = new Clock();
  const tts = new FakeTts();
  const output = new FakeOutput();
  const reports: VoiceMessage[] = [];
  const failures: Array<string | null> = [];
  const logs: string[] = [];
  const speech = new Speech({ tts, output, device: () => 'Speakers', report: (message) => reports.push(message), failed: (error) => failures.push(error), now: clock.now, log: (line) => logs.push(line), every: clock.every });
  const states = (): string[] => reports.filter((one) => one.type === 'speech').map((one) => `${(one as { replyId: string }).replyId} ${(one as { state: string }).state}`);

  return { clock, tts, output, reports, failures, speech, states, logs };
}

const item = (replyId: string, turn: string | null = 'm1', text = 'Fixed the badge.'): SpeechItem => ({ gen: 3, replyId, sessionId: 's1', text, tone: null, turn });

describe('Speech', () => {
  it('logs each reply whose speech ended: played, cut off, skipped, failed or stopped by a move, with its session, voice and duration', async () => {
    const { clock, tts, speech, logs } = setup();
    const said = (line: string): boolean => line.startsWith('speech: ');

    speech.speak({ ...item('r1', 'm1', 'x'.repeat(100)), as: { voice: 'marin', style: 'none', personality: null } });
    await settle();
    tts.requests[0]!.audio(48_000);
    tts.requests[0]!.finish();
    await settle();
    speech.speak(item('r2', 'm2', 'x'.repeat(10)));
    speech.speak(item('r3', 'm2'));
    await settle();
    tts.requests[1]!.audio(48_000);
    await settle();
    clock.advance(400);
    speech.stop();
    speech.speak(item('r4', 'm3'));
    speech.speak(item('r5', 'm3'));
    await settle();
    speech.halt();
    expect(logs.filter(said)).toEqual([
      'speech: reply r1 of session s1 played, voice marin, 1000 ms played, 100 of 100 characters',
      'speech: reply r2 of session s1 interrupted, voice default, 400 ms played, 4 of 10 characters',
      'speech: reply r3 of session s1 skipped, voice default, 0 ms played, 0 of 16 characters',
      'speech: reply r4 of session s1 stopped: voice moved, voice default, 0 ms played, 0 of 16 characters',
      'speech: reply r5 of session s1 stopped: voice moved, voice default, 0 ms played, 0 of 16 characters',
    ]);
  });

  it('plays a reply as its audio comes, reports its position every 150 ms, and reports it played once drained', async () => {
    const { clock, tts, output, reports, failures, speech, states } = setup();

    speech.speak(item('r1', 'm1', 'x'.repeat(100)));
    expect(speech.playing?.replyId).toBe('r1');
    await settle();
    expect(output.devices).toEqual(['Speakers']);
    tts.requests[0]!.audio(48_000);
    await settle();
    expect(states()).toEqual(['r1 playing']);
    expect(reports[0]).toEqual({ type: 'speech', gen: 3, replyId: 'r1', sessionId: 's1', state: 'playing', atMs: 0, said: 0 });
    clock.advance(PROGRESS_MS * 2);
    // 300 ms of 1000 written; until all audio came, the passage counts as at least 65 ms a character.
    expect(reports.filter((one) => one.type === 'progress').at(-1)).toEqual({ type: 'progress', gen: 3, replyId: 'r1', sessionId: 's1', chars: 5, atMs: 300 });
    tts.requests[0]!.finish();
    await settle();
    expect(output.playbacks[0]!.drained).toBe(true);
    expect(reports.at(-1)).toEqual({ type: 'speech', gen: 3, replyId: 'r1', sessionId: 's1', state: 'played', atMs: 1000, said: 100 });
    expect(failures).toEqual([null]);
    expect(speech.playing).toBeNull();
  });

  it("plays one turn's replies in order, and skips a waiting reply once a newer turn's reply waits (decision 24)", async () => {
    const { tts, speech, states } = setup();

    speech.speak(item('r1', 'm1'));
    speech.speak(item('r2', 'm1'));
    speech.speak(item('r3', 'm1'));
    speech.speak(item('r4', 'm2'));
    await settle();
    tts.requests[0]!.finish();
    await settle();
    // r2 and r3 answer m1, but r4, of a newer turn, waits.
    expect(states()).toEqual(['r1 played', 'r2 skipped', 'r3 skipped']);
    expect(tts.requests.map((one) => one.text)).toHaveLength(2);
    tts.requests[1]!.finish();
    await settle();
    expect(states()).toEqual(['r1 played', 'r2 skipped', 'r3 skipped', 'r4 played']);
  });

  it('interrupts the playing reply where it stopped on Stop speaking and skips the waiting ones', async () => {
    const { clock, tts, output, reports, speech, states } = setup();

    speech.speak(item('r1', 'm1', 'x'.repeat(10)));
    speech.speak(item('r2', 'm1'));
    await settle();
    tts.requests[0]!.audio(48_000);
    await settle();
    clock.advance(400);
    speech.stop();
    expect(states()).toEqual(['r1 playing', 'r1 interrupted', 'r2 skipped']);
    expect(reports.find((one) => one.type === 'speech' && one.state === 'interrupted')).toMatchObject({ atMs: 400, said: 4 });
    expect(output.playbacks[0]!.stopped).toBe(true);
    expect(tts.requests[0]!.cancelled).toBe(true);
    expect(speech.playing).toBeNull();
  });

  it('skips a cancelled reply, playing or waiting, and goes on with the next', async () => {
    const { tts, speech, states } = setup();

    speech.speak(item('r1'));
    speech.speak(item('r2'));
    speech.speak(item('r3'));
    speech.cancel('r2');
    speech.cancel('r1');
    speech.cancel('gone');
    await settle();
    expect(states()).toEqual(['r2 skipped', 'r1 skipped']);
    expect(speech.playing?.replyId).toBe('r3');
    expect(tts.requests[0]!.cancelled).toBe(true);
  });

  it('drops everything unreported when the voice target moves', async () => {
    const { tts, output, reports, speech } = setup();

    speech.speak(item('r1'));
    speech.speak(item('r2'));
    await settle();
    speech.halt();
    await settle();
    expect(reports).toEqual([]);
    expect(speech.queued).toEqual([]);
    expect(tts.requests[0]!.cancelled).toBe(true);
    expect(output.playbacks[0]!.stopped).toBe(true);
  });

  it('says until when it plays: always while a reply is requested or plays or the needs-you sound plays, then when it stopped', async () => {
    const { clock, tts, output, speech } = setup();

    expect(speech.playedUntil).toBe(-Infinity);
    clock.advance(1_000);
    speech.speak(item('r1'));
    // From the request, before any audio comes.
    expect(speech.playedUntil).toBe(Infinity);
    await settle();
    tts.requests[0]!.audio(4_800);
    tts.requests[0]!.finish();
    await settle();
    expect(speech.playedUntil).toBe(1_000);
    clock.advance(500);
    speech.speak(item('r2', 'm2'));
    clock.advance(200);
    speech.stop();
    expect(speech.playedUntil).toBe(1_700);

    clock.advance(300);
    speech.earcon();
    expect(speech.playedUntil).toBe(Infinity);
    await settle();
    expect(output.playbacks.at(-1)!.drained).toBe(true);
    expect(speech.playedUntil).toBe(2_000);
  });

  it('plays the needs-you sound at once, or after the reply playing now and before the next', async () => {
    const { tts, output, speech, states } = setup();

    speech.earcon();
    await settle();
    expect(output.playbacks[0]!.written).toEqual([needsYouChime()]);
    expect(output.playbacks[0]!.drained).toBe(true);

    speech.speak(item('r1'));
    speech.speak(item('r2'));
    speech.earcon();
    await settle();
    expect(output.playbacks).toHaveLength(2);
    tts.requests[0]!.finish();
    await settle();
    // The chime played between the two replies.
    expect(output.playbacks[2]!.written).toEqual([needsYouChime()]);
    expect(states()).toEqual(['r1 played']);
    expect(tts.requests).toHaveLength(2);
    expect(needsYouChime().length).toBe(2 * Math.round(24 * 110) + 2 * Math.round(24 * 160));
  });

  it('reports a reply failed when speech or playback fails, with why for the audio report, and goes on', async () => {
    const { tts, output, failures, speech, states } = setup();

    tts.throws = new Error('No OpenAI key');
    speech.speak(item('r1'));
    tts.throws = null;
    await settle();
    output.fail = new Error('no device');
    speech.speak(item('r2'));
    await settle();
    output.fail = null;
    speech.speak(item('r3'));
    await settle();
    tts.requests.at(-1)!.fail(new Error('speech connection closed'));
    await settle();
    output.fail = new Error('no device');
    speech.earcon();
    await settle();
    expect(states()).toEqual(['r1 failed', 'r2 failed', 'r3 failed']);
    expect(failures).toEqual(['No OpenAI key', 'no device', 'speech connection closed', 'no device']);
  });
  it('stops the playing reply on a barge-in with how much of it played, skips the rest of its turn, and plays the next turn\'s replies', async () => {
    const { clock, tts, speech, states } = setup();

    speech.speak(item('r1', 'm1', 'x'.repeat(100)));
    speech.speak(item('r2', 'm1'));
    await settle();
    tts.requests[0]!.audio(48_000);
    await settle();
    clock.advance(400);

    const stopped = speech.interrupt();

    // 400 ms of a passage whose audio is still coming, at 65 ms a character at least.
    expect(stopped).toMatchObject({ item: { replyId: 'r1' }, atMs: 400, said: 6 });
    expect(states()).toEqual(['r1 playing', 'r1 interrupted', 'r2 skipped']);
    expect(tts.requests[0]!.cancelled).toBe(true);
    // A later reply of the turn spoken over is not heard; the answer to the interrupting message is.
    speech.speak(item('r3', 'm1'));
    expect(states().at(-1)).toBe('r3 skipped');
    speech.speak(item('r4', 'm2'));
    expect(speech.playing?.replyId).toBe('r4');
    speech.speak(item('r5', 'm1'));
    expect(speech.queued.map((one) => one.replyId)).toEqual(['r5']);
    expect(speech.interrupt()).toMatchObject({ item: { replyId: 'r4' } });
    expect(speech.interrupt()).toBeNull();
  });
});
