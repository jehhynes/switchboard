/**
 * The phone's audio worklet (architecture.md § Remote access, Voice on a phone), loaded by the page as `/page/voice-worklet.js`. `sb-play`
 * plays the voice's 24 kHz PCM at the context's rate through a queue with a start buffer, reports how much it played, and drops what it holds
 * at once on a flush; `sb-capture` turns the phone's microphone into 16 kHz frames for the voice.
 */

/** The rate the voice's speech comes at. */
export const PLAY_RATE = 24_000;
/** Audio held before a playback starts, raised after the queue ran dry while more was coming. */
export const START_MS = 60;
export const START_AFTER_UNDERRUN_MS = 200;
/** How often the worklet reports what it played, in milliseconds. */
export const REPORT_MS = 50;

/** A message the page posts to `sb-play`. */
export type PlayCommand = { type: 'open'; id: number } | { type: 'pcm'; id: number; samples: Int16Array } | { type: 'end'; id: number } | { type: 'flush'; id: number };
/** What `sb-play` posts back: the source frames of a playback played so far, `done` once it played all it got before its end, and underruns. */
export type PlayReport = { type: 'played'; id: number; frames: number; done: boolean; underruns: number };

/**
 * One playback at a time, resampled from {@link PLAY_RATE} to the output rate by linear interpolation. It waits for its start buffer (or its
 * end) before it plays; a queue that runs dry before the end counts an underrun and waits for the larger start buffer again.
 */
export class PlayQueue {
  #id: number | null = null;
  readonly #chunks: Float32Array[] = [];
  /** Source frames queued and not played, and the read position in the first chunk, fractional. */
  #queued = 0;
  #at = 0;
  #played = 0;
  #ended = false;
  #started = false;
  #startMs = START_MS;
  #underruns = 0;
  #sinceReport = 0;
  readonly #step: number;

  constructor(
    private readonly outputRate: number,
    private readonly report: (report: PlayReport) => void,
  ) {
    this.#step = PLAY_RATE / outputRate;
  }

  command(command: PlayCommand): void {
    if (command.type === 'open') {
      this.#reset(command.id);
      return;
    }

    if (command.id !== this.#id) {
      return;
    }

    if (command.type === 'flush') {
      this.#reset(null);
    } else if (command.type === 'end') {
      this.#ended = true;
    } else {
      const floats = new Float32Array(command.samples.length);

      for (let index = 0; index < floats.length; index++) {
        floats[index] = command.samples[index]! / 32768;
      }

      this.#chunks.push(floats);
      this.#queued += floats.length;
    }
  }

  /** Fills one render quantum. */
  render(out: Float32Array): void {
    out.fill(0);

    if (this.#id === null) {
      return;
    }

    if (!this.#started) {
      this.#started = this.#ended || (this.#queued * 1000) / PLAY_RATE >= this.#startMs;
    }

    if (this.#started) {
      for (let index = 0; index < out.length; index++) {
        const chunk = this.#chunks[0];

        if (chunk === undefined) {
          break;
        }

        const whole = Math.floor(this.#at);
        const next = whole + 1 < chunk.length ? chunk[whole + 1]! : (this.#chunks[1]?.[0] ?? chunk[whole]!);

        out[index] = chunk[whole]! + (next - chunk[whole]!) * (this.#at - whole);
        this.#at += this.#step;

        while (this.#chunks[0] !== undefined && this.#at >= this.#chunks[0].length) {
          this.#at -= this.#chunks[0].length;
          this.#played += this.#chunks[0].length;
          this.#queued -= this.#chunks[0].length;
          this.#chunks.shift();
        }
      }
    }

    const id = this.#id;
    const empty = this.#chunks.length === 0;

    if (empty && this.#ended) {
      this.report({ type: 'played', id, frames: this.#played, done: true, underruns: this.#underruns });
      this.#reset(null);
      return;
    }

    if (empty && this.#started) {
      this.#underruns++;
      this.#started = false;
      this.#startMs = START_AFTER_UNDERRUN_MS;
    }

    this.#sinceReport += (out.length * 1000) / this.outputRate;

    if (this.#sinceReport >= REPORT_MS) {
      this.#sinceReport = 0;
      this.report({ type: 'played', id, frames: this.#played + Math.floor(this.#at), done: false, underruns: this.#underruns });
    }
  }

  #reset(id: number | null): void {
    this.#id = id;
    this.#chunks.length = 0;
    this.#queued = 0;
    this.#at = 0;
    this.#played = 0;
    this.#ended = false;
    this.#started = false;
    this.#sinceReport = 0;
  }
}

/** The rate the phone's microphone goes to the voice at, and the length of each frame it sends, 20 ms. */
export const CAPTURE_RATE = 16_000;
export const FRAME_SAMPLES = 320;
/** The low-pass filter's cut-off before resampling: below the 8 kHz Nyquist rate of 16 kHz audio, with room for the filter's roll-off. */
export const CAPTURE_CUTOFF_HZ = 7_000;

/**
 * The microphone's audio at the context's rate (48 kHz on an iPhone, which records badly into a 16 kHz context) as 16 kHz 16-bit frames of
 * {@link FRAME_SAMPLES}: a windowed-sinc low-pass filter evaluated at each output position, interpolated between input samples for a rate
 * that is not a whole multiple.
 */
export class CaptureResampler {
  readonly #taps: Float32Array;
  readonly #half: number;
  readonly #step: number;
  /** Input not yet passed by the filter's window; `#pos` is the next output's position in it, fractional. */
  #buffer: Float32Array;
  #pos: number;
  readonly #frame = new Int16Array(FRAME_SAMPLES);
  #filled = 0;

  constructor(
    inputRate: number,
    private readonly emit: (frame: Int16Array) => void,
  ) {
    this.#step = inputRate / CAPTURE_RATE;
    this.#half = Math.max(8, Math.ceil(8 * this.#step));

    const cutoff = Math.min(CAPTURE_CUTOFF_HZ, 0.45 * inputRate) / inputRate;
    const length = 2 * this.#half + 1;
    const taps = new Float32Array(length);
    let sum = 0;

    for (let index = 0; index < length; index++) {
      const x = index - this.#half;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      // Blackman window.
      const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1)) + 0.08 * Math.cos((4 * Math.PI * index) / (length - 1));

      taps[index] = sinc * window;
      sum += taps[index]!;
    }

    for (let index = 0; index < length; index++) {
      taps[index] = taps[index]! / sum;
    }

    this.#taps = taps;
    // Silence before the first sample, so the first output has a whole window.
    this.#buffer = new Float32Array(this.#half);
    this.#pos = this.#half;
  }

  /** Takes one block of input; emits each frame as it fills. */
  push(input: Float32Array): void {
    const buffer = new Float32Array(this.#buffer.length + input.length);

    buffer.set(this.#buffer);
    buffer.set(input, this.#buffer.length);
    this.#buffer = buffer;

    while (Math.floor(this.#pos) + 1 + this.#half < buffer.length) {
      const whole = Math.floor(this.#pos);
      const fraction = this.#pos - whole;
      const at = this.#filter(whole);
      const value = fraction === 0 ? at : at + (this.#filter(whole + 1) - at) * fraction;

      this.#frame[this.#filled++] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);

      if (this.#filled === FRAME_SAMPLES) {
        this.emit(this.#frame.slice());
        this.#filled = 0;
      }

      this.#pos += this.#step;
    }

    const drop = Math.floor(this.#pos) - this.#half;

    if (drop > 0) {
      this.#buffer = buffer.slice(drop);
      this.#pos -= drop;
    }
  }

  #filter(center: number): number {
    let sum = 0;

    for (let index = 0; index < this.#taps.length; index++) {
      sum += this.#taps[index]! * this.#buffer[center - this.#half + index]!;
    }

    return sum;
  }
}

declare const registerProcessor: ((name: string, processor: unknown) => void) | undefined;
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

if (typeof registerProcessor === 'function') {
  registerProcessor(
    'sb-play',
    class extends AudioWorkletProcessor {
      readonly queue = new PlayQueue(sampleRate, (report) => this.port.postMessage(report));

      constructor() {
        super();
        this.port.onmessage = (event: MessageEvent<PlayCommand>) => this.queue.command(event.data);
      }

      process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const channels = outputs[0] ?? [];

        if (channels[0] !== undefined) {
          this.queue.render(channels[0]);

          for (const other of channels.slice(1)) {
            other.set(channels[0]);
          }
        }

        return true;
      }
    },
  );
  // The phone's microphone, resampled to 16 kHz frames posted to the page; it plays nothing.
  registerProcessor(
    'sb-capture',
    class extends AudioWorkletProcessor {
      readonly resampler = new CaptureResampler(sampleRate, (frame) => this.port.postMessage(frame, [frame.buffer]));

      process(inputs: Float32Array[][]): boolean {
        const channel = inputs[0]?.[0];

        if (channel !== undefined) {
          this.resampler.push(channel);
        }

        return true;
      }
    },
  );
}
