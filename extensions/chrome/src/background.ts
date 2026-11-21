import { readPaneEnabled, readSnoozed } from './hub.js';
import { PaneConnection, PaneWindow, paneMarkerUrl } from './pane.js';
import type { KeyValue, PaneSocketLike } from './pane.js';
import { readCards } from './pills.js';
import { postSnooze, postUnsnooze, snoozeMessage, unsnoozeMessage } from './snooze.js';
import { GROUP_TITLE, bookmarkRemoved, dockLink, firstNavigations, placedKinds, tabPlacer } from './tabs.js';
import type { Tabs } from './tabs.js';

// Content scripts on github.com cannot read a loopback address, so the service worker reads the hub for them.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { type?: unknown } | null)?.type !== 'snoozed') {
    return false;
  }

  void readSnoozed((url) => fetch(url, { cache: 'no-store' })).then(sendResponse);

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { type?: unknown } | null)?.type !== 'cards') {
    return false;
  }

  void readCards((url) => fetch(url, { cache: 'no-store' })).then(sendResponse);

  return true;
});

// The hub accepts a snooze only from an extension Origin, which the service worker's fetch sends (mechanics M23).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const snooze = snoozeMessage(message);

  if (snooze === null) {
    return false;
  }

  void postSnooze((url, init) => fetch(url, init), snooze.url, snooze.until).then(sendResponse);

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const unsnooze = unsnoozeMessage(message);

  if (unsnooze === null) {
    return false;
  }

  void postUnsnooze((url, init) => fetch(url, init), unsnooze.url).then(sendResponse);

  return true;
});

const kinds = placedKinds(chrome.storage.session);

const tabs: Tabs = {
  group: async (windowId) => {
    const [group] = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });

    if (group === undefined) {
      return { id: null, tabs: [] };
    }

    const inGroup = (await chrome.tabs.query({ groupId: group.id })).flatMap((tab) => (tab.id === undefined ? [] : [{ ...tab, id: tab.id }]));
    const placed = await kinds.of(inGroup.map((tab) => tab.id));

    return { id: group.id, tabs: inGroup.map((tab) => ({ id: tab.id, index: tab.index, url: tab.pendingUrl ?? tab.url ?? '', kind: placed.get(tab.id) })) };
  },
  remember: kinds.remember,
  join: async (tabId, windowId, groupId) => {
    if (groupId !== null) {
      await chrome.tabs.group({ tabIds: tabId, groupId });
      return;
    }

    const created = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId } });

    await chrome.tabGroups.update(created, { title: GROUP_TITLE, color: 'cyan' });
  },
  move: async (tabId, index) => void (await chrome.tabs.move(tabId, { index })),
  // Firefox can commit the marked URL before the load restarts, so its unmarked load replaces that history entry (mechanics M52).
  load: async (tabId, url) => void (await chrome.tabs.update(tabId, FIREFOX ? { url, loadReplace: true } : { url })),
  close: (tabId) => chrome.tabs.remove(tabId),
};

const place = tabPlacer(tabs);
const navigations = firstNavigations();

// Chrome creates a tab for a link from Windows; the event wakes the service worker before the navigation's events.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) {
    navigations.created(tab.id);
  }
});

// A link the dock opened carries its bookmark or query mark (PRD R74). URL filters ignore the bookmark, so every navigation is checked.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || !navigations.first(details.tabId) || dockLink(details.url) === null) {
    return;
  }

  void chrome.tabs
    .get(details.tabId)
    .then((tab) => place(details.tabId, tab.windowId, details.url))
    .catch((error: unknown) => console.error('Switchboard could not place a tab', error));
});

// Once the page has started, changing only the bookmark does not load it again.
chrome.webNavigation.onCommitted.addListener((details) => {
  const url = bookmarkRemoved(details.frameId, details.url);

  if (url !== null) {
    void chrome.tabs.update(details.tabId, { url }).catch((error: unknown) => console.error('Switchboard could not remove its bookmark', error));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void kinds.forget(tabId).catch((error: unknown) => console.error('Switchboard could not forget a closed tab', error));
});

// A tab taken out of the group, or into another group, no longer has the kind it was placed for; dragged back in, it has its address's kind.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const groupId = change.groupId;

  if (groupId === undefined) {
    return;
  }

  void (groupId === -1 ? Promise.resolve(true) : chrome.tabGroups.get(groupId).then((group) => group.title !== GROUP_TITLE))
    .then((left) => (left ? kinds.forget(tabId) : undefined))
    .catch((error: unknown) => console.error('Switchboard could not forget a tab that left its group', error));
});

// The Chrome pane (architecture.md § Browser extension): Chrome only, as Firefox has neither the fixed extension ID nor externally_connectable.
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
    sendResponse(pane.external(message, sender.origin));
    return false;
  });
  chrome.windows.onRemoved.addListener((windowId) => void pane.windowRemoved(windowId).catch((error: unknown) => console.error('Switchboard could not forget its pane', error)));
  pane.connect();
}
