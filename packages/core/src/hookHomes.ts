import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { switchboardHome } from './paths.js';

/** A script Switchboard installs as a hook: one of its files directly in a Switchboard home, which is always named `.switchboard`. */
const SCRIPT = /^(.*\/\.switchboard)\/(?:hook|codex-hook|contract)\.mjs$/;

/** The Switchboard home a hook script belongs to, with forward slashes, or null for any other path. */
export function scriptHome(path: string): string | null {
  return SCRIPT.exec(path.replaceAll('\\', '/'))?.[1] ?? null;
}

/**
 * The address the hub holds for its lifetime, from the folder that holds its Switchboard home: a named pipe on Windows, a socket
 * file elsewhere. Only one process can listen on it, and the OS releases a pipe when its process dies, so a crashed hub leaves no stale lock.
 */
export function lockAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const key = createHash('sha256').update(win32.resolve(home).toLowerCase()).digest('hex').slice(0, 16);

    return `\\\\.\\pipe\\switchboard-${key}`;
  }

  return join(switchboardHome(home), 'hub.sock');
}

/** Whether a process listens on the address. */
export function answers(address: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection(address, () => {
      socket.destroy();
      done(true);
    });

    socket.on('error', () => done(false));
  });
}

/** Whether a hub holds the lock of a Switchboard home. A hub takes its lock before it installs hooks, so a starting hub counts. */
export function hubRunning(home: string): Promise<boolean> {
  return answers(lockAddress(dirname(home)));
}

const sameHome = (a: string, b: string) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/**
 * The other Switchboard homes a hook plan asks about whose hub is not running. `ask` runs the plan with a check that records each home
 * and keeps it. The profile's own home (`~/.switchboard`) never counts: while its hub is down, an acceptance hub that shares the
 * operator's settings must not take away the hooks of the operator's sessions.
 */
export async function stoppedHomes(
  ask: (stale: (home: string) => boolean) => unknown,
  running: (home: string) => Promise<boolean> = hubRunning,
  profile: string = homedir(),
): Promise<ReadonlySet<string>> {
  const homes = new Set<string>();

  ask((home) => (homes.add(home), false));

  const stopped = new Set<string>();

  await Promise.all(
    [...homes].map(async (home) => {
      if (!sameHome(home, switchboardHome(profile)) && !(await running(home))) {
        stopped.add(home);
      }
    }),
  );

  return stopped;
}
