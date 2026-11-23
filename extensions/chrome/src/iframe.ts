import { BROWSER_PORT } from './hub.js';
import { BROWSER_EXTENSION_ID } from '@switchboard/core/hubRecord';
export const IFRAME_HOST_PATH = '/iframeHost.html';
export const IFRAME_EXTENSION_ORIGIN = `chrome-extension://${BROWSER_EXTENSION_ID}`;

/** A host page is fixed extension code, and names only the Switchboard origin it contains. */
export function iframeTab(url: string | undefined, remote: string | null): { origin: string; hosted: boolean } | null {
  const origin = iframePage(url, remote);
  if (origin !== null) return { origin, hosted: false };
  try {
    const host = new URL(url!);
    const page = host.searchParams.get('origin');
    if (
      host.protocol === 'chrome-extension:' &&
      host.host === new URL(IFRAME_EXTENSION_ORIGIN).host &&
      host.pathname === IFRAME_HOST_PATH &&
      page !== null &&
      iframePage(`${page}/page/`, remote) === page
    )
      return { origin: page, hosted: true };
  } catch {
    /* Not an extension host. */
  }
  return null;
}

/** Local origins are vouched for by the fixed hub endpoint, never by the requesting page's server. */
export async function iframeEnabled(fetchUrl: (url: string) => Promise<Response>, origin: string, remote: string | null): Promise<boolean> {
  try {
    if (remote === null) {
      const response = await fetchUrl(`http://127.0.0.1:${BROWSER_PORT}/iframe`);
      const state = response.ok ? ((await response.json()) as { enabled?: unknown; origins?: unknown }) : null;
      if (state?.enabled !== true || !Array.isArray(state.origins) || !state.origins.includes(origin)) return false;
    } else if (origin !== remote) return false;
    const response = await fetchUrl(`${origin}/v1/browser/iframe`);
    return response.ok && ((await response.json()) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

/** The iframe experiment changes only GitHub document responses in a verified Switchboard tab. */
export interface IframeRule {
  id: number;
  priority: number;
  action: { type: 'modifyHeaders'; responseHeaders: Array<{ header: string; operation: 'remove' }> };
  condition: { tabIds: number[]; topDomains: string[]; regexFilter: string; resourceTypes: ['sub_frame'] };
}
export interface IframeSender {
  origin?: string;
  url?: string;
  frameId?: number;
  tab?: { id?: number };
}
export interface IframeLease {
  origin: string;
  until: number;
}
export interface IframeRulesDeps {
  origin: string | null;
  now(): number;
  tab(id: number): Promise<string | undefined>;
  enabled(origin: string): Promise<boolean>;
  leases(): Promise<Record<string, IframeLease>>;
  save(leases: Record<string, IframeLease>): Promise<void>;
  rules(): Promise<Array<{ id: number }>>;
  update(removeRuleIds: number[], addRules: IframeRule[]): Promise<void>;
}
export const IFRAME_LEASE_MS = 90_000;

export function iframeRule(tabId: number, origin: string): IframeRule {
  return {
    id: tabId + 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    // topDomains (Chrome 145+) keeps the rule from applying after the tab navigates away, before onUpdated runs.
    condition: { tabIds: [tabId], topDomains: [new URL(origin).hostname], regexFilter: '^https://github\\.com/', resourceTypes: ['sub_frame'] },
  };
}

export function iframePage(url: string | undefined, remote: string | null): string | null {
  try {
    const page = new URL(url!);
    return page.pathname === '/page/' &&
      page.username === '' &&
      page.password === '' &&
      (remote === null ? /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(page.origin) : page.origin === remote)
      ? page.origin
      : null;
  } catch {
    return null;
  }
}

/** All rule and lease changes are serialized, including navigation and sign-out cleanup. */
export class IframeRules {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: IframeRulesDeps) {}
  #run<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run);
    this.#queue = next.catch(() => undefined);
    return next;
  }
  external(message: unknown, sender: IframeSender): Promise<{ ok?: true; error?: string }> {
    return this.#run(async () => {
      const type = (message as { type?: unknown } | null)?.type;
      const id = sender.tab?.id;
      const origin = iframePage(sender.url, this.deps.origin);
      if ((type !== 'iframe-enable' && type !== 'iframe-disable' && type !== 'iframe-launch' && type !== 'iframe-check') || !Number.isInteger(id) || id! < 0 || origin === null || origin !== sender.origin) {
        return { error: 'Only the Switchboard page can enable the iframe experiment.' };
      }
      const tab = iframeTab(await this.deps.tab(id!), this.deps.origin);
      if (tab?.origin !== origin || (tab.hosted ? !(typeof sender.frameId === 'number' && sender.frameId > 0) : sender.frameId !== 0))
        return { error: 'Not in the Switchboard tab.' };
      if (type === 'iframe-disable') {
        await this.#remove(id!);
        return { ok: true as const };
      }
      if (!(await this.deps.enabled(origin))) {
        await this.#remove(id!);
        return { error: 'The iframe experiment is off or this browser is signed out of Switchboard.' };
      }
      // The page may navigate while its sign-in is checked.
      if (iframeTab(await this.deps.tab(id!), this.deps.origin)?.origin !== origin) {
        await this.#remove(id!);
        return { error: 'The Switchboard tab navigated away.' };
      }
      const leases = await this.deps.leases();
      if (type === 'iframe-launch' || type === 'iframe-check') return { ok: true as const };
      if (!tab.hosted) { await this.#remove(id!); return { ok: true as const }; }
      await this.deps.update([id! + 1], [iframeRule(id!, tab.hosted ? IFRAME_EXTENSION_ORIGIN : origin)]);
      leases[String(id)] = { origin, until: this.deps.now() + IFRAME_LEASE_MS };
      try {
        await this.deps.save(leases);
      } catch (error) {
        await this.deps.update([id! + 1], []);
        throw error;
      }
      return { ok: true as const };
    }).catch(() => ({ error: 'Could not install iframe rules. Use Chrome/Edge 145 or later and reload the experimental extension.' }));
  }
  remove(id: number): Promise<void> {
    return this.#run(() => this.#remove(id));
  }
  navigated(id: number): Promise<void> {
    return this.#run(async () => {
      const lease = (await this.deps.leases())[String(id)];
      if (lease !== undefined && iframeTab(await this.deps.tab(id), this.deps.origin)?.origin !== lease.origin) await this.#remove(id);
    });
  }
  async #remove(id: number): Promise<void> {
    const leases = await this.deps.leases();
    await this.deps.update([id + 1], []);
    delete leases[String(id)];
    await this.deps.save(leases);
  }
  /** Rechecks sign-in and setting, and removes rules whose page stopped renewing its lease. */
  sweep(): Promise<void> {
    return this.#run(async () => {
      const leases = await this.deps.leases();
      const remove: number[] = [];
      for (const rule of await this.deps.rules()) {
        const id = rule.id - 1;
        const lease = leases[String(id)];
        let keep = false;
        try {
          keep =
            lease !== undefined &&
            lease.until > this.deps.now() &&
            iframeTab(await this.deps.tab(id), this.deps.origin)?.hosted === true &&
            iframeTab(await this.deps.tab(id), this.deps.origin)?.origin === lease.origin &&
            (await this.deps.enabled(lease.origin));
        } catch {
          /* A failed check removes the exception. */
        }
        if (!keep) {
          remove.push(rule.id);
          delete leases[String(id)];
        }
      }
      await this.deps.update(remove, []);
      await this.deps.save(leases);
    });
  }
}
