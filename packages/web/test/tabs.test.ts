import { describe, expect, it } from 'vitest';
import { stripTabs } from '../src/tabs.js';
import type { DocTab, StripState } from '../src/tabs.js';
import { renderSideSwitch, renderTabs } from '../src/header.js';
import { newChanges } from '../src/changes.js';
import type { LocalTab } from '../src/localFiles.js';
import { EMPTY } from '../src/model.js';
import type { PageState } from '../src/model.js';
import { newView } from '../src/render.js';
import { mount } from '../src/island.js';
import type { ArtifactView } from '@switchboard/protocol';

const artifact = (n: number): ArtifactView => ({ path: `chat/a${n}.md`, owner: 'o', kind: 'notes', title: `A ${n}`, ext: 'md', type: 'markdown', updatedAt: n });
// Opened first, read: its tab is named by the file's path. Opened second, still loading: by the target its link named.
const read: LocalTab = { id: 7, target: 'src/b.ts', line: 3, entry: { state: 'ok', data: { path: 'D:/w/src/b.ts', name: 'b.ts', kind: 'text' } as never, version: 'v', etag: null } };
const loading: LocalTab = { id: 4, target: 'docs/a.md', line: null, entry: { state: 'loading' } };
const links = [{ url: 'https://github.com/o/r/issues/1', label: 'Issue 1' }, { url: 'https://github.com/o/r/pull/2', label: 'PR #2' }];

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
  const strip = { links, link: links[1]!.url, open: null, fit: 3, menu: false, now: 0, files: full.files, changes: newChanges() };
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

  it('Strip_ArtifactsBeyondTheFit_GoToTheArtifactsMenuAtTheEnd', () => {
    const host = document.createElement('div');

    mount(host, renderSideSwitch('status', state, true, { ...strip, fit: 1 }, true, true));
    expect([...host.querySelectorAll<HTMLElement>('.artifact-tab:not(.link-tab)')].map((tab) => tab.dataset['path'])).toEqual(['chat/a9.md']);
    // After every tab, Console too.
    expect(host.querySelector('nav')!.lastElementChild!.classList.contains('artifact-more')).toBe(true);
  });
});
