import type { LogLevel } from '@switchboard/core/log';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Capture, CaptureStream } from './output.js';

/** How long the helper may take to compile and open the device before capture falls back. */
export const WINDOWS_CAPTURE_START_MS = 20_000;
/** How long a stopped helper may take to exit before it is killed. */
const STOP_MS = 3000;

export interface WindowsCaptureDeps {
  /** `commcapture.ps1`, beside the voice process's script. */
  script: string;
  /** The playback device setting, read at each open: the echo reference is the device the voice plays through. */
  speakers(): string | null;
  log(line: string, level?: LogLevel): void;
  spawn?: typeof spawn;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

/**
 * Capture on Windows through `commcapture.ps1` (architecture.md § Dictation): the mic in communications mode, where Windows cancels the echo of
 * what the voice's speakers play itself, so the audio the voice plays is not fed to it. 16 kHz mono 16-bit PCM from the helper's stdout; its
 * first stderr line, the device and the effects Windows applies, goes to the voice log, and a device Windows applies no echo cancellation to
 * fails the open with a `NoEchoCancellation`, so capture falls back to decibri, half-duplex for that reason.
 */
export function windowsCapture(deps: WindowsCaptureDeps): Capture {
  const run = deps.spawn ?? spawn;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));

  return {
    open: (device, onPcm, onError) =>
      new Promise<CaptureStream>((resolve, reject) => {
        const speakers = deps.speakers();
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', deps.script, ...(device === null ? [] : ['-Device', device]), ...(speakers === null ? [] : ['-Speakers', speakers])];
        const child: ChildProcess = run('powershell.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let started = false;
        let stopped = false;
        let ended = false;
        let odd: Buffer | null = null;
        const fail = (why: string, noEcho?: { halfDuplex: string; remote: boolean }): void => {
          if (stopped || ended) {
            return;
          }

          ended = true;
          clearTimer(startTimer);

          if (started) {
            onError(new Error(why));
          } else {
            // Nothing more from this helper reaches recognition, which may be capturing through the fallback by now.
            child.stdout?.removeAllListeners('data');
            child.stdout?.resume();
            child.kill();
            reject(noEcho === undefined ? new Error(why) : new NoEchoCancellation(why, noEcho.halfDuplex, noEcho.remote));
          }
        };
        const startTimer = setTimer(() => fail(`the Windows capture helper did not start within ${WINDOWS_CAPTURE_START_MS / 1000} s`), WINDOWS_CAPTURE_START_MS);

        child.on('error', (error) => fail(`the Windows capture helper did not run: ${error.message}`));
        child.on('exit', (code) => fail(`the Windows capture helper exited with code ${code ?? 'none'}`));
        child.stdin?.on('error', () => undefined);
        child.stdout?.on('data', (data: Buffer) => {
          if (!started || stopped || ended) {
            return;
          }

          // A pipe can split a sample; its first byte waits for the next chunk.
          let pcm = odd === null ? data : Buffer.concat([odd, data]);

          odd = pcm.length % 2 === 1 ? pcm.subarray(pcm.length - 1) : null;
          pcm = pcm.subarray(0, pcm.length - (pcm.length % 2));

          if (pcm.length > 0) {
            onPcm(pcm);
          }
        });
        createInterface({ input: child.stderr! }).on('line', (line) => {
          if (ended) {
            return;
          }

          let message: { device?: unknown; error?: unknown; discontinuities?: unknown; effects?: unknown; remote?: unknown };

          try {
            message = JSON.parse(line) as typeof message;
          } catch {
            deps.log(`windows capture: ${line}`);
            return;
          }

          if (typeof message.error === 'string') {
            fail(message.error);
          } else if (typeof message.discontinuities === 'number') {
            if (message.discontinuities > 0) {
              deps.log(`windows capture: ${message.discontinuities} packets followed lost audio`);
            }
          } else if (!started && typeof message.device === 'string') {
            deps.log(`windows capture: ${line}`);

            const remote = message.remote === true || /remote audio/i.test(message.device);

            if (!cancelsEcho(message.effects)) {
              fail(`Windows applies no echo cancellation to ${message.device}`, { halfDuplex: noEchoReason(message.device, remote), remote });
              return;
            }

            started = true;
            clearTimer(startTimer);
            resolve({
              stop: () => {
                if (stopped) {
                  return;
                }

                stopped = true;
                // The helper exits when its stdin closes.
                child.stdin?.end();

                const kill = setTimer(() => child.kill(), STOP_MS);

                child.on('exit', () => clearTimer(kill));
              },
              halfDuplex: null,
              remote,
              // Windows' echo canceller takes its reference from the speakers.
              reference: () => undefined,
            });
          }
        });
      }),
  };
}

/** The device has no echo cancellation; `halfDuplex` says so for the voice log and the mic's tooltip, and `remote` whether this is a Remote Desktop session. */
export class NoEchoCancellation extends Error {
  constructor(
    message: string,
    readonly halfDuplex: string,
    readonly remote: boolean,
  ) {
    super(message);
  }
}

/**
 * Why a device has no echo cancellation, naming Remote Desktop when the helper reports a remote session or the device is its "Remote Audio",
 * whose capture Windows applies no effects to.
 */
export function noEchoReason(device: string, remote: boolean): string {
  if (/remote audio/i.test(device)) {
    return 'no echo cancellation on Remote Audio';
  }

  return remote ? `no echo cancellation on ${device} over Remote Desktop` : `no echo cancellation on ${device}`;
}

/** Whether the helper's effects list has acoustic echo cancellation on. */
function cancelsEcho(effects: unknown): boolean {
  return Array.isArray(effects) && effects.some((effect: { effect?: unknown; on?: unknown } | null) => effect?.effect === 'acoustic echo cancellation' && effect.on === true);
}

/**
 * Opens through `primary`, and through `fallback` when it fails, logging why. A half-duplex fallback after a `NoEchoCancellation` gives
 * that error's reason, which names the device, instead of its own.
 */
export function withFallback(primary: Capture, fallback: Capture, log: (line: string) => void, fallbackName: string): Capture {
  return {
    open: async (device, onPcm, onError) => {
      try {
        return await primary.open(device, onPcm, onError);
      } catch (error) {
        log(`${(error as Error).message}; capturing through ${fallbackName}`);

        const stream = await fallback.open(device, onPcm, onError);

        return error instanceof NoEchoCancellation && stream.halfDuplex !== null ? { stop: () => stream.stop(), reference: (pcm) => stream.reference(pcm), halfDuplex: error.halfDuplex, remote: error.remote } : stream;
      }
    },
  };
}
