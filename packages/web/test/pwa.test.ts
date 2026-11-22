// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const lightSideBar = /@media \(prefers-color-scheme: light\)[^@]*--vscode-sideBar-background:\s*(#[0-9a-fA-F]{6})/.exec(theme)![1];

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

  it("keeps the title bar in the page's colour and draws a line along the installed app's top edge, not the browser tab's", () => {
    const css = PAGE_ASSETS['page.css']!.body;
    const rule = /@media \(display-mode: standalone\) \{ body::before \{([^}]*)\} \}/.exec(css);

    expect(rule?.[1]).toContain('height: 1px');
    expect(rule?.[1]).toContain('background: var(--vscode-titleBar-border, var(--vscode-widget-border))');
    expect(rule?.[1]).toContain('position: fixed');
    // Along the band's bottom edge, under the 12 px band the installed app keeps at the top.
    expect(rule?.[1]).toContain('inset: var(--sb-top) 0 auto 0');
    // Only the installed app draws it; a browser tab has its own tab strip above the page.
    expect(css.replace(rule![0], '')).not.toMatch(/body::before/);
    expect(JSON.parse(PAGE_ASSETS['manifest.webmanifest']!.body)).toMatchObject({ theme_color: sideBar });
  });

  it("draws the composer from the composer.css it shares with the Conversation view, before the page's own rules, which leave the box alone", () => {
    const css = PAGE_ASSETS['page.css']!.body;
    const own = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/page.css'), 'utf8');
    const shared = readFileSync(createRequire(import.meta.url).resolve('@switchboard/conversation/composer.css'), 'utf8');

    expect(css.indexOf(shared)).toBeGreaterThanOrEqual(0);
    expect(css.indexOf(shared)).toBeLessThan(css.indexOf(own));
    expect(own).not.toMatch(/(^|\n)\.composer \{[^}]*(background|border|border-radius)\s*:/);
    expect(own).not.toMatch(/(^|\n)\.composer-footer \{/);

    // The conversation dropdown's fill and its selected row come from picker.css, shared too.
    const picker = readFileSync(createRequire(import.meta.url).resolve('@switchboard/conversation/picker.css'), 'utf8');

    expect(css.indexOf(picker)).toBeGreaterThanOrEqual(0);
    expect(css.indexOf(picker)).toBeLessThan(css.indexOf(own));
    expect(own).not.toMatch(/button\.picker:hover|\.conversation-row\[aria-checked="true"\]/);

    // Where a menu opens comes from menu.css, shared too: under its button, left edges lined up, unless placeMenus flips it.
    const menu = readFileSync(createRequire(import.meta.url).resolve('@switchboard/conversation/menu.css'), 'utf8');

    expect(css.indexOf(menu)).toBeGreaterThanOrEqual(0);
    expect(css.indexOf(menu)).toBeLessThan(css.indexOf(own));
    expect(menu).toMatch(/\n\.menu \{[^}]*top: calc\(100% \+ 2px\); left: 0;/);
    expect(own).not.toMatch(/(^|\n)\.menu \{|align-right/);
  });

  it('fits an iPhone: an opaque status bar, the safe areas in the bars\' colour, 16 px fields and an opaque 180 px Home Screen icon', () => {
    const page = PAGE_ASSETS['index.html']!.body;
    const css = PAGE_ASSETS['page.css']!.body;

    expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    // black-translucent gets iOS 26.1's blur over the page's top; with no key the status bar is opaque and the page starts below it.
    expect(page).not.toContain('apple-mobile-web-app-status-bar-style');
    expect(page).toContain('<div id="safe-top" aria-hidden="true"></div>\n<div id="root"></div>');
    // The band is the status bar's inset, and at least 12 px in the installed app, so iOS's top-edge hit test (4 px down) finds a fixed box over
    // 10 px tall, paints the status bar in its colour and drops its blur; everything at the top starts below the band.
    expect(css).toContain(':root { --sb-top: env(safe-area-inset-top); }\n@media (display-mode: standalone) { :root { --sb-top: max(env(safe-area-inset-top), 12px); } }');
    expect(css).toMatch(/#safe-top \{[^}]*position: fixed; inset: 0 0 auto 0; z-index: 1001; height: var\(--sb-top\); background: var\(--sb-bar-background\);/);
    expect(css).toMatch(/#root \{[^}]*padding: var\(--sb-top\) env\(safe-area-inset-right\) 0 env\(safe-area-inset-left\);/);
    expect(css).toMatch(/#root\.drawers:not\(\.listing\):not\(\.history\) > \.side \{[^}]*padding-top: var\(--sb-top\);/);
    // Only the band's own definitions read the inset; every top edge reads the band.
    expect(css.match(/env\(safe-area-inset-top\)/g)).toHaveLength(2);
    expect(css).toMatch(/\.sheet-backdrop \{[^}]*padding: max\(16px, var\(--sb-top\)\)/);
    expect(css).toMatch(/\.settings-backdrop \{[^}]*padding: max\(24px, var\(--sb-top\)\)/);
    expect(css).toMatch(/\.settings-backdrop \{ padding: var\(--sb-top\) env\(safe-area-inset-right\) 0 env\(safe-area-inset-left\);/);
    // The bars are opaque in both schemes, so the band and the header they meet are one colour.
    expect(css).toMatch(/^:root \{[^}]*--sb-bar-background: var\(--vscode-sideBar-background\);/m);

    const touch = css.slice(css.indexOf('@media (hover: none), (pointer: coarse) {\n  .composer-input'));

    expect(touch).toMatch(/^@media \(hover: none\), \(pointer: coarse\) \{\n  \.composer-input \{ font-size: 16px; \}\n  input:not\(\[type="checkbox"\], \[type="radio"\], \[type="file"\]\), textarea, select \{ font-size: 16px !important; \}/);

    for (const name of ['index.html', 'offline.html']) {
      expect(PAGE_ASSETS[name]!.body).toContain('<link rel="apple-touch-icon" href="apple-touch-icon.png">\n<meta name="apple-mobile-web-app-title" content="Switchboard">');
    }

    expect(size('apple-touch-icon.png')).toEqual([180, 180]);
    // Colour type 2 is RGB with no alpha: iOS fills a transparent icon's corners with black.
    expect(Buffer.from(PAGE_ASSETS['apple-touch-icon.png']!.body, 'base64')[25]).toBe(2);
  });

  it("leaves a reply's copy button out on a touch screen, where the text is copied as the system does, and keeps a code block's", () => {
    const css = PAGE_ASSETS['page.css']!.body;
    const touch = /@media \(hover: none\), \(pointer: coarse\) \{\n  \.code-block > \.copy \{ opacity: 1; \}\n  \.meta \.copy \{ display: none; \}\n/.exec(css);

    expect(touch).not.toBeNull();
    // The hover rule a desktop uses is unchanged.
    expect(css).toContain('.code-block:hover > .copy, .reply:hover .meta .copy, .copy:focus-visible { opacity: 1; }');
    expect(css).not.toMatch(/\.meta \.copy::after/);
  });

  it('links the manifest from the page and the offline page, with the theme colour, light first while the system is light, and serves every file the worker keeps', () => {
    for (const name of ['index.html', 'offline.html']) {
      const html = PAGE_ASSETS[name]!.body;

      expect(html).toContain('<link rel="manifest" href="manifest.webmanifest">');
      // A browser takes the first theme-color whose media matches, so the light one comes first and Dark Modern's is the fallback.
      expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${lightSideBar}">\n<meta name="theme-color" content="${sideBar}">`);
      expect(html).not.toMatch(/\{\{themeColor(Light)?\}\}/);
    }

    expect(PAGE_ASSETS['offline.html']!.body).toContain('Switchboard is not running');
    // The Start button opens the link hub.js autostart registers, which starts the hub and passes nothing of the link on (PRD R117).
    expect(PAGE_ASSETS['offline.html']!.body).toContain('<a class="start" href="switchboard:start">Start Switchboard</a>');
    expect(PAGE_ASSETS['offline.html']!.body).toContain('<code>node ~/.switchboard/hub.js start</code>');
    expect(PAGE_ASSETS['offline.html']!.body).toMatch(new RegExp(`@media \\(prefers-color-scheme: light\\) \\{[^@]*background: ${lightSideBar}; color: #3b3b3b;`));
    expect(lightSideBar).not.toBe(sideBar);
    expect(SHELL.map((path) => path.slice('/page/'.length)).filter((name) => PAGE_ASSETS[name] === undefined)).toEqual([]);
    expect(PAGE_ASSETS['sw.js']!.mime).toBe('text/javascript; charset=utf-8');
  });
});
