import type { PageRow } from '@switchboard/protocol';
import { BROWSER_EXTENSION_ID, BROWSER_PORT } from '@switchboard/core/hubRecord';

/** Must match the key-derived ID verified by extensions/chrome/test/manifest.test.ts. */
export const IFRAME_EXTENSION_ID = BROWSER_EXTENSION_ID;
export const IFRAME_RENEW_MS = 30_000;

/** Only bounded web URLs without embedded credentials may enter a website frame. */
export function frameUrl(url: string): boolean {
  try {
    const value = new URL(url);
    const loopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost';
    const hub = new URL(location.href);
    if (value.origin === hub.origin || (loopback(value.hostname) && (value.port === String(BROWSER_PORT) || (loopback(hub.hostname) && value.protocol === hub.protocol && value.port === hub.port)))) return false;
    return url.length <= 2048 && (value.protocol === 'http:' || value.protocol === 'https:') && value.username === '' && value.password === '';
  } catch {
    return false;
  }
}
/** What the page reads of the browser to tell whether it can install the extension: its user agent string and, where it has them, its client hints. */
export interface BrowserIdentity {
  userAgent: string;
  userAgentData?: { brands?: ReadonlyArray<{ brand: string }>; mobile?: boolean; platform?: string } | undefined;
  /** Whether any pointer is fine, a mouse or touchpad (`(any-pointer: fine)`); left out where unknown. */
  finePointer?: boolean;
}

/**
 * Whether this browser can install the Switchboard extension that embedded link tabs need (architecture.md § Embedded link tabs): Chromium on a
 * desktop, as Chrome and Edge on Windows, macOS, Linux and ChromeOS. Safari, Firefox, every iOS and iPadOS browser and Chromium on Android cannot.
 * Read from User-Agent Client Hints where the browser has them (Chromium in a secure context), else from the user agent string; an iPad's Safari
 * names itself a Mac but never Chrome. Chrome on Android in desktop mode, the default on large tablets, names itself desktop Linux in both, so a
 * Linux browser counts only with a fine pointer, a mouse or touchpad, which a desktop has and a tablet seldom does.
 */
export function canInstallExtension(browser: BrowserIdentity): boolean {
  const hints = browser.userAgentData;
  const hinted = hints?.brands !== undefined && hints.brands.length > 0;
  const linux = hinted ? hints.platform === 'Linux' : /\bLinux\b/.test(browser.userAgent) && !/\bCrOS\b/.test(browser.userAgent);

  if (linux && browser.finePointer === false) {
    return false;
  }

  if (hinted) {
    return hints.brands!.some(({ brand }) => brand === 'Chromium') && hints.mobile !== true && hints.platform !== 'Android';
  }

  return /\bChrom(?:e|ium)\/\d/.test(browser.userAgent) && !/Android|Mobile|iPhone|iPad|iPod|CriOS|EdgiOS|FxiOS/.test(browser.userAgent);
}

export function frameLinks(row: PageRow | null): Array<{ url: string; label: string }> {
  if (row === null) return [];
  const links = [{ url: row.url, label: 'Ticket' }, ...row.links];
  return links.filter((link, i) => frameUrl(link.url) && links.findIndex((one) => one.url === link.url) === i).map(({ url, label }) => ({ url, label }));
}

/** A page layer over the website frame, in viewport pixels, that the extension host cuts out of the frame (extensions/chrome/src/iframeFrames.ts). */
export interface FrameHole {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
}
/** What of the page draws over the website frame: the layers to cut out of it, and a modal backdrop's darkening, 0 to 1. */
export interface FrameCover {
  holes: FrameHole[];
  dim: number;
  modal: boolean;
  /** The frame cannot show: an opaque backdrop or more layers than the host takes. */
  hide: boolean;
}
export const FRAME_HOLES_MAX = 16;

const overlaps = (a: DOMRect, b: DOMRect): boolean => a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** A CSS colour's alpha, as getComputedStyle gives it; 1 for one it cannot read, so an unknown backdrop hides the frame. */
export function colorAlpha(color: string): number {
  if (color === 'transparent') return 0;
  const match = /^rgba?\(([^)]*)\)$/.exec(color.trim());
  if (match === null) return 1;
  const parts = match[1]!.split(/[\s,/]+/).filter((part) => part !== '');
  if (parts.length === 3) return 1;
  const alpha = parts[3]!.endsWith('%') ? parseFloat(parts[3]!) / 100 : parseFloat(parts[3]!);
  return Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
}

/**
 * What of the page covers the website frame's `slot`: each of `layers` that overlaps it becomes a hole, and each of `backdrops` that does makes
 * the frame modal and darkens it by the backdrop's alpha. A nearly opaque backdrop, as the phone's full-screen dialogs have, hides the frame.
 */
export function frameCover(slot: DOMRect, layers: Iterable<Element>, backdrops: Iterable<Element>, modal = false): FrameCover {
  let clear = 1;
  for (const backdrop of backdrops) {
    if (!overlaps(backdrop.getBoundingClientRect(), slot)) continue;
    modal = true;
    clear *= 1 - colorAlpha(getComputedStyle(backdrop).backgroundColor);
  }
  const holes: FrameHole[] = [];
  for (const layer of new Set(layers)) {
    const box = layer.getBoundingClientRect();
    if (!overlaps(box, slot)) continue;
    holes.push({ left: box.left, top: box.top, width: box.width, height: box.height, radius: parseFloat(getComputedStyle(layer).borderTopLeftRadius) || 0 });
  }
  const dim = Math.round((1 - clear) * 1000) / 1000;
  return { holes: holes.slice(0, FRAME_HOLES_MAX), dim, modal, hide: dim > 0.9 || holes.length > FRAME_HOLES_MAX };
}

export interface IframeBrowserDeps {
  send(message: Record<string, unknown>): Promise<unknown>;
  changed(becameReady?: boolean): void;
  external(url: string): void;
}

/** Keeps one frame across redraws; switching work items discards the earlier document. */
export class IframeBrowser {
  #enabled = false;
  #generation = 0;
  #ready = false;
  #available = false;
  #note = 'Connecting to the experimental extension…';
  #root: HTMLElement | null = null;
  #item: number | null = null;
  #url = '';
  #links: Array<{ url: string; label: string }> = [];
  #checking = false;
  #requestedSites = '';
  #sites(): string { return JSON.stringify([...new Set(this.tabs.map((link) => new URL(link.url).host))].sort()); }
  #sync(): void {
    const sites = this.#sites();
    if (this.#hosted && this.#enabled && sites !== this.#requestedSites) { this.#requestedSites = sites; this.#ready = false; void this.renew(); }
  }
  #pending: { item: number | null; url: string } | null = null;
  #closed = new Set<string>();
  #slot: HTMLElement | null = null;
  #seq = 0;
  readonly #epoch = crypto.randomUUID();
  #reloadPage = false;
  #launchError: string | null = null;
  readonly #hosted = window.parent !== window;
  #holes = false;
  constructor(private readonly deps: IframeBrowserDeps) {}
  get ready(): boolean {
    return this.#ready;
  }
  get available(): boolean { return this.#available; }
  get tabs(): Array<{ url: string; label: string }> { return this.#links.filter((link) => !this.#closed.has(link.url)); }
  get selected(): string { return this.#url; }
  /** Whether the extension host cuts the page's layers out of the website frame; an older host does not, so the page hides the frame under them. */
  get holes(): boolean { return this.#holes; }
  /** The host said it cuts holes; true the first time it does. */
  holesAnswered(): boolean {
    if (this.#holes) return false;
    this.#holes = true;
    return true;
  }
  follow(row: PageRow | null, review = false): void {
    const item = row?.workItemId ?? null;
    if (item !== this.#item) {
      this.#discard();
      this.#closed.clear();
      this.#links = frameLinks(row);
      this.#item = item;
      this.#url = (review ? row?.links.find((link) => link.kind === 'pr' && frameUrl(link.url))?.url : undefined) ?? this.#links[0]?.url ?? '';
    } else {
      for (const link of frameLinks(row)) if (!this.#links.some((one) => one.url === link.url)) this.#links.push(link);
    }
    this.#sync();
  }
  close(url: string): void {
    this.#closed.add(url);
    if (url === this.#url) this.#url = this.tabs[0]?.url ?? '';
    this.#sync();
    this.place(false);
    this.deps.changed();
  }
  configure(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    this.#generation++;
    this.#requestedSites = '';
    this.#ready = false;
    this.#available = false;
    this.#note = 'Connecting to the experimental extension…';
    this.#reloadPage = false;
    this.#discard();
    if (enabled) void this.renew();
    else void this.deps.send({ type: 'iframe-disable' }).catch(() => undefined);
  }
  async renew(): Promise<void> {
    if (!this.#enabled || this.#checking) return;
    this.#checking = true;
    const generation = this.#generation;
    const sites = this.#sites();
    const urls = this.tabs.map((link) => link.url);
    let reply: { ok?: unknown; error?: unknown } | null = null;
    try {
      reply = (await this.deps.send(this.#hosted ? { type: 'iframe-enable', urls } : { type: 'iframe-check' })) as { ok?: unknown; error?: unknown } | null;
    } catch {
      /* Extension absent or reloading. */
    }
    this.#checking = false;
    if (generation !== this.#generation) {
      if (this.#enabled) void this.renew();
      return;
    }
    if (this.#hosted && sites !== this.#sites()) { void this.renew(); return; }
    this.#requestedSites = sites;
    const wasReady = this.#ready;
    this.#ready = reply?.ok === true;
    this.#available = this.#ready;
    this.#note = this.#ready ? '' : String(reply?.error ?? 'Load the experimental Switchboard Chrome/Edge extension in this browser, then select Retry.');
    this.deps.changed(this.#ready && !wasReady);
  }
  #discard(): void {
    if (this.#hosted) window.parent.postMessage({ type: 'switchboard-iframe', epoch: this.#epoch, seq: ++this.#seq, title: document.title, item: null, tabs: [] }, `chrome-extension://${IFRAME_EXTENSION_ID}`);
    this.#root?.remove();
    this.#root = null;
    this.#slot = null;
    this.#item = null;
    this.#url = '';
  }
  requireReload(): void {
    this.configure(false);
    this.#reloadPage = true;
    this.#note = 'Reload Switchboard to apply the embedded browser setting.';
  }
  async #launch(item: number | null, url: string): Promise<void> {
    this.#launchError = null;
    try {
      const result = await this.deps.send({ type: 'iframe-launch', workItemId: item, url }) as { ok?: unknown; error?: unknown } | null;
      if (result?.ok !== true) this.#launchError = String(result?.error ?? 'Could not open embedded tabs. Use Open outside or retry.');
    } catch { this.#launchError = 'Could not reach the extension. Use Open outside or retry.'; }
    if (this.#launchError !== null) this.deps.changed();
  }
  open(url: string, item: number | null = this.#item): boolean {
    if (!this.#available || !frameUrl(url)) return false;
    if (!this.#links.some((link) => link.url === url)) this.#links.push({ url, label: 'Link' });
    this.#closed.delete(url);
    this.#sync();
    this.#url = url;
    this.#pending = { item, url };
    if (!this.#hosted) void this.#launch(item, url);
    return true;
  }
  draw(host: HTMLElement, row: PageRow | null, review: boolean): void {
    if (!this.#ready) {
      host.replaceChildren();
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = this.#note;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = this.#reloadPage ? 'Reload Switchboard' : 'Retry';
      retry.onclick = () => (this.#reloadPage ? location.reload() : void this.renew());
      host.append(note, retry);
      return;
    }
    this.follow(row, review);
    if (this.#root === null) {
      this.#root = document.createElement('section');
      this.#root.className = this.#hosted ? 'iframe-browser hosted' : 'iframe-browser';
      this.#slot = document.createElement('div');
      this.#slot.className = 'iframe-slot';
      this.#root.append(this.#slot);
    }
    if (this.#pending?.item === this.#item) {
      const url = this.#pending!.url;
      if (!this.#links.some((link) => link.url === url)) this.#links.push({ url, label: 'Link' });
      this.#url = url;
    }
    this.#pending = null;
    if (host.firstChild !== this.#root) host.replaceChildren(this.#root);
    if (!this.#hosted && this.#root.querySelector('.iframe-toolbar') === null) {
      const toolbar = document.createElement('div');
      toolbar.className = 'iframe-toolbar';
      const outside = document.createElement('button');
      outside.type = 'button';
      outside.textContent = 'Open outside';
      outside.onclick = () => this.deps.external(this.#url);
      const note = document.createElement('p');
      note.className = 'iframe-warning';
      note.textContent = 'Open with sign-in support to use these tabs inside Switchboard.';
      toolbar.append(outside, note);
      const hosted = document.createElement('button');
      hosted.type = 'button';
      hosted.textContent = 'Open with sign-in support';
      hosted.onclick = () => void this.#launch(row?.workItemId ?? null, this.#url);
      toolbar.append(hosted);
      this.#root.prepend(toolbar);
    }
    if (this.#launchError !== null) this.#root.querySelector<HTMLElement>('.iframe-warning')!.textContent = this.#launchError;
  }
  /** Where the website frame's slot lies on the page, while it is in the page, for the layers that would draw under the sibling frame. */
  slotRect(): DOMRect | null {
    return this.#slot?.isConnected === true ? this.#slot.getBoundingClientRect() : null;
  }
  /** The extension owns a sibling frame so websites have an extension top-level page for its cookie exemptions. */
  place(visible: boolean, cover?: FrameCover): void {
    if (!this.#hosted) return;
    const rect = visible && this.#ready && this.#slot?.isConnected === true && cover?.hide !== true ? this.#slot.getBoundingClientRect() : null;
    const layers = cover === undefined ? {} : { holes: cover.holes, dim: cover.dim, modal: cover.modal };
    const message =
      rect === null
        ? { type: 'switchboard-iframe', epoch: this.#epoch, seq: ++this.#seq, title: document.title, item: this.#item, tabs: this.tabs.map((link) => link.url) }
        : { type: 'switchboard-iframe', epoch: this.#epoch, seq: ++this.#seq, title: document.title, item: this.#item, tabs: this.tabs.map((link) => link.url), url: this.#url, left: rect.left, top: rect.top, width: rect.width, height: rect.height, ...layers };
    window.parent.postMessage(message, `chrome-extension://${IFRAME_EXTENSION_ID}`);
  }
  dispose(): void {
    this.configure(false);
    this.#discard();
  }
}
