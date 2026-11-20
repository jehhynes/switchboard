import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** Capture and recognition run at 16 kHz mono. */
export const ASR_RATE = 16_000;
/** The recogniser's model, the int8 build of NVIDIA's Nemotron Speech Streaming 0.6B with 160 ms chunks, in `<voice home>/models`. */
export const ASR_MODEL = 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25';
/** The audio kept for the preroll of the next message. */
const KEEP = 8 * ASR_RATE;
const PREROLL = ASR_RATE / 2;
/** Words that stopped growing this long ago are a piece. */
export const PHRASE_SILENCE_MS = 1_200;
/** A brief quiet after new words: the moment to ask whether the message is finished. */
export const QUIET_MS = 400;

/** One recogniser stream: audio in, its text so far out. */
export interface AsrStream {
  accept(samples: Float32Array): void;
  text(): string;
  /** No more audio comes: the model gives up the last words it held back for what follows them. */
  finish(): void;
}

export interface AsrEngine {
  stream(): AsrStream;
}

export interface TranscriberEvents {
  /** The words not yet settled into a piece changed; empty once they settled. */
  onWords(text: string): void;
  /** Words that stopped growing for `PHRASE_SILENCE_MS`: a piece. */
  onPiece(text: string): void;
  /** `QUIET_MS` after the words last grew. */
  onQuiet(): void;
}

/**
 * Streaming recognition of one message at a time (architecture.md § Dictation), from claude-collab's `asr-local.js`. One recogniser stream runs
 * for a whole message, since restarting it at every pause lost the first words after each restart; new words settle into a piece once they
 * stopped growing for a short pause, and the stream starts again only at the end of a message, primed with the last half second so a word
 * begun at the boundary is not lost.
 */
export class Transcriber {
  #stream: AsrStream;
  readonly #ring = new Float32Array(KEEP);
  #total = 0;
  #text = '';
  #settled = 0;
  #grewAt = 0;
  #quietDone = true;

  constructor(
    private readonly engine: AsrEngine,
    private readonly events: TranscriberEvents,
  ) {
    this.#stream = engine.stream();
  }

  /** The words not yet settled into a piece. */
  get words(): string {
    return words(this.#text).slice(this.#settled).join(' ');
  }

  /** Samples heard so far, which the clock of the pauses counts in. */
  get total(): number {
    return this.#total;
  }

  feed(samples: Float32Array): void {
    for (const sample of samples) {
      this.#ring[this.#total++ % KEEP] = sample;
    }

    this.#stream.accept(samples);

    const text = this.#stream.text().trim();

    if (text !== this.#text) {
      this.#text = text;
      this.#grewAt = this.#total;
      this.#quietDone = false;
      this.events.onWords(this.words);
    }

    if (!this.#quietDone && this.#total - this.#grewAt >= (QUIET_MS * ASR_RATE) / 1000) {
      this.#quietDone = true;
      this.events.onQuiet();
    }

    if (words(this.#text).length > this.#settled && this.#total - this.#grewAt >= (PHRASE_SILENCE_MS * ASR_RATE) / 1000) {
      const piece = this.words;

      this.#settled = words(this.#text).length;
      this.events.onPiece(piece);
      this.events.onWords('');
    }
  }

  /** Takes the words not settled yet as text, without reporting them as a piece; null with none. */
  take(): string | null {
    const rest = this.words;

    this.#settled = words(this.#text).length;

    return rest === '' ? null : rest;
  }

  /** No more audio comes for this message: the stream gives up the words it held back. `end` must follow. */
  drain(): void {
    this.#stream.finish();
    this.#text = this.#stream.text().trim();
  }

  /**
   * The message ended: a fresh stream, primed with the last half second unless `preroll` is false, as after a stop or a discard, whose last half
   * second holds the words that would come back in the next message.
   */
  end(preroll = true): void {
    this.#stream = this.engine.stream();

    const count = preroll ? Math.min(PREROLL, this.#total) : 0;

    if (count > 0) {
      const pre = new Float32Array(count);

      for (let index = 0; index < count; index++) {
        pre[index] = this.#ring[(this.#total - count + index) % KEEP]!;
      }

      this.#stream.accept(pre);
    }

    this.#text = '';
    this.#settled = 0;
    this.#quietDone = true;
  }
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** 16-bit PCM as samples from -1 to 1, as the recogniser takes them. */
export function pcmToSamples(pcm: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(pcm.length / 2));

  for (let index = 0; index < samples.length; index++) {
    samples[index] = pcm.readInt16LE(index * 2) / 32_768;
  }

  return samples;
}

interface SherpaModule {
  OnlineRecognizer: new (config: Record<string, unknown>) => {
    createStream(): { acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void };
    isReady(stream: unknown): boolean;
    decode(stream: unknown): void;
    getResult(stream: unknown): { text: string };
  };
}

/**
 * The sherpa-onnx recogniser (prebuilt N-API, CPU), which only the voice process loads: decoding settings tuned in claude-collab on saved clips,
 * modified beam search with 4 paths and hotwords at 1.5 (claude-collab `docs/findings.md`). Loading the model takes about 2 seconds and blocks.
 * An error says why it cannot run: sherpa-onnx is not installed, or the model is not in `modelDir`.
 */
export function sherpaEngine(modelDir: string, hotwords: { bpeVocab: string; hotwordsFile: string | null }, requireFrom: string): AsrEngine | { error: string } {
  if (!existsSync(join(modelDir, 'encoder.int8.onnx'))) {
    return { error: `No speech recognition model in ${modelDir}.` };
  }

  let sherpa: SherpaModule;

  try {
    sherpa = createRequire(requireFrom)('sherpa-onnx-node') as SherpaModule;
  } catch (error) {
    return { error: `Speech recognition is not available: ${(error as Error).message}` };
  }

  const file = (name: string): string => join(modelDir, name);
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: ASR_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: file('encoder.int8.onnx'), decoder: file('decoder.int8.onnx'), joiner: file('joiner.int8.onnx') },
      tokens: file('tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
      modelingUnit: 'bpe',
      bpeVocab: hotwords.bpeVocab,
    },
    decodingMethod: 'modified_beam_search',
    maxActivePaths: 4,
    ...(hotwords.hotwordsFile === null ? {} : { hotwordsFile: hotwords.hotwordsFile, hotwordsScore: 1.5 }),
  });

  return {
    stream: () => {
      const stream = recognizer.createStream();
      const decode = (): void => {
        while (recognizer.isReady(stream)) {
          recognizer.decode(stream);
        }
      };

      return {
        accept: (samples) => {
          stream.acceptWaveform({ sampleRate: ASR_RATE, samples });
          decode();
        },
        text: () => recognizer.getResult(stream).text,
        finish: () => {
          stream.inputFinished();
          decode();
        },
      };
    },
  };
}
