import { REMOTE_FILE, readPaneEnabled, readRoutes, readSnoozed } from './hub.js';
import { PaneConnection, PaneWindow, paneMarkerUrl } from './pane.js';
import type { KeyValue, PaneSocketLike } from './pane.js';
import { readCards } from './pills.js';
import { postSnooze, postUnsnooze, snoozeMessage, unsnoozeMessage } from './snooze.js';

// The hub on this computer, or the one whose web page gave this copy (architecture.md § Browser extension).
const routes = readRoutes((url) => fetch(url), chrome.runtime.getURL(REMOTE_FILE));

// Content scripts on github.com cannot read a loopback address, so the service worker reads the hub for them.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { type?: unknown } | null)?.type !== 'hub') {
    return false;
  }

  void routes.then((hub) => sendResponse({ origin: hub.origin }));

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { type?: unknown } | null)?.type !== 'snoozed') {
    return false;
  }

  void routes.then((hub) => readSnoozed((url) => fetch(url, { cache: 'no-store' }), hub)).then(sendResponse);

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { type?: unknown } | null)?.type !== 'cards') {
    return false;
  }

  void routes.then((hub) => readCards((url) => fetch(url, { cache: 'no-store' }), hub)).then(sendResponse);

  return true;
});

// The hub accepts a snooze only from an extension Origin, which the service worker's fetch sends (mechanics M23).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const snooze = snoozeMessage(message);

  if (snooze === null) {
    return false;
  }

  void routes.then((hub) => postSnooze((url, init) => fetch(url, init), snooze.url, snooze.until, hub)).then(sendResponse);

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const unsnooze = unsnoozeMessage(message);

  if (unsnooze === null) {
    return false;
  }

  void routes.then((hub) => postUnsnooze((url, init) => fetch(url, init), unsnooze.url, hub)).then(sendResponse);

  return true;
});

// The Chrome pane (architecture.md § Browser extension): Chrome only, as Firefox has neither the fixed extension ID nor externally_connectable, and
// only with the hub on this computer, since the pane keeps a window there. Its listeners are added at once, as a service worker that an event
// wakes gets only the listeners its first run adds.
if (!FIREFOX) {
  const store = (area: chrome.storage.StorageArea): KeyValue => ({ get: (key) => area.get(key), set: (items) => area.set(items), remove: (key) => area.remove(key) });
  const markerPage = chrome.runtime.getURL('pane.html');
  const pane = new PaneConnection({
    socket: (url) => new WebSocket(url) as unknown as PaneSocketLike,
    enabled: () => readPaneEnabled((url) => fetch(url, { cache: 'no-store' })),
    window: new PaneWindow(
      {
        markerUrl: (marker) => paneMarkerUrl(markerPage, marker),
        isMarker: (url) => url.startsWith(markerPage),
        // Chrome takes the foreground for a new window even with focused false (mechanics M103); the dock places it.
        createWindow: async (url) => (await chrome.windows.create({ type: 'normal', url, focused: false })).id!,
        windowExists: (windowId) => chrome.windows.get(windowId).then(() => true, () => false),
        tabs: async (windowId) => (await chrome.tabs.query({ windowId })).flatMap((tab) => (tab.id === undefined ? [] : [{ id: tab.id, url: tab.pendingUrl ?? tab.url ?? '' }])),
        openTab: async (windowId, url, active) => (await chrome.tabs.create({ windowId, url, active })).id!,
        loadTab: async (tabId, url) => void (await chrome.tabs.update(tabId, { url })),
        activateTab: async (tabId) => void (await chrome.tabs.update(tabId, { active: true })),
        closeTab: (tabId) => chrome.tabs.remove(tabId),
      },
      store(chrome.storage.session),
    ),
    local: store(chrome.storage.local),
    session: store(chrome.storage.session),
    now: () => Date.now(),
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    setInterval: (run, ms) => setInterval(run, ms),
    clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
    log: (message, error) => console.error(message, error),
  });

  // The page wakes the service worker, which Chrome stops while no socket keeps it busy, and hands it the pairing token.
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    void routes.then((hub) => sendResponse(hub.origin === null ? pane.external(message, sender.origin) : null));
    return true;
  });
  chrome.windows.onRemoved.addListener((windowId) => void pane.windowRemoved(windowId).catch((error: unknown) => console.error('Switchboard could not forget its pane', error)));
  void routes.then((hub) => {
    if (hub.origin === null) {
      pane.connect();
    }
  });
}
