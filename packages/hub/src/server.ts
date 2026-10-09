import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HubIdentity } from '@switchboard/core';

export interface Reply {
  status: number;
  body: unknown;
}

export interface HubServerOptions {
  identity: HubIdentity;
  onShutdown(): void;
  /** Handlers for authorized `POST` paths, given the parsed JSON body. */
  post?: Record<string, (body: unknown) => Promise<Reply>>;
  /** The panel state, sent as a `state` event when an `/events` stream opens and on each `update`. */
  snapshot?: () => unknown;
  /** The dock view, sent as a `dock` event when a `/dock/events` stream opens and on each `update` (PRD R71). */
  dock?: () => unknown;
  heartbeatMs?: number;
  now?: () => number;
}

export interface HubServer {
  port: number;
  token: string;
  /** Connected event streams. */
  clients(): number;
  /** When the last event stream closed, or null while one is open. Starts at listen time. */
  emptySince(): number | null;
  /** Sends each open stream its view again: `state` to `/events` streams and `dock` to `/dock/events` streams. */
  update(): void;
  close(): Promise<void>;
}

type View = 'panel' | 'dock';

const HEARTBEAT_MS = 15_000;
const BODY_LIMIT = 1024 * 1024;

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = '';

    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      text += chunk;

      if (text.length > BODY_LIMIT) {
        reject(new Error('body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * Loopback HTTP server. `/hub` is public identity; everything else requires the token from `hub.json`.
 * An open `/events` stream marks a connected client and holds off idle exit.
 */
export function listenHub(options: HubServerOptions): Promise<HubServer> {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const now = options.now ?? Date.now;
  // Each open stream and the view it sends.
  const streams = new Map<ServerResponse, View>();

  let emptySince: number | null = now();

  const authorized = (request: IncomingMessage): boolean => {
    const given = Buffer.from(request.headers.authorization ?? '');

    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const views: Record<View, { event: string; data: (() => unknown) | undefined }> = {
    panel: { event: 'state', data: options.snapshot },
    dock: { event: 'dock', data: options.dock },
  };
  const message = (view: View): string | null => {
    const { event, data } = views[view];

    return data === undefined ? null : `event: ${event}\ndata: ${JSON.stringify(data())}\n\n`;
  };

  const openStream = (request: IncomingMessage, response: ServerResponse, view: View): void => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write(`event: hello\ndata: ${JSON.stringify(options.identity)}\n\n`);
    response.write(message(view) ?? '');
    streams.set(response, view);
    emptySince = null;
    request.on('close', () => {
      streams.delete(response);

      if (streams.size === 0) {
        emptySince = now();
      }
    });
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    if (request.method === 'GET' && path === '/hub') {
      json(response, 200, options.identity);
    } else if (!authorized(request)) {
      json(response, 401, { error: 'unauthorized' });
    } else if (request.method === 'GET' && path === '/status') {
      json(response, 200, options.identity);
    } else if (request.method === 'GET' && path === '/events') {
      openStream(request, response, 'panel');
    } else if (request.method === 'GET' && path === '/dock/events') {
      openStream(request, response, 'dock');
    } else if (request.method === 'POST' && path === '/shutdown') {
      json(response, 200, { stopping: true });
      options.onShutdown();
    } else if (request.method === 'POST' && options.post?.[path] !== undefined) {
      const handler = options.post[path];

      readJson(request).then(
        (body) =>
          handler(body).then(
            (reply) => json(response, reply.status, reply.body),
            (error: unknown) => json(response, 500, { error: String(error) }),
          ),
        (error: Error) => json(response, 400, { error: error.message }),
      );
    } else {
      json(response, 404, { error: 'not found' });
    }
  });

  const heartbeat = setInterval(() => {
    for (const stream of streams.keys()) {
      stream.write(': ping\n\n');
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);

  heartbeat.unref();

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      clearInterval(heartbeat);
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;

      resolve({
        port,
        token,
        clients: () => streams.size,
        emptySince: () => emptySince,
        update: () => {
          // Each view is built once, and only while a stream shows it.
          const built = new Map<View, string | null>();

          for (const [stream, view] of streams) {
            if (!built.has(view)) {
              built.set(view, message(view));
            }

            stream.write(built.get(view) ?? '');
          }
        },
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);

            for (const stream of streams.keys()) {
              stream.end();
            }

            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
