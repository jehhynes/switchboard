import { request } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listenBrowser } from '../src/browser.js';
import type { BrowserServer } from '../src/browser.js';

let server: BrowserServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function get(port: number, path: string, host = `127.0.0.1:${port}`, method = 'GET'): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port, method, path, headers: { Host: host, Origin: 'https://evil.example' } }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });

    outbound.on('error', reject);
    outbound.end();
  });
}

describe('listenBrowser', () => {
  it('lists the snoozed URLs on each request, with no CORS header', async () => {
    let urls = ['https://github.com/o/r/issues/1'];

    server = await listenBrowser(0, () => urls);

    const first = await get(server.port, '/snoozed');

    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ urls: ['https://github.com/o/r/issues/1'] });
    expect(first.headers['access-control-allow-origin']).toBeUndefined();
    expect(first.headers['cache-control']).toBe('no-store');

    urls = [];
    expect(JSON.parse((await get(server.port, '/snoozed', `localhost:${server.port}`)).body)).toEqual({ urls: [] });
  });

  it('refuses another Host, another path and another method', async () => {
    server = await listenBrowser(0, () => ['https://github.com/o/r/issues/1']);

    expect((await get(server.port, '/snoozed', `rebound.example:${server.port}`)).status).toBe(403);
    expect((await get(server.port, '/snoozed', '127.0.0.1:1')).status).toBe(403);
    expect((await get(server.port, '/status')).status).toBe(404);
    expect((await get(server.port, '/snoozed', undefined, 'POST')).status).toBe(404);
    expect((await get(server.port, '//[')).status).toBe(404);
    expect((await get(server.port, '//[', 'rebound.example')).status).toBe(403);
    expect((await get(server.port, '/snoozed?x=1')).status).toBe(200);
  });

  it('rejects when the port is taken', async () => {
    const holder = createServer();

    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));

    const port = (holder.address() as { port: number }).port;

    await expect(listenBrowser(port, () => [])).rejects.toThrow(/EADDRINUSE/);
    await new Promise((done) => holder.close(done));
  });
});
