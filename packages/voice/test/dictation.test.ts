import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core/settings';
import type { VoiceSettings } from '@switchboard/core/settings';
import { ASR_RATE, PHRASE_SILENCE_MS } from '../src/asr.js';
import { COLLECT_AFTER_DROP_MS, Dictation, RECOGNISER_IDLE_MS, WARM_RELEASE_MS, WARM_RETRY_MS, WARM_SETTLE_MS, WARM_SOON_MS } from '../src/dictation.js';
import type { AudioDevices } from '../src/micUse.js';
import { ENROLL_SECONDS } from '../src/protocol.js';
import type { VoiceMessage } from '../src/protocol.js';
import type { ChatTurn } from '../src/turn.js';
import type { PieceCheck, Voiceprint } from '../src/voiceprint.js';
import { Clock, FakeCapture, FakeEngine, settle } from './fakes.js';

type Sent = Extract<VoiceMessage, { type: 'words' | 'piece' | 'utterance' | 'enrollment' | 'command' }>;

/** A voice check that passes a piece unless `verdict` fails it, and an enrolment that saves unless told to fail. */
function fakeVoiceprint(options: { verdict?: (text: string) => PieceCheck | null; unavailable?: string; enrollError?: string; replyVoice?: number | null; enrolled?: boolean } = {}) {
  const voiceprint = {
    enrolled: options.enrolled ?? false,
    replyVoiceScore: () => options.replyVoice ?? null,
    checks: [] as Array<{ text: string; samples: number }>,
    enrolls: [] as number[],
    unavailable: () => options.unavailable ?? null,
    check: (audio: Float32Array, text: string): PieceCheck => {
      voiceprint.checks.push({ text, samples: audio.length });
      return options.verdict?.(text) ?? { score: 0.9, f0: 110, dropped: false, reason: null };
    },
    enroll: (samples: Float32Array) => {
      voiceprint.enrolls.push(samples.length);

      if (options.enrollError !== undefined) {
        throw new Error(options.enrollError);
      }

      return { windows: 20, f0: 107 };
    },
  };

  return voiceprint;
}

function setup(options: { turn?: (chat: ChatTurn[]) => number; watcher?: 'none' | 'manual'; recognizer?: { error: string }; settings?: Partial<VoiceSettings>; voiceprint?: ReturnType<typeof fakeVoiceprint> } = {}) {
  const clock = new Clock();
  const capture = new FakeCapture();
  const engine = new FakeEngine();
  const sent: Sent[] = [];
  const logs: string[] = [];
  const chats: ChatTurn[][] = [];
  const termsAsked: Array<string | null> = [];
  const loads: string[][] = [];
  /** Each load and each free, in order, with the clock's time. */
  const recognizers: Array<{ load: boolean; at: number }> = [];
  const used: string[] = [];
  let spoke = 0;
  let changed = 0;
  let turnClosed = 0;
  /** The reply the fake speech plays, and what a barge-in's stop answers. */
  const speech: { playing: { replyId: string; text: string; voice: string } | null; until: number; interrupts: number; heard: { said: string; rest: string } } = { playing: null, until: -Infinity, interrupts: 0, heard: { said: '', rest: '' } };
  let id = 0;
  /** `devices` takes endpoint IDs or makes them from the names. */
  const watch: { changed: ((busy: boolean, apps: string[]) => void) | null; failed: (() => void) | null; devices: ((devices: Omit<AudioDevices, 'outputId' | 'inputId'> & Partial<AudioDevices>) => void) | null; closed: number } = { changed: null, failed: null, devices: null, closed: 0 };
  const settings: VoiceSettings = { ...DEFAULT_SETTINGS.voice, enabled: true, ...options.settings };
  const dictation = new Dictation({
    capture,
    recognizer: (terms) => {
      loads.push(terms);
      recognizers.push({ load: true, at: clock.t });
      return options.recognizer ?? engine;
    },
    vocabulary: {
      terms: (repo) => {
        termsAsked.push(repo);
        return repo === null ? ['Switchboard'] : ['Switchboard', repo];
      },
      used: (text) => used.push(text),
    },
    turn:
      options.turn === undefined
        ? null
        : {
            threshold: 0.011,
            probability: async (chat) => {
              chats.push(chat);
              return options.turn!(chat);
            },
            close: () => void turnClosed++,
          },
    watchMicUse: (onChanged, onFailed, onDevices) => {
      if (options.watcher === 'none') {
        return null;
      }

      watch.changed = onChanged;
      watch.failed = onFailed;
      watch.devices = (devices) => onDevices({ outputId: `${devices.output}#1`, inputId: `${devices.input}#1`, ...devices });
      return { close: () => void watch.closed++ };
    },
    settings: () => settings,
    ...(options.voiceprint === undefined ? {} : { voiceprint: options.voiceprint as unknown as Voiceprint }),
    playing: () => speech.playing,
    playedUntil: () => speech.until,
    interrupt: () => {
      const playing = speech.playing;

      speech.interrupts++;
      speech.playing = null;
      return playing === null ? null : { replyId: playing.replyId, ...speech.heard };
    },
    send: (message) => sent.push(message),
    changed: () => void changed++,
    spoke: () => void spoke++,
    newId: () => `id${++id}`,
    now: clock.now,
    log: (line) => logs.push(line),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    every: clock.every,
  });
  /** Says `text` (the recogniser's whole text so far) and lets `ms` of audio pass, 100 ms at a time. */
  const say = (text: string, ms = 100): void => {
    engine.text = text;

    for (let at = 0; at < ms; at += 100) {
      capture.pcm(100);
      clock.advance(100);
    }
  };
  const quiet = (ms: number): void => say(engine.text, ms);
  /** As `say`, with audio loud enough for barge-in to check. */
  const loud = (text: string, ms = 100): void => {
    engine.text = text;

    for (let at = 0; at < ms; at += 100) {
      capture.tone(100, 200);
      clock.advance(100);
    }
  };
  /** Mic on with the watcher saying no other app records, and a target. */
  const listening = async (): Promise<void> => {
    dictation.target(1, 's1', 'acme/app');
    dictation.mic(true);
    watch.changed?.(false, []);
    await settle();
  };

  engine.free = () => {
    engine.freed++;
    recognizers.push({ load: false, at: clock.t });
  };

  return { clock, capture, engine, sent, logs, chats, termsAsked, loads, recognizers, used, watch, settings, dictation, say, quiet, loud, listening, speech, spoke: () => spoke, changed: () => changed, turnClosed: () => turnClosed };
}

/** A WAV's PCM from `fixtures/echo`: real captures of a reply played aloud (README.md there). */
const echoWav = (name: string): Buffer => readFileSync(new URL(`./fixtures/echo/${name}`, import.meta.url)).subarray(44);
const PLAYED = echoWav('played.wav');
const PLAYED_TEXT = 'Tests passed and the new build is ready';

/**
 * Plays `PLAYED` as reply `replyId` from 0.5 s into `captured`, handing the voice's audio over in 20 ms pieces as it plays, while the capture
 * delivers `captured` in 100 ms chunks, as the saved captures were recorded; then 0.4 s of silence, so the echo check has measured. `during`
 * runs at each chunk while the reply plays.
 */
function playOver(t: ReturnType<typeof setup>, captured: Buffer, replyId: string, during?: () => void, tailChunks = 4): void {
  const start = t.clock.t;
  let played = 0;

  for (let at = 0; at < captured.length + tailChunks * 3_200; at += 3_200) {
    for (let step = 0; step < 5; step++) {
      if (t.clock.t - start >= 500 && played < PLAYED.length) {
        t.speech.playing = { replyId, text: PLAYED_TEXT, voice: 'marin' };
        t.speech.until = Infinity;
        t.dictation.reference(PLAYED.subarray(played, played + 960));
        played += 960;

        if (played >= PLAYED.length) {
          t.speech.playing = null;
          t.speech.until = t.clock.t + 20;
        }
      }

      t.clock.advance(20);
    }

    if (t.speech.playing !== null) {
      during?.();
    }

    t.capture.stream!.onPcm(at < captured.length ? captured.subarray(at, at + 3_200) : Buffer.alloc(3_200));
  }
}

const kinds = (sent: Sent[]): string[] =>
  sent.map((one) =>
    one.type === 'words' ? `words "${one.text}"` : one.type === 'piece' ? `piece "${one.text}"${one.dropped ? ' dropped' : ''}` : one.type === 'enrollment' ? `enrollment ${one.state}` : one.type === 'command' ? `command ${one.command}` : `utterance "${one.text}" ${one.final ? 'final' : 'cut'}`,
  );

describe('Dictation', () => {

  it('hears a spoken alert\'s answer with no target and after the idle timeout, sends none of it to the hub, and returns capture to what it was', async () => {
    const { dictation, say, quiet, sent, capture, watch, logs, clock } = setup({ settings: { micIdleMinutes: 1 } });
    const answers: Array<string | null> = [];

    dictation.mic(true);
    watch.changed!(false, []);
    await settle();
    expect([dictation.state, capture.opens, dictation.answerable]).toEqual(['idle-off', 0, true]);

    dictation.listen((text) => answers.push(text));
    await settle();
    expect([dictation.state, capture.opens]).toEqual(['listening', 1]);
    say('yes go ahead', 300);
    expect(dictation.hearing).toBe(true);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(answers).toEqual(['yes go ahead']);
    expect(sent).toEqual([]);
    expect(logs).toContain('alert answer id1: 3 words');
    expect(logs.join('\n')).not.toContain('go ahead');

    // Stopping listening for an answer stops capture again: there is still no target.
    dictation.listen(null);
    expect([dictation.state, capture.stream!.stopped]).toEqual(['idle-off', true]);

    // With a target, after the idle timeout: an answer accepted ends the idle stop, and dictation goes to the session again.
    dictation.target(1, 's1', null);
    await settle();
    clock.advance(60_000);
    expect(dictation.state).toBe('idle-off');
    dictation.listen((text) => answers.push(text));
    await settle();
    expect(dictation.state).toBe('listening');
    say('tell me', 200);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(answers).toEqual(['yes go ahead', 'tell me']);
    dictation.listen(null, true);
    await settle();
    expect(dictation.state).toBe('listening');
    say('now the session', 200);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(kinds(sent).at(-1)).toBe('utterance "now the session" final');
    expect(sent.every((one) => 'sessionId' in one && one.sessionId === 's1')).toBe(true);
  });

  it('drops an answer still open when listening for one stops, keeps one open across a move of the target, and gives null for one cut short', async () => {
    const { dictation, say, quiet, sent, listening, watch } = setup();
    const answers: Array<string | null> = [];
    const cuts: boolean[] = [];

    await listening();
    dictation.listen((text, cut) => {
      answers.push(text);
      cuts.push(cut);
    });
    say('hang on', 200);
    dictation.listen(null);
    expect(answers).toEqual([]);
    expect(sent).toEqual([]);

    dictation.listen((text, cut) => {
      answers.push(text);
      cuts.push(cut);
    });
    say('sure', 200);
    dictation.target(2, 's2', 'acme/app');
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(answers).toEqual(['sure']);

    say('wait', 200);
    watch.changed!(true, ['Teams']);
    expect(answers).toEqual(['sure', null]);
    expect(cuts).toEqual([false, true]);
    expect(dictation.answerable).toBe(false);
    expect(sent).toEqual([]);
  });

  it('cuts an alert answer waited for or being said when a composer that keeps listening takes the focus, and keeps capture for the draft', async () => {
    const { dictation, say, sent, listening, capture } = setup();
    const answers: Array<[string | null, boolean]> = [];

    await listening();
    dictation.listen((text, cut) => answers.push([text, cut]));
    dictation.typing(true, true);
    expect(answers).toEqual([[null, true]]);
    dictation.listen(null);
    dictation.typing(false);

    dictation.listen((text, cut) => answers.push([text, cut]));
    say('yes go', 200);
    dictation.typing(true, true);
    expect(answers).toEqual([[null, true], [null, true]]);
    dictation.listen(null);
    expect(sent).toEqual([]);
    expect(dictation.state).toBe('listening');
    expect(capture.opens).toBe(1);
  });

  it('can hear no answer with the mic off, paused by voice, the composer focused or during an enrolment', async () => {
    const { dictation, listening, say, quiet } = setup({ voiceprint: fakeVoiceprint() });

    expect(dictation.answerable).toBe(false);
    await listening();
    expect(dictation.answerable).toBe(true);
    dictation.typing(true);
    expect(dictation.answerable).toBe(false);
    dictation.typing(false);
    await settle();
    // A composer that keeps listening, as the web page's, still keeps answers out of its draft.
    dictation.typing(true, true);
    expect(dictation.state).toBe('listening');
    expect(dictation.answerable).toBe(false);
    dictation.typing(false);
    expect(dictation.answerable).toBe(true);
    say('stop listening', 200);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(dictation.state).toBe('paused-by-voice');
    expect(dictation.answerable).toBe(false);
    dictation.mic(true);
    expect(dictation.answerable).toBe(true);
    dictation.enroll('start');
    expect([dictation.enrolling, dictation.answerable]).toEqual([true, false]);
  });

  it('captures only once the watcher says no other app records, and loads the recogniser with the target repository\'s terms', async () => {
    const { capture, dictation, watch, termsAsked, loads, engine, changed } = setup();

    engine.device = 'gpu';
    expect([dictation.state, dictation.recognizer]).toEqual(['off', null]);
    dictation.target(1, 's1', 'acme/app');
    dictation.mic(true);
    await settle();
    expect(capture.opens).toBe(0);
    expect(dictation.state).toBe('starting');
    // The recogniser loads at Mic on, while the watcher starts, not after its first answer.
    expect(loads).toHaveLength(1);
    watch.changed!(false, []);
    await settle();
    expect(capture.opens).toBe(1);
    expect(capture.devices).toEqual([null]);
    expect(new Set(termsAsked)).toEqual(new Set(['acme/app']));
    // The spoken commands are boosted with the terms.
    expect(loads).toEqual([['Switchboard', 'acme/app', 'stop listening', 'pause listening', 'start listening', 'resume listening']]);
    expect(dictation.state).toBe('listening');
    // Where the loaded recogniser runs, for the audio report.
    expect(dictation.recognizer).toBe('gpu');
    expect(changed()).toBeGreaterThan(0);
  });

  it('logs how long Mic on waited for each step before capture opened', async () => {
    const { dictation, watch, logs, clock } = setup();

    dictation.target(1, 's1', 'acme/app');
    dictation.mic(true);
    clock.advance(400);
    watch.changed!(false, []);
    await settle();
    expect(logs.filter((line) => line.startsWith('mic on'))).toEqual(['mic on → listening in 400 ms: recogniser loaded 0 ms, other-app check 400 ms, capture open 0 ms']);
    // Off and on again: the recogniser is kept.
    dictation.mic(false);
    dictation.mic(true);
    watch.changed!(false, []);
    await settle();
    expect(logs.filter((line) => line.startsWith('mic on')).at(-1)).toBe('mic on → listening in 0 ms: recogniser ready 0 ms, other-app check 0 ms, capture open 0 ms');
  });

  it('loads the recogniser ahead of Mic on once the target settles, waiting while a reply plays, and once per set of terms', () => {
    const { dictation, loads, logs, clock, speech, engine } = setup();

    dictation.target(1, 's1', 'acme/app');
    clock.advance(WARM_SETTLE_MS - 1);
    expect(loads).toHaveLength(0);
    // A target that moves again waits again.
    dictation.target(2, 's2', 'acme/web');
    clock.advance(WARM_SETTLE_MS - 1);
    expect(loads).toHaveLength(0);
    speech.playing = { replyId: 'r1', text: 'Done.', voice: 'marin' };
    clock.advance(1);
    expect(loads).toHaveLength(0);
    speech.playing = null;
    clock.advance(WARM_RETRY_MS);
    expect(loads.map((terms) => terms[1])).toEqual(['acme/web']);
    // Its first decode runs then, on a second of silence.
    expect(engine.accepted).toBe(ASR_RATE);
    expect(logs.filter((line) => line.startsWith('recogniser loaded ahead'))).toHaveLength(1);
    // The same terms load nothing again; Mic on finds it ready.
    dictation.target(3, 's3', 'acme/web');
    clock.advance(WARM_SETTLE_MS);
    dictation.warm();
    expect(loads).toHaveLength(1);

    // A phone took the voice: the target the hub sets right after loads at once, not after it settles.
    dictation.warmSoon();
    dictation.target(4, 's4', 'acme/phone');
    clock.advance(WARM_SOON_MS + WARM_RELEASE_MS);
    expect(loads.map((terms) => terms[1])).toEqual(['acme/web', 'acme/phone']);
    // The next target settles again, also after a move whose target was ready.
    dictation.target(5, 's5', 'acme/later');
    clock.advance(WARM_SOON_MS);
    expect(loads).toHaveLength(2);
    clock.advance(WARM_SETTLE_MS);
    dictation.warmSoon();
    clock.advance(WARM_SOON_MS);
    dictation.target(6, 's6', 'acme/other');
    clock.advance(WARM_SOON_MS + WARM_RELEASE_MS);
    expect(loads).toHaveLength(3);
  });

  it('frees the recogniser before one for other terms loads, and loads that one only once the memory has gone, ahead of the mic and while listening', async () => {
    const { dictation, loads, recognizers, clock, engine, listening, say } = setup();
    /** No load comes while a recogniser freed before it may still hold its memory. */
    const neverTwo = (): void => {
      recognizers.forEach((one, index) => {
        if (one.load) {
          expect(recognizers.slice(0, index).filter((freed) => !freed.load && one.at - freed.at < WARM_RELEASE_MS)).toEqual([]);
        }
      });
      expect(recognizers.filter((one) => !one.load)).toHaveLength(3);
    };

    dictation.target(1, 's1', 'acme/app');
    clock.advance(WARM_SETTLE_MS);
    dictation.target(2, 's2', 'acme/web');
    clock.advance(WARM_SETTLE_MS);
    expect([loads.length, engine.freed, dictation.recognizer]).toEqual([1, 1, null]);
    clock.advance(WARM_RELEASE_MS);
    expect(loads.map((terms) => terms[1])).toEqual(['acme/app', 'acme/web']);
    // Mic on for a target with other terms frees the loaded one and waits before loading.
    dictation.target(3, 's3', 'acme/app');
    dictation.mic(true);
    await settle();
    expect([loads.length, engine.freed, dictation.state]).toEqual([2, 2, 'starting']);
    clock.advance(WARM_RELEASE_MS);
    await settle();
    await listening();
    expect([loads.map((terms) => terms[1]).at(-1), dictation.state]).toEqual(['acme/app', 'listening']);
    // While listening, the target's new terms free the recogniser at once; audio until the next loads is heard by none.
    dictation.target(4, 's4', 'acme/phone');
    expect([engine.freed, dictation.recognizer]).toEqual([3, null]);
    say('lost words', 50);
    clock.advance(WARM_RELEASE_MS - 50);
    await settle();
    expect([loads.map((terms) => terms[1]).at(-1), dictation.recognizer, dictation.state]).toEqual(['acme/phone', 'cpu', 'listening']);
    neverTwo();
  });

  it('loads one recogniser for target changes while listening, with the last terms, and none once an enrolment took the capture', async () => {
    const options: { recognizer?: { error: string } } = {};
    const { dictation, loads, clock, listening } = setup(options);

    await listening();
    options.recognizer = { error: 'No speech recognition model in m.' };
    dictation.target(2, 's2', 'acme/web');
    dictation.target(3, 's3', 'acme/phone');
    dictation.target(4, 's4', 'acme/other');
    clock.advance(WARM_RELEASE_MS);
    await settle();
    // One load for the capture, then the attempt to listen again; not one per target change.
    expect(loads.map((terms) => terms[1])).toEqual(['acme/app', 'acme/other', 'acme/other']);
    expect(dictation.state).toBe('unavailable');

    const enrolling = setup({ voiceprint: fakeVoiceprint() });

    await enrolling.listening();
    enrolling.dictation.target(2, 's2', 'acme/web');
    enrolling.dictation.enroll('start');
    await settle();
    enrolling.clock.advance(WARM_RELEASE_MS);
    await settle();
    expect([enrolling.loads.length, enrolling.dictation.enrolling]).toEqual([1, true]);
  });

  it('loads the recogniser for a target that moved while the device opened, and stops capture when it cannot load', async () => {
    const options: { recognizer?: { error: string } } = {};
    const { dictation, capture, watch, loads, clock } = setup(options);
    let open = (): void => undefined;

    capture.hold = new Promise((resolve) => (open = resolve));
    dictation.target(1, 's1', 'acme/app');
    dictation.mic(true);
    watch.changed!(false, []);
    await settle();
    dictation.target(2, 's2', 'acme/web');
    clock.advance(WARM_SETTLE_MS);
    // The load ahead waits for the open.
    expect(loads.map((terms) => terms[1])).toEqual(['acme/app']);
    options.recognizer = { error: 'No speech recognition model in m.' };
    open();
    await settle();
    clock.advance(WARM_RELEASE_MS);
    await settle();
    // Loaded once the old one's memory had gone, then again by the attempt to listen, which reports why.
    expect(loads.map((terms) => terms[1])).toEqual(['acme/app', 'acme/web', 'acme/web']);
    expect([dictation.state, dictation.error, capture.open_]).toEqual(['unavailable', 'No speech recognition model in m.', false]);
  });

  it('loads the recogniser once the settings come, with no target or device, then for a target with other terms, and keeps no error from a load ahead that failed', () => {
    const { dictation, loads, logs, clock } = setup();

    // The voice process started: the hub's settings come before any target or device has the voice.
    dictation.settingsChanged();
    clock.advance(WARM_SETTLE_MS - 1);
    expect(loads).toHaveLength(0);
    clock.advance(1);
    expect(loads.map((terms) => terms.slice(0, 2))).toEqual([['Switchboard', 'stop listening']]);
    expect(logs.filter((line) => line.startsWith('recogniser loaded ahead'))).toHaveLength(1);
    // Settings again, as after a hub restart, and the target leaving load nothing again.
    dictation.settingsChanged();
    dictation.target(1, null, null);
    clock.advance(WARM_SETTLE_MS);
    expect(loads).toHaveLength(1);
    // A target with its own terms loads them once it settles.
    dictation.target(2, 's2', 'acme/app');
    clock.advance(WARM_SETTLE_MS + WARM_RELEASE_MS);
    expect(loads.map((terms) => terms[1])).toEqual(['stop listening', 'acme/app']);

    // An enrolment that starts before the load puts it off until the enrolment ends, cancelled or finished.
    for (const end of ['cancel', 'finish'] as const) {
      const enrolling = setup({ voiceprint: fakeVoiceprint() });

      enrolling.dictation.settingsChanged();
      enrolling.dictation.enroll('start');
      enrolling.clock.advance(WARM_SETTLE_MS);
      expect(enrolling.loads).toHaveLength(0);

      if (end === 'cancel') {
        enrolling.dictation.enroll('cancel');
      } else {
        enrolling.clock.advance(ENROLL_SECONDS * 1000);
      }

      enrolling.clock.advance(WARM_SETTLE_MS);
      expect(enrolling.loads).toHaveLength(1);
    }

    // Voice off loads nothing.
    const off = setup({ settings: { enabled: false } });

    off.dictation.settingsChanged();
    off.clock.advance(WARM_SETTLE_MS);
    expect(off.loads).toHaveLength(0);

    const missing = setup({ recognizer: { error: 'No speech recognition model in m.' } });

    missing.dictation.target(1, 's1', 'acme/app');
    missing.clock.advance(WARM_SETTLE_MS);
    expect(missing.loads).toHaveLength(1);
    expect(missing.dictation.error).toBeNull();
    expect(missing.logs.filter((line) => line.startsWith('No speech recognition model'))).toEqual([]);
  });

  it('collects the dropped streams a second after the last drop, never while the operator is heard, and not after close', async () => {
    const { dictation, engine, sent, say, quiet, clock, listening } = setup();
    const streamAt: number[] = [];
    const collectAt: number[] = [];
    const stream = engine.stream.bind(engine);

    engine.stream = () => (streamAt.push(clock.t), stream());
    engine.collect = () => void collectAt.push(clock.t);

    const untilFinal = (): void => {
      const before = sent.filter((one) => one.type === 'utterance').length;

      for (let step = 0; step < 100 && sent.filter((one) => one.type === 'utterance').length === before; step++) {
        quiet(100);
      }
    };

    await listening();
    say('fix the build', 100);
    untilFinal();
    expect(kinds(sent).at(-1)).toBe('utterance "fix the build" final');
    expect(collectAt).toEqual([]);
    quiet(COLLECT_AFTER_DROP_MS);
    expect(collectAt).toEqual([streamAt.at(-1)! + COLLECT_AFTER_DROP_MS]);

    // Words heard within the second after a drop hold the collection until that utterance has ended too.
    say('and the tests', 100);
    untilFinal();
    say('then push', 100);

    for (let at = 0; at < 3_000; at += 100) {
      say(`then push ${'it '.repeat(at / 100 + 1).trim()}`, 100);
    }

    expect(collectAt).toHaveLength(1);
    untilFinal();
    quiet(COLLECT_AFTER_DROP_MS);
    expect(collectAt).toEqual([collectAt[0], streamAt.at(-1)! + COLLECT_AFTER_DROP_MS]);

    // A drop just before close collects nothing afterwards.
    say('one more', 100);
    untilFinal();
    dictation.close();
    clock.advance(COLLECT_AFTER_DROP_MS * 5);
    expect(collectAt).toHaveLength(2);
  });

  it('gives the turn model the target session\'s last reply until the session leaves the targets', async () => {
    const { dictation, chats, say, quiet, sent, listening } = setup({ turn: () => 0.5 });

    dictation.context('s1', 'Which port?');
    dictation.context('s2', 'Done.');
    dictation.keepContexts(new Set(['s1']));
    await listening();
    say('use 8080', 100);
    quiet(500);
    await settle();
    expect(chats.at(-1)?.[0]).toEqual({ role: 'assistant', content: 'Which port?' });

    for (let step = 0; step < 100 && !sent.some((one) => one.type === 'utterance'); step++) {
      quiet(100);
      await settle();
    }

    dictation.keepContexts(new Set(['s2']));
    say('and restart it', 100);
    quiet(500);
    await settle();
    expect(chats.at(-1)?.[0]).toEqual({ role: 'assistant', content: '' });
  });

  it('closes the turn model with the recogniser it frees for disuse, not while capture is in use, and asks it again after Mic on', async () => {
    const { dictation, engine, chats, clock, watch, say, quiet, listening, turnClosed } = setup({ turn: () => 0.5, settings: { micIdleMinutes: 120 } });

    await listening();
    clock.advance(RECOGNISER_IDLE_MS + 1_000);
    expect(turnClosed()).toBe(0);
    dictation.mic(false);
    clock.advance(RECOGNISER_IDLE_MS - 1);
    expect([engine.freed, turnClosed()]).toEqual([0, 0]);
    clock.advance(1);
    expect([engine.freed, turnClosed()]).toEqual([1, 1]);

    clock.advance(WARM_RELEASE_MS);
    dictation.mic(true);
    watch.changed!(false, []);
    await settle();
    say('fix the build', 100);
    quiet(500);
    await settle();
    expect(chats.length).toBeGreaterThan(0);
    expect(turnClosed()).toBe(1);
  });

  it('frees the recogniser once capture has gone unused for 30 minutes, never while it listens, and counts again from each Mic on', async () => {
    // The mic idle timeout is longer than the limit, so capture stays open through it.
    const { dictation, engine, loads, logs, clock, watch, listening } = setup({ settings: { micIdleMinutes: 120 } });
    const freedLine = 'recogniser freed: capture was not used for 30 minutes; it loads again at Mic on';

    await listening();
    clock.advance(RECOGNISER_IDLE_MS + 1_000);
    expect([engine.freed, dictation.recognizer, dictation.state]).toEqual([0, 'cpu', 'listening']);

    dictation.mic(false);
    clock.advance(RECOGNISER_IDLE_MS - 1);
    expect(engine.freed).toBe(0);
    clock.advance(1);
    expect([engine.freed, dictation.recognizer]).toEqual([1, null]);
    expect(logs.filter((line) => line === freedLine)).toHaveLength(1);

    // Mic on loads it again, once the freed one's memory has gone; a Mic on before the limit starts the count over.
    clock.advance(WARM_RELEASE_MS);
    dictation.mic(true);
    watch.changed!(false, []);
    await settle();
    expect([loads.length, dictation.state]).toEqual([2, 'listening']);
    dictation.mic(false);
    clock.advance(RECOGNISER_IDLE_MS - 1_000);
    dictation.mic(true);
    await settle();
    dictation.mic(false);
    clock.advance(RECOGNISER_IDLE_MS - 1);
    expect(engine.freed).toBe(1);
    clock.advance(1);
    expect(engine.freed).toBe(2);

    // A closed dictation frees nothing later.
    const closing = setup();

    await closing.listening();
    closing.dictation.mic(false);
    closing.dictation.close();
    closing.clock.advance(RECOGNISER_IDLE_MS * 2);
    expect(closing.engine.freed).toBe(0);
  });

  it('frees nothing while capture opens, an enrolment records or a spoken alert waits for its answer', async () => {
    const opening = setup();

    opening.capture.hold = new Promise(() => undefined);
    opening.dictation.target(1, 's1', 'acme/app');
    opening.dictation.mic(true);
    opening.watch.changed!(false, []);
    await settle();
    opening.clock.advance(RECOGNISER_IDLE_MS * 2);
    expect([opening.loads.length, opening.engine.freed, opening.dictation.state]).toEqual([1, 0, 'starting']);

    // The enrolment's recording stops the count, which starts over once it ends.
    const enrolling = setup({ voiceprint: fakeVoiceprint() });

    enrolling.dictation.settingsChanged();
    enrolling.clock.advance(RECOGNISER_IDLE_MS - 1_000);
    enrolling.dictation.enroll('start');
    await settle();
    enrolling.clock.advance(ENROLL_SECONDS * 1000);
    await settle();
    expect(enrolling.dictation.enrolling).toBe(false);
    enrolling.clock.advance(RECOGNISER_IDLE_MS - 1);
    expect(enrolling.engine.freed).toBe(0);
    enrolling.clock.advance(1);
    expect(enrolling.engine.freed).toBe(1);

    // A spoken alert waiting for its answer, even with the mic off, keeps it; the count starts once the alert stops listening.
    const alert = setup();

    alert.dictation.settingsChanged();
    alert.clock.advance(WARM_SETTLE_MS);
    alert.dictation.listen(() => undefined);
    alert.clock.advance(RECOGNISER_IDLE_MS * 2);
    expect(alert.engine.freed).toBe(0);
    alert.dictation.listen(null);
    alert.clock.advance(RECOGNISER_IDLE_MS - 1);
    expect(alert.engine.freed).toBe(0);
    alert.clock.advance(1);
    expect(alert.engine.freed).toBe(1);
  });

  it('loads nothing ahead after a free for disuse: not a load ahead waiting then, a target, the settings or an enrolment; Mic on loads one', async () => {
    const { dictation, loads, engine, clock, watch } = setup({ voiceprint: fakeVoiceprint() });

    dictation.settingsChanged();
    clock.advance(WARM_SETTLE_MS);
    expect(loads).toHaveLength(1);
    // A target that settles after the free: its load ahead was waiting when the free came.
    clock.advance(RECOGNISER_IDLE_MS - WARM_SETTLE_MS - 1_000);
    dictation.target(1, 's1', 'acme/app');
    clock.advance(1_000);
    expect(engine.freed).toBe(1);
    clock.advance(WARM_SETTLE_MS * 2);
    expect(loads).toHaveLength(1);

    dictation.target(2, 's2', 'acme/web');
    clock.advance(WARM_SETTLE_MS + WARM_RETRY_MS);
    dictation.warm();
    dictation.settingsChanged();
    clock.advance(WARM_SETTLE_MS);
    dictation.enroll('start');
    await settle();
    clock.advance(ENROLL_SECONDS * 1000 + WARM_SETTLE_MS);
    await settle();
    expect(loads).toHaveLength(1);

    dictation.mic(true);
    watch.changed!(false, []);
    await settle();
    expect([loads.length, loads[1]![1], dictation.state]).toEqual([2, 'acme/web', 'listening']);
  });

  it('frees the recogniser 30 minutes after capture fails or pauses for another app with the mic on, and loads it again when listening resumes', async () => {
    const failing = setup({ settings: { micIdleMinutes: 120 } });

    await failing.listening();
    failing.capture.stream!.onError(new Error('device gone'));
    await settle();
    expect(failing.dictation.state).toBe('unavailable');
    failing.clock.advance(RECOGNISER_IDLE_MS - 1);
    expect(failing.engine.freed).toBe(0);
    failing.clock.advance(1);
    expect([failing.engine.freed, failing.dictation.recognizer]).toEqual([1, null]);

    const paused = setup({ settings: { micIdleMinutes: 120 } });

    await paused.listening();
    paused.watch.changed!(true, ['Teams']);
    await settle();
    expect(paused.dictation.state).toBe('paused-other-app');
    paused.clock.advance(RECOGNISER_IDLE_MS);
    expect(paused.engine.freed).toBe(1);
    paused.clock.advance(WARM_RELEASE_MS);
    paused.watch.changed!(false, []);
    await settle();
    expect([paused.loads.length, paused.dictation.state]).toEqual([2, 'listening']);
  });

  it('loads again after a free for disuse for a spoken alert with no target, and at once for a phone taking the voice', async () => {
    const alert = setup();

    alert.dictation.settingsChanged();
    alert.clock.advance(WARM_SETTLE_MS);
    // The mic is on with no target: nothing listens, so the count runs.
    alert.dictation.mic(true);
    alert.watch.changed!(false, []);
    await settle();
    expect(alert.dictation.state).toBe('idle-off');
    alert.clock.advance(RECOGNISER_IDLE_MS);
    expect([alert.engine.freed, alert.dictation.recognizer]).toEqual([1, null]);
    alert.dictation.listen(() => undefined);
    await settle();
    expect([alert.loads.length, alert.dictation.state]).toEqual([2, 'listening']);

    const phone = setup();

    phone.dictation.settingsChanged();
    phone.clock.advance(RECOGNISER_IDLE_MS);
    expect(phone.engine.freed).toBe(1);
    phone.dictation.warmSoon();
    phone.dictation.target(1, 's1', 'acme/phone');
    phone.clock.advance(WARM_SOON_MS + WARM_RELEASE_MS);
    expect(phone.loads.map((terms) => terms[1])).toEqual(['stop listening', 'acme/phone']);
  });

  it('loads exactly one recogniser for a Mic on that comes while the one freed for disuse still holds its memory', async () => {
    const { dictation, loads, recognizers, clock, watch } = setup();

    dictation.target(1, 's1', 'acme/app');
    clock.advance(RECOGNISER_IDLE_MS);
    expect(recognizers.map((one) => one.load)).toEqual([true, false]);
    dictation.mic(true);
    watch.changed!(false, []);
    await settle();
    expect([loads.length, dictation.state]).toEqual([1, 'starting']);
    clock.advance(WARM_RELEASE_MS);
    await settle();
    expect([loads.length, dictation.state]).toEqual([2, 'listening']);
    expect(recognizers[2]!.at - recognizers[1]!.at).toBeGreaterThanOrEqual(WARM_RELEASE_MS);
  });

  it('turns live words into pieces after their pause and ends the utterance after the end-of-message pause, as final', async () => {
    const { dictation, say, quiet, sent, used, listening, spoke } = setup();

    await listening();
    say('fix the login', 300);
    expect(dictation.state).toBe('hearing');
    expect(kinds(sent)).toEqual(['words "fix the login"']);
    expect(sent[0]).toMatchObject({ gen: 1, sessionId: 's1', utteranceId: 'id1' });
    expect(spoke()).toBeGreaterThan(0);
    quiet(PHRASE_SILENCE_MS);
    expect(kinds(sent)).toEqual(['words "fix the login"', 'piece "fix the login"', 'words ""']);
    expect(used).toEqual(['fix the login']);
    say('fix the login flow', 100);
    quiet(2_000);
    expect(kinds(sent).slice(3)).toEqual(['words "flow"', 'piece "flow"', 'words ""']);
    // 3 s of quiet since the words last grew ends it.
    quiet(900);
    expect(kinds(sent).slice(6)).toEqual(['utterance "fix the login flow" final']);
    expect(dictation.state).toBe('listening');
  });

  it('closes after the short wait the turn model earned, waits twice the pause after a dangling word, and reads the session\'s last reply', async () => {
    const finished = setup({ turn: () => 0.6 });

    await finished.listening();
    finished.dictation.context('s1', 'Which port, 8765 or 8799?');
    finished.say('use 8799', 100);
    finished.quiet(400);
    await settle();
    expect(finished.chats).toEqual([[{ role: 'assistant', content: 'Which port, 8765 or 8799?' }, { role: 'user', content: 'use 8799' }]]);
    finished.quiet(200);
    expect(kinds(finished.sent).at(-1)).toBe('utterance "use 8799" final');

    const dangling = setup({ turn: () => 0.9 });

    await dangling.listening();
    dangling.say('fix it and', 100);
    dangling.quiet(5_500);
    expect(dangling.sent.some((one) => one.type === 'utterance')).toBe(false);
    dangling.quiet(600);
    expect(kinds(dangling.sent).at(-1)).toBe('utterance "fix it and" final');
  });

  it('sends an end by turn detection with when its last word, decision and end were, logs that line, and sends a cut with none', async () => {
    const model = setup({ turn: () => 0.6 });

    await model.listening();
    model.say('use 8799', 100);
    const lastWordAt = model.clock.now() - 100;
    model.quiet(400);
    await settle();
    model.quiet(200);

    const ended = model.sent.at(-1);

    expect(ended).toMatchObject({ type: 'utterance', final: true, timing: { lastWordAt, endedBy: 'turn model' } });
    const timing = (ended as Extract<Sent, { type: 'utterance' }>).timing!;
    expect(timing.decidedAt - timing.lastWordAt).toBeGreaterThanOrEqual(500);
    expect(timing.endedAt).toBeGreaterThanOrEqual(timing.decidedAt);
    expect(model.logs.at(-1)).toMatch(/^utterance id\d+ ended by the turn model: last word → decision \d+ ms \(turn model p 0\.600 in \d+ ms, earned quiet 500 ms\), decision → sent \d+ ms \(the last piece's voice check\)$/);

    const paused = setup();

    await paused.listening();
    paused.say('fix the login', 100);
    paused.quiet(3_100);
    expect(paused.sent.at(-1)).toMatchObject({ type: 'utterance', final: true, timing: { endedBy: 'pause' } });
    expect(paused.logs.at(-1)).toMatch(/^utterance id\d+ ended by the pause: last word → decision 3\d{3} ms \(no turn model answer\)/);

    const cut = setup();

    await cut.listening();
    cut.say('fix the login', 100);
    cut.dictation.typing(true);
    expect(cut.sent.at(-1)).toMatchObject({ type: 'utterance', final: false });
    expect(cut.sent.at(-1)).not.toHaveProperty('timing');
    expect(cut.logs.some((line) => line.includes(' ended by '))).toBe(false);
  });

  it('reports an utterance cut by another app\'s recording even before its first piece settled', async () => {
    const { dictation, say, sent, watch, listening } = setup();

    await listening();
    say('fix the', 200);
    watch.changed!(true, ['teams']);
    expect(kinds(sent)).toEqual(['words "fix the"', 'words ""', 'utterance "" cut']);
    expect(dictation.state).toBe('paused-other-app');
  });

  it('finishes the words in flight when the composer takes the focus, reports the utterance cut, and listens again when it leaves', async () => {
    const { dictation, engine, say, sent, capture, listening } = setup();

    await listening();
    say('rename the', 200);
    engine.held = 'button';
    dictation.typing(true);
    expect(kinds(sent)).toEqual(['words "rename the"', 'piece "rename the button"', 'words ""', 'utterance "rename the button" cut']);
    expect(dictation.state).toBe('typing');
    expect(capture.stream!.stopped).toBe(true);
    dictation.typing(false);
    await settle();
    expect(capture.opens).toBe(2);
    expect(dictation.state).toBe('listening');

    // A composer that asks to listen on leaves the utterance and capture alone.
    say('and the tests', 200);
    const before = sent.length;

    dictation.typing(true, true);
    expect(kinds(sent.slice(before))).toEqual([]);
    expect(dictation.state).toBe('hearing');
    expect(capture.opens).toBe(2);
  });

  it('drops what it was hearing when another app records, sends no end, and resumes only when that app stops', async () => {
    const { dictation, say, quiet, sent, capture, watch, logs, listening } = setup();

    await listening();
    say('first part', 100);
    quiet(PHRASE_SILENCE_MS);
    say('first part and the rest', 300);
    watch.changed!(true, ['Teams']);
    expect(kinds(sent)).toEqual(['words "first part"', 'piece "first part"', 'words ""', 'words "and the rest"', 'words ""', 'utterance "first part" cut']);
    expect(dictation.state).toBe('paused-other-app');
    expect(capture.stream!.stopped).toBe(true);
    expect(logs).toContain('listening paused: Teams is recording');
    quiet(10_000);
    expect(sent).toHaveLength(6);
    watch.changed!(false, []);
    await settle();
    expect(dictation.state).toBe('listening');
    expect(capture.opens).toBe(2);
  });

  it('closes an utterance open at a voice move as cut under its own generation, and stops listening with no target', async () => {
    const { dictation, say, sent, listening, capture, loads, clock } = setup();

    await listening();
    say('about the', 200);
    dictation.target(2, 's2', 'acme/app');
    expect(kinds(sent).slice(-2)).toEqual(['words ""', 'utterance "about the" cut']);
    expect(sent.at(-1)).toMatchObject({ gen: 1, sessionId: 's1' });
    // The same terms keep the recogniser.
    expect(loads).toHaveLength(1);
    dictation.target(3, 's3', 'acme/other');
    clock.advance(WARM_RELEASE_MS);
    await settle();
    expect(loads).toHaveLength(2);
    dictation.target(4, null, null);
    expect(dictation.state).toBe('idle-off');
    expect(capture.stream!.stopped).toBe(true);
  });

  it('stops capture after the mic idle timeout, until the mic is turned on again; 0 never stops it', async () => {
    const idle = setup({ settings: { micIdleMinutes: 1 } });

    await idle.listening();
    idle.clock.advance(59_000);
    idle.say('still here', 100);
    idle.quiet(4_000);
    // A minute from the last words, not from the utterance's end.
    idle.clock.advance(55_000);
    expect(idle.dictation.state).toBe('listening');
    idle.clock.advance(1_000);
    expect(idle.dictation.state).toBe('idle-off');
    expect(idle.capture.stream!.stopped).toBe(true);
    idle.dictation.mic(true);
    await settle();
    expect(idle.dictation.state).toBe('listening');

    const never = setup({ settings: { micIdleMinutes: 0 } });

    await never.listening();
    never.clock.advance(24 * 60 * 60_000);
    expect(never.dictation.state).toBe('listening');
  });

  it('says why when recognition or the device cannot run, and tries again when the mic is turned on', async () => {
    const missing = setup({ recognizer: { error: 'No speech recognition model in m.' } });

    await missing.listening();
    expect(missing.dictation.state).toBe('unavailable');
    expect(missing.dictation.error).toBe('No speech recognition model in m.');
    expect(missing.capture.opens).toBe(0);
    // The mic button turns an unavailable mic off.
    missing.dictation.mic(false);
    expect(missing.dictation.state).toBe('off');

    const broken = setup();

    broken.capture.fail = new Error('no device');
    await broken.listening();
    expect(broken.dictation.state).toBe('unavailable');
    expect(broken.dictation.error).toBe('The microphone failed: no device');
    broken.capture.fail = null;
    broken.dictation.mic(true);
    await settle();
    expect(broken.dictation.state).toBe('listening');
    broken.say('hello', 200);
    broken.capture.stream!.onError(new Error('device removed'));
    expect(broken.dictation.error).toBe('The microphone failed: device removed');
    // What was heard before the failure stays in the draft, unsent.
    expect(kinds(broken.sent).slice(-3)).toEqual(['piece "hello"', 'words ""', 'utterance "hello" cut']);
  });

  it('loads the recogniser again at each attempt to listen, so a model put back needs no restart', async () => {
    const options: { recognizer?: { error: string } } = { recognizer: { error: 'No speech recognition model in m.' } };
    const missing = setup(options);

    await missing.listening();
    expect(missing.dictation.state).toBe('unavailable');
    missing.dictation.typing(true);
    missing.dictation.typing(false);
    await settle();
    expect(missing.dictation.state).toBe('unavailable');
    // Mic on tried it while the watcher started, whose answer reports that failure without loading again; the composer's focus round trip tries again.
    expect(missing.loads.length).toBe(2);
    expect(missing.logs.filter((line) => line.startsWith('mic on'))).toEqual(['mic on → unavailable in 0 ms: recogniser loaded 0 ms, other-app check 0 ms']);
    expect(missing.logs.filter((line) => line.startsWith('No speech recognition model'))).toHaveLength(1);
    delete options.recognizer;
    missing.dictation.typing(true);
    missing.dictation.typing(false);
    await settle();
    expect(missing.dictation.state).toBe('listening');
    expect(missing.dictation.error).toBeNull();
    expect(missing.capture.opens).toBe(1);

    const turnedOn = setup(options);

    options.recognizer = { error: 'No speech recognition model in m.' };
    await turnedOn.listening();
    delete options.recognizer;
    turnedOn.dictation.mic(true);
    await settle();
    expect(turnedOn.dictation.state).toBe('listening');
  });

  it('listens with no watcher where nothing can watch, or once the watcher fails, and stops it with the mic', async () => {
    const none = setup({ watcher: 'none' });

    none.dictation.target(1, 's1', null);
    none.dictation.mic(true);
    await settle();
    expect(none.dictation.state).toBe('listening');

    const failing = setup();

    failing.dictation.target(1, 's1', null);
    failing.dictation.mic(true);
    failing.watch.failed!();
    await settle();
    expect(failing.dictation.state).toBe('listening');
    failing.dictation.mic(false);
    expect(failing.watch.closed).toBe(1);
    expect(failing.dictation.state).toBe('off');
    expect(failing.capture.stream!.stopped).toBe(true);
  });

  it('passes the audio played to the open capture as the echo canceller\'s reference', async () => {
    const { dictation, capture, listening } = setup();

    dictation.reference(Buffer.alloc(4));
    await listening();
    dictation.reference(Buffer.alloc(8));
    expect(capture.references.map((one) => one.length)).toEqual([8]);
    dictation.close();
    expect(capture.stream!.stopped).toBe(true);
  });
  it('drops a piece that fails the voice check: reported with its score, kept out of the utterance, and an utterance of dropped pieces only ending cut', async () => {
    const voiceprint = fakeVoiceprint({ verdict: (text) => (text.includes('someone') ? { score: 0.31, f0: 240, dropped: true, reason: 'score' } : null) });
    const { say, quiet, sent, used, logs, listening } = setup({ voiceprint });

    await listening();
    say('fix it', 100);
    quiet(PHRASE_SILENCE_MS);
    say('fix it someone else', 100);
    quiet(PHRASE_SILENCE_MS);
    expect(kinds(sent)).toEqual(['words "fix it"', 'piece "fix it"', 'words ""', 'words "someone else"', 'piece "someone else" dropped', 'words ""']);
    expect(sent[4]).toMatchObject({ score: 0.31, f0: 240, dropped: true });
    expect(sent[1]).toMatchObject({ score: 0.9, f0: 110, dropped: false });
    expect(voiceprint.checks.map((one) => one.text)).toEqual(['fix it', 'someone else']);
    expect(voiceprint.checks[0]!.samples).toBeGreaterThan(0);
    expect(logs).toContain('piece dropped by the voice check (score 0.31): 2 words');
    expect(logs.filter((line) => line.startsWith('piece dropped')).join('\n')).not.toContain('someone else');
    expect(used).toEqual(['fix it']);
    quiet(2_000);
    expect(kinds(sent).at(-1)).toBe('utterance "fix it" final');

    say('someone talking', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    // Nothing kept: it ends as cut, so the hub sends nothing and forgets it.
    expect(kinds(sent).slice(-4)).toEqual(['words "someone talking"', 'piece "someone talking" dropped', 'words ""', 'utterance "" cut']);
  });

  it('judges the end of a turn again without a dropped piece, so someone else\'s words do not end the operator\'s turn', async () => {
    const voiceprint = fakeVoiceprint({ verdict: (text) => (text.includes('go ahead') ? { score: 0.2, f0: 120, dropped: true, reason: 'score' } : null) });
    const { say, quiet, sent, chats, listening } = setup({ voiceprint, turn: (chat) => (chat[1]!.content.includes('go ahead') ? 0.05 : 0.0001) });

    await listening();
    say('fix it', 100);
    quiet(PHRASE_SILENCE_MS);
    say('fix it go ahead', 100);
    quiet(400);
    await settle();
    quiet(800);
    await settle();
    expect(chats.map((chat) => chat[1]!.content)).toEqual(['fix it', 'fix it go ahead', 'fix it']);
    // The words "go ahead" earned a 2 s wait, which no longer counts.
    quiet(1_000);
    expect(sent.some((one) => one.type === 'utterance')).toBe(false);
    quiet(900);
    expect(kinds(sent).at(-1)).toBe('utterance "fix it" final');
  });

  it('records 60 s for enrolment with the mic off and no recogniser, sends none of it to a session, and saves the print', async () => {
    const voiceprint = fakeVoiceprint();
    const { dictation, capture, clock, sent, loads, logs } = setup({ voiceprint });

    dictation.enroll('start');
    await settle();
    expect(kinds(sent)).toEqual(['enrollment recording']);
    expect([capture.opens, loads.length, dictation.state]).toEqual([1, 0, 'off']);

    for (let at = 0; at < 600; at++) {
      capture.pcm(100);
    }

    clock.advance(59_000);
    dictation.enroll('start');
    expect(kinds(sent)).toEqual(['enrollment recording', 'enrollment recording']);
    clock.advance(1_000);
    expect(voiceprint.enrolls).toEqual([960_000]);
    expect(kinds(sent).at(-1)).toBe('enrollment enrolled');
    expect(capture.stream!.stopped).toBe(true);
    expect(logs).toContain('voiceprint enrolled from 20 windows, median pitch 107 Hz');
  });

  it('cancels an enrolment without saving, and fails one that cannot run without opening the microphone', async () => {
    const voiceprint = fakeVoiceprint();
    const { dictation, capture, clock, sent } = setup({ voiceprint });

    dictation.enroll('cancel');
    expect(sent).toEqual([]);
    dictation.enroll('start');
    await settle();
    capture.pcm(100);
    dictation.enroll('cancel');
    clock.advance(60_000);
    expect(kinds(sent)).toEqual(['enrollment recording', 'enrollment cancelled']);
    expect(voiceprint.enrolls).toEqual([]);
    expect(capture.stream!.stopped).toBe(true);

    const missing = setup({ voiceprint: fakeVoiceprint({ unavailable: 'No speaker model at m.' }) });

    missing.dictation.enroll('start');
    await settle();
    expect(missing.sent).toEqual([{ type: 'enrollment', state: 'failed', error: 'No speaker model at m.' }]);
    expect(missing.capture.opens).toBe(0);

    const none = setup();

    none.dictation.enroll('start');
    expect(none.sent).toEqual([{ type: 'enrollment', state: 'failed', error: 'The voice check is not available.' }]);
  });

  it('cuts dictation short for an enrolment, hears no words while it records, and listens again after a failed one', async () => {
    const voiceprint = fakeVoiceprint({ enrollError: 'The recording was too short: speak for at least 9 seconds.' });
    const { dictation, capture, clock, sent, say, listening } = setup({ voiceprint });

    await listening();
    say('about the', 200);
    dictation.enroll('start');
    await settle();
    expect(kinds(sent)).toEqual(['words "about the"', 'piece "about the"', 'words ""', 'utterance "about the" cut', 'enrollment recording']);
    expect([capture.opens, dictation.state]).toEqual([2, 'idle-off']);
    say('the quick brown fox', 2_000);
    expect(sent).toHaveLength(5);
    clock.advance(60_000);
    await settle();
    expect(sent.at(-1)).toEqual({ type: 'enrollment', state: 'failed', error: 'The recording was too short: speak for at least 9 seconds.' });
    expect([capture.opens, dictation.state]).toEqual([3, 'listening']);
  });

  it('fails an enrolment whose microphone fails', async () => {
    const voiceprint = fakeVoiceprint();
    const { dictation, capture, sent } = setup({ voiceprint });

    capture.fail = new Error('device gone');
    dictation.enroll('start');
    await settle();
    expect(sent.at(-1)).toEqual({ type: 'enrollment', state: 'failed', error: 'The microphone failed: device gone' });
    expect(voiceprint.enrolls).toEqual([]);
  });
  it('holds the words heard while a reply plays as its possible echo, and drops them once it ends and the audio is quiet', async () => {
    const { say, loud, sent, logs, speech, listening } = setup();

    await listening();
    speech.playing = { replyId: 'r1', text: 'The session token is refreshed in two places.', voice: 'marin' };
    loud('the session token is', 1_500);
    expect(sent).toEqual([]);
    speech.playing = null;
    // Still loud: the tail is checked for up to 1.5 s.
    loud('the session token is refreshed', 1_000);
    expect(sent).toEqual([]);
    say('the session token is refreshed', 1_000);
    expect(sent).toEqual([]);
    expect(logs).toContain('5 words heard over reply r1 dropped as its echo');
    expect(logs.join('\n')).not.toContain('session token');
    expect(speech.interrupts).toBe(0);
    say('fix it', 100);
    expect(kinds(sent)).toEqual(['words "fix it"']);
  });

  it('barges in when the operator talks over a reply: stops it, recognises again from the onset, and the utterance names the reply and what was heard', async () => {
    const { engine, say, quiet, loud, sent, logs, speech, listening } = setup();

    await listening();
    speech.playing = { replyId: 'r1', text: 'The session token is refreshed in two places.', voice: 'marin' };
    speech.heard = { said: 'The session token', rest: 'is refreshed in two places.' };
    loud('hold on wait', 300);
    expect(speech.interrupts).toBe(0);
    loud('hold on wait', 200);
    expect(speech.interrupts).toBe(1);
    expect(engine.streams).toBe(2);
    expect(logs).toContain('barge-in on reply r1 (strong, score none, reply voice none): 3 words');
    say('hold on wait', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(kinds(sent)).toEqual(['words "hold on wait"', 'piece "hold on wait"', 'words ""', 'utterance "hold on wait" final']);
    expect(sent.at(-1)).toMatchObject({ interrupted: { replyId: 'r1', said: 'The session token', rest: 'is refreshed in two places.' } });
  });

  it('checks the tail of a reply that just ended, and opens an utterance naming no reply when a barge-in fires there', async () => {
    const { say, quiet, loud, sent, speech, listening } = setup();

    await listening();
    speech.playing = { replyId: 'r1', text: 'Done.', voice: 'marin' };
    loud('', 1_000);
    speech.playing = null;
    loud('stop that please', 600);
    expect(speech.interrupts).toBe(1);
    say('stop that please', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(sent.at(-1)).toMatchObject({ type: 'utterance', text: 'stop that please', final: true, interrupted: null });
  });

  it('lets the words of an utterance already open when a reply starts through, with no barge-in check', async () => {
    const { say, loud, sent, speech, listening } = setup();

    await listening();
    say('about the', 200);
    speech.playing = { replyId: 'r1', text: 'Done.', voice: 'marin' };
    loud('about the other thing', 1_000);
    expect(kinds(sent)).toEqual(['words "about the"', 'words "about the other thing"']);
    expect(speech.interrupts).toBe(0);
  });
  it('on half-duplex capture hears nothing while the voice plays and for the tail after, with no barge-in, and then listens afresh', async () => {
    const { clock, capture, engine, dictation, say, quiet, loud, sent, logs, speech, listening } = setup();

    capture.halfDuplex = 'no echo cancellation on Remote Audio';
    await listening();
    expect(dictation.halfDuplex).toBe('no echo cancellation on Remote Audio; echo check: not measured yet');
    expect(logs).toContain('listening: half-duplex (no echo cancellation on Remote Audio; echo check: not measured yet)');
    speech.playing = { replyId: 'r1', text: 'The session token is refreshed in two places.', voice: 'marin' };
    speech.until = Infinity;
    loud('hold on wait', 2_000);
    expect(sent).toEqual([]);
    expect(speech.interrupts).toBe(0);
    expect(logs).toContain('listening paused while the voice plays (half-duplex)');

    // The reply ended: still deaf for voice.halfDuplexTailMs (800 ms), as the echo comes back late over Remote Desktop.
    speech.playing = null;
    speech.until = clock.t;
    loud('places', 700);
    expect(sent).toEqual([]);
    expect(dictation.state).toBe('listening');

    const streams = engine.streams;

    quiet(200);
    expect(logs.at(-1)).toBe('listening resumes');
    expect(engine.streams).toBe(streams + 1);
    say('fix the login', 300);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(kinds(sent)).toEqual(['words "fix the login"', 'piece "fix the login"', 'words ""', 'utterance "fix the login" final']);
    expect(sent.at(-1)).toMatchObject({ interrupted: null });

    // The mode is logged when it changes, not at each open.
    dictation.typing(true);
    dictation.typing(false);
    await settle();
    expect(logs.filter((line) => line.startsWith('listening: '))).toHaveLength(1);
    capture.halfDuplex = null;
    dictation.typing(true);
    dictation.typing(false);
    await settle();
    expect(dictation.halfDuplex).toBeNull();
    expect(logs.filter((line) => line.startsWith('listening: '))).toEqual(['listening: half-duplex (no echo cancellation on Remote Audio; echo check: not measured yet)', 'listening: full duplex (echo cancelled)']);
  });

  it('on half-duplex capture cuts the utterance open when the voice starts playing, keeping its words unsent, and follows voice.halfDuplexTailMs', async () => {
    const { clock, capture, say, quiet, loud, sent, logs, speech, listening } = setup({ settings: { halfDuplexTailMs: 300 } });

    capture.halfDuplex = 'no echo cancellation on Remote Audio';
    await listening();
    say('about the', 200);
    speech.until = Infinity;
    loud('about the', 100);
    expect(kinds(sent)).toEqual(['words "about the"', 'piece "about the"', 'words ""', 'utterance "about the" cut']);
    // Nothing heard over the reply is reported.
    loud('about the other thing', 1_000);
    expect(sent).toHaveLength(4);
    expect(logs).toContain('listening paused while the voice plays (half-duplex): the utterance being heard is cut and kept in the draft');
    speech.until = clock.t;
    quiet(200);
    expect(logs).not.toContain('listening resumes');
    quiet(100);
    expect(logs.at(-1)).toBe('listening resumes');
    say('next', 100);
    expect(kinds(sent).at(-1)).toBe('words "next"');
  });

  it('on half-duplex capture cuts an utterance when the voice starts playing between two chunks of audio, never ending it as final', async () => {
    const { clock, capture, say, sent, speech, listening } = setup();

    capture.halfDuplex = 'no echo cancellation on Remote Audio';
    await listening();
    say('fix the login', 100);
    // Quiet past the piece's pause, then a reply starts with the end-of-message pause almost over and no audio after it.
    for (let at = 0; at < 2_500; at += 100) {
      capture.pcm(100);
      clock.advance(100);
    }

    speech.until = Infinity;
    clock.advance(1_000);
    expect(kinds(sent).at(-1)).toBe('utterance "fix the login" cut');
    expect(sent.some((one) => one.type === 'utterance' && one.final)).toBe(false);
  });

  it('on full-duplex capture ignores when the voice played', async () => {
    const { capture, say, sent, speech, listening, logs } = setup();

    await listening();
    expect(capture.halfDuplex).toBeNull();
    expect(logs).toContain('listening: full duplex (echo cancelled)');
    speech.until = Infinity;
    say('fix it', 100);
    expect(kinds(sent)).toEqual(['words "fix it"']);
  });

  it('follows voice.duplex before the capture\'s echo cancellation, for this computer or Remote Desktop, and applies a change at once', async () => {
    const { clock, capture, dictation, say, loud, sent, logs, speech, listening, settings, engine } = setup({ settings: { duplex: { local: 'auto', remote: 'full' } } });

    // Over Remote Desktop with no canceller, full duplex as set: it hears words while the voice plays.
    capture.halfDuplex = 'no echo cancellation on Remote Audio';
    capture.remote = true;
    await listening();
    expect(dictation.halfDuplex).toBeNull();
    expect(logs).toContain('listening: full duplex (set to full duplex over Remote Desktop; no echo cancellation on Remote Audio)');
    speech.until = Infinity;
    say('fix it', 100);
    expect(kinds(sent)).toEqual(['words "fix it"']);

    // Set to half: listening pauses at the next audio, the utterance cut.
    settings.duplex = { local: 'auto', remote: 'half' };
    dictation.settingsChanged();
    expect(dictation.halfDuplex).toBe('set to half duplex over Remote Desktop');
    expect(logs.at(-1)).toBe('listening: half-duplex (set to half duplex over Remote Desktop)');
    say('fix it', 100);
    expect(kinds(sent).at(-1)).toBe('utterance "fix it" cut');
    expect(dictation.state).toBe('listening');

    // Back to full while deaf: listening resumes at once on a fresh recogniser stream.
    const streams = engine.streams;

    settings.duplex = { local: 'auto', remote: 'full' };
    dictation.settingsChanged();
    expect(logs.slice(-2)).toEqual(['listening resumes', 'listening: full duplex (set to full duplex over Remote Desktop; no echo cancellation on Remote Audio)']);
    expect(engine.streams).toBe(streams + 1);
    clock.advance(100);

    // On this computer the local setting applies: auto keeps the capture's own reason; half applies even with echo cancellation.
    capture.remote = false;
    dictation.typing(true);
    dictation.typing(false);
    await settle();
    expect(dictation.halfDuplex).toBe('no echo cancellation on Remote Audio; echo check: not measured yet');
    settings.duplex = { local: 'half', remote: 'full' };
    capture.halfDuplex = null;
    dictation.typing(true);
    dictation.typing(false);
    await settle();
    expect(dictation.halfDuplex).toBe('set to half duplex on this computer');
    expect(logs.filter((line) => line.startsWith('listening: ')).slice(-2)).toEqual(['listening: half-duplex (no echo cancellation on Remote Audio; echo check: not measured yet)', 'listening: half-duplex (set to half duplex on this computer)']);
  });

  it('under auto, stays half-duplex on capture with no echo cancellation while the echo check hears the speakers', async () => {
    const t = setup();

    t.capture.halfDuplex = 'no echo cancellation on Remote Audio';
    t.capture.remote = true;
    await t.listening();
    expect(t.dictation.halfDuplex).toBe('no echo cancellation on Remote Audio; echo check: not measured yet');
    expect(t.logs).toContain('listening: half-duplex (no echo cancellation on Remote Audio; echo check: not measured yet)');
    playOver(t, echoWav('echo-remote.wav'), 'r1');

    const measured = t.logs.find((line) => line.startsWith('echo check: '));

    expect(measured).toMatch(/^echo check: echo \(r 0\.\d+ at \d+ ms, level -\d+(\.\d)? dBFS, range \d+(\.\d)? dB, 1\.\d s played; hint: none over Remote Desktop, whose Remote Audio says nothing of headphones\)$/);
    expect(t.dictation.halfDuplex).toBe('no echo cancellation on Remote Audio; echo check: echo detected');
    expect(t.dictation.fullDuplex).toBeNull();
    expect(t.sent).toEqual([]);
  });

  it('under auto, listens while the voice plays once two echo checks in a row hear none, and is half-duplex again at the reply\'s own words', async () => {
    const t = setup();

    t.capture.halfDuplex = 'no echo cancellation on Microphone';
    await t.listening();
    playOver(t, echoWav('quiet.wav'), 'r1');
    expect(t.logs.filter((line) => line.startsWith('echo check: '))).toEqual([expect.stringMatching(/^echo check: none \(r .*; hint: none; 1 of 2 in a row\)$/)]);
    expect(t.dictation.halfDuplex).toBe('no echo cancellation on Microphone; echo check: not measured yet');
    playOver(t, echoWav('quiet.wav'), 'r2');
    expect(t.logs.filter((line) => line.startsWith('echo check: ')).at(-1)).toMatch(/2 of 2 in a row\)$/);
    expect(t.logs.at(-1)).toBe('listening: full duplex (echo check: no echo detected; no echo cancellation on Microphone)');
    expect([t.dictation.halfDuplex, t.dictation.fullDuplex]).toEqual([null, 'echo check: no echo detected']);

    // Full duplex: a reply plays and its own words are heard over it, as when the headphones come off; half-duplex at once, and the words
    // that are not the reply's neither barge in nor reach the session, though no voiceprint is enrolled.
    playOver(t, echoWav('quiet.wav'), 'r3', () => (t.engine.text = 'tests passed and stop now'));
    expect(t.logs).toContain('echo check: 3 of 5 words heard over the reply are its own: half-duplex again');
    expect(t.logs).toContain('listening: half-duplex (no echo cancellation on Microphone; echo check: echo detected)');
    expect(t.logs).toContain('listening paused while the voice plays (half-duplex): 5 words heard over the reply dropped as its echo');
    expect(t.speech.interrupts).toBe(0);
    expect(t.sent).toEqual([]);
    // Listening resumes after the reply, afresh.
    expect(t.logs).toContain('listening resumes');
  });

  it('under auto, is half-duplex again when a check in full duplex hears echo, and starts over when the mic is turned on again', async () => {
    const t = setup();

    t.capture.halfDuplex = 'no echo cancellation on Microphone';
    await t.listening();
    playOver(t, echoWav('quiet.wav'), 'r1');
    playOver(t, echoWav('quiet.wav'), 'r2');
    expect(t.dictation.fullDuplex).toBe('echo check: no echo detected');
    playOver(t, echoWav('echo-local.wav'), 'r3');
    expect(t.logs.filter((line) => line.startsWith('echo check: ')).at(-1)).toMatch(/^echo check: echo \(.*\): half-duplex again$/);
    expect(t.dictation.halfDuplex).toBe('no echo cancellation on Microphone; echo check: echo detected');

    t.dictation.mic(false);
    t.dictation.mic(true);
    t.watch.changed?.(false, []);
    await settle();
    expect(t.logs).toContain('echo check starts over: the mic was turned on');
    expect(t.dictation.halfDuplex).toBe('no echo cancellation on Microphone; echo check: not measured yet');

    // A measurement pending when the devices change is dropped: headphones now, and nothing measured on them yet.
    playOver(t, echoWav('quiet.wav'), 'r4', undefined, 0);
    t.watch.devices!({ output: 'Headphones (WH-1000XM4)', outputId: 'h#1', formFactor: 'headphones', input: 'Microphone (BRIO)', inputId: 'b#1', remote: false });
    t.watch.devices!({ output: 'Headphones (WH-1000XM4)', outputId: 'h#2', formFactor: 'headphones', input: 'Microphone (BRIO)', inputId: 'b#1', remote: false });
    t.quiet(1_000);
    expect(t.logs.filter((line) => line.startsWith('echo check: '))).toHaveLength(3);
    expect(t.dictation.fullDuplex).toBeNull();

    // Another capture device starts it over too.
    playOver(t, echoWav('quiet.wav'), 'r4');
    t.settings.inputDevice = 'Headset';
    t.dictation.settingsChanged();
    expect(t.logs.slice(-2)).toEqual(['echo check starts over: the capture or playback device changed', 'listening: half-duplex (no echo cancellation on Microphone; echo check: not measured yet)']);
  });

  it('under auto, needs one check that hears none with headphones on this computer, and starts over when the devices change', async () => {
    const t = setup();

    t.capture.halfDuplex = 'no echo cancellation on Microphone';
    await t.listening();
    t.watch.devices!({ output: 'Headphones (WH-1000XM4)', outputId: 'Headphones (WH-1000XM4)#1', formFactor: 'headphones', input: 'Microphone (WH-1000XM4)', inputId: 'Microphone (WH-1000XM4)#1', remote: false });
    expect(t.logs).toContain('devices: playback "Headphones (WH-1000XM4)" (headphones), capture "Microphone (WH-1000XM4)", on this computer');
    playOver(t, echoWav('quiet.wav'), 'r1');
    expect(t.logs.filter((line) => line.startsWith('echo check: '))).toEqual([expect.stringMatching(/hint: headphones \(form factor headphones of "Headphones \(WH-1000XM4\)"\); 1 of 1 in a row\)$/)]);
    expect(t.dictation.fullDuplex).toBe('echo check: no echo detected');

    // Speakers now: the check starts over, half-duplex, and two checks are needed again.
    t.watch.devices!({ output: 'LG HDR 4K', outputId: 'LG HDR 4K#1', formFactor: 'speakers', input: 'Microphone (BRIO)', inputId: 'Microphone (BRIO)#1', remote: false });
    expect(t.logs).toContain('echo check starts over: the playback or capture device changed');
    expect(t.dictation.halfDuplex).toBe('no echo cancellation on Microphone; echo check: not measured yet');
    playOver(t, echoWav('quiet.wav'), 'r2');
    expect(t.logs.filter((line) => line.startsWith('echo check: ')).at(-1)).toMatch(/hint: no headphones \(form factor speakers of "LG HDR 4K"\); 1 of 2 in a row\)$/);

    // A Remote Desktop session: its own start over, and the headphones hint is not used there.
    t.watch.devices!({ output: 'Remote Audio', outputId: 'Remote Audio#1', formFactor: 'remote network device', input: 'Remote Audio', inputId: 'Remote Audio#1', remote: true });
    expect(t.logs).toContain('echo check starts over: a Remote Desktop session started');
    playOver(t, echoWav('quiet.wav'), 'r3');
    expect(t.logs.filter((line) => line.startsWith('echo check: ')).at(-1)).toMatch(/hint: none over Remote Desktop, whose Remote Audio says nothing of headphones; 1 of 2 in a row\)$/);
  });

  it('watches the playback device voice.outputDevice names, starting another watcher when it changes', async () => {
    const t = setup();

    t.capture.halfDuplex = 'no echo cancellation on Microphone';
    await t.listening();
    t.watch.devices!({ output: 'Speakers', outputId: 's#1', formFactor: 'speakers', input: 'Microphone (BRIO)', inputId: 'b#1', remote: false });
    playOver(t, echoWav('quiet.wav'), 'r0');
    t.dictation.settingsChanged();
    expect(t.watch.closed).toBe(0);
    const old = { changed: t.watch.changed!, devices: t.watch.devices! };

    t.settings.outputDevice = 'LG';
    t.dictation.settingsChanged();
    expect(t.watch.closed).toBe(1);
    // The closed watcher's late lines count for nothing: another app recording, as the new one says, keeps the mic paused.
    t.watch.changed!(true, ['Teams']);
    expect(t.dictation.state).toBe('paused-other-app');
    old.changed(false, []);
    old.devices({ output: 'Speakers', formFactor: 'speakers', input: 'Microphone (BRIO)', remote: true });
    expect(t.dictation.state).toBe('paused-other-app');
    expect(t.logs.filter((line) => line.startsWith('devices: '))).toHaveLength(1);
    t.watch.changed!(false, []);
    await settle();
    // The old watcher's hint is gone, and the check starts over for the other device.
    expect(t.logs).toContain('echo check starts over: the capture or playback device changed');
    playOver(t, echoWav('quiet.wav'), 'r1');
    expect(t.logs.filter((line) => line.startsWith('echo check: ')).at(-1)).toMatch(/hint: none; 1 of 2 in a row\)$/);
  });

  it('keeps a Remote Desktop session it was told of when voice.outputDevice changes, until the new watcher says', async () => {
    const t = setup({ settings: { duplex: { local: 'full', remote: 'half' } } });

    t.capture.halfDuplex = 'no echo cancellation on Microphone';
    await t.listening();
    t.watch.devices!({ output: 'Remote Audio', formFactor: 'remote network device', input: 'Remote Audio', remote: true });
    t.settings.outputDevice = 'Remote';
    t.dictation.settingsChanged();
    expect(t.dictation.halfDuplex).toBe('set to half duplex over Remote Desktop');
  });

  it('follows voice.duplex for the session the watcher reports, as the session switches between this computer and Remote Desktop', async () => {
    const t = setup({ settings: { duplex: { local: 'full', remote: 'half' } } });

    t.capture.halfDuplex = 'no echo cancellation on Microphone';
    await t.listening();
    expect(t.dictation.fullDuplex).toBe('set on this computer');
    t.watch.devices!({ output: 'Remote Audio', formFactor: 'remote network device', input: 'Remote Audio', remote: true });
    expect([t.dictation.halfDuplex, t.logs.at(-1)]).toEqual(['set to half duplex over Remote Desktop', 'listening: half-duplex (set to half duplex over Remote Desktop)']);
    t.watch.devices!({ output: 'LG HDR 4K', formFactor: 'speakers', input: 'Microphone (BRIO)', remote: false });
    expect(t.dictation.fullDuplex).toBe('set on this computer');
  });

  it('runs no echo check when voice.duplex is set, or on capture that cancels the echo', async () => {
    for (const [halfDuplex, duplex] of [['no echo cancellation on Microphone', { local: 'half', remote: 'auto' }], ['no echo cancellation on Microphone', { local: 'full', remote: 'auto' }], [null, { local: 'auto', remote: 'auto' }]] as const) {
      const t = setup({ settings: { duplex } });

      t.capture.halfDuplex = halfDuplex;
      await t.listening();
      playOver(t, echoWav('quiet.wav'), 'r1');
      playOver(t, echoWav('quiet.wav'), 'r2');
      expect(t.logs.filter((line) => line.startsWith('echo check'))).toEqual([]);
    }
  });

  it('checks the words an early end was judged on before closing, and judges again without them when they fail', async () => {
    const voiceprint = fakeVoiceprint({ verdict: (text) => (text.includes('go ahead') ? { score: 0.2, f0: 120, dropped: true, reason: 'score' } : null) });
    const { say, quiet, sent, chats, listening } = setup({ voiceprint, turn: (chat) => (chat[1]!.content.includes('go ahead') ? 0.9 : 0.0001) });

    await listening();
    say('change the login', 100);
    quiet(PHRASE_SILENCE_MS);
    say('change the login go ahead', 100);
    quiet(400);
    await settle();
    // 0.9 earned a 0.5 s wait; the words are checked then, fail, and the turn stays open.
    quiet(300);
    await settle();
    expect(kinds(sent).slice(-2)).toEqual(['piece "go ahead" dropped', 'words ""']);
    expect(chats.map((chat) => chat[1]!.content)).toEqual(['change the login', 'change the login go ahead', 'change the login']);
    expect(sent.some((one) => one.type === 'utterance')).toBe(false);
    quiet(2_500);
    expect(kinds(sent).at(-1)).toBe('utterance "change the login" final');
  });

  it('opens capture again for dictation when an enrolment it opened for ends before the device answers', async () => {
    const voiceprint = fakeVoiceprint();
    const { dictation, capture, loads, listening, say, sent } = setup({ voiceprint });
    let release!: () => void;

    capture.hold = new Promise((resolve) => (release = resolve));
    dictation.enroll('start');
    await settle();
    dictation.enroll('cancel');
    capture.hold = null;
    await listening();
    release();
    await settle();
    await settle();
    expect(loads).toHaveLength(1);
    expect(capture.opens).toBe(2);
    expect(dictation.state).toBe('listening');
    say('fix it', 100);
    expect(kinds(sent).at(-1)).toBe('words "fix it"');
  });
});

describe('Dictation room hold', () => {
  const someoneElse = (text: string): PieceCheck | null => (text.includes('dinner') ? { score: 0.2, f0: 220, dropped: true, reason: 'score' } : null);

  it('holds dictated turns for voice.roomHoldSeconds after a voice that is not the operator\'s, extends at each one, and ends on its own', async () => {
    const { dictation, say, quiet, logs, clock, changed, listening } = setup({ voiceprint: fakeVoiceprint({ verdict: someoneElse }), settings: { roomHoldSeconds: 30 } });

    await listening();
    expect(dictation.roomHold).toBeNull();
    const before = changed();
    say('is dinner ready', 100);
    quiet(PHRASE_SILENCE_MS);
    expect(dictation.roomHold).toBeGreaterThan(clock.t + 29_000);
    expect(dictation.roomHold).toBeLessThanOrEqual(clock.t + 30_000);
    expect(changed()).toBeGreaterThan(before);
    expect(logs).toContain('room hold started: someone else is talking, so dictated messages stay in the composer for 30 s');
    const first = dictation.roomHold!;
    quiet(10_000);
    say('dinner in five', 100);
    quiet(PHRASE_SILENCE_MS);
    expect(dictation.roomHold).toBeGreaterThan(first);
    expect(logs.at(-1)).toBe('room hold extended: someone else is talking, so dictated messages stay in the composer for 30 s');
    const until = dictation.roomHold!;
    quiet(until - clock.t - 100);
    expect(dictation.roomHold).toBe(until);
    quiet(200);
    expect(dictation.roomHold).toBeNull();
    expect(logs).toContain('room hold ended: dictated messages send on their own again');
  });

  it('starts no hold for the operator\'s own words, with voice.roomHold off, or for a piece that may be a reply\'s echo', async () => {
    const own = setup({ voiceprint: fakeVoiceprint({ verdict: someoneElse }) });

    await own.listening();
    own.say('fix the login', 100);
    own.quiet(PHRASE_SILENCE_MS);
    expect(own.dictation.roomHold).toBeNull();

    const off = setup({ voiceprint: fakeVoiceprint({ verdict: someoneElse }), settings: { roomHold: false } });

    await off.listening();
    off.say('is dinner ready', 100);
    off.quiet(PHRASE_SILENCE_MS);
    expect(off.dictation.roomHold).toBeNull();

    // Like a learnt reply voice.
    const echo = setup({ voiceprint: fakeVoiceprint({ verdict: someoneElse, replyVoice: 0.8 }) });

    await echo.listening();
    echo.say('is dinner ready', 100);
    echo.quiet(PHRASE_SILENCE_MS);
    expect(echo.dictation.roomHold).toBeNull();
    expect(echo.logs).toContain('no room hold: the dropped piece sounds like a reply voice (0.8)');

    // Just after a reply stopped playing.
    const after = setup({ voiceprint: fakeVoiceprint({ verdict: someoneElse, replyVoice: 0.3 }) });

    await after.listening();
    after.speech.until = after.clock.t;
    after.say('is dinner ready', 100);
    after.quiet(PHRASE_SILENCE_MS);
    expect(after.dictation.roomHold).toBeNull();
    after.quiet(3_000);
    after.say('is dinner ready now', 100);
    after.quiet(PHRASE_SILENCE_MS);
    expect(after.dictation.roomHold).not.toBeNull();
  });

  it('ends a hold when voice.roomHold is turned off, and when the dictation closes', async () => {
    const { dictation, say, quiet, settings, logs, listening } = setup({ voiceprint: fakeVoiceprint({ verdict: someoneElse }) });

    await listening();
    say('is dinner ready', 100);
    quiet(PHRASE_SILENCE_MS);
    expect(dictation.roomHold).not.toBeNull();
    settings.roomHold = false;
    dictation.settingsChanged();
    expect(dictation.roomHold).toBeNull();
    expect(logs.at(-1)).toBe('room hold ended: voice.roomHold is off');
    settings.roomHold = true;
    quiet(5_000);
    say('dinner is ready', 100);
    quiet(PHRASE_SILENCE_MS);
    expect(dictation.roomHold).not.toBeNull();
    dictation.close();
    expect(dictation.roomHold).toBeNull();
  });
});

describe('Dictation spoken commands', () => {
  it('pauses on "stop listening" said alone, sends none of it, and hears only "start listening" until then', async () => {
    const { dictation, say, quiet, sent, logs, capture, listening } = setup();

    await listening();
    say('Stop listening.', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(kinds(sent)).toEqual(['words "Stop listening."', 'words ""', 'command stop-listening', 'utterance "" cut']);
    expect(sent[2]).toMatchObject({ type: 'command', text: 'Stop listening.', sessionId: 's1', utteranceId: 'id1' });
    expect(dictation.state).toBe('paused-by-voice');
    expect(logs).toContain('listening paused by voice: only "start listening" is heard until then');
    // Capture keeps running for the command that resumes.
    expect(capture.open_).toBe(true);

    const before = sent.length;
    say('so what do you think about dinner', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(sent.slice(before)).toEqual([]);
    say('resume listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(kinds(sent.slice(before))).toEqual(['command start-listening']);
    expect(sent.at(-1)).toMatchObject({ utteranceId: null, sessionId: 's1' });
    expect(dictation.state).toBe('listening');
    say('fix the login', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(kinds(sent).slice(-4)).toEqual(['words "fix the login"', 'piece "fix the login"', 'words ""', 'utterance "fix the login" final']);
  });

  it('sends a command said inside a longer utterance, or cut short, as dictation', async () => {
    const { dictation, say, quiet, sent, listening } = setup();

    await listening();
    say('stop listening', 100);
    quiet(PHRASE_SILENCE_MS);
    say('stop listening to the radio', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(kinds(sent).filter((one) => one.startsWith('piece') || one.startsWith('utterance') || one.startsWith('command'))).toEqual(['piece "stop listening"', 'piece "to the radio"', 'utterance "stop listening to the radio" final']);
    expect(dictation.state).toBe('listening');

    say('start listening now please', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(kinds(sent).at(-1)).toBe('utterance "start listening now please" final');

    say('pause listening', 100);
    quiet(PHRASE_SILENCE_MS);
    dictation.typing(true);
    expect(kinds(sent).slice(-2)).toEqual(['piece "pause listening"', 'utterance "pause listening" cut']);
    expect(dictation.state).toBe('typing');
  });

  it('resumes only on a "start listening" that clears voice.matchThreshold without the short-piece allowance', async () => {
    const voiceprint = fakeVoiceprint({ enrolled: true, verdict: (text) => (text === 'start listening' ? { score: 0.55, f0: 120, dropped: false, reason: null } : null) });
    const { dictation, say, quiet, logs, listening } = setup({ voiceprint });

    await listening();
    say('stop listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(dictation.state).toBe('paused-by-voice');
    say('start listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(dictation.state).toBe('paused-by-voice');
    expect(logs.at(-1)).toBe('start listening not taken: its voice match 0.55 is under voice.matchThreshold');
    say('resume listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(dictation.state).toBe('listening');
  });

  it('takes no command in another voice, resumes on Mic on, and keeps the room hold while paused', async () => {
    const voiceprint = fakeVoiceprint({ verdict: (text) => (text.includes('other') || text === 'start listening' ? { score: 0.2, f0: 230, dropped: true, reason: 'score' } : null) });
    const { dictation, say, quiet, sent, listening } = setup({ voiceprint });

    await listening();
    say('pause listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(dictation.state).toBe('paused-by-voice');
    // Someone else's "start listening" does not resume, and holds.
    say('start listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(dictation.state).toBe('paused-by-voice');
    expect(dictation.roomHold).not.toBeNull();
    expect(kinds(sent).filter((one) => one.startsWith('command'))).toEqual(['command stop-listening']);
    dictation.mic(true);
    expect(dictation.state).toBe('listening');

    // Off and on again also clears a pause.
    say('stop listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(dictation.state).toBe('paused-by-voice');
    dictation.mic(false);
    dictation.mic(true);
    expect(dictation.state).not.toBe('paused-by-voice');
  });

  it('resumes only on a whole utterance while paused: a command split by a pause counts, one with more words or cut short does not', async () => {
    const { dictation, say, quiet, sent, spoke, listening } = setup();

    await listening();
    say('stop listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    // Talking while paused restarts the away timeout's count.
    const spoken = spoke();
    say('start listening', 100);
    quiet(PHRASE_SILENCE_MS);
    expect(spoke()).toBeGreaterThan(spoken);
    say('start listening to the radio', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(dictation.state).toBe('paused-by-voice');
    say('start', 100);
    quiet(PHRASE_SILENCE_MS);
    say('start listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(dictation.state).toBe('listening');
    expect(kinds(sent).filter((one) => one.startsWith('command'))).toEqual(['command stop-listening', 'command start-listening']);

    say('stop listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    say('start listening', 100);
    quiet(PHRASE_SILENCE_MS);
    dictation.typing(true);
    dictation.typing(false);
    await settle();
    quiet(4_000);
    expect(dictation.state).toBe('paused-by-voice');
  });

  it('drops what was said while paused when Mic on resumes, so none of it reaches the draft', async () => {
    const { dictation, say, quiet, sent, listening } = setup();

    await listening();
    say('stop listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    const before = sent.length;
    say('this is for my wife', 400);
    dictation.mic(true);
    quiet(PHRASE_SILENCE_MS + 3_000);
    expect(dictation.state).toBe('listening');
    expect(sent.slice(before)).toEqual([]);

    say('stop listening', 100);
    quiet(PHRASE_SILENCE_MS + 3_000);
    const paused = sent.length;
    say('more for my wife', 400);
    dictation.mic(false);
    expect(sent.slice(paused)).toEqual([]);
  });
});
