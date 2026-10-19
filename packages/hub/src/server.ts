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
  /** The snapshot, sent as a `state` event when an `/events` stream opens and on each `update`. */
  snapshot?: () => unknown;
  /**
   * The dock view, sent as a `dock` event when a `/dock/events` stream opens, on each `update`, and when a VS Code window opens, closes or
   * changes focus, with `windows` added (PRD R71).
   */
  dock?: () => object;
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
  /** Sends an event to every `/dock/events` stream, such as `show` or `config`; returns how many streams it reached. */
  notifyDock(event: string, data: unknown): number;
  /** Sends an event to every `/events` stream, such as `claim`; returns how many streams it reached. */
  notifyWindows(event: string, data: unknown): number;
  /** Builds no more views, so nothing reads the app after it closes; streams that open get only `hello`. */
  stopViews(): void;
  close(): Promise<void>;
}

type View = 'window' | 'dock';

/**
 * The VS Code windows the hub's `/events` streams come from: each item window's workspace file, and the one in front, which the dock follows
 * where it cannot see other apps' windows (architecture.md § Dock).
 */
export interface OpenWindows {
  /** The workspace files of connected item windows, in the order they connected. */
  open: string[];
  /** The workspace file of the item window that last gained focus and still has it, or null. */
  front: string | null;
  /** Connected windows, item windows or not. */
  count: number;
}

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
  // Each window stream's workspace file, null for a window that is not an item window.
  const workspaces = new Map<ServerResponse, string | null>();
  let front: string | null = null;
  // When the focus change that set `front` happened, and each window's latest reported change, so a report that arrives late changes nothing.
  let frontAt = -Infinity;
  let theme: 'light' | 'dark' | undefined;
  let themeAt = -Infinity;
  const reportedAt = new Map<string | null, number>();

  let emptySince: number | null = now();

  const authorized = (request: IncomingMessage): boolean => {
    const given = Buffer.from(request.headers.authorization ?? '');

    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const openWindows = (): OpenWindows => ({ open: [...new Set([...workspaces.values()].filter((file): file is string => file !== null))], front, count: workspaces.size });
  const dock = options.dock;
  const views: Record<View, { event: string; data: (() => unknown) | undefined }> = {
    window: { event: 'state', data: options.snapshot },
    dock: { event: 'dock', data: dock === undefined ? undefined : () => ({ ...dock(), windows: openWindows(), ...(theme === undefined ? {} : { theme }) }) },
  };
  // Set by stopViews and close: the app that builds the views may already be closed.
  let closing = false;

  const message = (view: View): string | null => {
    const { event, data } = views[view];

    return closing || data === undefined ? null : `event: ${event}\ndata: ${JSON.stringify(data())}\n\n`;
  };

  const windowsChanged = (): void => {
    const sent = message('dock');

    if (sent === null) {
      return;
    }

    for (const [stream, view] of streams) {
      if (view === 'dock') {
        stream.write(sent ?? '');
      }
    }
  };

  const focus = (workspace: string | null, focused: boolean, at: number): void => {
    const last = reportedAt.get(workspace) ?? -Infinity;

    reportedAt.set(workspace, Math.max(last, at));

    if (at < last || at < frontAt) {
      return;
    }

    // A window that is not an item window has no workspace, as no front has none, so only an item window's blur clears the front.
    if (focused) {
      front = workspace;
      frontAt = at;
    } else if (workspace !== null && front === workspace) {
      front = null;
      frontAt = at;
    }
  };

  /** A window stream's `workspace` names its workspace file, `focused=1` says it has focus, and `at` is when the window read its focus. */
  const openStream = (request: IncomingMessage, response: ServerResponse, view: View, query?: URLSearchParams): void => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write(`event: hello\ndata: ${JSON.stringify(options.identity)}\n\n`);
    response.write(message(view) ?? '');
    streams.set(response, view);
    emptySince = null;

    if (view === 'window') {
      const workspace = query?.get('workspace') || null;

      workspaces.set(response, workspace);
      const at = Number(query?.get('at'));

      focus(workspace, query?.get('focused') === '1', Number.isFinite(at) && query?.get('at') ? at : now());
      windowsChanged();
    }

    request.on('close', () => {
      streams.delete(response);

      if (workspaces.has(response)) {
        const workspace = workspaces.get(response)!;

        workspaces.delete(response);

        // A reloaded window opens its new stream before the old one closes, and keeps its focus. A closed window leaves the front without
        // setting its time, so another window's focus that happened earlier but arrives later still applies.
        if (front === workspace && ![...workspaces.values()].includes(workspace)) {
          front = null;
        }

        windowsChanged();
      }

      if (streams.size === 0) {
        emptySince = now();
      }
    });
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (request.method === 'GET' && path === '/hub') {
      json(response, 200, options.identity);
    } else if (!authorized(request)) {
      json(response, 401, { error: 'unauthorized' });
    } else if (request.method === 'GET' && path === '/status') {
      json(response, 200, options.identity);
    } else if (request.method === 'GET' && path === '/events') {
      openStream(request, response, 'window', url.searchParams);
    } else if (request.method === 'GET' && path === '/dock/events') {
      openStream(request, response, 'dock');
    } else if (request.method === 'POST' && path === '/window/theme') {
      readJson(request).then(
        (body) => {
          const report = body as { theme?: unknown; at?: unknown } | null;

          if ((report?.theme !== 'light' && report?.theme !== 'dark') || typeof report.at !== 'number' || !Number.isFinite(report.at)) {
            json(response, 400, { error: 'Expected {theme: light|dark, at: epoch milliseconds}.' });
            return;
          }

          if (report.at >= themeAt) {
            theme = report.theme;
            themeAt = report.at;
            windowsChanged();
          }

          json(response, 200, {});
        },
        (error: Error) => json(response, 400, { error: error.message }),
      );
    } else if (request.method === 'POST' && path === '/window/focus') {
      readJson(request).then(
        (body) => {
          const { workspace, focused, at } = (body ?? {}) as { workspace?: unknown; focused?: unknown; at?: unknown };

          if ((workspace !== null && typeof workspace !== 'string') || typeof focused !== 'boolean' || (at !== undefined && typeof at !== 'number')) {
            json(response, 400, { error: 'Expected {workspace, focused, at?} with workspace a path or null and at the epoch milliseconds of the change.' });
          } else {
            const file = workspace === '' ? null : workspace;

            // A report that arrives after its window's stream closed does not bring the window back.
            if (file === null || !focused || [...workspaces.values()].includes(file)) {
              focus(file, focused, at ?? now());
              windowsChanged();
            }

            json(response, 200, {});
          }
        },
        (error: Error) => json(response, 400, { error: error.message }),
      );
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

  const notify = (to: View, event: string, data: unknown): number => {
    let sent = 0;

    for (const [stream, view] of streams) {
      if (view === to) {
        stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        sent++;
      }
    }

    return sent;
  };

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
        notifyDock: (event, data) => notify('dock', event, data),
        notifyWindows: (event, data) => notify('window', event, data),
        stopViews: () => {
          closing = true;
        },
        close: () =>
          new Promise<void>((done) => {
            closing = true;
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
