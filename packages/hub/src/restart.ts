import type { LogLevel } from '@switchboard/core';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { switchboardHome } from '@switchboard/core';
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
  /** Its process ID, which the handover file names. */
  pid: number;
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
  /**
   * Refuses new requests, stops this hub so the successor takes its lock, port and record, and exits; or, when it could not hand over before
   * stopping anything, ends the successor and answers why, and this hub runs on.
   */
  handOver(successor: Successor): Promise<void | { error: string }>;
  log(line: string, level?: LogLevel): void;
}

/**
 * Restarts the hub onto the installed bundle when that is another build, or when `hub.js restart` asks, once the hub is quiet
 * (architecture.md § Hub lifecycle). `check` runs on a timer.
 */
export class HubRestart {
  /** `hub.js restart` asked, so the restart runs whatever build is installed. */
  #asked = false;
  /** An installed build whose successor did not start, tried again only when asked or once another build is installed. */
  #failed: string | null = null;
  /** The reason last logged for waiting, so each is logged once. */
  #waiting: string | null = null;
  #running = false;
  #handedOver = false;

  constructor(private readonly deps: RestartDeps) {}

  /** `POST /restart`: restarts once quiet; answers the installed build and what the restart waits for, or why not. */
  request(): { installed: string; waiting: string | null } | { refused: string } {
    const installed = this.deps.installed();

    if (installed === null) {
      return { refused: 'No hub bundle is installed.' };
    }

    if (this.#handedOver) {
      return { refused: 'The hub is already restarting.' };
    }

    this.#asked = true;
    this.deps.log('hub: restart asked by hub.js restart', 'debug');

    const waiting = this.#running ? null : this.deps.quiet();

    void this.check();

    return { installed, waiting };
  }

  /** Whether a restart is due: another build is installed, or one was asked for. */
  #due(installed: string | null): boolean {
    return installed !== null && (this.#asked || (installed !== this.deps.build && installed !== this.#failed));
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
        this.deps.log(`hub: restart onto build ${installed} waits: ${blocker}`);
        this.#waiting = blocker;
      }

      return;
    }

    this.#running = true;

    let handedTo: Successor;

    try {
      this.deps.log(`hub: restarting from build ${this.deps.build} onto build ${installed} (${this.#asked ? 'asked by hub.js restart' : 'it is installed'})`);

      const successor = await this.deps.successor();

      if ('error' in successor) {
        this.deps.log(`hub: restart failed: ${successor.error}; this hub keeps running`, 'warn');
        this.#failed = installed;
        this.#asked = false;
        this.#waiting = null;
        return;
      }

      // The successor took a while to load; anything that started meanwhile puts the restart off.
      const late = this.deps.quiet();

      if (late !== null) {
        successor.cancel();
        this.deps.log(`hub: restart onto build ${installed} waits: ${late}`);
        this.#waiting = late;
        return;
      }

      this.#handedOver = true;
      handedTo = successor;
    } finally {
      this.#running = false;
    }

    const refused = await this.deps.handOver(handedTo);

    // Nothing was handed over: this hub keeps running its own build.
    if (refused !== undefined) {
      this.deps.log(`hub: restart failed: ${refused.error}; this hub keeps running`, 'warn');
      this.#handedOver = false;
      this.#failed = installed;
      this.#asked = false;
      this.#waiting = null;
    }
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
  /** The runtime of this hub: Node.js, or an Electron executable in Node mode. */
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
      settle({ pid: child.pid!, cancel: () => child.kill() });
    });
  });
}

/** In a successor started with `--takeover`: tells the old hub this bundle loaded, and lets go of the IPC channel so it does not hold this process. */
export function reportReady(): void {
  if (process.send !== undefined) {
    process.send(READY_MESSAGE, () => process.disconnect());
  }
}

/** `<home>/.switchboard/hub-handover.json`: the successor a restarting hub hands over to, so a hub started meanwhile waits for it. */
export function handoverPath(home: string): string {
  return join(switchboardHome(home), 'hub-handover.json');
}

/**
 * Names the successor before the old hub lets go of the lock, with what the app hands it (`carried`), such as the voice's device and target
 * (architecture.md § Hub lifecycle).
 */
export function writeHandover(home: string, pid: number, now: number = Date.now(), carried?: Record<string, unknown>): void {
  const path = handoverPath(home);

  writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify({ pid, at: now, ...(carried === undefined ? {} : { carried }) }));
  renameSync(`${path}.${process.pid}.tmp`, path);
}

/** What the hub that handed over to `pid` carried to it, from a handover under `TAKEOVER_WAIT_MS` old that names it; null otherwise. */
export function handedOver(home: string, pid: number, now: number = Date.now()): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(handoverPath(home), 'utf8')) as { pid?: unknown; at?: unknown; carried?: unknown };
    const carried = raw.carried;

    return raw.pid === pid && typeof raw.at === 'number' && now - raw.at < TAKEOVER_WAIT_MS && now >= raw.at && typeof carried === 'object' && carried !== null && !Array.isArray(carried)
      ? (carried as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Removes the handover once the successor it names holds the lock. */
export function clearHandover(home: string, pid: number): void {
  if (pendingHandover(home, () => true)?.pid === pid) {
    rmSync(handoverPath(home), { force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The successor a restart hands over to, while its handover is under `TAKEOVER_WAIT_MS` old and its process runs; null otherwise. A hub start
 * that finds no hub then waits for this one rather than starting its own, which could take the lock first.
 */
export function pendingHandover(home: string, running: (pid: number) => boolean = alive, now: number = Date.now()): { pid: number } | null {
  try {
    const raw = JSON.parse(readFileSync(handoverPath(home), 'utf8')) as { pid?: unknown; at?: unknown };

    return typeof raw.pid === 'number' && typeof raw.at === 'number' && now - raw.at < TAKEOVER_WAIT_MS && now >= raw.at && running(raw.pid) ? { pid: raw.pid } : null;
  } catch {
    return null;
  }
}
