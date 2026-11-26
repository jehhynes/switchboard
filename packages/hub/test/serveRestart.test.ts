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
import { home, running, serve, served, recordOnDisk } from './serveFixtures.js';

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

    expect(lines.filter((line) => line.startsWith('hub: stopping') || line.startsWith('hub: restart '))).toEqual(['hub: stopping: a client asked it to stop', `hub: restart onto build ${buildOf(bundle)} waits: the hub is stopping`]);
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
    expect(lines.filter((line) => line.startsWith('hub: restarting') || line.startsWith('hub: pid') || line.startsWith('hub: stopping'))).toEqual([
      `hub: restarting from build b1 onto build ${buildOf(bundle)} (it is installed)`,
      'hub: stopping: restarting onto the installed build',
      `hub: pid ${process.pid} took over with build b2`,
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
    await until(() => (lines.some((line) => line.startsWith('hub: restart failed')) ? true : null));
    expect(lines.find((line) => line.startsWith('hub: restart failed'))).toMatch(/^hub: restart failed: the handover could not be written: .+; this hub keeps running$/);
    expect([exit.mock.calls.length, handedOver.mock.calls.length, cancel.mock.calls.length]).toEqual([0, 0, 1]);
    expect(lines.some((line) => line.startsWith('hub: stopping'))).toBe(false);
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
