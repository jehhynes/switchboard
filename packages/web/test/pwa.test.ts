// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PAGE_ASSETS } from '../dist/index.js';
import { NAVIGATION_RACE_MS, SHELL, SHELL_CACHE, shellResponse, startWorker } from '../src/sw.js';
import type { ShellDeps } from '../src/sw.js';

const ORIGIN = 'http://127.0.0.1:47616';
const get = (path: string, mode: RequestMode = 'cors', method = 'GET'): Request => {
  const request = new Request(`${ORIGIN}${path}`, { method });

  Object.defineProperty(request, 'mode', { value: mode });
  return request;
};

/** A cache and a network: `hub` answers each fetch, as with a stopped hub (`down`), one behind `tailscale serve` (502), or one that never answers (`hang`). */
function fakes(hub: 'up' | 'down' | 'hang' | number, kept = new Map<string, string>([['/page/', 'kept page'], ['/page/page-0123456789abcdef.js', 'kept script']])) {
  const fetched: string[] = [];
  const timers: Array<() => void> = [];
  const deps: ShellDeps = {
    shell: ['/page/', '/page/page-0123456789abcdef.js', '/page/icon-192.png'],
    fetch: async (request) => {
      fetched.push(new URL(request.url).pathname);

      if (hub === 'down') {
        throw new TypeError('Failed to fetch');
      }

      if (hub === 'hang') {
        return new Promise<Response>(() => {});
      }

      return new Response(hub === 'up' ? `hub ${new URL(request.url).pathname}` : '', { status: hub === 'up' ? 200 : hub });
    },
    cached: async (path) => (kept.has(path) ? new Response(kept.get(path)) : undefined),
    setTimeout: (run, ms) => {
      expect(ms).toBe(NAVIGATION_RACE_MS);
      timers.push(run);
    },
  };

  return { deps, fetched, timers };
}

describe('the service worker', () => {
  it("leaves the API, the event stream, the page's other files, posts and other origins to the browser", () => {
    const { deps, fetched } = fakes('up');

    expect(shellResponse(get('/v1/conversation/events?page=1'), ORIGIN, deps)).toBeNull();
    expect(shellResponse(get('/v1/page/list'), ORIGIN, deps)).toBeNull();
    expect(shellResponse(get('/page/console.js'), ORIGIN, deps)).toBeNull();
    expect(shellResponse(get('/page/ping'), ORIGIN, deps)).toBeNull();
    expect(shellResponse(get('/v1/conversation/send', 'cors', 'POST'), ORIGIN, deps)).toBeNull();
    expect(shellResponse(get('/page/icon-192.png'), 'http://localhost:47616', deps)).toBeNull();
    expect(shellResponse(get('/v1/conversation/artifact/k/chat/a.html', 'navigate'), ORIGIN, deps)).toBeNull();
    expect(fetched).toEqual([]);
  });

  it("loads the page from the hub when it answers in time, a sign-in page included, and the kept page when it does not, or answers 502, 503 or 504", async () => {
    const page = async (hub: Parameters<typeof fakes>[0], late = false) => {
      const { deps, timers } = fakes(hub);
      const answer = shellResponse(get('/page/#w=3', 'navigate'), ORIGIN, deps)!;

      if (late) {
        await new Promise((done) => setImmediate(done));
        timers.forEach((run) => run());
      }

      const response = await answer;

      return [response.status, await response.text()];
    };

    expect(await page('up')).toEqual([200, 'hub /page/']);
    expect(await page(401)).toEqual([401, '']);
    expect(await page('down')).toEqual([200, 'kept page']);
    expect(await page(502)).toEqual([200, 'kept page']);
    expect(await page(503)).toEqual([200, 'kept page']);
    expect(await page(504)).toEqual([200, 'kept page']);
    // A hub that hangs, as a sleeping PC behind Tailscale: the kept page after the race's time.
    expect(await page('hang', true)).toEqual([200, 'kept page']);
  });

  it("gives the browser's own answer when no page is kept yet", async () => {
    const down = fakes('down', new Map());

    expect((await shellResponse(get('/page/', 'navigate'), ORIGIN, down.deps)!).type).toBe('error');

    const proxy = fakes(502, new Map());

    expect((await shellResponse(get('/page/', 'navigate'), ORIGIN, proxy.deps)!).status).toBe(502);
  });

  it('serves a shell file from its kept copy, which never changes under its name, and from the hub when none is kept', async () => {
    const { deps, fetched } = fakes('up');

    expect(await (await shellResponse(get('/page/page-0123456789abcdef.js'), ORIGIN, deps))!.text()).toBe('kept script');
    expect(fetched).toEqual([]);
    expect(await (await shellResponse(get('/page/icon-192.png'), ORIGIN, deps))!.text()).toBe('hub /page/icon-192.png');
  });

  it("keeps the whole shell on install or fails it, so the worker before stays, and keeps this build's cache and the one before on activate", async () => {
    const listeners = new Map<string, (event: never) => void>();
    const put: string[] = [];
    const deleted: string[] = [];
    const worker = { location: { origin: ORIGIN }, skipWaiting: vi.fn(async () => {}), clients: { claim: vi.fn(async () => {}) }, addEventListener: (type: string, listener: (event: never) => void) => void listeners.set(type, listener) };
    const staged = new Map<string, Response>();
    const cache = { match: async (path: string) => staged.get(path), put: async (path: string, response: Response) => void (put.push(path), staged.set(path, response)) };
    const store = { open: async () => cache, keys: async () => ['switchboard-shell-a', 'switchboard-shell-b', 'switchboard-shell-c-staging', SHELL_CACHE, 'other-app'], delete: async (name: string) => (deleted.push(name), true) } as unknown as CacheStorage;
    const waits: Array<Promise<unknown>> = [];
    const install = async (answer: (path: string) => Response): Promise<unknown> => {
      waits.length = 0;
      startWorker(worker as never, store, async (request) => answer(new URL(request.url).pathname));
      listeners.get('install')!({ waitUntil: (work: Promise<unknown>) => waits.push(work) } as never);
      return Promise.all(waits).then(() => null, (error: Error) => error.message);
    };

    // Not signed in, or one file cut off: nothing kept, the install fails and the worker before stays.
    expect(await install(() => new Response('net', { status: 401 }))).toMatch(/^The shell could not be kept: /);
    expect(await install(() => {
      throw new TypeError('Failed to fetch');
    })).toMatch(/^The shell could not be kept: /);
    expect(put).toEqual([]);
    // Only the staging cache goes: a complete cache of the same build that a worker before kept stays.
    expect(deleted).toEqual([`${SHELL_CACHE}-staging`, `${SHELL_CACHE}-staging`]);
    expect(worker.skipWaiting).not.toHaveBeenCalled();

    expect(await install(() => new Response('net'))).toBeNull();
    // Staged, then kept.
    expect(put).toEqual([...SHELL, ...SHELL]);
    expect(worker.skipWaiting).toHaveBeenCalled();

    deleted.length = 0;
    waits.length = 0;
    listeners.get('activate')!({ waitUntil: (work: Promise<unknown>) => waits.push(work) } as never);
    await Promise.all(waits);
    // A staging cache an install left is never kept as the build before.
    expect(deleted).toEqual(['switchboard-shell-c-staging', 'switchboard-shell-a']);
    expect(worker.clients.claim).toHaveBeenCalled();
  });

});

describe('the installable page', () => {
  const theme = PAGE_ASSETS['theme.css']!.body;
  // The bars' colour, the side bar's.
  const bars = /--vscode-sideBar-background:\s*(#[0-9a-fA-F]{6})/.exec(theme)![1];
  const lightBars = /@media \(prefers-color-scheme: light\)[^@]*--vscode-sideBar-background:\s*(#[0-9a-fA-F]{6})/.exec(theme)![1];

  /** A PNG's width and height from its header. */
  const size = (name: string): [number, number] => {
    const png = Buffer.from(PAGE_ASSETS[name]!.body, 'base64');

    expect(png.subarray(1, 4).toString()).toBe('PNG');
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };

  it('has a manifest for a standalone window scoped to the page, in the theme\'s colours, with icons at the sizes browsers require', () => {
    const manifest = JSON.parse(PAGE_ASSETS['manifest.webmanifest']!.body) as Record<string, unknown> & { icons: Array<{ src: string; sizes: string; purpose: string }> };

    expect(PAGE_ASSETS['manifest.webmanifest']!.mime).toBe('application/manifest+json');
    expect(manifest).toMatchObject({ id: '/page/', name: 'Switchboard', start_url: '/page/', scope: '/page/', display: 'standalone', theme_color: bars, background_color: bars });
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
    // Along the band's bottom edge: the top inset's band, 0 under an iPhone's opaque status bar.
    expect(rule?.[1]).toContain('inset: var(--sb-top) 0 auto 0');
    // Only the installed app draws it; a browser tab has its own tab strip above the page.
    expect(css.replace(rule![0], '')).not.toMatch(/body::before/);
    expect(JSON.parse(PAGE_ASSETS['manifest.webmanifest']!.body)).toMatchObject({ theme_color: bars });
  });

  it("draws the composer from packages/conversation's composer.css, before the page's own rules, which leave the box alone", () => {
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
    // The band is the status bar's inset alone, 0 under the opaque status bar: no band takes room above the bars. Each view's top bar is sticky at
    // the top, opaque and z-index 10, so iOS's top-edge hit test (4 px down) finds it, paints the status bar in its colour and drops its blur.
    expect(css).toContain(':root { --sb-top: env(safe-area-inset-top); }\n');
    expect(css).not.toMatch(/--sb-top: max\(/);
    expect(css).toContain('.header, .list-header, .settings-head, .persona-head { position: sticky; top: 0; z-index: var(--sb-z-bar); }');
    expect(css).toMatch(/(^|\n)\.header \{[^}]*background: var\(--sb-bar-background\);/);
    expect(css).not.toMatch(/(^|\n)\.header \{[^}]*position: relative/);
    expect(css).toMatch(/(^|\n)\.list-header \{[^}]*background: var\(--sb-bar-background\);/);
    expect(css).toMatch(/(^|\n)\.settings-head \{[^}]*background: var\(--vscode-sideBar-background\);/);
    expect(css).toMatch(/#safe-top \{[^}]*position: fixed; inset: 0 0 auto 0; z-index: var\(--sb-z-top-band\); height: var\(--sb-top\); background: var\(--sb-bar-background\);/);
    expect(css).toMatch(/#root \{[^}]*padding: var\(--sb-top\) env\(safe-area-inset-right\) 0 env\(safe-area-inset-left\);/);
    expect(css).toMatch(/#root\.drawers:not\(\.listing\) > \.side \{[^}]*padding-top: var\(--sb-top\);/);
    // Only the band's own definition reads the inset; every top edge reads the band.
    expect(css.match(/env\(safe-area-inset-top\)/g)).toHaveLength(1);
    expect(css).toMatch(/\.sheet-backdrop \{[^}]*padding: max\(16px, var\(--sb-top\)\)/);
    expect(css).toMatch(/\.settings-backdrop \{[^}]*padding: max\(24px, var\(--sb-top\)\)/);
    expect(css).toMatch(/\.settings-backdrop \{ padding: var\(--sb-top\) env\(safe-area-inset-right\) 0 env\(safe-area-inset-left\);/);
    // The bars are opaque in both schemes, so the band and the header they meet are one colour.
    expect(css).toMatch(/^:root \{[^}]*--sb-chrome: var\(--vscode-sideBar-background\);[^}]*--sb-bar-background: var\(--sb-chrome\);/m);

    const touch = css.slice(css.indexOf('@media (hover: none), (pointer: coarse) {\n  .composer-input'));

    expect(touch).toMatch(/^@media \(hover: none\), \(pointer: coarse\) \{\n  \.composer-input \{ font-size: 16px; \}\n  input:not\(\[type="checkbox"\], \[type="radio"\], \[type="file"\]\), textarea, select \{ font-size: 16px !important; \}/);

    expect(page).toContain('<link rel="apple-touch-icon" href="apple-touch-icon.png">\n<meta name="apple-mobile-web-app-title" content="Switchboard">');

    expect(size('apple-touch-icon.png')).toEqual([180, 180]);
    // Colour type 2 is RGB with no alpha: iOS fills a transparent icon's corners with black.
    expect(Buffer.from(PAGE_ASSETS['apple-touch-icon.png']!.body, 'base64')[25]).toBe(2);
  });

  it("leaves a reply's copy button out on a touch screen, where the text is copied as the system does, and keeps a code block's", () => {
    const css = PAGE_ASSETS['page.css']!.body;
    const touch = /@media \(hover: none\), \(pointer: coarse\) \{\n  \.code-block > \.copy \{ opacity: 1; min-width: 44px; min-height: 44px; align-items: center; justify-content: center; \}\n  \.meta \.copy \{ display: none; \}\n/.exec(css);

    expect(touch).not.toBeNull();
    // The hover rule a desktop uses is unchanged.
    expect(css).toContain('.code-block:hover > .copy, .reply:hover .meta .copy, .copy:focus-visible { opacity: 1; }');
    expect(css).not.toMatch(/\.meta \.copy::after/);
  });

  it('links the manifest from the page, with the theme colour, light first while the system is light, and has the worker keep every shell file the page loads', () => {
    const html = PAGE_ASSETS['index.html']!.body;

    expect(html).toContain('<link rel="manifest" href="manifest.webmanifest">');
    // A browser takes the first theme-color whose media matches, so the light one comes first and Dark Modern's is the fallback.
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${lightBars}">\n<meta name="theme-color" content="${bars}">`);
    expect(html).not.toMatch(/\{\{(?!build)[^}]*\}\}/);
    expect(lightBars).not.toBe(bars);

    const worker = PAGE_ASSETS['sw.js']!.body;

    for (const name of ['page.js', 'page.css', 'theme.css', 'codicon.css', 'codicon.ttf']) {
      expect(worker).toContain(`"/page/${PAGE_ASSETS[name]!.hashed}"`);
    }

    expect(worker).toContain('"/page/"');
    expect(PAGE_ASSETS['sw.js']!.mime).toBe('text/javascript; charset=utf-8');
    expect(PAGE_ASSETS['offline.html']).toBeUndefined();
  });

  it("paints the boot screen in the system's scheme before any file loads, then the page's stylesheets and script by their hashed names", () => {
    const html = PAGE_ASSETS['index.html']!.body;
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;

    // Inline, so the first paint has the right background in dark and light, with nothing loaded.
    expect(style).toContain(`html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; color-scheme: dark; background: ${bars}; }`);
    expect(style).toMatch(new RegExp(`@media \\(prefers-color-scheme: light\\) \\{\\n  html \\{ color-scheme: light; background: ${lightBars}; \\}`));
    expect(html.indexOf('<div id="boot"')).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    expect(html).toContain("<h2>Switchboard is not reachable</h2>");
    // The boot script comes first, so it sees page.js or a stylesheet fail.
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    expect(html).toMatch(/<link rel="stylesheet" href="codicon-[0-9a-f]{16}\.css">\n<link rel="stylesheet" href="theme-[0-9a-f]{16}\.css">\n<link rel="stylesheet" href="page-[0-9a-f]{16}\.css">\n<script src="page-[0-9a-f]{16}\.js"><\/script>/);
  });
});
