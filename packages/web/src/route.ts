// Where the page is (architecture.md § Web page, Route and restore): the open work item, its tab and what the tab shows, and History, in the
// address's hash and in local storage, so a reload, and an installed app the system ended and started again at its start URL with no hash,
// comes back to it.

/**
 * The open work item and its tab: `status`, `console`, `browser`, `artifact:<path>`, `changes` with the file `f` its diff was at, or
 * `file` with the local file `p` at line `l`; null for its Conversation. `h` is the ticket whose History shows, with its key.
 */
export interface Route {
  w: number | null;
  t: string | null;
  f?: string | null;
  p?: string | null;
  l?: number | null;
  h?: { ticketId: number; key: string } | null;
}

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

/** The route a hash names, as `#w=12&t=changes&f=src%2Fa.ts`; no work item for any other, though History may show over the list. */
export function parseRoute(hash: string): Route {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const w = whole(params.get('w'));
  const ticketId = whole(params.get('h'));
  const h = ticketId === null ? null : { ticketId, key: params.get('hk') ?? '' };
  const t = w === null ? null : params.get('t') || null;

  return { w, t, f: t === 'changes' ? params.get('f') || null : null, p: t === 'file' ? params.get('p') || null : null, l: t === 'file' ? whole(params.get('l')) : null, h };
}

export function routeHash(route: Route): string {
  const params: Array<[string, string]> = [];

  if (route.w !== null) {
    params.push(['w', String(route.w)]);

    if (route.t !== null) {
      params.push(['t', route.t]);
    }

    if (route.t === 'changes' && route.f != null) {
      params.push(['f', route.f]);
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

/** The route to start on: the address's, or with none there, the one this device kept. */
export function startRoute(hash: string, kept: string | null): Route {
  const own = parseRoute(hash);

  return own.w !== null || own.h != null || kept === null ? own : parseRoute(kept);
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
