import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openEvents } from '../src/client.js';
import { call } from '../src/http.js';
import { listenHub } from '../src/server.js';
import type { HubServer } from '../src/server.js';
import { until } from './helpers.js';

const identity = { hub: 'switchboard', protocol: 1, version: '0.1.0', pid: 99 };

let server: HubServer;

afterEach(async () => {
  await server.close();
});

function recordOf(s: HubServer) {
  return { protocol: 1, version: '0.1.0', build: 'b1', port: s.port, token: s.token, pid: 99, startedAt: '' };
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
    expect((await call(server.port, 'GET', '/events', null))?.status).toBe(401);
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

    const first = await openEvents(recordOf(server), () => {});
    const second = await openEvents(recordOf(server), () => {});

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
        { host: '127.0.0.1', port: server.port, path: '/events', headers: { Authorization: `Bearer ${server.token}` } },
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
