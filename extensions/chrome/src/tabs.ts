const LOOPBACK_PAGE = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/;

/** The name of the tab group that holds Switchboard's links in a window. */
export const GROUP_TITLE = 'Switchboard';

/** The longest link the page may ask the extension to open. */
export const MAX_LINK = 2_048;

/**
 * The kind of page a tab shows, which one tab of the Switchboard group holds: a GitHub issue, a GitHub pull request, else the host and first
 * path segment, such as `desk.zoho.com/agent` or `forum.example.com/t`. Null for a URL that is not http(s).
 */
export function tabKind(url: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  const host = parsed.host.toLowerCase();
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');

  if (host === 'github.com' && segments.length >= 4 && /^\d+$/.test(segments[3]!)) {
    if (segments[2] === 'issues') {
      return 'github.com/issues';
    }

    if (segments[2] === 'pull') {
      return 'github.com/pull';
    }
  }

  return `${host}/${(segments[0] ?? '').toLowerCase()}`;
}

export interface Tab {
  id: number;
  url: string;
  /** The kind the tab was opened for, kept while it stays open and in the group, through redirects; undefined for a tab dragged in or opened before session storage was cleared. */
  kind?: string | undefined;
}

/** The part of `chrome.storage.session` the kind store uses. */
export interface SessionStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * The kind each grouped tab was opened for, one key per tab so that concurrent writes for different tabs do not overwrite each other. Session
 * storage outlives the service worker, which stops when idle, and is cleared when the browser restarts or the extension reloads.
 */
export function placedKinds(storage: SessionStorage) {
  const key = (tabId: number) => `placedKind:${tabId}`;

  return {
    async of(tabIds: number[]): Promise<Map<number, string>> {
      const stored = tabIds.length === 0 ? {} : await storage.get(tabIds.map(key));

      return new Map(tabIds.flatMap((tabId) => (typeof stored[key(tabId)] === 'string' ? [[tabId, stored[key(tabId)] as string]] : [])));
    },
    remember: (tabId: number, kind: string) => storage.set({ [key(tabId)]: kind }),
    forget: (tabId: number) => storage.remove(key(tabId)),
  };
}

/** The Chrome calls `openLink` makes. */
export interface Tabs {
  /** The last focused normal window, or null when the browser has none. */
  window(): Promise<number | null>;
  /** The Switchboard group in that window, else in another window, with its window and tabs; null when no window has one. */
  group(windowId: number | null): Promise<{ id: number; windowId: number; tabs: Tab[] } | null>;
  /** Opens the link in a new active tab of the window, or in a new normal window when `windowId` is null. */
  create(windowId: number | null, url: string): Promise<{ tabId: number; windowId: number }>;
  /** Adds the tab to the group, or to a new Switchboard group in the tab's window when `groupId` is null. */
  join(tabId: number, windowId: number, groupId: number | null): Promise<void>;
  /** Records the kind the tab was opened for. */
  remember(tabId: number, kind: string): Promise<void>;
  load(tabId: number, url: string): Promise<void>;
  /** Makes the tab active and brings its window to the front. */
  show(tabId: number, windowId: number): Promise<void>;
}

/**
 * Opens a link the web page asked for in the Switchboard tab group, one tab per kind: the group's tab of the link's kind loads it, or only comes
 * to the front when it already shows it, and otherwise a new tab joins the group, which is made in the last focused window when no window has
 * one. Returns what it did.
 */
export async function openLink(tabs: Tabs, url: string): Promise<'shown' | 'loaded' | 'opened'> {
  const kind = tabKind(url);

  if (kind === null) {
    throw new Error(`Not an http or https link: ${url}`);
  }

  const windowId = await tabs.window();
  const group = await tabs.group(windowId);
  // A site such as Zoho Desk redirects a link to another address, so a grouped tab's kind is the one recorded, not its address's.
  const old = group?.tabs.find((tab) => (tab.kind ?? tabKind(tab.url)) === kind);

  if (group !== null && old !== undefined) {
    const same = old.url === url;

    if (!same) {
      await tabs.load(old.id, url);
    }

    await tabs.remember(old.id, kind);
    await tabs.show(old.id, group.windowId);
    return same ? 'shown' : 'loaded';
  }

  const created = await tabs.create(group?.windowId ?? windowId, url);

  await tabs.join(created.tabId, created.windowId, group?.windowId === created.windowId ? group.id : null);
  await tabs.remember(created.tabId, kind);
  await tabs.show(created.tabId, created.windowId);
  return 'opened';
}

/**
 * Runs `openLink` for one link at a time, so a second link that arrives while the first is handled finds the group and tab the first left
 * instead of making its own. A failed run does not stop the next. A link whose turn comes after `deadline` is refused unopened, because the
 * page has stopped waiting and opened it itself.
 */
export function linkOpener(tabs: Tabs, now: () => number = Date.now): (url: string, deadline?: number) => Promise<'shown' | 'loaded' | 'opened'> {
  let last: Promise<unknown> = Promise.resolve();

  return (url, deadline = Infinity) => {
    const one = async () => {
      if (now() > deadline) {
        throw new Error('The page stopped waiting for this link.');
      }

      return openLink(tabs, url);
    };
    const run = last.then(one, one);

    last = run;
    return run;
  };
}

/**
 * A web page's request: `links` asks whether the extension opens the page's links, `open` opens one, its URL null when it is not one, and
 * `until` the time, in milliseconds since the epoch on the same computer's clock, after which the page no longer waits for it, or null.
 */
export type LinkRequest = { type: 'links' } | { type: 'open'; url: string | null; until: number | null };

/** The page's link request in a message from a web page, or null for another message. */
export function linkRequest(message: unknown): LinkRequest | null {
  const type = (message as { type?: unknown } | null)?.type;

  if (type === 'links') {
    return { type };
  }

  if (type !== 'open') {
    return null;
  }

  const { url, until } = message as { url?: unknown; until?: unknown };

  return { type, url: typeof url === 'string' && url.length <= MAX_LINK && tabKind(url) !== null ? url : null, until: typeof until === 'number' && Number.isFinite(until) ? until : null };
}

/**
 * Answers the web page's link request (architecture.md § Browser extension): only the page of the hub this copy reaches is heard, a loopback
 * page for the hub on this computer, or the page's own origin for a copy on another device.
 */
export async function answerLink(request: LinkRequest, origin: string | undefined, hubOrigin: string | null, open: (url: string, deadline?: number) => Promise<unknown>): Promise<{ links: true } | { opened: true } | { error: string }> {
  const heard = origin !== undefined && (hubOrigin === null ? LOOPBACK_PAGE.test(origin) : origin === hubOrigin);

  if (!heard) {
    return { error: 'Only the Switchboard page can ask this.' };
  }

  if (request.type === 'links') {
    return { links: true };
  }

  if (request.url === null) {
    return { error: 'The link is not an http or https URL.' };
  }

  try {
    await open(request.url, request.until ?? undefined);
    return { opened: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
