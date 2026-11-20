import type { Output, Playback } from './output.js';

interface Speaker {
  writeAsync(chunk: Buffer): Promise<void>;
  drainAsync(): Promise<void>;
  stop(): void;
}

interface DecibriModule {
  Speaker: { open(options: { sampleRate: number; channels: number; dtype: 'int16'; device?: string }): Promise<Speaker> };
}

/**
 * Playback through decibri (prebuilt N-API, voice-design § 2.3), which only the voice process's entry point loads. A platform where it could not
 * install still runs the process, and each playback fails with the load error.
 */
export async function decibriOutput(sampleRate: number): Promise<Output> {
  let loaded: DecibriModule | Error;

  try {
    // A variable specifier keeps TypeScript from needing decibri's types where it is not installed.
    const name = 'decibri';
    const module = (await import(name)) as { default?: DecibriModule } & DecibriModule;

    loaded = module.default?.Speaker === undefined ? module : module.default;
  } catch (error) {
    loaded = error as Error;
  }

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
