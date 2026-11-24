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
export function frameLinks(row: PageRow | null): Array<{ url: string; label: string }> {
  if (row === null) return [];
  const links = [{ url: row.url, label: 'Ticket' }, ...row.links];
  return links.filter((link, i) => frameUrl(link.url) && links.findIndex((one) => one.url === link.url) === i).map(({ url, label }) => ({ url, label }));
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
  constructor(private readonly deps: IframeBrowserDeps) {}
  get ready(): boolean {
    return this.#ready;
  }
  get available(): boolean { return this.#available; }
  get tabs(): Array<{ url: string; label: string }> { return this.#links.filter((link) => !this.#closed.has(link.url)); }
  get selected(): string { return this.#url; }
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
  place(visible: boolean): void {
    if (!this.#hosted) return;
    const rect = visible && this.#ready && this.#slot?.isConnected === true ? this.#slot.getBoundingClientRect() : null;
    const message =
      rect === null
        ? { type: 'switchboard-iframe', epoch: this.#epoch, seq: ++this.#seq, title: document.title, item: this.#item, tabs: this.tabs.map((link) => link.url) }
        : { type: 'switchboard-iframe', epoch: this.#epoch, seq: ++this.#seq, title: document.title, item: this.#item, tabs: this.tabs.map((link) => link.url), url: this.#url, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    window.parent.postMessage(message, `chrome-extension://${IFRAME_EXTENSION_ID}`);
  }
  dispose(): void {
    this.configure(false);
    this.#discard();
  }
}
