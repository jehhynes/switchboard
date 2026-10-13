import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
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

  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function start(...args: string[]): { child: ChildProcess; exited: Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }> } {
  // CLAUDE_CONFIG_DIR and CODEX_HOME keep hook installation inside the temporary home. PATH holds only Node and Windows, so the hub runs no
  // real Claude or Codex: an orphaned Codex app-server from the hook trust exchange held <home>/.codex past the cleanup.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  const env = { ...inherited, PATH: [dirname(process.execPath), join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')].join(delimiter), CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') };
  const child = spawn(process.execPath, [main, ...args, `--home=${home}`, ...(args[0] === 'report' ? [] : ['--browser-port=0'])], { windowsHide: true, env });
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
    expect(found.configDir).toBe(resolve(home, '.switchboard'));
    expect(await status(found)).toBe(200);

    const second = await start().exited;

    expect(second.code).toBe(0);
    expect(second.stdout).toBe(`A hub is already running for this home on port ${found.port}; pid ${second.pid} exiting.\n`);

    const stop = await start('--stop').exited;

    expect(stop.stdout).toBe('Stopped the hub.\n');
    expect((await first.exited).code).toBe(0);
    expect(record()).toBeNull();
  });

  it('creates the --config folder, and records it', async () => {
    const configDir = join(home, 'repo', 'switchboard');
    const first = start('--idle-ms=60000', `--config=${configDir}`);
    const found = await recorded();

    expect(found.configDir).toBe(resolve(configDir));
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(join(configDir, 'playbooks'))).toBe(false);

    await start('--stop').exited;
    expect((await first.exited).code).toBe(0);
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

  it('records reports through the running hub, with exit codes for usage, refusal and no hub', async () => {
    const usage = await start('report', 'stage', 's1').exited;

    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain('report stage <sessionId> <stage>');

    const noHub = await start('report', 'stage', 's1', 'Planning').exited;

    expect(noHub).toMatchObject({ code: 2, stderr: 'The Switchboard hub is not running, so the report was not recorded.\n' });

    const hub = start('--idle-ms=60000');
    await recorded();

    const refused = await start('report', 'stage', 's1', 'Planning').exited;

    expect(refused).toMatchObject({ code: 3, stderr: 'Refused: Unknown session s1.\n' });
    expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks.Stop).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).hooks.Stop).toHaveLength(1);

    await start('--stop').exited;
    expect((await hub.exited).code).toBe(0);
  });

  it('exits after the idle time with no client and removes its record', async () => {
    const hub = start('--idle-ms=200');

    await recorded();

    expect((await hub.exited).code).toBe(0);
    expect(record()).toBeNull();
  });
});
