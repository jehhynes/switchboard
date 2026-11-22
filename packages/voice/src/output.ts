/** One playback: PCM written in order, played as it comes; `stop` ends it at once and drops what is left. */
export interface Playback {
  write(pcm: Buffer): Promise<void>;
  /** Resolves once everything written has played. */
  drain(): Promise<void>;
  stop(): void;
  /** How much of it has been heard, in milliseconds, where the device reports it, as a phone does; left out where it is timed by the clock. */
  position?(): number;
}

/** The playback device; decibri's `Speaker` in the process, a fake in tests. */
export interface Output {
  /** `device` is a case-insensitive part of the device's name, or null for the system default. */
  open(device: string | null): Promise<Playback>;
  /** The capture and playback library, for the `audio` report. */
  readonly engine: string;
}

/** One open capture: 16 kHz mono 16-bit PCM as it comes, and the audio played, pushed as it plays, for echo cancellation. */
export interface CaptureStream {
  stop(): void;
  /**
   * Why this capture has no working echo cancellation, such as "no echo cancellation on Remote Audio", so dictation stops listening while the
   * voice plays (architecture.md § Dictation); null when the echo is cancelled.
   */
  readonly halfDuplex: string | null;
  /** Whether the voice process runs in a Remote Desktop session, which picks `voice.duplex.remote` over `voice.duplex.local`; null when unknown. */
  readonly remote: boolean | null;
  /** Audio being played, 24 kHz mono 16-bit PCM, in played order. */
  reference(pcm: Buffer): void;
}

/** The capture device; decibri's `Microphone` in the process, a fake in tests (architecture.md § Dictation). */
export interface Capture {
  /** `device` is a case-insensitive part of the device's name, or null for the system default. */
  open(device: string | null, onPcm: (pcm: Buffer) => void, onError: (error: Error) => void): Promise<CaptureStream>;
}

/** A short two-tone chime, 24 kHz 16-bit mono PCM, that the voice plays when another work item starts needing the operator. */
export function needsYouChime(sampleRate = 24_000): Buffer {
  const tones = [
    { hz: 880, ms: 110 },
    { hz: 1320, ms: 160 },
  ];
  const samples = tones.reduce((sum, tone) => sum + Math.round((sampleRate * tone.ms) / 1000), 0);
  const pcm = Buffer.alloc(samples * 2);
  let at = 0;

  for (const tone of tones) {
    const length = Math.round((sampleRate * tone.ms) / 1000);

    for (let index = 0; index < length; index++) {
      // A short fade at each end, so the tone does not click.
      const fade = Math.min(1, index / (sampleRate * 0.01), (length - index) / (sampleRate * 0.02));
      const value = Math.sin((2 * Math.PI * tone.hz * index) / sampleRate) * 0.25 * fade;

      pcm.writeInt16LE(Math.round(value * 32767), (at + index) * 2);
    }

    at += length;
  }

  return pcm;
}
