import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hubRecordPath, parseHubRecord, switchboardHome } from '@switchboard/core';
import type { Card } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openEvents } from '../src/client.js';
import { findHub } from '../src/discover.js';
import { call } from '../src/http.js';
import { holdLock, releaseLock } from '../src/lock.js';
import { serveHub } from '../src/serve.js';
import type { HubApp, ServeResult, ServeOptions, Served } from '../src/serve.js';
import { tempHome, until } from './helpers.js';

let home: string;
let remove: () => void;
const running: Served[] = [];

beforeEach(() => {
  ({ home, remove } = tempHome());
});

afterEach(async () => {
  for (const served of running.splice(0)) {
    await served.stop('test ended');
  }

  remove();
});

async function serve(options: Partial<ServeOptions> = {}): Promise<ServeResult> {
  const result = await serveHub({ home, version: '0.1.0', build: 'b1', configDir: 'C:/cfg', log: () => {}, exit: vi.fn(), ...options });

  if ('served' in result) {
    running.push(result.served);
  }

  return result;
}

function served(result: ServeResult): Served {
  if (!('served' in result)) {
    throw new Error('expected a served hub');
  }

  return result.served;
}

function writeStale(): void {
  mkdirSync(switchboardHome(home), { recursive: true });
  writeFileSync(
    hubRecordPath(home),
    JSON.stringify({ protocol: 1, version: '0.0.1', build: 'old', port: 1, token: 'stale', pid: 1, startedAt: '2026-01-01T00:00:00.000Z' }),
  );
}

function recordOnDisk() {
  try {
    return parseHubRecord(readFileSync(hubRecordPath(home), 'utf8'));
  } catch {
    return null;
  }
}

describe('serveHub', () => {
  it('writes a record that findHub accepts', async () => {
    const { record } = served(await serve());

    expect(recordOnDisk()).toEqual(record);
    expect(record.pid).toBe(process.pid);
    expect(record.version).toBe('0.1.0');
    expect(record.build).toBe('b1');
    expect(record.configDir).toBe('C:/cfg');
    expect(await findHub(home)).toEqual(record);
  });

  it('reports the existing hub instead of starting a second', async () => {
    const first = served(await serve());

    expect(await serve()).toEqual({ existing: first.record });
    expect(running).toHaveLength(1);
  });

  it('replaces a record whose hub no longer answers', async () => {
    writeStale();

    const { record } = served(await serve());

    expect(recordOnDisk()?.token).toBe(record.token);
  });

  it('leaves exactly one hub when several start at once over a stale record', async () => {
    writeStale();

    const results = await Promise.all([serve(), serve(), serve()]);
    const winners = results.filter((result) => 'served' in result);

    expect(winners).toHaveLength(1);

    const winner = served(winners[0]!).record;

    expect(results.filter((result) => 'existing' in result)).toEqual([{ existing: winner }, { existing: winner }]);
    expect(recordOnDisk()).toEqual(winner);
  });

  it('refuses when another process holds the lock but no hub answers', async () => {
    mkdirSync(switchboardHome(home), { recursive: true });

    const lock = await holdLock(home);

    try {
      expect(await serve({ waitMs: 200 })).toEqual({ refused: 'another process holds the hub lock but no hub answers' });
      expect(recordOnDisk()).toBeNull();
    } finally {
      await releaseLock(lock!);
    }
  });

  it('releases the lock when stopped, so a new hub can start', async () => {
    const first = served(await serve());

    await first.stop('test');

    const second = served(await serve());

    expect(second.record.token).not.toBe(first.record.token);
    expect(recordOnDisk()).toEqual(second.record);
  });

  it('removes its record and stops listening when stopped', async () => {
    const hub = served(await serve());

    await hub.stop('test');

    expect(recordOnDisk()).toBeNull();
    expect(await call(hub.record.port, 'GET', '/hub', null, 300)).toBeNull();
  });

  it('leaves another hub record in place when stopped', async () => {
    const hub = served(await serve());
    const other = { ...hub.record, token: 'another hub' };

    writeFileSync(hubRecordPath(home), JSON.stringify(other));
    await hub.stop('test');

    expect(recordOnDisk()).toEqual(other);
  });

  it('stops and exits 0 when a client asks', async () => {
    const exit = vi.fn();
    const hub = served(await serve({ exit }));

    await call(hub.record.port, 'POST', '/shutdown', hub.record.token);
    await until(() => (exit.mock.calls.length > 0 ? true : null));

    expect(exit).toHaveBeenCalledWith(0);
    expect(recordOnDisk()).toBeNull();
  });

  it('exits after the idle time with no client', async () => {
    const exit = vi.fn();

    await serve({ idleMs: 100, exit });
    await until(() => (exit.mock.calls.length > 0 ? true : null));

    expect(exit).toHaveBeenCalledWith(0);
    expect(recordOnDisk()).toBeNull();
  });

  it('stays up while a client is connected', async () => {
    const exit = vi.fn();
    const hub = served(await serve({ idleMs: 100, exit }));
    const stream = await openEvents(hub.record, () => {});

    expect(stream).not.toBeNull();
    await new Promise((done) => setTimeout(done, 400));
    expect(exit).not.toHaveBeenCalled();

    stream!.close();
    await until(() => (exit.mock.calls.length > 0 ? true : null));
    expect(exit).toHaveBeenCalledWith(0);
  });

  describe('browser endpoint', () => {
    const cards: Card[] = [{ url: 'https://github.com/o/r/issues/2', playbook: 'dev:qa-failure', group: 'needs', snoozed: false }];
    const app = (urls: string[]): HubApp => ({ post: {}, snapshot: () => ({}), snoozedUrls: () => urls, cards: () => cards, onChange: () => {}, busy: () => false, close: () => {} });

    async function freePort(): Promise<number> {
      const probe = createServer();

      await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));

      const port = (probe.address() as { port: number }).port;

      await new Promise((done) => probe.close(done));

      return port;
    }

    it('serves the app\'s snoozed URLs and cards on the browser port and stops serving them when stopped', async () => {
      const browserPort = await freePort();
      const hub = served(await serve({ browserPort, app: async () => app(['https://github.com/o/r/issues/1']) }));
      const reply = await call(browserPort, 'GET', '/snoozed', null);

      expect(reply?.status).toBe(200);
      expect(JSON.parse(reply!.body)).toEqual({ urls: ['https://github.com/o/r/issues/1'] });
      expect(JSON.parse((await call(browserPort, 'GET', '/cards', null))!.body)).toEqual({
        cards: [{ url: 'https://github.com/o/r/issues/2', playbook: 'dev:qa-failure', group: 'needs', snoozed: false }],
      });

      await hub.stop('test');
      expect(await call(browserPort, 'GET', '/snoozed', null, 500)).toBeNull();
    });

    it('logs a taken browser port and serves the hub anyway', async () => {
      const holder = createServer();

      await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));

      const browserPort = (holder.address() as { port: number }).port;
      const log = vi.fn();
      const hub = served(await serve({ browserPort, log, app: async () => app([]) }));

      expect(await findHub(home)).toEqual(hub.record);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^browser endpoint not served on 127\\.0\\.0\\.1:${browserPort}: .*EADDRINUSE`)));
      await new Promise((done) => holder.close(done));
    });
  });
});
