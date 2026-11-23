import { describe, expect, it } from 'vitest';
import { mount } from '../src/island.js';
import { renderHeader, renderSideSwitch, renderTabs } from '../src/header.js';
import { changesTab, newChanges } from '../src/changes.js';
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
const changes = changesTab({ ...newChanges(), list: { total: 2, rows: [] } as never }, false);

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
    draw(renderTabs(newView(), state, true, { open: null, fit: 2, menu: false, now: 0 }, changes, true, true)),
    draw(renderSideSwitch('status', state, true, { open: 'chat/a2.md', fit: 2, menu: false, now: 0 }, changes, true, true)),
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

    expect(tabs.map((tab) => [tab.dataset['tab'], tab.querySelector('.codicon')!.className, tab.querySelector('.tab-label')!.textContent, tab.title])).toEqual([
      ['conversation', 'codicon codicon-comment-discussion', 'Conversation', 'Conversation'],
      ['status', 'codicon codicon-pulse', 'Status', 'Status'],
      ['console', 'codicon codicon-terminal', 'Console', 'Console'],
      ['browser', 'codicon codicon-globe', 'Browser', 'Browser'],
      ['history', 'codicon codicon-history', 'History', 'History'],
    ]);
    // Status's unread dot stays in its name once the label is hidden.
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Conversation', 'Status, unread', 'Console', 'Browser', 'History']);
    expect(TABS.every((one) => one.icon !== '')).toBe(true);
  });

  it('NarrowStrip_Under600px_ShowsTheFixedTabsAsTheirIcons', () => {
    const narrow = /@container \(max-width: 600px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

    expect(narrow).toContain('.tab:is([data-tab], [data-side]) .tab-label { display: none; }');
    // With Browser or History as well, under 760 px.
    const crowded = /@container \(max-width: 760px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

    expect(crowded).toMatch(/:has\(~ :is\(\[data-tab="browser"\], \[data-tab="history"\][^)]*\)\)\) \.tab-label \{ display: none; \}/);
    // No rule hides a tab's icon.
    expect(narrow).not.toMatch(/codicon(?!-chevron-down)[^{]*\{[^}]*display: none/);
  });
});

describe('the label beside an icon', () => {
  it('IconRows_EveryTextBesideAnIcon_IsTrimmedToItsCapHeight', () => {
    const selector = labelSelector();
    const hosts = [
      draw(renderTabs(newView(), state, true, { open: null, fit: 2, menu: true, now: 0 }, changes, true)),
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
