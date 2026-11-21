import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TABS, MAX_TRIES, PANE_SOCKET_URL, PING_MS, PaneConnection, PaneWindow, paneLinks, paneMarker, paneMarkerTitle, paneMarkerUrl, retryWait } from '../src/pane.js';
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
    markerUrl: (marker) => paneMarkerUrl(MARKER_PAGE, marker),
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

describe('paneMarkerUrl and paneMarkerTitle', () => {
  it('puts the marker in the query, so a new marker in a reused tab loads a new document that titles it again', () => {
    const first = new URL(paneMarkerUrl(MARKER_PAGE, '0123456789ab'));
    const second = new URL(paneMarkerUrl(MARKER_PAGE, 'ba9876543210'));

    expect(first.hash).toBe('');
    // A change of fragment alone is a same-document navigation that runs no script and keeps the old title.
    expect(first.origin + first.pathname + first.search).not.toBe(second.origin + second.pathname + second.search);
    expect(paneMarkerTitle(first.search)).toBe('Switchboard pane 0123456789ab');
    expect(paneMarkerTitle(second.search)).toBe('Switchboard pane ba9876543210');
  });

  it('titles the page without a marker when the query holds none or a malformed one', () => {
    expect(paneMarkerTitle('')).toBe('Switchboard pane');
    expect(paneMarkerTitle('?marker=XYZ')).toBe('Switchboard pane');
    expect(paneMarkerTitle('?marker=0123456789abc')).toBe('Switchboard pane');
  });
});

describe('the marker page', () => {
  afterEach(() => {
    history.replaceState(null, '', '/');
    vi.resetModules();
  });

  it('titles itself from the marker in its query each time it loads', async () => {
    for (const marker of ['0123456789ab', 'ba9876543210']) {
      history.replaceState(null, '', new URL(paneMarkerUrl(MARKER_PAGE, marker)).search);
      vi.resetModules();
      await import('../src/panePage.js');
      expect(document.title).toBe(`Switchboard pane ${marker}`);
    }

    // A fragment is not read: the old form titles no marker, so a tab left on it is found only after it loads a query URL.
    history.replaceState(null, '', '/#aaaaaaaaaaaa');
    vi.resetModules();
    await import('../src/panePage.js');
    expect(document.title).toBe('Switchboard pane');
  });
});

describe('PaneWindow', () => {
  it('opens one window on the marker page, then shows a tab per link with the active one in front and the marker tab closed', async () => {
    const { fake, windows, calls } = browser();
    const session = memory();
    const pane = new PaneWindow(fake, session);

    await pane.mark('0123456789ab');
    expect(calls).toEqual([`window ${MARKER_PAGE}?marker=0123456789ab`]);

    await pane.show(['https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/2'], 'https://github.com/o/r/pull/2');
    expect(calls.slice(1)).toEqual(['open https://github.com/o/r/issues/1', 'open https://github.com/o/r/pull/2', 'activate https://github.com/o/r/pull/2', `close ${MARKER_PAGE}?marker=0123456789ab`]);
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

  it('loads the query form into a marker tab left on the old fragment form, and closes such a tab when it shows the links', async () => {
    const { fake, windows, calls } = browser();
    const session = memory({ pane: { windowId: 7, links: {} } });

    windows.set(7, [{ id: 70, url: `${MARKER_PAGE}#1b17b20dd815`, active: true }]);
    const pane = new PaneWindow(fake, session);

    await pane.mark('ef4652596974');
    expect(calls).toEqual([`load 70 ${MARKER_PAGE}?marker=ef4652596974`, `activate ${MARKER_PAGE}?marker=ef4652596974`]);

    windows.get(7)!.push({ id: 71, url: `${MARKER_PAGE}#1b17b20dd815`, active: false });
    await pane.show(['https://a.test/1'], 'https://a.test/1');
    expect(calls).toContain(`close ${MARKER_PAGE}#1b17b20dd815`);
    expect(calls).toContain(`close ${MARKER_PAGE}?marker=ef4652596974`);
  });

  it('marks an open window again in its marker tab, or a new one, and opens a new window once the old one closed', async () => {
    const { fake, windows, calls } = browser();
    const session = memory();
    const pane = new PaneWindow(fake, session);

    await pane.mark('0123456789ab');
    const windowId = [...windows.keys()][0]!;
    const markerTab = windows.get(windowId)![0]!.id;

    await pane.mark('ba9876543210');
    expect(calls[1]).toBe(`load ${markerTab} ${MARKER_PAGE}?marker=ba9876543210`);
    expect(calls[2]).toBe(`activate ${MARKER_PAGE}?marker=ba9876543210`);

    await pane.show(['https://a.test/1'], 'https://a.test/1');
    await pane.mark('aaaaaaaaaaaa');
    expect(calls.at(-1)).toBe(`open ${MARKER_PAGE}?marker=aaaaaaaaaaaa active`);

    expect(await pane.removed(999)).toBe(false);
    windows.delete(windowId);
    expect(await pane.removed(windowId)).toBe(true);
    expect(session.items).toEqual({});
    await pane.mark('bbbbbbbbbbbb');
    expect(calls.at(-1)).toBe(`window ${MARKER_PAGE}?marker=bbbbbbbbbbbb`);
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

function connection(initial: Record<string, unknown> = {}, options: { enabled?: boolean | null } = {}) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
  const intervals: Array<{ run: () => void; ms: number }> = [];
  const local = memory(initial);
  const session = memory();
  const window = { mark: vi.fn(async () => {}), show: vi.fn(async () => {}), removed: vi.fn(async () => true) };
  const state = { enabled: options.enabled === undefined ? true : options.enabled, now: 1_000 };
  const enabled = vi.fn(async () => state.enabled);
  const pane = new PaneConnection({
    socket: (url) => {
      const socket = new FakeSocket(url);

      sockets.push(socket);
      return socket;
    },
    enabled,
    window: window as unknown as PaneWindow,
    local,
    session,
    now: () => state.now,
    setTimeout: (run, ms) => timers.push({ run, ms, cleared: false }) - 1,
    clearTimeout: (timer) => void (timers[timer as number]!.cleared = true),
    setInterval: (run, ms) => intervals.push({ run, ms }),
    clearInterval: () => {},
    log: () => {},
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  /** The waits of the timers still pending. */
  const pending = () => timers.filter((timer) => !timer.cleared).map((timer) => timer.ms);
  /** Runs the last pending timer. */
  const fire = async () => {
    const timer = timers.filter((each) => !each.cleared).at(-1)!;

    timer.cleared = true;
    state.now += timer.ms;
    timer.run();
    await settle();
  };

  return { pane, sockets, timers, intervals, local, session, window, settle, state, enabled, pending, fire };
}

describe('PaneConnection', () => {
  it('says hello with its kept credential, pings every 20 s, and keeps a new credential from pairing', async () => {
    const { pane, sockets, intervals, local, settle } = connection({ paneCredential: 'kept' });

    pane.connect();
    pane.connect();
    await settle();
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

  it('asks the hub nothing and opens no socket before it was ever paired', async () => {
    const { pane, sockets, enabled, pending, settle } = connection();

    pane.connect();
    expect(pane.external({ type: 'wake' }, 'http://127.0.0.1:47616')).toEqual({ ok: true });
    await settle();
    expect(enabled).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    expect(pending()).toEqual([]);
  });

  it('opens no socket and sets no timer while the hub has the pane off, and asks again on each wake', async () => {
    const { pane, sockets, enabled, pending, settle, state } = connection({ paneCredential: 'kept' }, { enabled: false });

    pane.connect();
    await settle();
    pane.external({ type: 'wake' }, 'http://localhost:47616');
    await settle();
    expect(enabled).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(0);
    expect(pending()).toEqual([]);

    state.enabled = true;
    pane.external({ type: 'wake' }, 'http://localhost:47616');
    await settle();
    expect(sockets).toHaveLength(1);
  });

  it('asks again later, twice as long each time, while the hub does not answer, and then stops', async () => {
    const { pane, sockets, enabled, pending, fire, settle } = connection({ paneCredential: 'kept' }, { enabled: null });

    pane.connect();
    await settle();

    const waits: number[] = [];

    while (pending().length > 0) {
      waits.push(pending()[0]!);
      await fire();
    }

    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000]);
    expect(enabled).toHaveBeenCalledTimes(7);
    expect(sockets).toHaveLength(0);
    expect(retryWait(6)).toBe(300_000);
    expect(retryWait(20)).toBe(300_000);
  });

  it('backs off after a refused socket, keeping the wait through wakes and restarts, and stops after the last try until the page pairs', async () => {
    const first = connection({ paneCredential: 'kept' });
    const { pane, sockets, enabled, pending, fire, settle, session, state } = first;

    pane.connect();
    await settle();
    // Refused with 403: the socket closes without a message from the hub.
    sockets[0]!.close();
    await settle();
    expect(session.items['paneRefused']).toEqual({ count: 1, until: state.now + 5_000 });
    expect(pending()).toEqual([5_000]);

    // A wake inside the wait opens nothing and asks nothing.
    pane.external({ type: 'wake' }, 'http://localhost:47616');
    await settle();
    expect(sockets).toHaveLength(1);
    expect(enabled).toHaveBeenCalledTimes(1);

    for (let n = 1; n < MAX_TRIES; n++) {
      await fire();
      expect(sockets).toHaveLength(n + 1);
      sockets[n]!.close();
      await settle();
    }

    expect(session.items['paneRefused']).toEqual({ count: MAX_TRIES, until: null });
    expect(pending()).toEqual([]);
    pane.connect();
    await settle();
    expect(sockets).toHaveLength(MAX_TRIES);
    expect(enabled).toHaveBeenCalledTimes(MAX_TRIES);

    // A pairing token from the page tries again, and pairing clears the refusals.
    pane.external({ type: 'pair', token: 'tok' }, 'http://127.0.0.1:47616');
    await settle();
    expect(sockets).toHaveLength(MAX_TRIES + 1);
    sockets.at(-1)!.open();
    await settle();
    expect(sockets.at(-1)!.sent).toEqual([{ type: 'pair', token: 'tok' }]);
    sockets.at(-1)!.receive({ type: 'paired', credential: 'fresh' });
    await settle();
    expect(session.items['paneRefused']).toBeUndefined();
  });

  it('waits out a refusal kept from before the service worker restarted', async () => {
    const { pane, sockets, enabled, session, pending, fire, settle, state } = connection({ paneCredential: 'kept' });

    session.items['paneRefused'] = { count: 2, until: state.now + 7_000 };
    pane.connect();
    await settle();
    expect(enabled).not.toHaveBeenCalled();
    expect(pending()).toEqual([7_000]);
    await fire();
    expect(sockets).toHaveLength(1);
  });

  it('closes and stops when the hub does not know its credential, until the page pairs again', async () => {
    const { pane, sockets, session, pending, settle } = connection({ paneCredential: 'stale' });

    pane.connect();
    await settle();
    sockets[0]!.open();
    await settle();
    sockets[0]!.receive({ type: 'unpaired' });
    await settle();
    expect(sockets[0]!.readyState).toBe(3);
    expect(session.items['paneRefused']).toEqual({ count: 1, until: null });
    expect(pending()).toEqual([]);

    pane.external({ type: 'wake' }, 'http://localhost:47616');
    await settle();
    expect(sockets).toHaveLength(1);

    pane.external({ type: 'pair', token: 'tok' }, 'http://localhost:47616');
    await settle();
    expect(sockets).toHaveLength(2);
  });

  it('pairs with a token from a loopback page only, connecting first when needed', async () => {
    const { pane, sockets, settle } = connection();

    expect(pane.external({ type: 'pair', token: 't' }, 'https://evil.test')).toEqual({ error: 'Only the Switchboard page can ask this.' });
    expect(pane.external({ type: 'pair', token: 't' }, undefined)).toEqual({ error: 'Only the Switchboard page can ask this.' });
    expect(pane.external({ type: 'pair', token: 't' }, 'http://127.0.0.1.evil.test:47616')).toEqual({ error: 'Only the Switchboard page can ask this.' });
    expect(pane.external({ type: 'pair', token: 'x'.repeat(129) }, 'http://127.0.0.1:47616')).toEqual({ error: 'Unknown request.' });
    expect(pane.external({ type: 'open', url: 'https://a.test/' }, 'http://127.0.0.1:47616')).toEqual({ error: 'Unknown request.' });
    await settle();
    expect(sockets).toHaveLength(0);

    expect(pane.external({ type: 'pair', token: 'tok' }, 'http://127.0.0.1:47616')).toEqual({ ok: true });
    await settle();
    sockets[0]!.open();
    await settle();
    expect(sockets[0]!.sent).toEqual([{ type: 'pair', token: 'tok' }]);

    // On an open socket the token goes at once.
    expect(pane.external({ type: 'pair', token: 'again' }, 'http://localhost:47616')).toEqual({ ok: true });
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'pair', token: 'again' });
    expect(pane.external({ type: 'wake' }, 'http://localhost:47616')).toEqual({ ok: true });
    await settle();
    expect(sockets).toHaveLength(1);
  });

  it('waits for the answer to a token sent after hello, and closes and backs off when the hub refuses the token', async () => {
    const { pane, sockets, session, pending, settle, state } = connection({ paneCredential: 'stale' });

    pane.connect();
    await settle();
    sockets[0]!.open();
    await settle();
    pane.external({ type: 'pair', token: 'tok' }, 'http://localhost:47616');
    // The answer to hello arrives after the token went.
    sockets[0]!.receive({ type: 'unpaired' });
    await settle();
    expect(sockets[0]!.readyState).toBe(1);

    sockets[0]!.receive({ type: 'unpaired', error: 'The pairing token is unknown, used or expired. Pair again from the page.' });
    await settle();
    expect(sockets[0]!.readyState).toBe(3);
    expect(session.items['paneRefused']).toEqual({ count: 1, until: state.now + 5_000 });
    expect(pending()).toEqual([5_000]);
  });

  it('carries out window and tabs only once paired, and answers window with its marker', async () => {
    const { pane, sockets, window, settle } = connection({ paneCredential: 'kept' });

    pane.connect();
    await settle();
    sockets[0]!.open();
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
    expect(window.mark.mock.calls).toEqual([['0123456789ab']]);
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'window', marker: '0123456789ab' });
    expect(window.show.mock.calls).toEqual([[['https://a.test/'], 'https://a.test/']]);
  });

  it('tells the hub its window closed, and after a paired socket drops asks the hub again, opening nothing once the pane is off', async () => {
    const { pane, sockets, pending, fire, settle, state, session } = connection({ paneCredential: 'kept' });

    pane.connect();
    await settle();
    sockets[0]!.open();
    sockets[0]!.receive({ type: 'paired' });
    await settle();
    await pane.windowRemoved(7);
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'closed' });

    sockets[0]!.close();
    await settle();
    expect(pane.paired).toBe(false);
    expect(pending()).toEqual([5_000]);
    expect(session.items['paneRefused']).toBeUndefined();
    await fire();
    expect(sockets).toHaveLength(2);

    sockets[1]!.open();
    sockets[1]!.receive({ type: 'paired' });
    await settle();
    sockets[1]!.close();
    await settle();
    state.enabled = false;
    await fire();
    expect(sockets).toHaveLength(2);
    expect(pending()).toEqual([]);
  });
  it('connects for a pairing token that arrives while the hub is being asked', async () => {
    const { pane, sockets, enabled, settle } = connection({ paneCredential: 'stale' }, { enabled: false });
    let answer: (value: boolean) => void = () => {};

    enabled.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));
    pane.connect();
    await settle();
    pane.external({ type: 'pair', token: 'tok' }, 'http://127.0.0.1:47616');
    answer(false);
    await settle();
    expect(sockets).toHaveLength(0);
    expect(enabled).toHaveBeenCalledTimes(2);

    enabled.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));
    pane.connect();
    await settle();
    pane.external({ type: 'pair', token: 'tok' }, 'http://127.0.0.1:47616');
    answer(true);
    await settle();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    await settle();
    expect(sockets[0]!.sent).toEqual([{ type: 'pair', token: 'tok' }]);
  });

  it('sends nothing when the socket closed while its credential was read', async () => {
    const { pane, sockets, local, intervals, settle } = connection({ paneCredential: 'kept' });

    pane.connect();
    await settle();

    const read = local.get;
    let release: () => void = () => {};

    local.get = (key) => new Promise((resolve) => (release = () => void read(key).then(resolve)));
    sockets[0]!.open();
    sockets[0]!.close();
    release();
    await settle();
    expect(sockets[0]!.sent).toEqual([]);
    expect(intervals).toHaveLength(0);
  });
});
