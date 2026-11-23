// The installed page's service worker (architecture.md § Web page, App shell). It keeps the page's shell for each build: the page, its
// content-hashed script and styles, the icons and the manifest, and nothing else; the API, the event stream and every other file go to the
// network untouched. A page load answers from the network when the hub answers in time, and otherwise from the kept page, whose own screen
// says when the hub cannot be reached; a 502, 503 or 504, as `tailscale serve` answers for a stopped hub, counts as no answer.

declare const __SHELL__: string[] | undefined;
declare const __SHELL_VERSION__: string | undefined;

/** The shell's files, by path, as build.mjs lists them for this build. */
export const SHELL: string[] = typeof __SHELL__ === 'undefined' ? ['/page/'] : __SHELL__;
/** This build's cache; the previous build's is kept too, for a page of that build still open. */
export const SHELL_CACHE = `switchboard-shell-${typeof __SHELL_VERSION__ === 'undefined' ? 'dev' : __SHELL_VERSION__}`;
/** How long a page load waits for the hub before the kept page answers. */
export const NAVIGATION_RACE_MS = 3_000;
/** The page, which every page load under /page/ falls back to. */
export const PAGE = '/page/';

export interface ShellDeps {
  /** The shell's paths: {@link SHELL}. */
  shell: readonly string[];
  fetch(request: Request): Promise<Response>;
  cached(path: string): Promise<Response | undefined>;
  setTimeout(run: () => void, ms: number): unknown;
}

const unavailable = (response: Response): boolean => response.status === 502 || response.status === 503 || response.status === 504;

/** The answer to a request the worker sees, or null to leave it to the browser. */
export function shellResponse(request: Request, origin: string, deps: ShellDeps): Promise<Response> | null {
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== origin) {
    return null;
  }

  if (request.mode === 'navigate' && url.pathname.startsWith('/page/')) {
    return navigate(request, deps);
  }

  // A shell file: the kept copy, which never changes under its name, else the hub's.
  if (deps.shell.includes(url.pathname) && url.pathname !== PAGE) {
    return deps.cached(url.pathname).then((kept) => kept ?? deps.fetch(request));
  }

  return null;
}

/** The hub's page when it answers within {@link NAVIGATION_RACE_MS}, other than 502, 503 or 504; otherwise the kept page, or the hub's answer when none is kept. */
function navigate(request: Request, deps: ShellDeps): Promise<Response> {
  const network = deps.fetch(request).then(
    (response) => (unavailable(response) ? null : response),
    () => null,
  );
  const late = new Promise<'late'>((done) => deps.setTimeout(() => done('late'), NAVIGATION_RACE_MS));

  return Promise.race([network, late]).then(async (first) => {
    if (first !== null && first !== 'late') {
      return first;
    }

    const kept = await deps.cached(PAGE);

    if (kept !== undefined) {
      return kept;
    }

    // No kept page: wait for whatever the hub answers, or the browser's own error page.
    return (await network) ?? deps.fetch(request).catch(() => Response.error());
  });
}

interface WorkerEvent {
  waitUntil(work: Promise<unknown>): void;
}

interface FetchEvent extends WorkerEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}

interface Worker {
  location: { origin: string };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (event: WorkerEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

/**
 * Keeps each shell file the hub gives with the sign-in, or none: a shell with a file missing, as for a browser not signed in or a dropped
 * connection, fails the install, so the worker before, with its whole shell, stays until the browser installs this one again. The files go to
 * a staging cache first, so a failure never touches a complete cache of the same build that a worker before kept.
 */
async function keepShell(store: CacheStorage, fetcher: (request: Request) => Promise<Response>, origin: string): Promise<void> {

  const staging = `${SHELL_CACHE}-staging`;

  try {
    const responses = await Promise.all(SHELL.map(async (path) => [path, await fetcher(new Request(new URL(path, origin).href, { credentials: 'same-origin', cache: 'reload' })).catch(() => null)] as const));
    const missing = responses.filter(([, response]) => response?.ok !== true).map(([path]) => path);

    if (missing.length > 0) {
      throw new Error(`The shell could not be kept: ${missing.join(', ')}`);
    }

    const staged = await store.open(staging);

    await Promise.all(responses.map(([path, response]) => staged.put(path, response!)));

    const cache = await store.open(SHELL_CACHE);

    for (const path of SHELL) {
      const response = await staged.match(path);

      if (response === undefined) {
        throw new Error(`The shell could not be kept: ${path}`);
      }

      await cache.put(path, response);
    }
  } finally {
    await store.delete(staging);
  }
}

/** Runs the worker in a service worker's global scope. */
export function startWorker(worker: Worker, store: CacheStorage, fetcher: (request: Request) => Promise<Response>, timers: { setTimeout(run: () => void, ms: number): unknown } = { setTimeout: (run, ms) => setTimeout(run, ms) }): void {
  const deps: ShellDeps = {
    shell: SHELL,
    fetch: fetcher,
    // The page's address carries a hash and maybe a query; the kept page is the one page.
    cached: async (path) => (await store.open(SHELL_CACHE)).match(path, { ignoreSearch: true }),
    setTimeout: timers.setTimeout,
  };

  worker.addEventListener('install', (event) => {
    event.waitUntil(keepShell(store, fetcher, worker.location.origin).then(() => worker.skipWaiting()));
  });
  worker.addEventListener('activate', (event) => {
    event.waitUntil(
      store
        .keys()
        .then(async (names) => {
          // This build's cache and the newest other one stay; Cache Storage lists caches in the order they were made.
          // A staging cache an install left when it was cut short is no build's.
          const staging = names.filter((name) => name.startsWith('switchboard-shell-') && name.endsWith('-staging'));
          const others = names.filter((name) => name.startsWith('switchboard-shell-') && name !== SHELL_CACHE && !staging.includes(name));

          await Promise.all([...staging, ...others.slice(0, -1)].map((name) => store.delete(name)));
        })
        .then(() => worker.clients.claim()),
    );
  });
  worker.addEventListener('fetch', (event) => {
    const response = shellResponse(event.request, worker.location.origin, deps);

    if (response !== null) {
      event.respondWith(response);
    }
  });
}
