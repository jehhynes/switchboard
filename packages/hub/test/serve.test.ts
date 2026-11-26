import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { home, running, pageApp, openPageStream, serve, served, writeStale, recordOnDisk } from './serveFixtures.js';

describe('serveHub', () => {
  it('writes a record that findHub accepts', async () => {
    const { record } = served(await serve());

    expect(recordOnDisk()).toEqual(record);
    expect(record.pid).toBe(process.pid);
    expect(record.version).toBe('0.1.0');
    expect(record.build).toBe('b1');
    expect(record.configDir).toBe('C:/cfg');
    // The record names the runtime the hub runs under.
    expect(record.execPath).toBe(process.execPath);
    expect(await findHub(home)).toEqual(record);
  });

  it.runIf(process.platform !== 'win32')('writes the record, which holds the hub token, readable only by its user', async () => {
    // A record an older hub left readable, and a temporary file of this process ID left by a crash.
    mkdirSync(dirname(hubRecordPath(home)), { recursive: true });
    writeFileSync(hubRecordPath(home), '{}', { mode: 0o644 });
    writeFileSync(`${hubRecordPath(home)}.${process.pid}.tmp`, '{}', { mode: 0o644 });
    served(await serve());

    expect(statSync(hubRecordPath(home)).mode & 0o777).toBe(0o600);
  });

  it('reports the existing hub instead of starting a second', async () => {
    const first = served(await serve());

    expect(await serve()).toEqual({ existing: first.record });
    expect(running).toHaveLength(1);
  });

  it('replaces a record whose hub no longer answers', async () => {
    await writeStale();

    const { record } = served(await serve());

    expect(recordOnDisk()?.token).toBe(record.token);
  });

  it('leaves exactly one hub when several start at once over a stale record', async () => {
    await writeStale();

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

  it('ends the streams before it closes the app, so their close handlers can still read the store', async () => {
    const events: string[] = [];
    let closed = false;
    const app = pageApp({
      windowClosed: (key) => {
        if (closed) {
          throw new Error('database is not open');
        }

        events.push(`closed ${key}`);
      },
      close: () => {
        closed = true;
        events.push('app closed');
      },
    });
    const hub = served(await serve({ app: async () => app, browserPort: null }));
    const stream = await openPageStream(hub.record);

    expect(stream).not.toBeNull();
    await hub.stop('test');

    expect(events).toEqual(['closed key-1', 'app closed']);
  });

  it('refuses new requests once stopping and closes the app only after the requests it is answering', async () => {
    const events: string[] = [];
    let release: (() => void) | null = null;
    const app: HubApp = { post: { '/slow': () => new Promise((done) => (release = () => (events.push('answered'), done({ status: 200, body: {} })))), '/fast': async () => ({ status: 200, body: {} }) }, snapshot: () => ({}), snoozedUrls: () => [], cards: () => [], snoozeUrl: () => null, unsnoozeUrl: () => null, busy: () => false, close: () => void events.push('app closed') };
    const hub = served(await serve({ app: async () => app, browserPort: null }));
    const slow = call(hub.record.port, 'POST', '/slow', hub.record.token, 5000, {});

    await until(() => (release !== null ? true : null));

    const stopped = hub.stop('a client asked it to stop');
    const refused = await call(hub.record.port, 'POST', '/fast', hub.record.token, 2000, {});

    expect(refused?.status).toBe(503);
    expect(JSON.parse(refused!.body)).toEqual({ error: 'The hub is stopping: a client asked it to stop.' });
    expect(events).toEqual([]);

    release!();
    expect((await slow)?.status).toBe(200);
    await stopped;
    expect(events).toEqual(['answered', 'app closed']);
  });

  it('removes its record and stops listening when stopped', async () => {
    const hub = served(await serve());

    await hub.stop('test');

    expect(recordOnDisk()).toBeNull();
    expect(await call(hub.record.port, 'GET', '/hub', null, 300)).toBeNull();
  });

  it('records a deliberate stop with its reason for the supervisor, which the next hub to take the lock clears', async () => {
    const hub = served(await serve());

    expect(readStopped(home)).toBeNull();
    await hub.stop('a client asked it to stop');
    expect(readStopped(home)).toMatchObject({ pid: process.pid, reason: 'a client asked it to stop' });

    served(await serve());
    expect(readStopped(home)).toBeNull();
  });

  it('clears a deliberate stop as soon as it holds the lock, so a hub that fails while starting counts as a crash', async () => {
    await served(await serve()).stop('a client asked it to stop');
    expect(readStopped(home)).not.toBeNull();
    await expect(serve({ app: async () => Promise.reject(new Error('the store did not open')) })).rejects.toThrow('the store did not open');
    expect(readStopped(home)).toBeNull();
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

  it('keeps running with no client when no idle time is given', async () => {
    // Only the interval clock is faked, so the hub's sockets and lock work as usual.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

    try {
      const exit = vi.fn();

      served(await serve({ exit }));
      vi.advanceTimersByTime(24 * 60 * 60_000);

      expect(exit).not.toHaveBeenCalled();
      expect(recordOnDisk()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits after the idle time with no client', async () => {
    const exit = vi.fn();

    await serve({ idleMs: 100, exit });
    await until(() => (exit.mock.calls.length > 0 ? true : null));

    expect(exit).toHaveBeenCalledWith(0);
    expect(recordOnDisk()).toBeNull();
  });

  it('stays up while a page is connected', async () => {
    const exit = vi.fn();
    // Long enough for the page to sign in and connect on a loaded machine; the window below is twice as long.
    const hub = served(await serve({ idleMs: 500, exit, app: async () => pageApp(), browserPort: null }));
    const stream = await openPageStream(hub.record);

    expect(stream).not.toBeNull();
    await new Promise((done) => setTimeout(done, 1_000));
    expect(exit).not.toHaveBeenCalled();

    stream!.close();
    await until(() => (exit.mock.calls.length > 0 ? true : null));
    expect(exit).toHaveBeenCalledWith(0);
  });

  describe('browser endpoint', () => {
    const cards: Card[] = [{ url: 'https://github.com/o/r/issues/2', playbook: 'dev:qa-failure', group: 'blocked', snoozed: false }];
    const app = (urls: string[], snoozeUrl: HubApp['snoozeUrl'] = () => null, unsnoozeUrl: HubApp['unsnoozeUrl'] = () => null): HubApp => ({ post: {}, snapshot: () => ({}), snoozedUrls: () => urls, cards: () => cards, snoozeUrl, unsnoozeUrl, busy: () => false, close: () => {} });

    async function freePort(): Promise<number> {
      const probe = createServer();

      await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));

      const port = (probe.address() as { port: number }).port;

      await new Promise((done) => probe.close(done));

      return port;
    }

    /**
     * Serves a hub on a port the system just gave out, and on another when something took it before the hub bound it, which the hub logs
     * as `not served`. `served` is the line the hub logs once it listens there, or null where it binds before `serve` resolves.
     */
    async function onFreePort(start: (port: number, log: (line: string) => void) => Promise<Served>, served: ((port: number) => string) | null): Promise<{ port: number; hub: Served }> {
      for (let attempt = 1; ; attempt++) {
        const port = await freePort();
        const lines: string[] = [];
        const hub = await start(port, (line) => lines.push(line));
        const taken = (line: string) => line.includes(` not served on 127.0.0.1:${port}:`);
        const outcome = served === null ? (lines.find(taken) ?? 'served') : await until(() => lines.find((line) => line === served(port) || taken(line)) ?? null);

        if (!taken(outcome)) {
          return { port, hub };
        }

        await hub.stop('test');

        if (attempt === 3) {
          throw new Error(outcome);
        }
      }
    }

    /** Whether nothing listens on `port` now: this test binds it, which only works once the hub let it go. */
    async function released(port: number): Promise<boolean> {
      const probe = createServer();
      const bound = await new Promise<boolean>((done) => {
        probe.once('error', () => done(false));
        probe.listen(port, '127.0.0.1', () => done(true));
      });

      if (bound) {
        await new Promise((done) => probe.close(done));
      }

      return bound;
    }

    it('serves the app\'s snoozed URLs and cards on the browser port and stops serving them when stopped', async () => {
      const { port: browserPort, hub } = await onFreePort(async (port, log) => served(await serve({ browserPort: port, log, app: async () => app(['https://github.com/o/r/issues/1']) })), null);
      const reply = await call(browserPort, 'GET', '/snoozed', null);

      expect(reply?.status).toBe(200);
      expect(JSON.parse(reply!.body)).toEqual({ urls: ['https://github.com/o/r/issues/1'] });
      expect(JSON.parse((await call(browserPort, 'GET', '/cards', null))!.body)).toEqual({
        cards: [{ url: 'https://github.com/o/r/issues/2', playbook: 'dev:qa-failure', group: 'blocked', snoozed: false }],
      });

      await hub.stop('test');
      expect(await released(browserPort)).toBe(true);
    });

    it('passes a snooze and an unsnooze from the browser port to the app (PRD R66)', async () => {
      const calls: unknown[][] = [];
      const { port: browserPort } = await onFreePort(
        async (port, log) => served(await serve({ browserPort: port, log, app: async () => app([], (url, until) => (calls.push(['snooze', url, until]), { refused: null }), (url) => (calls.push(['unsnooze', url]), { refused: null })) })),
        null,
      );
      const post = (path: string, body: unknown) =>
        new Promise<number>((resolve, reject) => {
          const headers = { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc' };
          const outbound = request({ host: '127.0.0.1', port: browserPort, method: 'POST', path, headers }, (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          });

          outbound.on('error', reject);
          outbound.end(JSON.stringify(body));
        });

      expect(await post('/snooze', { url: 'https://github.com/o/r/issues/1', until: null })).toBe(200);
      expect(await post('/unsnooze', { url: 'https://github.com/o/r/issues/1' })).toBe(200);
      expect(calls).toEqual([
        ['snooze', 'https://github.com/o/r/issues/1', null],
        ['unsnooze', 'https://github.com/o/r/issues/1'],
      ]);
    });

    it("serves the web page on the app's web.port unless the options name another port, and stops serving it when stopped", async () => {
      const store = Store.open(':memory:');
      const page = { access: new PageAccess(store), asset: () => null, opened: () => 'p', isPage: () => false, list: () => [], files: async () => null, artifact: () => null, upload: () => ({ status: 403, body: {} }) };
      const pageServed = (port: number) => `web page on http://127.0.0.1:${port}/page/`;
      const { port: pagePort, hub } = await onFreePort(async (port, log) => served(await serve({ browserPort: null, log, app: async () => ({ ...app([]), page, pagePort: () => port }) })), pageServed);

      expect((await call(pagePort, 'GET', '/page/', null))?.status).toBe(401);
      await hub.stop('test');
      expect(await released(pagePort)).toBe(true);

      // pagePort 0 in the options serves the page on the hub's port alone, so it logs no web page port.
      const log = vi.fn();
      const other = served(await serve({ browserPort: null, log, pagePort: 0, app: async () => ({ ...app([]), page, pagePort: () => pagePort }) }));

      // A listen on the app's port would log within this window.
      await new Promise((done) => setTimeout(done, 100));
      expect(log.mock.calls.filter(([line]) => String(line).startsWith('web page'))).toEqual([]);
      expect(await released(pagePort)).toBe(true);
      await other.stop('test');
    });

    it('logs a taken browser port and serves the hub anyway', async () => {
      const holder = createServer();

      await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));

      const browserPort = (holder.address() as { port: number }).port;
      const log = vi.fn();
      const hub = served(await serve({ browserPort, log, app: async () => app([]) }));

      expect(await findHub(home)).toEqual(hub.record);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^browser endpoint not served on 127\\.0\\.0\\.1:${browserPort}: .*EADDRINUSE`)), 'warn');
      await new Promise((done) => holder.close(done));
    });
  });
});
