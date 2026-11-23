import { REMOTE_FILE, readPaneEnabled, readRoutes, readSnoozed } from './hub.js';
import { PaneConnection, PaneWindow, paneMarkerUrl } from './pane.js';
import type { KeyValue, PaneSocketLike } from './pane.js';
import { readCards } from './pills.js';
import { postSnooze, postUnsnooze, snoozeMessage, unsnoozeMessage } from './snooze.js';
import { GROUP_TITLE, answerLink, linkOpener, linkRequest, placedKinds } from './tabs.js';
import type { Tabs } from './tabs.js';
import { IframeRules, iframeEnabled } from './iframe.js';
import type { IframeLease } from './iframe.js';

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

// The Chrome pane and the Switchboard tab group (architecture.md § Browser extension): Chrome only, as Firefox has neither the fixed extension ID
// nor externally_connectable. The pane works only with the hub on this computer, since it keeps a window there; the tab group takes the links of
// the page this copy reaches. The listeners are added at once, as a service worker that an event wakes gets only the listeners its first run adds.
if (!FIREFOX) {
  const iframe = routes.then((hub) => new IframeRules({
    origin: hub.origin,
    now: () => Date.now(),
    tab: (id) => chrome.tabs.get(id).then((tab) => tab.url, () => undefined),
    enabled: (origin) => iframeEnabled((url) => fetch(url, { credentials: 'include', cache: 'no-store' }), origin, hub.origin),
    leases: async () => (await chrome.storage.session.get('iframeLeases'))['iframeLeases'] as Record<string, IframeLease> | undefined ?? {},
    save: (leases) => chrome.storage.session.set({ iframeLeases: leases }),
    rules: () => chrome.declarativeNetRequest.getSessionRules(),
    update: (removeRuleIds, addRules) => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules }),
  }));
  const cleanup = (run: Promise<unknown>): void => { void run.catch((error: unknown) => console.error('Switchboard could not clear iframe rules', error)); };
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (type !== 'iframe-enable' && type !== 'iframe-disable' && type !== 'iframe-launch') return false;
    void iframe.then((rules) => rules.external(message, sender)).then(async (answer) => {
      if (type === 'iframe-launch' && answer.ok === true) await chrome.tabs.create({ url: `${chrome.runtime.getURL('iframeHost.html')}?origin=${encodeURIComponent(sender.origin!)}`, active: true });
      sendResponse(answer);
    }).catch(() => sendResponse({ error: 'Could not open the iframe browser.' }));
    return true;
  });
  chrome.tabs.onRemoved.addListener((id) => cleanup(iframe.then((rules) => rules.remove(id))));
  chrome.tabs.onUpdated.addListener((id, change) => { if (change.url !== undefined) cleanup(iframe.then((rules) => rules.navigated(id))); });
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'iframe-cleanup') cleanup(iframe.then((rules) => rules.sweep())); });
  cleanup(chrome.alarms.create('iframe-cleanup', { periodInMinutes: 0.5 }));
  cleanup(iframe.then((rules) => rules.sweep()));
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

  const kinds = placedKinds(chrome.storage.session);
  const tabs: Tabs = {
    window: () => chrome.windows.getLastFocused({ windowTypes: ['normal'] }).then((window) => window.id ?? null, () => null),
    group: async (windowId) => {
      const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
      const group = groups.find((one) => one.windowId === windowId) ?? groups[0];

      if (group === undefined) {
        return null;
      }

      const inGroup = (await chrome.tabs.query({ groupId: group.id })).flatMap((tab) => (tab.id === undefined ? [] : [{ id: tab.id, url: tab.pendingUrl ?? tab.url ?? '' }]));
      const placed = await kinds.of(inGroup.map((tab) => tab.id));

      return { id: group.id, windowId: group.windowId, tabs: inGroup.map((tab) => ({ ...tab, kind: placed.get(tab.id) })) };
    },
    create: async (windowId, url) => {
      if (windowId === null) {
        const window = await chrome.windows.create({ type: 'normal', url, focused: true });

        return { tabId: window.tabs![0]!.id!, windowId: window.id! };
      }

      return { tabId: (await chrome.tabs.create({ windowId, url, active: true })).id!, windowId };
    },
    join: async (tabId, windowId, groupId) => {
      if (groupId !== null) {
        await chrome.tabs.group({ tabIds: tabId, groupId });
        return;
      }

      const created = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId } });

      await chrome.tabGroups.update(created, { title: GROUP_TITLE, color: 'cyan' });
    },
    remember: kinds.remember,
    load: async (tabId, url) => void (await chrome.tabs.update(tabId, { url })),
    show: async (tabId, windowId) => {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(windowId, { focused: true });
    },
  };
  const open = linkOpener(tabs);

  // The page wakes the service worker, which Chrome stops while no socket keeps it busy, hands it the pairing token, and has its links opened in
  // the tab group.
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (String((message as { type?: unknown } | null)?.type).startsWith('iframe-')) return false;
    const link = linkRequest(message);

    void routes.then(async (hub) => sendResponse(link !== null ? await answerLink(link, sender.origin, hub.origin, open) : hub.origin === null ? pane.external(message, sender.origin) : null));
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void kinds.forget(tabId).catch((error: unknown) => console.error('Switchboard could not forget a closed tab', error));
  });
  // A tab taken out of the group, or into another group, no longer has the kind it was opened for; dragged back in, it has its address's kind.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    const groupId = change.groupId;

    if (groupId === undefined) {
      return;
    }

    void (groupId === -1 ? Promise.resolve(true) : chrome.tabGroups.get(groupId).then((group) => group.title !== GROUP_TITLE))
      .then((left) => (left ? kinds.forget(tabId) : undefined))
      .catch((error: unknown) => console.error('Switchboard could not forget a tab that left its group', error));
  });
  chrome.windows.onRemoved.addListener((windowId) => void pane.windowRemoved(windowId).catch((error: unknown) => console.error('Switchboard could not forget its pane', error)));
  void routes.then((hub) => {
    if (hub.origin === null) {
      pane.connect();
    }
  });
}
