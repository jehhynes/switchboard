import { describe, expect, it, vi } from 'vitest';
import { startPage } from '../src/main.js';
import { RECONNECT_MS, reconnector } from '../src/reconnect.js';
import { drawAtOnce } from './frame.js';

type Answer = { status: number; body?: unknown } | 'down';

/** A reconnector over scripted answers per URL, with its timers run by hand. */
function harness(build: string | null, answers: Record<string, Answer[]>) {
  const asked: string[] = [];
  const timers: Array<{ run: () => void; ms: number }> = [];
  let reloads = 0;
  const lost = reconnector({
    fetch: async (url) => {
      asked.push(url);

      const answer = answers[url]!.shift()!;

      if (answer === 'down') {
        throw new TypeError('Failed to fetch');
      }

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body };
    },
    setTimeout: (run, ms) => timers.push({ run, ms }),
    reload: () => void reloads++,
    build,
  });
  const tick = async (): Promise<void> => {
    const timer = timers.shift()!;

    expect(timer.ms).toBe(RECONNECT_MS);
    timer.run();
    await new Promise((done) => setTimeout(done, 0));
  };

  return { lost, asked, timers, tick, reloads: () => reloads };
}

describe('reconnecting after the hub restarts', () => {
  it('asks until the hub answers, then reloads a page whose hub now runs another build, once however many errors came', async () => {
    const { lost, asked, timers, tick, reloads } = harness('b1', { '/page/ping': ['down', { status: 503 }, { status: 200, body: { build: 'b2' } }] });

    lost({ readyState: 0 });
    lost({ readyState: 0 });
    expect(timers).toHaveLength(1);
    await tick();
    await tick();
    await tick();
    expect(asked).toEqual(['/page/ping', '/page/ping', '/page/ping']);
    expect(reloads()).toBe(1);
    expect(timers).toHaveLength(0);
  });

  it("leaves the browser's own reconnect to a hub of the same build, and reloads when the browser gave up, signed out included", async () => {
    const same = harness('b1', { '/page/ping': [{ status: 200, body: { build: 'b1' } }] });

    same.lost({ readyState: 0 });
    await same.tick();
    expect(same.reloads()).toBe(0);
    expect(same.asked).toEqual(['/page/ping']);

    // A stream refused for a revoked sign-in reloads into the hub's signed-out page.
    const closed = harness('b1', { '/page/ping': [{ status: 200, body: { build: 'b1' } }] });

    closed.lost({ readyState: 2 });
    await closed.tick();
    expect(closed.reloads()).toBe(1);
    expect(closed.asked).toEqual(['/page/ping']);
  });

  it('does not reload for a build it never knew, and watches again after the next error', async () => {
    const { lost, tick, timers, reloads } = harness(null, { '/page/ping': [{ status: 200, body: { build: 'b2' } }, { status: 200, body: {} }, { status: 200, body: { build: 'b2' } }] });

    lost({});
    await tick();
    expect(reloads()).toBe(0);
    lost({});
    await tick();
    // An answer without a build is asked again.
    await tick();
    expect(reloads()).toBe(0);
    expect(timers).toHaveLength(0);
  });
});

describe('the page after its stream fails', () => {
  it('reloads once a hub of another build answers', async () => {
    vi.useFakeTimers();

    const listeners = new Map<string, () => void>();
    const source = { readyState: 0, addEventListener: (type: string, listener: () => void) => void listeners.set(type, listener), close: () => {} };
    const reload = vi.fn();
    const fetch = vi.fn(async (url: string) => ({ status: 200, ok: true, json: async () => (url === '/page/ping' ? { build: 'b2' } : {}) }) as unknown as Response);
    const root = document.createElement('div');

    document.body.replaceChildren(root);

    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: function () { return source; } as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, build: 'b1', reload });

    listeners.get('error')!();
    await vi.advanceTimersByTimeAsync(RECONNECT_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    page.close();
    vi.useRealTimers();
  });
});
