import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core/settings';
import type { LockEvent } from '../src/lockWatch.js';
import { PHONE_CHUNK_MS, PHONE_LEAD_MS, PHONE_STALL_MS, PHONE_STALLED, PhoneOutput } from '../src/phone.js';
import { parseHubMessage } from '../src/protocol.js';
import type { VoiceMessage } from '../src/protocol.js';
import { VoiceService } from '../src/service.js';
import { BYTES_PER_MS } from '../src/tts.js';
import { Clock, FakeOutput, FakeTts, settle } from './fakes.js';

const VOICE = { voice: 'marin', style: 'none', personality: null } as const;
const MS = (ms: number): Buffer => Buffer.alloc(Math.round(ms * BYTES_PER_MS));

describe('PhoneOutput (architecture.md § Remote access, Voice on a phone)', () => {
  it('sends a playback\'s audio in pieces, never more than the lead ahead of what the phone reports heard, and positions it by those reports', async () => {
    const sent: VoiceMessage[] = [];
    const phone = new PhoneOutput({ send: (message) => sent.push(message), now: () => 0, every: () => ({ stop: () => undefined }) });
    const playback = await phone.open();
    const pcmMs = () => sent.filter((one) => one.type === 'phone-pcm').reduce((sum, one) => sum + Buffer.from((one as { pcm: string }).pcm, 'base64').length / BYTES_PER_MS, 0);

    expect(sent).toEqual([{ type: 'phone-play', id: 1 }]);

    let written = false;
    const write = playback.write(MS(1_000)).then(() => (written = true));

    await settle();
    // Only the lead went; each piece is one chunk at most.
    expect(pcmMs()).toBeLessThanOrEqual(PHONE_LEAD_MS);
    expect(pcmMs()).toBeGreaterThan(PHONE_LEAD_MS - PHONE_CHUNK_MS);
    expect(sent.filter((one) => one.type === 'phone-pcm').every((one) => Buffer.from((one as { pcm: string }).pcm, 'base64').length <= PHONE_CHUNK_MS * BYTES_PER_MS)).toBe(true);
    expect(written).toBe(false);

    // A report of another playback or a heard time going back changes nothing.
    phone.played(9, 900, false);
    phone.played(1, 200, false);
    phone.played(1, 100, false);
    await settle();
    expect(playback.position()).toBe(200);
    expect(pcmMs()).toBeLessThanOrEqual(200 + PHONE_LEAD_MS);
    expect(pcmMs()).toBeGreaterThan(200 + PHONE_LEAD_MS - PHONE_CHUNK_MS);

    // Reports of what was sent let the rest go.
    for (let round = 0; round < 10 && !written; round++) {
      phone.played(1, pcmMs(), false);
      await settle();
    }

    await write;
    expect(written).toBe(true);
    expect(pcmMs()).toBe(1_000);

    let drained = false;
    const drain = playback.drain().then(() => (drained = true));

    expect(sent.at(-1)).toEqual({ type: 'phone-end', id: 1 });
    await settle();
    expect(drained).toBe(false);
    phone.played(1, 950, true);
    await drain;
    expect(playback.position()).toBe(1_000);
    playback.stop();
    // A playback that ended needs no flush.
    expect(sent.filter((one) => one.type === 'phone-flush')).toEqual([]);
  });

  it('flushes a stopped playback, lets its held write go, and fails the end of every playback when the phone is lost', async () => {
    const sent: VoiceMessage[] = [];
    const phone = new PhoneOutput({ send: (message) => sent.push(message), now: () => 0, every: () => ({ stop: () => undefined }) });
    const first = await phone.open();
    const held = first.write(MS(500));

    await settle();
    first.stop();
    await held;
    expect(sent.at(-1)).toEqual({ type: 'phone-flush', id: 1 });
    await expect(first.drain()).resolves.toBeUndefined();
    // Reports for a stopped playback are dropped.
    phone.played(1, 400, true);

    const second = await phone.open();

    await second.write(MS(100));

    const ended = second.drain();

    phone.lost('The phone that had the voice left.');
    await expect(ended).rejects.toThrow('The phone that had the voice left.');
    await expect(second.drain()).rejects.toThrow('The phone that had the voice left.');
    // Writing to a lost playback sends nothing.
    const count = sent.length;

    await second.write(MS(100));
    expect(sent).toHaveLength(count);
  });

  it('never counts a report beyond what was sent, nor an end before it was sent', async () => {
    const sent: VoiceMessage[] = [];
    const phone = new PhoneOutput({ send: (message) => sent.push(message), now: () => 0, every: () => ({ stop: () => undefined }) });
    const playback = await phone.open();
    const write = playback.write(MS(1_000));

    await settle();
    // An inflated report lifts the lead only as far as what was sent.
    phone.played(1, 60_000, false);
    await settle();
    expect(playback.position()).toBeLessThanOrEqual(PHONE_LEAD_MS);
    // An early end is ignored: the write goes on, and the end still waits for a real one.
    phone.played(1, 60_000, true);

    let written = false;
    const finished = write.then(() => (written = true));

    for (let round = 0; round < 10 && !written; round++) {
      phone.played(1, 2_000, false);
      await settle();
    }

    await finished;

    let drained = false;
    const drain = playback.drain().then(() => (drained = true));

    await settle();
    expect(drained).toBe(false);
    phone.played(1, 1_000, true);
    await drain;
  });

  it('fails every playback and says so when the phone stops reporting while a write or the end waits on it', async () => {
    const clock = new Clock();
    const stalls: string[] = [];
    const phone = new PhoneOutput({ send: () => undefined, now: clock.now, every: clock.every, stalled: (why) => stalls.push(why) });
    const playback = await phone.open();
    const write = playback.write(MS(1_000));

    await settle();
    // Progress keeps it alive.
    clock.advance(PHONE_STALL_MS - 500);
    phone.played(1, 100, false);
    await settle();
    clock.advance(PHONE_STALL_MS - 500);
    expect(stalls).toEqual([]);
    clock.advance(1_000);
    await write;
    expect(stalls).toEqual([PHONE_STALLED]);
    await expect(playback.drain()).rejects.toThrow(PHONE_STALLED);

    // An end that never comes stalls too.
    const second = await phone.open();

    await second.write(MS(100));

    const end = second.drain();

    clock.advance(PHONE_STALL_MS + 500);
    await expect(end).rejects.toThrow(PHONE_STALLED);
    expect(stalls).toHaveLength(2);
  });

  it('reads the device and the phone\'s reports in the protocol, and refuses bad ones', () => {
    expect(parseHubMessage('{"type":"device","device":"phone"}')).toEqual({ type: 'device', device: 'phone' });
    expect(parseHubMessage('{"type":"device","device":"tablet"}')).toEqual({ error: 'Invalid device message.' });
    expect(parseHubMessage('{"type":"phone-played","id":3,"ms":120.5,"done":false}')).toEqual({ type: 'phone-played', id: 3, ms: 120.5, done: false });
    expect(parseHubMessage('{"type":"phone-played","id":3,"ms":-1,"done":false}')).toHaveProperty('error');
    expect(parseHubMessage('{"type":"phone-played","id":"3","ms":1,"done":false}')).toHaveProperty('error');
  });
});

describe('VoiceService with the voice on the phone', () => {
  function setup() {
    const clock = new Clock();
    const tts = new FakeTts();
    const output = new FakeOutput();
    const sent: VoiceMessage[] = [];
    const logs: string[] = [];
    const calls: string[] = [];
    let lock!: (event: LockEvent) => void;
    const service = new VoiceService({
      tts,
      output,
      send: (message) => sent.push(message),
      watchLock: (changed) => {
        lock = changed;
        return { close: () => undefined };
      },
      dictation: () =>
        ({
          state: 'off',
          halfDuplex: null,
          error: null,
          recognizer: null,
          mic: (on: boolean) => calls.push(`mic ${on}`),
          enroll: (action: string) => calls.push(`enroll ${action}`),
          target: () => undefined,
          settingsChanged: () => undefined,
          reference: () => undefined,
          close: () => undefined,
        }) as unknown as import('../src/dictation.js').Dictation,
      now: clock.now,
      log: (line) => logs.push(line),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      every: clock.every,
    });

    service.receive({ type: 'settings', settings: { ...DEFAULT_SETTINGS.voice, enabled: true } });
    service.receive({ type: 'targets', targets: [{ sessionId: 's1', workItemId: 1 }], focus: null });
    service.receive({ type: 'talk-here', sessionId: 's1' });

    const speak = (replyId: string): void => service.receive({ type: 'speak', gen: 1, replyId, sessionId: 's1', text: 'Tests passed and the build is ready.', tone: null, turn: replyId, ...VOICE });
    const speechOf = (replyId: string) => sent.filter((one) => one.type === 'speech' && one.replyId === replyId).map((one) => [(one as { state: string }).state, (one as { atMs: number | null }).atMs]);

    return { clock, tts, output, sent, logs, calls, service, speak, speechOf, lock: (event: LockEvent) => lock(event) };
  }

  it('plays replies on the phone, reports where the phone says it stopped, and stops what plays when the voice moves', async () => {
    const { clock, tts, output, sent, service, speak, speechOf, logs } = setup();

    service.receive({ type: 'device', device: 'phone' });
    expect(logs).toContain('voice device: the phone (was computer)');
    speak('r1');
    tts.requests[0]!.audio(Math.round(200 * BYTES_PER_MS));
    await settle();
    expect(output.playbacks).toEqual([]);
    expect(sent.find((one) => one.type === 'phone-play')).toEqual({ type: 'phone-play', id: 1 });
    expect(speechOf('r1')).toEqual([['playing', 0]]);

    // The clock says 2 s passed, but the phone heard 120 ms: Stop reports the phone's position.
    clock.advance(2_000);
    service.receive({ type: 'phone-played', id: 1, ms: 120, done: false });
    service.receive({ type: 'stop' });
    expect(speechOf('r1').at(-1)).toEqual(['interrupted', 120]);
    expect(sent).toContainEqual({ type: 'phone-flush', id: 1 });

    // A reply played to its end ends when the phone says so.
    speak('r2');
    tts.requests[1]!.audio(Math.round(100 * BYTES_PER_MS));
    tts.requests[1]!.finish();
    await settle();
    expect(sent.at(-1)).toEqual({ type: 'phone-end', id: 2 });
    expect(speechOf('r2')).toEqual([['playing', 0]]);
    service.receive({ type: 'phone-played', id: 2, ms: 100, done: true });
    await settle();
    expect(speechOf('r2').at(-1)).toEqual(['played', 100]);

    // Moving the voice to this computer stops the reply on the phone; the next plays here.
    speak('r3');
    tts.requests[2]!.audio(Math.round(100 * BYTES_PER_MS));
    await settle();
    service.receive({ type: 'device', device: 'computer' });
    await settle();
    expect(speechOf('r3').at(-1)?.[0]).toBe('interrupted');
    speak('r4');
    tts.requests[3]!.audio(480);
    await settle();
    expect(output.playbacks).toHaveLength(1);
  });

  it('counts a long reply\'s position from the phone while its write still waits, and stops a needs-you sound playing here when the voice moves', async () => {
    const { tts, output, sent, service, speak, speechOf } = setup();

    service.receive({ type: 'device', device: 'phone' });
    speak('r1');
    // One 2 s chunk: the write waits on the lead while the phone plays.
    tts.requests[0]!.audio(Math.round(2_000 * BYTES_PER_MS));
    await settle();
    expect(speechOf('r1')).toEqual([['playing', 0]]);
    service.receive({ type: 'phone-played', id: 1, ms: 250, done: false });
    await settle();
    service.receive({ type: 'stop' });
    expect(speechOf('r1').at(-1)).toEqual(['interrupted', 250]);
    expect(sent.filter((one) => one.type === 'speech' && one.replyId === 'r1').at(-1)).toMatchObject({ said: expect.any(Number) });
    expect((sent.filter((one) => one.type === 'speech' && one.replyId === 'r1').at(-1) as { said: number }).said).toBeGreaterThan(0);

    // A needs-you sound playing on this computer stops when the voice moves to the phone.
    service.receive({ type: 'device', device: 'computer' });
    output.playbacks.length = 0;
    service.receive({ type: 'earcon', kind: 'needs-you' });
    await settle();
    expect(output.playbacks).toHaveLength(1);
    output.playbacks[0]!.hold = new Promise(() => undefined);
    service.receive({ type: 'device', device: 'phone' });
    expect(output.playbacks[0]!.stopped).toBe(true);
  });

  it('tells the hub when the phone stalls', async () => {
    const { clock, tts, sent, service, speak } = setup();

    service.receive({ type: 'device', device: 'phone' });
    speak('r1');
    tts.requests[0]!.audio(Math.round(1_000 * BYTES_PER_MS));
    await settle();
    clock.advance(PHONE_STALL_MS + 500);
    await settle();
    expect(sent).toContainEqual({ type: 'phone-stalled', reason: PHONE_STALLED });
  });

  it('turns the mic off and plays nothing once the phone left, until the voice is on a device again', async () => {
    const { tts, sent, service, speak, speechOf, calls } = setup();

    service.receive({ type: 'device', device: 'phone' });
    speak('r1');
    tts.requests[0]!.audio(Math.round(100 * BYTES_PER_MS));
    tts.requests[0]!.finish();
    await settle();
    service.receive({ type: 'device', device: 'none' });
    await settle();
    expect(speechOf('r1').at(-1)?.[0]).toBe('interrupted');
    expect(calls).toContain('mic false');

    // Nothing plays with no device: not on this computer's speakers either.
    speak('r2');
    expect(speechOf('r2')).toEqual([['skipped', null]]);
    expect(tts.requests).toHaveLength(1);
    service.receive({ type: 'earcon', kind: 'needs-you' });
    await settle();
    expect(sent.filter((one) => one.type === 'phone-play')).toHaveLength(1);

    service.receive({ type: 'device', device: 'phone' });
    speak('r3');
    expect(tts.requests).toHaveLength(2);
  });

  it('keeps the voice on the phone when this computer locks or disconnects, but not when it sleeps', async () => {
    const { tts, sent, service, speak, speechOf, calls, logs, lock } = setup();

    // Locked before the voice moved to the phone: the phone still plays.
    lock('locked');
    expect(sent.at(-1)).toEqual({ type: 'mic-off', reason: 'locked' });
    service.receive({ type: 'device', device: 'phone' });
    speak('r1');
    expect(tts.requests).toHaveLength(1);
    // This slice's phone has no microphone: the mic stays off there.
    service.receive({ type: 'mic', on: true });
    expect(calls.at(-1)).toBe('mic false');
    expect(logs.at(-1)).toBe('mic stays off: the voice is not on this computer');

    const offs = sent.filter((one) => one.type === 'mic-off').length;

    lock('locked');
    lock('disconnected');
    expect(logs.slice(-2)).toEqual(['computer locked: the voice stays on the phone', 'session disconnected: the voice stays on the phone']);
    expect(sent.filter((one) => one.type === 'mic-off')).toHaveLength(offs);
    expect(speechOf('r1')).toEqual([]);

    lock('asleep');
    expect(sent.at(-1)).toEqual({ type: 'mic-off', reason: 'asleep' });
    expect(speechOf('r1').at(-1)?.[0]).toBe('interrupted');
  });
});
