import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BargeIn, gate, novelWords, pcm24to16, splitSaid } from '../src/barge.js';
import type { HeardAudio } from '../src/barge.js';
import { loudness, normalize, Voiceprint } from '../src/voiceprint.js';

const RATE = 16_000;
const SETTINGS = { matchThreshold: 0.6, pitchLowFactor: 1.22, pitchMinLowShare: 0.2 };
const REPLY = "I looked at the login flow. The session token is refreshed in two places, and the second one runs after the redirect, so the old token wins.";

/** A voice-like tone: three harmonics with a slight vibrato. */
function tone(seconds: number, hz: number, amplitude = 0.3): Float32Array {
  let phase = 0;

  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, index) => {
    phase += (2 * Math.PI * hz * (1 + 0.03 * Math.sin((2 * Math.PI * 5 * index) / RATE))) / RATE;
    return (amplitude * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase))) / 1.8;
  });
}

/** Audio heard so far, fed 160 ms at a time as capture delivers it, with the recogniser's words. */
class Heard implements HeardAudio {
  #audio = new Float32Array(0);
  words = '';

  get total(): number {
    return this.#audio.length;
  }

  feed(samples: Float32Array): void {
    const next = new Float32Array(this.#audio.length + samples.length);

    next.set(this.#audio);
    next.set(samples, this.#audio.length);
    this.#audio = next;
  }

  samples(from: number): Float32Array {
    return this.#audio.slice(Math.max(0, from));
  }
}

/** Plays `audio` into the check in 160 ms chunks; the barge-in and the sample count it fired at, or null. */
function play(barge: BargeIn, audio: Float32Array, words = ''): { fired: ReturnType<BargeIn['check']>; at: number } {
  const heard = new Heard();

  heard.words = words;

  for (let at = 0; at < audio.length; at += 2560) {
    heard.feed(audio.subarray(at, at + 2560));

    const fired = barge.check(heard, SETTINGS);

    if (fired !== null) {
      return { fired, at: heard.total };
    }
  }

  return { fired: null, at: heard.total };
}

/** A voiceprint enrolled on a loud low voice, whose embedder reads loud audio as [1, 0] and quiet audio as [0, 1]. */
function enrolled(): Voiceprint {
  const dir = mkdtempSync(join(tmpdir(), 'sb-barge-'));
  const embedder = () => ({ embed: (samples: Float32Array) => (samples.length < RATE / 2 ? null : normalize(loudness(samples) > 0.1 ? [1, 0] : [0, 1])) });
  const voiceprint = new Voiceprint({ dir, embedder, log: () => undefined });

  voiceprint.enroll(tone(13, 120));
  return voiceprint;
}

describe('novelWords', () => {
  it('reads heard words in the reply\'s order, a word cut short and a lone reply word as echo, and other words as new', () => {
    const first = (heard: string): number => novelWords(heard.split(' '), REPLY).first;

    expect(first('the session token is')).toBe(-1);
    expect(first('session tok')).toBe(-1);
    expect(first('refres')).toBe(-1);
    expect(first('hold on the session')).toBe(0);
    expect(first('token')).toBe(-1);
    expect(first('stop')).toBe(0);
    expect(novelWords(['hold', 'on', 'the', 'session'], REPLY).count).toBe(2);
    expect(novelWords(['wait'], '')).toEqual({ first: 0, count: 1 });
  });
});

describe('splitSaid', () => {
  it('splits a passage at the played characters, counting a word cut partway as not heard', () => {
    expect(splitSaid('Fixed the login flow.', 9)).toEqual({ said: 'Fixed the', rest: 'login flow.' });
    expect(splitSaid('Fixed the login flow.', 12)).toEqual({ said: 'Fixed the', rest: 'login flow.' });
    expect(splitSaid('Fixed the login flow.', 0)).toEqual({ said: '', rest: 'Fixed the login flow.' });
    expect(splitSaid('Fixed the login flow.', 3)).toEqual({ said: '', rest: 'Fixed the login flow.' });
    expect(splitSaid('Fixed the login flow.', 99)).toEqual({ said: 'Fixed the login flow.', rest: '' });
  });
});

describe('pcm24to16', () => {
  it('resamples 24 kHz 16-bit PCM to 16 kHz samples', () => {
    const pcm = Buffer.alloc(12);

    [0, 16_384, -16_384, 0, 16_384, 0].forEach((value, index) => pcm.writeInt16LE(value, index * 2));
    // Every third 16 kHz sample falls halfway between two 24 kHz ones.
    expect(Array.from(pcm24to16(pcm))).toEqual([0, 0, 0, 0.25]);
  });
});

describe('BargeIn', () => {
  it('fires on two words that are not the reply\'s echo without an enrolment, never on the echo, and checks nothing under the loudness gate', () => {
    expect(gate(0)).toBe(0.003);
    expect(play(new BargeIn(null, REPLY, 'marin'), tone(2, 200), 'the session token is').fired).toBeNull();
    expect(play(new BargeIn(null, REPLY, 'marin'), tone(2, 200, 0.002), 'hold on wait').fired).toBeNull();

    const { fired, at } = play(new BargeIn(null, REPLY, 'marin'), tone(2, 200), 'hold on wait');

    expect(fired).toMatchObject({ trigger: 'strong', score: null, words: 'hold on wait' });
    // The first check with half a second of loud audio.
    expect(at).toBe(4 * 2560);
    expect(fired!.from).toBe(0);
  });

  it('fires at once on the enrolled voice beating the reply voice\'s learnt print, and passes neither a high voice nor a quiet one', () => {
    const voiceprint = enrolled();

    voiceprint.learnVoice('marin', tone(3, 200, 0.05));
    expect(play(new BargeIn(voiceprint, REPLY, 'marin'), tone(2, 115), 'hold on').fired).toMatchObject({ trigger: 'strong', score: 1, ttsScore: 0 });
    expect(play(new BargeIn(voiceprint, REPLY, 'marin'), tone(2, 300), 'hold on').fired).toBeNull();
    // Over the gate, but [0, 1]: the reply voice, not the operator's.
    expect(play(new BargeIn(voiceprint, REPLY, 'marin'), tone(2, 115, 0.12), 'hold on').fired).toBeNull();
  });

  it('needs a pass confirmed 0.3 s later while the reply voice has no print yet, or while every word heard is the reply\'s echo', () => {
    const voiceprint = enrolled();
    const unlearnt = play(new BargeIn(voiceprint, REPLY, 'cedar'), tone(2, 115), 'hold on');

    expect(unlearnt.fired).toMatchObject({ trigger: 'confirmed', score: 1, ttsScore: null });
    expect(unlearnt.at).toBe(6 * 2560);

    voiceprint.learnVoice('marin', tone(3, 200, 0.05));

    const echo = play(new BargeIn(voiceprint, REPLY, 'marin'), tone(2, 115), 'the session token');

    expect(echo.fired).toMatchObject({ trigger: 'confirmed' });
    expect(echo.at).toBe(6 * 2560);
  });
});
