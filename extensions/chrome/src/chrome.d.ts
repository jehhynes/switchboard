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
    url?: string;
    pendingUrl?: string;
  }

  function query(query: { windowId: number }): Promise<Tab[]>;
  function update(tabId: number, properties: { url: string } | { active: true }): Promise<Tab | undefined>;
  function create(properties: { windowId: number; url: string; active: boolean }): Promise<Tab>;
  function remove(tabId: number): Promise<void>;
}

declare namespace chrome.storage {
  interface StorageArea {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  }

  const session: StorageArea;
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
