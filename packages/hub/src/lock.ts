import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import type { Server } from 'node:net';
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { switchboardHome } from '@switchboard/core';

/**
 * The address the hub holds for its lifetime: a named pipe on Windows, a socket file elsewhere. Only one process
 * can listen on it, and the OS releases a pipe when its process dies, so a crashed hub leaves no stale lock.
 */
export function lockAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const key = createHash('sha256').update(resolve(home).toLowerCase()).digest('hex').slice(0, 16);

    return `\\\\.\\pipe\\switchboard-${key}`;
  }

  return join(switchboardHome(home), 'hub.sock');
}

function listenOn(address: string): Promise<Server | null> {
  return new Promise((done, fail) => {
    const server = createServer((socket) => socket.destroy());

    server.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? done(null) : fail(error)));
    server.listen(address, () => {
      server.unref();
      done(server);
    });
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

/** Hold the hub lock for a home, or null when another live process holds it. */
export async function holdLock(home: string): Promise<Server | null> {
  const address = lockAddress(home);
  const held = await listenOn(address);

  if (held !== null || process.platform === 'win32') {
    return held;
  }

  // A socket file outlives a crashed process; remove it only when nothing answers on it.
  if (await answers(address)) {
    return null;
  }

  rmSync(address, { force: true });

  return listenOn(address);
}

export function releaseLock(lock: Server): Promise<void> {
  return new Promise((done) => lock.close(() => done()));
}
