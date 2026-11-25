// Where the page is (architecture.md § Web page, Route and restore): the open work item, its tab and what the tab shows, in the
// address's hash and in local storage, so a reload, and an installed app the system ended and started again at its start URL with no hash,
// comes back to it.

/**
 * The open work item and its tab: `history`, `console`, `artifact:<path>`, `link` with the link tab's URL `u`, `changes` with the file
 * `f` its diff was at, or `file` with the local file `p` at line `l`; null for its Conversation. An address from before link tabs had URLs names
 * `browser`, read as `link` with no URL, and one from before History took the Status tab's place names `status`, read as `history`. `h` is the ticket whose History an address from before History was a tab showed, with its key, which
 * the page opens as the History tab. `list` is the phone's list (`#list`), which names no work item.
 */
export interface Route {
  w: number | null;
  t: string | null;
  f?: string | null;
  p?: string | null;
  l?: number | null;
  u?: string | null;
  h?: { ticketId: number; key: string } | null;
  list?: boolean;
}

/** The phone's list, an address of its own, so a reload after Back to the list shows the list. */
export const LIST_HASH = '#list';

/** Where this device keeps the route for a start with no hash. */
export const ROUTE_KEY = 'switchboard.route';
/** Where this tab keeps each work item's and tab's scroll place for a reload. */
export const SCROLL_KEY = 'switchboard.scroll';
/** How many places it keeps, the latest. */
export const SCROLLS_KEPT = 40;

const whole = (value: string | null): number | null => {
  const number = Number(value);

  return value !== null && Number.isSafeInteger(number) && number > 0 ? number : null;
};

/** The route a hash names, as `#w=12&t=changes&f=src%2Fa.ts`; no work item for any other. */
export function parseRoute(hash: string): Route {
  if (hash === LIST_HASH) {
    return { w: null, t: null, f: null, p: null, l: null, u: null, h: null, list: true };
  }

  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const w = whole(params.get('w'));
  const ticketId = whole(params.get('h'));
  const h = ticketId === null ? null : { ticketId, key: params.get('hk') ?? '' };
  const named = w === null ? null : params.get('t') || null;
  const t = named === 'browser' ? 'link' : named === 'status' ? 'history' : named;

  return { w, t, f: t === 'changes' ? params.get('f') || null : null, p: t === 'file' ? params.get('p') || null : null, l: t === 'file' ? whole(params.get('l')) : null, u: t === 'link' ? params.get('u') || null : null, h };
}

export function routeHash(route: Route): string {
  if (route.list === true) {
    return LIST_HASH;
  }

  const params: Array<[string, string]> = [];

  if (route.w !== null) {
    params.push(['w', String(route.w)]);

    if (route.t !== null) {
      params.push(['t', route.t]);
    }

    if (route.t === 'changes' && route.f != null) {
      params.push(['f', route.f]);
    }

    if (route.t === 'link' && route.u != null) {
      params.push(['u', route.u]);
    }

    if (route.t === 'file' && route.p != null) {
      params.push(['p', route.p]);

      if (route.l != null) {
        params.push(['l', String(route.l)]);
      }
    }
  }

  if (route.h != null) {
    params.push(['h', String(route.h.ticketId)], ['hk', route.h.key]);
  }

  return params.length === 0 ? '#' : `#${params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}`;
}

/** The route to start on: the address's, the list for `#list`, or with none there, the one this device kept. */
export function startRoute(hash: string, kept: string | null): Route {
  const own = parseRoute(hash);

  return own.w !== null || own.h != null || own.list === true || kept === null ? own : parseRoute(kept);
}

/**
 * A pane's scroll place: for the conversation, the first item in view, how far below the pane's top it starts and whether it followed the end;
 * for another tab, its scroll top.
 */
export interface ScrollPlace {
  id: string | null;
  offset: number;
  pinned: boolean;
  top: number;
}

/** The places kept, by `<work item> <tab>`; none from a malformed value. */
export function parseScrolls(raw: string | null): Record<string, ScrollPlace> {
  try {
    const kept = JSON.parse(raw ?? '{}') as unknown;

    if (kept === null || typeof kept !== 'object' || Array.isArray(kept)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(kept as Record<string, Partial<ScrollPlace>>).filter(
        ([, place]) => place !== null && typeof place === 'object' && (typeof place.id === 'string' || place.id === null) && typeof place.offset === 'number' && typeof place.pinned === 'boolean' && typeof place.top === 'number',
      ),
    ) as Record<string, ScrollPlace>;
  } catch {
    return {};
  }
}

/** The places with one more, the latest {@link SCROLLS_KEPT}. */
export function withScroll(places: Record<string, ScrollPlace>, key: string, place: ScrollPlace): Record<string, ScrollPlace> {
  const rest = Object.entries(places).filter(([one]) => one !== key);

  return Object.fromEntries([...rest, [key, place] as const].slice(-SCROLLS_KEPT));
}

/**
 * A work item's tabs as this device left them: the column's and the conversation pane's tab (`side`, `tab`) and the artifact shown, whether
 * the Changes tab was open and the file it was at, and the file tabs in their order with the one shown, so another work item and back, or a
 * reload, brings them back. The artifact tabs follow the work item's artifacts and the closed ones the hub keeps (architecture.md § Web page).
 */
export interface TabSet {
  side: string;
  tab: string;
  artifact: string | null;
  changes: boolean;
  changesFile: string | null;
  files: Array<{ target: string; line: number | null }>;
  /** The index in `files` of the file tab shown, or null. */
  file: number | null;
  /** The link tabs (`LinkSet` in iframeBrowser.ts); absent in a set kept before they were kept. */
  links?: { open: Array<{ url: string; name: string }>; closed: string[]; selected: string };
}

/** Where this device keeps each work item's tabs. */
export const TABS_KEY = 'switchboard.tabs';
/** How many work items' tabs it keeps, the latest. */
export const TAB_SETS_KEPT = 30;

const text = (value: unknown): value is string => typeof value === 'string';
const textOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const lineOrNull = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);

const linkSet = (value: unknown): boolean => {
  const links = value as TabSet['links'];

  return (
    links !== null &&
    typeof links === 'object' &&
    Array.isArray(links.open) &&
    links.open.every((one) => one !== null && typeof one === 'object' && text(one.url) && text(one.name)) &&
    Array.isArray(links.closed) &&
    links.closed.every(text) &&
    text(links.selected)
  );
};

/** A work item's key in the kept tab sets: not a bare number, so the sets keep their order, the latest last. */
export const tabSetKey = (workItemId: number): string => `w${workItemId}`;

/** The tab sets kept, by {@link tabSetKey}; any malformed one is left out. */
export function parseTabSets(raw: string | null): Record<string, TabSet> {
  try {
    const kept = JSON.parse(raw ?? '{}') as unknown;

    if (kept === null || typeof kept !== 'object' || Array.isArray(kept)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(kept as Record<string, Partial<TabSet>>).filter(
        ([key, set]) =>
          /^w[1-9][0-9]*$/.test(key) &&
          set !== null &&
          typeof set === 'object' &&
          text(set.side) &&
          text(set.tab) &&
          textOrNull(set.artifact) &&
          typeof set.changes === 'boolean' &&
          textOrNull(set.changesFile) &&
          Array.isArray(set.files) &&
          set.files.every((one) => one !== null && typeof one === 'object' && text(one.target) && lineOrNull(one.line)) &&
          (set.file === null || (typeof set.file === 'number' && Number.isSafeInteger(set.file) && set.file >= 0 && set.file < set.files.length)) &&
          (set.links === undefined || linkSet(set.links)),
      ).map(([key, set]) => {
        // A set kept before History took the Status tab's place names `status`, and one kept while History could close says whether it was open.
        const { history: _history, ...kept } = set as TabSet & { history?: unknown };

        return [key, { ...kept, side: kept.side === 'status' ? 'history' : kept.side, tab: kept.tab === 'status' ? 'history' : kept.tab }];
      }),
    ) as Record<string, TabSet>;
  } catch {
    return {};
  }
}

/** The tab sets with a work item's set as the latest, the latest {@link TAB_SETS_KEPT}. */
export function withTabSet(sets: Record<string, TabSet>, workItemId: number, set: TabSet): Record<string, TabSet> {
  const key = tabSetKey(workItemId);

  return Object.fromEntries([...Object.entries(sets).filter(([one]) => one !== key), [key, set] as const].slice(-TAB_SETS_KEPT));
}
