import { PANE_EXTENSION_ID } from '@switchboard/core';
import { describe, expect, it } from 'vitest';
import { PANE_MIN_WIDTH, PaneState, paneRect, paneTabs } from '../src/pane.js';
import type { PanePageView } from '../src/pane.js';
import type { PaneLinkState } from '../src/paneLink.js';

const RECT = { left: 1300, top: 40, width: 600, height: 900, dpr: 1.25, innerWidth: 1900, innerHeight: 1000 };
const ISSUE = 'https://github.com/o/r/issues/1';
const PR = 'https://github.com/o/r/pull/2';

describe('paneRect', () => {
  it('takes a finite column at least the pane’s minimum wide', () => {
    expect(paneRect(RECT)).toEqual(RECT);
    expect(paneRect({ ...RECT, width: PANE_MIN_WIDTH - 1 })).toBeNull();
    expect(paneRect({ ...RECT, dpr: 0 })).toBeNull();
    expect(paneRect({ ...RECT, top: Number.NaN })).toBeNull();
    expect(paneRect({ ...RECT, left: 1e9 })).toBeNull();
    expect(paneRect({ ...RECT, height: '9' })).toBeNull();
    expect(paneRect(null)).toBeNull();
  });
});

describe('paneTabs', () => {
  it('lists the ticket then its links once, http and https only, with the pull request in front in Ready for review', () => {
    const row = { url: ISSUE, links: [{ url: PR, kind: 'pr' }, { url: ISSUE, kind: 'issue' }, { url: 'file:///C:/x', kind: 'url' }, { url: 'https://desk.zoho.com/x', kind: 'url' }] };

    expect(paneTabs(row, 'review')).toEqual({ urls: [ISSUE, PR, 'https://desk.zoho.com/x'], active: PR });
    expect(paneTabs(row, 'progress')).toEqual({ urls: [ISSUE, PR, 'https://desk.zoho.com/x'], active: ISSUE });
    expect(paneTabs({ url: '', links: [{ url: PR, kind: 'pr' }] }, 'progress')).toEqual({ urls: [PR], active: PR });
    expect(paneTabs({ url: '', links: [] }, 'review')).toBeNull();
    expect(paneTabs({ url: 'javascript:alert(1)', links: [] }, 'review')).toBeNull();
    expect(paneTabs({ url: ISSUE, links: Array.from({ length: 30 }, (_, index) => ({ url: `https://a.test/${index}`, kind: 'url' })) }, null)!.urls).toHaveLength(20);
  });
});

function setup() {
  let enabled = true;
  let extension: PaneLinkState = 'paired';
  let docks = 1;
  const extensionSent: Array<Record<string, unknown>> = [];
  const dockSent: Array<Record<string, unknown>> = [];
  const pageSent: Array<[string, PanePageView]> = [];
  const focus: Array<[string, boolean]> = [];
  const tabs = new Map<string, { workItemId: number; urls: string[]; active: string } | null>([['page-1', { workItemId: 1, urls: [ISSUE, PR], active: ISSUE }], ['page-2', { workItemId: 2, urls: [PR], active: PR }]]);
  let markers = 0;
  const state = new PaneState({
    enabled: () => enabled,
    extension: () => extension,
    toExtension: (message) => (extensionSent.push(message), extension === 'paired'),
    toDock: (data) => (dockSent.push(data), docks),
    toPage: (key, view) => pageSent.push([key, view]),
    pages: () => ['page-1', 'page-2'],
    tabsOf: (key) => tabs.get(key) ?? null,
    focused: (key, focused) => focus.push([key, focused]),
    log: () => {},
    marker: () => `00000000000${++markers}`,
  });

  return {
    state,
    extensionSent,
    dockSent,
    pageSent,
    focus,
    tabs,
    lastPage: (key: string) => pageSent.filter(([one]) => one === key).at(-1)?.[1],
    set: (next: { enabled?: boolean; extension?: PaneLinkState; docks?: number }) => {
      enabled = next.enabled ?? enabled;
      extension = next.extension ?? extension;
      docks = next.docks ?? docks;
    },
  };
}

describe('PaneState', () => {
  it('starts nothing until a dock is ready, then marks the window, sends the tabs once the dock found it, and shows the pane', () => {
    const pane = setup();

    pane.state.pageRect('page-1', RECT);
    expect(pane.extensionSent).toEqual([]);
    expect(pane.lastPage('page-1')).toEqual({ enabled: true, extension: 'paired', extensionId: PANE_EXTENSION_ID, marker: null, shown: false, error: null });

    pane.state.dockReport({ state: 'ready', marker: null });
    expect(pane.extensionSent).toEqual([{ type: 'window', marker: '000000000001' }]);
    expect(pane.dockSent.at(-1)).toEqual({ marker: '000000000001', rect: RECT });
    expect(pane.lastPage('page-1')!.marker).toBe('000000000001');
    expect(pane.lastPage('page-2')!.marker).toBeNull();

    expect(pane.state.dockReport({ state: 'found', marker: 'stale0000000' })).toBe(false);
    expect(pane.state.dockReport({ state: 'found', marker: '000000000001' })).toBe(true);
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'tabs', urls: [ISSUE, PR], active: ISSUE });
    expect(pane.lastPage('page-1')!.marker).toBeNull();

    pane.state.dockReport({ state: 'shown', marker: '000000000001' });
    expect(pane.lastPage('page-1')!.shown).toBe(true);

    // Nothing new: nothing is sent again.
    const sent = pane.extensionSent.length;

    pane.state.update();
    expect(pane.extensionSent).toHaveLength(sent);

    // Another work item: its tabs.
    pane.tabs.set('page-1', { workItemId: 3, urls: [PR], active: PR });
    pane.state.update();
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'tabs', urls: [PR], active: PR });
  });

  it('hides the pane without a column or links, and keeps the windows it found', () => {
    const pane = setup();

    pane.state.dockReport({ state: 'ready', marker: null });
    pane.state.pageRect('page-1', RECT);
    pane.state.dockReport({ state: 'found', marker: '000000000001' });
    pane.state.dockReport({ state: 'shown', marker: '000000000001' });
    pane.state.pageRect('page-1', null);
    expect(pane.dockSent.at(-1)).toEqual({ marker: '000000000001', rect: null });
    expect(pane.lastPage('page-1')!.shown).toBe(false);

    pane.state.pageRect('page-1', RECT);
    pane.tabs.set('page-1', null);
    pane.state.update();
    expect(pane.dockSent.at(-1)).toEqual({ marker: '000000000001', rect: null });
  });

  it('lets go of the pane when the setting goes off, the extension unpairs or the dock stream is gone', () => {
    const pane = setup();

    pane.state.dockReport({ state: 'ready', marker: null });
    pane.state.pageRect('page-1', RECT);
    pane.set({ enabled: false });
    pane.state.update();
    expect(pane.dockSent.at(-1)).toEqual({ marker: null, rect: null });
    expect(pane.lastPage('page-1')!.enabled).toBe(false);

    pane.set({ enabled: true, extension: 'unpaired' });
    pane.state.update();
    expect(pane.dockSent.at(-1)).toEqual({ marker: null, rect: null });
    expect(pane.lastPage('page-1')!.extension).toBe('unpaired');

    pane.set({ extension: 'paired', docks: 0 });
    pane.state.update();
    // The dock was gone, so it is not ready until it says so again.
    const windows = pane.extensionSent.filter((message) => message['type'] === 'window').length;

    pane.set({ docks: 1 });
    pane.state.update();
    expect(pane.extensionSent.filter((message) => message['type'] === 'window')).toHaveLength(windows);
    pane.state.dockReport({ state: 'ready', marker: null });
    expect(pane.extensionSent.filter((message) => message['type'] === 'window')).toHaveLength(windows + 1);
  });

  it('finds the windows again with a new marker after one was recreated, and hands the pane to a page with a column when it gains the focus', () => {
    const pane = setup();

    pane.state.dockReport({ state: 'ready', marker: null });
    pane.state.pageRect('page-1', RECT);
    pane.state.dockReport({ state: 'found', marker: '000000000001' });
    pane.state.dockReport({ state: 'lost', marker: '000000000001' });
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'window', marker: '000000000002' });

    // A page in the background reports a column: the pane stays.
    pane.state.pageRect('page-2', RECT);
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'window', marker: '000000000002' });
    pane.state.pageFocused('page-1');
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'window', marker: '000000000002' });
    pane.state.pageFocused('page-2');
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'window', marker: '000000000003' });
    expect(pane.lastPage('page-2')!.marker).toBe('000000000003');
    expect(pane.lastPage('page-1')!.marker).toBeNull();

    // Focus before the column: the column, when it comes, takes the pane over.
    pane.state.pageRect('page-1', null);
    pane.state.pageFocused('page-1');
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'window', marker: '000000000003' });
    pane.state.pageRect('page-1', RECT);
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'window', marker: '000000000004' });
    pane.state.pageClosed('page-1');

    expect(pane.dockSent.at(-1)).toEqual({ marker: null, rect: null });
  });

  it('stops after a failure or the operator closing the pane until the page shows another work item, saying why', () => {
    const pane = setup();

    pane.state.dockReport({ state: 'ready', marker: null });
    pane.state.pageRect('page-1', RECT);
    pane.state.dockReport({ state: 'failed', marker: '000000000001', reason: 'The pane would not fit the column.' });
    expect(pane.dockSent.at(-1)).toEqual({ marker: null, rect: null });
    expect(pane.lastPage('page-1')!.error).toBe('The pane would not fit the column.');

    pane.state.update();
    expect(pane.extensionSent.filter((message) => message['type'] === 'window')).toHaveLength(1);

    pane.tabs.set('page-1', { workItemId: 3, urls: [PR], active: PR });
    pane.state.update();
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'window', marker: '000000000002' });
    expect(pane.lastPage('page-1')!.error).toBeNull();

    pane.state.extensionMessage({ type: 'closed' });
    expect(pane.dockSent.at(-1)).toEqual({ marker: null, rect: null });
    // Another work item with the same links lifts it too.
    pane.tabs.set('page-1', { workItemId: 4, urls: [PR], active: PR });
    pane.state.update();
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'window', marker: '000000000003' });
  });

  it('reports the pane’s focus as its page’s, and drops it when the pane is let go', () => {
    const pane = setup();

    pane.state.dockReport({ state: 'ready', marker: null });
    pane.state.pageRect('page-1', RECT);
    pane.state.dockReport({ state: 'shown', marker: '000000000001', focused: true });
    pane.state.dockReport({ state: 'shown', marker: '000000000001', focused: true });
    pane.state.dockReport({ state: 'shown', marker: '000000000001', focused: false });
    pane.state.dockReport({ state: 'shown', marker: '000000000001', focused: true });
    pane.state.dockReport({ state: 'lost', marker: '000000000001' });
    expect(pane.focus).toEqual([['page-1', true], ['page-1', false], ['page-1', true], ['page-1', false]]);
  });
});
