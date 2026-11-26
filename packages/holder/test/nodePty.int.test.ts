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
  // Sessions end one at a time, because sessions ending together have crashed node-pty's native code (mechanics M168).
  it.skipIf(process.platform !== 'win32')("closes each ended session's input pipe and output Worker, whether the program exits or is killed", async () => {
    host = new Host({ token: TOKEN, build: 'test', spawnPty: await loadNodePty(), killTree, closePty: (pty) => closePseudoTerminal(pty), releasePty: (pty) => void releasePseudoTerminal(pty) });

    const client = await HolderClient.connect({ port: await host.listen(), token: TOKEN });
    const ended = (session: string): Promise<void> => until(async () => (await client.list()).some((entry) => entry.session === session && entry.exitedAt !== null), `session ${session} to end`);
    const before = ptyHandles();

    await client.spawn({ session: 'exits', ...program("process.stdout.write('ready\\n'); setTimeout(() => process.exit(0), 300);") });
    await client.spawn({ session: 'killed', ...program("process.stdout.write('ready\\n'); setInterval(() => {}, 1000);") });
    await until(async () => (await client.screen('killed')).head.includes('ready'), 'the program to start');
    await ended('exits');

    // The killed session's input pipe and Worker are open while it runs.
    expect(ptyHandles().pipes).toBeGreaterThan(before.pipes);
    expect(ptyHandles().ports).toBeGreaterThan(before.ports);
    await client.kill('killed');
    await ended('killed');

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
