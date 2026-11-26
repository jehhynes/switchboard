import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createHttpServer, request } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';
import { hubRecordPath, parseHubRecord, Store, switchboardHome } from '@switchboard/core';
import type { Card } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findHub } from '../src/discover.js';
import { buildOf } from '../src/bundle.js';
import { call } from '../src/http.js';
import { holdLock, releaseLock } from '../src/lock.js';
import { PageAccess } from '../src/page.js';
import { handoverPath, writeHandover } from '../src/restart.js';
import { serveHub } from '../src/serve.js';
import { readStopped } from '../src/supervise.js';
import type { HubApp, ServeResult, ServeOptions, Served } from '../src/serve.js';
import { openStream, tempHome, until } from './helpers.js';

export let home: string;
export let remove: () => void;
export const running: Served[] = [];
/** Listeners a test started, closed after it. */
export const listeners: HttpServer[] = [];

beforeEach(() => {
  ({ home, remove } = tempHome());
});

afterEach(async () => {
  for (const served of running.splice(0)) {
    await served.stop('test ended');
  }

  for (const listener of listeners.splice(0)) {
    listener.closeAllConnections();
    await new Promise((done) => listener.close(done));
  }

  remove();
});

/** An app with the web page, whose one page key is `key-1`. */
export function pageApp(overrides: Partial<HubApp> = {}): HubApp {
  return {
    post: {},
    snapshot: () => ({}),
    snoozedUrls: () => [],
    cards: () => [],
    snoozeUrl: () => null,
    unsnoozeUrl: () => null,
    busy: () => false,
    page: { access: new PageAccess(Store.open(':memory:')), asset: () => null, opened: () => 'key-1', isPage: (key) => key === 'key-1', list: () => [], files: async () => null, artifact: () => null, upload: () => ({ status: 403, body: {} }) },
    conversation: (_key, write) => {
      write('event: hello\ndata: {}\n\n');
      return { close: () => {} };
    },
    close: () => {},
    ...overrides,
  };
}

/** Signs in to the hub's page with a one-time link and opens a page's conversation stream with the cookie. */
export async function openPageStream(record: { port: number; token: string }): Promise<{ close(): void } | null> {
  const link = new URL(JSON.parse((await call(record.port, 'POST', '/page/link', record.token))!.body).url);
  const signIn = await new Promise<string>((resolve) => request({ host: '127.0.0.1', port: record.port, path: `${link.pathname}${link.search}` }, (response) => (response.resume(), resolve(String(response.headers['set-cookie']).split(';')[0]!))).end());

  return openStream(record.port, '/v1/conversation/events?page=1', { Cookie: signIn });
}

export async function serve(options: Partial<ServeOptions> = {}): Promise<ServeResult> {
  const result = await serveHub({ home, version: '0.1.0', build: 'b1', configDir: 'C:/cfg', log: () => {}, exit: vi.fn(), ...options });

  if ('served' in result) {
    running.push(result.served);
  }

  return result;
}

export function served(result: ServeResult): Served {
  if (!('served' in result)) {
    throw new Error('expected a served hub');
  }

  return result.served;
}

/** A record of a hub that no longer answers: its port is this test's listener, which answers as something other than a hub. */
export async function writeStale(): Promise<void> {
  const other = createHttpServer((_request, response) => response.writeHead(404).end('not a hub'));

  await new Promise<void>((done) => other.listen(0, '127.0.0.1', done));
  listeners.push(other);
  mkdirSync(switchboardHome(home), { recursive: true });
  writeFileSync(
    hubRecordPath(home),
    JSON.stringify({ protocol: 1, version: '0.0.1', build: 'old', port: (other.address() as { port: number }).port, token: 'stale', pid: 1, startedAt: '2026-01-01T00:00:00.000Z' }),
  );
}

export function recordOnDisk() {
  try {
    return parseHubRecord(readFileSync(hubRecordPath(home), 'utf8'));
  } catch {
    return null;
  }
}
