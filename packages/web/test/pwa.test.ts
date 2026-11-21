// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PAGE_ASSETS } from '../dist/index.js';
import { OFFLINE_RETRY_MS, waitForHub } from '../src/offline.js';
import { OFFLINE_PAGE, SHELL, SHELL_CACHE, shellResponse, startWorker } from '../src/sw.js';
import type { ShellDeps } from '../src/sw.js';

const ORIGIN = 'http://127.0.0.1:47616';
const get = (path: string, mode: RequestMode = 'cors', method = 'GET'): Request => {
  const request = new Request(`${ORIGIN}${path}`, { method });

  Object.defineProperty(request, 'mode', { value: mode });
  return request;
};

/** A cache and a network: `down` makes every fetch fail, as with no hub. */
function fakes(down: boolean) {
  const kept = new Map<string, string>([[OFFLINE_PAGE, 'offline page'], ['/page/icon-192.png', 'old icon']]);
  const fetched: string[] = [];
  const deps: ShellDeps = {
    fetch: async (request) => {
      fetched.push(new URL(request.url).pathname);

      if (down) {
        throw new TypeError('Failed to fetch');
      }

      return new Response(`hub ${new URL(request.url).pathname}`, { status: 200 });
    },
    cached: async (path) => (kept.has(path) ? new Response(kept.get(path)) : undefined),
    keep: async (path, response) => void kept.set(path, await response.text()),
  };

  return { deps, kept, fetched };
}

describe('the service worker', () => {
  it('leaves the API, the event stream, the page\'s own files, posts and other origins to the browser', () => {
    const { deps, fetched } = fakes(false);

    expect(shellResponse(get('/v1/conversation/events?page=1'), ORIGIN, deps)).toBeNull();
    expect(shellResponse(get('/v1/page/list'), ORIGIN, deps)).toBeNull();
    expect(shellResponse(get('/page/page.js'), ORIGIN, deps)).toBeNull();
    expect(shellResponse(get('/page/ping'), ORIGIN, deps)).toBeNull();
    expect(shellResponse(get('/v1/conversation/send', 'cors', 'POST'), ORIGIN, deps)).toBeNull();
    expect(shellResponse(get('/page/icon-192.png'), 'http://localhost:47616', deps)).toBeNull();
    expect(shellResponse(get('/v1/conversation/artifact/k/chat/a.html', 'navigate'), ORIGIN, deps)).toBeNull();
    expect(fetched).toEqual([]);
  });

  it("loads the page from the hub, and shows the offline page when the hub does not answer", async () => {
    const up = fakes(false);

    expect(await (await shellResponse(get('/page/', 'navigate'), ORIGIN, up.deps))!.text()).toBe('hub /page/');

    const down = fakes(true);

    expect(await (await shellResponse(get('/page/', 'navigate'), ORIGIN, down.deps))!.text()).toBe('offline page');
  });

  it('serves its files from the hub and keeps the copy, and from the cache only when the hub does not answer', async () => {
    const up = fakes(false);

    expect(await (await shellResponse(get('/page/icon-192.png'), ORIGIN, up.deps))!.text()).toBe('hub /page/icon-192.png');
    expect(up.kept.get('/page/icon-192.png')).toBe('hub /page/icon-192.png');

    const down = fakes(true);

    expect(await (await shellResponse(get('/page/icon-192.png'), ORIGIN, down.deps))!.text()).toBe('old icon');
    expect((await shellResponse(get('/page/offline.js'), ORIGIN, down.deps))!.type).toBe('error');
  });

  it('caches its files on install, drops older caches of its own on activate, and answers only what shellResponse takes', async () => {
    const listeners = new Map<string, (event: never) => void>();
    const added: string[][] = [];
    const deleted: string[] = [];
    const worker = { location: { origin: ORIGIN }, skipWaiting: vi.fn(async () => {}), clients: { claim: vi.fn(async () => {}) }, addEventListener: (type: string, listener: (event: never) => void) => void listeners.set(type, listener) };
    const cache = { addAll: async (paths: string[]) => void added.push(paths), match: async () => undefined, put: async () => {} };
    const store = { open: async () => cache, keys: async () => [SHELL_CACHE, 'switchboard-shell-v0', 'other-app'], delete: async (name: string) => (deleted.push(name), true) } as unknown as CacheStorage;
    const waits: Array<Promise<unknown>> = [];

    startWorker(worker as never, store, async () => new Response('net'));
    listeners.get('install')!({ waitUntil: (work: Promise<unknown>) => waits.push(work) } as never);
    listeners.get('activate')!({ waitUntil: (work: Promise<unknown>) => waits.push(work) } as never);
    await Promise.all(waits);
    expect(added).toEqual([SHELL]);
    expect(worker.skipWaiting).toHaveBeenCalled();
    expect(deleted).toEqual(['switchboard-shell-v0']);
    expect(worker.clients.claim).toHaveBeenCalled();

    const answered: Array<Promise<Response>> = [];

    listeners.get('fetch')!({ request: get('/v1/page/list'), respondWith: (response: Promise<Response>) => answered.push(response) } as never);
    expect(answered).toHaveLength(0);
    listeners.get('fetch')!({ request: get('/page/', 'navigate'), respondWith: (response: Promise<Response>) => answered.push(response) } as never);
    expect(await (await answered[0]!).text()).toBe('net');
  });
});

describe('the offline page', () => {
  it('asks the hub until it answers, then reloads', async () => {
    const answers = [Promise.reject(new TypeError('down')), Promise.resolve({ ok: false }), Promise.resolve({ ok: true })];
    const waits: number[] = [];
    let reloads = 0;
    let next: (() => void) | null = null;

    waitForHub({ fetch: () => answers.shift()!, reload: () => void reloads++, setTimeout: (run, ms) => ((next = run), waits.push(ms)) });

    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(next).not.toBeNull());
      const run = next!;

      next = null;
      run();
    }

    await vi.waitFor(() => expect(reloads).toBe(1));
    expect(waits).toEqual([OFFLINE_RETRY_MS, OFFLINE_RETRY_MS]);
  });
});

describe('the installable page', () => {
  const theme = PAGE_ASSETS['theme.css']!.body;
  const sideBar = /--vscode-sideBar-background:\s*(#[0-9a-fA-F]{6})/.exec(theme)![1];

  /** A PNG's width and height from its header. */
  const size = (name: string): [number, number] => {
    const png = Buffer.from(PAGE_ASSETS[name]!.body, 'base64');

    expect(png.subarray(1, 4).toString()).toBe('PNG');
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };

  it('has a manifest for a standalone window scoped to the page, in the theme\'s colours, with icons at the sizes browsers require', () => {
    const manifest = JSON.parse(PAGE_ASSETS['manifest.webmanifest']!.body) as Record<string, unknown> & { icons: Array<{ src: string; sizes: string; purpose: string }> };

    expect(PAGE_ASSETS['manifest.webmanifest']!.mime).toBe('application/manifest+json');
    expect(manifest).toMatchObject({ id: '/page/', name: 'Switchboard', start_url: '/page/', scope: '/page/', display: 'standalone', theme_color: sideBar, background_color: sideBar });
    expect(manifest.icons.map((icon) => [icon.src, icon.sizes, icon.purpose])).toEqual([
      ['icon-192.png', '192x192', 'any'],
      ['icon-512.png', '512x512', 'any'],
      ['icon-maskable-512.png', '512x512', 'maskable'],
    ]);

    for (const icon of manifest.icons) {
      expect(size(icon.src)).toEqual(icon.sizes.split('x').map(Number));
    }
  });

  it('links the manifest from the page and the offline page, with the theme colour, and serves every file the worker keeps', () => {
    for (const name of ['index.html', 'offline.html']) {
      const html = PAGE_ASSETS[name]!.body;

      expect(html).toContain('<link rel="manifest" href="manifest.webmanifest">');
      expect(html).toContain(`<meta name="theme-color" content="${sideBar}">`);
      expect(html).not.toContain('{{');
    }

    expect(PAGE_ASSETS['offline.html']!.body).toContain('Switchboard is not running');
    expect(SHELL.map((path) => path.slice('/page/'.length)).filter((name) => PAGE_ASSETS[name] === undefined)).toEqual([]);
    expect(PAGE_ASSETS['sw.js']!.mime).toBe('text/javascript; charset=utf-8');
  });
});
