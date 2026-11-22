import type { AsrEngine, AsrStream } from '../src/asr.js';
import type { Capture, CaptureStream, Output, Playback } from '../src/output.js';
import type { SocketLike, Speaking, SpeechVoice } from '../src/tts.js';

/** Timers run by hand, in time order. */
export class Clock {
  t = 0;
  readonly timers: Array<{ run: () => void; at: number; cleared: boolean; every: number | null }> = [];

  setTimer = (run: () => void, ms: number): unknown => {
    const timer = { run, at: this.t + ms, cleared: false, every: null };

    this.timers.push(timer);
    return timer;
  };

  clearTimer = (timer: unknown): void => {
    (timer as { cleared: boolean }).cleared = true;
  };

  every = (run: () => void, ms: number): { stop(): void } => {
    const timer = { run, at: this.t + ms, cleared: false, every: ms };

    this.timers.push(timer);
    return { stop: () => void (timer.cleared = true) };
  };

  now = (): number => this.t;

  advance(ms: number): void {
    const until = this.t + ms;

    for (;;) {
      const due = this.timers.filter((timer) => !timer.cleared && timer.at <= until).sort((a, b) => a.at - b.at)[0];

      if (due === undefined) {
        break;
      }

      this.t = due.at;

      if (due.every === null) {
        due.cleared = true;
      } else {
        due.at += due.every;
      }

      due.run();
    }

    this.t = until;
  }
}

/** A playback that records what it was given; `drain` waits for `drained` while `hold` is set. */
export class FakePlayback implements Playback {
  readonly written: Buffer[] = [];
  stopped = false;
  drained = false;
  hold: Promise<void> | null = null;

  async write(pcm: Buffer): Promise<void> {
    this.written.push(pcm);
  }

  async drain(): Promise<void> {
    await this.hold;
    this.drained = true;
  }

  stop(): void {
    this.stopped = true;
  }
}

export class FakeOutput implements Output {
  readonly engine = 'fake';
  readonly playbacks: FakePlayback[] = [];
  readonly devices: Array<string | null> = [];
  fail: Error | null = null;

  async open(device: string | null): Promise<Playback> {
    this.devices.push(device);

    if (this.fail !== null) {
      throw this.fail;
    }

    const playback = new FakePlayback();

    this.playbacks.push(playback);
    return playback;
  }
}

/** A speech request the test finishes: `audio` sends a chunk, `finish` or `fail` ends it. */
export interface FakeSpeaking extends Speaking {
  text: string;
  tone: string | null;
  as: SpeechVoice | undefined;
  audio(bytes: number): void;
  finish(): void;
  fail(error: Error): void;
  cancelled: boolean;
}

export class FakeTts {
  readonly requests: FakeSpeaking[] = [];
  readonly configured: unknown[] = [];
  warmed = 0;
  closed = false;
  throws: Error | null = null;

  configure(settings: unknown): void {
    this.configured.push(settings);
  }

  warm(): void {
    this.warmed++;
  }

  close(): void {
    this.closed = true;
  }

  speak(text: string, tone: string | null, onAudio: (pcm: Buffer) => void, as?: SpeechVoice): Speaking {
    if (this.throws !== null) {
      throw this.throws;
    }

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });

    done.catch(() => undefined);

    const request: FakeSpeaking = {
      text,
      tone,
      as,
      done,
      cancelled: false,
      audio: (bytes) => onAudio(Buffer.alloc(bytes)),
      finish: () => resolve(),
      fail: (error) => reject(error),
      cancel: () => {
        request.cancelled = true;
        reject(new Error('speech cancelled'));
      },
    };

    this.requests.push(request);
    return request;
  }
}

/** A realtime socket the test answers. */
export class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  event(event: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

/** A capture device the test feeds: `pcm` delivers audio to the open stream, `fail` fails it. */
export class FakeCapture implements Capture {
  readonly devices: Array<string | null> = [];
  readonly references: Buffer[] = [];
  stream: { onPcm: (pcm: Buffer) => void; onError: (error: Error) => void; stopped: boolean } | null = null;
  opens = 0;
  fail: Error | null = null;
  /** What each stream opened says of its echo cancellation (`CaptureStream.halfDuplex`). */
  halfDuplex: string | null = null;
  /** What each stream opened says of a Remote Desktop session (`CaptureStream.remote`). */
  remote: boolean | null = null;

  /** When set, an open waits for it before answering. */
  hold: Promise<void> | null = null;

  async open(device: string | null, onPcm: (pcm: Buffer) => void, onError: (error: Error) => void): Promise<CaptureStream> {
    this.devices.push(device);
    this.opens++;
    await this.hold;

    if (this.fail !== null) {
      throw this.fail;
    }

    const stream = { onPcm, onError, stopped: false };

    this.stream = stream;

    return {
      stop: () => {
        stream.stopped = true;
      },
      halfDuplex: this.halfDuplex,
      remote: this.remote,
      reference: (pcm) => this.references.push(pcm),
    };
  }

  /** Delivers `ms` of silence to the open stream. */
  pcm(ms: number): void {
    if (this.stream !== null && !this.stream.stopped) {
      this.stream.onPcm(Buffer.alloc(ms * 32));
    }
  }

  /** Delivers `ms` of a sine at `hz` to the open stream, continuing its phase from the last tone. */
  tone(ms: number, hz: number, amplitude = 0.3): void {
    if (this.stream === null || this.stream.stopped) {
      return;
    }

    const count = ms * 16;
    const pcm = Buffer.alloc(count * 2);

    for (let index = 0; index < count; index++) {
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * this.#phase++) / 16_000) * amplitude * 32_767), index * 2);
    }

    this.stream.onPcm(pcm);
  }

  #phase = 0;

  get open_(): boolean {
    return this.stream !== null && !this.stream.stopped;
  }
}

/** A recogniser whose words the test sets: each stream reads `text` as it stood when audio came, and `held` once finished. */
export class FakeEngine implements AsrEngine {
  device: 'gpu' | 'cpu' = 'cpu';
  text = '';
  held = '';
  streams = 0;
  /** Samples fed to every stream. */
  accepted = 0;

  stream(): AsrStream {
    this.streams++;
    this.text = '';

    let text = '';

    return {
      accept: (samples) => {
        this.accepted += samples.length;
        text = this.text;
      },
      text: () => text,
      finish: () => {
        text = `${this.text} ${this.held}`.trim();
        this.held = '';
      },
    };
  }
}

/** Lets promise callbacks run. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
  }
}
