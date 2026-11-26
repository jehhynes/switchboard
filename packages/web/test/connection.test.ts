import { describe, expect, it } from 'vitest';
import { BACKOFF_MS, Connection, GRACE_MS, HELLO_MS, PING_TIMEOUT_MS, WAKE_STALE_MS, WATCHDOG_MS } from '../src/connection.js';
import type { ConnectionDeps, Stream } from '../src/connection.js';

class FakeStream implements Stream {
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  closed = false;

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }

  close(): void {
    this.closed = true;
  }
}

type Ping = { build?: string; signedIn?: boolean } | 'down' | 'hang';

/** A connection over fake streams, pings answered from a list, a clock and timers run by hand, and random fixed at its middle (no jitter). */
function harness(pings: Ping[] = [], build: string | null = 'b1', random = 0.5) {
  let now = 0;
  const timers: Array<{ at: number; run: () => void; id: number }> = [];
  let ids = 0;
  const streams: FakeStream[] = [];
  const events: string[] = [];
  const asked: string[] = [];
  let changes = 0;
  const deps: ConnectionDeps = {
    open: () => {
      const stream = new FakeStream();

      streams.push(stream);
      return stream;
    },
    events: ['hello', 'list'],
    event: (type, data) => events.push(`${type} ${data}`),
    fetch: (url, init) => {
      asked.push(url);

      const ping = pings.shift() ?? 'down';

      if (ping === 'hang') {
        return new Promise((_, fail) => init.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError'))));
      }

      return ping === 'down' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({ ok: true, json: async () => ping });
    },
    now: () => now,
    setTimeout: (run, ms) => {
      timers.push({ at: now + ms, run, id: ++ids });
      return ids;
    },
    clearTimeout: (id) => {
      const at = timers.findIndex((one) => one.id === id);

      if (at !== -1) {
        timers.splice(at, 1);
      }
    },
    random: () => random,
    build,
    changed: () => void changes++,
  };
  const connection = new Connection(deps);
  /** Moves the clock on by `ms`, running each timer due on the way, and the promises they start. */
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms;

    for (;;) {
      await new Promise((done) => setImmediate(done));
      timers.sort((a, b) => a.at - b.at);

      const next = timers[0];

      if (next === undefined || next.at > end) {
        break;
      }

      timers.shift();
      now = next.at;
      next.run();
    }

    now = end;
    await new Promise((done) => setImmediate(done));
  };
  const last = (): FakeStream => streams.at(-1)!;

  return { connection, streams, events, asked, advance, last, changes: () => changes, now: () => now };
}

describe('the page connection', () => {
  it('is live on its first hello, passes events on but not the tick, and is offline when no hello came within the grace period', async () => {
    const live = harness();

    live.connection.start();
    expect(live.connection.state).toBe('connecting');
    live.last().emit('list', { type: 'list' });
    live.last().emit('tick');
    live.last().emit('hello', { type: 'hello' });
    expect(live.connection.state).toBe('live');
    expect(live.events).toEqual(['list {"type":"list"}', 'hello {"type":"hello"}']);

    const never = harness();

    never.connection.start();
    await never.advance(GRACE_MS - 1);
    expect(never.connection.state).toBe('connecting');
    await never.advance(1);
    expect(never.connection.state).toBe('offline');
    expect(never.connection.lastLiveAt).toBeNull();
  });

  it('closes a failed stream itself and opens a new one after asking the hub, the same for a refused connection and a closed one, never reloading', async () => {
    const { connection, streams, asked, advance, last } = harness([{ build: 'b1', signedIn: true }, { build: 'b1', signedIn: true }]);

    connection.start();
    last().emit('hello');

    // A refused connection: the browser would try again by itself; the page closes the stream and tries on its own schedule.
    const first = last();

    first.emit('error');
    expect(first.closed).toBe(true);
    expect(connection.state).toBe('reconnecting');
    await advance(BACKOFF_MS[0]!);
    expect(asked).toEqual(['/page/ping']);
    expect(streams).toHaveLength(2);
    last().emit('hello');
    expect(connection.state).toBe('live');

    // A 502 from `tailscale serve` ends the stream for good in the browser; the page goes on the same way.
    const second = last();

    (second as unknown as { readyState: number }).readyState = 2;
    second.emit('error');
    await advance(BACKOFF_MS[0]!);
    expect(streams).toHaveLength(3);
    last().emit('hello');
    expect(connection.state).toBe('live');
    expect(connection.update).toBe(false);
  });

  it('changes nothing the operator sees within the grace period, and is offline after it until a hello', async () => {
    const { connection, advance, last } = harness(['down', 'down', 'down', { build: 'b1', signedIn: true }]);

    connection.start();
    last().emit('hello');
    await advance(1_000);
    last().emit('error');
    expect(connection.usable).toBe(true);
    await advance(GRACE_MS - 1);
    expect(connection.state).toBe('reconnecting');
    expect(connection.usable).toBe(true);
    await advance(1);
    expect(connection.state).toBe('offline');
    expect(connection.usable).toBe(false);
    // When it was last live: when it was lost.
    expect(connection.lastLiveAt).toBe(1_000);
    await advance(10_000);
    last().emit('hello');
    expect(connection.state).toBe('live');
  });

  it('waits longer between attempts, up to 30 s, varied by the jitter, and starts again from the shortest on Try now', async () => {
    const low = harness([], 'b1', 0);
    const waits: number[] = [];

    low.connection.start();
    low.last().emit('error');

    for (let attempt = 0; attempt < 8; attempt++) {
      waits.push(low.connection.nextAt! - low.now());
      await low.advance(low.connection.nextAt! - low.now());
      // The ping fails, which waits the next turn.
      await low.advance(0);
    }

    // 0.5, 1, 2, 4, 8, 15 and 30 s less the 20 % jitter at its lowest, then 30 s again.
    expect(waits).toEqual([400, 800, 1_600, 3_200, 6_400, 12_000, 24_000, 24_000]);

    low.connection.retryNow();
    await low.advance(0);
    expect(low.connection.nextAt! - low.now()).toBe(400);
  });

  it('opens a stream again that brought nothing, not even the tick, for the watchdog time, and one a hello never came on', async () => {
    const { connection, streams, advance, last } = harness([{ build: 'b1', signedIn: true }, { build: 'b1', signedIn: true }]);

    connection.start();
    last().emit('hello');
    // The hub's tick keeps it live.
    for (let at = 0; at < 3; at++) {
      await advance(15_000);
      last().emit('tick');
    }

    expect(streams).toHaveLength(1);
    // A half-open connection: nothing arrives, and no error either.
    await advance(WATCHDOG_MS + 5_000);
    expect(streams[0]!.closed).toBe(true);
    await advance(BACKOFF_MS[0]!);
    expect(streams).toHaveLength(2);
    // The new stream hangs before its hello.
    await advance(HELLO_MS);
    expect(streams[1]!.closed).toBe(true);
  });

  it('opens a silent stream again at once when the page comes back, and tries a lost one at once', async () => {
    const { connection, streams, asked, advance, last } = harness([{ build: 'b1', signedIn: true }, { build: 'b1', signedIn: true }]);

    connection.start();
    last().emit('hello');
    await advance(WAKE_STALE_MS - 1);
    connection.wake();
    expect(streams).toHaveLength(1);
    await advance(2);
    connection.wake();
    expect(streams[0]!.closed).toBe(true);
    await advance(0);
    expect(asked).toEqual(['/page/ping']);
    expect(streams).toHaveLength(2);
  });

  it("offers a reload for another build, never one for the same build or one it never knew, and stops for a gone sign-in", async () => {
    const other = harness([{ build: 'b2', signedIn: true }]);

    other.connection.start();
    other.last().emit('error');
    await other.advance(BACKOFF_MS[0]!);
    expect(other.connection.update).toBe(true);
    // It goes on with its own build meanwhile.
    other.last().emit('hello');
    expect(other.connection.state).toBe('live');

    const unknown = harness([{ build: 'b2', signedIn: true }], null);

    unknown.connection.start();
    unknown.last().emit('error');
    await unknown.advance(BACKOFF_MS[0]!);
    expect(unknown.connection.update).toBe(false);

    const out = harness([{ build: 'b1', signedIn: false }]);

    out.connection.start();
    out.last().emit('hello');
    out.last().emit('error');
    await out.advance(BACKOFF_MS[0]!);
    expect(out.connection.state).toBe('signedOut');
    expect(out.streams).toHaveLength(1);
    await out.advance(120_000);
    expect(out.asked).toEqual(['/page/ping']);
  });

  it('gives up a ping that hangs and tries again; check() asks without closing a live stream', async () => {
    const { connection, streams, asked, advance, last } = harness(['hang', { build: 'b1', signedIn: true }, { build: 'b1', signedIn: false }]);

    connection.start();
    last().emit('error');
    await advance(BACKOFF_MS[0]!);
    expect(asked).toHaveLength(1);
    await advance(PING_TIMEOUT_MS);
    await advance(BACKOFF_MS[1]!);
    expect(asked).toHaveLength(2);
    last().emit('hello');
    expect(streams).toHaveLength(2);
    connection.check();
    await advance(0);
    expect(connection.state).toBe('signedOut');
    expect(last().closed).toBe(true);
  });

  it('gives a stream lost while a sign-in check runs its attempt once the check ends', async () => {
    const { connection, streams, advance, last } = harness(['hang', { build: 'b1', signedIn: true }]);

    connection.start();
    last().emit('hello');
    connection.check();
    last().emit('error');
    await advance(PING_TIMEOUT_MS);
    await advance(BACKOFF_MS[0]!);
    expect(streams).toHaveLength(2);
  });

  it('answers whenLive at once while live, when the hello comes, and false once offline or after the time given', async () => {
    const { connection, advance, last } = harness([{ build: 'b1', signedIn: true }]);

    connection.start();

    const early = connection.whenLive(10_000);

    last().emit('hello');
    expect(await early).toBe(true);
    expect(await connection.whenLive(0)).toBe(true);
    last().emit('error');

    const short = connection.whenLive(100);

    await advance(100);
    expect(await short).toBe(false);

    const lost = connection.whenLive(10_000);

    await advance(GRACE_MS);
    expect(await lost).toBe(false);
    expect(await connection.whenLive(10_000)).toBe(false);
  });
});
