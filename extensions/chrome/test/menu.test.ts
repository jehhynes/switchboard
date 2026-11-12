import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card } from '@switchboard/core/group';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueKey } from '../src/board.js';
import { menuCard, watchCardMenus } from '../src/menu.js';
import { openUri } from '../src/open.js';
import type { SnoozeMenus } from '../src/snooze.js';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures', 'card-menu.html'), 'utf8');
const ISSUE = 'https://github.com/github/roadmap/issues/1090';
const card = (group: Card['group'], snoozed = false): Card => ({ url: 'https://github.com/GitHub/roadmap/issues/1090', playbook: 'dev:review', group, snoozed });

describe('watchCardMenus', () => {
  let watch: { stop(): void } | null = null;
  let snooze: { choose: ReturnType<typeof vi.fn>; unsnooze: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let opened: string[];

  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
    snooze = { choose: vi.fn(), unsnooze: vi.fn(), stop: vi.fn() };
    opened = [];
  });

  afterEach(() => {
    watch?.stop();
    watch = null;
    document.body.innerHTML = '';
  });

  const list = () => document.querySelector<HTMLElement>('#__primerPortalRoot__ ul[role="menu"]')!;
  const labels = () => [...list().querySelectorAll(':scope > li')].map((item) => (item.getAttribute('data-component') === 'ActionList.Divider' ? '---' : item.querySelector('[data-component="ActionList.Item.Label"]')?.textContent));
  const item = (label: string) => [...list().querySelectorAll<HTMLElement>('.switchboard-menu-item')].find((element) => element.textContent === label)!;
  const kebab = () => document.querySelector('[data-board-card-id] button[aria-haspopup="true"]')!;

  /** GitHub opening the card's More actions menu in its portal. */
  async function openMenu(): Promise<void> {
    document.body.append(document.querySelector<HTMLTemplateElement>('template#menu')!.content.cloneNode(true));
    await new Promise((done) => setTimeout(done, 0));
  }

  function start(found: Card | undefined) {
    watch = watchCardMenus(document, (url) => (issueKey(url) === 'github/roadmap#1090' ? found : undefined), snooze as unknown as SnoozeMenus, (uri) => opened.push(uri));
  }

  it('finds the card whose More actions button opened the menu, and none for another menu', async () => {
    await openMenu();

    expect(menuCard(document, list())).toEqual({ card: document.querySelector('[data-board-card-id]'), button: kebab() });
    list().setAttribute('aria-labelledby', 'another-tooltip');
    expect(menuCard(document, list())).toBeNull();
  });

  it('adds Open in Switchboard and Snooze after a divider at the bottom, styled as GitHub\'s items', async () => {
    start(card('blocked'));
    await openMenu();

    expect(labels()).toEqual(['Open in new tab', 'Copy link', 'Copy link in project', '---', 'Move to top', 'Move to bottom', 'Move to column', '---', 'Archive', 'Remove from project', '---', 'Open in Switchboard', 'Snooze in Switchboard…']);

    const open = item('Open in Switchboard');
    const copy = list().querySelector('li[role="menuitem"]')!;

    expect(open.className).toBe(`${copy.className} switchboard-menu-item`);
    expect([open.getAttribute('role'), open.getAttribute('tabindex'), open.getAttribute('aria-label')]).toEqual(['menuitem', '-1', 'Open in Switchboard']);
    expect(open.querySelectorAll('[id]')).toHaveLength(0);
    expect(open.hasAttribute('aria-keyshortcuts')).toBe(false);

    const svg = open.querySelector('[data-component="ActionList.LeadingVisual"] svg');

    expect([svg?.namespaceURI, svg?.getAttribute('viewBox'), svg?.getAttribute('class'), svg?.childElementCount, svg?.querySelector('path')?.getAttribute('d')?.slice(0, 18)]).toEqual([
      'http://www.w3.org/2000/svg',
      '0 0 16 16',
      'octicon',
      1,
      'M15.434 1.72887L12',
    ]);
  });

  it('offers Unsnooze on a snoozed card, only Open in Switchboard on a Done card, and nothing on a card the hub does not list', async () => {
    start(card('unstarted', true));
    await openMenu();
    expect(labels().slice(-3)).toEqual(['---', 'Open in Switchboard', 'Unsnooze in Switchboard']);

    watch!.stop();
    document.body.innerHTML = FIXTURE;
    start(card('done'));
    await openMenu();
    expect(labels().slice(-3)).toEqual(['Remove from project', '---', 'Open in Switchboard']);

    watch!.stop();
    document.body.innerHTML = FIXTURE;
    start(undefined);
    await openMenu();
    expect(list().querySelector('.switchboard-menu-item')).toBeNull();
    expect(labels().at(-1)).toBe('Remove from project');
  });

  it('adds its items once while GitHub keeps changing the page', async () => {
    start(card('blocked'));
    await openMenu();

    const before = [...list().children];

    document.body.append(document.createElement('div'));
    await new Promise((done) => setTimeout(done, 0));

    expect([...list().children]).toEqual(before);
  });

  it('follows a card that becomes snoozed, or that a failed read drops, while its menu is open', async () => {
    let found: Card | undefined = card('blocked');
    const change = async (next: Card | undefined) => {
      found = next;
      // A new cards read changes the card's pill.
      document.querySelector('[data-board-card-id]')!.append(document.createElement('span'));
      await new Promise((done) => setTimeout(done, 0));
    };

    watch = watchCardMenus(document, () => found, snooze as unknown as SnoozeMenus, (uri) => opened.push(uri));
    await openMenu();
    expect(labels().slice(-3)).toEqual(['---', 'Open in Switchboard', 'Snooze in Switchboard…']);

    await change(card('blocked', true));
    expect(labels().slice(-4)).toEqual(['Remove from project', '---', 'Open in Switchboard', 'Unsnooze in Switchboard']);
    item('Unsnooze in Switchboard').click();
    expect(snooze.unsnooze).toHaveBeenCalledExactlyOnceWith(ISSUE, kebab());
    expect(snooze.choose).not.toHaveBeenCalled();

    await change(undefined);
    expect(labels().at(-1)).toBe('Remove from project');
    expect(list().querySelectorAll('.switchboard-menu-item, .switchboard-menu-item-divider')).toHaveLength(0);
  });

  it('closes GitHub\'s menu with Escape and runs the item, keeping the click from GitHub', async () => {
    const keys: string[] = [];
    const reachedGitHub = vi.fn();

    start(card('blocked'));
    await openMenu();
    list().addEventListener('keydown', (event) => keys.push(event.key));
    document.body.addEventListener('click', reachedGitHub);

    item('Open in Switchboard').click();
    expect(opened).toEqual([openUri(ISSUE)]);
    expect(keys).toEqual(['Escape']);
    expect(reachedGitHub).not.toHaveBeenCalled();

    item('Snooze in Switchboard…').click();
    expect(snooze.choose).toHaveBeenCalledExactlyOnceWith(ISSUE, kebab());
  });

  it('runs an item on Enter or Space, and ignores other keys', async () => {
    start(card('progress', true));
    await openMenu();

    const unsnooze = item('Unsnooze in Switchboard');

    unsnooze.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(snooze.unsnooze).not.toHaveBeenCalled();

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });

    unsnooze.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(snooze.unsnooze).toHaveBeenCalledExactlyOnceWith(ISSUE, kebab());

    unsnooze.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(snooze.unsnooze).toHaveBeenCalledTimes(2);
  });
});

describe('watchCardMenus in a project table', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('adds the Switchboard items to a table row\'s Row actions menu, and snoozes under its button', async () => {
    const snooze = { choose: vi.fn(), unsnooze: vi.fn(), stop: vi.fn() };
    const opened: string[] = [];

    document.body.innerHTML = readFileSync(join(import.meta.dirname, 'fixtures', 'row-menu.html'), 'utf8');

    const watch = watchCardMenus(document, (url) => (issueKey(url) === 'github/roadmap#1090' ? card('blocked') : undefined), snooze as unknown as SnoozeMenus, (uri) => opened.push(uri));
    const button = document.querySelector('[role="row"] button[aria-haspopup="true"]')!;

    document.body.append(document.querySelector<HTMLTemplateElement>('template#menu')!.content.cloneNode(true));
    await new Promise((done) => setTimeout(done, 0));

    const list = document.querySelector('#__primerPortalRoot__ ul[role="menu"]')!;
    const labels = [...list.querySelectorAll(':scope > li')].map((item) => (item.getAttribute('data-component') === 'ActionList.Divider' ? '---' : item.querySelector('[data-component="ActionList.Item.Label"]')?.textContent));

    expect(menuCard(document, list)).toEqual({ card: document.querySelector('[role="row"]'), button });
    expect(labels).toEqual(['Archive', 'Remove from project', '---', 'Move item', '---', 'Open in Switchboard', 'Snooze in Switchboard…']);

    const items = [...list.querySelectorAll<HTMLElement>('.switchboard-menu-item')];

    items[0]!.click();
    expect(opened).toEqual([openUri(ISSUE)]);
    items[1]!.click();
    expect(snooze.choose).toHaveBeenCalledExactlyOnceWith(ISSUE, button);
    watch.stop();
  });
});
