import { describe, expect, it } from 'vitest';
import { fitTabs, stripTabs, UNMEASURED } from '../src/tabs.js';
import type { DocTab, StripState, TabFit } from '../src/tabs.js';
import { renderSideSwitch, renderTabs } from '../src/header.js';
import { newChanges } from '../src/changes.js';
import type { LocalTab } from '../src/localFiles.js';
import { EMPTY } from '../src/model.js';
import type { PageState } from '../src/model.js';
import { newView } from '../src/render.js';
import { mount } from '../src/island.js';
import { frameLink } from '../src/iframeBrowser.js';
import type { ArtifactView } from '@switchboard/protocol';

const artifact = (n: number): ArtifactView => ({ path: `chat/a${n}.md`, owner: 'o', kind: 'notes', title: `A ${n}`, ext: 'md', type: 'markdown', updatedAt: n });
// Opened first, read: its tab is named by the file's path. Opened second, still loading: by the target its link named.
const read: LocalTab = { id: 7, target: 'src/b.ts', line: 3, entry: { state: 'ok', data: { path: 'D:/w/src/b.ts', name: 'b.ts', kind: 'text' } as never, version: 'v', etag: null } };
const loading: LocalTab = { id: 4, target: 'docs/a.md', line: null, entry: { state: 'loading' } };
const links = [frameLink('https://github.com/o/r/issues/1', 'Issue 1'), frameLink('https://github.com/o/r/pull/2', 'PR #2')];

/** Every tab applying: History, two links, three artifacts out of order, two file tabs, Changes and Console. */
const full: StripState = {
  shown: 'status',
  statusUnread: false,
  browser: true,
  links,
  link: links[1]!.url,
  history: true,
  artifacts: [artifact(2), artifact(9), artifact(5)],
  open: null,
  closed: new Set(),
  files: { tabs: [read, loading], open: null },
  changes: true,
  console: true,
};
const ids = (tabs: DocTab[]): string[] => tabs.map((tab) => tab.id);
const selected = (tabs: DocTab[]): string[] => tabs.filter((tab) => tab.selected).map((tab) => tab.id);
const ORDER = ['status', 'history', `link:${links[0]!.url}`, `link:${links[1]!.url}`, 'artifact:chat/a9.md', 'artifact:chat/a5.md', 'artifact:chat/a2.md', 'file:D:/w/src/b.ts', 'file:docs/a.md', 'changes', 'console'];

describe('stripTabs', () => {
  it('StripTabs_WideLayout_OrdersStatusHistoryLinksArtifactsFilesChangesConsole', () => {
    expect(ids(stripTabs(full, 'wide'))).toEqual(ORDER);
  });

  it('StripTabs_NarrowLayout_PutsConversationFirstThenTheSameOrder', () => {
    expect(ids(stripTabs(full, 'narrow'))).toEqual(['conversation', ...ORDER]);
  });

  it('StripTabs_NothingOptionalApplies_ShowsStatusAloneOrWithConversation', () => {
    const bare: StripState = { ...full, browser: false, links: undefined, history: false, artifacts: [], files: { tabs: [], open: null }, changes: false, console: false };

    expect(ids(stripTabs(bare, 'wide'))).toEqual(['status']);
    expect(ids(stripTabs(bare, 'narrow'))).toEqual(['conversation', 'status']);
  });

  it('StripTabs_BrowserWithoutLinkTabs_ShowsTheBrowserTabWhereTheLinksGo', () => {
    expect(ids(stripTabs({ ...full, links: undefined }, 'wide')).slice(0, 4)).toEqual(['status', 'history', 'browser', 'artifact:chat/a9.md']);
    // No Browser tab beside link tabs, even an empty list of them, nor without the browser.
    expect(ids(stripTabs({ ...full, links: [] }, 'wide'))).not.toContain('browser');
    expect(ids(stripTabs({ ...full, links: undefined, browser: false }, 'wide'))).not.toContain('browser');
  });

  it('StripTabs_LinkTabsWithoutTheBrowserTab_StillShowEachLink', () => {
    expect(ids(stripTabs({ ...full, browser: false }, 'wide')).filter((id) => id.startsWith('link:'))).toEqual(links.map((link) => `link:${link.url}`));
  });

  it('StripTabs_ClosedArtifact_HasNoTabUnlessItShows', () => {
    const closed = new Set(['chat/a5.md']);

    expect(ids(stripTabs({ ...full, closed }, 'wide'))).not.toContain('artifact:chat/a5.md');
    // Shown in another pane than Artifacts, it still has none.
    expect(ids(stripTabs({ ...full, closed, open: 'chat/a5.md' }, 'wide'))).not.toContain('artifact:chat/a5.md');
    expect(selected(stripTabs({ ...full, closed, open: 'chat/a5.md', shown: 'artifacts' }, 'wide'))).toEqual(['artifact:chat/a5.md']);
  });

  it('StripTabs_EachShownTab_IsTheOneSelected', () => {
    expect(selected(stripTabs(full, 'narrow'))).toEqual(['status']);
    expect(selected(stripTabs({ ...full, shown: 'conversation' }, 'narrow'))).toEqual(['conversation']);
    expect(selected(stripTabs({ ...full, shown: 'history' }, 'wide'))).toEqual(['history']);
    expect(selected(stripTabs({ ...full, shown: 'browser' }, 'wide'))).toEqual([`link:${links[1]!.url}`]);
    expect(selected(stripTabs({ ...full, shown: 'browser', links: undefined }, 'wide'))).toEqual(['browser']);
    expect(selected(stripTabs({ ...full, shown: 'artifacts', open: 'chat/a2.md' }, 'wide'))).toEqual(['artifact:chat/a2.md']);
    expect(selected(stripTabs({ ...full, shown: 'file', files: { tabs: [read, loading], open: 4 } }, 'wide'))).toEqual(['file:docs/a.md']);
    expect(selected(stripTabs({ ...full, shown: 'diff' }, 'wide'))).toEqual(['changes']);
    expect(selected(stripTabs({ ...full, shown: 'console' }, 'wide'))).toEqual(['console']);
    // The link, artifact and file a pane would show select nothing while another tab shows.
    expect(selected(stripTabs({ ...full, open: 'chat/a2.md', files: { tabs: [read], open: 7 } }, 'wide'))).toEqual(['status']);
  });

  it('StripTabs_UnreadStatus_MarksStatusAlone', () => {
    const tabs = stripTabs({ ...full, statusUnread: true }, 'narrow');

    expect(tabs.filter((tab) => tab.kind === 'fixed' && tab.unread).map((tab) => tab.id)).toEqual(['status']);
    expect(stripTabs(full, 'narrow').some((tab) => tab.kind === 'fixed' && tab.unread)).toBe(false);
  });
});

describe('the strips drawn from stripTabs', () => {
  const state: PageState = { ...EMPTY, artifacts: full.artifacts as ArtifactView[] };
  const strip = { links, link: links[1]!.url, open: null, menu: false, now: 0, files: full.files, changes: newChanges() };
  const draw = (tree: ReturnType<typeof renderTabs>): HTMLElement[] => {
    const host = document.createElement('div');

    mount(host, tree);
    return [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
  };
  // Each drawn tab named as stripTabs names it.
  const name = (tab: HTMLElement): string =>
    tab.dataset['tab'] ?? tab.dataset['side'] ?? (tab.dataset['url'] !== undefined ? `link:${tab.dataset['url']}` : tab.closest<HTMLElement>('.artifact-tab')?.dataset['path'] !== undefined ? `artifact:${tab.closest<HTMLElement>('.artifact-tab')!.dataset['path']}` : tab.dataset['local'] !== undefined ? `file:${tab.dataset['local']}` : tab.classList.contains('changes-tab') ? 'changes' : '?');
  const drawnOrder = ['status', 'history', `link:${links[0]!.url}`, `link:${links[1]!.url}`, 'artifact:chat/a9.md', 'artifact:chat/a5.md', 'artifact:chat/a2.md', 'file:7', 'file:4', 'changes', 'console'];

  it('SideSwitch_EveryTab_DrawnInTheStripOrderSoLeftAndRightFollowIt', () => {
    expect(draw(renderSideSwitch('status', state, true, strip, true, true)).map(name)).toEqual(drawnOrder);
  });

  it('ConversationStrip_EveryTab_DrawnInTheSameOrderAfterConversation', () => {
    expect(draw(renderTabs(newView(), state, true, strip, true, true)).map(name)).toEqual(['conversation', ...drawnOrder]);
  });

  it('Strip_TabsBeyondTheFit_GoToMoreAtTheEnd', () => {
    const host = document.createElement('div');
    // Room for Status, History and the first link beside More.
    const fit: TabFit = { width: 350, more: 50, plain: 100, closable: 100, measured: {} };

    mount(host, renderSideSwitch('status', state, true, { ...strip, fit }, true, true));
    expect(draw(renderSideSwitch('status', state, true, { ...strip, fit }, true, true)).map(name)).toEqual(drawnOrder.slice(0, 3));
    // After every tab drawn, with the count of the rest, Console among them.
    expect(host.querySelector('nav')!.lastElementChild!.classList.contains('tab-more')).toBe(true);
    expect(host.querySelector('.tab-more-button .tab-badge')!.textContent).toBe(String(drawnOrder.length - 3));
    // Each drawn tab names its id, by which the page measures it.
    expect([...host.querySelectorAll<HTMLElement>('nav > [data-id]')].map((tab) => tab.dataset['id'])).toEqual(ORDER.slice(0, 3));
  });

  it('LinkTab_Tooltip_IsItsFullNameAndUrl', () => {
    const host = document.createElement('div');

    mount(host, renderSideSwitch('browser', state, true, strip, true, true));
    expect(host.querySelector<HTMLElement>(`[data-url="${links[0]!.url}"].tab-open`)!.textContent).toBe('#1');
    expect(host.querySelector<HTMLElement>(`[data-url="${links[0]!.url}"].tab-open`)!.title).toBe(`Issue 1 · ${links[0]!.url}`);
  });
});

describe('fitTabs', () => {
  const tabs = stripTabs({ ...full, shown: 'artifacts', open: 'chat/a2.md' }, 'narrow');
  const ids2 = (fitted: { shown: DocTab[]; hidden: DocTab[] }): [string[], string[]] => [ids(fitted.shown), ids(fitted.hidden)];
  // Every tab 100 px, a closable one 120 px, More 60 px.
  const fit = (width: number, measured: Record<string, number> = {}): TabFit => ({ width, more: 60, plain: 100, closable: 120, measured });
  const all = ['conversation', ...ORDER];
  // 4 plain tabs (Conversation, Status, Changes, Console) and 8 closable ones (History, two links, three artifacts, two files).
  const total = 4 * 100 + 8 * 120;

  it('FitTabs_UnmeasuredOrRoomForAll_ShowsEveryTab', () => {
    expect(ids2(fitTabs(tabs, UNMEASURED))).toEqual([all, []]);
    expect(ids2(fitTabs(tabs, fit(total)))).toEqual([all, []]);
    // More for the closed artifacts needs its room too.
    expect(ids2(fitTabs(tabs, fit(total), true))[1]).not.toEqual([]);
    expect(ids2(fitTabs(tabs, fit(total + 60), true))).toEqual([all, []]);
  });

  it('FitTabs_TooNarrow_KeepsTheSelectedTabConversationAndStatusThenTheRestInStripOrder', () => {
    // 60 for More, 120 for the selected artifact, 100 each for Conversation and Status, then History at 120: 500.
    const [shown, hidden] = ids2(fitTabs(tabs, fit(500)));

    expect(shown).toEqual(['conversation', 'status', 'history', 'artifact:chat/a2.md']);
    expect(hidden).toEqual(all.filter((id) => !shown.includes(id)));
    // One pixel short of History: it and every tab after it go, even one that would fit.
    expect(ids2(fitTabs(tabs, fit(499)))[0]).toEqual(['conversation', 'status', 'artifact:chat/a2.md']);
  });

  it('FitTabs_StripTooNarrowForTheKeptTabs_DropsStatusThenConversationButNeverTheSelectedTab', () => {
    expect(ids2(fitTabs(tabs, fit(379)))[0]).toEqual(['conversation', 'artifact:chat/a2.md']);
    expect(ids2(fitTabs(tabs, fit(279)))[0]).toEqual(['artifact:chat/a2.md']);
    expect(ids2(fitTabs(tabs, fit(10)))[0]).toEqual(['artifact:chat/a2.md']);
    // Every tab not shown is in More.
    expect(ids2(fitTabs(tabs, fit(10)))[1]).toHaveLength(all.length - 1);
  });

  it('FitTabs_SelectedConversation_KeepsStatusNext', () => {
    const conversation = stripTabs({ ...full, shown: 'conversation' }, 'narrow');

    expect(ids2(fitTabs(conversation, fit(260)))[0]).toEqual(['conversation', 'status']);
  });

  it('FitTabs_MeasuredTab_UsesItsOwnWidthOverItsKinds', () => {
    // History measured at 300 px no longer fits where it did at 120.
    expect(ids2(fitTabs(tabs, fit(500, { history: 300 })))[0]).toEqual(['conversation', 'status', 'artifact:chat/a2.md']);
    // A narrow Status measured at 60 px lets History in at 460.
    expect(ids2(fitTabs(tabs, fit(460, { status: 60 })))[0]).toEqual(['conversation', 'status', 'history', 'artifact:chat/a2.md']);
  });
});
