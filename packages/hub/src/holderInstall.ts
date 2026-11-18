import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Server } from 'node:net';
import { join, resolve, win32 } from 'node:path';
import { parseHolderRecord, recordPath } from '@switchboard/holder';

/** The holder build the extension carries, written by its build: a hash of every file's path and content, and the files, relative to its folder. */
export interface HolderManifest {
  build: string;
  files: string[];
}

export const MANIFEST_FILE = 'manifest.json';
/** Names the build a hub starts, in `<home>/holder/`. */
export const CURRENT_FILE = 'current.json';
/** Touched in a build's folder when a hub starts a holder from it, so an install in another window does not remove it meanwhile. */
export const IN_USE_FILE = 'in-use';
/** A build a hub reserved more recently than this is kept. */
const RECENT_MS = 10 * 60_000;
const LOCK_WAIT_MS = 10_000;

function readManifest(dir: string): HolderManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as Partial<HolderManifest>;

    return typeof raw.build === 'string' && /^[0-9a-f]{16}$/.test(raw.build) && Array.isArray(raw.files) && raw.files.every((file) => typeof file === 'string')
      ? { build: raw.build, files: raw.files }
      : null;
  } catch {
    return null;
  }
}

/** Whether a folder holds the whole build: its manifest and every file it lists. */
function complete(dir: string, build: string): boolean {
  const manifest = readManifest(dir);

  return manifest?.build === build && manifest.files.every((file) => existsSync(join(dir, file)));
}

/** The holder build a hub starts, or null when none is installed. */
export function currentHolderBuild(home: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'holder', CURRENT_FILE), 'utf8')) as { build?: unknown };

    return typeof raw.build === 'string' && /^[0-9a-f]{16}$/.test(raw.build) && existsSync(join(home, 'holder', raw.build, 'holder.js')) ? raw.build : null;
  } catch {
    return null;
  }
}

/**
 * Marks a complete build as in use before a holder starts from it, under the install lock, so an install in another window keeps its folder.
 * False when the build is not installed whole.
 */
export async function reserveHolderBuild(home: string, build: string): Promise<boolean> {
  const reserved = await withInstallLock(home, () => {
    const dir = join(home, 'holder', build);

    if (!complete(dir, build)) {
      return false;
    }

    const file = join(dir, IN_USE_FILE);
    const now = new Date();

    try {
      utimesSync(file, now, now);
    } catch {
      writeFileSync(file, '');
    }

    return true;
  });

  return reserved === true;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The install lock of a home: a named pipe on Windows, a socket file elsewhere, which the system releases when its process ends. */
export function installLockAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\switchboard-holder-install-${createHash('sha256').update(win32.resolve(home).toLowerCase()).digest('hex').slice(0, 16)}`;
  }

  return join(resolve(home), 'holder', 'install.sock');
}

function listen(address: string): Promise<Server | null> {
  return new Promise((done, fail) => {
    const server = createServer((socket) => socket.destroy());

    server.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? done(null) : fail(error)));
    server.listen(address, () => done(server));
  });
}

function answers(address: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection(address, () => {
      socket.destroy();
      done(true);
    });

    socket.on('error', () => done(false));
  });
}

/** Runs `work` while holding the install lock of the home, so windows activating at once and a hub reserving a build take turns. */
async function withInstallLock<T>(home: string, work: () => T, waitMs = LOCK_WAIT_MS): Promise<T | { error: string }> {
  const address = installLockAddress(home);
  const deadline = Date.now() + waitMs;
  let server: Server | null = null;

  try {
    mkdirSync(join(home, 'holder'), { recursive: true });

    while (server === null) {
      server = await listen(address);

      // A socket file outlives a crashed process; it is removed only when nothing answers on it.
      if (server === null && process.platform !== 'win32' && !(await answers(address))) {
        rmSync(address, { force: true });
        continue;
      }

      if (server === null) {
        if (Date.now() > deadline) {
          return { error: 'Another window is installing the terminal holder.' };
        }

        await new Promise((done) => setTimeout(done, 50));
      }
    }

    return work();
  } catch (error) {
    return { error: `The terminal holder's install lock could not be taken: ${(error as Error).message}` };
  } finally {
    const held = server;

    if (held !== null) {
      await new Promise<void>((done) => held.close(() => done()));
    }
  }
}

/**
 * Installs the holder build the extension carries into `<home>/holder/<build>/` and names it current. Each build has its own folder because
 * Windows refuses to replace a native module a running holder has loaded (mechanics M76). A complete installed build is never replaced; an
 * incomplete one is moved aside and copied again. Other build folders are removed, except the running holder's and one a hub reserved in the last
 * 10 minutes. Returns the build, or the error; a failure affects only Code Mode starts.
 */
export async function installHolder(source: string, home: string, running: (pid: number) => boolean = alive, now: () => number = Date.now): Promise<{ build: string } | { error: string }> {
  const manifest = readManifest(source);

  if (manifest === null) {
    return { error: `${join(source, MANIFEST_FILE)} is missing or invalid.` };
  }

  const root = join(home, 'holder');
  const target = join(root, manifest.build);

  return withInstallLock(home, () => {
      try {
        if (!complete(target, manifest.build)) {
          const temporary = `${target}.${process.pid}.tmp`;
          const aside = `${target}.${process.pid}.${now()}.old`;

          rmSync(temporary, { recursive: true, force: true });

          for (const file of [...manifest.files, MANIFEST_FILE]) {
            cpSync(join(source, file), join(temporary, file));
          }

          // A folder a holder has loaded cannot be removed on Windows, but it can be moved aside, and back when the new copy cannot take its place.
          const moved = existsSync(target);

          if (moved) {
            renameSync(target, aside);
          }

          try {
            renameSync(temporary, target);
          } catch (error) {
            if (moved) {
              renameSync(aside, target);
            }

            throw error;
          }
        }

        const pointer = join(root, CURRENT_FILE);

        writeFileSync(`${pointer}.${process.pid}.tmp`, JSON.stringify({ build: manifest.build }));
        renameSync(`${pointer}.${process.pid}.tmp`, pointer);
      } catch (error) {
        return { error: `The terminal holder could not be installed in ${target}: ${(error as Error).message}` };
      }

      try {
        removeOldBuilds(home, manifest.build, running, now);
      } catch {
        // A folder that cannot be listed is left for a later install.
      }

      return { build: manifest.build };
  });
}

function recentlyUsed(dir: string, now: () => number): boolean {
  try {
    return now() - statSync(join(dir, IN_USE_FILE)).mtimeMs < RECENT_MS;
  } catch {
    return false;
  }
}

/** Removes build folders other than `keep`, the running holder's and recent ones; a folder a process has loaded stays until a later install. */
function removeOldBuilds(home: string, keep: string, running: (pid: number) => boolean, now: () => number): void {
  const root = join(home, 'holder');
  let inUse: string | null = null;

  try {
    const record = parseHolderRecord(readFileSync(recordPath(home), 'utf8'));

    inUse = record !== null && running(record.pid) ? record.build : null;
  } catch {
    // No holder runs.
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === keep || entry.name === inUse || recentlyUsed(join(root, entry.name), now)) {
      continue;
    }

    try {
      rmSync(join(root, entry.name), { recursive: true, force: true });
    } catch {
      // Loaded by a process; removed at a later install.
    }
  }
}
