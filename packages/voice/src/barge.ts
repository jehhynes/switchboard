import { loudness, pitch, pitchTooHigh } from './voiceprint.js';
import type { Voiceprint, VoiceCheckSettings } from './voiceprint.js';

const RATE = 16_000;
/** Barge-in's bars over the voice match setting (claude-collab `barge.js`, measured in its findings of 2026-11-18). */
export const MARGIN = 0.1;
export const STRONG_OVER = 0.15;
export const STRONG_MARGIN = 0.2;
/** Voiced frames a short window needs before its pitch is judged. */
export const MIN_VOICED = 8;
/**
 * On a window this short the share of low frames is noisy, so a median above this multiple of the enrolled p90 also counts as too high; the
 * operator's animated speech, read an octave high on half its frames, peaked at 1.4 times it.
 */
const HIGH_MEDIAN = 1.6;
/** Any pass needs some voicing (60 ms): two other voices passed on windows with none. */
const MIN_VOICING = 3;
const WINDOW = 1.2 * RATE;
const MIN_WINDOW = 0.5 * RATE;
const CONFIRM = 0.3 * RATE;
/** Audio this far below the enrolled speaking level is too quiet to be the operator at the microphone; what echo cancellation leaves is quieter. */
const GATE_DB = -12;
/** Without an enrolment, a fixed floor keeps silence from being checked. */
const MIN_GATE = 0.003;

/** The recogniser's audio and words as barge-in reads them. */
export interface HeardAudio {
  /** Samples heard so far. */
  readonly total: number;
  /** The samples from `from` (an absolute sample count) to now, within the kept audio. */
  samples(from: number): Float32Array;
  /** The words not yet settled into a piece. */
  readonly words: string;
}

/** A barge-in: why it fired, and the sample its window began at, from which recognition starts again. */
export interface Barge {
  trigger: 'strong' | 'confirmed';
  from: number;
  score: number | null;
  ttsScore: number | null;
  words: string;
}

const norm = (word: string): string => word.toLowerCase().replace(/[^a-z0-9']/g, '');

/**
 * Words that are not the reply's echo: a run of two or more heard words that stand next to each other in the reply is echo, and so is a lone
 * heard word found anywhere in it; a heard word of three or more letters matches the start of a reply word, since the recogniser shows a word
 * still being spoken cut short. Returns the index of the first word that is not echo (-1 when all are) and how many are not.
 */
export function novelWords(words: string[], replyText: string): { first: number; count: number } {
  const heard = words.map(norm);
  const reply = replyText.split(/\s+/).map(norm).filter(Boolean);
  const echo = heard.map((word) => word === '');
  const like = (a: string, b: string): boolean => a === b || (a.length >= 3 && b.startsWith(a));

  if (reply.length > 0) {
    for (let index = 0; index + 1 < heard.length; index++) {
      if (heard[index] === '' || heard[index + 1] === '') {
        continue;
      }

      for (let at = 0; at + 1 < reply.length; at++) {
        if (like(heard[index]!, reply[at]!) && like(heard[index + 1]!, reply[at + 1]!)) {
          echo[index] = echo[index + 1] = true;
          break;
        }
      }
    }

    const real = heard.filter(Boolean);

    if (real.length === 1 && reply.some((word) => like(real[0]!, word))) {
      echo.fill(true);
    }
  }

  return { first: echo.indexOf(false), count: echo.filter((one) => !one).length };
}

/** The first 20 ms frame holding at least 10% of the window's peak energy. */
function trimLead(samples: Float32Array): number {
  const energies: number[] = [];
  let peak = 0;

  for (let start = 0; start + 320 <= samples.length; start += 320) {
    let energy = 0;

    for (let index = 0; index < 320; index++) {
      energy += samples[start + index]! * samples[start + index]!;
    }

    energies.push(energy);
    peak = Math.max(peak, energy);
  }

  const frame = energies.findIndex((energy) => energy >= peak * 0.1);

  return frame > 0 ? frame * 320 : 0;
}

/** The loudness below which audio is not checked: `GATE_DB` under the enrolled speaking level, or `MIN_GATE` without one. */
export function gate(level: number): number {
  return Math.max(MIN_GATE, level * 10 ** (GATE_DB / 20));
}

/**
 * Barge-in on one reply being played (architecture.md § Voice check and barge-in, from claude-collab `barge.js`). After each chunk of audio,
 * `check` reads the last 1.2 s from its first loud frame: audio under the loudness gate is not checked; the window must match the enrolled
 * voice by `voice.matchThreshold` and beat the reply voice's print by `MARGIN` (by `STRONG_OVER` over the bar while that print is not learnt
 * yet), with some voicing and a pitch that is not too high. A strong pass, with words that are not all the reply's echo, fires at once; an
 * ordinary pass fires once another passes at least 0.3 s later with no failure between. Without an enrolment or the model, two heard words that
 * are not echo fire it. The words alone never do: the recogniser follows the reply's echo even 20 dB under the operator's voice.
 */
export class BargeIn {
  #passAt: number | null = null;
  checks = 0;

  constructor(
    private readonly voiceprint: Voiceprint | null,
    /** The reply's spoken passage, whose words in what is heard are echo. */
    private readonly text: string,
    /** The voice it is spoken in, whose learnt print the operator's voice must beat. */
    private readonly voice: string,
  ) {}

  check(heard: HeardAudio, settings: VoiceCheckSettings): Barge | null {
    let samples = heard.samples(heard.total - WINDOW);
    const lead = trimLead(samples);

    if (samples.length - lead >= MIN_WINDOW) {
      samples = samples.subarray(lead);
    }

    if (samples.length < MIN_WINDOW || loudness(samples) < gate(this.voiceprint?.level ?? 0)) {
      this.#passAt = null;
      return null;
    }

    const from = heard.total - samples.length;
    const words = heard.words.split(/\s+/).filter(Boolean);
    const novel = novelWords(words, this.text);
    const allEcho = words.length > 0 && novel.first < 0;
    let pass: boolean;
    let strong: boolean;
    let score: number | null = null;
    let ttsScore: number | null = null;

    this.checks++;

    if (this.voiceprint === null || !this.voiceprint.enrolled || this.voiceprint.unavailable() !== null) {
      pass = strong = novel.count >= 2;
    } else {
      const embedding = this.voiceprint.embed(samples);
      const clip = pitch(samples);
      const enrolled = this.voiceprint.enrolledPitch;

      score = this.voiceprint.similarity(embedding);
      ttsScore = this.voiceprint.similarity(embedding, this.voiceprint.voicePrint(this.voice));

      const high = pitchTooHigh(clip, enrolled, settings, MIN_VOICED) || (enrolled?.p90 != null && clip.voiced >= MIN_VOICED && (clip.median ?? 0) > HIGH_MEDIAN * enrolled.p90);
      const bar = settings.matchThreshold;

      pass = score !== null && !high && clip.voiced >= MIN_VOICING && (ttsScore === null ? score >= bar + STRONG_OVER : score >= bar && score - ttsScore >= MARGIN);
      strong = pass && !allEcho && ttsScore !== null && clip.voiced >= MIN_VOICED && score! >= bar + STRONG_OVER && score! - ttsScore >= STRONG_MARGIN;
    }

    let trigger: Barge['trigger'] | null = null;

    if (strong) {
      trigger = 'strong';
    } else if (pass && this.#passAt !== null && heard.total - this.#passAt >= CONFIRM) {
      trigger = 'confirmed';
    } else if (pass) {
      this.#passAt ??= heard.total;
    } else {
      this.#passAt = null;
    }

    return trigger === null ? null : { trigger, from, score, ttsScore, words: words.join(' ') };
  }
}

/** The words of a passage up to `chars` played characters, a word cut partway counting as not heard, and the rest. */
export function splitSaid(text: string, chars: number): { said: string; rest: string } {
  const cut = Math.max(0, Math.min(text.length, chars));
  const at = cut === text.length || /\s/.test(text[cut] ?? ' ') ? cut : text.lastIndexOf(' ', cut);
  const end = Math.max(0, at);

  return { said: text.slice(0, end).trim(), rest: text.slice(end).trim() };
}

/** 24 kHz 16-bit PCM, as the voice plays it, to 16 kHz samples. */
export function pcm24to16(pcm: Buffer): Float32Array {
  const count = pcm.length >> 1;
  const at = (index: number): number => pcm.readInt16LE(Math.min(index, count - 1) * 2);
  const length = Math.floor((count * 2) / 3);
  const output = new Float32Array(length);

  for (let index = 0; index < length; index++) {
    const position = index * 1.5;
    const low = Math.floor(position);
    const share = position - low;

    output[index] = (at(low) * (1 - share) + at(low + 1) * share) / 32_768;
  }

  return output;
}

