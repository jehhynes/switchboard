import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { hubRecordPath, parseHubRecord, Store, switchboardHome } from '@switchboard/core';
import type { Card } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openEvents } from '../src/client.js';
import { findHub } from '../src/discover.js';
import { buildOf } from '../src/bundle.js';
import { call } from '../src/http.js';
import { holdLock, releaseLock } from '../src/lock.js';
import { PageAccess } from '../src/page.js';
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
    // The dock starts a hub with the runtime this one runs under (PRD R71).
    expect(record.execPath).toBe(process.execPath);
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

  it('builds the views once for a burst of changes', async () => {
    let change = () => {};
    let built = 0;
    const app: HubApp = { post: {}, snapshot: () => ++built, dock: () => ({}), snoozedUrls: () => [], cards: () => [], snoozeUrl: () => null, unsnoozeUrl: () => null, onChange: (listener) => (change = listener), busy: () => false, close: () => {} };
    const hub = served(await serve({ app: async () => app, browserPort: null }));
    const states: string[] = [];
    const stream = await openEvents(hub.record, () => {}, undefined, (event, data) => event === 'state' && states.push(data));

    await until(() => (states.length === 1 ? true : null));
    change();
    change();
    change();
    await until(() => (states.length === 2 ? true : null));
    await new Promise((done) => setTimeout(done, 50));

    expect(states).toEqual(['1', '2']);
    stream!.close();
  });

  describe('browser endpoint', () => {
    const cards: Card[] = [{ url: 'https://github.com/o/r/issues/2', playbook: 'dev:qa-failure', group: 'blocked', snoozed: false }];
    const app = (urls: string[], snoozeUrl: HubApp['snoozeUrl'] = () => null, unsnoozeUrl: HubApp['unsnoozeUrl'] = () => null): HubApp => ({ post: {}, snapshot: () => ({}), dock: () => ({}), snoozedUrls: () => urls, cards: () => cards, snoozeUrl, unsnoozeUrl, onChange: () => {}, busy: () => false, close: () => {} });

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
        cards: [{ url: 'https://github.com/o/r/issues/2', playbook: 'dev:qa-failure', group: 'blocked', snoozed: false }],
      });

      await hub.stop('test');
      expect(await call(browserPort, 'GET', '/snoozed', null, 500)).toBeNull();
    });

    it('passes a snooze and an unsnooze from the browser port to the app (PRD R66)', async () => {
      const browserPort = await freePort();
      const calls: unknown[][] = [];
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

      served(await serve({ browserPort, app: async () => app([], (url, until) => (calls.push(['snooze', url, until]), { refused: null }), (url) => (calls.push(['unsnooze', url]), { refused: null })) }));

      expect(await post('/snooze', { url: 'https://github.com/o/r/issues/1', until: null })).toBe(200);
      expect(await post('/unsnooze', { url: 'https://github.com/o/r/issues/1' })).toBe(200);
      expect(calls).toEqual([
        ['snooze', 'https://github.com/o/r/issues/1', null],
        ['unsnooze', 'https://github.com/o/r/issues/1'],
      ]);
    });

    it("serves the web page on the app's web.port unless the options name another port, and stops serving it when stopped", async () => {
      const pagePort = await freePort();
      const log = vi.fn();
      const store = Store.open(':memory:');
      const page = { access: new PageAccess(store), asset: () => null, opened: () => 'p', isPage: () => false, list: () => [], files: async () => null, artifact: () => null, upload: () => ({ status: 403, body: {} }) };
      const hub = served(await serve({ browserPort: null, log, app: async () => ({ ...app([]), page, pagePort: () => pagePort }) }));

      await until(() => (log.mock.calls.some(([line]) => line === `web page on http://127.0.0.1:${pagePort}/page/`) ? true : null));
      expect((await call(pagePort, 'GET', '/page/', null))?.status).toBe(401);
      await hub.stop('test');
      expect(await call(pagePort, 'GET', '/page/', null, 500)).toBeNull();

      const other = served(await serve({ browserPort: null, log, pagePort: 0, app: async () => ({ ...app([]), page, pagePort: () => pagePort }) }));

      await new Promise((done) => setTimeout(done, 100));
      expect(await call(pagePort, 'GET', '/page/', null, 500)).toBeNull();
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
  const app = (quiet: () => string | null): HubApp => ({ post: {}, snapshot: () => ({}), dock: () => ({}), snoozedUrls: () => [], cards: () => [], snoozeUrl: () => null, unsnoozeUrl: () => null, onChange: () => {}, busy: () => false, quiet, close: () => {} });

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
            return { cancel: () => cancelled.push('cancel') };
          },
        },
      }),
    );
    writeFileSync(bundle, 'the new build');
    await until(() => (cancelled.length > 0 ? true : null));

    expect(lines.filter((line) => line.startsWith('stopping') || line.startsWith('hub restart'))).toEqual(['stopping: a client asked it to stop', `hub restart onto build ${buildOf(bundle)} waits: the hub is stopping`]);
  });

  it('waits while a request is answered or the app is busy, then hands its lock, port and record to the successor and exits', async () => {
    const bundle = join(switchboardHome(home), 'hub.js');
    const lines: string[] = [];
    const exit = vi.fn();
    let busy: string | null = 'a session is starting';
    let release: () => void = () => {};
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
            return { cancel: () => {} };
          },
        },
      }),
    );

    writeFileSync(bundle, 'the new build');
    await until(() => (lines.some((line) => line.includes('waits: a session is starting')) ? true : null));

    const slow = call(old.record.port, 'POST', '/slow', old.record.token, 5000, {});

    busy = null;
    await until(() => (lines.some((line) => line.includes('waits: a request is being answered')) ? true : null));
    expect(successor).toBeNull();

    release();
    expect((await slow)?.status).toBe(200);
    await until(() => (exit.mock.calls.length > 0 ? true : null));

    const taken = served(await successor!);

    expect(exit).toHaveBeenCalledWith(0);
    expect(recordOnDisk()).toEqual(taken.record);
    expect(taken.record.build).toBe('b2');
    expect(await call(old.record.port, 'GET', '/hub', null, 300)).toBeNull();
    expect(lines.filter((line) => line.startsWith('restarting the hub') || line.startsWith('hub restart:') || line.startsWith('stopping'))).toEqual([
      `restarting the hub from build b1 onto build ${buildOf(bundle)}, which is installed`,
      'stopping: restarting onto the installed build',
      `hub restart: pid ${process.pid} took over with build b2`,
    ]);
  });
});
