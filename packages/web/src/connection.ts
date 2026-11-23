// The page's connection to its hub (architecture.md § Web page, Connection): one state for every surface, the same on this computer and on a
// paired device. The page owns its stream: it closes it on any error and opens a new one with backoff, never leaving it to the browser's own
// reconnect, so a refused connection and the 502 `tailscale serve` answers for a stopped hub behave the same. It never reloads the page.

/**
 * - `connecting`: no `hello` yet since the page started.
 * - `live`: events arrive; the last one, or the hub's `tick`, is under {@link WATCHDOG_MS} old.
 * - `reconnecting`: lost under {@link GRACE_MS} ago; nothing the operator sees changes.
 * - `offline`: lost for longer, or never connected within {@link GRACE_MS} of the start.
 * - `signedOut`: the hub answers, but this browser's sign-in is gone.
 */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'signedOut';

/** How long a lost connection may come back before the page says it is offline. */
export const GRACE_MS = 4_000;
/** A live stream silent this long, the hub's 15 s `tick` included, is taken for dead and opened again. */
export const WATCHDOG_MS = 40_000;
/** A page that comes back to the front, or online, with its last event older than this opens its stream again at once. */
export const WAKE_STALE_MS = 20_000;
/** How often the watchdog looks. */
export const WATCH_EVERY_MS = 5_000;
/** The waits between attempts, the last repeating, each varied by up to {@link JITTER} either way. */
export const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
export const JITTER = 0.2;
/** How long one `/page/ping` may take. */
export const PING_TIMEOUT_MS = 5_000;
/** How long a stream may take to bring its `hello` before it is given up and tried again. */
export const HELLO_MS = 10_000;

/** The part of an `EventSource` the connection uses. */
export interface Stream {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export interface ConnectionDeps {
  /** Opens the page's conversation stream. */
  open(): Stream;
  /** The stream's event types the page reads; each event goes to `event`. */
  events: readonly string[];
  event(type: string, data: string): void;
  fetch(url: string, init: RequestInit): Promise<{ ok: boolean; json(): Promise<unknown> }>;
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  /** 0 to 1; `Math.random` when left out. */
  random?(): number;
  /** The build of the hub that served the page, or null when unknown. */
  build: string | null;
  /** The state, `update` or `nextAt` changed. */
  changed(): void;
}

export class Connection {
  state: ConnectionState = 'connecting';
  /** When the state last changed. */
  since: number;
  /** When an event last arrived, or null before the first. */
  lastEventAt: number | null = null;
  /** When the connection was last live: the time it was lost while it is not. */
  lastLiveAt: number | null = null;
  /** The hub runs another build than the page's: the page offers a reload and never reloads by itself. */
  update = false;
  /** When the next attempt runs, or null while none waits. */
  nextAt: number | null = null;
  #source: Stream | null = null;
  #attempts = 0;
  #retry: unknown = null;
  #grace: unknown = null;
  #watch: unknown = null;
  #hello: unknown = null;
  #asking = false;
  #closed = false;
  readonly #waiters = new Set<() => void>();

  constructor(private readonly deps: ConnectionDeps) {
    this.since = deps.now();
  }

  /** Opens the stream; the page is offline if no `hello` comes within {@link GRACE_MS}. */
  start(): void {
    this.#open();
    this.#startGrace();
    this.#watchLater();
  }

  /** Whether commands can go now: live, or lost only within the grace period. */
  get usable(): boolean {
    return this.state === 'live' || this.state === 'reconnecting';
  }

  /** Tries at once, as Retry or Try now asks, and starts the backoff again. */
  retryNow(): void {
    if (this.#closed || this.state === 'live') {
      return;
    }

    // A stream still opening may hang as long as the network lets it: it is given up for a new one.
    this.#drop();
    this.#attempts = 0;
    this.#clearRetry();
    this.#attempt();
  }

  /**
   * The page came to the front, back online or out of the back-forward cache: a live stream silent for {@link WAKE_STALE_MS} is opened again,
   * and a lost one is tried at once.
   */
  wake(): void {
    if (this.#closed || this.state === 'signedOut') {
      return;
    }

    if (this.state === 'live') {
      if (this.deps.now() - (this.lastEventAt ?? 0) > WAKE_STALE_MS) {
        this.#lost(this.#source);
        this.retryNow();
      }

      return;
    }

    this.retryNow();
  }

  /** Asks the hub whether this browser is still signed in, as after a 401, leaving a live stream open unless it is not. */
  check(): void {
    if (!this.#closed && this.state !== 'signedOut') {
      this.#ask(false);
    }
  }

  /** Resolves true once live, or false after `ms` or when the connection is offline or signed out. */
  whenLive(ms: number): Promise<boolean> {
    if (this.state === 'live') {
      return Promise.resolve(true);
    }

    if (this.state === 'offline' || this.state === 'signedOut' || this.#closed) {
      return Promise.resolve(false);
    }

    return new Promise((done) => {
      const finish = (): void => {
        this.deps.clearTimeout(timer);
        this.#waiters.delete(finish);
        done(this.state === 'live');
      };
      const timer = this.deps.setTimeout(finish, ms);

      this.#waiters.add(finish);
    });
  }

  close(): void {
    this.#closed = true;
    this.#drop();
    this.#clearRetry();
    this.deps.clearTimeout(this.#grace);
    this.deps.clearTimeout(this.#watch);
    this.#settle();
  }

  #open(): void {
    const source = this.deps.open();

    this.#source = source;
    this.deps.clearTimeout(this.#hello);
    this.#hello = this.deps.setTimeout(() => this.#lost(source), HELLO_MS);

    for (const type of [...this.deps.events, 'tick']) {
      source.addEventListener(type, (event) => {
        if (this.#source !== source) {
          return;
        }

        this.lastEventAt = this.deps.now();

        if (type !== 'tick') {
          this.deps.event(type, String(event.data));
        }

        if (type === 'hello') {
          this.#live();
        }
      });
    }

    source.addEventListener('error', () => this.#lost(source));
  }

  #live(): void {
    const changed = this.state !== 'live';

    this.deps.clearTimeout(this.#hello);
    this.#hello = null;
    this.#attempts = 0;
    this.#clearRetry();
    this.deps.clearTimeout(this.#grace);
    this.#grace = null;
    this.lastLiveAt = this.deps.now();

    if (changed) {
      this.#set('live');
    }

    this.#settle();
  }

  /** The stream failed or went silent: it is closed, and an attempt waits its turn. */
  #lost(source: Stream | null): void {
    if (this.#closed || source !== this.#source) {
      return;
    }

    this.#drop();

    if (this.state === 'live') {
      this.lastLiveAt = this.deps.now();
      this.#set('reconnecting');
      this.#startGrace();
    }

    this.#later();
  }

  /** Closes the stream, opened or still opening. */
  #drop(): void {
    this.deps.clearTimeout(this.#hello);
    this.#hello = null;
    this.#source?.close();
    this.#source = null;
  }

  #startGrace(): void {
    this.deps.clearTimeout(this.#grace);
    this.#grace = this.deps.setTimeout(() => {
      this.#grace = null;

      if (this.state === 'connecting' || this.state === 'reconnecting') {
        this.#set('offline');
        this.#settle();
      }
    }, GRACE_MS);
  }

  /** Waits the backoff's next wait, then tries. */
  #later(): void {
    if (this.#retry !== null || this.#asking || this.state === 'signedOut') {
      return;
    }

    const base = BACKOFF_MS[Math.min(this.#attempts, BACKOFF_MS.length - 1)]!;
    const wait = Math.round(base * (1 + JITTER * (2 * (this.deps.random?.() ?? Math.random()) - 1)));

    this.#attempts++;
    this.nextAt = this.deps.now() + wait;
    this.#retry = this.deps.setTimeout(() => {
      this.#retry = null;
      this.#attempt();
    }, wait);
    this.deps.changed();
  }

  #clearRetry(): void {
    this.deps.clearTimeout(this.#retry);
    this.#retry = null;
    this.nextAt = null;
  }

  #attempt(): void {
    this.#ask(true);
  }

  /** Asks `/page/ping` whether the hub answers, which build it runs and whether this browser is signed in, then opens the stream when `open`. */
  #ask(open: boolean): void {
    if (this.#closed || this.#asking) {
      return;
    }

    this.#asking = true;

    if (open) {
      this.nextAt = null;
      this.deps.changed();
    }

    const abort = new AbortController();
    const timer = this.deps.setTimeout(() => abort.abort(), PING_TIMEOUT_MS);
    const done = (answer: { build?: unknown; signedIn?: unknown } | null): void => {
      this.deps.clearTimeout(timer);
      this.#asking = false;

      if (this.#closed) {
        return;
      }

      if (answer === null) {
        this.#resumeAfterCheck(open);
        return;
      }

      if (typeof answer.build === 'string' && answer.build !== '' && this.deps.build !== null && answer.build !== this.deps.build && !this.update) {
        this.update = true;
        this.deps.changed();
      }

      if (answer.signedIn === false) {
        this.#drop();
        this.#clearRetry();
        this.deps.clearTimeout(this.#grace);
        this.#grace = null;
        this.#set('signedOut');
        this.#settle();
        return;
      }

      if (open) {
        this.#open();
      } else {
        this.#resumeAfterCheck(false);
      }
    };

    void this.deps.fetch('/page/ping', { cache: 'no-store', credentials: 'same-origin', signal: abort.signal }).then(
      async (response) => done(response.ok ? (((await response.json().catch(() => null)) as { build?: unknown; signedIn?: unknown } | null) ?? null) : null),
      () => done(null),
    );
  }

  /** After a sign-in check, a stream lost while it ran, whose attempt the check held back, gets its attempt. */
  #resumeAfterCheck(open: boolean): void {
    if (open || (this.#source === null && this.#retry === null && this.state !== 'live' && this.state !== 'signedOut')) {
      this.#later();
    }
  }

  #watchLater(): void {
    this.#watch = this.deps.setTimeout(() => {
      if (this.#closed) {
        return;
      }

      if (this.state === 'live' && this.deps.now() - (this.lastEventAt ?? 0) > WATCHDOG_MS) {
        this.#lost(this.#source);
      }

      this.#watchLater();
    }, WATCH_EVERY_MS);
  }

  #set(state: ConnectionState): void {
    this.state = state;
    this.since = this.deps.now();
    this.deps.changed();
  }

  #settle(): void {
    for (const waiter of [...this.#waiters]) {
      waiter();
    }
  }
}
