import { describe, expect, it, vi } from 'vitest';
import { MAX_TABS, PANE_SOCKET_URL, PING_MS, PaneConnection, PaneWindow, paneLinks, paneMarker } from '../src/pane.js';
import type { KeyValue, PaneBrowser, PaneSocketLike } from '../src/pane.js';

const MARKER_PAGE = 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/pane.html';

function memory(initial: Record<string, unknown> = {}): KeyValue & { items: Record<string, unknown> } {
  const items: Record<string, unknown> = { ...initial };

  return {
    items,
    get: async (key) => (key in items ? { [key]: structuredClone(items[key]) } : {}),
    set: async (next) => void Object.assign(items, structuredClone(next)),
    remove: async (key) => void delete items[key],
  };
}

/** Windows and tabs as Chrome keeps them, with every call recorded. */
function browser() {
  const windows = new Map<number, Array<{ id: number; url: string; active: boolean }>>();
  const calls: string[] = [];
  let next = 100;
  const fake: PaneBrowser = {
    markerUrl: (marker) => `${MARKER_PAGE}#${marker}`,
    isMarker: (url) => url.startsWith(MARKER_PAGE),
    createWindow: async (url) => {
      const id = next++;

      windows.set(id, [{ id: next++, url, active: true }]);
      calls.push(`window ${url}`);
      return id;
    },
    windowExists: async (id) => windows.has(id),
    tabs: async (id) => (windows.get(id) ?? []).map(({ id: tabId, url }) => ({ id: tabId, url })),
    openTab: async (windowId, url, active) => {
      const id = next++;

      windows.get(windowId)!.push({ id, url, active });
      calls.push(`open ${url}${active ? ' active' : ''}`);
      return id;
    },
    loadTab: async (tabId, url) => {
      [...windows.values()].flat().find((tab) => tab.id === tabId)!.url = url;
      calls.push(`load ${tabId} ${url}`);
    },
    activateTab: async (tabId) => void calls.push(`activate ${[...windows.values()].flat().find((tab) => tab.id === tabId)!.url}`),
    closeTab: async (tabId) => {
      for (const tabs of windows.values()) {
        const at = tabs.findIndex((tab) => tab.id === tabId);

        if (at >= 0) {
          calls.push(`close ${tabs[at]!.url}`);
          tabs.splice(at, 1);
        }
      }
    },
  };

  return { fake, windows, calls };
}

describe('paneMarker and paneLinks', () => {
  it('takes only twelve hex digits as a marker', () => {
    expect(paneMarker('0123456789ab')).toBe('0123456789ab');
    expect(paneMarker('0123456789AB')).toBeNull();
    expect(paneMarker('0123456789a')).toBeNull();
    expect(paneMarker(12)).toBeNull();
  });

  it('takes http and https links only, at most twenty, with the active one among them', () => {
    expect(paneLinks(['https://github.com/o/r/issues/1', 'http://x.test/'], 'http://x.test/')).toEqual({ urls: ['https://github.com/o/r/issues/1', 'http://x.test/'], active: 'http://x.test/' });
    expect(paneLinks(['javascript:alert(1)'], 'javascript:alert(1)')).toBeNull();
    expect(paneLinks(['file:///C:/x'], 'file:///C:/x')).toBeNull();
    expect(paneLinks(['https://a.test/'], 'https://b.test/')).toBeNull();
    expect(paneLinks([], '')).toBeNull();
    expect(paneLinks(['not a url'], 'not a url')).toBeNull();
    expect(paneLinks([`https://a.test/${'x'.repeat(2048)}`], `https://a.test/${'x'.repeat(2048)}`)).toBeNull();
    const many = Array.from({ length: MAX_TABS + 1 }, (_, index) => `https://a.test/${index}`);
    expect(paneLinks(many, many[0])).toBeNull();
    expect(paneLinks('https://a.test/', 'https://a.test/')).toBeNull();
  });
});

describe('PaneWindow', () => {
  it('opens one window on the marker page, then shows a tab per link with the active one in front and the marker tab closed', async () => {
    const { fake, windows, calls } = browser();
    const session = memory();
    const pane = new PaneWindow(fake, session);

    await pane.mark('0123456789ab');
    expect(calls).toEqual([`window ${MARKER_PAGE}#0123456789ab`]);

    await pane.show(['https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/2'], 'https://github.com/o/r/pull/2');
    expect(calls.slice(1)).toEqual(['open https://github.com/o/r/issues/1', 'open https://github.com/o/r/pull/2', 'activate https://github.com/o/r/pull/2', `close ${MARKER_PAGE}#0123456789ab`]);
    expect([...windows.values()][0]!.map((tab) => tab.url)).toEqual(['https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/2']);
  });

  it('keeps the tabs of links still listed, closes only the tabs it opened for other links, and leaves the operator’s tabs', async () => {
    const { fake, windows, calls } = browser();
    const pane = new PaneWindow(fake, memory());

    await pane.mark('0123456789ab');
    await pane.show(['https://a.test/1', 'https://a.test/2'], 'https://a.test/1');

    const windowId = [...windows.keys()][0]!;

    await fake.openTab(windowId, 'https://mine.test/', false);
    // A redirect changes the tab's address; it is still the link's tab.
    windows.get(windowId)![0]!.url = 'https://a.test/1?redirected';
    calls.length = 0;

    await pane.show(['https://a.test/1', 'https://b.test/3'], 'https://b.test/3');
    expect(calls).toEqual(['open https://b.test/3', 'activate https://b.test/3', 'close https://a.test/2']);
    expect(windows.get(windowId)!.map((tab) => tab.url)).toEqual(['https://a.test/1?redirected', 'https://mine.test/', 'https://b.test/3']);
  });

  it('opens a link again whose tab the operator closed, and does nothing without a window', async () => {
    const { fake, windows, calls } = browser();
    const pane = new PaneWindow(fake, memory());

    await pane.show(['https://a.test/1'], 'https://a.test/1');
    expect(calls).toEqual([]);

    await pane.mark('0123456789ab');
    await pane.show(['https://a.test/1'], 'https://a.test/1');

    const tabs = windows.get([...windows.keys()][0]!)!;

    await fake.closeTab(tabs[0]!.id);
    calls.length = 0;
    await pane.show(['https://a.test/1'], 'https://a.test/1');
    expect(calls).toEqual(['open https://a.test/1', 'activate https://a.test/1']);
  });

  it('marks an open window again in its marker tab, or a new one, and opens a new window once the old one closed', async () => {
    const { fake, windows, calls } = browser();
    const session = memory();
    const pane = new PaneWindow(fake, session);

    await pane.mark('0123456789ab');
    const windowId = [...windows.keys()][0]!;
    const markerTab = windows.get(windowId)![0]!.id;

    await pane.mark('ba9876543210');
    expect(calls[1]).toBe(`load ${markerTab} ${MARKER_PAGE}#ba9876543210`);
    expect(calls[2]).toBe(`activate ${MARKER_PAGE}#ba9876543210`);

    await pane.show(['https://a.test/1'], 'https://a.test/1');
    await pane.mark('aaaaaaaaaaaa');
    expect(calls.at(-1)).toBe(`open ${MARKER_PAGE}#aaaaaaaaaaaa active`);

    expect(await pane.removed(999)).toBe(false);
    windows.delete(windowId);
    expect(await pane.removed(windowId)).toBe(true);
    expect(session.items).toEqual({});
    await pane.mark('bbbbbbbbbbbb');
    expect(calls.at(-1)).toBe(`window ${MARKER_PAGE}#bbbbbbbbbbbb`);
  });
});

class FakeSocket implements PaneSocketLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function connection(initial: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ run: () => void; ms: number }> = [];
  const intervals: Array<{ run: () => void; ms: number }> = [];
  const local = memory(initial);
  const window = { mark: vi.fn(async () => {}), show: vi.fn(async () => {}), removed: vi.fn(async () => true) };
  const pane = new PaneConnection({
    socket: (url) => {
      const socket = new FakeSocket(url);

      sockets.push(socket);
      return socket;
    },
    window: window as unknown as PaneWindow,
    local,
    setTimeout: (run, ms) => timers.push({ run, ms }),
    clearTimeout: () => {},
    setInterval: (run, ms) => intervals.push({ run, ms }),
    clearInterval: () => {},
    log: () => {},
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  return { pane, sockets, timers, intervals, local, window, settle };
}

describe('PaneConnection', () => {
  it('says hello with its kept credential, pings every 20 s, and keeps a new credential from pairing', async () => {
    const { pane, sockets, intervals, local, settle } = connection({ paneCredential: 'kept' });

    pane.connect();
    pane.connect();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe(PANE_SOCKET_URL);
    sockets[0]!.open();
    await settle();
    expect(sockets[0]!.sent).toEqual([{ type: 'hello', credential: 'kept' }]);
    expect(intervals[0]!.ms).toBe(PING_MS);
    intervals[0]!.run();
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'ping' });

    sockets[0]!.receive({ type: 'paired', credential: 'fresh' });
    await settle();
    expect(pane.paired).toBe(true);
    expect(local.items['paneCredential']).toBe('fresh');
  });

  it('pairs with a token from a loopback page only, connecting first when needed', async () => {
    const { pane, sockets, settle } = connection();

    expect(pane.external({ type: 'pair', token: 't' }, 'https://evil.test')).toEqual({ error: 'Only the Switchboard page can ask this.' });
    expect(pane.external({ type: 'pair', token: 't' }, undefined)).toEqual({ error: 'Only the Switchboard page can ask this.' });
    expect(pane.external({ type: 'pair', token: 't' }, 'http://127.0.0.1.evil.test:47616')).toEqual({ error: 'Only the Switchboard page can ask this.' });
    expect(pane.external({ type: 'pair', token: 'x'.repeat(129) }, 'http://127.0.0.1:47616')).toEqual({ error: 'Unknown request.' });
    expect(pane.external({ type: 'open', url: 'https://a.test/' }, 'http://127.0.0.1:47616')).toEqual({ error: 'Unknown request.' });
    expect(sockets).toHaveLength(0);

    expect(pane.external({ type: 'pair', token: 'tok' }, 'http://127.0.0.1:47616')).toEqual({ ok: true });
    sockets[0]!.open();
    await settle();
    expect(sockets[0]!.sent).toEqual([{ type: 'pair', token: 'tok' }]);

    // On an open socket the token goes at once.
    expect(pane.external({ type: 'pair', token: 'again' }, 'http://localhost:47616')).toEqual({ ok: true });
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'pair', token: 'again' });
    expect(pane.external({ type: 'wake' }, 'http://localhost:47616')).toEqual({ ok: true });
    expect(sockets).toHaveLength(1);
  });

  it('carries out window and tabs only once paired, and answers window with its marker', async () => {
    const { pane, sockets, window, settle } = connection();

    pane.connect();
    sockets[0]!.open();
    sockets[0]!.receive({ type: 'unpaired' });
    sockets[0]!.receive({ type: 'window', marker: '0123456789ab' });
    sockets[0]!.receive({ type: 'tabs', urls: ['https://a.test/'], active: 'https://a.test/' });
    await settle();
    expect(window.mark).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();

    sockets[0]!.receive({ type: 'paired' });
    sockets[0]!.receive({ type: 'window', marker: 'NOT-A-MARKER' });
    sockets[0]!.receive({ type: 'window', marker: '0123456789ab' });
    sockets[0]!.receive({ type: 'tabs', urls: ['javascript:x'], active: 'javascript:x' });
    sockets[0]!.receive({ type: 'tabs', urls: ['https://a.test/'], active: 'https://a.test/' });
    sockets[0]!.onmessage?.({ data: 'not json' });
    await settle();
    await settle();
    expect(window.mark.mock.calls).toEqual([['0123456789ab']]);
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'window', marker: '0123456789ab' });
    expect(window.show.mock.calls).toEqual([[['https://a.test/'], 'https://a.test/']]);
  });

  it('tells the hub its window closed, and connects again after a socket closes, waiting longer each time', async () => {
    const { pane, sockets, timers, settle } = connection();

    pane.connect();
    sockets[0]!.open();
    sockets[0]!.receive({ type: 'paired' });
    await settle();
    await pane.windowRemoved(7);
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'closed' });

    sockets[0]!.close();
    expect(pane.paired).toBe(false);
    expect(timers.map((timer) => timer.ms)).toEqual([5_000]);
    timers[0]!.run();
    expect(sockets).toHaveLength(2);
    sockets[1]!.close();
    timers[1]!.run();
    sockets[2]!.close();
    timers[2]!.run();
    sockets[3]!.close();
    expect(timers.map((timer) => timer.ms)).toEqual([5_000, 30_000, 60_000, 60_000]);
  });
});
