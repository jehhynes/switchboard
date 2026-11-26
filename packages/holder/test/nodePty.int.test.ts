import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { HolderClient } from '../src/client.js';
import { closePseudoTerminal, releasePseudoTerminal } from '../src/close.js';
import { Host } from '../src/host.js';
import { loadNodePty } from '../src/nodePty.js';
import { killTree } from '../src/processes.js';

const TOKEN = 'b'.repeat(64);
let host: Host | null = null;

afterEach(async () => {
  await host?.endAll();
  await host?.close();
  host = null;
});

/** The open pipes, other than standard input and output, and Worker message ports of this process, which node-pty opens for each Windows pseudo-terminal. */
function ptyHandles(): { pipes: number; ports: number } {
  const handles = (process as unknown as { _getActiveHandles(): Array<{ constructor?: { name?: string }; _handle?: { constructor?: { name?: string }; fd?: number } }> })._getActiveHandles();

  return {
    pipes: handles.filter((handle) => handle.constructor?.name === 'Socket' && handle._handle?.constructor?.name === 'Pipe' && (handle._handle.fd ?? -1) > 2).length,
    ports: handles.filter((handle) => handle.constructor?.name === 'MessagePort').length,
  };
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const program = (code: string) => ({ label: 'test', file: process.execPath, args: ['-e', code], cwd: tmpdir(), env, cols: 80, rows: 24 });

describe('node-pty on Windows', () => {
  it.skipIf(process.platform !== 'win32')("closes each ended session's input pipe and output Worker, whether the program exits or is killed", async () => {
    host = new Host({ token: TOKEN, build: 'test', spawnPty: await loadNodePty(), killTree, closePty: (pty) => closePseudoTerminal(pty), releasePty: (pty) => void releasePseudoTerminal(pty) });

    const client = await HolderClient.connect({ port: await host.listen(), token: TOKEN });
    const ended = (session: string): Promise<void> => until(async () => (await client.list()).some((entry) => entry.session === session && entry.exitedAt !== null), `session ${session} to end`);
    const before = ptyHandles();

    const exiting = ['e1', 'e2', 'e3'];
    const killed = ['k1', 'k2', 'k3'];

    await Promise.all(exiting.map((session) => client.spawn({ session, ...program("process.stdout.write('ready\\n'); setTimeout(() => process.exit(0), 300);") })));
    await Promise.all(killed.map((session) => client.spawn({ session, ...program("process.stdout.write('ready\\n'); setInterval(() => {}, 1000);") })));
    await Promise.all(killed.map((session) => until(async () => (await client.screen(session)).head.includes('ready'), `session ${session} to start`)));
    await Promise.all(exiting.map(ended));

    // The killed sessions' input pipes and Workers are open while they run.
    expect(ptyHandles().pipes).toBeGreaterThanOrEqual(before.pipes + killed.length);
    expect(ptyHandles().ports).toBeGreaterThanOrEqual(before.ports + killed.length);
    await Promise.all(killed.map((session) => client.kill(session)));
    await Promise.all(killed.map(ended));

    // node-pty ends the Worker a second after its dispose, which comes a second after the program's last output.
    let after = ptyHandles();

    await until(() => {
      after = ptyHandles();

      return after.pipes <= before.pipes && after.ports <= before.ports;
    }, 'the pipes and Workers to close').catch(() => {
      throw new Error(`The ended sessions kept pipes or Workers: ${JSON.stringify(before)} before, ${JSON.stringify(after)} after.`);
    });
    client.close();
  }, 60_000);
});
