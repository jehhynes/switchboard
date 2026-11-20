import type { Capture, CaptureStream, Output, Playback } from './output.js';

interface Speaker {
  writeAsync(chunk: Buffer): Promise<void>;
  drainAsync(): Promise<void>;
  stop(): void;
}

interface Microphone {
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  stop(): void;
  pushAecReference(data: Buffer): void;
}

interface DecibriModule {
  Speaker: { open(options: { sampleRate: number; channels: number; dtype: 'int16'; device?: string }): Promise<Speaker> };
  Microphone: { open(options: Record<string, unknown>): Promise<Microphone> };
}

/** Loads decibri, or the error that kept it from loading. */
async function loadDecibri(): Promise<DecibriModule | Error> {
  try {
    // A variable specifier keeps TypeScript from needing decibri's types where it is not installed.
    const name = 'decibri';
    const module = (await import(name)) as { default?: DecibriModule } & DecibriModule;

    return module.default?.Speaker === undefined ? module : module.default;
  } catch (error) {
    return error as Error;
  }
}

/** decibri's `tau` canceller removed almost none of the echo in the echo checks (mechanics.md M94), so its capture is half-duplex. */
export const DECIBRI_HALF_DUPLEX = "decibri's echo canceller removes too little echo";

/**
 * Capture through decibri's `Microphone` (architecture.md § Dictation) at 16 kHz mono 16-bit in 100 ms chunks, with its `tau` echo canceller fed
 * the 24 kHz audio the voice plays, so a reply played aloud is taken out of what the recogniser hears.
 */
export async function decibriCapture(sampleRate: number, referenceRate: number): Promise<Capture> {
  const loaded = await loadDecibri();

  return {
    open: async (device, onPcm, onError): Promise<CaptureStream> => {
      if (loaded instanceof Error) {
        throw new Error(`Capture is not available: ${loaded.message}`);
      }

      const mic = await loaded.Microphone.open({
        sampleRate,
        channels: 1,
        dtype: 'int16',
        framesPerBuffer: sampleRate / 10,
        aec: { model: 'tau', referenceSampleRate: referenceRate },
        ...(device === null ? {} : { device }),
      });
      let stopped = false;

      mic.on('data', (chunk) => {
        if (!stopped) {
          onPcm(chunk);
        }
      });
      mic.on('error', (error) => {
        if (!stopped) {
          onError(error);
        }
      });

      return {
        stop: () => {
          if (!stopped) {
            stopped = true;
            mic.stop();
          }
        },
        halfDuplex: DECIBRI_HALF_DUPLEX,
        reference: (pcm) => {
          if (!stopped) {
            mic.pushAecReference(pcm);
          }
        },
      };
    },
  };
}

/**
 * Playback through decibri (prebuilt N-API, voice-design § 2.3), which only the voice process's entry point loads. A platform where it could not
 * install still runs the process, and each playback fails with the load error.
 */
export async function decibriOutput(sampleRate: number): Promise<Output> {
  const loaded = await loadDecibri();

  return {
    engine: 'decibri',
    open: async (device): Promise<Playback> => {
      if (loaded instanceof Error) {
        throw new Error(`Playback is not available: ${loaded.message}`);
      }

      const speaker = await loaded.Speaker.open({ sampleRate, channels: 1, dtype: 'int16', ...(device === null ? {} : { device }) });
      let stopped = false;

      return {
        write: (pcm) => (stopped ? Promise.resolve() : speaker.writeAsync(pcm)),
        drain: () => (stopped ? Promise.resolve() : speaker.drainAsync()),
        stop: () => {
          if (!stopped) {
            stopped = true;
            speaker.stop();
          }
        },
      };
    },
  };
}
