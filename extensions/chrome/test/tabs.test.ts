import { describe, expect, it } from 'vitest';
import { answerLink, linkOpener, linkRequest, MAX_LINK, openLink, placedKinds, tabKind } from '../src/tabs.js';
import type { Tab, Tabs } from '../src/tabs.js';

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

/** Normal windows with their tabs and Switchboard groups, which the fake calls change as Chrome would. */
function fakeChrome(windows: Record<number, { id: number; url: string; group?: number; kind?: string }[]>, focused: number | null) {
  const calls: string[] = [];
  let nextTab = 100;
  let nextGroup = 70;
  let nextWindow = 9;
  const all = () => Object.entries(windows).flatMap(([windowId, tabs]) => tabs.map((tab) => ({ ...tab, windowId: Number(windowId), tab })));
  const tab = (id: number) => all().find((each) => each.id === id)!.tab;
  const tabs: Tabs = {
    window: async () => focused,
    group: async (windowId) => {
      calls.push(`group ${windowId}`);
      const grouped = all().filter((each) => each.group !== undefined);
      const one = grouped.find((each) => each.windowId === windowId) ?? grouped[0];

      return one === undefined
        ? null
        : { id: one.group!, windowId: one.windowId, tabs: grouped.filter((each) => each.group === one.group).map((each): Tab => ({ id: each.id, url: each.url, kind: each.kind })) };
    },
    create: async (windowId, url) => {
      calls.push(`create ${windowId} ${url}`);
      const id = nextTab++;
      const target = windowId ?? nextWindow++;

      (windows[target] ??= []).push({ id, url });
      return { tabId: id, windowId: target };
    },
    join: async (tabId, windowId, groupId) => {
      calls.push(`join ${tabId} ${windowId} ${groupId}`);
      tab(tabId).group = groupId ?? nextGroup++;
    },
    remember: async (tabId, kind) => {
      calls.push(`remember ${tabId} ${kind}`);
      tab(tabId).kind = kind;
    },
    load: async (tabId, url) => {
      calls.push(`load ${tabId} ${url}`);
      tab(tabId).url = url;
    },
    show: async (tabId, windowId) => void calls.push(`show ${tabId} ${windowId}`),
  };

  return { tabs, calls, windows };
}

describe('openLink', () => {
  it("loads the link in the group's tab of the same kind and brings it to the front", async () => {
    const chrome = fakeChrome({ 5: [{ id: 1, url: 'https://github.com/o/r/pull/1' }, { id: 2, url: 'https://github.com/o/r/pull/2', group: 70 }, { id: 3, url: 'https://github.com/o/r/issues/3', group: 70 }] }, 5);

    expect(await openLink(chrome.tabs, 'https://github.com/o/r/pull/9')).toBe('loaded');
    expect(chrome.calls).toEqual(['group 5', 'load 2 https://github.com/o/r/pull/9', 'remember 2 github.com/pull', 'show 2 5']);
    expect(chrome.windows[5]!.map((tab) => tab.id)).toEqual([1, 2, 3]);
  });

  it('only brings the tab to the front when it already shows the link', async () => {
    const chrome = fakeChrome({ 5: [{ id: 2, url: 'https://github.com/o/r/pull/9', group: 70 }] }, 5);

    expect(await openLink(chrome.tabs, 'https://github.com/o/r/pull/9')).toBe('shown');
    expect(chrome.calls).toEqual(['group 5', 'remember 2 github.com/pull', 'show 2 5']);
  });

  it('reuses the tab opened for the same kind after its site redirected it to another address', async () => {
    const chrome = fakeChrome({ 5: [{ id: 2, url: 'https://desk.zoho.com/support/login.sas?serviceurl=%2Fagent%2Fo%2Ft%2F1', group: 70, kind: 'desk.zoho.com/agent' }, { id: 3, url: 'https://desk.zoho.com/agent/o/t/5', group: 70, kind: 'desk.zoho.com/support' }] }, 5);

    expect(await openLink(chrome.tabs, 'https://desk.zoho.com/agent/o/t/9')).toBe('loaded');
    expect(chrome.calls).toEqual(['group 5', 'load 2 https://desk.zoho.com/agent/o/t/9', 'remember 2 desk.zoho.com/agent', 'show 2 5']);
  });

  it('adds a new tab to the group when it has none of the kind, leaving a tab of that kind outside the group alone', async () => {
    const chrome = fakeChrome({ 5: [{ id: 1, url: 'https://github.com/o/r/pull/1' }, { id: 3, url: 'https://github.com/o/r/issues/3', group: 70 }] }, 5);

    expect(await openLink(chrome.tabs, 'https://github.com/o/r/pull/9')).toBe('opened');
    expect(chrome.calls).toEqual(['group 5', 'create 5 https://github.com/o/r/pull/9', 'join 100 5 70', 'remember 100 github.com/pull', 'show 100 5']);
  });

  it('starts a group in the focused window when no window has one', async () => {
    const chrome = fakeChrome({ 5: [{ id: 1, url: 'https://github.com/o/r/pull/1' }] }, 5);

    expect(await openLink(chrome.tabs, 'https://github.com/o/r/pull/9')).toBe('opened');
    expect(chrome.calls).toEqual(['group 5', 'create 5 https://github.com/o/r/pull/9', 'join 100 5 null', 'remember 100 github.com/pull', 'show 100 5']);
    expect(chrome.windows[5]![1]!.group).toBe(70);
  });

  it("uses another window's group when the focused window has none", async () => {
    const chrome = fakeChrome({ 5: [{ id: 1, url: 'https://x.test/' }], 6: [{ id: 2, url: 'https://github.com/o/r/pull/2', group: 70 }] }, 5);

    expect(await openLink(chrome.tabs, 'https://github.com/o/r/issues/4')).toBe('opened');
    expect(chrome.calls).toEqual(['group 5', 'create 6 https://github.com/o/r/issues/4', 'join 100 6 70', 'remember 100 github.com/issues', 'show 100 6']);
  });

  it('opens a new window with a new group when the browser has no normal window', async () => {
    const chrome = fakeChrome({}, null);

    expect(await openLink(chrome.tabs, 'https://github.com/o/r/pull/9')).toBe('opened');
    expect(chrome.calls).toEqual(['group null', 'create null https://github.com/o/r/pull/9', 'join 100 9 null', 'remember 100 github.com/pull', 'show 100 9']);
  });

  it('refuses a link that is not http(s) before touching a tab', async () => {
    const chrome = fakeChrome({ 5: [] }, 5);

    await expect(openLink(chrome.tabs, 'file:///C:/x.txt')).rejects.toThrow('Not an http or https link');
    expect(chrome.calls).toEqual([]);
  });
});

describe('linkOpener', () => {
  it('opens a second link after the first, so it reuses the tab the first made', async () => {
    const chrome = fakeChrome({ 5: [] }, 5);
    const open = linkOpener(chrome.tabs);

    expect(await Promise.all([open('https://github.com/o/r/pull/7'), open('https://github.com/o/r/pull/8')])).toEqual(['opened', 'loaded']);
    expect(chrome.windows[5]!.map((tab) => [tab.id, tab.url])).toEqual([[100, 'https://github.com/o/r/pull/8']]);
  });

  it('opens the next link after one that failed', async () => {
    const chrome = fakeChrome({ 5: [] }, 5);
    const group = chrome.tabs.group;
    let fail = true;

    chrome.tabs.group = async (windowId) => (fail ? ((fail = false), Promise.reject(new Error('No window with id: 5.'))) : group(windowId));

    const open = linkOpener(chrome.tabs);
    const failed = open('https://github.com/o/r/pull/9');
    const next = open('https://github.com/o/r/pull/9');

    await expect(failed).rejects.toThrow('No window with id: 5.');
    expect(await next).toBe('opened');
  });

  it('refuses a link whose turn comes after its deadline, leaving the tabs alone, and opens the next', async () => {
    const chrome = fakeChrome({ 5: [] }, 5);
    let clock = 1_000;
    const create = chrome.tabs.create;
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));

    // The first link's tab takes until after the second link's deadline.
    chrome.tabs.create = async (windowId, url) => {
      await held;
      clock = 3_000;
      return create(windowId, url);
    };

    const open = linkOpener(chrome.tabs, () => clock);
    const first = open('https://github.com/o/r/pull/7', 2_500);
    const late = open('https://example.com/a', 2_500);
    const after = open('https://example.com/b');

    release();
    expect(await first).toBe('opened');
    await expect(late).rejects.toThrow('The page stopped waiting for this link.');
    expect(await after).toBe('opened');
    expect(chrome.calls.filter((call) => call.startsWith('create'))).toEqual(['create 5 https://github.com/o/r/pull/7', 'create 5 https://example.com/b']);
  });
});

describe('linkRequest', () => {
  it('reads the probe and an http(s) link to open', () => {
    expect(linkRequest({ type: 'links' })).toEqual({ type: 'links' });
    expect(linkRequest({ type: 'open', url: 'https://github.com/o/r/pull/9' })).toEqual({ type: 'open', url: 'https://github.com/o/r/pull/9', until: null });
    expect(linkRequest({ type: 'open', url: 'https://github.com/o/r/pull/9', until: 11_500 })).toEqual({ type: 'open', url: 'https://github.com/o/r/pull/9', until: 11_500 });
    expect(linkRequest({ type: 'open', url: 'https://github.com/o/r/pull/9', until: Number.NaN })).toMatchObject({ until: null });
    expect(linkRequest({ type: 'open', url: 'https://github.com/o/r/pull/9', until: '11500' })).toMatchObject({ until: null });
  });

  it('gives a null URL for a link that is not http(s), too long or missing', () => {
    expect(linkRequest({ type: 'open', url: 'javascript:alert(1)' })).toMatchObject({ type: 'open', url: null });
    expect(linkRequest({ type: 'open', url: `https://x.test/${'a'.repeat(MAX_LINK)}` })).toMatchObject({ type: 'open', url: null });
    expect(linkRequest({ type: 'open' })).toMatchObject({ type: 'open', url: null });
  });

  it("returns null for the pane's messages and anything else", () => {
    expect(linkRequest({ type: 'wake' })).toBeNull();
    expect(linkRequest({ type: 'pair', token: 't' })).toBeNull();
    expect(linkRequest(null)).toBeNull();
    expect(linkRequest('open')).toBeNull();
  });
});

describe('answerLink', () => {
  const opener = () => {
    const opened: string[] = [];

    return { opened, open: async (url: string) => void opened.push(url) };
  };

  it("hears a loopback page for the hub on this computer and only the page's origin for a copy on another device", async () => {
    const local = opener();

    expect(await answerLink({ type: 'links' }, 'http://127.0.0.1:47615', null, local.open)).toEqual({ links: true });
    expect(await answerLink({ type: 'open', url: 'https://github.com/o/r/pull/9', until: null }, 'http://localhost:5173', null, local.open)).toEqual({ opened: true });
    expect(await answerLink({ type: 'links' }, 'https://pc.tail.ts.net', null, local.open)).toEqual({ error: 'Only the Switchboard page can ask this.' });
    expect(local.opened).toEqual(['https://github.com/o/r/pull/9']);
    // The page's own deadline goes to the opener unchanged, however late the message arrived.
    const deadlines: Array<number | undefined> = [];

    await answerLink({ type: 'open', url: 'https://x.test/', until: 11_500 }, 'http://127.0.0.1:47615', null, async (_url, deadline) => void deadlines.push(deadline));
    await answerLink({ type: 'open', url: 'https://x.test/', until: null }, 'http://127.0.0.1:47615', null, async (_url, deadline) => void deadlines.push(deadline));
    expect(deadlines).toEqual([11_500, undefined]);

    const remote = opener();

    expect(await answerLink({ type: 'open', url: 'https://github.com/o/r/pull/9', until: null }, 'https://pc.tail.ts.net', 'https://pc.tail.ts.net', remote.open)).toEqual({ opened: true });
    expect(await answerLink({ type: 'open', url: 'https://github.com/o/r/pull/9', until: null }, 'http://127.0.0.1:47615', 'https://pc.tail.ts.net', remote.open)).toEqual({ error: 'Only the Switchboard page can ask this.' });
    expect(await answerLink({ type: 'open', url: 'https://github.com/o/r/pull/9', until: null }, 'https://other.tail.ts.net', 'https://pc.tail.ts.net', remote.open)).toEqual({ error: 'Only the Switchboard page can ask this.' });
    expect(await answerLink({ type: 'links' }, undefined, 'https://pc.tail.ts.net', remote.open)).toEqual({ error: 'Only the Switchboard page can ask this.' });
    expect(remote.opened).toEqual(['https://github.com/o/r/pull/9']);
  });

  it('refuses a link that is not http(s) and passes on a failed open', async () => {
    expect(await answerLink({ type: 'open', url: null, until: null }, 'http://127.0.0.1:47615', null, async () => undefined)).toEqual({ error: 'The link is not an http or https URL.' });
    expect(await answerLink({ type: 'open', url: 'https://x.test/', until: null }, 'http://127.0.0.1:47615', null, async () => Promise.reject(new Error('No window with id: 5.')))).toEqual({ error: 'No window with id: 5.' });
  });
});
