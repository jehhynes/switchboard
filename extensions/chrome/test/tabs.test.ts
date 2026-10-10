import { describe, expect, it } from 'vitest';
import { bookmarkRemoved, dockLink, firstNavigations, placedKinds, placeTab, tabKind, tabPlacer } from '../src/tabs.js';
import type { Tab, Tabs } from '../src/tabs.js';

describe('dockLink', () => {
  it("removes the dock's bookmark from a link that had none", () => {
    expect(dockLink('https://github.com/o/r/pull/7#switchboard-tab')).toEqual({ link: 'https://github.com/o/r/pull/7', bookmark: true });
    expect(dockLink('https://x.test/p?a=1#switchboard-tab')).toEqual({ link: 'https://x.test/p?a=1', bookmark: true });
  });

  it("removes the dock's query mark and keeps the query and bookmark the link already has", () => {
    expect(dockLink('https://github.com/o/r/issues/7?switchboard-tab=1#issuecomment-1')).toEqual({ link: 'https://github.com/o/r/issues/7#issuecomment-1', bookmark: false });
    expect(dockLink('https://desk.zoho.com/support/x/ShowHomePage.do?a=%20b+c&switchboard-tab=1#Cases/dv/1')?.link).toBe('https://desk.zoho.com/support/x/ShowHomePage.do?a=%20b+c#Cases/dv/1');
    expect(dockLink('https://x.test/p?switchboard-tab=1&a=1')?.link).toBe('https://x.test/p?a=1');
    expect(dockLink('https://x.test/p?a=1&switchboard-tab=1&b=2')?.link).toBe('https://x.test/p?a=1&b=2');
    expect(dockLink('https://x.test/p?switchboard-tab=1')?.link).toBe('https://x.test/p');
  });

  it('returns null for a link the dock did not open', () => {
    expect(dockLink('https://github.com/o/r/pull/7')).toBeNull();
    expect(dockLink('https://github.com/o/r/pull/7#')).toBeNull();
    expect(dockLink('https://github.com/o/r/pull/7#switchboard-tabs')).toBeNull();
    expect(dockLink('https://x.test/p#a#switchboard-tab')).toBeNull();
    expect(dockLink('https://x.test/p?my-switchboard-tab=1')).toBeNull();
    expect(dockLink('https://x.test/p?switchboard-tab=10')).toBeNull();
    expect(dockLink('https://x.test/p#?switchboard-tab=1')).toBeNull();
    expect(dockLink('https://x.test/p?next=https://other.test/?switchboard-tab=1')).toBeNull();
  });

  it('removes only the mark the dock added after a URL in another parameter', () => {
    expect(dockLink('https://x.test/p?next=https://other.test/?switchboard-tab=1&switchboard-tab=1')?.link).toBe('https://x.test/p?next=https://other.test/?switchboard-tab=1');
  });
});

describe('bookmarkRemoved', () => {
  it('gives the link with a bare bookmark for a top-frame page with the bookmark mark', () => {
    expect(bookmarkRemoved(0, 'https://github.com/o/r/pull/7#switchboard-tab')).toBe('https://github.com/o/r/pull/7#');
  });

  it('returns null for a frame, a query mark and an unmarked page', () => {
    expect(bookmarkRemoved(3, 'https://github.com/o/r/pull/7#switchboard-tab')).toBeNull();
    expect(bookmarkRemoved(0, 'https://github.com/o/r/pull/7?switchboard-tab=1#a')).toBeNull();
    expect(bookmarkRemoved(0, 'https://github.com/o/r/pull/7#')).toBeNull();
  });
});

describe('firstNavigations', () => {
  it("counts only a created tab's first navigation", () => {
    const navigations = firstNavigations();

    navigations.created(4);

    expect(navigations.first(4)).toBe(true);
    expect(navigations.first(4)).toBe(false);
    expect(navigations.first(5)).toBe(false);
  });
});

describe('placedKinds', () => {
  function memory() {
    const items = new Map<string, unknown>();

    return {
      items,
      get: async (keys: string[]) => Object.fromEntries(keys.flatMap((key) => (items.has(key) ? [[key, items.get(key)]] : []))),
      set: async (values: Record<string, unknown>) => void Object.entries(values).forEach(([key, value]) => items.set(key, value)),
      remove: async (key: string) => void items.delete(key),
    };
  }

  it('remembers and forgets each tab under its own key', async () => {
    const storage = memory();
    const kinds = placedKinds(storage);

    await kinds.remember(4, 'desk.zoho.com/agent');
    await kinds.remember(5, 'github.com/pull');
    await kinds.forget(4);

    expect(await kinds.of([4, 5, 6])).toEqual(new Map([[5, 'github.com/pull']]));
    expect([...storage.items.keys()]).toEqual(['placedKind:5']);
  });

  it("keeps a tab's kind when another tab is forgotten during the write", async () => {
    const storage = memory();
    const kinds = placedKinds(storage);

    await kinds.remember(2, 'desk.zoho.com/agent');
    await Promise.all([kinds.forget(2), kinds.remember(4, 'desk.zoho.com/agent')]);

    expect(await kinds.of([2, 4])).toEqual(new Map([[4, 'desk.zoho.com/agent']]));
  });

  it('reads nothing for no tabs and ignores a value that is not a kind', async () => {
    const storage = memory();
    const get = storage.get;
    let reads = 0;

    storage.get = async (keys) => (reads++, get(keys));
    storage.items.set('placedKind:3', 7);

    expect(await placedKinds(storage).of([])).toEqual(new Map());
    expect(reads).toBe(0);
    expect(await placedKinds(storage).of([3])).toEqual(new Map());
  });
});

describe('tabKind', () => {
  it('puts GitHub issues and pull requests of any repository in their own kinds', () => {
    expect(tabKind('https://github.com/o/r/issues/1')).toBe('github.com/issues');
    expect(tabKind('https://GitHub.com/other/repo/issues/2#issuecomment-3')).toBe('github.com/issues');
    expect(tabKind('https://github.com/o/r/pull/7')).toBe('github.com/pull');
    expect(tabKind('https://github.com/o/r/pull/7/files')).toBe('github.com/pull');
  });

  it('gives other GitHub pages and other sites their host and first path segment', () => {
    expect(tabKind('https://github.com/o/r/issues')).toBe('github.com/o');
    expect(tabKind('https://github.com/o/r/pulls')).toBe('github.com/o');
    expect(tabKind('https://desk.zoho.com/support/acme/ShowHomePage.do#Cases/dv/1')).toBe('desk.zoho.com/support');
    expect(tabKind('https://forum.example.com/t/forum/topic')).toBe('forum.example.com/t');
    expect(tabKind('https://www.example.com/')).toBe('www.example.com/');
  });

  it('returns null for a URL that is not http(s)', () => {
    expect(tabKind('chrome://newtab/')).toBeNull();
    expect(tabKind('not a url')).toBeNull();
    expect(tabKind('')).toBeNull();
  });
});

/** A window's tabs in order and its Switchboard group, which the fake calls change as Chrome would. */
function fakeChrome(open: { id: number; url: string; grouped?: boolean; kind?: string }[]) {
  const calls: string[] = [];
  let groupId: number | null = open.some((tab) => tab.grouped) ? 70 : null;
  const tab = (id: number) => open.find((each) => each.id === id)!;
  const tabs: Tabs = {
    group: async (windowId) => {
      calls.push(`group ${windowId}`);
      return { id: groupId, tabs: open.flatMap((each, index): Tab[] => (each.grouped === true ? [{ id: each.id, index, url: each.url, kind: each.kind }] : [])) };
    },
    join: async (tabId, windowId, id) => {
      calls.push(`join ${tabId} ${windowId} ${id}`);
      groupId ??= 71;
      tab(tabId).grouped = true;
    },
    remember: async (tabId, kind) => {
      calls.push(`remember ${tabId} ${kind}`);
      tab(tabId).kind = kind;
    },
    move: async (tabId, index) => {
      calls.push(`move ${tabId} ${index}`);
      open.splice(index, 0, open.splice(open.indexOf(tab(tabId)), 1)[0]!);
    },
    load: async (tabId, url) => {
      calls.push(`load ${tabId} ${url}`);
      tab(tabId).url = url;
    },
    close: async (tabId) => {
      calls.push(`close ${tabId}`);
      open.splice(open.indexOf(tab(tabId)), 1);
    },
  };

  return { tabs, calls, open, group: () => groupId };
}

describe('placeTab', () => {
  it("puts the new tab in place of the group's tab of the same kind and closes that tab", async () => {
    const chrome = fakeChrome([
      { id: 1, url: 'https://github.com/o/r/pull/1' },
      { id: 2, url: 'https://github.com/o/r/pull/2#', grouped: true },
      { id: 3, url: 'https://github.com/o/r/issues/3#', grouped: true },
      { id: 4, url: 'https://github.com/o/r/pull/9#switchboard-tab' },
    ]);

    expect(await placeTab(chrome.tabs, 4, 5, 'https://github.com/o/r/pull/9#switchboard-tab')).toBe(2);
    expect(chrome.calls).toEqual(['group 5', 'join 4 5 70', 'remember 4 github.com/pull', 'group 5', 'move 4 1', 'close 2']);
    expect(chrome.open.map((tab) => tab.id)).toEqual([1, 4, 3]);
  });

  it("takes the old tab's place when joining moves the new tab from before the group to its end", async () => {
    const chrome = fakeChrome([
      { id: 4, url: 'https://github.com/o/r/pull/9#switchboard-tab' },
      { id: 2, url: 'https://github.com/o/r/pull/2#', grouped: true },
      { id: 3, url: 'https://github.com/o/r/issues/3#', grouped: true },
    ]);
    const join = chrome.tabs.join;

    chrome.tabs.join = async (tabId, windowId, id) => {
      await join(tabId, windowId, id);
      chrome.open.push(chrome.open.splice(0, 1)[0]!);
    };

    expect(await placeTab(chrome.tabs, 4, 5, 'https://github.com/o/r/pull/9#switchboard-tab')).toBe(2);
    expect(chrome.calls).toEqual(['group 5', 'join 4 5 70', 'remember 4 github.com/pull', 'group 5', 'move 4 0', 'close 2']);
    expect(chrome.open.map((tab) => tab.id)).toEqual([4, 3]);
  });

  it('leaves the tabs alone when the old tab left the group before the move', async () => {
    const chrome = fakeChrome([
      { id: 2, url: 'https://github.com/o/r/pull/2#', grouped: true },
      { id: 4, url: 'https://github.com/o/r/pull/9#switchboard-tab' },
    ]);
    const join = chrome.tabs.join;

    chrome.tabs.join = async (tabId, windowId, id) => {
      await join(tabId, windowId, id);
      chrome.open[0]!.grouped = false;
    };

    expect(await placeTab(chrome.tabs, 4, 5, 'https://github.com/o/r/pull/9#switchboard-tab')).toBeNull();
    expect(chrome.calls).toEqual(['group 5', 'join 4 5 70', 'remember 4 github.com/pull', 'group 5']);
    expect(chrome.open.map((tab) => tab.id)).toEqual([2, 4]);
  });

  it('replaces the tab placed for the same kind after its site redirected it to another address', async () => {
    const chrome = fakeChrome([
      { id: 2, url: 'https://desk.zoho.com/support/login.sas?serviceurl=%2Fagent%2Fo%2Ft%2F1#', grouped: true, kind: 'desk.zoho.com/agent' },
      { id: 3, url: 'https://desk.zoho.com/agent/o/t/5#', grouped: true, kind: 'desk.zoho.com/support' },
      { id: 4, url: 'https://desk.zoho.com/agent/o/t/9#switchboard-tab' },
    ]);

    expect(await placeTab(chrome.tabs, 4, 5, 'https://desk.zoho.com/agent/o/t/9#switchboard-tab')).toBe(2);
    expect(chrome.calls).toEqual(['group 5', 'join 4 5 70', 'remember 4 desk.zoho.com/agent', 'group 5', 'move 4 0', 'close 2']);
  });

  it('leaves a tab of the same kind outside the group open and adds the new tab to the group', async () => {
    const chrome = fakeChrome([
      { id: 1, url: 'https://github.com/o/r/pull/1' },
      { id: 3, url: 'https://github.com/o/r/issues/3#', grouped: true },
      { id: 4, url: 'https://github.com/o/r/pull/9#switchboard-tab' },
    ]);

    expect(await placeTab(chrome.tabs, 4, 5, 'https://github.com/o/r/pull/9#switchboard-tab')).toBeNull();
    expect(chrome.calls).toEqual(['group 5', 'join 4 5 70', 'remember 4 github.com/pull']);
    expect(chrome.open.map((tab) => tab.id)).toEqual([1, 3, 4]);
  });

  it('starts a group in a window that has none', async () => {
    const chrome = fakeChrome([
      { id: 1, url: 'https://github.com/o/r/pull/1' },
      { id: 4, url: 'https://github.com/o/r/pull/9#switchboard-tab' },
    ]);

    expect(await placeTab(chrome.tabs, 4, 5, 'https://github.com/o/r/pull/9#switchboard-tab')).toBeNull();
    expect(chrome.calls).toEqual(['group 5', 'join 4 5 null', 'remember 4 github.com/pull']);
    expect(chrome.group()).toBe(71);
  });

  it('removes a query mark from the new tab and replaces a grouped tab that still has one', async () => {
    const chrome = fakeChrome([
      { id: 3, url: 'https://github.com/o/r/issues/3?switchboard-tab=1#issuecomment-1', grouped: true },
      { id: 4, url: 'https://github.com/o/r/issues/9?switchboard-tab=1#issuecomment-2' },
    ]);

    expect(await placeTab(chrome.tabs, 4, 5, 'https://github.com/o/r/issues/9?switchboard-tab=1#issuecomment-2')).toBe(3);
    expect(chrome.calls).toEqual(['load 4 https://github.com/o/r/issues/9#issuecomment-2', 'group 5', 'join 4 5 70', 'remember 4 github.com/issues', 'group 5', 'move 4 0', 'close 3']);
  });

  it('leaves a link the dock did not mark alone', async () => {
    const chrome = fakeChrome([{ id: 2, url: 'https://github.com/o/r/pull/8', grouped: true }]);

    expect(await placeTab(chrome.tabs, 4, 5, 'https://github.com/o/r/pull/9')).toBeNull();
    expect(chrome.calls).toEqual([]);
  });

  it('adds a link that is not http(s) to the group without replacing a tab', async () => {
    const chrome = fakeChrome([
      { id: 2, url: 'file:///C:/y.txt', grouped: true },
      { id: 4, url: 'file:///C:/x.txt#switchboard-tab' },
    ]);

    expect(await placeTab(chrome.tabs, 4, 5, 'file:///C:/x.txt#switchboard-tab')).toBeNull();
    expect(chrome.calls).toEqual(['group 5', 'join 4 5 70']);
  });
});

describe('tabPlacer', () => {
  it('handles a second link after the first, so it replaces the tab the first kept', async () => {
    const chrome = fakeChrome([
      { id: 3, url: 'https://github.com/o/r/pull/7#switchboard-tab' },
      { id: 4, url: 'https://github.com/o/r/pull/8#switchboard-tab' },
    ]);
    const place = tabPlacer(chrome.tabs);

    expect(await Promise.all([place(3, 5, chrome.open[0]!.url), place(4, 5, chrome.open[1]!.url)])).toEqual([null, 3]);
    expect(chrome.calls).toEqual(['group 5', 'join 3 5 null', 'remember 3 github.com/pull', 'group 5', 'join 4 5 71', 'remember 4 github.com/pull', 'group 5', 'move 4 0', 'close 3']);
    expect(chrome.open.map((tab) => tab.id)).toEqual([4]);
  });

  it('runs the next link after one that failed', async () => {
    const chrome = fakeChrome([{ id: 6, url: 'file:///C:/x.txt#switchboard-tab' }]);
    const group = chrome.tabs.group;

    chrome.tabs.group = async (windowId) => (windowId === 5 ? Promise.reject(new Error('No window with id: 5.')) : group(windowId));

    const place = tabPlacer(chrome.tabs);
    const failed = place(4, 5, 'https://github.com/o/r/pull/9#switchboard-tab');
    const next = place(6, 7, 'file:///C:/x.txt#switchboard-tab');

    await expect(failed).rejects.toThrow('No window with id: 5.');
    expect(await next).toBeNull();
    expect(chrome.calls).toEqual(['group 7', 'join 6 7 null']);
  });
});
