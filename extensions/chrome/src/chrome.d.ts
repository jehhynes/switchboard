// The part of the Chrome extension API this extension uses.

/** True in the Firefox build, set by esbuild's `define`. */
declare const FIREFOX: boolean;
declare namespace chrome.runtime {
  function sendMessage(message: unknown): Promise<unknown>;
  function getURL(path: string): string;

  const onMessageExternal: {
    addListener(listener: (message: unknown, sender: import('./iframe.js').IframeSender, sendResponse: (response: unknown) => void) => boolean): void;
  };

  const onMessage: {
    addListener(listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean): void;
  };
}

declare namespace chrome.tabs {
  interface Tab {
    id?: number;
    url?: string;
    pendingUrl?: string;
  }

  function query(query: { windowId: number } | { groupId: number }): Promise<Tab[]>;
  function update(tabId: number, properties: { url: string } | { active: true }): Promise<Tab | undefined>;
  function create(properties: { windowId?: number; url: string; active: boolean }): Promise<Tab>;
  function remove(tabId: number): Promise<void>;
  function group(options: { tabIds: number; groupId?: number; createProperties?: { windowId: number } }): Promise<number>;

  const onRemoved: { addListener(listener: (tabId: number) => void): void };
  const onUpdated: { addListener(listener: (tabId: number, change: { groupId?: number; url?: string }) => void): void };
  function get(tabId: number): Promise<Tab>;
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
    tabs?: chrome.tabs.Tab[];
  }

  function create(properties: { type: 'normal'; url: string; focused: boolean }): Promise<Window>;
  function get(windowId: number): Promise<Window>;
  function getLastFocused(options: { windowTypes: ['normal'] }): Promise<Window>;
  function update(windowId: number, properties: { focused: true }): Promise<Window>;

  const onRemoved: { addListener(listener: (windowId: number) => void): void };
}

declare namespace chrome.tabGroups {
  interface TabGroup {
    id: number;
    windowId: number;
    title?: string;
  }

  function get(groupId: number): Promise<TabGroup>;
  function query(query: { title: string }): Promise<TabGroup[]>;
  function update(groupId: number, properties: { title: string; color: 'cyan' }): Promise<TabGroup | undefined>;
}
declare namespace chrome.declarativeNetRequest {
  function getSessionRules(): Promise<Array<{ id: number }>>;
  function updateSessionRules(options: { removeRuleIds: number[]; addRules: import('./iframe.js').IframeRule[] }): Promise<void>;
}
declare namespace chrome.alarms {
  function create(name: string, info: { periodInMinutes: number }): Promise<void>;
  const onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
}
