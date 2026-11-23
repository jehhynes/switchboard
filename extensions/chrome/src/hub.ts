/** The hub's browser endpoint port; equal to `BROWSER_PORT` in @switchboard/core and the manifest's host permission. */
export const BROWSER_PORT = 47615;

/** Where the extension reads and posts to the hub. */
export interface HubRoutes {
  /** The web page's HTTPS origin on another device (PRD R121), or null for the hub on this computer. */
  origin: string | null;
  snoozed: string;
  cards: string;
  snooze: string;
  unsnooze: string;
}

/** The hub on this computer: its loopback browser endpoint. */
export const LOCAL_ROUTES: HubRoutes = {
  origin: null,
  snoozed: `http://127.0.0.1:${BROWSER_PORT}/snoozed`,
  cards: `http://127.0.0.1:${BROWSER_PORT}/cards`,
  snooze: `http://127.0.0.1:${BROWSER_PORT}/snooze`,
  unsnooze: `http://127.0.0.1:${BROWSER_PORT}/unsnooze`,
};


/**
 * The web page's origin on this computer, such as `http://127.0.0.1:47616`, the first origin the hub's `GET /iframe` vouches for; null when the
 * hub does not answer or names none. The extension cannot read `hub.json`, and the page's port is a setting.
 */
export async function readLocalPage(fetchUrl: (url: string) => Promise<Response>): Promise<string | null> {
  try {
    const response = await fetchUrl(`http://127.0.0.1:${BROWSER_PORT}/iframe`);
    const body: unknown = response.ok ? await response.json() : null;
    const origins = typeof body === 'object' && body !== null ? (body as { origins?: unknown }).origins : undefined;
    const first = Array.isArray(origins) ? origins[0] : undefined;

    return typeof first === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

/** The file the hub adds to a copy it gives another device, naming its web page's origin (architecture.md § Browser extension). */
export const REMOTE_FILE = 'remote.json';

/** The hub reached through the web page's origin on another device, whose browser routes take the page's sign-in cookie. */
export function remoteRoutes(origin: string): HubRoutes {
  return { origin, snoozed: `${origin}/v1/browser/snoozed`, cards: `${origin}/v1/browser/cards`, snooze: `${origin}/v1/browser/snooze`, unsnooze: `${origin}/v1/browser/unsnooze` };
}

/**
 * The routes the extension's own `remote.json` names: the remote ones for an HTTPS origin, the loopback ones when the file is missing, as in the
 * build loaded from `dist`, or holds anything else.
 */
export async function readRoutes(fetchUrl: (url: string) => Promise<Response>, url: string): Promise<HubRoutes> {
  try {
    const response = await fetchUrl(url);
    const body: unknown = response.ok ? await response.json() : null;
    const origin = typeof body === 'object' && body !== null ? (body as { origin?: unknown }).origin : undefined;

    return typeof origin === 'string' && /^https:\/\/[a-z0-9.-]+$/i.test(origin) ? remoteRoutes(origin.toLowerCase()) : LOCAL_ROUTES;
  } catch {
    return LOCAL_ROUTES;
  }
}

/** The URLs of snoozed tickets, or null when the hub does not answer or answers with something else (PRD R56). */
export async function readSnoozed(fetchUrl: (url: string) => Promise<Response>, routes: HubRoutes = LOCAL_ROUTES): Promise<string[] | null> {
  try {
    const response = await fetchUrl(routes.snoozed);

    if (!response.ok) {
      return null;
    }

    const body: unknown = await response.json();
    const urls = typeof body === 'object' && body !== null ? (body as { urls?: unknown }).urls : undefined;

    return Array.isArray(urls) && urls.every((url) => typeof url === 'string') ? urls : null;
  } catch {
    return null;
  }
}
