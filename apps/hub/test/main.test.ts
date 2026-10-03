import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubRecordPath, parseHubRecord, switchboardHome } from '@switchboard/core';
import { holdLock, releaseLock } from '@switchboard/hub';
import type { HubRecord } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const main = join(import.meta.dirname, '..', 'dist', 'main.js');

let home: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchboard-app-'));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill();
  }

  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

function start(...args: string[]): { child: ChildProcess; exited: Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }> } {
  const child = spawn(process.execPath, [main, `--home=${home}`, ...args], { windowsHide: true });
  let stdout = '';
  let stderr = '';

  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  children.push(child);

  return { child, exited: new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr, pid: child.pid }))) };
}

function record(): HubRecord | null {
  try {
    return parseHubRecord(readFileSync(hubRecordPath(home), 'utf8'));
  } catch {
    return null;
  }
}

async function recorded(): Promise<HubRecord> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
    const found = record();

    if (found !== null) {
      return found;
    }

    await new Promise((done) => setTimeout(done, 50));
  }

  throw new Error('no hub.json was written');
}

function status(found: HubRecord): Promise<number> {
  return new Promise((resolve) => {
    const outbound = request(
      { host: '127.0.0.1', port: found.port, path: '/status', headers: { Authorization: `Bearer ${found.token}` } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );

    outbound.on('error', () => resolve(0));
    outbound.end();
  });
}

describe('hub entry point', () => {
  it('serves, refuses a second hub, and stops on --stop', async () => {
    const first = start('--idle-ms=60000');
    const found = await recorded();

    expect(found.pid).toBe(first.child.pid);
    expect(await status(found)).toBe(200);

    const second = await start().exited;

    expect(second.code).toBe(0);
    expect(second.stdout).toBe(`A hub is already running for this home on port ${found.port}; pid ${second.pid} exiting.\n`);

    const stop = await start('--stop').exited;

    expect(stop.stdout).toBe('Stopped the hub.\n');
    expect((await first.exited).code).toBe(0);
    expect(record()).toBeNull();
  });

  it('reports when there is no hub to stop', async () => {
    const stop = await start('--stop').exited;

    expect(stop.code).toBe(0);
    expect(stop.stdout).toBe('No hub is running for this home.\n');
  });

  it('exits 1 when another process holds the lock and no hub answers', async () => {
    mkdirSync(switchboardHome(home), { recursive: true });

    const lock = await holdLock(home);

    try {
      const refused = await start().exited;

      expect(refused.code).toBe(1);
      expect(refused.stderr).toBe(`Not starting: another process holds the hub lock but no hub answers; pid ${refused.pid} exiting.\n`);
      expect(record()).toBeNull();
    } finally {
      await releaseLock(lock!);
    }
  });

  it('exits after the idle time with no client and removes its record', async () => {
    const hub = start('--idle-ms=200');

    await recorded();

    expect((await hub.exited).code).toBe(0);
    expect(record()).toBeNull();
  });
});
