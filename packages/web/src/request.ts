// The page's requests to its hub (architecture.md § Web page, Requests): every one ends within its timeout, so no lock waits on a hung
// connection, and every failure reads as one plain sentence.

/** How long a request may take: a read, a command, and opening a work item. */
export const READ_MS = 15_000;
export const COMMAND_MS = 20_000;
export const NAVIGATION_MS = 10_000;
/** An upload's limit, which a slow phone connection needs for a large file. */
export const UPLOAD_MS = 120_000;
/** The waits between a retried command's attempts, the last repeating. */
export const RETRY_MS = [500, 1_000, 2_000, 4_000];

/**
 * Why a request failed: no answer (`network`), none in time (`timeout`), the hub restarting or not behind `tailscale serve` (`unavailable`:
 * 502, 503, 504), the browser signed out (401), the hub refusing (`refused`: 403 or 409, with its reason), or anything else (`bad`).
 */
export type Failure = 'network' | 'timeout' | 'unavailable' | 'signedOut' | 'refused' | 'bad';

/** What a failure says when the hub gave no reason of its own. */
export const FAILURE_TEXT: Record<Failure, string> = {
  network: "Can't reach Switchboard. Try again.",
  timeout: 'That took too long. Try again.',
  unavailable: 'Switchboard is restarting. Try again in a moment.',
  signedOut: 'This device is signed out.',
  refused: 'Switchboard refused that.',
  bad: 'That did not work. Try again.',
};

export interface Answer {
  status: number;
  body: Record<string, unknown>;
  /** Why it failed, or null for a 2xx answer. */
  failure: Failure | null;
}

/** A failure the same request may succeed after: worth a retry for a command whose `opId` makes a repeat harmless. */
export function transient(failure: Failure | null): boolean {
  return failure === 'network' || failure === 'timeout' || failure === 'unavailable';
}

export function failureOf(status: number): Failure | null {
  return status >= 200 && status < 300 ? null : status === 401 ? 'signedOut' : status === 403 || status === 409 ? 'refused' : status === 502 || status === 503 || status === 504 ? 'unavailable' : 'bad';
}

export interface RequestDeps {
  fetch: typeof fetch;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

/**
 * A `fetch` that gives up after `ms`, rejecting with a `TimeoutError`, the body's reading included; a caller's own signal still aborts it.
 * For the page's controllers, which handle a rejected fetch as they did before.
 */
export function timedFetch(deps: RequestDeps, ms: number): typeof fetch {
  return async (input, init = {}) => {
    const abort = new AbortController();
    const timer = deps.setTimeout(() => abort.abort(new DOMException('That took too long.', 'TimeoutError')), ms);
    const outer = init.signal;

    if (outer != null) {
      if (outer.aborted) {
        abort.abort(outer.reason);
      } else {
        outer.addEventListener('abort', () => abort.abort(outer.reason), { once: true });
      }
    }

    // A fetch that ignores its signal still ends: each step races the abort.
    const aborted = new Promise<never>((_, fail) => abort.signal.addEventListener('abort', () => fail(abort.signal.reason), { once: true }));

    aborted.catch(() => {});

    try {
      const response = await Promise.race([deps.fetch(input, { ...init, signal: abort.signal }), aborted]);

      if (response === null || typeof response !== 'object') {
        deps.clearTimeout(timer);
        return response;
      }

      // The body may stall after the headers, so the timer runs until it is read.
      const done = (): void => deps.clearTimeout(timer);

      return new Proxy(response, {
        get(target, name) {
          const value = Reflect.get(target, name, target) as unknown;

          if (typeof value !== 'function') {
            return value;
          }

          if (name === 'json' || name === 'text' || name === 'arrayBuffer' || name === 'blob') {
            return (...args: unknown[]) => Promise.race([(value as (...a: unknown[]) => Promise<unknown>).apply(target, args), aborted]).finally(done);
          }

          return (value as (...a: unknown[]) => unknown).bind(target);
        },
      });
    } catch (error) {
      deps.clearTimeout(timer);
      throw error;
    }
  };
}

export interface RequestOptions {
  /** How long one attempt may take. */
  timeout: number;
  /**
   * For a command whose `opId` makes a repeat harmless: how long after the first attempt a transient failure is tried again, with the same
   * body but the page's key as it is then; 0 for none.
   */
  retryFor?: number;
  /** Waits for the connection to be usable before an attempt, up to the time given; true when it is. */
  ready?(ms: number): Promise<boolean>;
  now(): number;
  keepalive?: boolean;
}

/** Sends one request, built afresh by `init` for each attempt, and answers its status, its JSON body and why it failed. */
export async function request(deps: RequestDeps, url: string, init: () => RequestInit, options: RequestOptions): Promise<Answer> {
  const started = options.now();
  const fetcher = timedFetch(deps, options.timeout);

  for (let attempt = 0; ; attempt++) {
    const answer = await once(fetcher, url, init());
    const left = (options.retryFor ?? 0) - (options.now() - started);
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;

    if (!transient(answer.failure) || left <= wait) {
      return answer;
    }

    await new Promise((done) => deps.setTimeout(() => done(null), wait));

    if (options.ready !== undefined && !(await options.ready(Math.max(0, left - wait)))) {
      return answer;
    }
  }
}

async function once(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Answer> {
  let response: Response;

  try {
    response = await fetcher(url, init);
  } catch (error) {
    const failure: Failure = (error as { name?: string } | null)?.name === 'TimeoutError' ? 'timeout' : 'network';

    console.warn(`Switchboard: ${url} failed: ${String(error)}`);
    return { status: 0, body: { error: FAILURE_TEXT[failure] }, failure };
  }

  // Only a test's fake gives no response; it reads as no answer.
  if (response == null) {
    return { status: 0, body: { error: FAILURE_TEXT.network }, failure: 'network' };
  }

  const failure = failureOf(response.status);
  let body: Record<string, unknown>;

  try {
    const read = (await response.json()) as unknown;

    body = read !== null && typeof read === 'object' && !Array.isArray(read) ? (read as Record<string, unknown>) : {};
  } catch (error) {
    // A body that stalled is a timeout, and one cut short no answer, so no 2xx answer stands without the body it carries; only 204 has none.
    if ((error as { name?: string } | null)?.name === 'TimeoutError') {
      return { status: 0, body: { error: FAILURE_TEXT.timeout }, failure: 'timeout' };
    }

    if (failure === null && response.status !== 204) {
      return { status: 0, body: { error: FAILURE_TEXT.network }, failure: 'network' };
    }

    body = {};
  }

  if (failure !== null) {
    console.warn(`Switchboard: ${url} answered ${response.status}: ${String(body['error'] ?? '')}`);
  }

  // The hub's own reason stands for a refusal or a bad request; an unreachable or restarting hub, or a proxy's empty 502, reads plainly.
  if (failure === 'unavailable' || failure === 'signedOut' || (failure !== null && typeof body['error'] !== 'string')) {
    body = { ...body, error: FAILURE_TEXT[failure] };
  }

  return { status: response.status, body, failure };
}
