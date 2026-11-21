import { BROWSER_PORT } from './hub.js';

/** The hub's pane socket (architecture.md § Pane socket). */
export const PANE_SOCKET_URL = `ws://127.0.0.1:${BROWSER_PORT}/pane`;
/** How often the extension sends a message on its socket; Chrome keeps the service worker alive while one goes within every 30 s. */
export const PING_MS = 20_000;
/** The first wait before trying again; each further try waits twice as long, up to {@link RETRY_MAX_MS}. */
export const RETRY_MS = 5_000;
export const RETRY_MAX_MS = 5 * 60_000;
/** Tries after which the extension stops until the page pairs it again or the browser restarts. */
export const MAX_TRIES = 6;

/** The wait before try `n`, counted from 0. */
export function retryWait(n: number): number {
  return Math.min(RETRY_MS * 2 ** n, RETRY_MAX_MS);
}
/** The most links a work item's pane opens. */
export const MAX_TABS = 20;

const MARKER = /^[0-9a-f]{12}$/;

/** A marker from the hub, or null for anything else. */
export function paneMarker(value: unknown): string | null {
  return typeof value === 'string' && MARKER.test(value) ? value : null;
}

/** The links a `tabs` message names, each an http or https URL of at most 2048 characters, or null for anything else. */
export function paneLinks(urls: unknown, active: unknown): { urls: string[]; active: string } | null {
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_TABS || typeof active !== 'string' || !urls.includes(active)) {
    return null;
  }

  const valid = urls.every((url) => {
    if (typeof url !== 'string' || url.length > 2048) {
      return false;
    }

    try {
      return ['http:', 'https:'].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  });

  return valid ? { urls: urls as string[], active } : null;
}

/** The browser calls the pane needs, `chrome.windows` and `chrome.tabs` in the extension. */
export interface PaneBrowser {
  /** The marker page's URL, which titles the pane window's tab `Switchboard pane <marker>` for the dock to find it. */
  markerUrl(marker: string): string;
  isMarker(url: string): boolean;
  /** Opens a normal window on the URL; its ID. */
  createWindow(url: string): Promise<number>;
  windowExists(windowId: number): Promise<boolean>;
  tabs(windowId: number): Promise<Array<{ id: number; url: string }>>;
  openTab(windowId: number, url: string, active: boolean): Promise<number>;
  loadTab(tabId: number, url: string): Promise<void>;
  activateTab(tabId: number): Promise<void>;
  closeTab(tabId: number): Promise<void>;
}

export interface KeyValue {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface PaneRecord {
  windowId: number;
  /** The tab the pane opened for each link, by the link's URL. */
  links: Record<string, number>;
}

const RECORD = 'pane';

/**
 * The pane window (architecture.md § Browser extension): one normal window the extension opens when the hub asks, its marker tab, and one tab
 * per link of the work item the page shows. Its ID and tabs are kept in session storage, which outlives the service worker.
 */
export class PaneWindow {
  constructor(
    private readonly browser: PaneBrowser,
    private readonly session: KeyValue,
  ) {}

  async #record(): Promise<PaneRecord | null> {
    const kept = (await this.session.get(RECORD))[RECORD] as PaneRecord | undefined;

    return kept !== undefined && (await this.browser.windowExists(kept.windowId)) ? kept : null;
  }

  /** Opens the pane window, or brings its marker tab to the front, showing `marker`. */
  async mark(marker: string): Promise<void> {
    const kept = await this.#record();
    const url = this.browser.markerUrl(marker);

    if (kept === null) {
      const windowId = await this.browser.createWindow(url);

      await this.session.set({ [RECORD]: { windowId, links: {} } satisfies PaneRecord });
      return;
    }

    const shown = (await this.browser.tabs(kept.windowId)).find((tab) => this.browser.isMarker(tab.url));

    if (shown === undefined) {
      await this.browser.openTab(kept.windowId, url, true);
    } else {
      await this.browser.loadTab(shown.id, url);
      await this.browser.activateTab(shown.id);
    }
  }

  /**
   * Shows one tab per link, opening those it lacks, closing the tabs it opened for links no longer listed and the marker tab, and brings
   * `active`'s tab to the front. Tabs the operator opened stay. Does nothing without a pane window.
   */
  async show(urls: readonly string[], active: string): Promise<void> {
    const kept = await this.#record();

    if (kept === null) {
      return;
    }

    const tabs = await this.browser.tabs(kept.windowId);
    const open = new Set(tabs.map((tab) => tab.id));
    const links: Record<string, number> = {};

    for (const url of urls) {
      const tabId = kept.links[url];

      links[url] = tabId !== undefined && open.has(tabId) ? tabId : await this.browser.openTab(kept.windowId, url, false);
    }

    await this.browser.activateTab(links[active]!);

    const wanted = new Set(Object.values(links));
    const stale = [...Object.values(kept.links).filter((tabId) => open.has(tabId) && !wanted.has(tabId)), ...tabs.filter((tab) => this.browser.isMarker(tab.url)).map((tab) => tab.id)];

    for (const tabId of new Set(stale)) {
      await this.browser.closeTab(tabId);
    }

    await this.session.set({ [RECORD]: { windowId: kept.windowId, links } satisfies PaneRecord });
  }

  /** Forgets the pane when its window closed; true when it was the pane's. */
  async removed(windowId: number): Promise<boolean> {
    const kept = (await this.session.get(RECORD))[RECORD] as PaneRecord | undefined;

    if (kept?.windowId !== windowId) {
      return false;
    }

    await this.session.remove(RECORD);
    return true;
  }
}

export interface PaneSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface PaneConnectionDeps {
  socket(url: string): PaneSocketLike;
  /** Whether the hub has the pane on, from `GET /pane`; null when the hub does not answer. */
  enabled(): Promise<boolean | null>;
  window: PaneWindow;
  /** Local storage, which keeps the credential across browser restarts. */
  local: KeyValue;
  /** Session storage, which keeps the refusals across service worker restarts. */
  session: KeyValue;
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
  log(message: string, error?: unknown): void;
}

const CREDENTIAL = 'paneCredential';
/** Refused sockets since the last pairing: how many, and the time before which none is opened; `until` null stops until the page pairs. */
const REFUSED = 'paneRefused';

interface Refused {
  count: number;
  until: number | null;
}
const LOOPBACK_PAGE = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

/**
 * The extension's end of the pane socket (architecture.md § Pane socket): connects only while it has a credential or a pairing token and the
 * hub says the pane is on, pairs with a token the signed-in page hands it, keeps the service worker awake with a ping every 20 s, and carries
 * out the hub's `window` and `tabs` messages. Chrome logs every refused WebSocket handshake as an error, so the extension asks `GET /pane`
 * first, which logs nothing, and stops after {@link MAX_TRIES} refusals.
 */
export class PaneConnection {
  #socket: PaneSocketLike | null = null;
  #starting = false;
  /** A connect asked for while one was starting, such as a pairing token arriving during the check. */
  #again = false;
  #token: string | null = null;
  #ping: unknown = null;
  #retry: unknown = null;
  /** Tries since the hub last answered or a socket was last paired, while the hub does not answer or a paired socket dropped. */
  #tries = 0;
  #paired = false;
  /** A `pair` went on the open socket, whose answer follows the `unpaired` that answered its `hello`. */
  #pairSent = false;
  /** The hub's messages are carried out one at a time, in order. */
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PaneConnectionDeps) {}

  get paired(): boolean {
    return this.#paired;
  }

  /**
   * Connects unless a socket is open or opening: not without a credential or a token, not while refusals wait or stopped it unless a token
   * waits, and not while the hub says the pane is off or does not answer, which tries again later.
   */
  connect(): void {
    if (this.#socket !== null) {
      return;
    }

    if (this.#starting) {
      this.#again = true;
      return;
    }

    this.#starting = true;
    void this.#start()
      .catch(() => undefined)
      .finally(() => {
        this.#starting = false;

        if (this.#again) {
          this.#again = false;
          this.connect();
        }
      });
  }

  async #start(): Promise<void> {
    this.#cancelRetry();

    if (this.#token === null) {
      const credential = (await this.deps.local.get(CREDENTIAL))[CREDENTIAL];

      if (typeof credential !== 'string') {
        return;
      }

      const refused = (await this.deps.session.get(REFUSED))[REFUSED] as Refused | undefined;

      if (refused !== undefined && (refused.until === null || refused.until > this.deps.now())) {
        if (refused.until !== null) {
          this.#later(refused.until - this.deps.now());
        }

        return;
      }
    }

    const enabled = await this.deps.enabled();

    if (enabled !== null) {
      this.#tries = 0;
    }

    if (enabled !== true) {
      // Off: nothing to do until the page wakes the extension. No answer: the hub may be starting.
      if (enabled === null && this.#tries < MAX_TRIES) {
        this.#later(retryWait(this.#tries++));
      }

      return;
    }

    if (this.#socket === null) {
      this.#open();
    }
  }

  #open(): void {
    const socket = this.deps.socket(PANE_SOCKET_URL);
    let answered = false;

    this.#socket = socket;
    this.#pairSent = false;
    socket.onopen = () => void this.#greet(socket).catch(() => undefined);
    socket.onmessage = (event) => {
      answered = true;
      this.#received(socket, event.data);
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.#socket !== socket) {
        return;
      }

      const paired = this.#paired;

      this.#socket = null;
      this.#paired = false;
      this.deps.clearInterval(this.#ping);
      this.#ping = null;

      if (!answered) {
        // Refused before the hub answered, as with 403 while the pane is off or for another extension ID.
        void this.#refused(false).catch(() => undefined);
      } else if (paired && this.#tries < MAX_TRIES) {
        // A paired socket dropped, as when the hub restarts or the pane is turned off; the check finds which.
        this.#later(retryWait(this.#tries++));
      }
    };
  }

  #later(ms: number): void {
    this.#cancelRetry();
    this.#retry = this.deps.setTimeout(() => {
      this.#retry = null;
      this.connect();
    }, ms);
  }

  #cancelRetry(): void {
    if (this.#retry !== null) {
      this.deps.clearTimeout(this.#retry);
      this.#retry = null;
    }
  }

  /** Counts a refusal and waits twice as long each time; `stop`, or {@link MAX_TRIES} refusals, waits until the page pairs again. */
  async #refused(stop: boolean): Promise<void> {
    const kept = (await this.deps.session.get(REFUSED))[REFUSED] as Refused | undefined;
    const count = (kept?.count ?? 0) + 1;
    const until = stop || count >= MAX_TRIES ? null : this.deps.now() + retryWait(count - 1);

    await this.deps.session.set({ [REFUSED]: { count, until } satisfies Refused });

    if (until !== null) {
      this.#later(until - this.deps.now());
    }
  }

  /**
   * A message from a web page through `externally_connectable`: `wake` connects, `pair` pairs with the page's token. Only a page on a
   * loopback origin is heard, as the manifest also requires; the token itself is checked by the hub.
   */
  external(message: unknown, origin: string | undefined): { ok: true } | { error: string } {
    if (origin === undefined || !LOOPBACK_PAGE.test(origin)) {
      return { error: 'Only the Switchboard page can ask this.' };
    }

    const type = (message as { type?: unknown } | null)?.type;
    const token = (message as { token?: unknown } | null)?.token;

    if (type === 'pair' && typeof token === 'string' && token.length > 0 && token.length <= 128) {
      this.#token = token;
      this.#tries = 0;

      if (this.#socket?.readyState === 1) {
        this.#socket.send(JSON.stringify({ type: 'pair', token }));
        this.#token = null;
        this.#pairSent = true;
      } else {
        this.connect();
      }

      return { ok: true };
    }

    if (type === 'wake') {
      this.connect();
      return { ok: true };
    }

    return { error: 'Unknown request.' };
  }

  /** The pane window closed: the hub hears it, so it can open another. */
  async windowRemoved(windowId: number): Promise<void> {
    if ((await this.deps.window.removed(windowId)) && this.#socket?.readyState === 1 && this.#paired) {
      this.#socket.send(JSON.stringify({ type: 'closed' }));
    }
  }

  async #greet(socket: PaneSocketLike): Promise<void> {
    const credential = (await this.deps.local.get(CREDENTIAL))[CREDENTIAL];

    // The socket may have closed while the credential was read.
    if (this.#socket !== socket || socket.readyState !== 1) {
      return;
    }

    const token = this.#token;

    this.#token = null;

    if (token !== null) {
      this.#pairSent = true;
    }

    socket.send(JSON.stringify(token !== null ? { type: 'pair', token } : { type: 'hello', credential: typeof credential === 'string' ? credential : null }));
    this.#ping = this.deps.setInterval(() => socket.readyState === 1 && socket.send(JSON.stringify({ type: 'ping' })), PING_MS);
  }

  #received(socket: PaneSocketLike, data: unknown): void {
    let message: Record<string, unknown>;

    try {
      message = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }

    this.#queue = this.#queue
      .then(() => this.#handle(socket, message))
      .catch((error: unknown) => this.deps.log('Switchboard could not update its pane', error));
  }

  async #handle(socket: PaneSocketLike, message: Record<string, unknown>): Promise<void> {
    if (message['type'] === 'paired') {
      this.#paired = true;
      this.#tries = 0;
      await this.deps.session.remove(REFUSED);

      if (typeof message['credential'] === 'string') {
        await this.deps.local.set({ [CREDENTIAL]: message['credential'] });
      }

      return;
    }

    if (message['type'] === 'unpaired') {
      // The answer to hello: the kept credential is not the hub's, so stop until the page pairs again. The answer to a token, with its
      // error: try the kept credential again later. Either way, not while a newer token waits.
      this.#paired = false;

      if (this.#pairSent && message['error'] === undefined) {
        return;
      }

      if (this.#token === null) {
        await this.#refused(message['error'] === undefined);

        if (this.#socket === socket && this.#token === null) {
          this.#socket = null;
          this.deps.clearInterval(this.#ping);
          this.#ping = null;
          socket.close();
        }
      }

      return;
    }

    if (!this.#paired) {
      return;
    }

    const marker = paneMarker(message['marker']);

    if (message['type'] === 'window' && marker !== null) {
      await this.deps.window.mark(marker);

      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'window', marker }));
      }

      return;
    }

    const links = message['type'] === 'tabs' ? paneLinks(message['urls'], message['active']) : null;

    if (links !== null) {
      await this.deps.window.show(links.urls, links.active);
    }
  }
}
