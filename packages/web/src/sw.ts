// The installed page's service worker (architecture.md § Web page). It keeps only the offline page, its script, the icons and the manifest, and
// answers a page load that cannot reach the hub with the offline page. Everything else, the page's own files, the API and the event stream,
// goes to the network untouched, so a page is always the one its hub serves.

/** The cache the worker keeps the offline files in; a new name drops the old cache. Raise it whenever a file in `SHELL` changes, so an installed worker is replaced and keeps the new copies. */
export const SHELL_CACHE = 'switchboard-shell-v2';
/** The files the worker keeps, which the hub serves without a sign-in. */
export const SHELL = ['/page/offline.html', '/page/offline.js', '/page/icon-192.png', '/page/icon-512.png', '/page/icon-maskable-512.png', '/page/manifest.webmanifest'];
/** The page shown when the hub does not answer. */
export const OFFLINE_PAGE = '/page/offline.html';

export interface ShellDeps {
  fetch(request: Request): Promise<Response>;
  cached(path: string): Promise<Response | undefined>;
  keep(path: string, response: Response): Promise<void>;
}

/** The answer to a request the worker sees, or null to leave it to the browser. */
export function shellResponse(request: Request, origin: string, deps: ShellDeps): Promise<Response> | null {
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== origin) {
    return null;
  }

  if (request.mode === 'navigate' && url.pathname.startsWith('/page/')) {
    return deps.fetch(request).catch(async () => (await deps.cached(OFFLINE_PAGE)) ?? Response.error());
  }

  if (!SHELL.includes(url.pathname)) {
    return null;
  }

  // The hub's copy first, kept for when it is gone.
  return deps.fetch(request).then(
    async (response) => {
      if (response.ok) {
        await deps.keep(url.pathname, response.clone());
      }

      return response;
    },
    async () => (await deps.cached(url.pathname)) ?? Response.error(),
  );
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

/** Runs the worker in a service worker's global scope. */
export function startWorker(worker: Worker, store: CacheStorage, fetcher: (request: Request) => Promise<Response>): void {
  const deps: ShellDeps = {
    fetch: fetcher,
    cached: async (path) => (await store.open(SHELL_CACHE)).match(path),
    keep: async (path, response) => (await store.open(SHELL_CACHE)).put(path, response),
  };

  worker.addEventListener('install', (event) => {
    event.waitUntil(store.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => worker.skipWaiting()));
  });
  worker.addEventListener('activate', (event) => {
    event.waitUntil(
      store
        .keys()
        .then((names) => Promise.all(names.filter((name) => name.startsWith('switchboard-shell-') && name !== SHELL_CACHE).map((name) => store.delete(name))))
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
