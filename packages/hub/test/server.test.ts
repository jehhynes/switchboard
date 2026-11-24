import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call } from '../src/http.js';
import { listenHub } from '../src/server.js';
import type { HubServer } from '../src/server.js';
import { openStream, until } from './helpers.js';

const identity = { hub: 'switchboard', protocol: 1, version: '0.1.0', pid: 99 };

let server: HubServer;

afterEach(async () => {
  await server.close();
});

const bearer = (s: HubServer) => ({ Authorization: `Bearer ${s.token}` });

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
    expect((await call(server.port, 'GET', '/dock/events', null))?.status).toBe(401);
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
    // VS Code windows' streams and reports are gone; a page's conversation stream needs its cookie and `page`.
    expect((await call(server.port, 'GET', '/events', server.token))?.status).toBe(404);
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

  it('tracks connected event streams', async () => {
    let time = 1000;

    server = await listenHub({ identity, onShutdown: () => {}, now: () => time });

    expect(server.clients()).toBe(0);
    expect(server.emptySince()).toBe(1000);

    const first = await openStream(server.port, '/dock/events', bearer(server));
    const second = await openStream(server.port, '/dock/events', bearer(server));

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

  it('sends a hello event and heartbeats on open streams', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, heartbeatMs: 20 });

    let text = '';

    await new Promise<void>((resolve) => {
      const outbound = request(
        { host: '127.0.0.1', port: server.port, path: '/dock/events', headers: { Authorization: `Bearer ${server.token}` } },
        (response) => {
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            text += chunk;

            if (text.includes(': ping')) {
              outbound.destroy();
              resolve();
            }
          });
        },
      );

      outbound.end();
    });

    expect(text).toContain(`event: hello\ndata: ${JSON.stringify(identity)}\n\n`);
    expect(text).toContain(': ping\n\n');
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

  it('sends each dock stream the dock view when it opens and again on update', async () => {
    let dock = { d: 1 };
    server = await listenHub({ identity, onShutdown: () => {}, dock: () => dock });

    const read = (path: string) => {
      const chunks: string[] = [];
      const outbound = request({ host: '127.0.0.1', port: server.port, path, headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => chunks.push(chunk));
      });

      outbound.on('error', () => {});
      outbound.end();

      return { text: () => chunks.join(''), close: () => outbound.destroy() };
    };
    const docked = read('/dock/events');

    await until(() => (docked.text().includes('event: dock\ndata: {"d":1}\n\n') ? true : null));
    expect(server.clients()).toBe(1);
    dock = { d: 2 };
    server.update();
    await until(() => (docked.text().includes('event: dock\ndata: {"d":2}\n\n') ? true : null));
    expect(docked.text()).toMatch(/^event: hello\ndata: \{"hub":"switchboard"/);
    docked.close();
  });

  it('sends a dock event to the dock streams, and counts them', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, dock: () => ({}) });

    expect(server.notifyDock('show', {})).toBe(0);

    const chunks: Record<string, string[]> = { '/dock/events': [], '/dock/events?click=1': [] };

    for (const path of Object.keys(chunks)) {
      const outbound = request({ host: '127.0.0.1', port: server.port, path, headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => chunks[path]!.push(chunk));
      });

      outbound.on('error', () => {});
      outbound.end();
    }

    await until(() => (server.clients() === 2 ? true : null));
    expect(server.notifyDock('show', { a: 1 })).toBe(2);
    await until(() => (Object.values(chunks).every((one) => one.join('').includes('event: show\ndata: {"a":1}\n\n')) ? true : null));
  });

  it('sends a forwarded click to the newest dock stream that asked for clicks, and to no other stream (PRD R65, R69)', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, dock: () => ({}) });

    const open = (path: string) => {
      const chunks: string[] = [];
      const outbound = request({ host: '127.0.0.1', port: server.port, path, headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => chunks.push(chunk));
      });

      outbound.on('error', () => {});
      outbound.end();

      return { text: () => chunks.join(''), close: () => outbound.destroy() };
    };

    expect(server.clickDock({ rowKey: 'item:1' })).toBe(false);

    const old = open('/dock/events');
    const first = open('/dock/events?click=1');
    const second = open('/dock/events?click=1');

    await until(() => (server.clients() === 3 ? true : null));
    expect(server.clickDock({ rowKey: 'item:2' })).toBe(true);
    await until(() => (second.text().includes('event: click\ndata: {"rowKey":"item:2"}\n\n') ? true : null));

    second.close();
    await until(() => (server.clients() === 2 ? true : null));
    expect(server.clickDock({ rowKey: 'item:3' })).toBe(true);
    await until(() => (first.text().includes('"rowKey":"item:3"') ? true : null));
    expect(first.text()).not.toContain('"rowKey":"item:2"');
    expect(old.text()).not.toContain('event: click');

    first.close();
    await until(() => (server.clients() === 1 ? true : null));
    expect(server.clickDock({ rowKey: 'item:4' })).toBe(false);
    old.close();
  });

  it('builds no view once views stop, because the hub then closes the app that builds them', async () => {
    let appClosed = false;
    let builtAfterClose = 0;
    const local = await listenHub({
      identity,
      onShutdown: () => {},
      dock: () => {
        builtAfterClose += appClosed ? 1 : 0;
        return {};
      },
    });
    const connect = (path: string) => {
      const outbound = request({ host: '127.0.0.1', port: local.port, path, headers: { Authorization: `Bearer ${local.token}` } }, (response) => response.resume());

      outbound.on('error', () => {});
      outbound.end();
    };

    connect('/dock/events');
    await until(() => (local.clients() === 1 ? true : null));
    // The hub's stop: views stop, the app closes, and requests on open connections still arrive before the server closes.
    local.stopViews();
    appClosed = true;
    connect('/dock/events');
    await until(() => (local.clients() === 2 ? true : null));
    local.update();
    await local.close();
    await new Promise((done) => setTimeout(done, 100));
    expect(builtAfterClose).toBe(0);
    server = await listenHub({ identity, onShutdown: () => {} });
  });

  it('refuses the dock stream without the token', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, dock: () => ({}) });

    expect((await call(server.port, 'GET', '/dock/events', null))?.status).toBe(401);
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

    server.hold('The hub is restarting onto a new build; try again in a few seconds.');

    const refused = await call(server.port, 'POST', '/fast', server.token, 5000, {});

    expect(refused?.status).toBe(503);
    expect(JSON.parse(refused!.body)).toEqual({ error: 'The hub is restarting onto a new build; try again in a few seconds.' });
    // A page waits this long before it sends the command again.
    expect((await fetch(`http://127.0.0.1:${server.port}/fast`, { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, body: '{}' })).headers.get('retry-after')).toBe('2');
    expect(server.inFlight()).toBe(0);
    expect((await call(server.port, 'GET', '/hub', null, 2000))?.status).toBe(200);
  });
});
