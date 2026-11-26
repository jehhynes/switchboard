import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { hubRecordPath, parseHubRecord } from '@switchboard/core';
import type { HubRecord } from '@switchboard/core';
import { afterEach, beforeEach } from 'vitest';

export const main = join(import.meta.dirname, '..', 'dist', 'main.js');

/** The temporary home of the test that runs now. */
export let home: string;
const children: ChildProcess[] = [];

/** Gives each test a temporary home, and ends the processes it started before removing it. */
export function useTestHome(): void {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'switchboard-app-'));
  });

  afterEach(async () => {
    const running = children.splice(0).filter((child) => child.exitCode === null && child.signalCode === null);

    for (const child of running) child.kill();
    try {
      await until(() => running.every((child) => child.exitCode !== null || child.signalCode !== null) ? true : null, 5_000);
    } catch {
      throw new Error(`Test children still running: ${running.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => child.pid).join(', ')}`);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 30_000);
}

export function start(...args: string[]): { child: ChildProcess; exited: Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }> } {
  return startWith({}, ...args);
}

export function startWith(extra: Record<string, string | undefined>, ...args: string[]): { child: ChildProcess; exited: Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }> } {
  return launch(main, extra, args);
}

export function launch(entry: string, extra: Record<string, string | undefined>, args: string[]): { child: ChildProcess; exited: Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }> } {
  // CLAUDE_CONFIG_DIR and CODEX_HOME keep hook installation inside the temporary home. PATH holds only Node and Windows, so the hub runs no
  // real Claude or Codex: an orphaned Codex app-server from the hook trust exchange held <home>/.codex past the cleanup.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  const env: Record<string, string | undefined> = { ...inherited, PATH: [dirname(process.execPath), join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')].join(delimiter), CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), ...extra };

  // A variable set to undefined is removed, such as the CLAUDE_CODE_SESSION_ID of a Claude session running the tests.
  for (const key of Object.keys(extra).filter((name) => extra[name] === undefined)) {
    delete env[key];
  }

  const child = spawn(process.execPath, [entry, ...args, `--home=${home}`, ...(['report', 'register', 'attach', 'holder', 'restart', 'install', 'autostart', 'config'].includes(args[0] ?? '') ? [] : ['--browser-port=0', '--page-port=0'])], { windowsHide: true, env });
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

export function record(): HubRecord | null {
  try {
    return parseHubRecord(readFileSync(hubRecordPath(home), 'utf8'));
  } catch {
    return null;
  }
}

export async function recorded(): Promise<HubRecord> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
    const found = record();

    if (found !== null) {
      return found;
    }

    await new Promise((done) => setTimeout(done, 50));
  }

  throw new Error('no hub.json was written');
}

export function status(found: HubRecord): Promise<number> {
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

export async function until<T>(check: () => T | null, within = 10_000): Promise<T> {
  for (const deadline = Date.now() + within; Date.now() < deadline; ) {
    const found = check();

    if (found !== null) {
      return found;
    }

    await new Promise((done) => setTimeout(done, 50));
  }

  throw new Error('condition not met in time');
}

/** Stop the hub and wait for its process to release the test home. */
export async function stopAndWait(): Promise<void> {
  const pid = record()?.pid;

  await start('--stop').exited;
  if (pid === undefined) return;
  try {
    await until(() => {
      try {
        process.kill(pid, 0);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw error;
      }
    });
  } catch (error) {
    throw new Error(`Hub pid ${pid} did not exit after --stop`, { cause: error });
  }
}

/** The status a page's conversation stream answers with `cookie`, closed once its headers arrive. */
export function pageStreamStatus(found: HubRecord, cookie: string): Promise<number> {
  return new Promise((resolve) => {
    const outbound = request({ host: '127.0.0.1', port: found.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${found.port}`, Cookie: cookie } }, (response) => {
      resolve(response.statusCode ?? 0);
      outbound.destroy();
    });

    outbound.on('error', () => resolve(0));
    outbound.end();
  });
}

/** Signs a browser in to the hub's page with a one-time link, answering its cookie. */
export async function pageCookie(found: HubRecord): Promise<string> {
  const link = await new Promise<string>((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port: found.port, method: 'POST', path: '/page/link', headers: { Authorization: `Bearer ${found.token}` } }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve((JSON.parse(body) as { url: string }).url));
    });

    outbound.on('error', reject);
    outbound.end();
  });
  const url = new URL(link);

  return new Promise((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port: Number(url.port), path: `${url.pathname}${url.search}` }, (response) => {
      response.resume();
      resolve(String(response.headers['set-cookie']).split(';')[0]!);
    });

    outbound.on('error', reject);
    outbound.end();
  });
}

export function get(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port, path, headers }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve(body));
    });

    outbound.on('error', reject);
    outbound.end();
  });
}
