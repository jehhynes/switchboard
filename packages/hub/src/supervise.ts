import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Server } from 'node:net';
import { join, posix } from 'node:path';
import { answers, lockAddress, switchboardHome } from '@switchboard/core';

/** How often the supervisor checks the hub lock. */
export const SUPERVISE_CHECK_MS = 2_000;
/** How long a supervisor that has seen no hub yet leaves the login start to start one, so the two do not race for the lock. */
export const SUPERVISE_GRACE_MS = 15_000;
/** The wait before the second start since the hub last ran steadily; each further start doubles it, up to `SUPERVISE_MAX_MS`. */
export const SUPERVISE_BASE_MS = 10_000;
export const SUPERVISE_MAX_MS = 300_000;
/** How long the hub must hold its lock before its next crash counts as the first again. */
export const SUPERVISE_STABLE_MS = 600_000;

/** What a hub that stopped on purpose leaves behind: its pid, when, and why. */
export interface StoppedRecord {
  pid: number;
  at: number;
  reason: string;
}

/** `<home>/.switchboard/hub-stopped.json`: the last hub stopped on purpose, so the supervisor does not start another. */
export function stoppedPath(home: string): string {
  return join(switchboardHome(home), 'hub-stopped.json');
}

/** Written by a hub that stops on purpose before it lets go of its lock; a restart onto a new build is not a stop. */
export function writeStopped(home: string, reason: string, now: number = Date.now()): void {
  const path = stoppedPath(home);

  writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify({ pid: process.pid, at: now, reason }));
  renameSync(`${path}.${process.pid}.tmp`, path);
}

export function readStopped(home: string): StoppedRecord | null {
  try {
    const raw = JSON.parse(readFileSync(stoppedPath(home), 'utf8')) as Partial<StoppedRecord>;

    return typeof raw.pid === 'number' && typeof raw.at === 'number' && typeof raw.reason === 'string' ? { pid: raw.pid, at: raw.at, reason: raw.reason } : null;
  } catch {
    return null;
  }
}

/** Removed by the hub that takes the lock, so a later crash of that hub counts as one. */
export function clearStopped(home: string): void {
  rmSync(stoppedPath(home), { force: true });
}

/**
 * The supervisor's own lock: a named pipe beside the hub's on Windows, and an abstract socket on Linux, which has no file to outlive a crashed
 * supervisor, so no start ever has to remove one another holds.
 */
export function supervisorAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `${lockAddress(home, 'win32')}-supervisor`;
  }

  return `\0switchboard-supervisor-${createHash('sha256').update(posix.resolve(home)).digest('hex').slice(0, 16)}`;
}

const STOP_LINE = 'stop';

/**
 * `<home>/.switchboard/supervisor-token`: the secret a stop request must carry, readable only by its user, because any local account can reach
 * an abstract socket.
 */
export function supervisorTokenPath(home: string): string {
  return join(switchboardHome(home), 'supervisor-token');
}

function listenSupervisor(address: string, token: string, onStop: () => void): Promise<Server | null> {
  return new Promise((done, fail) => {
    const server = createServer((socket) => {
      let text = '';

      socket.setEncoding('utf8');
      socket.setTimeout(2_000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', (chunk: string) => {
        text += chunk;

        if (!text.includes('\n')) {
          return;
        }

        if (text.trim() === `${STOP_LINE} ${token}`) {
          socket.end('stopping\n');
          onStop();
        } else {
          socket.destroy();
        }
      });
    });

    server.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? done(null) : fail(error)));
    server.listen(address, () => {
      server.unref();
      done(server);
    });
  });
}

/** Holds the supervisor lock of a home, or null when another supervisor holds it. A `stop` line with the token file's secret calls `onStop`. */
export async function holdSupervisorLock(home: string, onStop: () => void): Promise<Server | null> {
  const token = randomBytes(24).toString('hex');
  const server = await listenSupervisor(supervisorAddress(home), token, onStop);

  if (server !== null) {
    const path = supervisorTokenPath(home);

    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(`${path}.${process.pid}.tmp`, token, { mode: 0o600 });
    renameSync(`${path}.${process.pid}.tmp`, path);
  }

  return server;
}

/**
 * `<home>/.switchboard/supervisor-off`: written by `hub.js autostart off` on Windows before it deletes the task, so a supervisor the task had
 * already launched, which has yet to take its lock, exits once it has; `autostart on` removes it.
 */
export function supervisorOffPath(home: string): string {
  return join(switchboardHome(home), 'supervisor-off');
}

/** Asks the supervisor of `home` to stop and waits until it has: true once stopped, false when none ran. */
export async function stopSupervisor(home: string, waitMs = 5_000): Promise<boolean> {
  const address = supervisorAddress(home);

  if (!(await answers(address))) {
    return false;
  }

  // A supervisor that has just taken its lock may not have written its token yet, so each try reads it again until the time runs out.
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; ) {
    let token = '';

    try {
      token = readFileSync(supervisorTokenPath(home), 'utf8').trim();
    } catch {
      // Not written yet: the request is refused and tried again.
    }

    await new Promise<void>((done) => {
      const socket = createConnection(address, () => socket.write(`${STOP_LINE} ${token}\n`));

      socket.setTimeout(2_000, () => socket.destroy());
      socket.on('data', () => {});
      socket.on('error', () => done());
      socket.on('close', () => done());
    });

    for (const settle = Math.min(deadline, Date.now() + 500); Date.now() < settle; ) {
      if (!(await answers(address))) {
        return true;
      }

      await new Promise((done) => setTimeout(done, 100));
    }
  }

  throw new Error(`the supervisor on ${address} did not stop within ${waitMs / 1000} seconds`);
}

export interface SuperviseDeps {
  /** Whether a hub process holds the hub lock, which a starting or hung hub does too. */
  hubLocked(): Promise<boolean>;
  /** Whether a hub restarting onto a new build is handing over to a successor that still runs. */
  handover(): boolean;
  /** The record of the last hub stopped on purpose, while no hub has taken the lock since. */
  stopped(): StoppedRecord | null;
  /** Starts the installed hub detached; answers why it could not, or null. */
  start(): string | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  checkMs?: number;
  graceMs?: number;
  /** The wait before the second start; `SUPERVISE_BASE_MS` when left out. */
  restartDelayMs?: number;
}

/** The wait after the last start before the next, for the `attempts`th start since the hub last ran steadily, doubling from `baseMs`. */
export function restartDelay(attempts: number, baseMs = SUPERVISE_BASE_MS): number {
  return attempts === 0 ? 0 : Math.min(baseMs * 2 ** (attempts - 1), SUPERVISE_MAX_MS);
}

/**
 * `hub.js supervise`: starts the hub again when it has gone without stopping on purpose (architecture.md § Hub lifecycle). It never starts a hub
 * while any process holds the hub lock or a restart onto a new build hands over, and a hub stopped with `hub.js --stop` stays stopped until
 * something else starts one. Starts back off while the hub keeps failing.
 */
export class HubSupervisor {
  #stopping = false;
  #wake: (() => void) | null = null;

  constructor(private readonly deps: SuperviseDeps) {}

  stop(): void {
    this.#stopping = true;
    this.#wake?.();
  }

  #wait(ms: number): Promise<void> {
    return new Promise((done) => {
      this.#wake = done;
      void this.deps.sleep(ms).then(() => done());
    });
  }

  async run(): Promise<void> {
    const { deps } = this;
    const checkMs = deps.checkMs ?? SUPERVISE_CHECK_MS;
    const graceMs = deps.graceMs ?? SUPERVISE_GRACE_MS;
    const began = deps.now();
    let seen = false;
    let attempts = 0;
    let lastStart: number | null = null;
    let upSince: number | null = null;
    let said: string | null = null;
    const say = (line: string): void => {
      if (line !== said) {
        deps.log(line);
        said = line;
      }
    };

    while (!this.#stopping) {
      if (await deps.hubLocked()) {
        seen = true;
        said = null;
        upSince ??= deps.now();

        if (deps.now() - upSince >= SUPERVISE_STABLE_MS) {
          attempts = 0;
        }
      } else {
        upSince = null;

        const handingOver = deps.handover();
        const stopped = handingOver ? null : deps.stopped();
        const delay = restartDelay(attempts, deps.restartDelayMs);

        if (handingOver) {
          say('the hub is handing over to a new build; waiting for the new hub');
        } else if (stopped !== null) {
          say(`the hub (pid ${stopped.pid}) was stopped on purpose (${stopped.reason}); not starting it until something else does`);
        } else if (!seen && lastStart === null && deps.now() - began < graceMs) {
          // The login start's turn.
        } else if (lastStart !== null && deps.now() - lastStart < delay) {
          say(`the hub is not running; starting it again ${delay / 1000} seconds after the last start`);
        } else {
          const why = deps.start();

          lastStart = deps.now();
          attempts += 1;
          said = null;
          deps.log(why !== null ? `could not start the hub: ${why}` : seen ? `the hub stopped without hub.js --stop; starting it again (start ${attempts} since it last ran steadily)` : 'no hub is running; starting one');
        }
      }

      if (!this.#stopping) {
        await this.#wait(checkMs);
      }
    }
  }
}
