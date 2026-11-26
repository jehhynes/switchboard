import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { Host } from './host.js';
import { closePseudoTerminal, releasePseudoTerminal } from './close.js';
import { loadNodePty } from './nodePty.js';
import { MemorySampler, killTree } from './processes.js';
import { PROTOCOL } from './protocol.js';
import { holderLockAddress, parseHolderRecord, recordPath } from './record.js';
import type { HolderRecord } from './record.js';

/** How long the holder stays up while it holds no live session. */
const IDLE_EXIT_MS = 10 * 60_000;

function option(name: string): string | undefined {
  const prefix = `--${name}=`;

  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/** One holder.log line in the hub log's format (logLine in @switchboard/core, which the holder does not depend on): time, level, text. */
function log(message: string, level: 'error' | 'warn' | 'info' = 'info'): void {
  process.stdout.write(`${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`);
}

function listen(address: string): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());

    server.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? resolve(null) : reject(error)));
    server.listen(address, () => resolve(server));
  });
}

function answers(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(address, () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => resolve(false));
  });
}

/** Holds the single-instance lock, or null when another live holder holds it. */
async function holdLock(home: string): Promise<Server | null> {
  const address = holderLockAddress(home);
  const held = await listen(address);

  if (held !== null || process.platform === 'win32') {
    return held;
  }

  // A socket file outlives a crashed process; remove it only when nothing answers on it.
  if (await answers(address)) {
    return null;
  }

  rmSync(address, { force: true });

  return listen(address);
}

/** Whether the holder named by the record accepts connections. */
async function recordAnswers(home: string): Promise<boolean> {
  try {
    const record = parseHolderRecord(readFileSync(recordPath(home), 'utf8'));

    return (
      record !== null &&
      (await new Promise<boolean>((resolve) => {
        const socket = createConnection({ port: record.port, host: '127.0.0.1' }, () => {
          socket.destroy();
          resolve(true);
        });

        socket.on('error', () => resolve(false));
      }))
    );
  } catch {
    return false;
  }
}

function writeRecord(home: string, record: HolderRecord): void {
  const path = recordPath(home);
  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

/** Removes the record only while it is this process's, so a successor's record stays. */
function removeRecord(home: string): void {
  try {
    if (parseHolderRecord(readFileSync(recordPath(home), 'utf8'))?.pid === process.pid) {
      rmSync(recordPath(home), { force: true });
    }
  } catch {
    // No record to remove.
  }
}

async function main(): Promise<void> {
  const home = option('home');

  if (home === undefined || home === '') {
    console.error('Usage: holder.js --home=<Switchboard home> [--build=<build>]');
    process.exit(2);
  }

  mkdirSync(home, { recursive: true });

  // A holder ended by force can hold its pipe for a moment after its exit.
  let lock = await holdLock(home);

  for (let attempt = 0; lock === null && attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));

    if (!(await recordAnswers(home))) {
      lock = await holdLock(home);
    }
  }

  if (lock === null) {
    log('Another terminal holder holds the lock of this home; exiting.');
    process.exit(0);
  }

  const idleExitMs = Number(option('idle-exit-ms') ?? IDLE_EXIT_MS);
  let idleTimer: NodeJS.Timeout | null = null;
  let host: Host | null = null;
  const sampler = new MemorySampler(() => host?.list().filter((entry) => entry.exitedAt === null).map((entry) => entry.pid) ?? [], undefined, 30_000, (error) => log(`Process memory could not be read: ${error}`));

  let exiting = false;
  const exit = async (reason: string): Promise<void> => {
    if (exiting) {
      return;
    }

    exiting = true;
    log(`Exiting: ${reason}`);
    sampler.stop();
    await host?.endAll();
    removeRecord(home);
    await host?.close();
    lock.close();
    process.exit(0);
  };

  const idle = (live: number): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    if (live === 0) {
      idleTimer = setTimeout(() => void exit('it held no session for the idle time'), idleExitMs);
    } else {
      void sampler.sample();
    }
  };

  const token = randomBytes(32).toString('hex');
  const build = option('build') ?? 'dev';

  host = new Host({
    token,
    build,
    spawnPty: await loadNodePty(),
    killTree: (pid) => killTree(pid),
    closePty: (pty) => closePseudoTerminal(pty),
    releasePty: (pty) => void releasePseudoTerminal(pty),
    log,
    memory: (pids) => sampler.memory(pids),
    tree: (pid) => sampler.tree(pid),
    onShutdown: () => void exit('shutdown was requested'),
    onLiveChange: idle,
  });

  const port = await host.listen();

  writeRecord(home, { protocol: PROTOCOL, build, port, token, pid: process.pid, startedAt: new Date().toISOString() });
  sampler.start();
  idle(0);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void exit(`it received ${signal}`));
  }

  log(`Listening on 127.0.0.1:${port} for ${home} (protocol ${PROTOCOL}, Node.js ${process.version}).`);
}

// A crash would end every held session, so an unexpected error is logged and the holder keeps running.
process.on('uncaughtException', (error) => log(`Unexpected error: ${error.stack ?? error.message}`, 'error'));
process.on('unhandledRejection', (error) => log(`Unexpected rejection: ${String(error)}`, 'error'));

main().catch((error: unknown) => {
  log(`The terminal holder could not start: ${(error as Error).stack ?? String(error)}`, 'error');
  process.exit(1);
});
