// The part of the Chrome extension API this extension uses.
declare namespace chrome.runtime {
  function sendMessage(message: unknown): Promise<unknown>;

  const onMessage: {
    addListener(listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean): void;
  };
}

declare namespace chrome.tabs {
  interface Tab {
    id?: number;
    index: number;
    windowId: number;
    url?: string;
    pendingUrl?: string;
  }

  function query(query: { groupId: number }): Promise<Tab[]>;
  function update(tabId: number, properties: { url: string }): Promise<Tab | undefined>;
  function move(tabId: number, properties: { index: number }): Promise<Tab>;
  function group(options: { tabIds: number; groupId?: number; createProperties?: { windowId: number } }): Promise<number>;
  function remove(tabId: number): Promise<void>;
  function get(tabId: number): Promise<Tab>;

  const onCreated: { addListener(listener: (tab: Tab) => void): void };
  const onRemoved: { addListener(listener: (tabId: number) => void): void };
  const onUpdated: { addListener(listener: (tabId: number, change: { groupId?: number }) => void): void };
}

declare namespace chrome.storage {
  const session: import('./tabs.js').SessionStorage;
}

declare namespace chrome.tabGroups {
  interface TabGroup {
    id: number;
    title?: string;
  }

  function get(groupId: number): Promise<TabGroup>;

  function query(query: { windowId: number; title: string }): Promise<TabGroup[]>;
  function update(groupId: number, properties: { title: string; color: 'cyan' }): Promise<TabGroup | undefined>;
}

declare namespace chrome.webNavigation {
  interface Details {
    tabId: number;
    frameId: number;
    url: string;
  }

  const onBeforeNavigate: { addListener(listener: (details: Details) => void): void };
  const onCommitted: { addListener(listener: (details: Details) => void): void };
}
