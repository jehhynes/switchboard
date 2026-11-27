import { describe, expect, it, vi } from 'vitest';
import { FAILURE_TEXT, failureOf, request, RETRY_MS, timedFetch, transient } from '../src/request.js';
import type { RequestDeps } from '../src/request.js';

/** Request deps over a scripted fetch, with real timers (the tests use vi's fake ones). */
function deps(answers: Array<{ status: number; body?: unknown } | 'down' | 'hang' | 'stall' | 'cut'>, seen: Array<{ url: string; body: unknown }> = []): RequestDeps {
  return {
    fetch: (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, body: init.body === undefined ? null : JSON.parse(String(init.body)) });

      const answer = answers.shift() ?? 'down';
      const aborted = () => new Promise<never>((_, fail) => init.signal?.addEventListener('abort', () => fail(init.signal!.reason)));

      if (answer === 'down') {
        throw new TypeError('Failed to fetch');
      }

      if (answer === 'hang') {
        return aborted();
      }

      // Headers, then a body that never ends, or one the connection cut short.
      if (answer === 'cut') {
        return { status: 200, ok: true, json: () => Promise.reject(new TypeError('network error')) } as unknown as Response;
      }

      return { status: answer === 'stall' ? 200 : answer.status, ok: true, json: () => (answer === 'stall' ? aborted() : answer.body === undefined ? Promise.reject(new SyntaxError('Unexpected end of JSON input')) : Promise.resolve(answer.body)) } as unknown as Response;
    }) as typeof fetch,
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}

describe('requests', () => {
  it('classifies statuses, and tries again only no answer, a timeout and an unavailable hub', () => {
    expect([200, 204, 401, 403, 409, 400, 404, 500, 502, 503, 504].map(failureOf)).toEqual([null, null, 'signedOut', 'refused', 'refused', 'bad', 'bad', 'bad', 'unavailable', 'unavailable', 'unavailable']);
    expect((['network', 'timeout', 'unavailable', 'signedOut', 'refused', 'bad', null] as const).map(transient)).toEqual([true, true, true, false, false, false, false]);
  });

  it("says no answer, a hang, a stalled body and a proxy's empty 502 in plain words, and keeps the hub's own reason for a refusal", async () => {
    vi.useFakeTimers();

    const options = { timeout: 1_000, now: () => Date.now() };
    const one = (answer: Parameters<typeof deps>[0][number]) => {
      const result = request(deps([answer]), '/v1/x', () => ({}), options);

      void vi.advanceTimersByTimeAsync(1_000);
      return result;
    };

    expect(await one('down')).toEqual({ status: 0, body: { error: FAILURE_TEXT.network }, failure: 'network' });
    expect(await one('hang')).toEqual({ status: 0, body: { error: FAILURE_TEXT.timeout }, failure: 'timeout' });
    expect(await one('stall')).toEqual({ status: 0, body: { error: FAILURE_TEXT.timeout }, failure: 'timeout' });
    expect(await one({ status: 502 })).toEqual({ status: 502, body: { error: FAILURE_TEXT.unavailable }, failure: 'unavailable' });
    expect(await one({ status: 503, body: { error: 'Switchboard is restarting onto a new build; try again in a few seconds.' } })).toMatchObject({ body: { error: 'Switchboard is restarting. Try again in a moment.' } });
    expect(await one({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } })).toEqual({ status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' }, failure: 'refused' });
    // The hub's old text for a stale scope generation, which it keeps for older pages, reads in the page's words.
    expect(await one({ status: 409, body: { error: "The window's conversation changed." } })).toEqual({ status: 409, body: { error: 'You switched to another session, so that was not done. Try again.' }, failure: 'refused' });
    expect(await one({ status: 500 })).toEqual({ status: 500, body: { error: 'That did not work (status 500). Try again.' }, failure: 'bad' });
    expect(await one({ status: 200, body: { ok: 1 } })).toEqual({ status: 200, body: { ok: 1 }, failure: null });
    // A 2xx answer stands only with its body: one cut short is no answer, so a send is tried again rather than taken as sent.
    expect(await one('cut')).toEqual({ status: 0, body: { error: FAILURE_TEXT.network }, failure: 'network' });
    expect(await one({ status: 204 })).toEqual({ status: 204, body: {}, failure: null });
    // An error status keeps its meaning with no body, as a proxy's 502 or a bare 401.
    expect(await one({ status: 401 })).toEqual({ status: 401, body: { error: FAILURE_TEXT.signedOut }, failure: 'signedOut' });
    expect(await one({ status: 409 })).toEqual({ status: 409, body: { error: 'Switchboard did not allow that (status 409).' }, failure: 'refused' });
    vi.useRealTimers();
  });

  it('tries a transient failure again within its time, building each try afresh, and gives up on a refusal or once the time is spent', async () => {
    vi.useFakeTimers();

    const seen: Array<{ url: string; body: unknown }> = [];
    let key = 'k1';
    let now = 0;
    const ready = vi.fn(async () => true);
    const sent = request(deps(['down', { status: 503 }, { status: 200, body: { message: { id: 'm1' } } }], seen), '/v1/conversation/send', () => ({ method: 'POST', body: JSON.stringify({ window: key, opId: 'op-1' }) }), { timeout: 1_000, retryFor: 30_000, ready, now: () => now });

    key = 'k2';
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]! + RETRY_MS[1]!);
    expect(await sent).toMatchObject({ status: 200, failure: null });
    // One opId for every try; the key the page has at each.
    expect(seen.map((one) => one.body)).toEqual([{ window: 'k1', opId: 'op-1' }, { window: 'k2', opId: 'op-1' }, { window: 'k2', opId: 'op-1' }]);
    expect(ready).toHaveBeenCalledTimes(2);

    const refused: typeof seen = [];

    expect(await request(deps([{ status: 409, body: { error: 'No.' } }, { status: 200 }], refused), '/x', () => ({}), { timeout: 1_000, retryFor: 30_000, now: () => now })).toMatchObject({ status: 409 });
    expect(refused).toHaveLength(1);

    // Out of time: the last failure stands.
    const late: typeof seen = [];
    const spent = request(deps(['down', 'down', 'down'], late), '/x', () => ({}), { timeout: 1_000, retryFor: 1_000, now: () => now });

    await vi.advanceTimersByTimeAsync(RETRY_MS[0]!);
    now = 1_000;
    await vi.advanceTimersByTimeAsync(RETRY_MS[1]!);
    expect(await spent).toMatchObject({ failure: 'network' });
    expect(late.length).toBeLessThanOrEqual(2);

    // A connection that does not come back ends the retries.
    const offline: typeof seen = [];
    const given = request(deps(['down', { status: 200 }], offline), '/x', () => ({}), { timeout: 1_000, retryFor: 30_000, ready: async () => false, now: () => 0 });

    await vi.advanceTimersByTimeAsync(RETRY_MS[0]!);
    expect(await given).toMatchObject({ failure: 'network' });
    expect(offline).toHaveLength(1);
    vi.useRealTimers();
  });

  it("gives up a controller's read in time, its body too, and passes the caller's own abort through", async () => {
    vi.useFakeTimers();

    const fetcher = timedFetch(deps(['hang', 'stall', 'hang']), 500);
    const hung = fetcher('/a').catch((error: Error) => error.name);

    await vi.advanceTimersByTimeAsync(500);
    expect(await hung).toBe('TimeoutError');

    const response = await fetcher('/b');
    const body = response.json().catch((error: Error) => error.name);

    await vi.advanceTimersByTimeAsync(500);
    expect(await body).toBe('TimeoutError');

    const mine = new AbortController();
    const cancelled = fetcher('/c', { signal: mine.signal }).catch((error: Error) => error.name);

    mine.abort(new DOMException('gone', 'AbortError'));
    expect(await cancelled).toBe('AbortError');
    vi.useRealTimers();
  });
});
