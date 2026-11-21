import { spawn } from 'node:child_process';
import { closeSync, openSync, statSync } from 'node:fs';
import { buildOf } from './bundle.js';

/** How often the hub looks at the installed bundle and, while a restart waits, whether it is quiet. */
export const RESTART_CHECK_MS = 1_000;
/** How long a successor has to load its bundle and report ready. */
export const READY_TIMEOUT_MS = 30_000;
/** How long a successor waits for the old hub's lock, and the old hub for the successor's record. */
export const TAKEOVER_WAIT_MS = 30_000;
/** The message a successor sends over IPC once its bundle has loaded. */
export const READY_MESSAGE = 'switchboard-hub-ready';

/** A successor that reported ready and waits for the hub lock. */
export interface Successor {
  /** Ends it, when the old hub cannot hand over after all. */
  cancel(): void;
}

export interface RestartDeps {
  /** This hub's build. */
  build: string;
  /** The installed bundle's build, or null when none is installed. */
  installed(): string | null;
  /** Why the hub cannot restart now, or null when it is quiet. */
  quiet(): string | null;
  /** Starts the hub that takes over; resolves once it is ready, or with why it did not start. */
  successor(): Promise<Successor | { error: string }>;
  /** Refuses new requests, stops this hub so the successor takes its lock, port and record, and exits. */
  handOver(): Promise<void>;
  log(line: string): void;
}

/**
 * Restarts the hub onto the installed bundle when that is another build, once the hub is quiet
 * (architecture.md § Hub lifecycle). `check` runs on a timer.
 */
export class HubRestart {
  /** An installed build whose successor did not start, tried again only once another build is installed. */
  #failed: string | null = null;
  /** The reason last logged for waiting, so each is logged once. */
  #waiting: string | null = null;
  #running = false;
  #handedOver = false;

  constructor(private readonly deps: RestartDeps) {}

  /** Whether a restart is due: another build is installed, other than one whose successor did not start. */
  #due(installed: string | null): boolean {
    return installed !== null && installed !== this.deps.build && installed !== this.#failed;
  }

  async check(): Promise<void> {
    if (this.#running || this.#handedOver) {
      return;
    }

    const installed = this.deps.installed();

    if (!this.#due(installed)) {
      this.#waiting = null;
      return;
    }

    const blocker = this.deps.quiet();

    if (blocker !== null) {
      if (blocker !== this.#waiting) {
        this.deps.log(`hub restart onto build ${installed} waits: ${blocker}`);
        this.#waiting = blocker;
      }

      return;
    }

    this.#running = true;

    try {
      this.deps.log(`restarting the hub from build ${this.deps.build} onto build ${installed}, which is installed`);

      const successor = await this.deps.successor();

      if ('error' in successor) {
        this.deps.log(`hub restart failed: ${successor.error}; this hub keeps running`);
        this.#failed = installed;
        this.#waiting = null;
        return;
      }

      // The successor took a while to load; anything that started meanwhile puts the restart off.
      const late = this.deps.quiet();

      if (late !== null) {
        successor.cancel();
        this.deps.log(`hub restart onto build ${installed} waits: ${late}`);
        this.#waiting = late;
        return;
      }

      this.#handedOver = true;
    } finally {
      this.#running = false;
    }

    await this.deps.handOver();
  }
}

/**
 * The build of the installed bundle, read again only when its size or modification time changes, since the hub asks every second; null
 * while none is installed.
 */
export function installedBuild(bundle: string): () => string | null {
  let seen = '';
  let build: string | null = null;

  return () => {
    try {
      const stat = statSync(bundle);
      const key = `${stat.size}:${stat.mtimeMs}`;

      if (key !== seen) {
        build = buildOf(bundle);
        seen = key;
      }

      return build;
    } catch {
      seen = '';
      build = null;
      return null;
    }
  };
}

export interface SuccessorOptions {
  /** The runtime of this hub, VS Code's executable in Node mode or Node.js. */
  execPath: string;
  bundle: string;
  /** This hub's arguments, without any `--takeover`; `--takeover=<this pid>` is added. */
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  logPath: string;
  readyMs?: number;
}

/**
 * Starts the installed bundle as the hub that takes over from this one, detached with its output appended to the hub log, and resolves once it
 * reports ready over IPC, which it does after loading its bundle and before waiting for the lock. One that exits first or does not report in
 * time is ended and its reason returned.
 */
export function startSuccessor(options: SuccessorOptions): Promise<Successor | { error: string }> {
  const readyMs = options.readyMs ?? READY_TIMEOUT_MS;
  let log: number;

  try {
    log = openSync(options.logPath, 'a');
  } catch (error) {
    return Promise.resolve({ error: `the hub log cannot be opened: ${(error as Error).message}` });
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: Successor | { error: string }): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    const child = spawn(options.execPath, [options.bundle, ...options.args.filter((argument) => !argument.startsWith('--takeover')), `--takeover=${process.pid}`], {
      env: options.env,
      detached: true,
      stdio: ['ignore', log, log, 'ipc'],
      windowsHide: true,
    });

    closeSync(log);

    const timer = setTimeout(() => {
      child.kill();
      settle({ error: `the new hub did not report ready within ${readyMs / 1000} seconds` });
    }, readyMs);

    child.once('error', (error) => settle({ error: `the new hub did not start: ${error.message}` }));
    child.once('exit', (code, signal) => settle({ error: `the new hub exited (${signal ?? `code ${code}`}) before it was ready` }));
    child.on('message', (message) => {
      if (message !== READY_MESSAGE || settled) {
        return;
      }

      child.disconnect();
      child.unref();
      settle({ cancel: () => child.kill() });
    });
  });
}

/** In a successor started with `--takeover`: tells the old hub this bundle loaded, and lets go of the IPC channel so it does not hold this process. */
export function reportReady(): void {
  if (process.send !== undefined) {
    process.send(READY_MESSAGE, () => process.disconnect());
  }
}
