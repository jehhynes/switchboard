import { iframeTab } from './iframe.js';

export interface HostTab { id?: number; windowId?: number; url?: string; pendingUrl?: string }
export interface IframeLaunchDeps {
  remote: string | null;
  host: string;
  tabs(): Promise<HostTab[]>;
  create(url: string): Promise<unknown>;
  update(id: number, url?: string): Promise<unknown>;
  focus(window: number): Promise<unknown>;
}
/** Serializes launches so rapid clicks reuse one verified host for this hub. */
export class IframeLauncher {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: IframeLaunchDeps) {}
  open(origin: string, item: unknown, link?: unknown): Promise<void> {
    const next = this.#queue.then(async () => {
      if (item !== null && item !== undefined && !(Number.isSafeInteger(item) && (item as number) > 0)) throw new Error('Invalid work item.');
      const target = new URL(this.deps.host);
      target.searchParams.set('origin', origin);
      const selection = new URLSearchParams();
      if (typeof item === 'number') selection.set('workItemId', String(item));
      if (link !== undefined) {
        if (typeof link !== 'string' || link.length > 2048) throw new Error('Invalid GitHub link.');
        const url = new URL(link);
        if (url.origin !== 'https://github.com' || url.username !== '' || url.password !== '') throw new Error('Invalid GitHub link.');
        selection.set('url', link);
      }
      selection.set('request', crypto.randomUUID());
      target.hash = selection.toString();
      if (iframeTab(target.href, this.deps.remote)?.origin !== origin) throw new Error('Invalid Switchboard origin.');
      const tab = (await this.deps.tabs()).find((one) => {
        const page = iframeTab(one.pendingUrl ?? one.url, this.deps.remote);
        return one.id !== undefined && page?.hosted === true && page.origin === origin;
      });
      if (tab?.id === undefined) await this.deps.create(target.href);
      else {
        await this.deps.update(tab.id, target.href);
        if (tab.windowId !== undefined) await this.deps.focus(tab.windowId);
      }
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
