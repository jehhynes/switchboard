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

let home: string;
let remove: () => void;
const running: Served[] = [];
/** Listeners a test started, closed after it. */
const listeners: HttpServer[] = [];

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
function pageApp(overrides: Partial<HubApp> = {}): HubApp {
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
async function openPageStream(record: { port: number; token: string }): Promise<{ close(): void } | null> {
  const link = new URL(JSON.parse((await call(record.port, 'POST', '/page/link', record.token))!.body).url);
  const signIn = await new Promise<string>((resolve) => request({ host: '127.0.0.1', port: record.port, path: `${link.pathname}${link.search}` }, (response) => (response.resume(), resolve(String(response.headers['set-cookie']).split(';')[0]!))).end());

  return openStream(record.port, '/v1/conversation/events?page=1', { Cookie: signIn });
}

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

/** A record of a hub that no longer answers: its port is this test's listener, which answers as something other than a hub. */
async function writeStale(): Promise<void> {
  const other = createHttpServer((_request, response) => response.writeHead(404).end('not a hub'));

  await new Promise<void>((done) => other.listen(0, '127.0.0.1', done));
  listeners.push(other);
  mkdirSync(switchboardHome(home), { recursive: true });
  writeFileSync(
    hubRecordPath(home),
    JSON.stringify({ protocol: 1, version: '0.0.1', build: 'old', port: (other.address() as { port: number }).port, token: 'stale', pid: 1, startedAt: '2026-01-01T00:00:00.000Z' }),
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
    // The record names the runtime the hub runs under.
    expect(record.execPath).toBe(process.execPath);
    expect(await findHub(home)).toEqual(record);
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
      expect(log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^browser endpoint not served on 127\\.0\\.0\\.1:${browserPort}: .*EADDRINUSE`)));
      await new Promise((done) => holder.close(done));
    });
  });
});

describe('serveHub restart onto a new build', () => {
  const app = (quiet: () => string | null): HubApp => ({ post: {}, snapshot: () => ({}), snoozedUrls: () => [], cards: () => [], snoozeUrl: () => null, unsnoozeUrl: () => null, busy: () => false, quiet, close: () => {} });

  it('lets a successor wait for the lock of the hub it takes over from, and take its record once that hub stops', async () => {
    const first = served(await serve());
    // In one process both hubs have this pid, which the successor takes for the hub it replaces.
    const second = serve({ takeover: process.pid });

    await new Promise((done) => setTimeout(done, 300));
    expect(recordOnDisk()?.token).toBe(first.record.token);

    await first.stop('test');

    const taken = served(await second);

    expect(recordOnDisk()).toEqual(taken.record);
  });

  it('stands a successor down when another hub took the lock, and refuses when the lock is not handed over in time', async () => {
    const first = served(await serve());

    expect(await serve({ takeover: 1 })).toEqual({ existing: first.record });

    mkdirSync(switchboardHome(home), { recursive: true });
    await first.stop('test');

    const lock = await holdLock(home);

    try {
      expect(await serve({ takeover: 1, restart: { bundle: join(home, 'none.js'), successor: async () => ({ error: 'unused' }), takeoverWaitMs: 200 } })).toEqual({ refused: 'the hub (pid 1) did not hand over the hub lock within 0.2 seconds' });
    } finally {
      await releaseLock(lock!);
    }
  });

  it('ends the successor instead of handing over when the hub was asked to stop while the successor loaded', async () => {
    const lines: string[] = [];
    const cancelled: string[] = [];
    const bundle = join(switchboardHome(home), 'hub.js');
    let hub: Served | null = null;

    mkdirSync(switchboardHome(home), { recursive: true });
    hub = served(
      await serve({
        log: (line) => lines.push(line),
        browserPort: null,
        app: async () => app(() => null),
        restart: {
          bundle,
          checkMs: 20,
          successor: async () => {
            await hub!.stop('a client asked it to stop');
            return { pid: process.pid, cancel: () => cancelled.push('cancel') };
          },
        },
      }),
    );
    writeFileSync(bundle, 'the new build');
    await until(() => (cancelled.length > 0 ? true : null));

    expect(lines.filter((line) => line.startsWith('stopping') || line.startsWith('hub restart'))).toEqual(['stopping: a client asked it to stop', `hub restart onto build ${buildOf(bundle)} waits: the hub is stopping`]);
  });

  it('makes a hub started during a handover wait for the successor the handover names, rather than take the lock first', async () => {
    mkdirSync(switchboardHome(home), { recursive: true });
    writeHandover(home, process.pid);

    // In one process the successor has this pid too.
    const window = serve({ browserPort: null });

    await new Promise((done) => setTimeout(done, 200));
    expect(recordOnDisk()).toBeNull();

    const successor = served(await serve({ takeover: 1, browserPort: null }));

    expect(await window).toEqual({ existing: successor.record });
    expect(existsSync(handoverPath(home))).toBe(false);
  });

  it('starts at once over a handover whose successor no longer runs', async () => {
    mkdirSync(switchboardHome(home), { recursive: true });

    // A successor that died leaves a handover naming a pid that no longer runs, which a start ignores.
    writeFileSync(handoverPath(home), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));

    const started = Date.now();

    served(await serve({ browserPort: null }));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('waits while a request is answered or the app is busy, then hands its lock, port and record to the successor and exits', async () => {
    const bundle = join(switchboardHome(home), 'hub.js');
    const lines: string[] = [];
    const exit = vi.fn();
    let busy: string | null = 'a session is starting';
    let release: (() => void) | null = null;
    let successor: Promise<ServeResult> | null = null;

    mkdirSync(switchboardHome(home), { recursive: true });

    const old = served(
      await serve({
        log: (line) => lines.push(line),
        exit,
        browserPort: null,
        app: async () => ({ ...app(() => busy), post: { '/slow': () => new Promise((done) => (release = () => done({ status: 200, body: {} }))) } }),
        restart: {
          bundle,
          checkMs: 20,
          successor: async () => {
            successor = serve({ build: 'b2', takeover: process.pid, browserPort: null, app: async () => app(() => null) });
            return { pid: process.pid, cancel: () => {} };
          },
        },
      }),
    );

    writeFileSync(bundle, 'the new build');
    await until(() => (lines.some((line) => line.includes('waits: a session is starting')) ? true : null));

    const slow = call(old.record.port, 'POST', '/slow', old.record.token, 5000, {});

    // The request is being answered before the app stops being busy, or the hub could hand over in between.
    await until(() => (release !== null ? true : null));
    busy = null;
    await until(() => (lines.some((line) => line.includes('waits: a request is being answered')) ? true : null));
    expect(successor).toBeNull();

    release!();
    expect((await slow)?.status).toBe(200);
    await until(() => (exit.mock.calls.length > 0 ? true : null));

    const taken = served(await successor!);

    expect(exit).toHaveBeenCalledWith(0);
    expect(recordOnDisk()).toEqual(taken.record);
    expect(taken.record.build).toBe('b2');
    expect(old.record.restarts).toBe(true);
    expect(taken.record.restarts).toBeUndefined();
    expect(await call(old.record.port, 'GET', '/hub', null, 300)).toBeNull();
    expect(lines.filter((line) => line.startsWith('restarting the hub') || line.startsWith('hub restart:') || line.startsWith('stopping'))).toEqual([
      `restarting the hub from build b1 onto build ${buildOf(bundle)}, which is installed`,
      'stopping: restarting onto the installed build',
      `hub restart: pid ${process.pid} took over with build b2`,
    ]);
  });

  it('records no deliberate stop when it stops to hand over, so the supervisor waits for the successor', async () => {
    const bundle = join(switchboardHome(home), 'hub.js');
    const exit = vi.fn();

    mkdirSync(switchboardHome(home), { recursive: true });
    served(await serve({ exit, browserPort: null, app: async () => app(() => null), restart: { bundle, checkMs: 20, successor: async () => ({ pid: process.pid, cancel: () => {} }) } }));
    writeFileSync(bundle, 'the new build');
    // The old hub has stopped and removed its record; the successor has not started yet.
    await until(() => (recordOnDisk() === null ? true : null));
    expect(readStopped(home)).toBeNull();

    served(await serve({ build: 'b2', takeover: process.pid, browserPort: null }));
    await until(() => (exit.mock.calls.length > 0 ? true : null));
    expect(readStopped(home)).toBeNull();
  });

  it('keeps running, its app untouched, when the handover cannot be written', async () => {
    const bundle = join(switchboardHome(home), 'hub.js');
    const exit = vi.fn();
    const lines: string[] = [];
    const handedOver = vi.fn();
    const cancel = vi.fn();

    mkdirSync(switchboardHome(home), { recursive: true });
    served(
      await serve({
        exit,
        log: (line) => lines.push(line),
        browserPort: null,
        // A value JSON cannot write.
        app: async () => ({ ...app(() => null), handover: () => ({ voice: 1n }), handedOver }),
        restart: { bundle, checkMs: 20, successor: async () => ({ pid: process.pid, cancel }) },
      }),
    );
    writeFileSync(bundle, 'the new build');
    await until(() => (lines.some((line) => line.startsWith('hub restart failed')) ? true : null));
    expect(lines.find((line) => line.startsWith('hub restart failed'))).toMatch(/^hub restart failed: the handover could not be written: .+; this hub keeps running$/);
    expect([exit.mock.calls.length, handedOver.mock.calls.length, cancel.mock.calls.length]).toEqual([0, 0, 1]);
    expect(lines.some((line) => line.startsWith('stopping'))).toBe(false);
  });

  it('carries what the app hands over to the successor\'s app, which a hub started anew never gets', async () => {
    const bundle = join(switchboardHome(home), 'hub.js');
    const exit = vi.fn();
    const handed: string[] = [];
    let carried: unknown = 'not built';
    let successor: Promise<ServeResult> | null = null;

    mkdirSync(switchboardHome(home), { recursive: true });

    const fresh: unknown[] = [];

    served(
      await serve({
        exit,
        browserPort: null,
        app: async (given) => {
          fresh.push(given);
          return { ...app(() => null), handover: () => (handed.push('handed'), { voice: { device: 'phone', phoneHash: 'h' } }), handedOver: () => void handed.push('let go') };
        },
        restart: {
          bundle,
          checkMs: 20,
          successor: async () => {
            successor = serve({
              build: 'b2',
              takeover: process.pid,
              browserPort: null,
              app: async (given) => {
                carried = given;
                return app(() => null);
              },
            });
            return { pid: process.pid, cancel: () => {} };
          },
        },
      }),
    );

    expect(fresh).toEqual([null]);
    writeFileSync(bundle, 'the new build');
    await until(() => (exit.mock.calls.length > 0 ? true : null));
    served(await successor!);
    expect(handed).toEqual(['handed', 'let go']);
    expect(carried).toEqual({ voice: { device: 'phone', phoneHash: 'h' } });
    expect(existsSync(handoverPath(home))).toBe(false);
  });
});
