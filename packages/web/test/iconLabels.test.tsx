import { describe, expect, it } from 'vitest';
import { mount } from '../src/island.js';
import { renderHeader, renderSideSwitch, renderTabs } from '../src/header.js';
import { newChanges } from '../src/changes.js';
import { EMPTY, stateIcon } from '../src/model.js';
import type { PageState } from '../src/model.js';
import { newView, TABS } from '../src/render.js';
import { PAGE_ASSETS } from '../dist/index.js';
import type { TabFit } from '../src/tabs.js';
import { frameLink } from '../src/iframeBrowser.js';
import type { ComponentChild } from 'preact';
import type { ArtifactView, SessionView } from '@switchboard/protocol';

const css = PAGE_ASSETS['page.css']!.body;
/** Room for `n` tabs of 100 px beside a 50 px More. */
const room = (n: number): TabFit => ({ width: n * 100 + 50, more: 50, plain: 100, closable: 100, measured: {} });
const artifact = (n: number): ArtifactView => ({ path: `chat/a${n}.${n % 2 === 0 ? 'md' : 'png'}`, owner: 'o', kind: 'notes', title: `A ${n}`, ext: n % 2 === 0 ? 'md' : 'png', type: n % 2 === 0 ? 'markdown' : 'image', updatedAt: n });
const session: SessionView = { id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null };
const scope = { kind: 'page' as const, key: 'k', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle' as const, conversation: 'full' as const, unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };
const state: PageState = { ...EMPTY, connected: true, scope, session, artifacts: [1, 2, 3, 4].map(artifact), state: { id: 'st', sessionId: 's', at: 1, headline: 'Done', body: null, stale: null, unread: true } };
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
    draw(renderTabs(newView(), state, true, { open: null, menu: false, now: 0, changes }, true)),
    draw(renderSideSwitch('history', state, true, { open: 'chat/a2.md', fit: room(7), menu: false, now: 0, changes }, true)),
  ];

  it('TabStrips_EveryTab_ShowsAnIcon', () => {
    // The column's strip has room for all but Console, so More shows there.
    expect(strips[1]!.querySelector('.tab-more-button')).not.toBeNull();
    for (const strip of strips) {
      const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"], .tab-more-button')];

      expect(tabs.length).toBeGreaterThan(5);
      for (const tab of tabs) {
        expect([tab.getAttribute('aria-label') ?? tab.textContent, (tab.closest('.tab') ?? tab).querySelector('.codicon, .file-icon') !== null]).toEqual([tab.getAttribute('aria-label') ?? tab.textContent, true]);
      }
    }
  });

  it('FixedTabs_Drawn_NameTheirIconAndKeepTheirNameWithoutTheLabel', () => {
    const tabs = [...strips[0]!.querySelectorAll<HTMLElement>('[data-tab]')];

    // In the strip's order (tabs.ts): History before the links, Console last, after Changes.
    // Each shows an icon before its label, whichever codicon it is, and is titled by its label.
    expect(tabs.map((tab) => [tab.dataset['tab'], tab.querySelector('.codicon') !== null, tab.querySelector('.tab-label')!.textContent, tab.title])).toEqual([
      ['conversation', true, 'Chat', 'Chat'],
      ['history', true, 'History', 'History'],
      ['browser', true, 'Browser', 'Browser'],
      ['console', true, 'Console', 'Console'],
    ]);
    // History's unread dot stays in its name once the label is hidden.
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Chat', 'History, unread', 'Browser', 'Console']);
    expect(strips[0]!.querySelector('.changes-tab ~ [data-tab="console"]')).not.toBeNull();
    // History has no close mark.
    expect(strips.map((strip) => strip.querySelector('[data-action="close-history"]'))).toEqual([null, null]);
    expect(TABS.every((one) => one.icon !== '')).toBe(true);
  });

  it('LinkTabs_Drawn_ShowAnIconForWhatTheyOpenBeforeALabelNamingTheItem', () => {
    const links = [
      frameLink('https://github.com/o/r/issues/21602', 'gh 21602', { kind: 'github', ticket: 'gh 21602' }),
      frameLink('https://github.com/o/r/pull/22234', 'PR #22234'),
      frameLink('https://desk.zoho.com/agent/ticket/4521', 'zoho 4521', { kind: 'zoho', ticket: 'zoho 4521' }),
      frameLink('https://forum.example.com/t/9', 'plug 9', { kind: 'plug', ticket: 'plug 9' }),
      frameLink('https://example.com/', 'Docs'),
    ];

    for (const strip of [
      draw(renderTabs({ ...newView(), tab: 'browser' }, state, true, { links, link: links[0]!.url, open: null, menu: false, now: 0, changes }, true)),
      draw(renderSideSwitch('browser', state, true, { links, link: links[0]!.url, open: null, menu: false, now: 0, changes }, true)),
    ]) {
      const tabs = [...strip.querySelectorAll<HTMLElement>('.link-tab .tab-open')];

      // A source without a logo of its own in the list, as a plugin's, shows the globe.
      expect(tabs.map((tab) => [tab.querySelector('.codicon, .source-logo')?.getAttribute('class'), tab.querySelector('.tab-label')!.textContent])).toEqual([
        ['codicon codicon-github link-icon issue', '#21602'],
        ['codicon codicon-git-pull-request link-icon pr', '#22234'],
        ['source-logo zoho link-icon', '4521'],
        ['codicon codicon-globe', '9'],
        ['codicon codicon-globe', 'Docs'],
      ]);
      expect(tabs.map((tab) => tab.title)).toEqual(['gh 21602', 'PR #22234', 'zoho 4521', 'plug 9', 'Docs'].map((name, index) => `${name} · ${links[index]!.url}`));
      expect(tabs[0]!.querySelector('.tab-label')!.matches(labelSelector())).toBe(true);
    }
    // In the colours of the list's issue and pull request pills.
    expect(css).toContain('.link-icon.issue { color: var(--sb-github); }');
    expect(css).toContain('.link-icon.pr { color: var(--sb-pull-request); }');
    expect(css).toContain('.row-line .pill.link.pr { border-color: var(--sb-pull-request);');
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

  it('TabStrip_EveryTab_GrowsEvenlyToItsContentAndNeverBelowItsLeastWidth', () => {
    // One rule for every tab: grown evenly from nothing, never past the tab's own content, never below its least width: its padding, 16 px icon,
    // 6 px gap, 1 px border and a 44 px label, with its close mark's room.
    expect(css).toContain('\n.tab { --sb-tab-pad: 14px; --sb-tab-close-room: 32px; box-sizing: border-box; flex: 1 1 0; min-width: calc(2 * var(--sb-tab-pad) + 23px + var(--sb-tab-label-least)); max-width: max-content; position: relative;');
    expect(css).toContain('.tab:has(> .tab-close) { min-width: calc(var(--sb-tab-pad) + 23px + var(--sb-tab-label-least) + var(--sb-tab-close-room)); }');
    expect(css).toMatch(/\n\.tab \{[^}]*overflow: hidden;[^}]*padding: 0 var\(--sb-tab-pad\);/);
    // A label is cut with an ellipsis, between about five characters and the most a label takes.
    expect(css).toContain('.tabs { --sb-tab-label-max: 100px; --sb-tab-label-least: 44px; }');
    expect(css).toContain('.tab .tab-label { min-width: var(--sb-tab-label-least); max-width: var(--sb-tab-label-max); overflow: hidden; text-overflow: ellipsis; }');
    // Link tabs are the strip's own tabs, not a scroller of fixed-width tabs that crowds the rest.
    expect(css).not.toContain('.link-tabs');
    expect(css).not.toMatch(/\.link-tab[^{]*\{[^}]*width:/);
    // No tab has a width of its own but its least width, by what it holds; the maximize button and More are no tabs.
    const own = [...css.matchAll(/(?:^|\n|\})\s*([^{}@]*\.(?:tab|artifact-tab|link-tab|history-tab|diff-tab|changes-tab)\b[^{}@]*)\{([^}]*)\}/g)]
      .filter(([, selector, body]) => !/panel-max|tab-(?:label|open|close|badge|more)|\.tabs\b|tab-menu\b|\.codicon/.test(selector!) && /(?:^|[ ;])(?:min-|max-)?width:|flex:/.test(body!))
      .map(([, selector]) => selector!.trim());

    // (The close-mark rule above is left out by its .tab-close.)
    expect(own).toEqual(['.tab']);
  });

  it('NarrowStrip_AnyWidth_KeepsEveryLabelAndIcon', () => {
    // The icon-only rules are gone: no rule hides a tab's label or icon, at any width.
    expect(css).not.toContain('--sb-tab-label-display');
    expect(css).not.toContain('--sb-tab-icons');
    expect(css).not.toMatch(/\.tab[^{]*\.tab-label[^{]*\{[^}]*display: none/);
    expect(css).not.toMatch(/\.tab[^{]*codicon(?!-chevron-down)[^{]*\{[^}]*display: (?:none|var)/);
  });

  it('CloseMark_OnATouchScreen_IsA44pxTargetCountedInTheTabsLeastWidth', () => {
    expect(css).toContain('@media (hover: none), (pointer: coarse) {\n  .tab { --sb-tab-close-room: 50px; }\n  .tab-close { width: 44px; height: 44px; margin-right: calc(-1 * var(--sb-tab-pad)); border-radius: 0; }\n}');
  });

  it('LinkTabs_InTheStrip_AreItsOwnChildrenSoTheyAreCounted', () => {
    const strip = draw(renderTabs({ ...newView(), tab: 'browser' }, state, true, { open: null, menu: false, now: 0, links: [frameLink('https://github.com/o/r/issues/1', 'Ticket'), frameLink('https://github.com/o/r/pull/2', 'PR #2')], link: 'https://github.com/o/r/pull/2' }));

    expect([...strip.querySelectorAll(':scope .tabs > .link-tab')].map((tab) => tab.textContent)).toEqual(['#1', '#2']);
  });
});

describe('the label beside an icon', () => {
  it('IconRows_EveryTextBesideAnIcon_IsTrimmedToItsCapHeight', () => {
    const selector = labelSelector();
    const hosts = [
      draw(renderTabs(newView(), state, true, { open: null, fit: room(3), menu: true, now: 0, changes }, true)),
      draw(renderHeader(state, { ...newView(), picker: true })),
      draw(renderHeader(state, { ...newView(), actions: true })),
    ];
    const rows = hosts.flatMap((host) => [...host.querySelectorAll<HTMLElement>('.menu-row, .tab, .tab-open, button.picker')].filter((row) => row.querySelector(':scope > .codicon, :scope > .file-icon, :scope > .menu-gutter')));
    // The picker's title and session name stand in one column beside its icons, each a text of its own.
    const texts = rows.flatMap((row) => [...row.children].flatMap((child) => (child.matches('.picker-text') ? [...child.children] : [child])).filter((child) => !child.matches('.codicon, .file-icon, .menu-gutter, .unread-dot, .count, .tab-open, .tab-close, .provider, svg') && (child.textContent ?? '').trim() !== ''));

    expect(rows.length).toBeGreaterThan(10);
    expect(texts.length).toBeGreaterThan(10);
    expect(texts.filter((text) => !text.matches(selector)).map((text) => text.outerHTML)).toEqual([]);
    // An icon is never trimmed.
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

  it('ClaudeMark_AnyContext_HasNoBackgroundStaysOrangeInBothSchemesAndTakesTheTextColourOnlyOnAPressedButton', () => {
    expect(rules).toEqual([
      [':is(.provider, .provider-option-mark)[aria-label="Claude"]', 'color: #D97757;'],
      ['[aria-pressed="true"] :is(.provider, .provider-option-mark)[aria-label="Claude"]', 'color: inherit;'],
      [':is(.provider, .provider-option-mark)[aria-label="Claude"]', 'color: #C96442;'],
    ]);
    // Light's darker orange is in the light scheme only; the pressed rule's attribute outranks it there.
    expect(css).toMatch(/@media \(prefers-color-scheme: light\) \{ :is\(\.provider, \.provider-option-mark\)\[aria-label="Claude"\] \{ color: #C96442; \} \}/);
  });

  it('ClaudeMark_HoveredOrFocusedMenuRow_KeepsItsColour', () => {
    // No rule recolours a provider's mark on a hovered or focused row, so it stays orange in the dark theme, as Codex's mark keeps its colour.
    const markRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector]) => selector!.replace(/\/\*[\s\S]*?\*\//g, '').trim()).filter((selector) => /\.provider/.test(selector));
    expect(markRules.length).toBeGreaterThan(3);
    expect(markRules.filter((selector) => /:hover|:focus/.test(selector) && /\.provider(-option-mark)?\b/.test(selector.split(/[ >+~]/).pop() ?? ''))).toEqual([]);
  });
});

describe('a session waiting at a limit', () => {
  it('reads Usage limit for a quota and Rate limited for a provider throttle', () => {
    const until = Date.now() + 3_600_000;

    expect(stateIcon('idle', null, { until, retry: false }).text).toMatch(/^Usage limit · resumes /);
    expect(stateIcon('idle', null, { until, retry: true, throttle: true }).text).toMatch(/^Rate limited · retries /);
  });
});
