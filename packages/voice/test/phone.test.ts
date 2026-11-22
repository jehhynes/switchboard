import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core/settings';
import type { LockEvent } from '../src/lockWatch.js';
import { Dictation } from '../src/dictation.js';
import type { DictationDeps } from '../src/dictation.js';
import { PHONE_CHUNK_MS, PHONE_HALF_DUPLEX, PHONE_LEAD_MS, PHONE_STALL_MS, PHONE_STALLED, PhoneCapture, PhoneOutput } from '../src/phone.js';
import { parseHubMessage } from '../src/protocol.js';
import type { VoiceMessage } from '../src/protocol.js';
import { VoiceService } from '../src/service.js';
import { BYTES_PER_MS } from '../src/tts.js';
import { Clock, FakeCapture, FakeEngine, FakeOutput, FakeTts, settle } from './fakes.js';

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
          warmSoon: () => calls.push('warm'),
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

  it('turns the mic off and plays nothing once the phone left, says why, and tells a hub that connects, until the voice is on a device again', async () => {
    const { tts, sent, service, speak, speechOf, calls, logs } = setup();

    service.receive({ type: 'device', device: 'phone' });
    speak('r1');
    tts.requests[0]!.audio(Math.round(100 * BYTES_PER_MS));
    tts.requests[0]!.finish();
    await settle();
    // The phone took the voice in the tap that turns its mic on next: the recogniser loads meanwhile.
    expect(calls.slice(-2)).toEqual(['mic false', 'warm']);
    service.receive({ type: 'device', device: 'none' });
    await settle();
    expect(speechOf('r1').at(-1)?.[0]).toBe('interrupted');
    expect(calls).toContain('mic false');
    // Only a move to the phone loads it.
    expect(calls.filter((call) => call === 'warm')).toHaveLength(1);

    // Nothing plays with no device: not on this computer's speakers either, and the outcome says why.
    speak('r2');
    expect(speechOf('r2')).toEqual([['skipped', null]]);
    expect(sent.filter((one) => one.type === 'speech').at(-1)).toMatchObject({ replyId: 'r2', reason: 'no device: the phone that had the voice left' });
    expect(logs).toContain('speech: reply r2 of session s1 skipped (no device: the phone that had the voice left), voice marin, 0 ms played, 0 of 36 characters');
    expect(tts.requests).toHaveLength(1);
    // A hub started again learns that no device has the voice.
    expect(service.greeting().at(-1)).toEqual({ type: 'device', device: 'none' });
    service.receive({ type: 'earcon', kind: 'needs-you' });
    await settle();
    expect(sent.filter((one) => one.type === 'phone-play')).toHaveLength(1);

    service.receive({ type: 'device', device: 'phone' });
    speak('r3');
    expect(tts.requests).toHaveLength(2);

    // Back on this computer it plays there.
    service.receive({ type: 'device', device: 'computer' });
    speak('r4');
    expect(tts.requests).toHaveLength(3);
    expect(service.greeting().at(-1)).toEqual({ type: 'device', device: 'computer' });
  });

  it('keeps the voice on the phone when this computer locks or disconnects, but not when it sleeps', async () => {
    const { tts, sent, service, speak, speechOf, calls, logs, lock } = setup();

    // Locked before the voice moved to the phone: the phone still plays.
    lock('locked');
    expect(sent.at(-1)).toEqual({ type: 'mic-off', reason: 'locked' });
    service.receive({ type: 'device', device: 'phone' });
    speak('r1');
    expect(tts.requests).toHaveLength(1);
    // The phone's microphone turns on, whatever this computer's lock.
    service.receive({ type: 'mic', on: true });
    expect(calls.at(-1)).toBe('mic true');

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

describe('PhoneCapture (architecture.md § Remote access, Voice on a phone)', () => {
  it('asks the page for its audio while a stream is open, delivers whole samples, and fails the stream when the phone is lost', async () => {
    const sent: VoiceMessage[] = [];
    const capture = new PhoneCapture({ send: (message) => sent.push(message) });
    const heard: number[] = [];
    const errors: string[] = [];

    // Audio before a stream opens goes nowhere.
    capture.pcm(Buffer.alloc(640));

    const stream = await capture.open(null, (pcm) => heard.push(pcm.length), (error) => errors.push(error.message));

    expect(sent).toEqual([{ type: 'phone-capture', on: true }]);
    // It starts half-duplex, for the echo check to measure, and is no Remote Desktop capture.
    expect([stream.halfDuplex, stream.remote]).toEqual([PHONE_HALF_DUPLEX, false]);
    capture.pcm(Buffer.alloc(641));
    capture.pcm(Buffer.alloc(1));
    expect(heard).toEqual([640]);

    stream.stop();
    stream.stop();
    expect(sent).toEqual([{ type: 'phone-capture', on: true }, { type: 'phone-capture', on: false }]);
    capture.pcm(Buffer.alloc(640));
    expect(heard).toEqual([640]);

    // A stream replaced by a newer one does not stop the newer one; losing the phone fails the open one only.
    const first = await capture.open(null, () => undefined, (error) => errors.push(`first: ${error.message}`));
    await capture.open(null, () => undefined, (error) => errors.push(`second: ${error.message}`));
    first.stop();
    expect(sent.at(-1)).toEqual({ type: 'phone-capture', on: true });
    capture.lost('The phone that had the voice left.');
    expect(errors).toEqual(['second: The phone that had the voice left.']);
  });

  it('reads the phone\'s audio and busy state in the protocol, and refuses bad ones', () => {
    expect(parseHubMessage('{"type":"phone-mic","pcm":"AAA="}')).toEqual({ type: 'phone-mic', pcm: 'AAA=' });
    expect(parseHubMessage('{"type":"phone-state","busy":true}')).toEqual({ type: 'phone-state', busy: true });
    expect('error' in parseHubMessage('{"type":"phone-mic","pcm":1}')).toBe(true);
    expect('error' in parseHubMessage(JSON.stringify({ type: 'phone-mic', pcm: 'A'.repeat(100_000) }))).toBe(true);
    expect('error' in parseHubMessage('{"type":"phone-state","busy":"yes"}')).toBe(true);
  });
});

describe('VoiceService dictating from the phone', () => {
  function setup(voiceprint?: unknown) {
    const clock = new Clock();
    const tts = new FakeTts();
    const output = new FakeOutput();
    const computer = new FakeCapture();
    const engine = new FakeEngine();
    const sent: VoiceMessage[] = [];
    const logs: string[] = [];
    const computerWatches: string[] = [];
    let computerBusy: ((busy: boolean, apps: string[]) => void) | null = null;
    const service: VoiceService = new VoiceService({
      tts,
      output,
      send: (message) => sent.push(message),
      dictation: (hooks) =>
        new Dictation({
          capture: hooks.capture(computer),
          recognizer: () => engine,
          vocabulary: { terms: () => [], used: () => undefined },
          turn: null,
          watchMicUse: hooks.watchMicUse(((changed) => {
            computerWatches.push('open');
            computerBusy = changed;
            return { close: () => void computerWatches.push('close') };
          }) as DictationDeps['watchMicUse']),
          settings: () => service.settings,
          ...(voiceprint === undefined ? {} : { voiceprint: voiceprint as import('../src/voiceprint.js').Voiceprint }),
          send: hooks.send,
          playing: hooks.playing,
          playedUntil: hooks.playedUntil,
          interrupt: hooks.interrupt,
          changed: hooks.changed,
          spoke: hooks.spoke,
          newId: () => `u${sent.length}`,
          now: clock.now,
          log: (line) => logs.push(line),
          setTimer: clock.setTimer,
          clearTimer: clock.clearTimer,
          every: clock.every,
        }),
      now: clock.now,
      log: (line) => logs.push(line),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      every: clock.every,
    });

    service.receive({ type: 'settings', settings: { ...DEFAULT_SETTINGS.voice, enabled: true } });
    service.receive({ type: 'targets', targets: [{ sessionId: 's1', workItemId: 1 }], focus: null });
    service.receive({ type: 'talk-here', sessionId: 's1' });

    /** The phone's page sends `ms` of audio while the recogniser reads `text`, 100 ms at a time. */
    const phoneSays = (text: string, ms: number): void => {
      engine.text = text;

      for (let at = 0; at < ms; at += 100) {
        service.receive({ type: 'phone-mic', pcm: Buffer.alloc(3_200).toString('base64') });
        clock.advance(100);
      }
    };
    const mic = () => (sent.filter((one) => one.type === 'audio').at(-1) as { mic: string; halfDuplex?: string } | undefined);

    return { clock, tts, output, computer, engine, sent, logs, computerWatches, computerBusy: () => computerBusy, service, phoneSays, mic };
  }

  it('captures from the phone, not this computer, and sends what it hears to the target', async () => {
    const { computer, sent, computerWatches, service, phoneSays, mic, engine } = setup();

    service.receive({ type: 'device', device: 'phone' });
    service.receive({ type: 'mic', on: true });
    await settle();
    // The phone's page has not said its microphone is open: paused, nothing captured yet.
    expect(computer.opens).toBe(0);
    expect(computerWatches).toEqual([]);
    expect(mic()?.mic).toBe('paused-other-app');
    expect(sent.filter((one) => one.type === 'phone-capture')).toEqual([]);

    service.receive({ type: 'phone-state', busy: false });
    await settle();
    expect(sent.filter((one) => one.type === 'phone-capture')).toEqual([{ type: 'phone-capture', on: true }]);
    expect(mic()).toMatchObject({ mic: 'listening', halfDuplex: expect.stringContaining(PHONE_HALF_DUPLEX) });
    expect(computer.opens).toBe(0);

    phoneSays('ship the fix', 500);
    engine.held = '';
    phoneSays('ship the fix', 4_000);
    await settle();
    expect(sent.filter((one) => one.type === 'utterance')).toEqual([expect.objectContaining({ sessionId: 's1', text: 'ship the fix', final: true })]);

    // Mic off stops the phone's capture.
    service.receive({ type: 'mic', on: false });
    expect(sent.filter((one) => one.type === 'phone-capture').at(-1)).toEqual({ type: 'phone-capture', on: false });
  });

  it('pauses and drops what it was hearing when the phone is busy, and stops the phone\'s capture when the voice moves', async () => {
    const { computer, sent, service, phoneSays, mic } = setup();

    service.receive({ type: 'device', device: 'phone' });
    service.receive({ type: 'mic', on: true });
    service.receive({ type: 'phone-state', busy: false });
    await settle();
    phoneSays('take the call', 600);
    // A call mutes the phone's track: nothing of the utterance goes out.
    service.receive({ type: 'phone-state', busy: true });
    await settle();
    expect(mic()?.mic).toBe('paused-other-app');
    expect(sent.filter((one) => one.type === 'phone-capture').at(-1)).toEqual({ type: 'phone-capture', on: false });
    phoneSays('take the call', 4_000);
    await settle();
    expect(sent.filter((one) => one.type === 'utterance' && one.final)).toEqual([]);

    service.receive({ type: 'phone-state', busy: false });
    await settle();
    expect(mic()?.mic).toBe('listening');

    // The voice moving to this computer turns the mic off and stops the phone's capture; turned on, it captures here.
    service.receive({ type: 'device', device: 'computer' });
    await settle();
    expect(sent.filter((one) => one.type === 'phone-capture').at(-1)).toEqual({ type: 'phone-capture', on: false });
    expect(mic()?.mic).toBe('off');
    // The phone's late audio and state go nowhere now.
    service.receive({ type: 'phone-state', busy: true });
    service.receive({ type: 'mic', on: true });
    await settle();
    expect(computer.opens).toBe(0);
  });

  it('keeps the mic off with no device, and refuses enrolment away from this computer', async () => {
    const { sent, service, logs, mic } = setup();

    service.receive({ type: 'device', device: 'phone' });
    service.receive({ type: 'enroll', action: 'start' });
    expect(sent.at(-1)).toEqual({ type: 'enrollment', state: 'failed', error: 'The voice is on the phone. Take it back to this computer to record your voice.' });

    service.receive({ type: 'device', device: 'none' });
    service.receive({ type: 'mic', on: true });
    await settle();
    expect(logs.at(-1)).toBe('mic stays off: the phone that had the voice left');
    expect(mic()?.mic ?? 'off').toBe('off');
  });


  it('plays a spoken alert on the phone and takes its answer from the phone\'s microphone, sending nothing to a session', async () => {
    const { clock, tts, sent, service, phoneSays } = setup();

    service.receive({ type: 'targets', targets: [{ sessionId: 's1', workItemId: 1 }, { sessionId: 's2', workItemId: 2 }], focus: null });
    service.receive({ type: 'device', device: 'phone' });
    service.receive({ type: 'mic', on: true });
    service.receive({ type: 'phone-state', busy: false });
    await settle();
    service.receive({ type: 'alert', alertId: 'a1', sessionId: 's2', cause: 'turn-finished', title: 'Fix the badge', persona: null, detail: 'The badge is fixed.', ...VOICE });

    for (let round = 0; round < 10 && tts.requests.length === 0; round++) {
      clock.advance(500);
      await settle();
    }

    // The alert's line plays on the phone, not this computer's speaker.
    expect(tts.requests).toHaveLength(1);
    tts.requests[0]!.audio(Math.round(300 * BYTES_PER_MS));
    tts.requests[0]!.finish();
    await settle();

    const play = sent.find((one) => one.type === 'phone-play') as { id: number };

    expect(play).toBeDefined();
    service.receive({ type: 'phone-played', id: play.id, ms: 300, done: true });
    await settle();
    clock.advance(300);
    await settle();

    // The answer comes from the phone; it goes to no session.
    phoneSays('yes', 600);
    phoneSays('yes', 4_000);
    await settle();
    expect(sent.filter((one) => one.type === 'utterance')).toEqual([]);
    expect(tts.requests.length).toBeGreaterThan(1);
    expect(sent.filter((one) => one.type === 'active').at(-1)).toMatchObject({ sessionId: 's2', reason: 'talk-here' });
  });

  it('checks the phone\'s pieces against the existing voiceprint, dropping another voice', async () => {
    const checked: string[] = [];
    const voiceprint = {
      enrolled: true,
      replyVoiceScore: () => null,
      unavailable: () => null,
      enroll: () => ({ windows: 0, f0: 0 }),
      learnVoice: () => undefined,
      check: (_audio: Float32Array, text: string) => {
        checked.push(text);
        return text.includes('someone') ? { score: 0.2, f0: 220, dropped: true, reason: 'another voice' } : { score: 0.9, f0: 110, dropped: false, reason: null };
      },
    };
    const { sent, service, phoneSays } = setup(voiceprint);

    service.receive({ type: 'device', device: 'phone' });
    service.receive({ type: 'mic', on: true });
    service.receive({ type: 'phone-state', busy: false });
    await settle();
    phoneSays('someone else talking', 600);
    phoneSays('someone else talking', 4_000);
    await settle();
    expect(checked).toContain('someone else talking');
    expect(sent.filter((one) => one.type === 'utterance' && one.final)).toEqual([]);

    phoneSays('ship it', 600);
    phoneSays('ship it', 4_000);
    await settle();
    expect(sent.filter((one) => one.type === 'utterance' && one.final)).toEqual([expect.objectContaining({ text: 'ship it' })]);
  });
});
