import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPage } from '../src/main.js';
import { bareKey, filterGroups, isKey, rangeSince, renderListHeader, SEARCH_DELAY_MS } from '../src/listHeader.js';
import type { SearchView } from '../src/listHeader.js';
import type { PageGroup, PageHeader, PageRow, SourceGroup } from '../src/types.js';

class FakeSource {
  static last: FakeSource | null = null;
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(readonly url: string) {
    FakeSource.last = this;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify({ type, ...(data as object) }) });
    }
  }

  close(): void {}
}

const listRow = (workItemId: number, patch: Partial<PageRow> = {}): PageRow => ({ workItemId, title: `Item ${workItemId}`, priority: null, time: null, ticket: `gh ${workItemId}`, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, ...patch });
const listGroup = (key: string, rows: PageRow[], patch: Partial<PageGroup> = {}): PageGroup => ({ key, title: key, glyph: '\u{ea70}', empty: null, rows, ...patch });
const github: SourceGroup = { kind: 'github', enabled: true, title: 'gh: polled\nClick to stop polling gh', sources: [{ name: 'gh', enabled: true }] };
const zoho: SourceGroup = { kind: 'zoho', enabled: true, title: 'desk: polled\nhelp: not polled\nClick to choose', sources: [{ name: 'desk', enabled: true }, { name: 'help', enabled: false }] };
const header = (patch: Partial<PageHeader> = {}): PageHeader => ({ sources: [github, zoho], ...patch });
const closed = (): SearchView => ({ open: false, query: '', filter: '', range: 0, older: [], more: false, pending: false, error: null });

describe('the list header (architecture.md § Web page)', () => {
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let answers: Record<string, { status: number; body: unknown }>;
  let root: HTMLElement;

  beforeEach(() => {
    posts = [];
    answers = {};
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const start = () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const name = Object.keys(answers).find((one) => url.endsWith(one));
      const answer = name === undefined ? { status: 200, body: {} } : answers[name]!;

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body, text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });

    return { page, source: FakeSource.last! };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  const hello = (source: FakeSource, patch: Record<string, unknown> = {}) => source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], header: header(), scope: null, ...patch });

  it("draws each source kind's logo as the dock does, grey while off, with the hub's tooltip, and a tag for a kind without a logo", () => {
    const host = document.createElement('div');

    host.innerHTML = renderListHeader(header({ sources: [github, { ...zoho, enabled: false }, { kind: 'jira', enabled: true, title: 'jira: polled', sources: [{ name: 'jira', enabled: true }] }] }), { menu: null, notice: null, search: closed() });

    const buttons = [...host.querySelectorAll<HTMLElement>('.source-toggle')];

    expect(host.querySelector('.list-title')?.textContent).toBe('Switchboard');
    expect(buttons.map((one) => one.getAttribute('aria-label'))).toEqual(['gh', 'zoho', 'jira']);
    expect(buttons[0]!.title).toBe('gh: polled\nClick to stop polling gh');
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1]!.getAttribute('aria-haspopup')).toBe('menu');
    expect(buttons[0]!.querySelector('svg.source-logo.github:not(.off)')).not.toBeNull();
    expect(buttons[1]!.querySelector('svg.source-logo.zoho.off')).not.toBeNull();
    expect(buttons[2]!.querySelector('.codicon-tag.source-logo')).not.toBeNull();
    // No sources, no icons.
    host.innerHTML = renderListHeader({ sources: [] }, { menu: null, notice: null, search: closed() });
    expect(host.querySelector('.header-sources')).toBeNull();
  });

  it("turns a kind's one source on or off with a click, opens a check menu for several that stays open, and shows a refusal under the header", async () => {
    const { page, source } = start();

    hello(source);
    click('.source-toggle[data-kind="github"]');
    await flush();
    expect(posts.at(-1)).toMatchObject({ url: '/v1/conversation/page-source', body: { window: 'pk', name: 'gh', enabled: false } });
    expect(root.querySelector('.source-menu')).toBeNull();

    click('.source-toggle[data-kind="zoho"]');
    expect([...root.querySelectorAll('.source-menu .menu-row')].map((row) => [row.textContent, row.getAttribute('aria-checked')])).toEqual([['desk', 'true'], ['help', 'false']]);
    click('.source-menu [data-source="help"]');
    await flush();
    expect(posts.at(-1)?.body).toMatchObject({ name: 'help', enabled: true });
    // The menu stays open, and its check follows the hub's next list.
    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ sources: [github, { ...zoho, sources: [{ name: 'desk', enabled: true }, { name: 'help', enabled: true }] }] }) });
    expect(root.querySelector('.source-menu [data-source="help"]')?.getAttribute('aria-checked')).toBe('true');

    answers['/page-source'] = { status: 409, body: { error: 'No source is named help.' } };
    click('.source-menu [data-source="help"]');
    await flush();
    await flush();
    expect(root.querySelector('.list-notice')?.textContent).toBe('No source is named help.');
    click('[data-action="list-dismiss"]');
    expect(root.querySelector('.list-notice')).toBeNull();

    // Escape closes the menu and gives the focus back to its icon; a press outside closes it too.
    root.querySelector<HTMLElement>('.source-menu .menu-row')!.focus();
    root.querySelector('.source-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.source-menu')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('.source-toggle[data-kind="zoho"]'));
    click('.source-toggle[data-kind="zoho"]');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.source-menu')).toBeNull();
    page.close();
  });

  const input = (text: string) => {
    const box = root.querySelector<HTMLInputElement>('.search-box')!;

    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  };
  const titles = () => [...root.querySelectorAll('#list .group')].map((group) => [group.getAttribute('data-group'), [...group.querySelectorAll('.row-title')].map((title) => title.textContent)]);
  const searchHello = (source: FakeSource) =>
    hello(source, {
      groups: [
        listGroup('progress', [listRow(1, { title: 'Fix the inbox', search: 'Fix the inbox · gh 1 · dev:build · In progress' }), listRow(2, { title: 'Quotes', search: 'Quotes · gh 2 · PR #19002 · dev:plan · In progress', links: [{ label: 'PR #19002', url: 'u', kind: 'pr', badge: '19002', glyph: null, mentioned: false }] })]),
        listGroup('done', [listRow(3, { title: 'Old inbox fix', search: 'Old inbox fix · gh 3 · Done' })]),
      ],
    });

  it('reads keys and words, and searches Done rows from the hub after the Done list, every group with a match shown and the rest left out', () => {
    expect(bareKey('gh 18941')).toBe('18941');
    expect(bareKey('PR #19002')).toBe('19002');
    expect(bareKey('#107')).toBe('107');
    const groups = [listGroup('progress', [listRow(1, { search: 'Fix the inbox · gh 1', links: [{ label: 'PR #5', url: 'u', kind: 'pr', badge: '5', glyph: null, mentioned: false }] })]), listGroup('done', [listRow(3, { search: 'Old · gh 3' })])];

    expect(isKey('#107', groups)).toBe(true);
    expect(isKey('pr #5', groups)).toBe(true);
    expect(isKey('gh x', groups)).toBe(false);
    expect(filterGroups(groups, '', [])).toEqual(groups);
    expect(filterGroups(groups, 'INBOX fix', []).map((group) => [group.key, group.rows.map((row) => row.workItemId)])).toEqual([['progress', [1]]]);
    // A row the hub found is listed after Done's own, once.
    expect(filterGroups(groups, 'gh', [listRow(3, { search: 'Old · gh 3' }), listRow(9, { search: 'Older · gh 9' })]).map((group) => [group.key, group.rows.map((row) => row.workItemId)])).toEqual([['progress', [1]], ['done', [3, 9]]]);
    const now = new Date(2026, 10, 21, 12).getTime();

    expect(rangeSince(1, now)).toBe(new Date(2026, 9, 21, 12).getTime());
    expect(rangeSince(2, now)).toBe(new Date(2026, 7, 21, 12).getTime());
    expect(rangeSince(3, now)).toBe(0);
    // A day the month back lacks is its last day, as the dock's AddMonths.
    expect(rangeSince(1, new Date(2026, 2, 31, 12).getTime())).toBe(new Date(2026, 1, 28, 12).getTime());
    expect(rangeSince(2, new Date(2026, 4, 31, 12).getTime())).toBe(new Date(2026, 1, 28, 12).getTime());
  });

  it('searches 250 ms after the last key from 3 characters and at once for a key, opening Done for a match and hiding groups without one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, source } = start();

    searchHello(source);
    expect(titles()).toEqual([['progress', ['Fix the inbox', 'Quotes']], ['done', []]]);
    click('.search-toggle');
    expect(document.activeElement).toBe(root.querySelector('.search-box'));
    expect(root.querySelector('.search-range')?.textContent).toBe('Last 2 weeks');
    input('in');
    vi.advanceTimersByTime(SEARCH_DELAY_MS);
    expect(titles()).toHaveLength(2);
    input('inbox');
    vi.advanceTimersByTime(SEARCH_DELAY_MS - 1);
    expect(titles()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(titles()).toEqual([['progress', ['Fix the inbox']], ['done', ['Old inbox fix']]]);
    // Two weeks is the list the page has: nothing is asked of the hub.
    expect(posts.some((post) => post.url.endsWith('/page-search'))).toBe(false);
    // A key searches at once, a link's too.
    input('PR #19002');
    expect(titles()).toEqual([['progress', ['Quotes']]]);
    input('zzz');
    vi.advanceTimersByTime(SEARCH_DELAY_MS);
    expect(titles()).toEqual([]);
    expect(root.querySelector('.search-none')?.textContent).toBe('No matches for “zzz” in the last 2 weeks.');
    expect([...root.querySelectorAll('.search-links button')].map((button) => button.textContent)).toEqual(['Search further back', 'All time', 'Clear search']);
    click('.search-links [data-action="list-search-clear"]');
    expect(root.querySelector<HTMLInputElement>('.search-box')!.value).toBe('');
    expect(titles()).toEqual([['progress', ['Fix the inbox', 'Quotes']], ['done', []]]);
    // Escape closes the box, which clears the search.
    input('#2');
    expect(titles()).toEqual([['progress', ['Quotes']]]);
    root.querySelector('.search-box')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.search-box')).toBeNull();
    expect(titles()).toHaveLength(2);
    page.close();
  });

  it('asks the hub for older Done rows when the range reaches back, drops an answer a newer search replaced, and shows Searching… and refusals', async () => {
    const { page, source } = start();
    const releases: Array<() => void> = [];
    const replies: Array<{ status: number; body: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      const reply = url.endsWith('/page-search') ? await new Promise<{ status: number; body: unknown }>((resolve) => releases.push(() => resolve(replies.shift()!))) : { status: 200, body: {} };

      return { status: reply.status, ok: reply.status === 200, json: async () => reply.body } as unknown as Response;
    });

    page.close();
    root.replaceChildren();

    const second = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => new Date(2026, 10, 21, 12).getTime() });
    const stream = FakeSource.last!;

    searchHello(stream);
    click('.search-toggle');
    input('#3');
    click('.search-range');
    expect([...root.querySelectorAll('.range-menu .menu-row')].map((row) => [row.textContent, row.getAttribute('aria-checked')])).toEqual([['Last 2 weeks', 'true'], ['Last month', 'false'], ['Last 3 months', 'false'], ['All time', 'false']]);
    click('.range-menu [data-range="1"]');
    expect(root.querySelector('.range-menu')).toBeNull();
    expect(root.querySelector('.search-range')?.textContent).toBe('Last month');
    expect(posts.at(-1)).toMatchObject({ url: '/v1/conversation/page-search', body: { window: 'pk', text: '3', since: new Date(2026, 9, 21, 12).getTime() } });
    expect(root.querySelector('.search-note')?.textContent).toBe('Searching…');
    // No "No matches" while the hub searches.
    input('#4');
    expect(root.querySelector('.search-none')).toBeNull();
    replies.push({ status: 200, body: { rows: [listRow(30, { title: 'Late answer', search: 'gh 30' })], more: false } });
    replies.push({ status: 200, body: { rows: [listRow(40, { title: 'Older work', search: 'Older work · gh 4' })], more: true } });
    releases.shift()!();
    await settle();
    expect(root.textContent).not.toContain('Late answer');
    releases.shift()!();
    await settle();
    expect(titles()).toEqual([['done', ['Older work']]]);
    expect(root.querySelector('.search-note')?.textContent).toBe('Showing the newest 1 matches from before the last 2 weeks. Add words to narrow the search.');
    // An older row's key is a key too: it searches at once.
    replies.push({ status: 200, body: { rows: [listRow(40, { title: 'Older work', ticket: 'zd 4077', search: 'Older work · zd 4077' })], more: false } });
    input('older');
    await new Promise((resolve) => setTimeout(resolve, 300));
    releases.shift()!();
    await settle();
    input('zd 4077');
    expect(posts.filter((post) => post.url.endsWith('/page-search')).at(-1)?.body['text']).toBe('zd 4077');
    replies.push({ status: 200, body: { rows: [listRow(40, { title: 'Older work', ticket: 'zd 4077', search: 'Older work · zd 4077' })], more: false } });
    releases.shift()!();
    await settle();
    expect(titles()).toEqual([['done', ['Older work']]]);
    input('#4');
    replies.push({ status: 200, body: { rows: [listRow(40, { title: 'Older work', search: 'Older work · gh 4' })], more: true } });
    releases.shift()!();
    await settle();
    // Search further back widens the range one step; All time is the last.
    click('[data-action="list-search-further"]');
    expect(root.querySelector('.search-range')?.textContent).toBe('Last 3 months');
    replies.push({ status: 500, body: { error: 'disk full' } });
    releases.shift()!();
    await settle();
    expect(root.querySelector('.search-note')?.textContent).toBe('The hub could not search further back: disk full');
    click('[data-action="list-search-further"]');
    replies.push({ status: 200, body: { rows: [], more: false } });
    releases.shift()!();
    await settle();
    expect(root.querySelector('.search-none')?.textContent).toBe('No matches for “4”.');
    expect([...root.querySelectorAll('.search-links button')].map((button) => button.textContent)).toEqual(['Clear search']);
    // Closing the search drops its range.
    click('.search-toggle');
    click('.search-toggle');
    expect(root.querySelector('.search-range')?.textContent).toBe('Last 2 weeks');
    second.close();
  });
});
