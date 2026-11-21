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
  let helper = true;
  const wanted: boolean[] = [];
  const extensionSent: Array<Record<string, unknown>> = [];
  const helperSent: Array<Record<string, unknown>> = [];
  const pageSent: Array<[string, PanePageView]> = [];
  const focus: Array<[string, boolean]> = [];
  const tabs = new Map<string, { workItemId: number; urls: string[]; active: string } | null>([['page-1', { workItemId: 1, urls: [ISSUE, PR], active: ISSUE }], ['page-2', { workItemId: 2, urls: [PR], active: PR }]]);
  let markers = 0;
  const state = new PaneState({
    enabled: () => enabled,
    extension: () => extension,
    toExtension: (message) => (extensionSent.push(message), extension === 'paired'),
    toHelper: (data) => (helperSent.push(data), helper),
    want: (on) => wanted.push(on),
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
    helperSent,
    wanted,
    pageSent,
    focus,
    tabs,
    lastPage: (key: string) => pageSent.filter(([one]) => one === key).at(-1)?.[1],
    set: (next: { enabled?: boolean; extension?: PaneLinkState; helper?: boolean }) => {
      enabled = next.enabled ?? enabled;
      extension = next.extension ?? extension;
      helper = next.helper ?? helper;
    },
  };
}

describe('PaneState', () => {
  it('wants the helper once a page owns the pane, starts nothing until it is ready, then marks the window, sends the tabs once it found it, and shows the pane', () => {
    const pane = setup();

    pane.state.update();
    expect(pane.wanted.at(-1)).toBe(false);
    pane.state.pageRect('page-1', RECT);
    expect(pane.wanted.at(-1)).toBe(true);
    expect(pane.extensionSent).toEqual([]);
    expect(pane.helperSent).toEqual([]);
    expect(pane.lastPage('page-1')).toEqual({ enabled: true, extension: 'paired', extensionId: PANE_EXTENSION_ID, marker: null, shown: false, error: null });

    pane.state.helperReport({ state: 'ready', marker: null });
    expect(pane.extensionSent).toEqual([{ type: 'window', marker: '000000000001' }]);
    expect(pane.helperSent.at(-1)).toEqual({ marker: '000000000001', rect: RECT });
    expect(pane.lastPage('page-1')!.marker).toBe('000000000001');
    expect(pane.lastPage('page-2')!.marker).toBeNull();

    expect(pane.state.helperReport({ state: 'found', marker: 'stale0000000' })).toBe(false);
    expect(pane.state.helperReport({ state: 'found', marker: '000000000001' })).toBe(true);
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'tabs', urls: [ISSUE, PR], active: ISSUE });
    expect(pane.lastPage('page-1')!.marker).toBeNull();

    pane.state.helperReport({ state: 'shown', marker: '000000000001' });
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

    pane.state.helperReport({ state: 'ready', marker: null });
    pane.state.pageRect('page-1', RECT);
    pane.state.helperReport({ state: 'found', marker: '000000000001' });
    pane.state.helperReport({ state: 'shown', marker: '000000000001' });
    pane.state.pageRect('page-1', null);
    expect(pane.helperSent.at(-1)).toEqual({ marker: '000000000001', rect: null });
    expect(pane.lastPage('page-1')!.shown).toBe(false);

    pane.state.pageRect('page-1', RECT);
    pane.tabs.set('page-1', null);
    pane.state.update();
    expect(pane.helperSent.at(-1)).toEqual({ marker: '000000000001', rect: null });
  });

  it('lets go of the pane and stops wanting the helper when the setting goes off or the extension unpairs, and starts over when the helper is gone', () => {
    const pane = setup();

    pane.state.helperReport({ state: 'ready', marker: null });
    pane.state.pageRect('page-1', RECT);
    pane.set({ enabled: false });
    pane.state.update();
    expect(pane.helperSent.at(-1)).toEqual({ marker: null, rect: null });
    expect(pane.wanted.at(-1)).toBe(false);
    expect(pane.lastPage('page-1')!.enabled).toBe(false);

    pane.set({ enabled: true, extension: 'unpaired' });
    pane.state.update();
    expect(pane.helperSent.at(-1)).toEqual({ marker: null, rect: null });
    expect(pane.lastPage('page-1')!.extension).toBe('unpaired');

    pane.set({ extension: 'paired', helper: false });
    pane.state.update();
    expect(pane.wanted.at(-1)).toBe(true);
    // The helper did not take the order, so it is not ready until it says so again.
    const windows = pane.extensionSent.filter((message) => message['type'] === 'window').length;

    pane.set({ helper: true });
    pane.state.update();
    expect(pane.extensionSent.filter((message) => message['type'] === 'window')).toHaveLength(windows);
    pane.state.helperReport({ state: 'ready', marker: null });
    expect(pane.extensionSent.filter((message) => message['type'] === 'window')).toHaveLength(windows + 1);

    // The helper stopped: the marker goes, and its restart starts over with a new one.
    const sent = pane.helperSent.length;

    pane.state.helperStopped(null);
    expect(pane.helperSent).toHaveLength(sent);
    expect(pane.lastPage('page-1')!.marker).toBeNull();
    pane.state.helperReport({ state: 'ready', marker: null });
    expect(pane.extensionSent.filter((message) => message['type'] === 'window')).toHaveLength(windows + 2);
  });

  it('shows why the helper does not run until it is ready again, below a failure the helper reported', () => {
    const pane = setup();

    pane.state.pageRect('page-1', RECT);
    pane.state.helperStopped('The Chrome pane helper is not installed.');
    expect(pane.lastPage('page-1')!.error).toBe('The Chrome pane helper is not installed.');
    expect(pane.lastPage('page-2')!.error).toBeNull();
    pane.state.helperReport({ state: 'ready', marker: null });
    expect(pane.lastPage('page-1')!.error).toBeNull();

    pane.state.helperReport({ state: 'failed', marker: '000000000001', reason: 'Windows refused to move or resize the pane.' });
    pane.state.helperStopped('The Chrome pane helper keeps stopping.');
    expect(pane.lastPage('page-1')!.error).toBe('Windows refused to move or resize the pane.');
    // A failure dismisses the pane, so the helper is not wanted until another work item.
    expect(pane.wanted.at(-1)).toBe(false);
  });

  it('finds the windows again with a new marker after one was recreated, and hands the pane to a page with a column when it gains the focus', () => {
    const pane = setup();

    pane.state.helperReport({ state: 'ready', marker: null });
    pane.state.pageRect('page-1', RECT);
    pane.state.helperReport({ state: 'found', marker: '000000000001' });
    pane.state.helperReport({ state: 'lost', marker: '000000000001' });
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

    expect(pane.helperSent.at(-1)).toEqual({ marker: null, rect: null });
  });

  it('stops after a failure or the operator closing the pane until the page shows another work item, saying why', () => {
    const pane = setup();

    pane.state.helperReport({ state: 'ready', marker: null });
    pane.state.pageRect('page-1', RECT);
    pane.state.helperReport({ state: 'failed', marker: '000000000001', reason: 'The pane would not fit the column.' });
    expect(pane.helperSent.at(-1)).toEqual({ marker: null, rect: null });
    expect(pane.lastPage('page-1')!.error).toBe('The pane would not fit the column.');

    pane.state.update();
    expect(pane.extensionSent.filter((message) => message['type'] === 'window')).toHaveLength(1);

    pane.tabs.set('page-1', { workItemId: 3, urls: [PR], active: PR });
    pane.state.update();
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'window', marker: '000000000002' });
    expect(pane.lastPage('page-1')!.error).toBeNull();

    pane.state.extensionMessage({ type: 'closed' });
    expect(pane.helperSent.at(-1)).toEqual({ marker: null, rect: null });
    // Another work item with the same links lifts it too.
    pane.tabs.set('page-1', { workItemId: 4, urls: [PR], active: PR });
    pane.state.update();
    expect(pane.extensionSent.at(-1)).toEqual({ type: 'window', marker: '000000000003' });
  });

  it('reports the pane’s focus as its page’s, and drops it when the pane is let go', () => {
    const pane = setup();

    pane.state.helperReport({ state: 'ready', marker: null });
    pane.state.pageRect('page-1', RECT);
    pane.state.helperReport({ state: 'shown', marker: '000000000001', focused: true });
    pane.state.helperReport({ state: 'shown', marker: '000000000001', focused: true });
    pane.state.helperReport({ state: 'shown', marker: '000000000001', focused: false });
    pane.state.helperReport({ state: 'shown', marker: '000000000001', focused: true });
    pane.state.helperReport({ state: 'lost', marker: '000000000001' });
    expect(pane.focus).toEqual([['page-1', true], ['page-1', false], ['page-1', true], ['page-1', false]]);
  });
});
