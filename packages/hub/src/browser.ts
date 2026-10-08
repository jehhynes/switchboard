import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Card } from '@switchboard/core';
import { handleSnooze, handleUnsnooze } from './browserSnooze.js';
import type { SnoozeByUrl, UnsnoozeByUrl } from './browserSnooze.js';

export interface BrowserServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Unauthenticated loopback endpoint for the Chrome extension: `GET /snoozed` lists the URLs of snoozed tickets (PRD R56),
 * `GET /cards` each ticket's playbook and group (PRD R67), `POST /snooze` snoozes one and `POST /unsnooze` ends its snooze (PRD R66). A browser extension
 * cannot read `hub.json`, so the port is fixed. It sends no CORS headers, so web pages cannot read it, and it refuses a
 * Host other than the loopback address, against DNS rebinding.
 */
export function listenBrowser(port: number, snoozed: () => string[], cards: () => Card[], snooze?: SnoozeByUrl, unsnooze?: UnsnoozeByUrl): Promise<BrowserServer> {
  const server: Server = createServer((request, response) => {
    const listening = (server.address() as { port: number }).port;
    const hosts = new Set([`127.0.0.1:${listening}`, `localhost:${listening}`]);
    // Split rather than parse, because `new URL` throws on a target such as `//[`, which would end the hub.
    const path = (request.url ?? '').split('?')[0];
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };

    if (!hosts.has(request.headers.host ?? '')) {
      reply(403, { error: 'forbidden host' });
    } else if (request.method === 'GET' && path === '/snoozed') {
      reply(200, { urls: snoozed() });
    } else if (request.method === 'GET' && path === '/cards') {
      reply(200, { cards: cards() });
    } else if (request.method === 'POST' && path === '/snooze' && snooze !== undefined) {
      void handleSnooze(request, snooze).then(({ status, body }) => reply(status, body));
    } else if (request.method === 'POST' && path === '/unsnooze' && unsnooze !== undefined) {
      void handleUnsnooze(request, unsnooze).then(({ status, body }) => reply(status, body));
    } else {
      reply(404, { error: 'not found' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
