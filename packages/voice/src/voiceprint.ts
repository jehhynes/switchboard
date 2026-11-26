import type { LogLevel } from '@switchboard/core/log';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SherpaRuntime } from './sherpa.js';

/** The speaker model, WeSpeaker's ResNet34 trained on VoxCeleb (256-dimensional embeddings), in `<voice home>/models`, as claude-collab used it. */
export const SPEAKER_MODEL = 'wespeaker_en_voxceleb_resnet34_LM.onnx';
/** The enrolled voiceprint and pitch range, in the voice home. */
export const VOICEPRINT_FILE = 'voiceprint.json';
/** The prints of the voices replies are spoken in, learnt from their audio, which barge-in tells the operator from. */
export const TTS_PRINTS_FILE = 'tts-voiceprints.json';
const RATE = 16_000;
/** Shorter audio gives embeddings too noisy to judge; it passes unscored. */
export const MIN_SECONDS = 0.8;
/** Fewer voiced frames than this (0.5 s of voicing) are too few to judge a pitch by. */
export const MIN_VOICED = 25;
/** One- and two-word pieces score lower even in the enrolled voice (about 0.6 against 0.8 to 0.95 for sentences), so their bar is lower by this. */
export const SHORT_PIECE_ALLOWANCE = 0.15;
/** Enrolment averages embeddings of 3 s windows, so a cough or a pause in one window does not skew the print, and needs at least 3 of them. */
const ENROLL_WINDOW = 3 * RATE;
const MIN_ENROLL_WINDOWS = 3;
/** A reply voice's print is the mean of at most this many 3 s windows of its audio. */
const PRINT_WINDOWS = 20;

/** Speaker embeddings: sherpa-onnx's extractor in the process, a fake in tests. */
export interface Embedder {
  /** A normalised embedding of 16 kHz samples, or null when the audio is too short for one. */
  embed(samples: Float32Array): Float32Array | null;
}

/** The pitch (F0) of a clip's voiced frames, in Hz, sorted; the median, p10 and p90; and how many frames were voiced. */
export interface Pitch {
  median: number | null;
  p10: number | null;
  p90: number | null;
  voiced: number;
  frames: number[];
}

/** The enrolled voice's pitch range as stored. */
export type EnrolledPitch = Pick<Pitch, 'median' | 'p10' | 'p90' | 'voiced'>;

/** The voice check's thresholds (voice-design decision 27). */
export interface VoiceCheckSettings {
  matchThreshold: number;
  pitchLowFactor: number;
  pitchMinLowShare: number;
}

/** A piece's voice check: its match score (null when it could not be judged), its median pitch, and whether it failed and why. */
export interface PieceCheck {
  score: number | null;
  f0: number | null;
  dropped: boolean;
  reason: 'score' | 'pitch' | null;
}

interface Stored {
  at: string;
  windows: number;
  vector: number[];
  pitch: EnrolledPitch | null;
  /** The enrolment's speaking level (`loudness`), which barge-in's loudness gate follows; missing in a print claude-collab enrolled. */
  level?: number;
}

export function normalize(vector: ArrayLike<number>): Float32Array {
  let sum = 0;

  for (let index = 0; index < vector.length; index++) {
    sum += vector[index]! * vector[index]!;
  }

  const norm = Math.sqrt(sum) || 1;

  return Float32Array.from(vector, (value) => value / norm);
}

/** Cosine similarity of two normalised embeddings, rounded to 3 places; null when either is missing. */
export function similarity(a: Float32Array | null, b: Float32Array | null): number | null {
  if (a === null || b === null || a.length !== b.length) {
    return null;
  }

  let sum = 0;

  for (let index = 0; index < a.length; index++) {
    sum += a[index]! * b[index]!;
  }

  return Math.round(sum * 1000) / 1000;
}

/**
 * Pitch by normalised autocorrelation on 40 ms frames (20 ms hop), 60 to 400 Hz, over frames with at least `minEnergy` of the clip's peak frame
 * energy whose best correlation exceeds 0.6 (claude-collab `voiceprint.js`). Barge-in raises `minEnergy`, so a quieter voice under the loudest
 * one does not count.
 */
export function pitch(samples: Float32Array, sampleRate = RATE, minEnergy = 0.05): Pitch {
  const size = Math.round(0.04 * sampleRate);
  const hop = size >> 1;
  const minLag = Math.floor(sampleRate / 400);
  const maxLag = Math.ceil(sampleRate / 60);
  const energies: number[] = [];
  let peak = 0;

  for (let start = 0; start + size + maxLag <= samples.length; start += hop) {
    let energy = 0;

    for (let index = 0; index < size; index++) {
      energy += samples[start + index]! * samples[start + index]!;
    }

    energies.push(energy);
    peak = Math.max(peak, energy);
  }

  const frames: number[] = [];

  energies.forEach((energy, frame) => {
    if (peak === 0 || energy < peak * minEnergy) {
      return;
    }

    const start = frame * hop;
    let best = 0;
    let bestLag = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let product = 0;
      let other = 0;

      for (let index = 0; index < size; index++) {
        const shifted = samples[start + index + lag]!;

        product += samples[start + index]! * shifted;
        other += shifted * shifted;
      }

      const r = product / Math.sqrt(energy * other + 1e-12);

      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }

    if (best > 0.6) {
      frames.push(sampleRate / bestLag);
    }
  });

  frames.sort((a, b) => a - b);

  const at = (share: number): number | null => (frames.length === 0 ? null : Math.round(frames[Math.min(frames.length - 1, Math.floor(share * frames.length))]!));

  return { median: at(0.5), p10: at(0.1), p90: at(0.9), voiced: frames.length, frames };
}

/**
 * Whether a clip is pitched too high to be the enrolled voice: with enough voiced frames, too few of them (`pitchMinLowShare`) at or below
 * `pitchLowFactor` times the enrolled p90. The share, not the median, because the estimator often reads a low voice an octave high on half its
 * frames; on claude-collab's 668 saved clips the operator's speech had at least 41% of frames in range, other voices and falsetto at most 11%.
 */
export function pitchTooHigh(clip: Pitch, enrolled: EnrolledPitch | null, settings: VoiceCheckSettings, minVoiced = MIN_VOICED): boolean {
  if (enrolled === null || enrolled.p90 === null || clip.voiced < minVoiced || clip.frames.length === 0) {
    return false;
  }

  const low = settings.pitchLowFactor * enrolled.p90;

  return clip.frames.filter((frame) => frame <= low).length / clip.frames.length < settings.pitchMinLowShare;
}

/** Loudness of speech: the RMS of the loudest 30% of 20 ms frames. */
export function loudness(samples: Float32Array): number {
  const energies: number[] = [];

  for (let start = 0; start + 320 <= samples.length; start += 320) {
    let energy = 0;

    for (let index = 0; index < 320; index++) {
      energy += samples[start + index]! * samples[start + index]!;
    }

    energies.push(energy / 320);
  }

  if (energies.length === 0) {
    return 0;
  }

  energies.sort((a, b) => b - a);

  const top = energies.slice(0, Math.max(1, Math.floor(energies.length * 0.3)));

  return Math.sqrt(top.reduce((sum, energy) => sum + energy, 0) / top.length);
}

export interface VoiceprintDeps {
  /** The voice home, which holds `voiceprint.json` and `tts-voiceprints.json`. */
  dir: string;
  /** Loads the speaker model on first use, or says why it cannot run. */
  embedder(): Embedder | { error: string };
  log(line: string, level?: LogLevel): void;
  now?(): number;
}

/**
 * The voice check (architecture.md § Voice check and barge-in, from claude-collab `voiceprint.js`): the operator's enrolled voiceprint and pitch
 * range, a piece's match score and pitch against them, and the prints of the voices replies are spoken in. Without an enrolment every piece
 * passes unscored; without the speaker model no piece is scored, and only an enrolment's pitch rule applies.
 */
export class Voiceprint {
  #embedder: Embedder | { error: string } | null = null;
  #print: Float32Array | null = null;
  #pitch: EnrolledPitch | null = null;
  #level = 0;
  #at: string | null = null;
  readonly #voices = new Map<string, { windows: number; vector: Float32Array }>();

  constructor(private readonly deps: VoiceprintDeps) {
    try {
      const saved = JSON.parse(readFileSync(join(deps.dir, VOICEPRINT_FILE), 'utf8')) as Stored;

      if (Array.isArray(saved.vector) && saved.vector.length > 0) {
        this.#print = Float32Array.from(saved.vector);
        this.#pitch = saved.pitch ?? null;
        this.#level = typeof saved.level === 'number' ? saved.level : 0;
        this.#at = typeof saved.at === 'string' ? saved.at : null;
      }
    } catch {
      // Not enrolled.
    }

    try {
      const saved = JSON.parse(readFileSync(join(deps.dir, TTS_PRINTS_FILE), 'utf8')) as Record<string, { windows: number; vector: number[] }>;

      for (const [voice, print] of Object.entries(saved)) {
        if (Number.isInteger(print?.windows) && Array.isArray(print.vector)) {
          this.#voices.set(voice, { windows: print.windows, vector: Float32Array.from(print.vector) });
        }
      }
    } catch {
      // No reply voice learnt yet.
    }
  }

  /** When the voice was enrolled, or null. */
  get enrolledAt(): string | null {
    return this.#at;
  }

  get enrolled(): boolean {
    return this.#print !== null;
  }

  get enrolledPitch(): EnrolledPitch | null {
    return this.#pitch;
  }

  /** The enrolment's speaking level, 0 when unknown. */
  get level(): number {
    return this.#level;
  }

  /** Why the speaker model cannot run, or null once it loaded. */
  unavailable(): string | null {
    const embedder = this.#load();

    return 'error' in embedder ? embedder.error : null;
  }

  /** A normalised embedding, or null without the model or for audio too short. */
  embed(samples: Float32Array): Float32Array | null {
    const embedder = this.#load();

    return 'error' in embedder ? null : embedder.embed(samples);
  }

  /** Similarity with the enrolled print, or with `print`. */
  similarity(embedding: Float32Array | null, print: Float32Array | null = this.#print): number | null {
    return similarity(embedding, print);
  }

  /** The print of a reply voice, once some of its audio was learnt. */
  voicePrint(voice: string): Float32Array | null {
    return this.#voices.get(voice)?.vector ?? null;
  }

  /** How closely audio matches the closest learnt reply voice, so a voice that is not the operator's can be told from the reply's own echo; null with none learnt or no embedding. */
  replyVoiceScore(samples: Float32Array): number | null {
    if (this.#voices.size === 0 || samples.length < MIN_SECONDS * RATE) {
      return null;
    }

    const embedding = this.embed(samples);
    const scores = [...this.#voices.values()].map((print) => similarity(embedding, print.vector)).filter((score): score is number => score !== null);

    return scores.length === 0 ? null : Math.max(...scores);
  }

  /**
   * A piece's voice check: dropped when its score is under `voice.matchThreshold` (less `SHORT_PIECE_ALLOWANCE` for one or two words) or its
   * pitch is too high. Audio under `MIN_SECONDS`, no enrolment or no model scores null and passes the score part.
   */
  check(samples: Float32Array, text: string, settings: VoiceCheckSettings): PieceCheck {
    if (this.#print === null) {
      return { score: null, f0: null, dropped: false, reason: null };
    }

    const score = samples.length < MIN_SECONDS * RATE ? null : this.similarity(this.embed(samples));
    const clip = pitch(samples);
    const short = text.trim().split(/\s+/).filter(Boolean).length <= 2;
    const bar = settings.matchThreshold - (short ? SHORT_PIECE_ALLOWANCE : 0);

    if (pitchTooHigh(clip, this.#pitch, settings)) {
      return { score, f0: clip.median, dropped: true, reason: 'pitch' };
    }

    return score !== null && score < bar ? { score, f0: clip.median, dropped: true, reason: 'score' } : { score, f0: clip.median, dropped: false, reason: null };
  }

  /**
   * Enrols from a recording: the mean of its 3 s windows' embeddings, with its pitch range and speaking level, saved to `voiceprint.json`.
   * Throws when the model cannot run or the recording held fewer than 3 windows that gave an embedding.
   */
  enroll(samples: Float32Array): { windows: number; f0: number | null } {
    const embedder = this.#load();

    if ('error' in embedder) {
      throw new Error(embedder.error);
    }

    let sums: Float32Array | null = null;
    let windows = 0;

    for (let start = 0; start + ENROLL_WINDOW <= samples.length; start += ENROLL_WINDOW) {
      const vector = embedder.embed(samples.subarray(start, start + ENROLL_WINDOW));

      if (vector !== null) {
        sums ??= new Float32Array(vector.length);
        vector.forEach((value, index) => (sums![index]! += value));
        windows++;
      }
    }

    if (sums === null || windows < MIN_ENROLL_WINDOWS) {
      throw new Error('The recording was too short: speak for at least 9 seconds.');
    }

    const range = pitch(samples);
    const stored: Stored = {
      at: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
      windows,
      vector: Array.from(normalize(sums)),
      pitch: range.voiced >= MIN_VOICED ? { median: range.median, p10: range.p10, p90: range.p90, voiced: range.voiced } : null,
      level: loudness(samples),
    };

    // A print that could not be saved is not enrolled: the one before stays.
    this.#write(VOICEPRINT_FILE, stored, true);
    this.#print = Float32Array.from(stored.vector);
    this.#pitch = stored.pitch;
    this.#level = stored.level ?? 0;
    this.#at = stored.at;
    return { windows, f0: range.median };
  }

  /** Adds a 3 s window of a reply voice's audio (16 kHz) to that voice's print, up to `PRINT_WINDOWS` windows, kept across runs. */
  learnVoice(voice: string, samples: Float32Array): void {
    const old = this.#voices.get(voice);

    if (old !== undefined && old.windows >= PRINT_WINDOWS) {
      return;
    }

    const vector = this.embed(samples);

    if (vector === null) {
      return;
    }

    const windows = old?.windows ?? 0;
    const sum = old === undefined ? vector : old.vector.map((value, index) => value * windows + vector[index]!);

    this.#voices.set(voice, { windows: windows + 1, vector: normalize(sum) });
    this.#write(TTS_PRINTS_FILE, Object.fromEntries([...this.#voices].map(([name, print]) => [name, { windows: print.windows, vector: Array.from(print.vector) }])));
  }

  #load(): Embedder | { error: string } {
    this.#embedder ??= this.deps.embedder();

    return this.#embedder;
  }

  /** Writes one of the voice home's files; a failure is logged, or thrown when `required`. */
  #write(name: string, value: unknown, required = false): void {
    const path = join(this.deps.dir, name);

    try {
      mkdirSync(this.deps.dir, { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(value));
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      if (required) {
        throw new Error(`The voiceprint could not be saved: ${(error as Error).message}`);
      }

      this.deps.log(`${name} could not be written: ${(error as Error).message}`, 'warn');
    }
  }
}

interface SherpaSpeakerModule {
  SpeakerEmbeddingExtractor: new (config: Record<string, unknown>) => {
    createStream(): { acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void };
    isReady(stream: unknown): boolean;
    compute(stream: unknown): Float32Array;
  };
}

/**
 * sherpa-onnx's speaker embedding extractor on the CPU with one thread, about 60 ms per 2 s of audio, through the build recognition uses
 * (`SherpaRuntime`), as claude-collab ran it; an error says why it cannot run.
 */
export function sherpaEmbedder(modelFile: string, runtime: SherpaRuntime): Embedder | { error: string } {
  if (!existsSync(modelFile)) {
    return { error: `No speaker model at ${modelFile}.` };
  }

  const loaded = runtime.get();

  if ('error' in loaded) {
    return { error: `The speaker model could not load: ${loaded.error}` };
  }

  try {
    const sherpa = loaded.module as SherpaSpeakerModule;
    const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelFile, numThreads: 1, debug: false });

    return {
      embed: (samples) => {
        const stream = extractor.createStream();

        stream.acceptWaveform({ sampleRate: RATE, samples });
        stream.inputFinished();

        return extractor.isReady(stream) ? normalize(extractor.compute(stream)) : null;
      },
    };
  } catch (error) {
    return { error: `The speaker model could not load: ${(error as Error).message}` };
  }
}
