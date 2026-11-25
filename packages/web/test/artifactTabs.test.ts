import { describe, expect, it } from 'vitest';
import { renderSideSwitch, renderTabs } from '../src/header.js';
import { artifactUrl, closedArtifacts, newView, openArtifactsSeen, parseArtifactsSeen, unreadArtifacts } from '../src/render.js';
import type { TabFit } from '../src/tabs.js';
import { EMPTY } from '../src/model.js';
import type { ArtifactView } from '@switchboard/protocol';
import { html } from './html.js';
import { changesTab, newChanges } from '../src/changes.js';
import { PAGE_ASSETS } from '../dist/index.js';

const artifact = (index: number): ArtifactView => ({ path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 1_000 + index });
const eight = [0, 1, 2, 3, 4, 5, 6, 7].map(artifact);
const paths = (markup: string, attribute: string) => [...markup.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map((match) => match[1]);
/** Room for `n` tabs of 100 px beside a 50 px More. */
const room = (n: number): TabFit => ({ width: n * 100 + 50, more: 50, plain: 100, closable: 100, measured: {} });
/** The artifact tabs' paths, from each tab's cell. */
const tabPaths = (markup: string) => [...markup.matchAll(/role="presentation" data-action="artifact" data-path="([^"]+)"/g)].map((match) => match[1]);

describe('closedArtifacts', () => {
  it('counts an artifact closed at its version, and open again once a newer version comes', () => {
    expect([...closedArtifacts(eight, [{ path: 'chat/a1.md', updatedAt: 1_001 }, { path: 'chat/a2.md', updatedAt: 900 }, { path: 'chat/gone.md', updatedAt: 1 }])]).toEqual(['chat/a1.md']);
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
  const parse = (markup: string): Document => new DOMParser().parseFromString(markup, 'text/html');

  it('follow Status and Browser in the column, the open one chosen with a close mark, and More with the rest, Console among them', () => {
    // Room for four: the open one, Status, then Browser and the newest artifact in strip order.
    const markup = html(renderSideSwitch('artifacts', state, true, { open: 'chat/a2.md', fit: room(4), menu: false, now: 2_000 }));

    expect(paths(markup, 'data-side')).toEqual(['status', 'browser']);
    expect(tabPaths(markup)).toEqual(['chat/a7.md', 'chat/a2.md']);
    expect(markup).toMatch(/class="tab artifact-tab selected"[^>]*data-path="chat\/a2.md"/);
    // Each artifact tab has its own close button beside the tab's, so each takes the keyboard; the open one's is in the tab order.
    expect(markup.match(/<button class="tab-close" type="button" data-action="close-artifact"/g)).toHaveLength(2);
    expect(markup).toContain('data-path="chat/a2.md" aria-label="Close Note 2" title="Close" tabindex="0"');
    expect(markup.match(/role="tab"/g)).toHaveLength(4);
    // More counts the tabs it holds: the six other artifacts and Console.
    expect(parse(markup).querySelector('.tab-more-button .tab-badge')!.textContent).toBe('7');
    expect(parse(markup).querySelector('.tab-more-button')!.getAttribute('aria-label')).toBe('More tabs, 7');
    expect(markup).not.toContain('tab-menu" role="menu"');
  });

  it('list in the open More menu every tab the strip does not show, in strip order, Console too', () => {
    const menu = parse(html(renderSideSwitch('status', state, false, { open: 'chat/a2.md', fit: room(3), menu: true, now: 2_000 }))).querySelector('.tab-menu')!;

    expect([...menu.querySelectorAll<HTMLElement>('.menu-row')].map((row) => row.dataset['path'] ?? row.dataset['side'])).toEqual(['chat/a5.md', 'chat/a4.md', 'chat/a3.md', 'chat/a2.md', 'chat/a1.md', 'chat/a0.md', 'console']);
    // Console's row is drawn as its tab, by its icon and label, and chooses it as the tab does.
    expect(menu.querySelector('[data-side="console"] .codicon-terminal')).not.toBeNull();
    expect(menu.querySelector('[data-side="console"]')!.getAttribute('aria-label')).toBe('Console');
    expect(menu.querySelector('.menu-separator')).toBeNull();
  });

  it("show each artifact's title, kind and age in the menu, and its title and kind in its tab's tooltip", () => {
    const kinds = [{ ...artifact(1), kind: 'plan', title: 'Rollout plan' }, { ...artifact(2), kind: 'report', title: 'Load test' }, ...eight.slice(3)];
    const markup = html(renderSideSwitch('status', { ...state, artifacts: kinds }, false, { open: null, fit: room(2), menu: true, now: 1_001 + 3 * 60_000 }));
    const menu = parse(markup).querySelector('.tab-menu')!;
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
    const markup = html(renderSideSwitch('status', { ...state, artifacts: [outside, ...eight] }, false, { open: null, fit: room(2), menu: true, now: 2_000 }));
    const menu = parse(markup).querySelector('.tab-menu')!;

    expect(tabPaths(markup)).toEqual(['@3/summary.md']);
    expect(menu.querySelector('[data-path="chat/a7.md"]')!.getAttribute('title')).toBe('chat/a7.md');
    expect(artifactUrl('k', outside.path)).toBe('/v1/conversation/artifact/k/%403/summary.md');
    // In More, its row's tooltip is its real path.
    const hidden = parse(html(renderSideSwitch('status', { ...state, artifacts: [...eight, { ...outside, updatedAt: 0 }] }, false, { open: null, fit: room(2), menu: true, now: 2_000 }))).querySelector('.tab-menu')!;

    expect(hidden.querySelector('[data-path="@3/summary.md"]')!.getAttribute('title')).toBe('D:/git/research/topic/summary.md');
  });

  it('leave out the closed artifacts but the open one, and list them after the hidden tabs, newest first', () => {
    const closed = new Set(['chat/a7.md', 'chat/a5.md', 'chat/a3.md']);
    const markup = html(renderSideSwitch('artifacts', state, false, { open: 'chat/a5.md', fit: room(4), menu: true, now: 2_000, closed }));
    const menu = parse(markup).querySelector('.tab-menu')!;

    // The open one keeps its tab; the tabs stay newest first.
    expect(tabPaths(markup)).toEqual(['chat/a6.md', 'chat/a5.md', 'chat/a4.md']);
    expect([...menu.children].map((row) => (row as HTMLElement).dataset['path'] ?? (row as HTMLElement).dataset['side'] ?? row.className)).toEqual(['chat/a2.md', 'chat/a1.md', 'chat/a0.md', 'console', 'menu-separator', 'chat/a7.md', 'chat/a3.md']);
    expect(menu.querySelector('[data-path="chat/a7.md"] .menu-note')!.textContent).toBe('just now');
    // With every tab in the strip, More stays for the closed ones, with no separator.
    const all = parse(html(renderSideSwitch('status', { ...state, artifacts: eight.slice(6) }, false, { open: null, menu: true, now: 2_000, closed })));

    expect([...all.querySelectorAll<HTMLElement>('.tab-menu > *')].map((row) => row.dataset['path'])).toEqual(['chat/a7.md']);
    expect(all.querySelector('.tab-more-button .tab-badge')!.textContent).toBe('1');
  });

  it('mark unread rows with the dot after the title, named in the row, and More with the dot while any row is unread', () => {
    const unread = new Set(['chat/a7.md', 'chat/a0.md']);
    const markup = html(renderSideSwitch('status', state, false, { open: null, fit: room(2), menu: true, now: 1_001 + 3 * 60_000, unread }));
    const menu = parse(markup).querySelector('.tab-menu')!;
    const row = menu.querySelector('[data-path="chat/a0.md"]')!;

    // a7 has its tab, so only a0's row in the menu is marked; More holds the six other artifacts and Console.
    expect([...menu.querySelectorAll('.unread-dot')].map((dot) => dot.closest<HTMLElement>('.menu-row')!.dataset['path'])).toEqual(['chat/a0.md']);
    expect([...row.querySelector('.title')!.children].map((cell) => cell.className)).toEqual(['title-text', 'unread-dot']);
    expect(row.getAttribute('aria-label')).toBe('Note 0, unread, note, 3 min ago');
    expect(menu.querySelector('[data-path="chat/a1.md"]')!.getAttribute('aria-label')).toBe('Note 1, note, 3 min ago');
    const strip = parse(markup);

    // On the count's corner, as a notification badge; the button has no caret, its menu named by aria-haspopup and its tooltip.
    expect(strip.querySelectorAll('.tab-more-button .tab-badge > .unread-dot')).toHaveLength(1);
    expect(strip.querySelector('.tab-more-button .codicon-chevron-down')).toBeNull();
    expect(strip.querySelector('.tab-more-button')!.getAttribute('aria-haspopup')).toBe('menu');
    expect(css).toContain('.tab.tab-more-button .tab-badge > .unread-dot { position: absolute; top: -3px; right: -3px;');
    expect(strip.querySelector('.tab-more-button')!.getAttribute('aria-label')).toBe('More tabs, 8, 1 unread');
    // A hidden unread Status marks More too; with nothing unread hidden, no dot.
    const status = parse(html(renderSideSwitch('artifacts', { ...state, status: { id: 's', sessionId: 's', at: 1, markdown: 'x', fallback: false, unread: true } }, false, { open: 'chat/a3.md', fit: { ...room(1), width: 140 }, menu: true, now: 0 })));

    expect(status.querySelector('.tab-menu [data-side="status"]')!.getAttribute('aria-label')).toBe('Status, unread');
    expect(status.querySelector('.tab-more-button .unread-dot')).not.toBeNull();
    expect(parse(html(renderSideSwitch('status', state, false, { open: null, fit: room(2), menu: false, now: 0, unread: new Set(['chat/a7.md']) }))).querySelector('.tab-more-button .unread-dot')).toBeNull();
  });

  it('show no More when every tab fits and none is closed, and no artifact tab without artifacts', () => {
    expect(html(renderSideSwitch('status', { ...state, artifacts: eight.slice(0, 2) }, false, { open: null, fit: room(5), menu: false, now: 0 }))).not.toContain('tab-more');
    // Unmeasured, every tab shows.
    expect(tabPaths(html(renderSideSwitch('status', state, false, { open: null, menu: false, now: 0 })))).toHaveLength(8);
    expect(html(renderSideSwitch('status', EMPTY))).not.toContain('artifact-tab');
  });

  it('end the conversation tab strip on a narrower screen the same way', () => {
    const markup = html(renderTabs({ ...newView(), tab: 'artifacts' }, state, false, { open: 'chat/a7.md', fit: room(3), menu: false, now: 0 }));

    expect(paths(markup, 'data-tab')).toEqual(['conversation', 'status']);
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

  it('never wraps, never hides a tab or its label by its width, and shrinks the padding under 480 px', () => {
    // A size container is a stacking context: the strip stands above the pane after it, so the More menu inside it does too.
    expect(css).toMatch(/\.tabs \{ position: relative; z-index: 3; display: flex; flex-wrap: nowrap; container-type: inline-size;/);
    // No container rule hides a tab, its label or a close mark: tabs that do not fit go into More instead.
    expect(css).not.toMatch(/@container[^{]*\{[^@]*\.tab[^{]*\{[^}]*display: (?:none|var)/);
    expect(css).not.toContain('--sb-tab-label-display');
    expect(css).toMatch(/@container \(max-width: 480px\) \{\n  \.tab \{ --sb-tab-pad: 9px; \}/);
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

  it('lines up the More menu kinds in a column, cutting the title first, and leaves the kind out on a viewport under 520 px', () => {
    expect(css).toContain('.tab-menu { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto;');
    expect(css).toContain('.tab-menu .menu-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid;');
    expect(css).toContain('@media (max-width: 519.98px) { .tab-menu .menu-kind { display: none; } }');
    // A long front matter kind is cut rather than crowd the title out.
    expect(css).toContain('.tab-menu .menu-kind { max-width: 14ch; overflow: hidden; text-overflow: ellipsis;');
    // Wider strips keep the kind: no other rule hides it.
    expect(css.match(/\.menu-kind[^{]*\{[^}]*display: none/g)).toHaveLength(1);
  });

  it('names More and the Changes tab with their counts', () => {
    const state = { ...EMPTY, artifacts: eight };

    expect(html(renderTabs(newView(), state, false, { open: null, fit: room(3), menu: false, now: 0 }))).toContain('aria-label="More tabs, 8"');
    expect(html(renderTabs(newView(), state, false, { open: null, fit: room(3), menu: false, now: 0 }))).not.toContain('unread-dot');
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
