import type { Capture, CaptureStream, Output, Playback } from './output.js';
import type { VoiceMessage } from './protocol.js';
import { BYTES_PER_MS } from './tts.js';

/** The most audio a phone playback may have sent and not yet played, so Stop, a move or a cancel cuts it within about this long. */
export const PHONE_LEAD_MS = 300;
/** Audio goes to the phone in pieces of at most this long, so the lead is checked before each. */
export const PHONE_CHUNK_MS = 40;
/**
 * A playback waiting on the phone that reports no progress for this long has stalled, as when iOS suspended its audio for good. It is longer
 * than the page's own wait for an interrupted audio context to run again (`RECOVER_MS` in the page), so a phone that recovers keeps the voice.
 */
export const PHONE_STALL_MS = 8_000;
/** Why a stalled phone loses the voice. */
export const PHONE_STALLED = 'The phone stopped playing the voice.';

type PhoneSend = (message: Extract<VoiceMessage, { type: 'phone-play' | 'phone-pcm' | 'phone-end' | 'phone-flush' }>) => void;

/**
 * Why phone capture starts half-duplex: iOS cancels the echo of the page's own playback, but how much is left is measured first by the echo
 * check under `voice.duplex` `auto`, against the phone's played reports.
 */
export const PHONE_HALF_DUPLEX = "the phone's echo cancellation is not measured";

export interface PhoneCaptureDeps {
  send(message: Extract<VoiceMessage, { type: 'phone-capture' }>): void;
}

/**
 * The phone's microphone as the voice's `Capture` (architecture.md § Remote access, Voice on a phone): opening it asks the page to send its
 * 16 kHz PCM (`phone-capture {on: true}`), which the hub relays as `phone-mic`; stopping it asks the page to stop. One stream at a time.
 */
export class PhoneCapture implements Capture {
  #stream: { onPcm: (pcm: Buffer) => void; onError: (error: Error) => void } | null = null;

  constructor(private readonly deps: PhoneCaptureDeps) {}

  async open(_device: string | null, onPcm: (pcm: Buffer) => void, onError: (error: Error) => void): Promise<CaptureStream> {
    const stream = { onPcm, onError };

    this.#stream = stream;
    this.deps.send({ type: 'phone-capture', on: true });

    return {
      stop: () => {
        if (this.#stream === stream) {
          this.#stream = null;
          this.deps.send({ type: 'phone-capture', on: false });
        }
      },
      halfDuplex: PHONE_HALF_DUPLEX,
      remote: false,
      // The phone cancels its own playback's echo; the echo check takes the reference from the service.
      reference: () => undefined,
    };
  }

  /** The phone's audio, as the hub relays it; dropped while no stream is open. A trailing odd byte, half a sample, is left out. */
  pcm(pcm: Buffer): void {
    const whole = pcm.subarray(0, pcm.length - (pcm.length % 2));

    if (whole.length > 0) {
      this.#stream?.onPcm(whole);
    }
  }

  /** The phone is gone: the open stream fails with why, as a removed device does. */
  lost(why: string): void {
    const stream = this.#stream;

    this.#stream = null;
    stream?.onError(new Error(why));
  }
}

export interface PhoneOutputDeps {
  send: PhoneSend;
  now(): number;
  every?(run: () => void, ms: number): { stop(): void };
  /** A playback stalled: every open playback failed, and the phone should lose the voice. */
  stalled?(why: string): void;
}

interface Open {
  id: number;
  /** Milliseconds of audio sent. */
  sentMs: number;
  /** Milliseconds the phone reported heard. */
  playedMs: number;
  /**
   * Milliseconds the phone reported its output took, before the output's latency; the lead is counted from it, since a Bluetooth output's
   * latency can exceed the lead, and a lead counted from what is heard would then never let more audio go.
   */
  outMs: number;
  done: boolean;
  /** Its end was sent, so the phone may report it done. */
  ended: boolean;
  /** When it last waited on the phone with no report since, or null while it does not wait. */
  waitingSince: number | null;
  stopped: boolean;
  /** Why the phone was lost while this played, which fails its end. */
  lost: string | null;
  /** Writes waiting for the phone to play some of what it holds. */
  waiting: Array<() => void>;
  drained: { resolve(): void; reject(error: Error): void } | null;
}

/** One phone playback: the audio sent and the position the phone reports heard. */
export interface PhonePlayback extends Playback {
  /** Milliseconds of this playback the phone reported heard. */
  position(): number;
}

/**
 * The phone's speaker as the voice's `Output` (architecture.md § Remote access, Voice on a phone): each playback's 24 kHz PCM goes to the hub,
 * which relays it to the phone's page, never more than {@link PHONE_LEAD_MS} ahead of what the phone reports heard, and the phone's reports give
 * the position and the end. A lost phone fails every open playback.
 */
export class PhoneOutput implements Output {
  readonly engine = 'phone';
  readonly #open = new Map<number, Open>();
  #next = 0;
  #watch: { stop(): void } | null = null;

  constructor(private readonly deps: PhoneOutputDeps) {}

  private send(message: Parameters<PhoneSend>[0]): void {
    this.deps.send(message);
  }

  /** Watches the waiting playbacks while any waits, failing them all once one hears nothing for {@link PHONE_STALL_MS}. */
  #waiting(one: Open): void {
    one.waitingSince ??= this.deps.now();
    this.#watch ??= (this.deps.every ?? every)(() => {
      const waiting = [...this.#open.values()].filter((open) => open.waitingSince !== null);

      if (waiting.length === 0) {
        this.#watch?.stop();
        this.#watch = null;
        return;
      }

      if (waiting.some((open) => this.deps.now() - open.waitingSince! >= PHONE_STALL_MS)) {
        this.#watch?.stop();
        this.#watch = null;
        this.lost(PHONE_STALLED);
        this.deps.stalled?.(PHONE_STALLED);
      }
    }, 500);
  }

  async open(): Promise<PhonePlayback> {
    const one: Open = { id: ++this.#next, sentMs: 0, playedMs: 0, outMs: 0, done: false, ended: false, waitingSince: null, stopped: false, lost: null, waiting: [], drained: null };

    this.#open.set(one.id, one);
    this.send({ type: 'phone-play', id: one.id });

    const wake = (): void => {
      for (const run of one.waiting.splice(0)) {
        run();
      }
    };
    const finish = (): void => {
      this.#open.delete(one.id);
      wake();
    };

    return {
      write: async (pcm) => {
        const chunk = Math.max(2, Math.round(PHONE_CHUNK_MS * BYTES_PER_MS) & ~1);

        for (let at = 0; at < pcm.length && !one.stopped; at += chunk) {
          const piece = pcm.subarray(at, at + chunk);

          // Hold the write while the phone holds a full lead, so a stop finds little queued there.
          while (!one.stopped && one.sentMs - Math.max(one.playedMs, one.outMs) + piece.length / BYTES_PER_MS > PHONE_LEAD_MS) {
            this.#waiting(one);
            await new Promise<void>((resolve) => one.waiting.push(resolve));
          }

          one.waitingSince = null;

          if (one.stopped) {
            return;
          }

          one.sentMs += piece.length / BYTES_PER_MS;
          this.send({ type: 'phone-pcm', id: one.id, pcm: piece.toString('base64') });
        }
      },
      drain: () => {
        if (one.lost !== null) {
          return Promise.reject(new Error(one.lost));
        }

        if (one.done || one.stopped) {
          return Promise.resolve();
        }

        one.ended = true;
        this.send({ type: 'phone-end', id: one.id });
        this.#waiting(one);
        return new Promise<void>((resolve, reject) => (one.drained = { resolve, reject }));
      },
      stop: () => {
        if (!one.stopped) {
          one.stopped = true;

          if (!one.done) {
            this.send({ type: 'phone-flush', id: one.id });
          }

          one.drained?.resolve();
          finish();
        }
      },
      position: () => Math.min(one.playedMs, one.sentMs),
    };
  }

  /**
   * The phone's report for a playback: how much of it was heard, how much its output took (`out`, before the output's latency; a page that
   * does not say counts as having taken what was heard), and whether all it was sent was played after its end.
   */
  played(id: number, ms: number, done: boolean, out?: number): void {
    const one = this.#open.get(id);

    if (one === undefined || one.stopped) {
      return;
    }

    // A report never counts more than was sent, nor an end before it was sent, so a page cannot lift the lead or end a playback early.
    const heard = Math.min(ms, one.sentMs);
    const taken = Math.min(Math.max(out ?? 0, heard), one.sentMs);

    if ((heard > one.playedMs || taken > one.outMs) && one.waitingSince !== null) {
      one.waitingSince = this.deps.now();
    }

    one.playedMs = Math.max(one.playedMs, heard);
    one.outMs = Math.max(one.outMs, taken);

    if (done && one.ended) {
      one.done = true;
      one.playedMs = one.sentMs;
      one.drained?.resolve();
      this.#open.delete(id);
    }

    for (const run of one.waiting.splice(0)) {
      run();
    }
  }

  /** The phone is gone: every open playback stops, and one waiting for its end fails with why. */
  lost(why: string): void {
    for (const one of [...this.#open.values()]) {
      one.stopped = true;
      one.lost = why;
      one.drained?.reject(new Error(why));
      this.#open.delete(one.id);

      for (const run of one.waiting.splice(0)) {
        run();
      }
    }
  }
}

function every(run: () => void, ms: number): { stop(): void } {
  const timer = setInterval(run, ms);

  return { stop: () => clearInterval(timer) };
}
