import { describe, expect, it } from 'vitest';
import { renderSideSwitch, renderTabs } from '../src/header.js';
import { ARTIFACT_MENU_WIDTH, ARTIFACT_TAB_WIDTH, ARTIFACT_TABS_MAX, artifactBar, artifactTabsFit, closedArtifacts, newView } from '../src/render.js';
import { EMPTY } from '../src/model.js';
import type { ArtifactView } from '@switchboard/protocol';
import { html } from './html.js';
import { changesButton, newChanges } from '../src/changes.js';
import { PAGE_ASSETS } from '../dist/index.js';

const artifact = (index: number): ArtifactView => ({ path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 1_000 + index });
const eight = [0, 1, 2, 3, 4, 5, 6, 7].map(artifact);
const paths = (markup: string, attribute: string) => [...markup.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map((match) => match[1]);
/** The artifact tabs' paths, from each tab's cell. */
const tabPaths = (markup: string) => [...markup.matchAll(/role="presentation" data-action="artifact" data-path="([^"]+)"/g)].map((match) => match[1]);

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

describe('the artifact tabs', () => {
  const state = { ...EMPTY, connected: true, artifacts: eight };

  it('follow Status, Console and Browser in the column, the open one chosen with a close mark, then Artifacts with the rest', () => {
    const markup = html(renderSideSwitch('artifacts', state, true, { open: 'chat/a2.md', fit: 3, menu: false, now: 2_000 }));

    expect(paths(markup, 'data-side')).toEqual(['status', 'console', 'browser']);
    expect(tabPaths(markup)).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a2.md']);
    expect(markup).toMatch(/class="tab artifact-tab selected"[^>]*data-path="chat\/a2.md"/);
    // The close mark is a button of its own beside the tab's, so each takes the keyboard.
    // Each artifact tab has its own close button beside the tab's, so each takes the keyboard; the open one's is in the tab order.
    expect(markup.match(/<button class="tab-close" type="button" data-action="close-artifact"/g)).toHaveLength(3);
    expect(markup).toContain('data-path="chat/a2.md" aria-label="Close Note 2" title="Close" tabindex="0"');
    expect(markup.match(/role="tab"/g)).toHaveLength(6);
    expect(markup).toContain('+5');
    expect(markup).not.toContain('artifact-menu" role="menu"');
  });

  it('choose none while another tab shows, and list every artifact in the open menu, those with a tab dimmed', () => {
    const markup = html(renderSideSwitch('status', state, false, { open: 'chat/a2.md', fit: 2, menu: true, now: 2_000 }));

    expect(markup).not.toContain('artifact-tab selected');
    expect(markup).not.toContain('title="Close" tabindex="0"');
    expect(paths(markup.slice(markup.indexOf('artifact-menu" role="menu"')), 'data-path')).toEqual(eight.map((one) => one.path).reverse());
    expect(markup.match(/menu-row in-bar/g)).toHaveLength(2);
  });

  it('leave out the closed artifacts but the open one, which the menu marks closed', () => {
    const closed = new Set(['chat/a7.md', 'chat/a5.md']);
    const markup = html(renderSideSwitch('artifacts', state, false, { open: 'chat/a5.md', fit: 3, menu: true, now: 2_000, closed }));

    expect(tabPaths(markup)).toEqual(['chat/a6.md', 'chat/a4.md', 'chat/a5.md']);
    expect(markup.match(/menu-row[^"]*closed/g)).toHaveLength(2);
    expect(markup).toContain('Closed · ');
  });

  it('show no menu when every artifact has a tab, and none at all without artifacts', () => {
    expect(html(renderSideSwitch('status', { ...state, artifacts: eight.slice(0, 2) }, false, { open: null, fit: 5, menu: false, now: 0 }))).not.toContain('artifact-menu-button');
    expect(html(renderSideSwitch('status', EMPTY))).not.toContain('artifact-tab');
  });

  it('end the conversation tab strip on a narrower screen the same way', () => {
    const markup = html(renderTabs({ ...newView(), tab: 'artifacts' }, state, false, { open: 'chat/a7.md', fit: 1, menu: false, now: 0 }));

    expect(paths(markup, 'data-tab')).toEqual(['conversation', 'status', 'console']);
    expect(tabPaths(markup)).toEqual(['chat/a7.md']);
    expect(markup).toContain('+7');
  });
});

describe('the tab strip on a narrow screen', () => {
  const css = PAGE_ASSETS['page.css']!.body;
  const narrow = /@container \(max-width: 600px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

  it('never wraps, and under 600 px shows Artifacts and Changes as their icons and counts, with the shown diff tab only', () => {
    // A size container is a stacking context: the strip stands above the pane after it, so the Artifacts menu inside it does too.
    expect(css).toMatch(/\.tabs \{ position: relative; z-index: 3; display: flex; flex-wrap: nowrap; container-type: inline-size;/);
    expect(narrow).toContain('.tab.artifact-menu-button .tab-label, .tab.artifact-menu-button .codicon-chevron-down, .tab.changes-button .tab-label, .tab.changes-button .codicon-chevron-down { display: none; }');
    expect(narrow).toContain('.tab.diff-tab:not(.selected) { display: none; }');
    // Conversation, Status, Console and Browser are never hidden.
    expect(narrow).not.toMatch(/\.tab(\[data-tab|\.selected|:not\(\.diff-tab)[^{]*\{[^}]*display: none/);
    expect(css).toMatch(/@container \(max-width: 360px\) \{\n  \.tab \{ padding: 0 9px; \}/);
    expect(css).toMatch(/@media \(hover: none\), \(pointer: coarse\) \{ \.tab\.artifact-menu-button, \.tab\.changes-button \{ min-width: 44px;/);
  });

  it('names the Artifacts and Changes buttons with their counts, as their labels may be hidden', () => {
    const state = { ...EMPTY, artifacts: eight };

    expect(html(renderTabs(newView(), state, false, { open: null, fit: 1, menu: false, now: 0 }))).toContain('aria-label="Artifacts, 7 more"');
    expect(html(changesButton(newChanges()))).toContain('aria-label="Changes"');
    expect(html(changesButton({ ...newChanges(), list: { total: 3, rows: [] } as never }))).toContain('aria-label="Changes, 3 files"');
  });
});
