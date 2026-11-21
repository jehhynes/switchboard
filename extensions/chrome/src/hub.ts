/** The hub's browser endpoint port; equal to `BROWSER_PORT` in @switchboard/core and the manifest's host permission. */
export const BROWSER_PORT = 47615;

export const SNOOZED_URL = `http://127.0.0.1:${BROWSER_PORT}/snoozed`;
export const PANE_STATE_URL = `http://127.0.0.1:${BROWSER_PORT}/pane`;

/** Whether the hub has the Chrome pane on (PRD R113), or null when the hub does not answer or answers with something else. */
export async function readPaneEnabled(fetchUrl: (url: string) => Promise<Response>): Promise<boolean | null> {
  try {
    const response = await fetchUrl(PANE_STATE_URL);

    if (!response.ok) {
      return null;
    }

    const body: unknown = await response.json();
    const enabled = typeof body === 'object' && body !== null ? (body as { enabled?: unknown }).enabled : undefined;

    return typeof enabled === 'boolean' ? enabled : null;
  } catch {
    return null;
  }
}

/** The URLs of snoozed tickets, or null when the hub does not answer or answers with something else (PRD R56). */
export async function readSnoozed(fetchUrl: (url: string) => Promise<Response>): Promise<string[] | null> {
  try {
    const response = await fetchUrl(SNOOZED_URL);

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
