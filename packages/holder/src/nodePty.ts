import type { Pty, PtyFactory } from './host.js';

export interface NodePtyModule {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): Pty;
}

interface Socket {
  once?: (event: string, listener: () => void) => unknown;
  on?: (event: string, listener: (error: Error) => void) => unknown;
  destroy?: () => void;
}

/** The part of node-pty 1.2's Windows terminal that tells when its program has started; node-pty's own, so checked before use. */
interface StartingPty {
  _agent?: { outSocket?: Socket; _inSocket?: Socket; kill?: () => void };
}

/** How long a program has, once node-pty spawned it, to connect its output and get a process ID. */
export const START_TIMEOUT_MS = 15_000;

/**
 * Pseudo-terminals from node-pty, a native module, which only the holder's entry point loads. node-pty is optional: on a platform where npm
 * could not build it, the holder still starts and each spawn fails with the load error (mechanics M76).
 */
export async function loadNodePty(): Promise<PtyFactory> {
  let loaded: NodePtyModule | Error;

  try {
    // A variable specifier keeps TypeScript from needing node-pty's types where it is not installed.
    const name = 'node-pty';
    const module = (await import(name)) as { default?: NodePtyModule } & NodePtyModule;

    loaded = module.default ?? module;
  } catch (error) {
    loaded = error as Error;
  }

  return ptyFactory(loaded);
}

/**
 * Spawns through a loaded node-pty and answers once the program has started. node-pty 1.2 starts a Windows program only when its output
 * worker thread is ready, so `pid` is 0 until the output pipe connects, and a program that cannot start ends with an exit instead of a throw
 * (mechanics M169).
 */
export function ptyFactory(loaded: NodePtyModule | Error, startTimeoutMs = START_TIMEOUT_MS): PtyFactory {
  return (file, args, options) => {
    if (loaded instanceof Error) {
      throw loaded;
    }

    const pty = loaded.spawn(file, args, { name: 'xterm-256color', cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env });

    if (pty.pid > 0) {
      return pty;
    }

    const agent = (pty as StartingPty)._agent;
    const outSocket = agent?.outSocket;

    if (typeof outSocket?.once !== 'function' || typeof outSocket.on !== 'function') {
      throw new Error('node-pty gave no process ID and no way to wait for one.');
    }

    return new Promise<Pty>((resolve, reject) => {
      let settled = false;
      const fail = (message: string): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        exit?.dispose?.();
        abandon(agent!);
        reject(new Error(message));
      };
      const exit = pty.onExit(({ exitCode }) => fail(`The program ended before it started (code ${exitCode}).`)) as { dispose?: () => void } | undefined;
      // node-pty clears its own timeout once its output Worker is ready, before the output pipe connects.
      const timer = setTimeout(() => fail(`The program did not start within ${startTimeoutMs / 1000} seconds.`), startTimeoutMs);

      // node-pty listens for the output pipe's errors only once it connected, and rethrows them while no other listener is registered, so this
      // listener stays: an error of one session's pipe fails its start, or after it reaches node-pty's own listener, and never the holder.
      outSocket.on!('error', (error) => fail(`Its output pipe failed: ${error.message}`));

      // node-pty sets the process ID in its own listener, registered first; output flows only after this event.
      outSocket.once!('ready_datapipe', () => {
        if (settled) {
          return;
        }

        if (pty.pid > 0) {
          settled = true;
          clearTimeout(timer);
          exit?.dispose?.();
          resolve(pty);
        } else {
          fail('node-pty started the program without a process ID.');
        }
      });
    });
  };
}

/**
 * Frees a pseudo-terminal whose program did not start: the agent's own `kill()`, because the terminal's waits for a start that has not come,
 * and its pipes.
 */
function abandon(agent: NonNullable<StartingPty['_agent']>): void {
  for (const free of [() => agent.kill?.(), () => agent._inSocket?.destroy?.(), () => agent.outSocket?.destroy?.()]) {
    try {
      free();
    } catch {
      // Already freed.
    }
  }
}
