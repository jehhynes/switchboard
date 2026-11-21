import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { pipeline } from 'node:stream';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { HubIdentity } from '@switchboard/core';
import { ARTIFACT_CSP, CONSOLE_QUEUE_BYTES, cookieValue, deviceId, deviceLabel, PAGE_COOKIE, PAGE_CSP, pageCookie, pageOrigin, PAIR_CSP, pairHtml, PUBLIC_PAGE_FILES, SIGNED_OUT_HTML } from './page.js';
import type { PageAccess, PageOrigin, RemoteAccess } from './page.js';
import { MAX_UPLOAD_BYTES } from './uploads.js';

export interface Reply {
  status: number;
  body: unknown;
}

export interface HubServerOptions {
  identity: HubIdentity;
  onShutdown(): void;
  /** `POST /restart`, from `hub.js restart`: restarts the hub onto the installed build once it is quiet (architecture.md § Hub lifecycle). */
  onRestart?(): Reply;
  /** Handlers for authorized `POST` paths, given the parsed JSON body and what only the server knows. */
  post?: Record<string, (body: unknown, context?: PostContext) => Promise<Reply>>;
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
  /** The window in front changed: its key, or null while no window with a key has the focus, and when (architecture.md § Voice). */
  focusChanged?: (key: string | null, at: number) => void;
  /** The web page (architecture.md § Web page); without it the hub serves none. */
  page?: PageRoutes;
  /** The hub's build, which `/page/ping` answers, so a page can tell a hub that serves another page. */
  build?: string;
  heartbeatMs?: number;
  now?: () => number;
}

/** What a `POST` handler may ask the server. */
export interface PostContext {
  /** The web page's address, `http://127.0.0.1:<port>/page/`, on its fixed port once it is known whether the page listens there, else the hub's. */
  pageUrl(): Promise<string>;
}

/** What the web page's routes read (architecture.md § Web page). */
export interface PageRoutes {
  access: PageAccess;
  /** The remote hosts and logins the page is served to through `tailscale serve` (architecture.md § Remote access); none without it. */
  remote?(): RemoteAccess;
  /** A file of the page itself, by its name under `/page/`, `index.html` for the page; null for none. */
  asset(name: string): { mime: string; body: Buffer | string; immutable?: boolean; gzip?: Buffer } | null;
  /** Registers a page's conversation stream, `installed` when it runs as the installed app, and returns its page key. */
  opened(installed?: boolean): string;
  isPage(key: string): boolean;
  list(): unknown;
  /** The `@` picker's files for a page key, or null with no selection. */
  files(key: string, query: string): Promise<unknown>;
  /** An artifact's file for a page key, or null outside its scope. */
  artifact(key: string, name: string): { path: string; mime: string; sandboxed: boolean } | null;
  /** Writes a file the page's composer attaches, for a page key at the `scopeGen` it showed: `{path, image}`, or why not. */
  upload(key: string, scopeGen: number, name: string, bytes: Uint8Array): Reply;
  /**
   * Opens a page's console on a session (architecture.md § Web page), writing its SSE events with `send` and ending the stream with `end`; a refusal
   * with no stream for a key that is not a page's or a session it does not show.
   */
  console?(key: string, sessionId: string, send: (event: string, data: unknown) => boolean, end: () => void): { close(): void } | { status: number; error: string };
  /**
   * A change route's answer for a page key (`CHANGE_ROUTES`, architecture.md § Web page), given the request's query and `If-None-Match`, with an
   * `ETag` when it has one; without it the hub serves none.
   */
  changes?(route: string, key: string, query: URLSearchParams, ifNoneMatch: string | undefined): Promise<Reply & { etag?: string }>;
}

/** The page's read-only change routes, under `/v1/conversation/` (architecture.md § Web page). */
export const CHANGE_ROUTES = new Set(['changes', 'diff']);

/** The least JSON body sent gzipped to a client that takes it. */
const GZIP_MIN_BYTES = 1024;

/**
 * The conversation commands a page may post with its cookie; never `new-conversation`, since a page hosts none: its New conversation… is
 * `page-conversation`, hosted by the shown conversation's folder. `row-action`, `row-paste`, `resume`, `prompt`, `prompt-key` and `console-input` take only a page key.
 * The hub itself answers `page-pair`, `page-devices` and `page-device-revoke` (architecture.md § Remote access).
 */
export const PAGE_COMMANDS = new Set(['send', 'history', 'seen', 'select', 'statuses', 'commands', 'answer', 'talk-here', 'stop-speaking', 'speak-replies', 'replay', 'personas', 'persona', 'page-focus', 'row-action', 'row-paste', 'row-open', 'row-command', 'pool-action', 'resume', 'prompt', 'prompt-key', 'mic', 'composer', 'providers', 'page-conversation', 'console-input', 'page-source', 'page-tabs', 'page-search', 'page-poll', 'page-history', 'page-holder-restart', 'page-adhoc', 'page-folder-conversation', 'pane-pair', 'pane-rect', 'page-pair', 'page-devices', 'page-device-revoke', 'page-settings-read', 'page-settings-check', 'page-settings-save', 'page-voice-enroll']);

/**
 * The page commands a device that reaches the page through a remote host may not post (architecture.md § Remote access): pairing and the device
 * list, so a paired device cannot pair others or sign this computer out; the Chrome pane's, which works only beside this computer's page;
 * restarting the terminal holder; and Settings', which the operator keeps to this computer.
 */
export const LOCAL_PAGE_COMMANDS = new Set(['page-pair', 'page-devices', 'page-device-revoke', 'pane-pair', 'pane-rect', 'page-holder-restart', 'page-settings-read', 'page-settings-check', 'page-settings-save', 'page-voice-enroll']);

/** The page routes only the hub token reaches, which the page's own routes never answer. */
const HUB_PAGE_ROUTES = new Set(['/page/link', '/page/revoke', '/page/pair', '/page/devices']);

/** The page commands the hub answers itself: pairing a device and the device list (architecture.md § Remote access). */
const DEVICE_COMMANDS = new Set(['page-pair', 'page-devices', 'page-device-revoke']);

/** Why a pairing link cannot be made with no remote host and login. */
export const REMOTE_OFF = 'Pairing a device needs remote access: set web.tailscale to true, or web.remoteHosts and web.remoteLogins, in settings.json, run tailscale serve, and restart the hub.';

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
  /**
   * Serves the web page on `port` too, its fixed port (architecture.md § Web page), trying again while the port is taken for up to `waitMs`, as by a
   * hub that is stopping. Answers null once it listens, or why not; a page link waits for the answer and then names this port, or the hub's own.
   */
  listenPage(port: number, waitMs?: number): Promise<string | null>;
  /** Builds no more views, so nothing reads the app after it closes; streams that open get only `hello`. */
  stopViews(): void;
  /** `POST` requests on the hub's and the page's ports not yet answered, so the hub restarts only between them (architecture.md § Hub lifecycle). */
  inFlight(): number;
  /** Answers every later `POST` 503 with `reason`, the first one given, while the hub hands over to its successor or stops. */
  hold(reason: string): void;
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
/** How long the page's fixed port is tried again while taken. */
const PAGE_PORT_WAIT_MS = 3_000;
const BODY_LIMIT = 1024 * 1024;

/** The JSON body of a request; an empty body is `{}` when `emptyOk`. */
function readJson(request: IncomingMessage, emptyOk = false): Promise<unknown> {
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
        resolve(emptyOk && text === '' ? {} : JSON.parse(text));
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

/** A JSON answer gzipped when the client takes gzip and it is large enough to gain, with its `ETag`, and 304 for a matching `If-None-Match`. */
function jsonCompressed(request: IncomingMessage, response: ServerResponse, reply: Reply & { etag?: string }): void {
  const etag = reply.etag === undefined ? {} : { ETag: `"${reply.etag}"` };

  if (reply.etag !== undefined && reply.status === 200 && request.headers['if-none-match'] === `"${reply.etag}"`) {
    response.writeHead(304, { ...etag, 'Cache-Control': 'no-cache' });
    response.end();
    return;
  }

  const text = JSON.stringify(reply.body);
  const gzip = text.length >= GZIP_MIN_BYTES && /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));

  response.writeHead(reply.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', ...etag, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
  response.end(gzip ? gzipSync(text) : text);
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
  let inFlight = 0;
  let held: string | null = null;

  /** Counts a `POST` until its answer, or answers it 503 while the hub hands over; true when it was answered. */
  const admit = (request: IncomingMessage, response: ServerResponse): boolean => {
    // `/restart` and `/shutdown` ask for the restart or the stop itself, so they do not hold it off.
    if (request.method !== 'POST' || request.url === '/restart' || request.url === '/shutdown') {
      return false;
    }

    if (held !== null) {
      request.resume();
      json(response, 503, { error: held });
      return true;
    }

    inFlight++;
    response.once('close', () => inFlight--);

    return false;
  };

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

  // The key of the window in front as last reported, so a change is reported once.
  let focusedKey: string | null = null;
  const focusMoved = (): void => {
    const key = front === null ? null : (keys.get(front) ?? null);

    if (key !== focusedKey) {
      focusedKey = key;
      options.focusChanged?.(key, frontAt);
    }
  };
  const windowsChanged = (): void => {
    focusMoved();

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

  // The hub's port, known once the server listens, and the page's fixed port once its listener listens, or why it does not.
  let ownPort = 0;
  let pageServer: Server | null = null;
  let pagePort: number | null = null;
  let pageNotice: string | null = null;
  let pageReady: Promise<unknown> = Promise.resolve();
  // Open page streams and the sign-in each opened with, so a revoke ends them all and a sign-in replaced ends its own.
  const pageStreams = new Map<ServerResponse, string | null>();
  // Where each open page key's stream came from, this computer or a remote host and login, so its artifact links work only from there.
  const pageKeyOrigins = new Map<string, string>();
  const originOf = (origin: PageOrigin): string => (origin.host === null ? 'local' : `${origin.host} ${origin.login}`);
  const page = options.page;

  /** Ends the open page streams of one sign-in, by its stored key, or of every sign-in. */
  const endPages = (session?: string): void => {
    for (const [stream, one] of pageStreams) {
      if (session === undefined || one === session) {
        stream.end();
      }
    }
  };
  /** A pairing link for the first remote host (architecture.md § Remote access), or why not while remote access is off. */
  const pairing = (): Reply => {
    const remote = page?.remote?.() ?? { hosts: [], logins: [] };
    const host = remote.hosts[0];

    return host === undefined || remote.logins.length === 0 || page === undefined ? { status: 409, body: { error: REMOTE_OFF } } : { status: 200, body: page.access.pair(host) };
  };
  /** The remembered sign-ins, with `current` on the one a Cookie header holds. */
  const devices = (cookie?: string): Reply => {
    const current = page?.access.sessionOf(cookie) ?? null;

    return { status: 200, body: { devices: (page?.access.devices() ?? []).map((one) => ({ ...one, current: current !== null && deviceId(current) === one.id })) } };
  };
  /** Signs one device out by its ID and ends its open pages. */
  const revokeDevice = (id: unknown): Reply => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}$/i.test(id)) {
      return { status: 400, body: { error: 'Expected {id}, a device ID of 8 hex characters.' } };
    }

    const hash = page?.access.revoke(id) ?? null;

    if (hash === null) {
      return { status: 404, body: { error: `No device has the ID ${id}.` } };
    }

    endPages(hash);
    return { status: 200, body: { revoked: 1 } };
  };
  /** A device command the page posts, which the hub answers itself; null for any other command. */
  const devicesRoute = (command: string, body: unknown, cookie: string | undefined): Reply | null =>
    command === 'page-pair' ? pairing() : command === 'page-devices' ? devices(cookie) : command === 'page-device-revoke' ? revokeDevice((body as { id?: unknown } | null)?.id) : null;

  /** The web page's routes (architecture.md § Web page); false for any other request. */
  const servePage = (request: IncomingMessage, response: ServerResponse, url: URL): boolean => {
    const path = url.pathname;
    const isPageRoute = path === '/' || path === '/page' || path.startsWith('/page/') || path === '/v1/page/list' || path.startsWith('/v1/conversation/artifact/') || (path === '/v1/conversation/events' && url.searchParams.has('page')) || path === '/v1/conversation/files' || path === '/v1/conversation/console' || (path.startsWith('/v1/conversation/') && CHANGE_ROUTES.has(path.slice('/v1/conversation/'.length)));
    const bearer = request.headers.authorization !== undefined;
    const cookiePost = request.method === 'POST' && !bearer && path.startsWith('/v1/conversation/') && request.headers.cookie !== undefined;

    if (page === undefined || (!isPageRoute && !cookiePost) || (request.method === 'POST' && HUB_PAGE_ROUTES.has(path))) {
      return false;
    }

    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    // Another name for this machine, as a DNS rebinding attack uses, never reaches the page, nor a proxied request that does not come from an
    // allowed remote host and login over HTTPS (architecture.md § Remote access). The port is the one the request came in on.
    const origin = pageOrigin(request.headers, request.socket.remoteAddress, request.socket.localPort ?? 0, page.remote?.() ?? { hosts: [], logins: [] });

    if ('refused' in origin) {
      json(response, 403, { error: origin.refused });
      return true;
    }

    const remote = origin.host !== null;

    if (remote) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }

    if (request.method === 'GET' && path === '/') {
      response.writeHead(303, { Location: '/page/', 'Cache-Control': 'no-store' });
      response.end();
      return true;
    }

    // An artifact's own files, which its sandboxed frame loads without the cookie, are read by the page key in their path, only from where the
    // page that holds the key signed in (architecture.md § Remote access).
    if (request.method === 'GET' && path.startsWith('/v1/conversation/artifact/')) {
      const [key = '', ...rest] = path.slice('/v1/conversation/artifact/'.length).split('/');
      let name = '';

      try {
        name = rest.map(decodeURIComponent).join('/');
      } catch {
        // A malformed name is not found.
      }

      const file = page.isPage(key) && pageKeyOrigins.get(key) === originOf(origin) ? page.artifact(key, name) : null;

      if (file === null) {
        json(response, 404, { error: 'No such artifact here.' });
        return true;
      }

      response.writeHead(200, { 'Content-Type': file.mime, 'Cache-Control': 'no-cache', ...(file.sandboxed ? { 'Content-Security-Policy': ARTIFACT_CSP } : {}) });
      pipeline(createReadStream(file.path), response, () => {});
      return true;
    }

    if (request.method === 'GET' && path === '/page') {
      const previous = page.access.sessionOf(request.headers.cookie);
      const code = remote ? url.searchParams.get('code') : null;
      const label = deviceLabel(request.headers['user-agent']);

      // A remote host with neither a link's token nor a code asks for the code.
      if (remote && code === null && !url.searchParams.has('t')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': PAIR_CSP });
        response.end(pairHtml(false));
        return true;
      }

      const cookie = code !== null ? page.access.exchangeCode(code, request.headers.cookie, origin, label) : page.access.exchange(url.searchParams.get('t') ?? '', request.headers.cookie, origin, label);

      if (cookie === null && remote) {
        response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': PAIR_CSP });
        response.end(pairHtml(true));
        return true;
      }

      if (cookie === null) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('This link was used or has expired. Open a new one with Switchboard: Open Web Page in VS Code, or hub.js web.\n');
        return true;
      }

      for (const [stream, session] of pageStreams) {
        if (session !== null && session === previous) {
          stream.end();
        }
      }

      response.writeHead(303, { 'Set-Cookie': pageCookie(cookie, remote), Location: '/page/', 'Cache-Control': 'no-store' });
      response.end();
      return true;
    }

    /** A file of the page, under the page's own headers. */
    const sendAsset = (name: string): void => {
      const asset = page.asset(name);

      if (asset === null) {
        json(response, 404, { error: 'not found' });
        return;
      }

      // A file that never changes under its name, as the diff viewer's under its build, is kept by the browser and goes gzipped when taken.
      const gzip = asset.gzip !== undefined && /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));

      response.writeHead(200, {
        'Content-Type': asset.mime,
        'Cache-Control': asset.immutable === true ? 'private, max-age=31536000, immutable' : 'no-cache',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': PAGE_CSP,
        ...(asset.gzip === undefined ? {} : { Vary: 'Accept-Encoding' }),
        ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
      });

      if (gzip) {
        response.end(asset.gzip);
        return;
      }

      // The page learns the build of the hub that served it, so it can tell when a restarted hub serves another page.
      response.end(name === 'index.html' ? String(asset.body).replaceAll('{{build}}', options.build ?? '') : asset.body);
    };

    // The installed page's manifest, icons, service worker and offline page, which a browser fetches without the cookie.
    if (request.method === 'GET' && path.startsWith('/page/') && PUBLIC_PAGE_FILES.has(path.slice('/page/'.length))) {
      sendAsset(path.slice('/page/'.length));
      return true;
    }

    // Whether the hub answers, and which build, for the offline page and a page that lost its stream.
    if (request.method === 'GET' && path === '/page/ping') {
      json(response, 200, { build: options.build ?? '' });
      return true;
    }

    if (!page.access.allows(request.headers.cookie, origin)) {
      if (request.method === 'GET' && path === '/page/') {
        response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': remote ? PAIR_CSP : PAGE_CSP });
        response.end(remote ? pairHtml(false) : SIGNED_OUT_HTML);
      } else {
        json(response, 401, { error: 'unauthorized' });
      }

      return true;
    }

    // Each signed-in request renews the cookie's Max-Age, as it renews the sign-in, so a computer in use stays signed in.
    response.setHeader('Set-Cookie', pageCookie(cookieValue(request.headers.cookie, PAGE_COOKIE)!, remote));

    if (request.method === 'GET' && path.startsWith('/page/')) {
      sendAsset(path === '/page/' ? 'index.html' : path.slice('/page/'.length));
      return true;
    }

    if (request.method === 'GET' && path === '/v1/conversation/events') {
      let key: string | null = page.opened(url.searchParams.get('installed') === '1');

      pageKeyOrigins.set(key, originOf(origin));
      openConversation(request, response, key);
      pageStreams.set(response, page.access.sessionOf(request.headers.cookie));
      request.on('close', () => {
        pageStreams.delete(response);

        if (key !== null) {
          pageKeyOrigins.delete(key);
          options.windowClosed?.(key);
          key = null;
        }
      });
      return true;
    }

    if (request.method === 'GET' && path === '/v1/page/list') {
      json(response, 200, { groups: page.list() });
      return true;
    }

    const window = url.searchParams.get('window') ?? '';

    // The console of the page's selected conversation (architecture.md § Web page): the held session's screen and output as SSE events.
    if (request.method === 'GET' && path === '/v1/conversation/console') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const send = (event: string, data: unknown): boolean => {
        if (response.writableEnded) {
          return false;
        }

        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return response.writableLength <= CONSOLE_QUEUE_BYTES;
      };
      const end = (): void => {
        pageStreams.delete(response);
        response.end();
      };

      if (page.console === undefined) {
        json(response, 404, { error: 'not found' });
        return true;
      }

      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      pageStreams.set(response, page.access.sessionOf(request.headers.cookie));

      const opened = page.console(window, sessionId, send, end);

      if ('status' in opened) {
        send('unavailable', { reason: opened.error });
        end();
        return true;
      }

      request.on('close', () => {
        pageStreams.delete(response);
        opened.close();
      });
      return true;
    }

    if (request.method === 'GET' && path === '/v1/conversation/files') {
      if (!page.isPage(window)) {
        json(response, 403, { error: 'Not in this window.' });
        return true;
      }

      void page.files(window, url.searchParams.get('q') ?? '').then(
        (files) => json(response, files === null ? 403 : 200, files === null ? { error: 'Not in this window.' } : { files }),
        (error: unknown) => json(response, 500, { error: String(error) }),
      );
      return true;
    }

    // The selected conversation's worktree changes (architecture.md § Web page), read for a page key.
    if (request.method === 'GET' && CHANGE_ROUTES.has(path.slice('/v1/conversation/'.length))) {
      if (page.changes === undefined) {
        json(response, 404, { error: 'not found' });
        return true;
      }

      if (!page.isPage(window)) {
        json(response, 403, { error: 'Not in this window.' });
        return true;
      }

      const ifNoneMatch = request.headers['if-none-match'];

      void page.changes(path.slice('/v1/conversation/'.length), window, url.searchParams, typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined).then(
        (reply) => jsonCompressed(request, response, reply),
        (error: unknown) => json(response, 500, { error: String(error) }),
      );
      return true;
    }

    // A file the composer attaches: its bytes as the body, with its length, from the page's own origin, for a page key, at most 10 MB.
    if (request.method === 'POST' && path === '/v1/conversation/upload') {
      const length = Number(request.headers['content-length']);
      const refuse = (status: number, error: string): void => {
        // The body is not read, so the connection closes rather than wait for it.
        response.setHeader('Connection', 'close');
        json(response, status, { error });
      };

      if (request.headers.origin !== origin.origin) {
        refuse(403, 'The page posts only from its own origin.');
      } else if (!page.isPage(window)) {
        refuse(403, 'Not in this window.');
      } else if (!Number.isSafeInteger(length) || request.headers['transfer-encoding'] !== undefined) {
        refuse(411, 'Send the file with its length.');
      } else if (length > MAX_UPLOAD_BYTES) {
        refuse(413, `${url.searchParams.get('name') || 'The file'} is larger than 10 MB.`);
      } else {
        const chunks: Buffer[] = [];

        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const reply = page.upload(window, Number(url.searchParams.get('scopeGen') ?? NaN), url.searchParams.get('name') ?? '', Buffer.concat(chunks));

          json(response, reply.status, reply.body);
        });
        request.on('error', () => response.destroy());
      }

      return true;
    }

    // A command a page posts: from the page's own origin, naming a page key, and only a conversation command.
    const command = path.slice('/v1/conversation/'.length);
    const handler = options.post?.[path];

    if (request.method !== 'POST' || !PAGE_COMMANDS.has(command) || (handler === undefined && !DEVICE_COMMANDS.has(command))) {
      json(response, 404, { error: 'not found' });
      return true;
    }

    if (request.headers.origin !== origin.origin) {
      json(response, 403, { error: 'The page posts only from its own origin.' });
      return true;
    }

    if (remote && LOCAL_PAGE_COMMANDS.has(command)) {
      json(response, 403, { error: 'Do this from the page on the computer that runs Switchboard.' });
      return true;
    }

    readJson(request).then(
      (body) => {
        const key = (body as { window?: unknown } | null)?.window;

        if (typeof key !== 'string' || !page.isPage(key)) {
          json(response, 403, { error: 'Not in this window.' });
          return;
        }

        const own = devicesRoute(command, body, request.headers.cookie);

        if (own !== null) {
          json(response, own.status, own.body);
          return;
        }

        handler!(body).then(
          (reply) => json(response, reply.status, reply.body),
          (error: unknown) => json(response, 500, { error: String(error) }),
        );
      },
      (error: Error) => json(response, 400, { error: error.message }),
    );
    return true;
  };

  /** A listener on the page's fixed port, which serves the page's routes and nothing else. */
  const listenPageOnce = (port: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const one = createServer((request, response) => {
        if (admit(request, response)) {
          return;
        }

        if (!servePage(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))) {
          json(response, 404, { error: 'not found' });
        }
      });

      one.once('error', reject);
      one.listen(port, '127.0.0.1', () => {
        one.off('error', reject);
        resolve(one);
      });
    });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (admit(request, response)) {
      return;
    }

    if (servePage(request, response, url)) {
      return;
    }

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
    } else if (request.method === 'POST' && path === '/page/link' && page !== undefined) {
      // A one-time link to the web page, which VS Code's Open Web Page and `hub.js web` hand out (architecture.md § Web page), on the page's
      // fixed port once it is known whether the page listens there.
      void pageReady.then(() =>
        json(response, 200, { url: `http://127.0.0.1:${pagePort ?? ownPort}/page?t=${page.access.token()}`, ...(pageNotice === null ? {} : { notice: pageNotice }) }),
      );
    } else if (request.method === 'POST' && path === '/page/revoke' && page !== undefined) {
      // Signs every browser out of the web page and ends the open pages' streams (architecture.md § Web page).
      // With {id}, signs out that device only (architecture.md § Remote access).
      readJson(request, true).then(
        (body) => {
          const id = (body as { id?: unknown } | null)?.id;

          if (id !== undefined) {
            const reply = revokeDevice(id);

            json(response, reply.status, reply.body);
            return;
          }

          const revoked = page.access.revokeAll();

          endPages();
          json(response, 200, { revoked });
        },
        (error: Error) => json(response, 400, { error: error.message }),
      );
    } else if (request.method === 'POST' && path === '/page/pair' && page !== undefined) {
      // A pairing link and code for a device on a remote host (architecture.md § Remote access).
      const reply = pairing();

      json(response, reply.status, reply.body);
    } else if (request.method === 'POST' && path === '/page/devices' && page !== undefined) {
      const reply = devices();

      json(response, reply.status, reply.body);
    } else if (request.method === 'POST' && path === '/shutdown') {
      json(response, 200, { stopping: true });
      options.onShutdown();
    } else if (request.method === 'POST' && path === '/restart' && options.onRestart !== undefined) {
      const reply = options.onRestart();

      request.resume();
      json(response, reply.status, reply.body);
    } else if (request.method === 'POST' && options.post?.[path] !== undefined) {
      const handler = options.post[path];

      readJson(request).then(
        (body) =>
          handler(body, { pageUrl: () => pageReady.then(() => `http://127.0.0.1:${pagePort ?? ownPort}/page/`) }).then(
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

      ownPort = port;

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
        listenPage: (wanted, waitMs = PAGE_PORT_WAIT_MS) => {
          const listened = (async (): Promise<string | null> => {
            for (const deadline = Date.now() + waitMs; ; ) {
              if (closing) {
                return 'the hub is stopping';
              }

              try {
                const one = await listenPageOnce(wanted);

                if (closing) {
                  one.close();
                  return 'the hub is stopping';
                }

                pageServer = one;
                pagePort = wanted;
                return null;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || Date.now() >= deadline) {
                  pageNotice = `The web page is not on port ${wanted} (${String(error)}), so this link names the hub's own port, which changes at each hub start, and an installed page cannot reach it. Free port ${wanted} or set web.port in settings.json, then restart the hub.`;
                  return String(error);
                }

                await new Promise((done) => setTimeout(done, 250));
              }
            }
          })();

          pageReady = listened;
          return listened;
        },
        stopViews: () => {
          closing = true;
        },
        inFlight: () => inFlight,
        hold: (reason) => {
          // The first reason stays, such as a restart's, which is why a stop that follows it refuses.
          held ??= reason;
        },
        close: () =>
          new Promise<void>((done) => {
            closing = true;
            clearInterval(heartbeat);

            for (const stream of streams.keys()) {
              stream.end();
            }

            let open = pageServer === null ? 1 : 2;
            const closed = (): void => {
              if (--open === 0) {
                done();
              }
            };

            server.close(closed);
            server.closeAllConnections();
            pageServer?.close(closed);
            pageServer?.closeAllConnections();
          }),
      });
    });
  });
}
