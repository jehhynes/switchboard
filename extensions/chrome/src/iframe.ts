import { frameUrl } from './iframeUrl.js';
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
export async function iframeAccess(fetchUrl: (url: string) => Promise<Response>, origin: string, remote: string | null): Promise<import('./hostStartup.js').HostAccess> {
  if (iframePage(`${origin}/page/`, remote) !== origin) return 'refused';
  const read = async (url: string): Promise<{ state: 'ok'; body: unknown } | { state: 'offline' | 'refused' }> => {
    let response: Response;
    try { response = await fetchUrl(url); } catch { return { state: 'offline' }; }
    if ([502, 503, 504].includes(response.status)) return { state: 'offline' };
    if (!response.ok) return { state: 'refused' };
    try { return { state: 'ok', body: await response.json() }; } catch { return { state: 'refused' }; }
  };
  if (remote === null) {
    const response = await read(`http://127.0.0.1:${BROWSER_PORT}/iframe`);
    if (response.state !== 'ok') return response.state;
    const state = response.body as { enabled?: unknown; origins?: unknown } | null;
    if (state?.enabled !== true || !Array.isArray(state.origins) || !state.origins.includes(origin)) return 'refused';
  }
  const response = await read(`${origin}/v1/browser/iframe`);
  if (response.state !== 'ok') return response.state;
  return (response.body as { enabled?: unknown } | null)?.enabled === true ? 'enabled' : 'refused';
}

export async function iframeEnabled(fetchUrl: (url: string) => Promise<Response>, origin: string, remote: string | null): Promise<boolean> {
  return await iframeAccess(fetchUrl, origin, remote) === 'enabled';
}

/** Header changes stay inside a verified extension host, except the service-worker rule for IFRAME_WORKER_HOSTS; its Switchboard child keeps its CSP. */
export interface IframeRule {
  id: number;
  priority: number;
  action: { type: 'modifyHeaders'; responseHeaders: Array<{ header: string; operation: 'remove' }> } | { type: 'allow' };
  condition: { tabIds: number[]; topDomains: string[]; regexFilter?: string; urlFilter?: string; initiatorDomains?: string[]; resourceTypes: ['sub_frame'] | ['xmlhttprequest'] };
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
  rules?: number[];
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

export function iframeRule(tabId: number, host: string, id: number): IframeRule {
  const hostname = new URL(`http://${host}`).hostname;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    // topDomains (Chrome 145+) keeps the rule from applying after the tab navigates away, before onUpdated runs.
    condition: { tabIds: [tabId], topDomains: [BROWSER_EXTENSION_ID], initiatorDomains: [BROWSER_EXTENSION_ID, hostname], regexFilter: `^https?://${escaped}/`, resourceTypes: ['sub_frame'] },
  };
}

/** The exact hosts whose own service worker gets the X-Frame-Options exception below, because the exception is not bound to the tab (operator decision 2026-11-24). */
export const IFRAME_WORKER_HOSTS: readonly string[] = ['desk.zoho.com'];

/**
 * Zoho Desk answers navigations in its scope from its own service worker. That worker's network fetch has no tab (-1), the
 * xmlhttprequest type, and the site's own domain as its top domain when the site navigates its frame, so the frame's rule misses it and the
 * response keeps its X-Frame-Options refusal (mechanics M153). This rule removes only X-Frame-Options and leaves CSP alone, so a
 * CSP frame-ancestors refusal served this way still refuses. A worker fetch has no tab, and Chrome takes its top domain from its initiator, so
 * the rule cannot tell this frame from the same site framed elsewhere: while the lease lasts, any page of that exact host its worker serves can
 * be framed by any site, and its other worker fetches lose the header too.
 */
export function iframeWorkerRule(host: string, id: number): IframeRule {
  const hostname = new URL(`http://${host}`).hostname;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    id,
    priority: 1,
    action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x-frame-options', operation: 'remove' }] },
    condition: { tabIds: [-1], topDomains: [BROWSER_EXTENSION_ID, hostname], initiatorDomains: [BROWSER_EXTENSION_ID, hostname], regexFilter: `^https?://${escaped}/`, resourceTypes: ['xmlhttprequest'] },
  };
}

export function iframePageRule(tabId: number, origin: string, id: number): IframeRule {
  const page = new URL(origin);
  const filter = page.hostname === 'localhost' || page.hostname === '127.0.0.1'
    ? { regexFilter: `^${page.protocol}//(localhost|127\\.0\\.0\\.1):${page.port}/` }
    : { urlFilter: `|${origin}/` };
  return {
    id,
    priority: 2,
    action: { type: 'allow' },
    condition: { tabIds: [tabId], topDomains: [new URL(IFRAME_EXTENSION_ORIGIN).hostname], ...filter, resourceTypes: ['sub_frame'] },
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
      const urls = (message as { urls?: unknown }).urls;
      if (!Array.isArray(urls) || !urls.every((url) => frameUrl(url, origin))) return { error: 'Invalid website tabs.' };
      const hosts = [...new Set((urls as string[]).map((url) => new URL(url).host))];
      // Browser tab IDs can approach the signed 32-bit limit; allocate independent rule IDs.
      const previous: number[] = leases[String(id)]?.rules ?? [];
      const used = new Set((await this.deps.rules()).map((rule) => rule.id).filter((ruleId) => !previous.includes(ruleId)));
      const ids: number[] = [];
      const workers = hosts.filter((host) => IFRAME_WORKER_HOSTS.includes(host));
      for (let i = 0, next = 1; i <= hosts.length + workers.length; i++) { while (used.has(next)) next++; ids.push(next); used.add(next++); }
      await this.deps.update(previous, [
        ...hosts.map((host, i) => iframeRule(id!, host, ids[i]!)),
        ...workers.map((host, i) => iframeWorkerRule(host, ids[hosts.length + i]!)),
        iframePageRule(id!, origin, ids[hosts.length + workers.length]!),
      ]);
      leases[String(id)] = { origin, until: this.deps.now() + IFRAME_LEASE_MS, rules: ids };
      try {
        await this.deps.save(leases);
      } catch (error) {
        await this.deps.update(ids, []);
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
    await this.deps.update(leases[String(id)]?.rules ?? [], []);
    delete leases[String(id)];
    await this.deps.save(leases);
  }
  /** Rechecks sign-in and setting, and removes rules whose page stopped renewing its lease. */
  sweep(): Promise<void> {
    return this.#run(async () => {
      const leases = await this.deps.leases();
      const keepIds = new Set<number>();
      const rules = await this.deps.rules();
      for (const [key, lease] of Object.entries(leases)) {
        const id = Number(key);
        let keep = false;
        try {
          const tab = iframeTab(await this.deps.tab(id), this.deps.origin);
          keep =
            Number.isSafeInteger(id) && id >= 0 && lease.rules !== undefined && lease.rules.length > 0 && lease.rules.every((ruleId) => rules.some((rule) => rule.id === ruleId)) &&
            lease.until > this.deps.now() &&
            tab?.hosted === true && tab.origin === lease.origin &&
            (await this.deps.enabled(lease.origin));
        } catch {
          /* A failed check removes the exception. */
        }
        if (keep) for (const ruleId of lease.rules!) keepIds.add(ruleId);
        else delete leases[key];
      }
      await this.deps.update(rules.filter((rule) => !keepIds.has(rule.id)).map((rule) => rule.id), []);
      await this.deps.save(leases);
    });
  }
}
