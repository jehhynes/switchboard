import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { collectGarbage, CPU_MODEL } from './sherpa.js';
import type { AsrDevice, SherpaRuntime } from './sherpa.js';

/** Capture and recognition run at 16 kHz mono. */
export const ASR_RATE = 16_000;
/** The audio kept for the preroll of the next message. */
const KEEP = 8 * ASR_RATE;
const PREROLL = ASR_RATE / 2;
/** Words that stopped growing this long ago are a piece. */
export const PHRASE_SILENCE_MS = 1_200;
/** A brief quiet after new words: the moment to ask whether the message is finished. */
export const QUIET_MS = 400;
/**
 * Audio below -55 dBFS is silence the recogniser does not decode (mechanics.md M131): each 160 ms chunk costs the fp32 model about 40 ms of
 * GPU time whether or not anyone speaks. The operator's captures sit at -60 to -75 dBFS between words and -40 to -20 dBFS in speech.
 */
export const SILENCE_RMS = 10 ** (-55 / 20);
/** Decoding goes on this long after the last loud audio or new words, so the model gives up the words it held back and a piece settles. */
export const DECODE_HANGOVER_MS = 2_000;

/** One recogniser stream: audio in, its text so far out. */
export interface AsrStream {
  accept(samples: Float32Array): void;
  text(): string;
  /** No more audio comes: the model gives up the last words it held back for what follows them. */
  finish(): void;
}

export interface AsrEngine {
  readonly device: AsrDevice;
  /** Audio quieter than this RMS (samples from -1 to 1) is not decoded once {@link DECODE_HANGOVER_MS} passed; undefined decodes all of it. */
  readonly silenceRms?: number | undefined;
  stream(): AsrStream;
  /** Releases the recogniser's native memory, gigabytes of GPU memory with the fp32 model; its streams take no more audio. */
  free(): void;
}

export interface TranscriberEvents {
  /** The words not yet settled into a piece changed; empty once they settled. */
  onWords(text: string): void;
  /** Words that stopped growing for `PHRASE_SILENCE_MS`: a piece, with its audio for the voice check (`recent`). */
  onPiece(text: string, audio: Float32Array): void;
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
  /** Where the audio of the next piece begins. */
  #pieceStart = 0;
  /** No audio before this sample goes into a piece's voice check: after a barge-in, the reply's echo before the operator's first word. */
  #audioFrom = 0;
  /** The samples the stream has been given, and when the audio was last louder than the engine's silence. */
  #fed = 0;
  #loudAt = -Infinity;

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

    this.#decode(samples);

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
      const audio = this.recent();

      this.#settled = words(this.#text).length;
      this.#pieceStart = this.#total;
      this.events.onPiece(piece, audio);
      this.events.onWords('');
    }
  }

  /**
   * Gives the stream the chunk unless it is silence past the hangover; after silence that was skipped, the half second before the chunk goes
   * first, so a word's soft onset is not lost.
   */
  #decode(samples: Float32Array): void {
    const silence = this.engine.silenceRms;

    if (silence !== undefined) {
      if (rms(samples) >= silence) {
        this.#loudAt = this.#total;
      } else if (this.#total - Math.max(this.#loudAt, this.#grewAt) > (DECODE_HANGOVER_MS * ASR_RATE) / 1000) {
        return;
      }
    }

    const skipped = this.#total - samples.length - this.#fed;

    this.#stream.accept(skipped > 0 ? this.samples(Math.max(this.#fed, this.#total - samples.length - PREROLL)) : samples);
    this.#fed = this.#total;
  }

  /** The samples from `from` (an absolute sample count) to now, within the last 8 seconds. */
  samples(from: number): Float32Array {
    const start = Math.max(from, this.#total - KEEP, 0);
    const out = new Float32Array(this.#total - start);

    for (let index = 0; index < out.length; index++) {
      out[index] = this.#ring[(start + index) % KEEP]!;
    }

    return out;
  }

  /** A piece's audio for the voice check: the last 4 to 8 seconds, or since the last piece when longer, never before a barge-in's onset. */
  recent(): Float32Array {
    let count = Math.min(KEEP, this.#total, Math.max(4 * ASR_RATE, this.#total - this.#pieceStart));

    if (this.#audioFrom > 0) {
      count = Math.min(count, this.#total - this.#audioFrom);
    }

    return this.samples(this.#total - count);
  }

  /** Takes the words not settled yet, with their audio, without reporting them as a piece; null with none. */
  take(): { text: string; audio: Float32Array } | null {
    const rest = this.words;

    this.#settled = words(this.#text).length;

    if (rest === '') {
      return null;
    }

    const audio = this.recent();

    this.#pieceStart = this.#total;
    return { text: rest, audio };
  }

  /**
   * A barge-in: recognition starts again on a fresh stream from `from` (an absolute sample count), so the words start with the operator's and
   * not the reply's echo before them, which the old stream may have followed instead.
   */
  restartFrom(from: number): void {
    const pre = this.samples(from);

    this.#stream = this.engine.stream();
    this.#stream.accept(pre);
    this.#fed = this.#total;
    this.#text = this.#stream.text().trim();
    this.#settled = 0;
    this.#grewAt = this.#total;
    this.#quietDone = false;
    this.#audioFrom = this.#pieceStart = this.#total - pre.length;
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

    this.#fed = this.#total;
    this.#text = '';
    this.#settled = 0;
    this.#quietDone = true;
    this.#audioFrom = 0;
  }
}

function rms(samples: Float32Array): number {
  let sum = 0;

  for (const sample of samples) {
    sum += sample * sample;
  }

  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
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

export interface Hotwords {
  bpeVocab: string;
  hotwordsFile: string | null;
}

/**
 * The sherpa-onnx recogniser (prebuilt N-API) on `device`, which only the voice process loads: the fp32 model on CUDA, the int8 model on the CPU,
 * since CUDA with the int8 model is slower than the CPU; decoding settings tuned in claude-collab on saved clips, modified beam search with 4
 * paths and hotwords at 1.5 (claude-collab `docs/findings.md`). Loading the model blocks for seconds. An error says why it cannot run: the
 * model is not in `modelDir`, or the recogniser could not be created. `hotwords` writes the hotword files from the model's tokens.
 */
export function sherpaEngine(module: unknown, device: AsrDevice, modelDir: string, hotwords: () => Hotwords): AsrEngine | { error: string } {
  const suffix = device === 'gpu' ? '' : '.int8';
  const file = (name: string): string => join(modelDir, name);

  if (!existsSync(file(`encoder${suffix}.onnx`)) || !existsSync(file('tokens.txt'))) {
    return { error: `No speech recognition model in ${modelDir}.` };
  }

  const words = hotwords();
  let recognizer: InstanceType<SherpaModule['OnlineRecognizer']> | null;

  try {
    recognizer = new (module as SherpaModule).OnlineRecognizer({
      featConfig: { sampleRate: ASR_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: file(`encoder${suffix}.onnx`), decoder: file(`decoder${suffix}.onnx`), joiner: file(`joiner${suffix}.onnx`) },
        tokens: file('tokens.txt'),
        numThreads: 4,
        provider: device === 'gpu' ? 'cuda' : 'cpu',
        debug: 0,
        modelingUnit: 'bpe',
        bpeVocab: words.bpeVocab,
      },
      decodingMethod: 'modified_beam_search',
      maxActivePaths: 4,
      ...(words.hotwordsFile === null ? {} : { hotwordsFile: words.hotwordsFile, hotwordsScore: 1.5 }),
    });
  } catch (error) {
    return { error: `The speech recognition model could not load: ${(error as Error).message}` };
  }

  /** The streams still in use, whose native handles `free` drops before the recogniser's; a stream no longer used is collected as usual. */
  const streams = new Set<WeakRef<{ drop(): void }>>();

  return {
    device,
    silenceRms: SILENCE_RMS,
    stream: () => {
      if (recognizer === null) {
        return { accept: () => undefined, text: () => '', finish: () => undefined };
      }

      let stream: ReturnType<NonNullable<typeof recognizer>['createStream']> | null = recognizer.createStream();
      const decode = (): void => {
        if (recognizer === null || stream === null) {
          stream = null;
          return;
        }

        while (recognizer.isReady(stream)) {
          recognizer.decode(stream);
        }
      };

      const one = {
        accept: (samples: Float32Array) => {
          stream?.acceptWaveform({ sampleRate: ASR_RATE, samples });
          decode();
        },
        text: () => (recognizer === null || stream === null ? '' : recognizer.getResult(stream).text),
        finish: () => {
          stream?.inputFinished();
          decode();
        },
        drop: () => {
          stream = null;
        },
      };

      for (const ref of streams) {
        if (ref.deref() === undefined) {
          streams.delete(ref);
        }
      }

      streams.add(new WeakRef(one));
      return one;
    },
    // sherpa-onnx-node has no destroy call: the recogniser's native memory goes when V8 collects its handle, which the small JS object never
    // prompts, so each replaced recogniser kept its 3.3 GB of GPU memory (mechanics.md M131). Dropping every reference and collecting frees it
    // on the next turn of the event loop. Its streams go first, a turn before it, since a stream's state may live in the recogniser's memory.
    free: () => {
      if (recognizer === null) {
        return;
      }

      for (const ref of streams) {
        ref.deref()?.drop();
      }

      streams.clear();
      collectGarbage();
      setImmediate(() => {
        recognizer = null;
        collectGarbage();
      });
    },
  };
}

/**
 * The recogniser on the device `runtime` chose (architecture.md § Dictation): on the GPU when it can, else, or when the GPU's recogniser fails
 * to load, on the CPU with the int8 model through the same build, with why logged. `hotwords` writes the hotword files from a model folder.
 */
export function sherpaRecognizer(runtime: SherpaRuntime, hotwords: (modelDir: string) => Hotwords, log: (line: string) => void): AsrEngine | { error: string } {
  const sherpa = runtime.get();

  if ('error' in sherpa) {
    return { error: `Speech recognition is not available: ${sherpa.error}` };
  }

  if (sherpa.device === 'gpu') {
    const engine = sherpaEngine(sherpa.module, 'gpu', sherpa.model, () => hotwords(sherpa.model));

    if (!('error' in engine)) {
      return engine;
    }

    log(`Speech recognition runs on the CPU, the int8 model: the GPU's recogniser did not load: ${engine.error}`);
  }

  const cpuModel = join(dirname(sherpa.model), CPU_MODEL);

  return sherpaEngine(sherpa.module, 'cpu', cpuModel, () => hotwords(cpuModel));
}
