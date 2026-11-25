import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_ATTRIBUTES, LAYOUT_BUTTONS, LAYOUT_KEYS, applyLayout, isConversationPage, pageStorage, placeButtons, readLayout, watchLayout } from '../src/layout.js';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', `layout-${name}.html`), 'utf8');
const ISSUE = fixture('issue');
const PULL = fixture('pull');
const COMMITS = fixture('pull-commits');
const CSS = readFileSync(join(import.meta.dirname, '..', 'src', 'content.css'), 'utf8');

const ISSUE_PATH = '/ownerrez/orez/issues/22338';
const PULL_PATH = '/ownerrez/orez/pull/22336';
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
    expect(isConversationPage('/ownerrez/orez/issues')).toBe(false);
    expect(isConversationPage('/ownerrez/orez/pulls')).toBe(false);
    expect(isConversationPage('/ownerrez/orez/issues/new')).toBe(false);
    expect(isConversationPage('/ownerrez/orez/pull/22336x')).toBe(false);
    expect(isConversationPage('/orgs/ownerrez/projects/1')).toBe(false);
    expect(isConversationPage('/')).toBe(false);
  });
});

describe('readLayout', () => {
  it('reads each saved setting, and off for one never saved or not "true"', () => {
    const storage = new MemoryStorage();

    expect(readLayout(storage)).toEqual({ sidebar: false, wide: false });
    storage.setItem(LAYOUT_KEYS.sidebar, 'true');
    storage.setItem(LAYOUT_KEYS.wide, 'yes');
    expect(readLayout(storage)).toEqual({ sidebar: true, wide: false });
  });

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
    applyLayout(document, '/orgs/ownerrez/projects/1', { sidebar: true, wide: true });

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

  it("puts them in an issue's header, which has no tab row", () => {
    document.body.innerHTML = ISSUE;
    placeButtons(document, ISSUE_PATH, { sidebar: false, wide: false });

    expect(group()!.parentElement?.getAttribute('data-testid')).toBe('issue-header');
  });

  it('puts them in the tab row on a pull request tab with no sidebar', () => {
    document.body.innerHTML = COMMITS;
    placeButtons(document, `${PULL_PATH}/commits`, { sidebar: false, wide: false });

    expect(group()!.parentElement?.className).toContain('prc-PageHeader-Navigation-');
  });

  it('removes the buttons on another page, and adds none without a tab row or issue header', () => {
    document.body.innerHTML = PULL;
    placeButtons(document, PULL_PATH, { sidebar: false, wide: false });
    placeButtons(document, '/ownerrez/orez/pulls', { sidebar: false, wide: false });

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

  it('makes no mutation when nothing changed', async () => {
    document.body.innerHTML = PULL;
    placeButtons(document, PULL_PATH, { sidebar: true, wide: false });

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((found) => records.push(...found));

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    placeButtons(document, PULL_PATH, { sidebar: true, wide: false });
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
    document.body.innerHTML = PULL;
    stop = watchLayout(document, storage, () => path).stop;

    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.wide)).toBe(true);
    expect(html().hasAttribute(LAYOUT_ATTRIBUTES.sidebar)).toBe(false);

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

    path = '/ownerrez/orez/issues';
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
