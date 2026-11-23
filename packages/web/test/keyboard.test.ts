import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PageGroup, PageRow } from '@switchboard/protocol';
import { startPage } from '../src/main.js';
import { drawAtOnce } from './frame.js';

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
  posts = []; opened = []; refused = false;
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

it('walks headings, rows and Done bands, selecting locally and revealing each row, with no wrap or modified arrows', () => {
  start([group('review', [row(1), row(2)]), group('done', [row(3, { band: 'Today' })])]);
  const reveal = vi.fn();
  HTMLElement.prototype.scrollIntoView = reveal;
  el('.group-head').focus();
  key(el('.group-head'), 'ArrowUp');
  expect(document.activeElement).toBe(el('.group-head'));
  key(el('.group-head'), 'ArrowDown');
  expect(document.activeElement).toBe(el('.row[data-row="item:1"]'));
  expect(el('.row.selected').dataset['row']).toBe('item:1');
  expect(reveal).toHaveBeenCalledWith({ block: 'nearest' });
  key(el('.row.selected'), 'ArrowDown', { altKey: true });
  expect(document.activeElement).toBe(el('.row.selected'));
  key(el('.row.selected'), 'ArrowDown');
  expect(el('.row.selected').dataset['row']).toBe('item:2');
  key(el('.row.selected'), 'ArrowDown');
  expect(document.activeElement).toBe(el('.group-head[data-group="done"]'));
  el('.group-head[data-group="done"]').click();
  key(el('.group-head[data-group="done"]'), 'ArrowDown');
  expect(document.activeElement).toBe(el('.band-head'));
  key(el('.band-head'), 'ArrowDown');
  expect(el('.row.selected').dataset['row']).toBe('item:3');
  key(el('.row.selected'), 'ArrowDown');
  expect(document.activeElement).toBe(el('.row.selected'));
  expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
  key(el('.row.selected'), 'Enter');
  expect(posts.filter((post) => post.url.endsWith('/select')).at(-1)?.body).toMatchObject({ workItemId: 3 });
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it('selects a row on focus and makes Tab reach its actions before its focusable link pills', () => {
  start([group('progress', [row(1, { url: 'https://example.test/1' }), row(2)])]);
  el('.row').focus();
  const selected = el('.row.selected');
  expect(selected.dataset['row']).toBe('item:1');
  expect(selected.firstElementChild).toBe(selected.querySelector('.row-actions'));
  expect(key(selected, 'Tab').defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(selected.querySelector('.row-actions'));
  const pill = el('.pill[role="link"]');
  expect(pill.tabIndex).toBe(0);
  pill.focus();
  key(pill, 'Enter');
  expect(opened).toEqual(['https://example.test/1']);
  expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
});

it.each(['ContextMenu', 'F10', 'right-click'])('opens a work-item menu with %s, walks it and returns focus with Escape', (method) => {
  start([group('progress', [row(1, { url: 'https://example.test/1' })])]);
  const target = el('.row');
  target.focus();
  if (method === 'right-click') target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  else key(target, method, { shiftKey: method === 'F10' });
  expect(el('.row-menu').textContent).toContain('Open ticket');
  expect(document.activeElement).toBe(el('.row-menu .menu-row'));
  key(document.activeElement as HTMLElement, 'ArrowDown');
  expect(document.activeElement?.closest('.row-menu')).not.toBeNull();
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
  key(el('.row.selected'), 'ContextMenu');
  el('.row.selected').click();
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
