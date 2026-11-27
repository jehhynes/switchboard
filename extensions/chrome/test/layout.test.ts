import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_ATTRIBUTES, LAYOUT_BUTTONS, LAYOUT_KEYS, applyLayout, isConversationPage, pageStorage, placeButtons, readLayout, startLayout, watchLayout } from '../src/layout.js';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', `layout-${name}.html`), 'utf8');
const ISSUE = fixture('issue');
const PULL = fixture('pull');
const COMMITS = fixture('pull-commits');
const CSS = readFileSync(join(import.meta.dirname, '..', 'src', 'content.css'), 'utf8');

const ISSUE_PATH = '/acme/app/issues/101';
const PULL_PATH = '/acme/app/pull/102';
const html = () => document.documentElement;
const group = () => document.querySelector<HTMLElement>(`.${LAYOUT_BUTTONS}`);
const buttonFor = (setting: string) => document.querySelector<HTMLButtonElement>(`[data-switchboard-layout="${setting}"]`)!;

class MemoryStorage {
  items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

/** The selectors of content.css's rules for one layout attribute, without the attribute, so they can run against a fixture. */
function ruleSelectors(attribute: string): string[] {
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => selector!.includes(`[${attribute}]`));

  return rules.flatMap(([, selector]) => {
    const list = selector!.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    // An :is() list is split into its selectors; any other rule is a comma-separated list.
    const inner = /:is\(([\s\S]*)\)\s*$/.exec(list);
    const parts = inner === null ? list.split(/,(?![^(]*\))/) : inner[1]!.split(/,(?![^(]*\))/);

    return parts.map((part) => part.replace(`html[${attribute}]`, '').trim()).filter((part) => part !== '');
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  html().removeAttribute(LAYOUT_ATTRIBUTES.sidebar);
  html().removeAttribute(LAYOUT_ATTRIBUTES.wide);
});

describe('isConversationPage', () => {
  it('matches an issue and every pull request tab', () => {
    expect(isConversationPage(ISSUE_PATH)).toBe(true);
    expect(isConversationPage(PULL_PATH)).toBe(true);
    expect(isConversationPage(`${PULL_PATH}/commits`)).toBe(true);
    expect(isConversationPage(`${PULL_PATH}/changes`)).toBe(true);
  });

  it('refuses lists, projects and other pages', () => {
    expect(isConversationPage('/acme/app/issues')).toBe(false);
    expect(isConversationPage('/acme/app/pulls')).toBe(false);
    expect(isConversationPage('/acme/app/issues/new')).toBe(false);
    expect(isConversationPage('/acme/app/pull/102x')).toBe(false);
    expect(isConversationPage('/orgs/acme/projects/1')).toBe(false);
    expect(isConversationPage('/')).toBe(false);
  });
});

describe('readLayout', () => {
  it('reads off when the storage throws', () => {
    expect(readLayout({ getItem: () => { throw new DOMException('denied', 'SecurityError'); } })).toEqual({ sidebar: false, wide: false });
  });
});

describe('pageStorage', () => {
  it('gives the page\'s localStorage', () => {
    expect(pageStorage(window)).toBe(window.localStorage);
  });

  it('gives one that keeps nothing when reading localStorage throws', () => {
    const blocked = Object.defineProperty({}, 'localStorage', { get: () => { throw new DOMException('denied', 'SecurityError'); } }) as Window;
    const storage = pageStorage(blocked);

    storage.setItem(LAYOUT_KEYS.sidebar, 'true');

    expect(readLayout(storage)).toEqual({ sidebar: false, wide: false });
  });
});

describe('applyLayout', () => {
  it('sets the attribute of each setting that is on, on a conversation page', () => {
    applyLayout(document, ISSUE_PATH, { sidebar: true, wide: false });

    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.sidebar)).toBe(true);
    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.wide)).toBe(false);

    applyLayout(document, ISSUE_PATH, { sidebar: false, wide: true });

    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.sidebar)).toBe(false);
    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.wide)).toBe(true);
  });

  it('removes both on any other page, so a project board keeps its width', () => {
    applyLayout(document, ISSUE_PATH, { sidebar: true, wide: true });
    applyLayout(document, '/orgs/acme/projects/1', { sidebar: true, wide: true });

    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.sidebar)).toBe(false);
    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.wide)).toBe(false);
  });
});

describe('content.css', () => {
  it('hides the issue sidebar and the pull request sidebar, and nothing else', () => {
    const selectors = ruleSelectors(LAYOUT_ATTRIBUTES.sidebar);
    const hidden = (page: string) => {
      document.body.innerHTML = page;
      return selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    };

    expect(hidden(ISSUE).map((element) => element.getAttribute('data-testid'))).toEqual(['issue-viewer-metadata-container']);
    expect(hidden(PULL).map((element) => element.className)).toEqual(['prc-PageLayout-PaneWrapper-pHPop panel__DOwr-P']);
    expect(hidden(COMMITS)).toEqual([]);
  });

  it('lays the buttons out in the flow of their row, never pinned over it', () => {
    const rules = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => selector!.includes(LAYOUT_BUTTONS));

    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter(([, , body]) => /position:\s*(absolute|fixed)/.test(body!))).toEqual([]);
    expect(CSS).not.toMatch(/:has\(>\s*\.switchboard-layout-buttons\)/);
    expect(rules.find(([selector]) => selector!.includes('prc-PageHeader-Navigation-'))?.[2]).toMatch(/float:\s*right/);
  });

  it('lifts each width cap the fixtures record and leaves the sidebar and header alone', () => {
    const selectors = ruleSelectors(LAYOUT_ATTRIBUTES.wide);
    const widened = (page: string) => {
      document.body.innerHTML = page;
      return new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).map((element) => element.className.split(' ')[0]));
    };

    expect(widened(ISSUE)).toEqual(new Set(['contentContainer__6-VbUZ', 'prc-PageLayout-ContentWrapper-gR9eG', 'prc-PageLayout-Content-xWL-A']));
    expect(widened(PULL)).toEqual(new Set(['topBanners__XBQkmL', 'prc-PageHeader-PageHeader-YLwBQ', 'prc-PageLayout-ContentWrapper-gR9eG', 'prc-PageLayout-Content-xWL-A']));
    expect(widened(COMMITS)).toEqual(new Set(['topBanners__XBQkmL', 'prc-PageHeader-PageHeader-YLwBQ', 'prc-PageLayout-ContentWrapper-gR9eG', 'prc-PageLayout-Content-xWL-A', 'layout__KTPKCC']));
  });
});

describe('placeButtons', () => {
  it("puts both buttons in a pull request's tab row", () => {
    document.body.innerHTML = PULL;
    placeButtons(document, PULL_PATH, { sidebar: false, wide: false });

    const buttons = group()!;

    expect(buttons.parentElement?.className).toContain('prc-PageHeader-Navigation-');
    expect(buttons.parentElement?.querySelector('nav')?.getAttribute('aria-label')).toBe('Pull request');
    // First, so it floats right of the row's own right-hand content.
    expect(buttons.parentElement?.firstElementChild).toBe(buttons);
    expect(buttons.nextElementSibling?.className).toContain('rightContentWrapper__');
    expect([...buttons.querySelectorAll('button')].map((button) => [button.getAttribute('aria-label'), button.getAttribute('aria-pressed'), button.title, button.hidden])).toEqual([
      ['Hide sidebar', 'false', 'Hide the sidebar (Switchboard)', false],
      ['Full width', 'false', 'Use the full width (Switchboard)', false],
    ]);
  });

  it('shows each pressed setting and the glyph for undoing it', () => {
    document.body.innerHTML = ISSUE;
    placeButtons(document, ISSUE_PATH, { sidebar: true, wide: true });

    expect(buttonFor('sidebar').getAttribute('aria-pressed')).toBe('true');
    expect(buttonFor('sidebar').title).toBe('Show the sidebar (Switchboard)');
    expect(buttonFor('sidebar').textContent).toBe('\u{ec00}');
    expect(buttonFor('wide').title).toBe('Limit the width (Switchboard)');
    expect(buttonFor('wide').textContent).toBe('\u{eb4d}');
  });

  it('hides the sidebar button on a pull request tab with no sidebar', () => {
    document.body.innerHTML = COMMITS;
    placeButtons(document, `${PULL_PATH}/commits`, { sidebar: true, wide: false });

    expect(buttonFor('sidebar').hidden).toBe(true);
    expect(buttonFor('wide').hidden).toBe(false);
  });

  it("puts them at the end of the row of actions beside an issue's title, after New issue, and not in the narrow window's row", () => {
    document.body.innerHTML = ISSUE;
    placeButtons(document, ISSUE_PATH, { sidebar: false, wide: false });

    const groups = [...document.querySelectorAll(`.${LAYOUT_BUTTONS}`)];

    expect(groups.map((element) => element.parentElement?.getAttribute('data-component'))).toEqual(['PH_Actions']);
    expect(groups[0]!.parentElement?.lastElementChild).toBe(groups[0]);
    expect(groups[0]!.previousElementSibling?.querySelector('a')?.textContent).toBe('New issue');
  });

  it('moves the buttons from an issue to the tab row of a pull request rendered in its place', () => {
    document.body.innerHTML = ISSUE;
    placeButtons(document, ISSUE_PATH, { sidebar: false, wide: false });
    document.body.insertAdjacentHTML('beforeend', PULL);
    placeButtons(document, PULL_PATH, { sidebar: false, wide: false });

    expect([...document.querySelectorAll(`.${LAYOUT_BUTTONS}`)].map((element) => element.parentElement?.className)).toEqual([expect.stringContaining('prc-PageHeader-Navigation-')]);
  });

  it('puts them in the tab row on a pull request tab with no sidebar', () => {
    document.body.innerHTML = COMMITS;
    placeButtons(document, `${PULL_PATH}/commits`, { sidebar: false, wide: false });

    expect(group()!.parentElement?.className).toContain('prc-PageHeader-Navigation-');
  });

  it('removes the buttons on another page, and adds none without a tab row or issue header', () => {
    document.body.innerHTML = PULL;
    placeButtons(document, PULL_PATH, { sidebar: false, wide: false });
    placeButtons(document, '/acme/app/pulls', { sidebar: false, wide: false });

    expect(group()).toBeNull();

    document.querySelector('nav[aria-label="Pull request"]')!.remove();
    placeButtons(document, PULL_PATH, { sidebar: false, wide: false });

    expect(group()).toBeNull();
  });

  it('moves the buttons when GitHub replaces their row', () => {
    document.body.innerHTML = PULL;
    placeButtons(document, PULL_PATH, { sidebar: false, wide: false });

    const row = document.querySelector('[class*="prc-PageHeader-Navigation-"]')!;
    const fresh = row.cloneNode(true) as Element;

    fresh.querySelector(`.${LAYOUT_BUTTONS}`)!.remove();
    row.replaceWith(fresh);
    placeButtons(document, PULL_PATH, { sidebar: false, wide: false });

    expect(group()!.parentElement).toBe(fresh);
    expect(document.querySelectorAll(`.${LAYOUT_BUTTONS}`)).toHaveLength(1);
  });

  it.each([
    ['a pull request', PULL, PULL_PATH],
    ['an issue', ISSUE, ISSUE_PATH],
  ])('makes no mutation on %s when nothing changed', async (_, page, path) => {
    document.body.innerHTML = page;
    placeButtons(document, path, { sidebar: true, wide: false });

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((found) => records.push(...found));

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    placeButtons(document, path, { sidebar: true, wide: false });
    await Promise.resolve();
    observer.disconnect();

    expect(records).toEqual([]);
    expect(document.querySelectorAll(`.${LAYOUT_BUTTONS}`)).toHaveLength(1);
  });
});

describe('watchLayout', () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  it('applies the saved settings at once and saves a click for every page', async () => {
    const storage = new MemoryStorage();
    let path = PULL_PATH;

    storage.setItem(LAYOUT_KEYS.wide, 'true');
    // Only "true" turns a setting on.
    storage.setItem(LAYOUT_KEYS.sidebar, 'yes');
    document.body.innerHTML = PULL;
    stop = watchLayout(document, storage, () => path).stop;

    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.wide)).toBe(true);
    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.sidebar)).toBe(false);
    expect(buttonFor('sidebar').getAttribute('aria-pressed')).toBe('false');

    buttonFor('sidebar').querySelector('span')!.click();

    expect(storage.getItem(LAYOUT_KEYS.sidebar)).toBe('true');
    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.sidebar)).toBe(true);
    expect(buttonFor('sidebar').getAttribute('aria-pressed')).toBe('true');

    buttonFor('wide').click();

    expect(storage.getItem(LAYOUT_KEYS.wide)).toBe('false');
    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.wide)).toBe(false);

    // Another issue keeps the hidden sidebar.
    path = ISSUE_PATH;
    document.body.innerHTML = ISSUE;
    await vi.advanceTimersByTimeAsync(50);

    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.sidebar)).toBe(true);
    expect(group()).not.toBeNull();
  });

  it('puts the buttons back when GitHub renders the row again, and clears the layout on leaving', async () => {
    const storage = new MemoryStorage();
    let path = PULL_PATH;

    storage.setItem(LAYOUT_KEYS.sidebar, 'true');
    document.body.innerHTML = PULL;
    stop = watchLayout(document, storage, () => path).stop;
    group()!.remove();
    await vi.advanceTimersByTimeAsync(50);

    expect(group()).not.toBeNull();

    path = '/acme/app/issues';
    document.body.append(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(50);

    expect(group()).toBeNull();
    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.sidebar)).toBe(false);
  });

  it('follows a change saved in another tab and ignores other keys', () => {
    const storage = new MemoryStorage();

    document.body.innerHTML = ISSUE;
    stop = watchLayout(document, storage, () => ISSUE_PATH).stop;
    storage.setItem(LAYOUT_KEYS.wide, 'true');
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));

    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.wide)).toBe(false);

    window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_KEYS.wide }));

    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.wide)).toBe(true);
  });

  it('keeps the setting when the storage refuses the write', () => {
    const storage = { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };

    document.body.innerHTML = ISSUE;
    stop = watchLayout(document, storage, () => ISSUE_PATH).stop;
    buttonFor('sidebar').click();

    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.sidebar)).toBe(false);
  });

  it('ignores clicks outside the buttons and stops watching', async () => {
    const storage = new MemoryStorage();

    document.body.innerHTML = ISSUE;
    const watcher = watchLayout(document, storage, () => ISSUE_PATH);

    document.querySelector('svg.octicon-three-bars')!.closest('button')!.click();
    expect(storage.items.size).toBe(0);

    watcher.stop();
    group()!.remove();
    await vi.advanceTimersByTimeAsync(50);

    expect(group()).toBeNull();
  });
});

describe('startLayout', () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    Reflect.deleteProperty(document, 'readyState');
  });

  it('applies the saved layout at once and places the buttons once the DOM is parsed', () => {
    const storage = new MemoryStorage();

    storage.setItem(LAYOUT_KEYS.wide, 'true');
    document.body.innerHTML = ISSUE;
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    stop = startLayout(document, storage, () => ISSUE_PATH).stop;

    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.wide)).toBe(true);
    expect(group()).toBeNull();

    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(group()).not.toBeNull();
    buttonFor('sidebar').click();
    expect(storage.getItem(LAYOUT_KEYS.sidebar)).toBe('true');
  });

  it('places the buttons at once on a parsed page, and watches nothing once stopped', () => {
    const storage = new MemoryStorage();

    document.body.innerHTML = ISSUE;
    stop = startLayout(document, storage, () => ISSUE_PATH).stop;

    expect(group()).not.toBeNull();

    stop();
    stop = undefined;
    buttonFor('sidebar').click();

    expect(storage.getItem(LAYOUT_KEYS.sidebar)).toBeNull();
  });

  it('never watches a page stopped before its DOM was parsed', () => {
    document.body.innerHTML = ISSUE;
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    startLayout(document, new MemoryStorage(), () => ISSUE_PATH).stop();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(group()).toBeNull();
  });
});
