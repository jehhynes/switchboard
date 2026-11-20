import { pcmToSamples } from './asr.js';

/** Frames of 10 ms: the envelopes the echo check compares. */
export const ECHO_FRAME_MS = 10;
/** The longest delay from playing to hearing the echo the check looks for; Remote Desktop's round trip is about 450 ms. */
export const ECHO_MAX_LAG_MS = 1_000;
/** Timestamps may put the capture slightly early; so far it is searched before the reference too. */
const ECHO_MIN_LAG_MS = -50;
/** A correlation of the capture's envelope with the played one at least this high is echo (mechanics.md M98). */
export const ECHO_R = 0.5;
/** Capture whose loud frames are under this level, or at most this far over its quiet ones, holds no echo or talk that recognition would hear. */
const QUIET_DB = -60;
const STEADY_DB = 6;
/** A measurement needs at least this much of the reply's audio playing. */
export const MIN_ACTIVE_FRAMES = 100;
/** A long playback is measured in stretches of at most this long, so talk in one part leaves the others measurable. */
export const ECHO_STRETCH_MS = 6_000;
/** Envelopes older than this are dropped. */
const KEEP_MS = 30_000;
/** The played audio's rate, 24 kHz 16-bit mono, and the capture's, 16 kHz. */
const PLAY_RATE = 24;
const CAPTURE_RATE = 16;
/** The capture clock is anchored on the earliest arrival over this many recent chunks, so it follows a device clock that drifts. */
const ANCHOR_CHUNKS = 50;

/** What one measurement found: `echo`, `none` (only steady noise heard) or `unclear` (sound that is not the reply's echo, such as talk). */
export interface EchoMeasure {
  verdict: 'echo' | 'none' | 'unclear';
  /** The best correlation of the capture's envelope with the played one, and its delay. */
  r: number;
  lagMs: number;
  /** The capture's 90th-percentile frame level, dBFS, and how far it is over its 20th percentile. */
  levelDb: number;
  rangeDb: number;
  /** Seconds of the played audio that were loud enough to count. */
  activeSeconds: number;
}

interface Frames {
  sum: Map<number, number>;
  count: Map<number, number>;
}

/**
 * Whether the voice's own playback reaches the mic (architecture.md § Dictation): the 10 ms loudness envelopes of the audio played and of the
 * audio captured, on one clock, are correlated over delays up to `ECHO_MAX_LAG_MS`. Speech's envelope survives Remote Desktop's codec, the
 * room and the speakers, where the waveform does not.
 */
export class EchoCheck {
  readonly #played: Frames = { sum: new Map(), count: new Map() };
  readonly #captured: Frames = { sum: new Map(), count: new Map() };
  /** Where the next played audio goes, in ms; it follows on from the last when it comes before that ends. */
  #playCursor = -Infinity;
  /** Samples captured since the capture opened, and the recent arrivals that anchor them on the clock. */
  #samples = 0;
  #anchors: number[] = [];
  /** The capture covers the clock from here, since it opened. */
  #captureFrom = Infinity;
  /** Stretches of playback not measured yet. */
  #stretches: Array<{ from: number; to: number }> = [];

  /** The capture opened again: its sample count starts over. */
  restart(): void {
    this.#samples = 0;
    this.#anchors = [];
    this.#captureFrom = Infinity;
    this.#captured.sum.clear();
    this.#captured.count.clear();
  }

  /** Audio captured, 16 kHz 16-bit mono, that arrived at `atMs`, its last sample then at the latest. */
  captured(pcm: Buffer, atMs: number): void {
    const samples = pcmToSamples(pcm);

    this.#samples += samples.length;
    this.#anchors.push(atMs - this.#samples / CAPTURE_RATE);

    if (this.#anchors.length > ANCHOR_CHUNKS) {
      this.#anchors.shift();
    }

    // A chunk arrives after its audio, by a varying amount: the earliest arrival is the closest to when it was heard.
    const startMs = Math.min(...this.#anchors) + (this.#samples - samples.length) / CAPTURE_RATE;

    this.#captureFrom = Math.min(this.#captureFrom, startMs);
    add(this.#captured, samples, startMs, CAPTURE_RATE);
    this.#prune(atMs);
  }

  /** Audio played, 24 kHz 16-bit mono, handed over at `atMs` as it starts to play. */
  played(pcm: Buffer, atMs: number): void {
    const startMs = this.#playCursor < atMs - 2 * ECHO_FRAME_MS ? atMs : this.#playCursor;
    const endMs = startMs + pcm.length / 2 / PLAY_RATE;
    const last = this.#stretches.at(-1);

    if (last === undefined || last.to < startMs) {
      this.#stretches.push({ from: startMs, to: endMs });
    } else if (last.to - last.from >= ECHO_STRETCH_MS) {
      this.#stretches.push({ from: last.to, to: endMs });
    } else {
      last.to = endMs;
    }

    this.#playCursor = endMs;
    add(this.#played, pcmToSamples(pcm), startMs, PLAY_RATE);
    this.#prune(atMs);
  }

  /**
   * Measures each stretch of playback whose echo the capture has had time to cover by `nowMs`; a stretch the capture did not cover, as
   * while it was closed, is dropped unmeasured.
   */
  due(nowMs: number): EchoMeasure[] {
    const measures: EchoMeasure[] = [];

    while (this.#stretches.length > 0 && this.readyAt(this.#stretches[0]!.to) <= nowMs) {
      const stretch = this.#stretches.shift()!;
      const measure = this.measure(stretch.from, stretch.to);

      if (measure !== null) {
        measures.push(measure);
      }
    }

    return measures;
  }

  /** When the capture will have covered audio played until `toMs` with its echo: the time to measure it. */
  readyAt(toMs: number): number {
    return toMs + ECHO_MAX_LAG_MS + 200;
  }

  /** Measures the audio played from `fromMs` to `toMs`; null when the capture did not cover it and the echo after it. */
  measure(fromMs: number, toMs: number): EchoMeasure | null {
    const first = Math.ceil(fromMs / ECHO_FRAME_MS);
    const last = Math.floor(toMs / ECHO_FRAME_MS);
    const minLag = Math.round(ECHO_MIN_LAG_MS / ECHO_FRAME_MS);
    const maxLag = Math.round(ECHO_MAX_LAG_MS / ECHO_FRAME_MS);

    if (last <= first || this.#captureFrom > (first + minLag) * ECHO_FRAME_MS || !this.#covered(first + minLag, last + maxLag)) {
      return null;
    }

    return judgeEcho(envelope(this.#played, first, last), envelope(this.#captured, first + minLag, last + maxLag), minLag);
  }

  #covered(first: number, last: number): boolean {
    for (let frame = first; frame < last; frame++) {
      if (!this.#captured.count.has(frame)) {
        return false;
      }
    }

    return true;
  }

  #prune(nowMs: number): void {
    const oldest = Math.floor((nowMs - KEEP_MS) / ECHO_FRAME_MS);

    for (const frames of [this.#played, this.#captured]) {
      for (const frame of frames.sum.keys()) {
        if (frame >= oldest) {
          break;
        }

        frames.sum.delete(frame);
        frames.count.delete(frame);
      }
    }
  }
}

function add(frames: Frames, samples: Float32Array, startMs: number, perMs: number): void {
  for (let index = 0; index < samples.length; index++) {
    const frame = Math.floor((startMs + index / perMs) / ECHO_FRAME_MS);
    const value = samples[index]!;

    frames.sum.set(frame, (frames.sum.get(frame) ?? 0) + value * value);
    frames.count.set(frame, (frames.count.get(frame) ?? 0) + 1);
  }
}

/** The RMS of each frame from `first` to before `last`; a frame nothing was played in is silence. */
function envelope(frames: Frames, first: number, last: number): Float32Array {
  const out = new Float32Array(last - first);

  for (let frame = first; frame < last; frame++) {
    const count = frames.count.get(frame) ?? 0;

    out[frame - first] = count === 0 ? 0 : Math.sqrt(frames.sum.get(frame)! / count);
  }

  return out;
}

/**
 * Judges a capture envelope against the played one: `capture[0]` is heard `minLag` frames after `played[0]`, and the capture runs on as far
 * as the longest delay. None when the capture is too quiet to recognise; echo when the envelopes correlate by `ECHO_R` at some delay; none
 * when the capture holds only steady sound; else unclear, as when the operator talks. Too little played audio is unclear.
 */
export function judgeEcho(played: Float32Array, capture: Float32Array, minLag: number): EchoMeasure {
  const peak = played.reduce((max, value) => Math.max(max, value), 0);
  const active = played.filter((value) => value > peak * 0.1).length;
  const lags = capture.length - played.length;
  let r = -1;
  let lag = 0;

  for (let shift = 0; shift <= lags; shift++) {
    const score = pearson(played, capture.subarray(shift, shift + played.length));

    if (score > r) {
      r = score;
      lag = shift;
    }
  }

  const levels = Array.from(capture, (value) => 20 * Math.log10(Math.max(value, 1e-6))).sort((a, b) => a - b);
  const levelDb = levels[Math.floor(levels.length * 0.9)] ?? -120;
  const rangeDb = levelDb - (levels[Math.floor(levels.length * 0.2)] ?? -120);
  const measure = { r: round(r), lagMs: (lag + minLag) * ECHO_FRAME_MS, levelDb: round(levelDb, 1), rangeDb: round(rangeDb, 1), activeSeconds: round((active * ECHO_FRAME_MS) / 1000, 1) };

  if (active < MIN_ACTIVE_FRAMES) {
    return { verdict: 'unclear', ...measure };
  }

  if (levelDb < QUIET_DB) {
    return { verdict: 'none', ...measure };
  }

  if (r >= ECHO_R) {
    return { verdict: 'echo', ...measure };
  }

  return { verdict: rangeDb < STEADY_DB ? 'none' : 'unclear', ...measure };
}

function pearson(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;

  for (let index = 0; index < n; index++) {
    meanA += a[index]!;
    meanB += b[index]!;
  }

  meanA /= n;
  meanB /= n;

  let ab = 0;
  let aa = 0;
  let bb = 0;

  for (let index = 0; index < n; index++) {
    const x = a[index]! - meanA;
    const y = b[index]! - meanB;

    ab += x * y;
    aa += x * x;
    bb += y * y;
  }

  return aa === 0 || bb === 0 ? 0 : ab / Math.sqrt(aa * bb);
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;

  return Math.round(value * scale) / scale;
}
