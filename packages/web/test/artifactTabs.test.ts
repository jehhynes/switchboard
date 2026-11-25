import { describe, expect, it } from 'vitest';
import { renderSideSwitch, renderTabs } from '../src/header.js';
import { ARTIFACT_MENU_WIDTH, ARTIFACT_TAB_WIDTH, ARTIFACT_TABS_MAX, artifactBar, artifactTabWidth, artifactUrl, artifactTabsFit, closedArtifacts, newView, openArtifactsSeen, parseArtifactsSeen, unreadArtifacts } from '../src/render.js';
import { EMPTY } from '../src/model.js';
import type { ArtifactView } from '@switchboard/protocol';
import { html } from './html.js';
import { changesTab, newChanges } from '../src/changes.js';
import { PAGE_ASSETS } from '../dist/index.js';

const artifact = (index: number): ArtifactView => ({ path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 1_000 + index });
const eight = [0, 1, 2, 3, 4, 5, 6, 7].map(artifact);
const paths = (markup: string, attribute: string) => [...markup.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map((match) => match[1]);
/** The artifact tabs' paths, from each tab's cell. */
const tabPaths = (markup: string) => [...markup.matchAll(/role="presentation" data-action="artifact" data-path="([^"]+)"/g)].map((match) => match[1]);

describe('artifactTabWidth', () => {
  it('ArtifactTabWidth_LabelledOrIcons_IsTheWidthPageCssDrawsItAtMost', () => {
    // 14 px padding, 16 px icon, 6 px gap, the 100 px label, 6 px gap, the 20 px close mark 6 px from the end, and the 1 px border.
    expect(artifactTabWidth(14, 100, false)).toBe(169);
    expect(ARTIFACT_TAB_WIDTH).toBe(169);
    // As an icon: the icon in its padding and the border, as wide as a fixed tab's icon.
    expect(artifactTabWidth(14, 100, true)).toBe(45);
    expect(artifactTabWidth(9, 100, true)).toBe(35);
    // Icons fit many more tabs into the same room.
    expect(artifactTabsFit(600, 300, 8, 60, artifactTabWidth(14, 100, true))).toBe(5);
    expect(artifactTabsFit(600, 300, 8, 60)).toBe(1);
  });
});

describe('artifactTabsFit', () => {
  it('shows every tab when they fit without the menu, else as many as fit beside it, at least one and at most the cap', () => {
    expect(artifactTabsFit(1000, 200, 3)).toBe(3);
    // 3 tabs need 504 px: in 600 px they do not fit with 200 px of other tabs, so the menu takes its room and 1 tab is left.
    expect(artifactTabsFit(600, 200, 3)).toBe(Math.floor((600 - 200 - ARTIFACT_MENU_WIDTH) / ARTIFACT_TAB_WIDTH));
    // No room for even one tab beside the menu: none, and the menu lists them all.
    expect(artifactTabsFit(300, 250, 8)).toBe(0);
    // The Artifacts button as drawn, here 60 px, leaves room for one more.
    expect(artifactTabsFit(700, 200, 8, 60)).toBe(Math.floor((700 - 200 - 60) / ARTIFACT_TAB_WIDTH));
    expect(artifactTabsFit(5000, 200, 8)).toBe(ARTIFACT_TABS_MAX);
    expect(artifactTabsFit(0, 0, 8)).toBe(ARTIFACT_TABS_MAX);
    expect(artifactTabsFit(0, 0, 2)).toBe(2);
    expect(artifactTabsFit(1000, 200, 0)).toBe(0);
  });
});

describe('closedArtifacts', () => {
  it('counts an artifact closed at its version, and open again once a newer version comes', () => {
    expect([...closedArtifacts(eight, [{ path: 'chat/a1.md', updatedAt: 1_001 }, { path: 'chat/a2.md', updatedAt: 900 }, { path: 'chat/gone.md', updatedAt: 1 }])]).toEqual(['chat/a1.md']);
  });
});

describe('artifactBar', () => {
  it('orders the artifacts newest first and puts the open one in place of the last tab when it does not fit', () => {
    expect(artifactBar(eight, null, 3).tabs.map((one) => one.path)).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a5.md']);
    expect(artifactBar(eight, 'chat/a0.md', 3).tabs.map((one) => one.path)).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a0.md']);
    expect(artifactBar(eight, 'chat/a6.md', 3).tabs.map((one) => one.path)).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a5.md']);
    expect(artifactBar(eight, 'chat/gone.md', 3).tabs).toHaveLength(3);
    expect(artifactBar(eight, null, 3).ordered.map((one) => one.path)).toEqual(eight.map((one) => one.path).reverse());
  });
});

describe('the artifacts this device opened', () => {
  it('reads the readable entries of what was kept, and none from nothing or something unreadable', () => {
    expect(parseArtifactsSeen(JSON.stringify({ '1': ['chat/a1.md'], '2': 'bad', '3': [4] }))).toEqual({ '1': ['chat/a1.md'] });
    expect(parseArtifactsSeen(null)).toEqual({});
    expect(parseArtifactsSeen('{')).toEqual({});
    expect(parseArtifactsSeen('[["chat/a1.md"]]')).toEqual({});
  });

  it('counts as unread the artifacts of a seen work item not opened, and none of a work item not seen yet', () => {
    const seen = { '1': ['chat/a5.md', 'chat/a0.md'], '2': ['chat/a6.md'] };

    expect([...unreadArtifacts(eight.slice(4), 1, seen)]).toEqual(['chat/a4.md', 'chat/a6.md', 'chat/a7.md']);
    expect([...unreadArtifacts(eight, 3, seen)]).toEqual([]);
    expect([...unreadArtifacts(eight, null, seen)]).toEqual([]);
  });

  it('adds opened paths once, records a work item seen with none, and leaves the record it was given alone', () => {
    const seen = { '1': ['chat/a1.md'] };

    expect(openArtifactsSeen(seen, 1, ['chat/a2.md', 'chat/a1.md'])).toEqual({ '1': ['chat/a1.md', 'chat/a2.md'] });
    expect(openArtifactsSeen(seen, 3, [])).toEqual({ '1': ['chat/a1.md'], '3': [] });
    expect(openArtifactsSeen(seen, 1, ['chat/a1.md'])).toBeNull();
    expect(seen).toEqual({ '1': ['chat/a1.md'] });
  });
});

const css = PAGE_ASSETS['page.css']!.body;

describe('the artifact tabs', () => {
  const state = { ...EMPTY, connected: true, artifacts: eight };

  it('follow Status and Browser in the column, the open one chosen with a close mark, then Artifacts with the rest and Console after them', () => {
    const markup = html(renderSideSwitch('artifacts', state, true, { open: 'chat/a2.md', fit: 3, menu: false, now: 2_000 }));

    expect(paths(markup, 'data-side')).toEqual(['status', 'browser', 'console']);
    expect(tabPaths(markup)).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a2.md']);
    expect(markup).toMatch(/class="tab artifact-tab selected"[^>]*data-path="chat\/a2.md"/);
    // The close mark is a button of its own beside the tab's, so each takes the keyboard.
    // Each artifact tab has its own close button beside the tab's, so each takes the keyboard; the open one's is in the tab order.
    expect(markup.match(/<button class="tab-close" type="button" data-action="close-artifact"/g)).toHaveLength(3);
    expect(markup).toContain('data-path="chat/a2.md" aria-label="Close Note 2" title="Close" tabindex="0"');
    expect(markup.match(/role="tab"/g)).toHaveLength(6);
    // Artifacts counts every artifact, open in a tab or not, with no plus sign.
    expect(markup).toContain('<span class="tab-badge muted">8</span>');
    expect(markup).not.toContain('+5');
    expect(markup).not.toContain('artifact-menu" role="menu"');
  });

  it('choose none while another tab shows, and list every artifact in the open menu, those with a tab dimmed', () => {
    const markup = html(renderSideSwitch('status', state, false, { open: 'chat/a2.md', fit: 2, menu: true, now: 2_000 }));

    expect(markup).not.toContain('artifact-tab selected');
    expect(markup).not.toContain('title="Close" tabindex="0"');
    expect(paths(markup.slice(markup.indexOf('artifact-menu" role="menu"')), 'data-path')).toEqual(eight.map((one) => one.path).reverse());
    expect(markup.match(/menu-row in-bar/g)).toHaveLength(2);
  });

  it("show each artifact's title, kind and age in the menu, and its title and kind in its tab's tooltip", () => {
    const kinds = [{ ...artifact(1), kind: 'plan', title: 'Rollout plan' }, { ...artifact(2), kind: 'report', title: 'Load test' }, ...eight.slice(3)];
    const markup = html(renderSideSwitch('status', { ...state, artifacts: kinds }, false, { open: null, fit: 1, menu: true, now: 1_001 + 3 * 60_000 }));
    const menu = new DOMParser().parseFromString(markup, 'text/html').querySelector('.artifact-menu')!;
    const row = menu.querySelector('[data-path="chat/a1.md"]')!;

    expect([...row.children].map((cell) => cell.className)).toEqual(['menu-gutter', 'title', 'menu-kind', 'menu-note']);
    expect(row.querySelector('.title')!.textContent).toBe('Rollout plan');
    expect(row.querySelector('.menu-kind')!.textContent).toBe('plan');
    expect(row.querySelector('.menu-note')!.textContent).toBe('3 min ago');
    expect(row.getAttribute('aria-label')).toBe('Rollout plan, plan, 3 min ago');
    expect(menu.querySelector('[data-path="chat/a2.md"] .menu-kind')!.textContent).toBe('report');
    expect(markup).toContain('title="Note 7 · note"');
  });

  it("list an external artifact as any other, its menu row's tooltip its real path, and fetch it by its name", () => {
    const outside = { ...artifact(9), path: '@3/summary.md', owner: 'external', kind: 'research', title: 'Speech engines', file: 'D:/git/research/topic/summary.md' };
    const markup = html(renderSideSwitch('status', { ...state, artifacts: [outside, ...eight] }, false, { open: null, fit: 1, menu: true, now: 2_000 }));
    const menu = new DOMParser().parseFromString(markup, 'text/html').querySelector('.artifact-menu')!;

    expect(tabPaths(markup)).toEqual(['@3/summary.md']);
    expect(menu.querySelector('[data-path="@3/summary.md"]')!.getAttribute('title')).toBe('D:/git/research/topic/summary.md');
    expect(menu.querySelector('[data-path="chat/a7.md"]')!.getAttribute('title')).toBe('chat/a7.md');
    expect(artifactUrl('k', outside.path)).toBe('/v1/conversation/artifact/k/%403/summary.md');
  });

  it('leave out the closed artifacts but the open one, and list them in the menu as any other', () => {
    const closed = new Set(['chat/a7.md', 'chat/a5.md']);
    const markup = html(renderSideSwitch('artifacts', state, false, { open: 'chat/a5.md', fit: 3, menu: true, now: 2_000, closed }));
    const menu = new DOMParser().parseFromString(markup, 'text/html').querySelector('.artifact-menu')!;

    // The open one takes the last tab's place, and the tabs stay newest first.
    expect(tabPaths(markup)).toEqual(['chat/a6.md', 'chat/a5.md', 'chat/a4.md']);
    expect(menu.querySelector('[data-path="chat/a7.md"]')!.className).toBe('menu-row');
    expect(menu.querySelector('[data-path="chat/a7.md"] .menu-note')!.textContent).toBe('just now');
    expect(menu.textContent).not.toContain('Closed');
  });

  it('mark the artifacts not opened with the unread dot after the title, named in the row', () => {
    const unread = new Set(['chat/a7.md', 'chat/a0.md']);
    const markup = html(renderSideSwitch('status', state, false, { open: null, fit: 2, menu: true, now: 1_001 + 3 * 60_000, unread }));
    const menu = new DOMParser().parseFromString(markup, 'text/html').querySelector('.artifact-menu')!;
    const row = menu.querySelector('[data-path="chat/a0.md"]')!;

    expect([...menu.querySelectorAll('.unread-dot')].map((dot) => dot.closest<HTMLElement>('.menu-row')!.dataset['path'])).toEqual(['chat/a7.md', 'chat/a0.md']);
    expect([...row.querySelector('.title')!.children].map((cell) => cell.className)).toEqual(['title-text', 'unread-dot']);
    expect(row.getAttribute('aria-label')).toBe('Note 0, unread, note, 3 min ago');
    expect(menu.querySelector('[data-path="chat/a1.md"]')!.getAttribute('aria-label')).toBe('Note 1, note, 3 min ago');
    // The artifact tabs carry no dot; the Artifacts button carries one, and names the unread count.
    const strip = new DOMParser().parseFromString(markup, 'text/html');

    expect(strip.querySelectorAll('.artifact-tab .unread-dot')).toHaveLength(0);
    // On the count's corner, as a notification badge; the button has no caret, its menu named by aria-haspopup and its tooltip.
    expect(strip.querySelectorAll('.artifact-menu-button .tab-badge > .unread-dot')).toHaveLength(1);
    expect(strip.querySelector('.artifact-menu-button .codicon-chevron-down')).toBeNull();
    expect(strip.querySelector('.artifact-menu-button')!.getAttribute('aria-haspopup')).toBe('menu');
    expect(css).toContain('.tab.artifact-menu-button .tab-badge > .unread-dot { position: absolute; top: -3px; right: -3px;');
    expect(strip.querySelector('.artifact-menu-button')!.getAttribute('aria-label')).toBe('Artifacts, 8, 2 unread');
    expect(strip.querySelector('.artifact-menu-button .tab-badge')!.textContent).toBe('8');
  });

  it('show no menu when every artifact has a tab, and none at all without artifacts', () => {
    expect(html(renderSideSwitch('status', { ...state, artifacts: eight.slice(0, 2) }, false, { open: null, fit: 5, menu: false, now: 0 }))).not.toContain('artifact-menu-button');
    expect(html(renderSideSwitch('status', EMPTY))).not.toContain('artifact-tab');
  });

  it('end the conversation tab strip on a narrower screen the same way', () => {
    const markup = html(renderTabs({ ...newView(), tab: 'artifacts' }, state, false, { open: 'chat/a7.md', fit: 1, menu: false, now: 0 }));

    expect(paths(markup, 'data-tab')).toEqual(['conversation', 'status', 'console']);
    expect(tabPaths(markup)).toEqual(['chat/a7.md']);
    expect(markup).toContain('<span class="tab-badge muted">8</span>');
  });
});

describe("an artifact view's head", () => {
  const css = PAGE_ASSETS['page.css']!.body;

  it('is one bar for every type: the tab surface, a fixed height, and Open in new window as a 14 px icon, a link drawn as the button is', () => {
    expect(css).toContain('.artifact-head { box-sizing: border-box; flex: none; display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 12px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--sb-tab-surface, transparent); }');
    expect(css).toContain('.artifact-head .icon { box-sizing: border-box; flex: none; justify-content: center; width: 22px; height: 22px; padding: 0; text-decoration: none; }');
    expect(css).toContain('.artifact-head .icon > .codicon { font-size: 14px; line-height: 1; }');
    expect(css).toMatch(/@media \(hover: none\), \(pointer: coarse\) \{\n  \.artifact-head \{ min-height: 52px; \}\n  \.artifact-head \.icon \{ width: 44px; height: 44px; \}\n\}/);
    // No other rule sizes its button or glyph, as the bars' touch rule did.
    expect(css.match(/\.artifact-head[^{]*\{[^}]*(min-width|min-height|font-size)/g)).toEqual(['.artifact-head { box-sizing: border-box; flex: none; display: flex; align-items: center; gap: 6px; min-height', '.artifact-head .icon > .codicon { font-size', '.artifact-head { min-height']);
  });
});

describe('the tab strip on a narrow screen', () => {
  const css = PAGE_ASSETS['page.css']!.body;
  const narrow = /@container \(max-width: 600px\) \{\n([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

  it('never wraps, and under 600 px shows Artifacts and the Changes tab as their icons and counts, and a file tab only while chosen', () => {
    // A size container is a stacking context: the strip stands above the pane after it, so the Artifacts menu inside it does too.
    expect(css).toMatch(/\.tabs \{ position: relative; z-index: 3; display: flex; flex-wrap: nowrap; container-type: inline-size;/);
    expect(css).toContain('@container (max-width: 600px) { .tabs > * { --sb-tab-icons: 1; --sb-tab-label-display: none; --sb-tab-justify: center; --sb-tab-close-other: none; } }');
    expect(css).toContain('.tab .tab-label, .tab.diff-tab .tab-badge { display: var(--sb-tab-label-display, block); }');
    // The Changes tab is never hidden; a file tab keeps its icon and close mark whole.
    expect(narrow).not.toMatch(/\.changes-tab(?![^{]*\.tab-label)[^{]*\{[^}]*display: none/);
    // The chosen file tab stays in its place in the strip's order, with no border or push of its own.
    expect(narrow).toBe('  .tab.diff-tab:not(.selected) { display: none; }');
    // Conversation, Status, Console and Browser are never hidden.
    expect(narrow).not.toMatch(/\.tab(\[data-tab|\.selected|:not\(\.diff-tab)[^{]*\{[^}]*display: none/);
    expect(css).toMatch(/@container \(max-width: 360px\) \{\n  \.tab, \.artifact-more \{ --sb-tab-pad: 9px; \}/);
    // An icon tab is 44 px wide, by its padding rather than a minimum width of its own.
    expect(css).not.toMatch(/@container[^{]*\{[^@]*--sb-tab-pad: (?!9px)/);
  });

  it('ChangesBar_OnATouchScreenUnder480px_PutsTheNoteOnARowOfItsOwn', () => {
    const changes = PAGE_ASSETS['page.css']!.body;

    expect(changes).toMatch(/\.changes-bar \{[^}]*display: flex; flex-wrap: wrap;/);
    expect(changes).toContain('@media (hover: none), (pointer: coarse) { @container (max-width: 479px) { .changes-scope { flex: 1 1 0; max-width: none; } .changes-note { order: 1; box-sizing: border-box; flex-basis: calc(100% - 51px);');
    // Wrap ends the note's row, so the scope above keeps its room.
    expect(changes).toContain('.changes-bar button[data-action="changes-wrap"] { order: 1; } } }');
  });

  it('MaximizeButton_FocusedOrPressed_KeepsTheStripBackgroundNotTheChosenTabs', () => {
    expect(css).toContain('.tab.panel-max, .tab.panel-max:hover, .tab.panel-max:focus, .tab.panel-max:active { background: var(--sb-tab-strip); }');
    expect(css).toContain('@media (hover: hover) { .tab.panel-max:hover { background: var(--vscode-toolbar-hoverBackground); } }');
    // The keyboard's focus shows as the outline every tab has.
    expect(css).toContain('.tab:focus-visible { outline: 1px solid var(--vscode-focusBorder);');
  });

  it('lines up the Artifacts menu kinds in a column, cutting the title first, and leaves the kind out on a viewport under 520 px', () => {
    expect(css).toContain('.artifact-menu { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto;');
    expect(css).toContain('.artifact-menu .menu-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid;');
    expect(css).toContain('@media (max-width: 519.98px) { .artifact-menu .menu-kind { display: none; } }');
    // A long front matter kind is cut rather than crowd the title out.
    expect(css).toContain('.artifact-menu .menu-kind { max-width: 14ch; overflow: hidden; text-overflow: ellipsis;');
    // Wider strips keep the kind: no other rule hides it.
    expect(css.match(/\.menu-kind[^{]*\{[^}]*display: none/g)).toHaveLength(1);
  });

  it('names the Artifacts button and the Changes tab with their counts, as their labels may be hidden', () => {
    const state = { ...EMPTY, artifacts: eight };

    expect(html(renderTabs(newView(), state, false, { open: null, fit: 1, menu: false, now: 0 }))).toContain('aria-label="Artifacts, 8"');
    expect(html(renderTabs(newView(), state, false, { open: null, fit: 1, menu: false, now: 0 }))).not.toContain('unread-dot');
    expect(html(changesTab(newChanges(), false))).toContain('aria-label="Changes"');
    expect(html(changesTab({ ...newChanges(), list: { total: 3, rows: [{ viewed: true }] } as never }, true))).toContain('aria-label="Changes, 1 of 3 files viewed"');
  });
});

describe('the Changes tab on a narrow pane', () => {
  it('ViewedTick_InAPaneUnder600px_ShowsItsBoxAlone', () => {
    const changesCss = PAGE_ASSETS['page.css']!.body;

    expect(changesCss).toContain('container-type: inline-size;');
    expect(changesCss).toContain('@container (max-width: 599px) { .diff-viewed-label { display: none; } }');
    expect(changesCss).toMatch(/\.diff-viewed \{ justify-content: center; min-width: 44px; min-height: 44px; \}/);
  });
});
