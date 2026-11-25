import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PageGroup, PageRow } from '@switchboard/protocol';
import { startPage } from '../src/main.js';
import { drawAtOnce } from './frame.js';
import { PAGE_ASSETS } from '../dist/index.js';

const css = PAGE_ASSETS['page.css']!.body;

const row = (id: number, patch: Partial<PageRow> = {}): PageRow => ({ workItemId: id, ticketId: id, title: `Item ${id}`, priority: null, time: null, ticket: `gh ${id}`, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: null, ...patch });
const group = (key: string, rows: PageRow[]): PageGroup => ({ key, title: key, glyph: '', empty: null, rows });
class Source {
  static last: Source;
  listeners = new Map<string, Array<(event: { data: string }) => void>>();
  constructor() { Source.last = this; }
  addEventListener(type: string, listener: (event: { data: string }) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string, data: object): void { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify({ type, ...data }) }); }
  close(): void {}
}
let root: HTMLElement;
let close: () => void;
let posts: Array<{ url: string; body: Record<string, unknown> }>;
let opened: string[];
let refused: boolean;
/** While set, a select's answer waits for it, so a test can deliver scopes while the select is outstanding. */
let gate: Promise<void> | null;
const el = (selector: string): HTMLElement => root.querySelector<HTMLElement>(selector)!;
const key = (target: HTMLElement, name: string, patch: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...patch });
  target.dispatchEvent(event);
  return event;
};
const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const start = (groups: PageGroup[]): Source => {
  const page = startPage(root, {
    frame: drawAtOnce, now: () => 10_000,
    EventSource: Source as unknown as typeof EventSource,
    fetch: (async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: JSON.parse(init?.body ?? '{}') });
      if (gate !== null && url.endsWith('/select')) await gate;
      return { status: refused && url.endsWith('/select') ? 409 : 200, ok: true, json: async () => refused ? { error: 'No longer available.' } : {}, text: async () => '' } as Response;
    }) as typeof fetch,
    openUrl: (url) => opened.push(url),
  });
  close = () => page.close();
  Source.last.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, status: null, artifacts: [] });
  return Source.last;
};
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
  localStorage.clear();
  history.replaceState(null, '', '#');
  window.innerWidth = 1600;
  posts = []; opened = []; refused = false; gate = null;
});
afterEach(() => { close?.(); vi.restoreAllMocks(); });

it('selects only when a scope-bound menu control is chosen, waits for its matching scope and never acts on the old work item', async () => {
  const action = { label: 'Mark done', action: 'done', icon: 'check', group: 'state' as const, confirm: null, input: null };
  const source = start([group('review', [row(1, { actions: [action] }), row(2, { actions: [action], url: 'https://example.test/2' })])]);
  const scope = (id: number) => ({ kind: 'page', key: 'k', folder: 'D:/scratch', title: 'Item', scopeGen: id, conversations: [], workItemId: id, cwd: 'D:/scratch', sessionId: null });
  source.emit('scope', { scope: scope(1) });
  key(el('.row[data-row="item:2"]'), 'ContextMenu');
  const control = el('.row-menu [data-label="Mark done"]') as HTMLButtonElement;
  expect(control.disabled).toBe(false);
  expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
  control.click();
  await flush();
  expect(posts.filter((post) => post.url.endsWith('/row-action'))).toEqual([]);
  source.emit('scope', { scope: scope(2) });
  await flush();
  expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ workItemId: 2, scopeGen: 2, label: 'Mark done' });
});

it('keeps clipped link pills out of Tab order and restores them when they fit', () => {
  const links = [{ label: 'Notes', url: 'https://example.test/notes', kind: 'url' as const, badge: 'Notes', glyph: null, mentioned: false }];
  start([group('review', [row(1, { links })])]);
  el('.row').focus();
  let top = 30;
  vi.spyOn(el('.row-links'), 'getBoundingClientRect').mockImplementation(() => ({ top: 10, bottom: 28, left: 0, right: 100, height: 18 }) as DOMRect);
  const pill = el('.pill.link');
  vi.spyOn(pill, 'getBoundingClientRect').mockImplementation(() => ({ top, bottom: top + 18, left: 0, right: 50, height: 18 }) as DOMRect);
  window.dispatchEvent(new Event('resize'));
  expect(pill.tabIndex).toBe(-1);
  top = 10;
  window.dispatchEvent(new Event('resize'));
  expect(pill.tabIndex).toBe(0);
});

it('makes the list one Tab stop, the row or heading last focused, with only that row\'s pills as stops, kept over redraws', () => {
  const links = [{ label: 'Notes', url: 'https://example.test/notes', kind: 'url' as const, badge: 'Notes', glyph: null, mentioned: false }];
  const groups = [group('review', [row(1, { url: 'https://example.test/1', links }), row(2, { url: 'https://example.test/2', links })]), group('done', [row(3, { band: 'Today' })])];
  const source = start(groups);
  const stops = (): string[] => [...root.querySelectorAll<HTMLElement>('.row, .group-head, .band-head')].filter((one) => one.tabIndex === 0).map((one) => one.dataset['row'] ?? one.dataset['group'] ?? one.dataset['band'] ?? '');
  const pills = (key: string): number[] => [...el(`.row[data-row="${key}"]`).querySelectorAll<HTMLElement>('.pill[data-action="open-link"]')].map((pill) => pill.tabIndex);
  // Nothing focused or selected: the first heading.
  expect(stops()).toEqual(['review']);
  expect([...pills('item:1'), ...pills('item:2')]).toEqual([-1, -1, -1, -1]);
  el('.row[data-row="item:2"]').focus();
  expect(stops()).toEqual(['item:2']);
  // The ticket key and the link pill of the stop's row only.
  expect(pills('item:2')).toEqual([0, 0]);
  expect(pills('item:1')).toEqual([-1, -1]);
  source.emit('list', { groups });
  expect(stops()).toEqual(['item:2']);
  expect(document.activeElement).toBe(el('.row[data-row="item:2"]'));
  key(el('.row[data-row="item:2"]'), 'ArrowUp');
  expect(stops()).toEqual(['item:1']);
  expect(pills('item:1')).toEqual([0, 0]);
  expect(pills('item:2')).toEqual([-1, -1]);
  el('.group-head[data-group="done"]').focus();
  expect(stops()).toEqual(['done']);
  source.emit('list', { groups });
  expect(document.activeElement).toBe(el('.group-head[data-group="done"]'));
  expect(stops()).toEqual(['done']);
  // A redraw while focus is outside the list moves no focus into it.
  const outside = document.createElement('input');
  document.body.append(outside);
  outside.focus();
  source.emit('list', { groups });
  expect(document.activeElement).toBe(outside);
  expect(stops()).toEqual(['done']);
});

it('makes the selected row the list\'s Tab stop until the focus is on another, and keeps an open row menu focused over a redraw', async () => {
  const groups = [group('review', [row(1), row(2, { url: 'https://example.test/2' })])];
  const source = start(groups);
  el('.row[data-row="item:2"]').click();
  await flush();
  expect([...root.querySelectorAll<HTMLElement>('.row, .group-head')].filter((one) => one.tabIndex === 0).map((one) => one.dataset['row'])).toEqual(['item:2']);
  key(el('.row[data-row="item:2"]'), 'ContextMenu');
  expect(document.activeElement).toBe(el('.row-menu'));
  source.emit('list', { groups });
  expect(document.activeElement).toBe(el('.row-menu'));
  key(el('.row-menu'), 'Escape');
  expect(document.activeElement).toBe(el('.row[data-row="item:2"]'));
});

it('does not cycle F8 behind a list-header sheet', () => {
  start([group('review', [row(1, { stripe: 'turn' })])]);
  el('[data-action="list-new-session"]').click();
  expect(root.querySelector('.sheet-backdrop')).not.toBeNull();
  key(el('.sheet'), 'F8');
  expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
});

it.each(['Escape', 'reconnect'])('cancels a deferred control on %s before a matching scope can arrive', async (cancel) => {
  const action = { label: 'Mark done', action: 'done', icon: 'check', group: 'state' as const, confirm: null, input: null };
  const source = start([group('review', [row(1, { actions: [action] })])]);
  key(el('.row'), 'ContextMenu');
  el('.row-menu [data-label="Mark done"]').click();
  if (cancel === 'Escape') key(root, 'Escape');
  else source.emit('hello', { key: 'new-page-key', scope: null, sessions: [], items: [] });
  source.emit('scope', { scope: { kind: 'page', key: 'k', scopeGen: 1, workItemId: 1, conversations: [] } });
  await flush();
  expect(posts.filter((post) => post.url.endsWith('/row-action'))).toEqual([]);
});

it('anchors right-click menus at the pointer and does not open an empty menu', () => {
  start([group('review', [row(1, { url: 'https://example.test/1' }), row(2)])]);
  el('.row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 70 }));
  expect(el('.row-menu-anchor').style.left).toBe('80px');
  expect(el('.row-menu-anchor').style.top).toBe('70px');
  const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  el('.row-menu .menu-row').dispatchEvent(native);
  expect(native.defaultPrevented).toBe(true);
  expect(el('.row-menu-anchor').style.top).toBe('70px');
  key(el('.row-menu .menu-row'), 'Escape');
  key(el('.row[data-row="item:2"]'), 'ContextMenu');
  expect(root.querySelector('.row-menu')).toBeNull();
});

it('fixes a row menu to the viewport at its row, inside it near its right edge, and raises the list above the conversation while it is open', () => {
  start([group('review', [row(1, { url: 'https://example.test/1' })])]);
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
  // The list's right edge is at 340 px; the right click lands near it.
  const entry = el('.list-row');
  vi.spyOn(entry, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 340, top: 200, bottom: 250, width: 340, height: 50 } as DOMRect);
  el('.row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 330, clientY: 220 }));
  const anchor = el('.row-menu-anchor');
  expect([anchor.style.left, anchor.style.top]).toEqual(['330px', '220px']);
  // The list scrolls the row up 100 px: the menu follows it.
  vi.spyOn(entry, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 340, top: 100, bottom: 150, width: 340, height: 50 } as DOMRect);
  el('#list').dispatchEvent(new Event('scroll'));
  expect([anchor.style.left, anchor.style.top]).toEqual(['330px', '120px']);
  // Opened from the keyboard, it sits under the row's start; a point past the viewport is held inside it.
  key(el('.row-menu .menu-row'), 'Escape');
  key(el('.row'), 'ContextMenu');
  expect([el('.row-menu-anchor').style.left, el('.row-menu-anchor').style.top]).toEqual(['8px', '146px']);
  key(el('.row-menu .menu-row'), 'Escape');
  vi.spyOn(entry, 'getBoundingClientRect').mockReturnValue({ left: 900, right: 1240, top: 780, bottom: 830, width: 340, height: 50 } as DOMRect);
  el('.row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1200, clientY: 820 }));
  expect([el('.row-menu-anchor').style.left, el('.row-menu-anchor').style.top]).toEqual(['1000px', '800px']);
  // page.css: the anchor is fixed, so the list's scroll box does not clip it, and the list rises to the header menus' layer while one is open.
  expect(css).toMatch(/\.row-menu-anchor \{ position: fixed;/);
  expect(css).toContain('#list:has(.row-menu) { position: relative; z-index: var(--sb-z-bar-menu); }');
});

it('walks headings, rows and Done bands, focusing and revealing each row without selecting it, with no wrap or modified arrows', () => {
  start([group('review', [row(1), row(2)]), group('done', [row(3, { band: 'Today' })])]);
  const reveal = vi.fn();
  HTMLElement.prototype.scrollIntoView = reveal;
  el('.group-head').focus();
  key(el('.group-head'), 'ArrowUp');
  expect(document.activeElement).toBe(el('.group-head'));
  key(el('.group-head'), 'ArrowDown');
  expect(document.activeElement).toBe(el('.row[data-row="item:1"]'));
  // Nothing is open, so nothing is selected: the focus is only the focus ring.
  expect(root.querySelector('.row.selected')).toBeNull();
  expect(reveal).toHaveBeenCalledWith({ block: 'nearest' });
  key((document.activeElement as HTMLElement), 'ArrowDown', { altKey: true });
  expect(document.activeElement).toBe(el('.row[data-row="item:1"]'));
  key((document.activeElement as HTMLElement), 'ArrowDown');
  expect((document.activeElement as HTMLElement).dataset['row']).toBe('item:2');
  key((document.activeElement as HTMLElement), 'ArrowDown');
  expect(document.activeElement).toBe(el('.group-head[data-group="done"]'));
  el('.group-head[data-group="done"]').click();
  key(el('.group-head[data-group="done"]'), 'ArrowDown');
  expect(document.activeElement).toBe(el('.band-head'));
  key(el('.band-head'), 'ArrowDown');
  expect((document.activeElement as HTMLElement).dataset['row']).toBe('item:3');
  key((document.activeElement as HTMLElement), 'ArrowDown');
  expect(document.activeElement).toBe(el('.row[data-row="item:3"]'));
  expect(root.querySelector('.row.selected')).toBeNull();
  expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
  key((document.activeElement as HTMLElement), 'Enter');
  expect(posts.filter((post) => post.url.endsWith('/select')).at(-1)?.body).toMatchObject({ workItemId: 3 });
  expect(el('.row.selected').dataset['row']).toBe('item:3');
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it('focuses a row without selecting it and leaves its link pills focusable', () => {
  start([group('progress', [row(1, { url: 'https://example.test/1' }), row(2)])]);
  el('.row').focus();
  expect(root.querySelector('.row.selected')).toBeNull();
  const selected = (document.activeElement as HTMLElement);
  expect(selected.dataset['row']).toBe('item:1');
  expect(selected.querySelector('.row-actions')).toBeNull();
  expect(key(selected, 'Tab').defaultPrevented).toBe(false);
  const pill = el('.pill[role="link"]');
  expect(pill.tabIndex).toBe(0);
  pill.focus();
  key(pill, 'Enter');
  expect(opened).toEqual(['https://example.test/1']);
  expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
});

it('opens a row menu whose first row is a write with nothing chosen, so Enter alone runs nothing', () => {
  const done = { label: 'Mark done', action: 'done', icon: 'check', group: 'main', confirm: null, input: null } as unknown as PageRow['actions'][number];
  start([group('progress', [row(1, { actions: [done] })])]);
  key(el('.row'), 'ContextMenu');
  expect(el('.row-menu .menu-row').dataset['label']).toBe('Mark done');
  expect(document.activeElement).toBe(el('.row-menu'));
  key(document.activeElement as HTMLElement, 'Enter');
  expect(posts.filter((post) => !post.url.endsWith('/page-focus'))).toEqual([]);
  expect(root.querySelector('.row-menu')).not.toBeNull();
  key(document.activeElement as HTMLElement, 'ArrowUp');
  expect(document.activeElement).toBe(el('.row-menu .menu-row'));
});

it.each(['ContextMenu', 'F10', 'right-click'])('opens a work-item menu with %s, walks it and returns focus with Escape', (method) => {
  start([group('progress', [row(1, { url: 'https://example.test/1' })])]);
  const target = el('.row');
  target.focus();
  if (method === 'right-click') target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  else key(target, method, { shiftKey: method === 'F10' });
  expect(el('.row-menu').textContent).toContain('Open ticket');
  expect(el('.row-menu').getAttribute('aria-label')).toBe('Actions for Item 1');
  // The menu opens with no row chosen.
  expect(document.activeElement).toBe(el('.row-menu'));
  key(document.activeElement as HTMLElement, 'ArrowDown');
  expect(document.activeElement).toBe(el('.row-menu .menu-row'));
  key(document.activeElement as HTMLElement, 'Escape');
  expect(root.querySelector('.row-menu')).toBeNull();
  expect(document.activeElement).toBe(target);
  expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
});

it('keeps a phone list and its menu shown without opening a conversation, and reports a refused menu control selection', async () => {
  window.innerWidth = 700;
  start([group('progress', [row(1, { url: 'https://example.test/1', actions: [{ label: 'Mark done', action: 'done', icon: 'check', group: 'state', confirm: null, input: null }] })])]);
  refused = true;
  key(el('.row'), 'ContextMenu');
  expect(root.classList.contains('listing')).toBe(true);
  expect(root.querySelector('.row-menu')).not.toBeNull();
  expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
  el('.row-menu [data-label="Mark done"]').click();
  await flush();
  await flush();
  // The refused select shows in the work item's own opening place (opening.tsx).
  expect(el('#panel .opening-why').textContent).toContain('No longer available.');
});

it('restores focus when keyed rows reorder inside the same group and closes the menu when its work-item row is clicked', () => {
  const source = start([group('review', [row(1, { url: 'https://example.test/1' }), row(2), row(3)])]);
  el('.row[data-row="item:1"]').focus();
  source.emit('list', { groups: [group('review', [row(2), row(3), row(1, { url: 'https://example.test/1' })])] });
  expect(document.activeElement).toBe(el('.row[data-row="item:1"]'));
  key(el('.row[data-row="item:1"]'), 'ContextMenu');
  el('.row[data-row="item:1"]').click();
  expect(root.querySelector('.row-menu')).toBeNull();
});

it('falls back to the opened row after a refused select or a local selection whose key vanished', async () => {
  const source = start([group('review', [row(1), row(2)]), group('done', [])]);
  const scope = { kind: 'page', key: 'k', folder: 'D:/scratch', title: 'Item', scopeGen: 1, conversations: [], workItemId: 1, cwd: 'D:/scratch', sessionId: null };
  source.emit('scope', { scope });
  refused = true;
  el('.row[data-row="item:2"]').click();
  await flush();
  await flush();
  // The refused open keeps its row marked under its reason until Back to the list (opening.tsx), which marks the opened row again.
  expect(el('.row.selected').dataset['row']).toBe('item:2');
  expect(el('#panel .opening-why').textContent).toContain('No longer available.');
  el('[data-action="open-back"]').click();
  expect(el('.row.selected').dataset['row']).toBe('item:1');
  el('.row[data-row="item:2"]').focus();
  source.emit('list', { groups: [group('review', []), group('done', [row(1)])] });
  expect(el('.row.selected').dataset['row']).toBe('item:1');
});

it('keeps the selection on the open work item while the focus, a hover or a row menu moves, and moves it only when a row opens', async () => {
  const source = start([group('review', [row(1), row(2, { url: 'https://example.test/2' }), row(3, { url: 'https://example.test/3' })])]);
  const scope = (id: number) => ({ kind: 'page', key: 'k', folder: 'D:/scratch', title: 'Item', scopeGen: id, conversations: [], workItemId: id, cwd: 'D:/scratch', sessionId: null });
  source.emit('scope', { scope: scope(1) });
  const marked = (): Array<[string | undefined, string | null]> => [...root.querySelectorAll<HTMLElement>('.row.selected, .row[aria-current="true"]')].map((one) => [one.dataset['row'], one.getAttribute('aria-current')]);
  expect(marked()).toEqual([['item:1', 'true']]);
  // Arrow keys move the focus only.
  el('.row[data-row="item:1"]').focus();
  key(el('.row[data-row="item:1"]'), 'ArrowDown');
  expect(document.activeElement).toBe(el('.row[data-row="item:2"]'));
  expect(marked()).toEqual([['item:1', 'true']]);
  // A hover is only its hover style.
  el('.row[data-row="item:3"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  expect(marked()).toEqual([['item:1', 'true']]);
  // A row menu, from the keyboard or a right-click, leaves the selection where it was.
  key(el('.row[data-row="item:2"]'), 'ContextMenu');
  expect(root.querySelector('.row-menu')).not.toBeNull();
  expect(marked()).toEqual([['item:1', 'true']]);
  key(document.activeElement as HTMLElement, 'Escape');
  el('.row[data-row="item:3"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  expect(root.querySelector('.row-menu')).not.toBeNull();
  expect(marked()).toEqual([['item:1', 'true']]);
  key(document.activeElement as HTMLElement, 'Escape');
  // Enter opens the focused row, which is selected at once, while it opens, and stays selected once the hub shows it.
  el('.row[data-row="item:2"]').focus();
  key(el('.row[data-row="item:2"]'), 'Enter');
  expect(marked()).toEqual([['item:2', 'true']]);
  await flush();
  source.emit('scope', { scope: scope(2) });
  expect(marked()).toEqual([['item:2', 'true']]);
  // Space opens a row too.
  el('.row[data-row="item:3"]').focus();
  key(el('.row[data-row="item:3"]'), ' ');
  expect(marked()).toEqual([['item:3', 'true']]);
  // page.css: the focus is the theme's focus ring, which the selected row's rule neither draws nor hides.
  expect(css).toContain('.row:focus-visible, .pill:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }');
  expect(css).not.toMatch(/\.row\.selected[^{]*\{[^}]*outline/);
  expect(css).not.toMatch(/\.row:(hover|focus)[^{]*\{[^}]*--sb-row-selected/);
});

it('keeps a phone list\'s selection on the open work item when Back returns to the list and the focus moves on', async () => {
  window.innerWidth = 700;
  const source = start([group('review', [row(1), row(2)])]);
  el('.row[data-row="item:1"]').click();
  await flush();
  source.emit('scope', { scope: { kind: 'page', key: 'k', folder: 'D:/scratch', title: 'Item', scopeGen: 1, conversations: [], workItemId: 1, cwd: 'D:/scratch', sessionId: null } });
  expect(root.classList.contains('listing')).toBe(false);
  el('[data-action="back"]').click();
  expect(root.classList.contains('listing')).toBe(true);
  expect(document.activeElement).toBe(el('.row.selected'));
  expect(el('.row.selected').dataset['row']).toBe('item:1');
  key(el('.row.selected'), 'ArrowDown');
  expect((document.activeElement as HTMLElement).dataset['row']).toBe('item:2');
  expect([...root.querySelectorAll<HTMLElement>('.row.selected, .row[aria-current="true"]')].map((one) => one.dataset['row'])).toEqual(['item:1']);
});

it('selects a conversation of the open work item\'s host group from its click, before its scope comes, and goes back to the open one when the hub refuses it', async () => {
  const source = start([group('review', [row(1), row(2)])]);
  const scope = (id: number) => ({ kind: 'page', key: 'k', folder: 'D:/scratch', title: 'Item', scopeGen: id, conversations: [{ workItemId: 1, title: 'Item 1', primary: true, sessionId: null, state: 'idle', conversation: 'full', unread: 0 }, { workItemId: 2, title: 'Item 2', primary: false, sessionId: null, state: 'idle', conversation: 'full', unread: 0 }], workItemId: id, cwd: 'D:/scratch', sessionId: null });
  source.emit('scope', { scope: scope(1) });
  const marked = (): Array<string | undefined> => [...root.querySelectorAll<HTMLElement>('.row.selected, .row[aria-current="true"]')].map((one) => one.dataset['row']);
  expect(marked()).toEqual(['item:1']);
  el('.row[data-row="item:2"]').focus();
  key(el('.row[data-row="item:2"]'), 'Enter');
  expect(marked()).toEqual(['item:2']);
  await flush();
  source.emit('scope', { scope: scope(2) });
  expect(marked()).toEqual(['item:2']);
  refused = true;
  el('.row[data-row="item:1"]').click();
  expect(marked()).toEqual(['item:1']);
  await flush();
  await flush();
  expect(marked()).toEqual(['item:2']);
});

it('selects the work item the hub shows by itself, as New session opens one, over the one the page last asked for', async () => {
  const source = start([group('review', [row(1), row(2), row(3)])]);
  const scope = (id: number) => ({ kind: 'page', key: 'k', folder: 'D:/scratch', title: 'Item', scopeGen: id, conversations: [], workItemId: id, cwd: 'D:/scratch', sessionId: null });
  el('.row[data-row="item:2"]').click();
  await flush();
  source.emit('hello', { key: 'pk', groups: [group('review', [row(1), row(2), row(3)])], scope: scope(2), sessions: [], items: [], more: false, status: null, artifacts: [] });
  expect(el('.row.selected').dataset['row']).toBe('item:2');
  source.emit('scope', { scope: scope(3) });
  expect([...root.querySelectorAll<HTMLElement>('.row.selected, .row[aria-current="true"]')].map((one) => one.dataset['row'])).toEqual(['item:3']);
});

it('keeps the latest choice under the shown head selected while a late scope of an earlier one, or of its earlier session, comes', async () => {
  const source = start([group('review', [row(1), row(2), row(3)])]);
  const conversations = [1, 2, 3].map((id) => ({ workItemId: id, title: `Item ${id}`, primary: id === 1, sessionId: null, state: 'idle', conversation: 'full', unread: 0 }));
  const scope = (id: number, gen = id) => ({ kind: 'page', key: 'k', folder: 'D:/scratch', title: 'Item', scopeGen: gen, conversations, workItemId: id, cwd: 'D:/scratch', sessionId: null });
  const marked = (): Array<string | undefined> => [...root.querySelectorAll<HTMLElement>('.row.selected, .row[aria-current="true"]')].map((one) => one.dataset['row']);
  source.emit('scope', { scope: scope(1) });
  let release!: () => void;
  gate = new Promise((done) => { release = done; });
  // 2, then 3 before 2's answer: 2's late scope leaves 3 selected.
  el('.row[data-row="item:2"]').click();
  el('.row[data-row="item:3"]').click();
  await flush();
  expect(marked()).toEqual(['item:3']);
  source.emit('scope', { scope: scope(2) });
  expect(marked()).toEqual(['item:3']);
  gate = null; release(); await flush(); await flush();
  source.emit('scope', { scope: scope(3) });
  expect(marked()).toEqual(['item:3']);
  // 1, then back to 3, the one shown: 1's late scope leaves 3 selected.
  gate = new Promise((done) => { release = done; });
  el('.row[data-row="item:1"]').click();
  el('.row[data-row="item:3"]').click();
  await flush();
  // Another event between them changes nothing.
  source.emit('list', { groups: [group('review', [row(1), row(2), row(3)])] });
  expect(marked()).toEqual(['item:3']);
  source.emit('scope', { scope: scope(1, 10) });
  expect(marked()).toEqual(['item:3']);
  gate = null; release(); await flush(); await flush();
  source.emit('scope', { scope: scope(3, 11) });
  expect(marked()).toEqual(['item:3']);
  // 2, then an earlier session of 3, the one shown, before 2's answer: 3 is selected, and stays after 2's late scope and 3's own.
  gate = new Promise((done) => { release = done; });
  el('.row[data-row="item:2"]').click();
  await flush();
  const earlier = document.createElement('button');
  earlier.dataset['action'] = 'select-session'; earlier.dataset['workItem'] = '3'; earlier.dataset['session'] = 'old';
  root.append(earlier);
  earlier.click();
  expect(marked()).toEqual(['item:3']);
  source.emit('scope', { scope: scope(2, 20) });
  expect(marked()).toEqual(['item:3']);
  gate = null; release(); await flush(); await flush();
  source.emit('scope', { scope: { ...scope(3, 21), sessionId: 'old', earlier: true } });
  expect(marked()).toEqual(['item:3']);
});

it('cycles F8 in list order through operator-turn rows, opens a closed group and clears a hiding search', async () => {
  start([group('review', [row(1, { dim: true }), row(2, { stripe: 'turn' }), row(6, { host: 'idle' })]), group('blocked', [row(3, { stripe: 'warning' })]), group('progress', [row(4, { stripe: 'turn' })]), group('unstarted', [row(5, { workItemId: null })])]);
  el('.group-head[data-group="review"]').click();
  el('[data-action="list-search"]').click();
  const search = el('.search-box') as HTMLInputElement;
  search.value = 'No match'; search.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 280));
  expect(root.querySelector('.row')).toBeNull();
  key(search, 'F8');
  expect(el('.row.selected').dataset['row']).toBe('item:2');
  expect(el('.group-head[data-group="review"]').getAttribute('aria-expanded')).toBe('true');
  expect(search.value).toBe('');
  await flush();
  key(el('.row.selected'), 'F8'); await flush();
  expect(el('.row.selected').dataset['row']).toBe('item:3');
  key(el('.row.selected'), 'F8'); await flush();
  expect(el('.row.selected').dataset['row']).toBe('item:2');
  key(el('.row.selected'), 'F8', { shiftKey: true }); await flush();
  expect(el('.row.selected').dataset['row']).toBe('item:3');
  expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).toEqual([2, 3, 2, 3]);
});

it('leaves F8 alone with modifiers or no eligible rows', () => {
  start([group('progress', [row(1)]), group('review', [row(2, { dim: true })])]);
  key(el('.row'), 'F8', { ctrlKey: true });
  key(el('.row'), 'F8');
  expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
});

it('keeps focus on a row moved between open groups, or the destination heading when closed, without stealing search focus', () => {
  const source = start([group('review', [row(1)]), group('progress', [row(2)]), group('done', [])]);
  el('.row').focus();
  source.emit('list', { groups: [group('review', []), group('progress', [row(2), row(1)]), group('done', [])] });
  expect(document.activeElement).toBe(el('.row[data-row="item:1"]'));
  source.emit('list', { groups: [group('review', []), group('progress', [row(2)]), group('done', [row(1, { band: 'Today' })])] });
  expect(document.activeElement).toBe(el('.group-head[data-group="done"]'));
  el('[data-action="list-search"]').click();
  const field = el('.search-box');
  field.focus();
  source.emit('list', { groups: [group('review', [row(1)]), group('progress', [row(2)])] });
  expect(document.activeElement).toBe(field);
});
