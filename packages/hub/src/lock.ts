import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { rmSync } from 'node:fs';
import { answers, lockAddress } from '@switchboard/core';

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
