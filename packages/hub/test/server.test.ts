import { request } from 'node:http';
import { Store } from '@switchboard/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call } from '../src/http.js';
import { PageAccess } from '../src/page.js';
import { listenHub } from '../src/server.js';
import type { HubServer, HubServerOptions } from '../src/server.js';
import { openStream, until } from './helpers.js';

const identity = { hub: 'switchboard', protocol: 1, version: '0.1.0', pid: 99 };

let server: HubServer;

afterEach(async () => {
  await server.close();
});

/** The web page's routes with a page key per stream, `key-1` first, and a conversation that `opens` counts. */
function withPage(opens: { count: number } = { count: 0 }): Pick<HubServerOptions, 'page' | 'conversation'> {
  let keys = 0;

  return {
    page: { access: new PageAccess(Store.open(':memory:')), asset: () => null, opened: () => `key-${++keys}`, isPage: (key) => key.startsWith('key-'), list: () => [], files: async () => null, artifact: () => null, upload: () => ({ status: 403, body: {} }) },
    conversation: (_key, write) => {
      opens.count++;
      write('event: hello\ndata: {}\n\n');
      return { close: () => {} };
    },
  };
}

/** Signs in to the page with a one-time link and opens a page's conversation stream; null when the hub refuses it. */
async function openPage(s: HubServer): Promise<{ close(): void } | null> {
  const link = new URL(JSON.parse((await call(s.port, 'POST', '/page/link', s.token))!.body).url);
  const cookie = await new Promise<string>((resolve) => request({ host: '127.0.0.1', port: s.port, path: `${link.pathname}${link.search}` }, (response) => (response.resume(), resolve(String(response.headers['set-cookie']).split(';')[0]!))).end());

  return openStream(s.port, '/v1/conversation/events?page=1', { Cookie: cookie });
}

describe('listenHub', () => {
  it('answers /hub without a token', async () => {
    server = await listenHub({ identity, onShutdown: () => {} });

    const reply = await call(server.port, 'GET', '/hub', null);

    expect(reply?.status).toBe(200);
    expect(JSON.parse(reply!.body)).toEqual(identity);
  });

  it('refuses other paths without the token', async () => {
    const onShutdown = vi.fn();

    server = await listenHub({ identity, onShutdown });

    expect((await call(server.port, 'GET', '/status', null))?.status).toBe(401);
    expect((await call(server.port, 'GET', '/status', 'wrong'))?.status).toBe(401);
    expect((await call(server.port, 'POST', '/shutdown', `${server.token}x`))?.status).toBe(401);
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('answers /status with the token', async () => {
    server = await listenHub({ identity, onShutdown: () => {} });

    const reply = await call(server.port, 'GET', '/status', server.token);

    expect(reply?.status).toBe(200);
    expect(JSON.parse(reply!.body)).toEqual(identity);
  });

  it('returns 404 for an unknown path or method with the token', async () => {
    server = await listenHub({ identity, onShutdown: () => {} });

    expect((await call(server.port, 'GET', '/nothing', server.token))?.status).toBe(404);
    expect((await call(server.port, 'POST', '/status', server.token))?.status).toBe(404);
    // VS Code windows' and the dock's streams and reports are gone; a page's conversation stream needs its cookie and `page`.
    expect((await call(server.port, 'GET', '/events', server.token))?.status).toBe(404);
    expect((await call(server.port, 'GET', '/dock/events', server.token))?.status).toBe(404);
    expect((await call(server.port, 'GET', '/v1/conversation/events?window=key-1', server.token))?.status).toBe(404);
    expect((await call(server.port, 'POST', '/window/focus', server.token, 2000, { window: 'key-1', focused: true }))?.status).toBe(404);
    expect((await call(server.port, 'POST', '/window/theme', server.token, 2000, { theme: 'dark', at: 1 }))?.status).toBe(404);
  });

  it('calls onShutdown for an authorized shutdown', async () => {
    const onShutdown = vi.fn();

    server = await listenHub({ identity, onShutdown });

    expect((await call(server.port, 'POST', '/shutdown', server.token))?.status).toBe(200);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('tracks connected page streams', async () => {
    let time = 1000;

    server = await listenHub({ identity, onShutdown: () => {}, now: () => time, ...withPage() });

    expect(server.clients()).toBe(0);
    expect(server.emptySince()).toBe(1000);

    const first = await openPage(server);
    const second = await openPage(server);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(server.clients()).toBe(2);
    expect(server.emptySince()).toBeNull();

    time = 2000;
    first!.close();
    await until(() => (server.clients() === 1 ? true : null));
    expect(server.emptySince()).toBeNull();

    time = 3000;
    second!.close();
    await until(() => (server.clients() === 0 ? true : null));
    expect(server.emptySince()).toBe(3000);
  });
});

describe('listenHub routes and state', () => {
  it('sends JSON bodies to POST handlers, refuses bad JSON, and reports handler errors', async () => {
    server = await listenHub({
      identity,
      onShutdown: () => {},
      post: { '/echo': async (body) => ({ status: 200, body: { got: body } }), '/boom': async () => Promise.reject(new Error('broken')) },
    });

    expect(await call(server.port, 'POST', '/echo', server.token, 2000, { a: 1 })).toEqual({ status: 200, body: '{"got":{"a":1}}' });
    expect((await call(server.port, 'POST', '/boom', server.token, 2000, {}))?.status).toBe(500);
    expect((await call(server.port, 'POST', '/echo', server.token))?.body).toBe('{"error":"body is not JSON"}');
    expect((await call(server.port, 'POST', '/echo', null, 2000, {}))?.status).toBe(401);
  });

  it('opens no page stream once views stop, because the hub then closes the app behind them', async () => {
    const opens = { count: 0 };

    server = await listenHub({ identity, onShutdown: () => {}, ...withPage(opens) });

    expect(await openPage(server)).not.toBeNull();
    await until(() => (server.clients() === 1 ? true : null));
    // The hub's stop: views stop, the app closes, and requests on open connections still arrive before the server closes.
    server.stopViews();
    expect(await openPage(server)).toBeNull();
    expect(opens.count).toBe(1);
    expect(server.clients()).toBe(1);
  });
});

describe('listenHub restart support', () => {
  it('counts POST requests until they are answered and answers 503 with the reason to every POST once held', async () => {
    let release: () => void = () => {};

    server = await listenHub({ identity, onShutdown: () => {}, post: { '/slow': () => new Promise((done) => (release = () => done({ status: 200, body: {} }))), '/fast': async () => ({ status: 200, body: {} }) } });

    expect(server.inFlight()).toBe(0);

    const slow = call(server.port, 'POST', '/slow', server.token, 5000, {});

    await until(() => (server.inFlight() === 1 ? true : null));
    release();
    expect((await slow)?.status).toBe(200);
    await until(() => (server.inFlight() === 0 ? true : null));

    server.hold('Switchboard is restarting onto a new build; try again in a few seconds.');

    const refused = await call(server.port, 'POST', '/fast', server.token, 5000, {});

    expect(refused?.status).toBe(503);
    expect(JSON.parse(refused!.body)).toEqual({ error: 'Switchboard is restarting onto a new build; try again in a few seconds.' });
    // A page waits this long before it sends the command again.
    expect((await fetch(`http://127.0.0.1:${server.port}/fast`, { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, body: '{}' })).headers.get('retry-after')).toBe('2');
    expect(server.inFlight()).toBe(0);
    expect((await call(server.port, 'GET', '/hub', null, 2000))?.status).toBe(200);
  });
});
