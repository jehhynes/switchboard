import type { PageRow } from '@switchboard/protocol';
import { PANE_EXTENSION_ID } from '@switchboard/core/hubRecord';

/** Must match the key-derived ID verified by extensions/chrome/test/manifest.test.ts. */
export const IFRAME_EXTENSION_ID = PANE_EXTENSION_ID;
export const IFRAME_RENEW_MS = 30_000;

/** GitHub only: no credentials, other schemes, lookalike hosts or unbounded URLs. */
export function githubFrameUrl(url: string): boolean {
  try {
    const value = new URL(url);
    return url.length <= 2048 && value.origin === 'https://github.com' && value.username === '' && value.password === '';
  } catch {
    return false;
  }
}
export function githubLinks(row: PageRow | null): Array<{ url: string; label: string }> {
  if (row === null) return [];
  const links = [{ url: row.url, label: 'Ticket' }, ...row.links];
  return links.filter((link, i) => githubFrameUrl(link.url) && links.findIndex((one) => one.url === link.url) === i).map(({ url, label }) => ({ url, label }));
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
  #note = 'Connecting to the experimental extension…';
  #root: HTMLElement | null = null;
  #frame: HTMLIFrameElement | null = null;
  #item: number | null = null;
  #url = '';
  #links: Array<{ url: string; label: string }> = [];
  #checking = false;
  #pending: { item: number | null; url: string } | null = null;
  #select: HTMLSelectElement | null = null;
  #closed = new Set<string>();
  #options = '';
  #slot: HTMLElement | null = null;
  #reload = false;
  #reloadPage = false;
  readonly #hosted = window.parent !== window;
  constructor(private readonly deps: IframeBrowserDeps) {}
  get ready(): boolean {
    return this.#ready;
  }
  get tabs(): Array<{ url: string; label: string }> { return this.#links.filter((link) => !this.#closed.has(link.url)); }
  get selected(): string { return this.#url; }
  follow(row: PageRow | null, review = false): void {
    const item = row?.workItemId ?? null;
    if (item !== this.#item) {
      this.#discard();
      this.#closed.clear();
      this.#links = githubLinks(row);
      this.#item = item;
      this.#url = (review ? row?.links.find((link) => link.kind === 'pr' && githubFrameUrl(link.url))?.url : undefined) ?? this.#links[0]?.url ?? '';
    } else {
      for (const link of githubLinks(row)) if (!this.#links.some((one) => one.url === link.url)) this.#links.push(link);
    }
  }
  close(url: string): void {
    this.#closed.add(url);
    if (url === this.#url) this.#url = this.tabs[0]?.url ?? '';
    this.place(false);
    this.deps.changed();
  }
  configure(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    this.#generation++;
    this.#ready = false;
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
    let reply: { ok?: unknown; error?: unknown } | null = null;
    try {
      reply = (await this.deps.send({ type: 'iframe-enable' })) as { ok?: unknown; error?: unknown } | null;
    } catch {
      /* Extension absent or reloading. */
    }
    this.#checking = false;
    if (generation !== this.#generation) {
      if (this.#enabled) void this.renew();
      return;
    }
    const wasReady = this.#ready;
    this.#ready = reply?.ok === true;
    this.#note = this.#ready ? '' : String(reply?.error ?? 'Load the experimental Switchboard Chrome/Edge extension in this browser, then select Retry.');
    if (!this.#ready) this.#discard();
    this.deps.changed(this.#ready && !wasReady);
  }
  #discard(): void {
    this.place(false);
    this.#frame?.remove();
    this.#root?.remove();
    this.#root = null;
    this.#frame = null;
    this.#slot = null;
    this.#select = null;
    this.#options = '';
    this.#item = null;
    this.#url = '';
  }
  requireReload(): void {
    this.configure(false);
    this.#reloadPage = true;
    this.#note = 'Reload Switchboard to apply the GitHub iframe setting.';
  }
  open(url: string, item: number | null = this.#item): boolean {
    if (!this.#ready || !githubFrameUrl(url)) return false;
    if (!this.#links.some((link) => link.url === url)) this.#links.push({ url, label: 'Link' });
    this.#closed.delete(url);
    this.#url = url;
    this.#pending = { item, url };
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
      this.#root.className = 'iframe-browser';
      this.#frame = document.createElement('iframe');
      this.#frame.title = 'GitHub browser experiment';
      this.#frame.referrerPolicy = 'no-referrer';
      this.#frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
      this.#slot = this.#hosted ? document.createElement('div') : this.#frame;
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
    if (this.#select === null) {
      const toolbar = document.createElement('div');
      toolbar.className = 'iframe-toolbar';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'GitHub link');
      this.#select = select;
      select.onchange = () => {
        this.#url = select.value;
        this.deps.changed();
      };
      const reload = document.createElement('button');
      reload.type = 'button';
      reload.textContent = 'Reload';
      reload.onclick = () => {
        if (this.#hosted) {
          this.#reload = true;
          this.deps.changed();
        } else this.#frame!.src = this.#url;
      };
      const outside = document.createElement('button');
      outside.type = 'button';
      outside.textContent = 'Open outside';
      outside.onclick = () => this.deps.external(this.#url);
      const note = document.createElement('p');
      note.className = 'iframe-warning';
      note.textContent = this.#hosted
        ? 'Extension-hosted GitHub experiment. If signed out, use Open outside, then Reload.'
        : 'Public GitHub frame: sign-in cookies may be blocked. Use Open with sign-in support to test authenticated embedding.';
      toolbar.append(reload, outside, note);
      if (!this.#hosted) {
        const hosted = document.createElement('button');
        hosted.type = 'button';
        hosted.textContent = 'Open with sign-in support';
        hosted.onclick = () =>
          void this.deps
            .send({ type: 'iframe-launch', workItemId: this.#item })
            .then((answer) => {
              const result = answer as { ok?: unknown; error?: unknown } | null;
              if (result?.ok !== true) note.textContent = String(result?.error ?? 'Reload the experimental extension, then try again.');
            })
            .catch(() => {
              note.textContent = 'Could not reach the experimental extension.';
            });
        toolbar.append(hosted);
      }
      this.#root.prepend(toolbar);
    }
    const options = JSON.stringify(this.#links);
    if (options !== this.#options) {
      this.#options = options;
      this.#select.replaceChildren();
      for (const link of this.#links) {
        const option = document.createElement('option');
        option.value = link.url;
        option.textContent = `${link.label}: ${link.url}`;
        this.#select.append(option);
      }
    }
    this.#select.value = this.#url;
    if (!this.#hosted && this.#url !== '' && this.#frame!.getAttribute('src') !== this.#url) this.#frame!.src = this.#url;
  }
  /** The extension owns a sibling frame so GitHub has an extension top-level page for its cookie exemptions. */
  place(visible: boolean): void {
    if (!this.#hosted) return;
    const rect = visible && this.#ready && this.#slot?.isConnected === true ? this.#slot.getBoundingClientRect() : null;
    const message =
      rect === null
        ? { type: 'switchboard-iframe', title: document.title, item: this.#item, tabs: this.tabs.map((link) => link.url) }
        : { type: 'switchboard-iframe', title: document.title, item: this.#item, tabs: this.tabs.map((link) => link.url), url: this.#url, left: rect.left, top: rect.top, width: rect.width, height: rect.height, reload: this.#reload };
    window.parent.postMessage(message, `chrome-extension://${IFRAME_EXTENSION_ID}`);
    this.#reload = false;
  }
  dispose(): void {
    this.configure(false);
    this.#discard();
  }
}
