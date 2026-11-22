import { BYTES_PER_MS } from './tts.js';

/** How often played audio is handed to the echo canceller, and so how far ahead of playback the reference may run. */
export const REFERENCE_TICK_MS = 20;

export interface PlayedReferenceDeps {
  /** Hands audio that is playing now to the echo canceller. */
  push(pcm: Buffer): void;
  now(): number;
  /**
   * Milliseconds of the playback heard so far, where the device reports it, as a phone does: audio is then handed over as those reports reach
   * it, at most a tick ahead, rather than timed by the clock from when it was written.
   */
  played?(): number;
  every?(run: () => void, ms: number): { stop(): void };
}

interface Segment {
  /** When it starts playing. */
  startMs: number;
  pcm: Buffer;
  /** Bytes already pushed. */
  sent: number;
}

/**
 * Hands one playback's audio, 24 kHz mono 16-bit PCM, to the echo canceller as it plays rather than as it is written. decibri's `Speaker` takes
 * about 3.3 s of audio before a write waits, and the canceller's reference queue holds 2 s and finds its delay from the reference in front of
 * the capture, so a reference pushed as it is written is partly dropped and never aligned (mechanics.md M94). Audio is taken to play from
 * when it is written, or from when the audio written before it ends, whichever is later; on a phone, from the phone's reports of what it played.
 */
export class PlayedReference {
  readonly #segments: Segment[] = [];
  #endMs = 0;
  #ticker: { stop(): void } | null = null;

  constructor(private readonly deps: PlayedReferenceDeps) {}

  /** Audio written to the playback, in played order; a trailing odd byte, half a sample, is left out. */
  written(written: Buffer): void {
    const pcm = written.subarray(0, written.length - (written.length % 2));

    if (pcm.length === 0) {
      return;
    }

    // Timed by the device's reports, audio starts where the audio before it ends, counted from the playback's start.
    const startMs = this.deps.played === undefined ? Math.max(this.deps.now(), this.#endMs) : this.#endMs;

    this.#endMs = startMs + pcm.length / BYTES_PER_MS;
    this.#segments.push({ startMs, pcm, sent: 0 });
    this.#tick();

    if (this.#segments.length > 0 && this.#ticker === null) {
      this.#ticker = (this.deps.every ?? every)(() => this.#tick(), REFERENCE_TICK_MS);
    }
  }

  /** The playback stopped: audio not played yet is dropped. */
  stop(): void {
    this.#segments.length = 0;
    this.#ticker?.stop();
    this.#ticker = null;
  }

  /** Pushes the audio that starts playing before the next tick; after a late tick, audio that played more than a tick ago is skipped. */
  #tick(): void {
    const reported = this.deps.played !== undefined;
    const now = reported ? this.deps.played!() : this.deps.now();
    const dueMs = now + REFERENCE_TICK_MS;

    for (;;) {
      const segment = this.#segments[0];

      if (segment === undefined) {
        break;
      }

      const due = this.#offset(segment, dueMs);
      // The canceller took silence for what was not pushed in time; pushing it now would put it where later audio plays.
      // A device's reports come in steps, so audio they passed over is still handed over, not skipped.
      const missed = reported ? 0 : this.#offset(segment, now - REFERENCE_TICK_MS);

      if (missed > segment.sent) {
        segment.sent = missed;
      }

      if (due > segment.sent) {
        this.deps.push(segment.pcm.subarray(segment.sent, due));
        segment.sent = due;
      }

      if (segment.sent < segment.pcm.length) {
        break;
      }

      this.#segments.shift();
    }

    if (this.#segments.length === 0) {
      this.#ticker?.stop();
      this.#ticker = null;
    }
  }

  /** The segment's bytes, in whole samples, that start playing before `atMs`. */
  #offset(segment: Segment, atMs: number): number {
    return Math.min(segment.pcm.length, Math.max(0, Math.floor(((atMs - segment.startMs) * BYTES_PER_MS) / 2) * 2));
  }
}

function every(run: () => void, ms: number): { stop(): void } {
  const timer = setInterval(run, ms);

  return { stop: () => clearInterval(timer) };
}
