/** The bookmark the dock adds to a link that has none, which the dock's `Switcher.TabBookmark` also holds (PRD R74). */
export const TAB_BOOKMARK = '#switchboard-tab';

/** The query parameter the dock adds, before the bookmark, to a link that has one, which the dock's `Switcher.TabParameter` also holds. */
export const TAB_PARAMETER = 'switchboard-tab=1';

/** The name of the tab group that holds the dock's tabs in each window. */
export const GROUP_TITLE = 'Switchboard';

/**
 * A link the dock opened: `link` is the URL without the dock's mark, and `bookmark` says the mark is the bookmark, which can be removed without
 * loading the page again, rather than the query parameter. Null when the dock did not mark the URL.
 */
export function dockLink(url: string): { link: string; bookmark: boolean } | null {
  const hash = url.indexOf('#');

  if (hash !== -1 && url.slice(hash) === TAB_BOOKMARK) {
    return { link: url.slice(0, hash), bookmark: true };
  }

  const base = hash === -1 ? url : url.slice(0, hash);
  const question = base.indexOf('?');
  const query = question === -1 ? '' : base.slice(question + 1);
  // A parameter starts the query or follows `&`, so a URL in another parameter's value does not count.
  const match = /(^|&)switchboard-tab=1(&|$)/.exec(query);

  if (match === null) {
    return null;
  }

  const rest = query.slice(0, match.index) + (match[1] !== '' && match[2] !== '' ? '&' : '') + query.slice(match.index + match[0].length);

  return { link: base.slice(0, question) + (rest === '' ? '' : `?${rest}`) + (hash === -1 ? '' : url.slice(hash)), bookmark: false };
}

/**
 * The URL that removes a bookmark mark from a page that has started in the top frame without loading it again: the link with a bare `#`,
 * because a URL without `#` loads the page again (mechanics M28). Null for any other navigation.
 */
export function bookmarkRemoved(frameId: number, url: string): string | null {
  const dock = frameId === 0 ? dockLink(url) : null;

  return dock?.bookmark === true ? `${dock.link}#` : null;
}

/**
 * The tabs Chrome created that have not navigated yet, as Chrome creates one for a link from Windows. Only a tab's first navigation counts as
 * the dock's, so a reload, Back or Forward to a URL that still has the bookmark is not placed again, whenever the page commits.
 */
export function firstNavigations(): { created(tabId: number): void; first(tabId: number): boolean } {
  const fresh = new Set<number>();

  return {
    created: (tabId) => void fresh.add(tabId),
    first: (tabId) => fresh.delete(tabId),
  };
}

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
  index: number;
  url: string;
  /** The kind the tab was placed for, kept while it stays open and in the group, through redirects; undefined for a tab dragged in or placed before session storage was cleared. */
  kind?: string | undefined;
}

/** The part of `chrome.storage.session` the kind store uses. */
export interface SessionStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * The kind each placed tab was placed for, one key per tab so that concurrent writes for different tabs do not overwrite each other. Session
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

/** The Chrome calls `placeTab` makes. */
export interface Tabs {
  /** The window's Switchboard group and its tabs, or a null group with no tabs. */
  group(windowId: number): Promise<{ id: number | null; tabs: Tab[] }>;
  /** Adds the tab to the group, or to a new Switchboard group in the window when `groupId` is null. */
  join(tabId: number, windowId: number, groupId: number | null): Promise<void>;
  /** Records the kind the tab was placed for. */
  remember(tabId: number, kind: string): Promise<void>;
  move(tabId: number, index: number): Promise<void>;
  load(tabId: number, url: string): Promise<void>;
  close(tabId: number): Promise<void>;
}

/**
 * Handles a new tab's navigation to a link the dock marked (PRD R74): the tab joins the window's Switchboard group, takes the place of the
 * group's tab of the same kind, which closes, and loads the link without a query mark. Returns the closed tab, or null.
 */
export async function placeTab(tabs: Tabs, tabId: number, windowId: number, url: string): Promise<number | null> {
  const dock = dockLink(url);

  if (dock === null) {
    return null;
  }

  // Loading again only restarts the navigation under way, before the page arrives.
  if (!dock.bookmark) {
    await tabs.load(tabId, dock.link);
  }

  const group = await tabs.group(windowId);
  const kind = tabKind(dock.link);
  // A site such as Zoho Desk redirects a link to another address, so a placed tab's kind is the one recorded, not its address's.
  const old = kind === null ? undefined : group.tabs.find((tab) => tab.id !== tabId && (tab.kind ?? tabKind(dockLink(tab.url)?.link ?? tab.url)) === kind);

  await tabs.join(tabId, windowId, group.id);

  if (kind !== null) {
    await tabs.remember(tabId, kind);
  }

  if (old === undefined) {
    return null;
  }

  // Joining can move the new tab from before the group to its end, which shifts the old tab's index.
  const index = (await tabs.group(windowId)).tabs.find((tab) => tab.id === old.id)?.index;

  // The operator closed the old tab or took it out of the group meanwhile.
  if (index === undefined) {
    return null;
  }

  await tabs.move(tabId, index);
  await tabs.close(old.id);
  return old.id;
}

/**
 * Runs `placeTab` for one navigation at a time, so a second link that arrives while the first is handled finds the group and tab the first
 * left instead of making its own. A failed run does not stop the next.
 */
export function tabPlacer(tabs: Tabs): (tabId: number, windowId: number, url: string) => Promise<number | null> {
  let last: Promise<unknown> = Promise.resolve();

  return (tabId, windowId, url) => {
    const run = last.then(
      () => placeTab(tabs, tabId, windowId, url),
      () => placeTab(tabs, tabId, windowId, url),
    );

    last = run;
    return run;
  };
}
