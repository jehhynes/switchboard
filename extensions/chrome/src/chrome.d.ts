// The part of the Chrome extension API this extension uses.

/** True in the Firefox build, set by esbuild's `define`. */
declare const FIREFOX: boolean;
declare namespace chrome.runtime {
  function sendMessage(message: unknown): Promise<unknown>;
  function getURL(path: string): string;

  const onMessageExternal: {
    addListener(listener: (message: unknown, sender: { origin?: string }, sendResponse: (response: unknown) => void) => boolean): void;
  };

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

  function query(query: { groupId: number } | { windowId: number }): Promise<Tab[]>;
  function update(tabId: number, properties: { url: string; loadReplace?: boolean } | { active: true }): Promise<Tab | undefined>;
  function create(properties: { windowId: number; url: string; active: boolean }): Promise<Tab>;
  function move(tabId: number, properties: { index: number }): Promise<Tab>;
  function group(options: { tabIds: number; groupId?: number; createProperties?: { windowId: number } }): Promise<number>;
  function remove(tabId: number): Promise<void>;
  function get(tabId: number): Promise<Tab>;

  const onCreated: { addListener(listener: (tab: Tab) => void): void };
  const onRemoved: { addListener(listener: (tabId: number) => void): void };
  const onUpdated: { addListener(listener: (tabId: number, change: { groupId?: number }) => void): void };
}

declare namespace chrome.storage {
  interface StorageArea {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  }

  const session: import('./tabs.js').SessionStorage & StorageArea;
  const local: StorageArea;
}

declare namespace chrome.windows {
  interface Window {
    id?: number;
  }

  function create(properties: { type: 'normal'; url: string; focused: boolean }): Promise<Window>;
  function get(windowId: number): Promise<Window>;

  const onRemoved: { addListener(listener: (windowId: number) => void): void };
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
