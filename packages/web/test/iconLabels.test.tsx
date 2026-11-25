import { describe, expect, it } from 'vitest';
import { mount } from '../src/island.js';
import { renderHeader, renderSideSwitch, renderTabs } from '../src/header.js';
import { newChanges } from '../src/changes.js';
import { EMPTY } from '../src/model.js';
import type { PageState } from '../src/model.js';
import { newView, TABS } from '../src/render.js';
import { PAGE_ASSETS } from '../dist/index.js';
import type { ComponentChild } from 'preact';
import type { ArtifactView, SessionView } from '@switchboard/protocol';

const css = PAGE_ASSETS['page.css']!.body;
const artifact = (n: number): ArtifactView => ({ path: `chat/a${n}.${n % 2 === 0 ? 'md' : 'png'}`, owner: 'o', kind: 'notes', title: `A ${n}`, ext: n % 2 === 0 ? 'md' : 'png', type: n % 2 === 0 ? 'markdown' : 'image', updatedAt: n });
const session: SessionView = { id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null };
const scope = { kind: 'page' as const, key: 'k', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle' as const, conversation: 'full' as const, unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };
const state: PageState = { ...EMPTY, connected: true, scope, session, artifacts: [1, 2, 3, 4].map(artifact), status: { id: 'st', sessionId: 's', at: 1, markdown: 'Done.', fallback: false, unread: true } };
const changes = { ...newChanges(), list: { total: 2, rows: [] } as never };

function draw(tree: ComponentChild): HTMLElement {
  const host = document.createElement('div');

  mount(host, tree);
  return host;
}

/** The selector of page.css's rule that trims a text beside an icon to its cap height (text-box). */
function labelSelector(): string {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, , body]) => body!.includes('text-box: trim-both cap alphabetic;'));

  expect(rule).toBeDefined();
  return rule![1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^.*@supports[^{]*\{/s, '').trim();
}

describe('the tab strips', () => {
  const strips = [
    draw(renderTabs(newView(), state, true, { open: null, fit: 2, menu: false, now: 0, changes }, true, true)),
    draw(renderSideSwitch('status', state, true, { open: 'chat/a2.md', fit: 2, menu: false, now: 0, changes }, true, true)),
  ];

  it('TabStrips_EveryTab_ShowsAnIcon', () => {
    for (const strip of strips) {
      const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"], .artifact-menu-button')];

      expect(tabs.length).toBeGreaterThan(5);
      for (const tab of tabs) {
        expect([tab.getAttribute('aria-label') ?? tab.textContent, (tab.closest('.tab') ?? tab).querySelector('.codicon, .file-icon') !== null]).toEqual([tab.getAttribute('aria-label') ?? tab.textContent, true]);
      }
    }
  });

  it('FixedTabs_Drawn_NameTheirIconAndKeepTheirNameWithoutTheLabel', () => {
    const tabs = [...strips[0]!.querySelectorAll<HTMLElement>('[data-tab]')];

    // In the strip's order (tabs.ts): History before the links, Console last, after Changes.
    expect(tabs.map((tab) => [tab.dataset['tab'], tab.querySelector('.codicon')!.className, tab.querySelector('.tab-label')!.textContent, tab.title])).toEqual([
      ['conversation', 'codicon codicon-comment-discussion', 'Conversation', 'Conversation'],
      ['status', 'codicon codicon-pulse', 'Status', 'Status'],
      ['history', 'codicon codicon-history', 'History', 'History'],
      ['browser', 'codicon codicon-globe', 'Browser', 'Browser'],
      ['console', 'codicon codicon-terminal', 'Console', 'Console'],
    ]);
    // Status's unread dot stays in its name once the label is hidden.
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Conversation', 'Status, unread', 'History', 'Browser', 'Console']);
    expect(strips[0]!.querySelector('.changes-tab ~ [data-tab="console"]')).not.toBeNull();
    // History has a close mark, as a file tab has.
    expect(strips.map((strip) => strip.querySelector('.history-tab [data-action="close-history"]')?.getAttribute('aria-label'))).toEqual(['Close History', 'Close History']);
    expect(TABS.every((one) => one.icon !== '')).toBe(true);
  });

  it('LinkTabs_Drawn_ShowTheBrowserIconBeforeTheirLabel', () => {
    const links = [{ url: 'https://github.com/o/r/issues/1', label: 'Issue 1' }, { url: 'https://example.com/', label: 'example.com' }];

    for (const strip of [
      draw(renderTabs({ ...newView(), tab: 'browser' }, state, true, { links, link: links[0]!.url, open: null, fit: 2, menu: false, now: 0, changes }, true, true)),
      draw(renderSideSwitch('browser', state, true, { links, link: links[0]!.url, open: null, fit: 2, menu: false, now: 0, changes }, true, true)),
    ]) {
      const tabs = [...strip.querySelectorAll<HTMLElement>('.link-tab .tab-open')];

      expect(tabs.map((tab) => [tab.querySelector('.codicon')?.className, tab.querySelector('.tab-label')!.textContent])).toEqual([
        ['codicon codicon-globe', 'Issue 1'],
        ['codicon codicon-globe', 'example.com'],
      ]);
      expect(tabs[0]!.querySelector('.tab-label')!.matches(labelSelector())).toBe(true);
    }
  });

  it('ConversationDropdown_EarlierSessions_ShareTheRowEdgeAndTheMenuWidens', () => {
    // An earlier session's row is drawn as its conversation's, with no indent of its own.
    expect(css).not.toMatch(/\.session-row[^{]*\{[^}]*padding-left/);
    // Wider than a menu's 360 px, in px, which placeMenus reads as the most it may take before the viewport's edge.
    expect(css).toContain('.menu.conversation-menu { max-width: 720px; }');
  });

  it('ConversationDropdown_ProviderMark_StandsInOneColumnWithNoBackground', () => {
    // After the state codicon, on the button and every row, an unknown provider's empty mark as wide as a mark.
    expect(css).toContain(':is(.conversation-row, button.picker) > .provider { width: 16px; justify-content: center; }');
    expect(css).toContain(':is(.conversation-row, button.picker) > .provider { order: 1; }');
    expect(css).toContain('button.picker > .codicon-chevron-down { order: 2; }');
    // No rule gives the mark a background of its own.
    expect(css).not.toMatch(/\.provider(?![-\w])[^{,]*\{[^}]*background/);
  });

  it('ConversationDropdown_Icons_CentredInBoxesOnWholePixels', () => {
    // Each icon in a 16 px box that centres its glyph, the codicons at their own 16 px grid; no baseline alignment or offset.
    expect(css).toContain(':is(.conversation-menu .menu-row, button.picker) > :is(.codicon, .provider), .conversation-menu .menu-gutter > .codicon { display: flex; flex: none; align-items: center; justify-content: center; height: 16px; line-height: 1; }');
    expect(css).toContain(':is(.conversation-menu .menu-row, button.picker) > .codicon { font-size: 16px; }');
    expect(css).not.toMatch(/conversation-(?:menu|row)[^{]*\{[^}]*(?:vertical-align|margin-top|top:)/);
    // The rows and the button centre their items; no rule aligns them otherwise.
    expect(css).toMatch(/\n\.menu-row \{[^}]*align-items: center;/);
    expect(css).toMatch(/\nbutton\.picker \{[^}]*align-items: center;/);
    expect(css).not.toMatch(/(?:\.menu-row|\.conversation-row|\.conversation-menu|button\.picker)[^{,]*\{[^}]*align-(?:items|self): (?!center)/);
    // The button is a whole number of pixels tall, so the menu under it, and its rows, start on a whole pixel.
    expect(css).toMatch(/\nbutton\.picker \{[^}]*min-height: 32px; box-sizing: border-box;/);
  });

  it('TabStrip_EveryTabButTheChosen_DrawsTheBottomBorder', () => {
    const tab = /\n\.tab \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const chosen = /\n\.tab\.selected \{([^}]*)\}/.exec(css)?.[1] ?? '';

    // Over the strip's own border, which the tabs overlap by their -1px bottom margin, so the line runs under them too.
    expect(tab).toContain('margin-bottom: -1px;');
    expect(tab).toContain('border-bottom: 1px solid var(--vscode-panel-border);');
    expect(chosen).toContain('border-bottom-color: var(--sb-tab-surface);');
  });

  it('TabStrip_EveryTab_GrowsEvenlyToItsContentWithNoMinimumOfItsOwn', () => {
    // One rule for every tab and the Artifacts button's cell: grown evenly from nothing, never past the tab's own content, never held wider.
    expect(css).toContain('.tab, .artifact-more { --sb-tab-pad: 14px; flex: 1 1 0; min-width: 0; max-width: max-content; }');
    expect(css).toMatch(/\n\.tab \{[^}]*overflow: hidden;[^}]*padding: 0 var\(--sb-tab-pad\);/);
    // A label is cut with an ellipsis, at most as wide as the artifact tab's cap.
    expect(css).toContain('.tab .tab-label { min-width: 0; max-width: var(--sb-tab-label-max); overflow: hidden; text-overflow: ellipsis; }');
    // Link tabs are the strip's own tabs, not a scroller of fixed-width tabs that crowds the rest.
    expect(css).not.toContain('.link-tabs');
    expect(css).not.toMatch(/\.link-tab[^{]*\{[^}]*width:/);
    // No tab has a width, a minimum or a maximum of its own, but the maximize button, which is no tab, and Artifacts inside its cell.
    const own = [...css.matchAll(/(?:^|\n|\})\s*([^{}@]*\.(?:tab|artifact-tab|link-tab|history-tab|diff-tab|changes-tab|artifact-menu-button)\b[^{}@]*)\{([^}]*)\}/g)]
      .filter(([, selector, body]) => !/panel-max|tab-(?:label|open|close|badge)|\.tabs\b|artifact-menu\b|\.codicon/.test(selector!) && /(?:^|[ ;])(?:min-|max-)?width:|flex:/.test(body!))
      .map(([, selector]) => selector!.trim());

    expect(own).toEqual(['.tab, .artifact-more', '.artifact-more > .tab']);
  });

  it('NarrowStrip_Under600px_ShowsTheFixedTabsAsTheirIcons', () => {
    // One switch for every tab: their labels, the fixed tabs', the link, History, artifact and file tabs' and Artifacts' alike, and every close mark
    // but the chosen tab's.
    expect(css).toContain('@container (max-width: 600px) { .tabs > * { --sb-tab-icons: 1; --sb-tab-label-display: none; --sb-tab-justify: center; --sb-tab-close-other: none; } }');
    expect(css).toContain('.tab .tab-label, .tab.diff-tab .tab-badge { display: var(--sb-tab-label-display, block); }');
    expect(css).toContain('.tab:not(.selected) > .tab-close { display: var(--sb-tab-close-other, flex); }');
    expect(css).not.toContain('@container (max-width: 760px)');
    // No rule hides a tab's icon.
    expect(css).not.toMatch(/\.tab[^{]*codicon(?!-chevron-down)[^{]*\{[^}]*display: (?:none|var)/);
  });

  it('TabStrip_TooNarrowForFiveCharactersALabel_ShowsEveryTabAsItsIcon', () => {
    // 116 px a tab (--sb-tab-least) keeps a cut label at five characters and the ellipsis, even beside a close mark; a strip narrower than that
    // for each of its tabs, the maximize button among them, shows them all as icons, and one with 17 or more always does.
    expect(css).toContain('.tabs { --sb-tab-label-max: 100px; --sb-tab-least: 116px; }');
    const counted = ':is(.tab, .artifact-more)';

    for (let n = 6; n <= 16; n++) {
      expect(css).toContain(`@container (width < ${n * 116}px) { .tabs:has(> :nth-child(${n} of ${counted})) > * { --sb-tab-icons: 1; --sb-tab-label-display: none; --sb-tab-justify: center; --sb-tab-close-other: none; } }`);
    }
    expect(css).toContain(`.tabs:has(> :nth-child(17 of ${counted})) > * { --sb-tab-icons: 1; --sb-tab-label-display: none; --sb-tab-justify: center; --sb-tab-close-other: none; }`);
    // Five tabs or fewer need no more than 580 px, which the 600 px rule already covers.
    expect(5 * 116).toBeLessThan(600);
  });

  it('LinkTabs_InTheStrip_AreItsOwnChildrenSoTheyAreCounted', () => {
    const strip = draw(renderTabs({ ...newView(), tab: 'browser' }, state, true, { open: null, fit: 0, menu: false, now: 0, links: [{ url: 'https://github.com/o/r/issues/1', label: 'Ticket' }, { url: 'https://github.com/o/r/pull/2', label: 'PR #2' }], link: 'https://github.com/o/r/pull/2' }));

    expect([...strip.querySelectorAll(':scope .tabs > .link-tab')].map((tab) => tab.textContent)).toEqual(['Ticket', 'PR #2']);
  });
});

describe('the label beside an icon', () => {
  it('IconRows_EveryTextBesideAnIcon_IsTrimmedToItsCapHeight', () => {
    const selector = labelSelector();
    const hosts = [
      draw(renderTabs(newView(), state, true, { open: null, fit: 2, menu: true, now: 0, changes }, true)),
      draw(renderHeader(state, { ...newView(), picker: true })),
      draw(renderHeader(state, { ...newView(), viewMenu: true })),
    ];
    const rows = hosts.flatMap((host) => [...host.querySelectorAll<HTMLElement>('.menu-row, .tab, .tab-open, button.picker')].filter((row) => row.querySelector(':scope > .codicon, :scope > .file-icon, :scope > .menu-gutter')));
    const texts = rows.flatMap((row) => [...row.children].filter((child) => !child.matches('.codicon, .file-icon, .menu-gutter, .unread-dot, .tab-badge, .count, .tab-open, .tab-close, .provider, svg') && (child.textContent ?? '').trim() !== ''));

    expect(rows.length).toBeGreaterThan(10);
    expect(texts.length).toBeGreaterThan(10);
    expect(texts.filter((text) => !text.matches(selector)).map((text) => text.outerHTML)).toEqual([]);
    // A badge keeps its own box, and an icon is never trimmed.
    expect(hosts[0]!.querySelector('.tab-badge')!.matches(selector)).toBe(false);
    expect(hosts[0]!.querySelector('.tab .codicon')!.matches(selector)).toBe(false);
  });

  it('LabelRule_Declared_PadsEquallySoTheLabelStaysCentredAndUnclipped', () => {
    expect(css).toMatch(/@supports \(text-box: trim-both cap alphabetic\) \{ [^{}]+\{ text-box: trim-both cap alphabetic; padding-block: calc\(\(1lh - 1cap\) \/ 2\); \} \}/);
    // No rule zeroes a menu title's padding, which would clip its descenders.
    expect(css).not.toMatch(/\.menu-row \.title \{[^}]*padding: 0;/);
  });
});

describe("Claude's provider mark", () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => selector!.includes('[aria-label="Claude"]')).map(([, selector, body]) => [selector!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^.*@media[^{]*\{/s, '').trim(), body!.trim()]);

  it('ClaudeMark_AnyContext_HasNoBackgroundAndTakesTheTextColourWhereOrangeLacksContrast', () => {
    expect(rules).toEqual([
      [':is(.provider, .provider-option-mark)[aria-label="Claude"]', 'color: #D97757;'],
      [':is(.menu-row:hover, .menu-row:focus, [aria-pressed="true"]) :is(.provider, .provider-option-mark)[aria-label="Claude"]', 'color: inherit;'],
      [':is(.provider, .provider-option-mark)[aria-label="Claude"]', 'color: inherit;'],
    ]);
    expect(css).toMatch(/@media \(prefers-color-scheme: light\) \{ :is\(\.provider, \.provider-option-mark\)\[aria-label="Claude"\] \{ color: inherit; \} \}/);
  });
});
