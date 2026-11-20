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
  /**
   * The snapshot a window's stream shows, sent as a `state` event when an `/events` stream opens and on each `update`: with window keys, the
   * window's scoped snapshot (architecture.md § Window scope). Undefined sends nothing, as before the first build.
   */
  snapshot?: (window: { workspace: string | null; key: string | null }) => unknown;
  /**
   * Registers a window's `/events` stream and returns the window key its `hello` carries: an item window names its workspace file, a folder
   * window, which has none, its folder.
   */
  windowOpened?: (workspace: string | null, folder: string | null) => string;
  /** The canonical folder of the folder window a key names, or null, for the dock's `windows.folders`. */
  windowFolder?: (key: string) => string | null;
  /** The window's `/events` stream closed, so its key dies. */
  windowClosed?: (key: string) => void;
  /** Opens a window's conversation stream for its key, writing each SSE frame; null for a key no window holds. */
  conversation?: (key: string, write: (frame: string) => void) => { close(): void } | null;
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
  /** Sends an event to every `/events` stream, or with `keys` only to the streams of those window keys, such as `claim`; returns how many streams it reached. */
  notifyWindows(event: string, data: unknown, keys?: readonly string[]): number;
  /** The key of the window that last gained focus and still has it, item or folder window, or null (architecture.md § Window scope). */
  focusedWindow(): string | null;
  /**
   * Sends a `click` event to the newest `/dock/events` stream opened with `?click=1`, so one dock runs a click VS Code forwards (PRD R65, R69);
   * returns whether one was open.
   */
  clickDock(data: unknown): boolean;
  /** Builds no more views, so nothing reads the app after it closes; streams that open get only `hello`. */
  stopViews(): void;
  close(): Promise<void>;
}

type View = 'window' | 'dock' | 'conversation';

/**
 * The VS Code windows the hub's `/events` streams come from: each item window's workspace file, and the one in front, which the dock follows
 * where it cannot see other apps' windows (architecture.md § Dock).
 */
export interface OpenWindows {
  /** The workspace files of connected item windows, in the order they connected. */
  open: string[];
  /** The workspace file of the item window that last gained focus and still has it; null while a folder window or none has it. */
  front: string | null;
  /** Connected windows, item windows or not. */
  count: number;
  /** The canonical folders of connected folder windows, which reach a folder-hosted conversation's destination (architecture.md § Dock). */
  folders: string[];
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
  // Dock streams that run forwarded clicks, oldest first; an older dock does not ask for them.
  const clickStreams: ServerResponse[] = [];
  // Each window stream's workspace file, null for a window that is not an item window.
  const workspaces = new Map<ServerResponse, string | null>();
  // Each window stream's key, when the app issues them.
  const keys = new Map<ServerResponse, string>();
  // Each window stream's folder, for a folder window, so a reload's new stream takes over the focus of its old one.
  const folders = new Map<ServerResponse, string | null>();
  // The window stream in front, reported by its key, so two folder windows, which have no workspace file, are told apart.
  let front: ServerResponse | null = null;
  // When the focus change that set `front` happened, and each window's latest reported change, so a report that arrives late changes nothing.
  let frontAt = -Infinity;
  let theme: 'light' | 'dark' | undefined;
  let themeAt = -Infinity;
  const reportedAt = new Map<ServerResponse, number>();
  // Each window stream's latest applied focus report, and the order streams opened, so only a newer stream of a reloaded window, still focused,
  // takes over the focus when the old one closes.
  const focusedNow = new Map<ServerResponse, boolean>();
  const openedAt = new Map<ServerResponse, number>();
  let opened = 0;

  let emptySince: number | null = now();

  const authorized = (request: IncomingMessage): boolean => {
    const given = Buffer.from(request.headers.authorization ?? '');

    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const openWindows = (): OpenWindows => ({
    open: [...new Set([...workspaces.values()].filter((file): file is string => file !== null))],
    front: front === null ? null : (workspaces.get(front) ?? null),
    count: workspaces.size,
    folders: [...new Set([...keys].flatMap(([stream, key]) => (workspaces.has(stream) && workspaces.get(stream) === null ? [options.windowFolder?.(key) ?? null] : [])).filter((folder): folder is string => folder !== null))],
  });
  const dock = options.dock;
  const views: Record<Exclude<View, 'conversation'>, { event: string; data: ((stream: ServerResponse) => unknown) | undefined }> = {
    window: { event: 'state', data: options.snapshot === undefined ? undefined : (stream) => options.snapshot!({ workspace: workspaces.get(stream) ?? null, key: keys.get(stream) ?? null }) },
    dock: { event: 'dock', data: dock === undefined ? undefined : () => ({ ...dock(), windows: openWindows(), ...(theme === undefined ? {} : { theme }) }) },
  };
  // Set by stopViews and close: the app that builds the views may already be closed.
  let closing = false;

  /** The view's event for a stream; a window's state is its own, so it is built per stream, the dock's once. */
  const message = (view: View, stream?: ServerResponse): string | null => {
    if (view === 'conversation') {
      return null;
    }

    const { event, data } = views[view];
    const built = closing || data === undefined || (view === 'window' && stream === undefined) ? undefined : data(stream!);

    return built === undefined ? null : `event: ${event}\ndata: ${JSON.stringify(built)}\n\n`;
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

  /** A window stream's focus change; null for a report that names no connected window, which counts only as a blur of none. */
  const focus = (stream: ServerResponse | null, focused: boolean, at: number): void => {
    const last = stream === null ? -Infinity : (reportedAt.get(stream) ?? -Infinity);

    if (stream !== null) {
      reportedAt.set(stream, Math.max(last, at));

      // A report the front rejects as older than its last change counts as no focus, so it never wins a hand-off.
      if (at >= last) {
        focusedNow.set(stream, focused && at >= frontAt);
      }
    }

    if (at < last || at < frontAt) {
      return;
    }

    // A focus report with no window, as from a window with neither workspace file nor key, clears the front, as another app's window would.
    if (focused) {
      front = stream;
      frontAt = at;
    } else if (stream !== null && front === stream) {
      front = null;
      frontAt = at;
    }
  };
  /** The same window, reloaded: a stream with the same workspace file, or for a folder window the same folder, named the same way. */
  const sameWindow = (a: ServerResponse, b: ServerResponse): boolean =>
    workspaces.get(a) != null ? workspaces.get(a) === workspaces.get(b) : folders.get(a) != null && workspaces.get(b) == null && folders.get(a) === folders.get(b);

  /**
   * A window stream's `workspace` names its workspace file, or for a folder window, which has none, `folder` its folder; `focused=1` says it has
   * focus, and `at` is when the window read its focus.
   */
  const openStream = (request: IncomingMessage, response: ServerResponse, view: View, query?: URLSearchParams): void => {
    const workspace = view === 'window' ? query?.get('workspace') || null : null;
    const folder = view === 'window' && workspace === null ? query?.get('folder') || null : null;
    const key = view === 'window' ? (options.windowOpened?.(workspace, folder) ?? null) : null;

    if (key !== null) {
      keys.set(response, key);
    }

    if (view === 'window') {
      workspaces.set(response, workspace);
      folders.set(response, folder);
      openedAt.set(response, ++opened);
    }

    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write(`event: hello\ndata: ${JSON.stringify(key === null ? options.identity : { ...options.identity, window: key })}\n\n`);
    response.write(message(view, response) ?? '');
    streams.set(response, view);
    emptySince = null;

    if (view === 'dock' && query?.get('click') === '1') {
      clickStreams.push(response);
    }

    if (view === 'window') {
      const at = Number(query?.get('at'));

      focus(response, query?.get('focused') === '1', Number.isFinite(at) && query?.get('at') ? at : now());
      windowsChanged();
    }

    request.on('close', () => {
      streams.delete(response);

      if (clickStreams.includes(response)) {
        clickStreams.splice(clickStreams.indexOf(response), 1);
      }

      if (keys.has(response)) {
        options.windowClosed?.(keys.get(response)!);
        keys.delete(response);
      }

      if (workspaces.has(response)) {
        // A reloaded window opens its new stream before the old one closes, and keeps its focus. A closed window leaves the front without
        // setting its time, so another window's focus that happened earlier but arrives later still applies.
        if (front === response) {
          front = [...workspaces.keys()].reverse().find((stream) => openedAt.get(stream)! > openedAt.get(response)! && focusedNow.get(stream) === true && sameWindow(response, stream)) ?? null;
        }

        workspaces.delete(response);
        folders.delete(response);
        reportedAt.delete(response);
        focusedNow.delete(response);
        openedAt.delete(response);
        windowsChanged();
      }

      if (streams.size === 0) {
        emptySince = now();
      }
    });
  };

  /** A window's conversation stream (architecture.md § Conversation API); refused for a key no connected window holds. */
  const openConversation = (request: IncomingMessage, response: ServerResponse, key: string): void => {
    let pending: string[] | null = [];
    const write = (frame: string): void => {
      if (pending === null) {
        response.write(frame);
      } else {
        pending.push(frame);
      }
    };
    const stream = closing ? null : (options.conversation?.(key, write) ?? null);

    if (stream === null) {
      json(response, 403, { error: 'Not in this window.' });
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

    for (const frame of pending) {
      response.write(frame);
    }

    pending = null;
    streams.set(response, 'conversation');
    emptySince = null;
    request.on('close', () => {
      stream.close();
      streams.delete(response);

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
      openStream(request, response, 'dock', url.searchParams);
    } else if (request.method === 'GET' && path === '/v1/conversation/events') {
      openConversation(request, response, url.searchParams.get('window') ?? '');
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
          const { window, workspace, focused, at } = (body ?? {}) as { window?: unknown; workspace?: unknown; focused?: unknown; at?: unknown };

          if ((window !== undefined && typeof window !== 'string') || (workspace !== undefined && workspace !== null && typeof workspace !== 'string') || typeof focused !== 'boolean' || (at !== undefined && typeof at !== 'number')) {
            json(response, 400, { error: 'Expected {window, focused, at?} with window the key of its stream and at the epoch milliseconds of the change.' });
          } else {
            // A window reports by its key; a window older than keys by its workspace file, the newest stream of that file.
            const file = workspace === '' ? null : (workspace ?? null);
            const stream =
              typeof window === 'string' ? ([...keys].find(([, key]) => key === window)?.[0] ?? null) : file === null ? null : ([...workspaces].reverse().find(([, one]) => one === file)?.[0] ?? null);
            const named = typeof window === 'string' || file !== null;

            // A report that arrives after its window's stream closed does not bring the window back.
            if (!named || stream !== null || !focused) {
              focus(stream, focused, at ?? now());
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

  const notify = (to: View, event: string, data: unknown, only?: readonly string[]): number => {
    let sent = 0;

    for (const [stream, view] of streams) {
      const key = keys.get(stream);

      if (view === to && (only === undefined || (key !== undefined && only.includes(key)))) {
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
          // The dock's view is built once, and only while a stream shows it; each window's is its own.
          const built = new Map<View, string | null>();

          for (const [stream, view] of streams) {
            if (view === 'window') {
              stream.write(message(view, stream) ?? '');
              continue;
            }

            if (!built.has(view)) {
              built.set(view, message(view));
            }

            stream.write(built.get(view) ?? '');
          }
        },
        notifyDock: (event, data) => notify('dock', event, data),
        notifyWindows: (event, data, only) => notify('window', event, data, only),
        focusedWindow: () => (front === null ? null : (keys.get(front) ?? null)),
        clickDock: (data) => {
          const stream = clickStreams.at(-1);

          stream?.write(`event: click\ndata: ${JSON.stringify(data)}\n\n`);

          return stream !== undefined;
        },
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
