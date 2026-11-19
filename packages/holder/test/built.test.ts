import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HolderClient } from '../src/client.js';
import { parseHolderRecord, recordPath } from '../src/record.js';
import type { HolderRecord } from '../src/record.js';

const MAIN = join(import.meta.dirname, '..', 'dist', 'main.js');
const homes: string[] = [];
const pids: number[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKill(pid: number): void {
  if (!alive(pid)) {
    return;
  }

  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      forceKill(pid);
    } catch {
      // Already gone.
    }
  }

  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'holder-'));

  homes.push(home);

  return home;
}

/** Starts the built holder detached, as the hub does, and resolves its process once it exited or wrote a record. */
function startHolder(home: string, extra: string[] = []): { pid: number; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [MAIN, `--home=${home}`, '--build=test-build', ...extra], { detached: true, stdio: 'ignore', windowsHide: true });

  pids.push(child.pid!);

  return { pid: child.pid!, exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
}

async function record(home: string, notPid?: number): Promise<HolderRecord> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (existsSync(recordPath(home))) {
      const found = parseHolderRecord(readFileSync(recordPath(home), 'utf8'));

      if (found !== null && found.pid !== notPid) {
        return found;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('The holder wrote no record.');
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const nodeProgram = (code: string) => ({ file: process.execPath, args: ['-e', code], cwd: tmpdir(), env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), cols: 80, rows: 24 });

describe('built holder', () => {
  it('writes a record a client can connect with, and refuses a second holder for the same home', async () => {
    const home = newHome();
    const first = startHolder(home);
    const found = await record(home);

    expect(found).toMatchObject({ protocol: 1, build: 'test-build', pid: first.pid });
    expect(found.token).toMatch(/^[0-9a-f]{64}$/);

    const second = startHolder(home);

    expect(await second.exited).toBe(0);
    expect(parseHolderRecord(readFileSync(recordPath(home), 'utf8'))?.pid).toBe(first.pid);

    const client = await HolderClient.connect({ port: found.port, token: found.token });

    expect(client.welcome).toEqual({ protocol: 1, build: 'test-build', pid: first.pid, features: ['snapshot', 'write'] });
    client.close();
  }, 30_000);

  it('runs a program in a real pseudo-terminal that outlives the client, kills its tree, and shuts down once none is live', async () => {
    const home = newHome();
    const holder = startHolder(home);
    const found = await record(home);
    let client = await HolderClient.connect({ port: found.port, token: found.token });
    const program = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write('ready ' + process.stdout.columns + 'x' + process.stdout.rows + ' child=' + c.pid + '\\n'); setInterval(() => {}, 1000);";
    const { pid } = await client.spawn({ session: 's1', label: 'item 1', ...nodeProgram(program) });

    await until(async () => /ready 80x24 child=\d+/.test((await client.screen('s1')).head), 'the program output');

    const child = Number(/child=(\d+)/.exec((await client.screen('s1')).head)![1]);

    pids.push(child);
    expect(alive(child)).toBe(true);
    client.close();
    client = await HolderClient.connect({ port: found.port, token: found.token });
    expect((await client.list()).map((entry) => [entry.session, entry.pid, entry.exitedAt])).toEqual([['s1', pid, null]]);
    await expect(client.shutdown()).rejects.toThrow('The terminal holder holds 1 live session.');
    expect(await client.kill('s1')).not.toBeUndefined();
    expect(alive(pid)).toBe(false);
    await until(() => !alive(child), 'the child to end', 5_000);
    await client.shutdown();
    expect(await holder.exited).toBe(0);
    expect(existsSync(recordPath(home))).toBe(false);
  }, 60_000);

  it('ends a program by closing its terminal, so its hang-up handler runs, before any tree kill', async () => {
    const home = newHome();
    const holder = startHolder(home);
    const found = await record(home);
    const client = await HolderClient.connect({ port: found.port, token: found.token });
    const marker = join(home, 'hangup.txt');
    // Node.js reports a closed console on Windows, and a hang-up elsewhere, as SIGHUP.
    const program = `process.on('SIGHUP', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'hangup'); process.exit(7); }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
    const { pid } = await client.spawn({ session: 's1', label: 'item 1', ...nodeProgram(program) });

    pids.push(pid);
    await until(async () => (await client.screen('s1')).head.includes('ready'), 'the program output');
    expect(await client.kill('s1')).toBe(7);
    expect(readFileSync(marker, 'utf8')).toBe('hangup');
    client.close();
    forceKill(holder.pid);
  }, 30_000);

  it('exits by itself after the idle time with no live session, whatever clients are connected', async () => {
    const home = newHome();
    const holder = startHolder(home, ['--idle-exit-ms=1500']);
    const found = await record(home);
    const client = await HolderClient.connect({ port: found.port, token: found.token });

    await client.watch(() => undefined);
    expect(await holder.exited).toBe(0);
    expect(existsSync(recordPath(home))).toBe(false);
  }, 30_000);

  it('stays up past the idle time while a session is live, and exits that long after its last one ends', async () => {
    const home = newHome();
    const holder = startHolder(home, ['--idle-exit-ms=1500']);
    const found = await record(home);
    const client = await HolderClient.connect({ port: found.port, token: found.token });

    await client.spawn({ session: 's1', label: 'item 1', ...nodeProgram('setInterval(() => {}, 1000)') });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(alive(holder.pid)).toBe(true);
    await client.kill('s1');

    const killedAt = Date.now();

    expect(await holder.exited).toBe(0);
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(1400);
  }, 30_000);

  it('lets a new holder take over after a forced exit left the record behind', async () => {
    const home = newHome();
    const first = startHolder(home);

    await record(home);
    forceKill(first.pid);
    await first.exited;
    expect(existsSync(recordPath(home))).toBe(true);

    const second = startHolder(home);
    const found = await record(home, first.pid);

    expect(found.pid).toBe(second.pid);
  }, 30_000);
});
