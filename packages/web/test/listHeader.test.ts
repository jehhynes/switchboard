import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPage } from '../src/main.js';
import { bareKey, filterGroups, isKey, rangeSince, renderListHeader, SEARCH_DELAY_MS } from '../src/listHeader.js';
import { html } from './html.js';
import type { SearchView } from '../src/listHeader.js';
import type { PageGroup, PageHeader, PageRow, SourceGroup } from '@switchboard/protocol';
import { drawAtOnce } from './frame.js';

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

const listRow = (workItemId: number, patch: Partial<PageRow> = {}): PageRow => ({ workItemId, ticketId: null, title: `Item ${workItemId}`, priority: null, time: null, ticket: `gh ${workItemId}`, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], terminal: false, band: null, voice: null, history: null, ...patch });
const listGroup = (key: string, rows: PageRow[], patch: Partial<PageGroup> = {}): PageGroup => ({ key, title: key, glyph: '\u{ea70}', empty: null, rows, ...patch });
const github: SourceGroup = { kind: 'github', enabled: true, title: 'gh: polled\nClick to stop polling gh', sources: [{ name: 'gh', enabled: true }] };
const zoho: SourceGroup = { kind: 'zoho', enabled: true, title: 'desk: polled\nhelp: not polled\nClick to choose', sources: [{ name: 'desk', enabled: true }, { name: 'help', enabled: false }] };
const header = (patch: Partial<PageHeader> = {}): PageHeader => ({ notes: [], sources: [github, zoho], repoRoots: ['D:/w1'], folders: ['D:/w1', 'D:/git/support'], schedules: [], ...patch });
const closed = (): SearchView => ({ open: false, query: '', filter: '', range: 0, older: [], more: false, pending: false, error: null });

describe('the list header (architecture.md § Web page)', () => {
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let answers: Record<string, { status: number; body: unknown; wait?: Promise<void> }>;
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

  let reloads = 0;
  const start = (local?: boolean) => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const name = Object.keys(answers).find((one) => url.endsWith(one));
      const answer = name === undefined ? { status: 200, body: {} } : answers[name]!;

      await answer.wait;

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body, text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, reload: () => void reloads++, ...(local === undefined ? {} : { local }) });

    return { page, source: FakeSource.last! };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  const hello = (source: FakeSource, patch: Record<string, unknown> = {}) => source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], header: header(), scope: null, ...patch });

  it("draws each source kind's logo as the dock does, grey while off, with the hub's tooltip, and a tag for a kind without a logo", () => {
    const host = document.createElement('div');

    host.innerHTML = html(renderListHeader(header({ sources: [github, { ...zoho, enabled: false }, { kind: 'jira', enabled: true, title: 'jira: polled', sources: [{ name: 'jira', enabled: true }] }] }), { menu: null, notice: null, sheet: null, search: closed() }));

    const buttons = [...host.querySelectorAll<HTMLElement>('.source-toggle')];

    // The app's icon and name come first; page.css shows them only on a phone, where no window title names the app (the operator's decision).
    const title = host.querySelector('.list-header > .list-title:first-child');

    expect(title?.textContent).toBe('Switchboard');
    expect(title?.querySelector('img.list-title-icon')?.getAttribute('src')).toBe('icon-192.png');
    expect(title?.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(buttons.map((one) => one.getAttribute('aria-label'))).toEqual(['gh', 'zoho', 'jira']);
    expect(buttons[0]!.title).toBe('gh: polled\nClick to stop polling gh');
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1]!.getAttribute('aria-haspopup')).toBe('menu');
    expect(buttons[0]!.querySelector('svg.source-logo.github:not(.off)')).not.toBeNull();
    expect(buttons[1]!.querySelector('svg.source-logo.zoho.off')).not.toBeNull();
    expect(buttons[2]!.querySelector('.codicon-tag.source-logo')).not.toBeNull();
    // No sources, no icons.
    host.innerHTML = html(renderListHeader(header({ sources: [] }), { menu: null, notice: null, sheet: null, search: closed() }));
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

    const second = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => new Date(2026, 10, 21, 12).getTime() });
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

  const change = (selector: string, value: string | boolean) => {
    const field = root.querySelector<HTMLInputElement>(selector)!;

    if (typeof value === 'boolean') {
      field.checked = value;
    } else {
      field.value = value;
    }

    field.dispatchEvent(new Event(field.tagName === 'SELECT' || field.type === 'checkbox' ? 'change' : 'input', { bubbles: true }));
  };
  const menuRows = () => [...root.querySelectorAll('.more-menu > li')].map((li) => (li.classList.contains('menu-separator') ? '-' : li.textContent));

  it("lists More Actions in the dock's groups, the sources first for a phone", async () => {
    const { page, source } = start();

    hello(source);
    click('.more-actions');
    expect(root.querySelector('.more-actions')?.getAttribute('aria-expanded')).toBe('true');
    expect(menuRows()).toEqual(['gh', 'desk', 'help', '-', 'New ad-hoc session…', 'New conversation in a folder…', '-', 'Held sessions', '-', 'Refresh sources', 'Reload', 'Show hub log', 'Get the browser extension…', '-', 'Pair a device…', 'Open Settings']);
    // The source rows are the phone's: page.css hides them outside the phone's layout, where the icons are in the header.
    expect([...root.querySelectorAll('.more-menu .more-source')]).toHaveLength(4);
    expect(root.querySelector('.more-menu [data-source="help"]')?.getAttribute('aria-checked')).toBe('false');
    click('.more-menu [data-source="help"]');
    await flush();
    expect(posts.at(-1)).toMatchObject({ url: '/v1/conversation/page-source', body: { name: 'help', enabled: true } });
    expect(root.querySelector('.more-menu')).not.toBeNull();

    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ sources: [] }) });
    expect(menuRows()[0]).toBe('New ad-hoc session…');

    // Refresh sources polls; the hub's refusal shows under the header.
    answers['/page-poll'] = { status: 409, body: { error: 'Every source is off.' } };
    click('.more-menu [data-action="list-poll"]');
    await flush();
    await flush();
    expect(posts.at(-1)?.url).toBe('/v1/conversation/page-poll');
    expect(root.querySelector('.more-menu')).toBeNull();
    expect(root.querySelector('.list-notice')?.textContent).toBe('Every source is off.');

    // Reload reloads the page, for an installed app with no browser reload, and closes the menu.
    const before = reloads;

    click('.more-actions');
    click('.more-menu [data-action="list-reload"]');
    expect(reloads).toBe(before + 1);
    expect(root.querySelector('.more-menu')).toBeNull();

    // A dock window the page does not have yet says to use the dock.
    for (const [action, title] of [['list-later-held', 'Held sessions'], ['list-later-log', 'Show hub log']]) {
      click('.more-actions');
      click(`.more-menu [data-action="${action}"]`);
      expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe(title);
      expect(root.querySelector('#list-sheet .sheet-detail')?.textContent).toBe(`${title} is not on the web page yet. Use it from the dock.`);
      click('#list-sheet .sheet-button');
      expect(root.querySelector('#list-sheet .sheet')).toBeNull();
    }

    // Get the browser extension downloads this computer's copy and says how to load it unpacked (PRD R121).
    click('.more-actions');
    click('.more-menu [data-action="list-extension"]');
    expect(root.querySelector('.more-menu')).toBeNull();
    expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('Get the browser extension');
    expect(root.querySelector('#list-sheet a.sheet-button.primary')?.getAttribute('href')).toBe('/page/switchboard-extension.zip');
    expect(root.querySelector('#list-sheet a.sheet-button.primary')?.getAttribute('download')).toBe('switchboard-extension.zip');
    expect(root.querySelector('#list-sheet .sheet-detail')?.textContent).toContain('reaches Switchboard on this computer');
    expect([...root.querySelectorAll('#list-sheet .extension-steps li')].map((li) => li.textContent)).toEqual([
      'Download the extension and extract the zip.',
      'Open chrome://extensions in Chrome or edge://extensions in Edge, and turn on Developer mode.',
      'Select Load unpacked and choose the extracted switchboard-extension folder.',
    ]);
    expect(posts.map((one) => one.url)).not.toContain('/v1/conversation/page-extension');
    click('#list-sheet .sheet-button.secondary');
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();

    // Open Settings opens the page's Settings, which reads settings.json from the hub.
    click('.more-actions');
    click('.more-menu [data-action="list-settings"]');
    await flush();
    expect(root.querySelector('.more-menu')).toBeNull();
    expect(root.querySelector('.settings')).not.toBeNull();
    expect(posts.map((one) => one.url)).toContain('/v1/conversation/page-settings-read');
    // The page under Settings takes no focus or clicks until Settings closes.
    expect(root.querySelector<HTMLElement>('.side')?.closest<HTMLElement>('[inert]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('.settings-close')!.click();
    expect(root.querySelector('.settings')).toBeNull();
    expect(root.querySelector('[inert]')).toBeNull();

    page.close();
  });

  it("reads settings.json again on the hub's config event: an untouched page shows the file, and unsaved edits stay under the changed-on-disk warning (PRD R54)", async () => {
    const { page, source } = start();
    const read = (version: string, concurrency: number) => ({
      status: 200,
      body: { settings: { path: 'C:/s.json', version, value: { sessions: { concurrency } }, error: null }, permissionModes: ['auto'], codexPermissionModes: [], providers: ['claude'], templateVariables: [], sourceKinds: ['github'], inUse: {}, enabled: {}, configDir: 'C:/c' },
    });
    const concurrency = () => root.querySelector<HTMLInputElement>('[data-path="sessions.concurrency"] input')!;

    answers['/page-settings-check'] = { status: 200, body: { errors: [] } };
    answers['/page-settings-read'] = read('v1', 2);
    hello(source);
    click('.more-actions');
    click('.more-menu [data-action="list-settings"]');
    await flush();
    await flush();
    root.querySelector<HTMLButtonElement>('.settings-nav-entry')!.click();
    await flush();
    expect(concurrency().value).toBe('2');

    answers['/page-settings-read'] = read('v2', 4);
    source.emit('config', {});
    await flush();
    await flush();
    expect(concurrency().value).toBe('4');
    expect(root.querySelector('.settings-warning')).toBeNull();

    concurrency().value = '5';
    concurrency().dispatchEvent(new Event('input', { bubbles: true }));
    answers['/page-settings-read'] = read('v3', 6);
    source.emit('config', {});
    await flush();
    await flush();
    expect(concurrency().value).toBe('5');
    expect(root.querySelector('.settings-warning')?.textContent).toBe('settings.json changed on disk, so your changes cannot be saved. Discard them and open Settings again to load it.');
    expect(root.querySelector<HTMLButtonElement>('.settings-bar .sheet-button.primary')!.disabled).toBe(true);

    page.close();
  });

  it("shows the last work item that started needing the operator under the header, opens it on a click, and hides it after 10 s off the pointer (PRD R65)", async () => {
    vi.useFakeTimers();
    const { source } = start();

    hello(source, { groups: [listGroup('blocked', [listRow(1), listRow(2)])] });
    source.emit('needs', { items: [{ workItemId: 1, message: 'gh 1 is waiting for your answer.' }, { workItemId: 2, message: 'gh 2 asks for permission.' }] });
    expect(root.querySelector('.needs-message')?.textContent).toBe('gh 2 asks for permission.');
    // The pointer on it keeps it; off it, 10 s hide it.
    root.querySelector('.needs-message')!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(15_000);
    expect(root.querySelector('.needs-toast')).not.toBeNull();
    root.querySelector('.side-head')!.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(9_000);
    expect(root.querySelector('.needs-toast')).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(root.querySelector('.needs-toast')).toBeNull();

    // A click on the message opens its work item and clears it; Dismiss only clears.
    source.emit('needs', { items: [{ workItemId: 1, message: 'gh 1 is waiting for your answer.' }] });
    click('.needs-message');
    expect(root.querySelector('.needs-toast')).toBeNull();
    expect(location.hash).toBe('#w=1');
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.filter((one) => one.url.endsWith('/select')).map((one) => one.body['workItemId'])).toEqual([1]);
    source.emit('needs', { items: [{ workItemId: 2, message: 'gh 2 asks for permission.' }] });
    click('[data-action="list-needs-dismiss"]');
    expect(root.querySelector('.needs-toast')).toBeNull();
    expect(location.hash).toBe('#w=1');
  });

  it("shows the dock's notes under the header in the warning colour, and the held-session note, which opens what Held sessions opens", () => {
    const { source } = start();

    hello(source);
    expect(root.querySelector('.list-note')).toBeNull();
    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ notes: ['Settings: settings.json is not valid JSON.', 'Voice: the voice process stopped.'], heldNote: '1 held session without a work item' }) });
    expect([...root.querySelectorAll('p.list-note')].map((note) => note.textContent)).toEqual(['Settings: settings.json is not valid JSON.', 'Voice: the voice process stopped.']);
    expect(root.querySelector('button.held-note')?.textContent).toBe('1 held session without a work item');
    click('button.held-note');
    expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('Held sessions');
    // The notes leave with the hub's next list that has none.
    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header() });
    expect(root.querySelector('.list-note')).toBeNull();
  });

  it('offers Voice on the computer on this computer\'s page only while the voice is not here, and says why it did not move (PRD R119)', async () => {
    const { page, source } = start(true);

    hello(source);
    click('.more-actions');
    expect(root.querySelector('[data-action="list-voice-computer"]')).toBeNull();
    click('.more-actions');
    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ voiceDevice: 'phone' }) });
    click('.more-actions');
    expect(menuRows().at(-1)).toBe('Voice on the computer');
    expect(root.querySelector('[data-action="list-voice-computer"]')?.getAttribute('title')).toContain('on a paired device');
    answers['/page-voice-computer'] = { status: 409, body: { error: 'Voice is off (voice.enabled).' } };
    click('.more-menu [data-action="list-voice-computer"]');
    await flush();
    await flush();
    expect(posts.filter((one) => one.url === '/v1/conversation/page-voice-computer')).toHaveLength(1);
    expect(root.querySelector('.more-menu')).toBeNull();
    expect(root.textContent).toContain('Voice is off (voice.enabled).');
    page.close();

    // A paired device's page never offers it.
    const remote = start(false);

    hello(remote.source);
    remote.source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ voiceDevice: 'none' }) });
    click('.more-actions');
    expect(root.querySelector('[data-action="list-voice-computer"]')).toBeNull();
    remote.page.close();
  });

  it('pairs a device from this computer with a QR code and a code, lists the signed-in devices and signs one out, and offers none of it on a paired device (architecture.md § Remote access)', async () => {
    const remote = start(false);

    hello(remote.source);
    click('.more-actions');
    // Settings stays on this computer too; the menu ends with Voice on this device, off until tapped.
    expect(menuRows().slice(-7)).toEqual(['-', 'Refresh sources', 'Reload', 'Show hub log', 'Get the browser extension…', '-', 'Voice on this device']);
    expect(root.querySelector('[data-action="list-phone-voice"]')?.getAttribute('aria-checked')).toBe('false');
    expect(root.querySelector('[data-action="list-settings"]')).toBeNull();
    // A paired device's copy reaches the hub through this page, so it is loaded in this browser (PRD R121).
    click('.more-menu [data-action="list-extension"]');
    expect(root.querySelector('#list-sheet .sheet-detail')?.textContent).toContain('signed in as this browser is, so load it in this browser');
    click('#list-sheet .sheet-button.secondary');
    remote.page.close();

    const { page, source } = start(true);
    const pairing = { url: `https://pc.tail.ts.net/page?t=${'a'.repeat(64)}`, code: 'ABCD-EFGH', host: 'pc.tail.ts.net', expiresAt: 10_000 + 5 * 60_000 };
    const phone = { id: '0123abcd', label: 'Android · Chrome', host: 'pc.tail.ts.net', login: 'alex@example.com', createdAt: 1, usedAt: 1_700_000_000_000, current: false };
    const own = { id: '89abcdef', label: 'Windows · Edge', host: null, login: null, createdAt: 1, usedAt: 1_700_000_000_000, current: true };

    answers['/page-pair'] = { status: 200, body: pairing };
    answers['/page-devices'] = { status: 200, body: { devices: [phone, own] } };
    hello(source);
    click('.more-actions');
    click('.more-menu [data-action="list-devices"]');
    await flush();
    await flush();

    const sheet = root.querySelector('#list-sheet .sheet')!;

    expect(sheet.querySelector('.sheet-title')?.textContent).toBe('Pair a device');
    expect(sheet.querySelector('svg.pair-qr path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(sheet.querySelector('.pair-code')?.textContent).toBe('ABCD-EFGH');
    expect(sheet.textContent).toContain('open https://pc.tail.ts.net/ on it and type this code');
    expect(sheet.textContent).toContain('It works once, for 5 more minutes.');
    expect([...sheet.querySelectorAll('.device-name')].map((one) => one.textContent)).toEqual(['Android · Chrome', 'Windows · Edge (this browser)']);
    expect(sheet.querySelector('.device-detail')?.textContent).toMatch(/^pc\.tail\.ts\.net as alex@example\.com · last used /);
    expect([...sheet.querySelectorAll('.device-detail')][1]?.textContent).toMatch(/^This computer · last used /);
    // This computer's page offers no voice of its own, and only a paired device has Allow voice.
    expect(root.querySelector('[data-action="list-phone-voice"]')).toBeNull();
    expect([...sheet.querySelectorAll('[data-action="list-device-voice"]')].map((one) => [(one as HTMLElement).dataset['id'], one.textContent])).toEqual([['0123abcd', 'Allow voice']]);

    // Allow voice posts the device's ID and lists the devices again, which then say so.
    answers['/page-devices'] = { status: 200, body: { devices: [{ ...phone, voice: true }, own] } };
    click('#list-sheet [data-action="list-device-voice"][data-id="0123abcd"]');
    await flush();
    await flush();
    expect(posts.filter((one) => one.url === '/v1/conversation/page-device-voice').map((one) => [one.body['id'], one.body['allow']])).toEqual([['0123abcd', true]]);
    expect(root.querySelector('#list-sheet .device-detail')?.textContent).toMatch(/ · voice allowed$/);
    expect(root.querySelector('#list-sheet [data-action="list-device-voice"]')?.textContent).toBe('Forbid voice');
    click('#list-sheet [data-action="list-device-voice"][data-id="0123abcd"]');
    await flush();
    await flush();
    expect(posts.filter((one) => one.url === '/v1/conversation/page-device-voice').map((one) => one.body['allow'])).toEqual([true, false]);

    // Sign out posts the device's ID and lists the devices again.
    answers['/page-devices'] = { status: 200, body: { devices: [own] } };
    click('#list-sheet [data-action="list-device-revoke"][data-id="0123abcd"]');
    await flush();
    await flush();
    expect(posts.some((one) => one.url === '/v1/conversation/page-device-revoke' && one.body['id'] === '0123abcd')).toBe(true);
    expect(root.querySelectorAll('#list-sheet .device')).toHaveLength(1);

    // New code asks again; a refusal says why in the sheet and draws no code.
    answers['/page-pair'] = { status: 409, body: { error: 'Pairing a device needs remote access.' } };
    click('#list-sheet [data-action="list-sheet-go"]');
    await flush();
    await flush();
    expect(root.querySelector('#list-sheet .sheet-error')?.textContent).toBe('Pairing a device needs remote access.');
    expect(root.querySelector('#list-sheet .pair-qr')).toBeNull();
    click('#list-sheet .sheet-button.primary');
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();
    page.close();
  });

  it('shows the holder notice under the header, asks before Restart and resume, and shows the result until dismissed (architecture.md § Restarting the holder)', async () => {
    const { page, source } = start();
    const confirm = { question: 'Restart the terminal holder?', detail: 'This session is not idle, so the restart interrupts its turn: Issue <8> (gh 108).', action: 'Restart and resume' };
    const holderNotice = { text: 'The terminal holder is from an older build. Restart it to update (1 session will be resumed).', confirm };

    hello(source);
    expect(root.querySelector('.holder-notice')).toBeNull();

    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ holderNotice }) });
    expect(root.querySelector('.holder-notice-text')?.textContent).toBe(holderNotice.text);
    click('.holder-restart');
    expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('Restart the terminal holder?');
    expect(root.querySelector('#list-sheet .sheet-detail')?.textContent).toBe(confirm.detail);
    expect(document.activeElement?.textContent).toBe('Cancel');
    click('#list-sheet [data-action="list-sheet-cancel"].sheet-button');
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();
    expect(posts.filter((one) => one.url.endsWith('/page-holder-restart'))).toEqual([]);

    // A refusal stays in the sheet; a start closes it.
    answers['/page-holder-restart'] = { status: 409, body: { error: 'The terminal holder is already restarting.' } };
    click('.holder-restart');
    click('#list-sheet [data-action="list-sheet-go"]');
    await flush();
    await flush();
    expect(root.querySelector('#list-sheet .sheet-error')?.textContent).toBe('The terminal holder is already restarting.');
    answers['/page-holder-restart'] = { status: 200, body: { started: true } };
    click('#list-sheet [data-action="list-sheet-go"]');
    await flush();
    await flush();
    expect(posts.filter((one) => one.url === '/v1/conversation/page-holder-restart').map((one) => one.body['detail'])).toEqual([confirm.detail, confirm.detail]);
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();

    // While it runs there is nothing to press; the result shows until dismissed, and a later one shows again.
    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ holderNotice: { text: 'Restarting the terminal holder and resuming its sessions…', confirm: null } }) });
    expect(root.querySelector('.holder-restart')).toBeNull();

    const holderResult = { at: 5, text: 'The terminal holder restarted and 1 session resumed. 1 session did not resume: gh 109: Claude Code did not start.', failed: true };

    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ holderResult }) });
    expect(root.querySelector('.holder-notice')).toBeNull();
    expect(root.querySelector('.holder-result.failed .holder-result-text')?.textContent).toBe(holderResult.text);
    click('[data-action="list-holder-dismiss"]');
    expect(root.querySelector('.holder-result')).toBeNull();
    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ holderResult }) });
    expect(root.querySelector('.holder-result')).toBeNull();
    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ holderResult: { at: 6, text: 'The terminal holder restarted.', failed: false } }) });
    expect(root.querySelector('.holder-result:not(.failed)')?.textContent).toBe('The terminal holder restarted.');

    page.close();
  });

  it('shows the holder notice on a paired device without Restart and resume (architecture.md § Remote access)', () => {
    const { page, source } = start(false);
    const holderNotice = { text: 'The terminal holder is from an older build. Restart it to update (1 session will be resumed).', confirm: { question: 'Restart the terminal holder?', detail: 'No session is interrupted.', action: 'Restart and resume' } };

    hello(source, { header: header({ holderNotice }) });
    expect(root.querySelector('.holder-notice-text')?.textContent).toBe(holderNotice.text);
    expect(root.querySelector('.holder-restart')).toBeNull();
    page.close();
  });

  it("creates an ad-hoc work item from New ad-hoc session as the dock's window does, keeping a refusal in the sheet, or runs a schedule", async () => {
    const { page, source } = start();

    answers['/providers'] = { status: 200, body: { defaultProvider: 'codex', installed: ['claude', 'codex'] } };
    hello(source, { header: header({ schedules: [{ name: 'nightly', playbook: 'dev:sweep' }] }) });
    click('.more-actions');
    click('[data-action="list-adhoc"]');
    await flush();
    await flush();
    expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('New ad-hoc session');
    expect(root.querySelector<HTMLSelectElement>('[data-field="repo"]')!.value).toBe('D:/w1');
    expect([...root.querySelectorAll('[data-field="repo"] option')].map((one) => one.textContent)).toEqual(['D:/w1', 'D:/git/support']);
    expect(root.querySelector<HTMLSelectElement>('[data-field="provider"]')!.value).toBe('codex');
    expect([...root.querySelectorAll('[data-field="schedule"] option')].map((one) => one.textContent)).toEqual(['A prompt', 'Run nightly now · dev:sweep']);
    expect(root.querySelector<HTMLButtonElement>('[data-action="list-sheet-go"]')!.disabled).toBe(true);
    change('[data-field="prompt"]', 'Look around');
    change('[data-field="repo"]', 'D:/git/support');
    change('[data-field="start"]', true);
    expect(root.querySelector<HTMLButtonElement>('[data-action="list-sheet-go"]')!.disabled).toBe(false);

    answers['/page-adhoc'] = { status: 409, body: { error: 'Code Mode sessions need hooks.' } };
    click('[data-action="list-sheet-go"]');
    await flush();
    await flush();
    const sent = posts.filter((post) => post.url.endsWith('/page-adhoc'));

    expect(sent[0]?.body).toMatchObject({ window: 'pk', prompt: 'Look around', repoRoot: 'D:/git/support', start: true, provider: 'codex' });
    expect(root.querySelector('#list-sheet .sheet-error')?.textContent).toBe('Code Mode sessions need hooks.');
    expect(root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value).toBe('Look around');

    // A retry is the same request, so the hub creates once.
    answers['/page-adhoc'] = { status: 200, body: { done: true } };
    click('[data-action="list-sheet-go"]');
    await flush();
    await flush();
    const retried = posts.filter((post) => post.url.endsWith('/page-adhoc'));

    expect(retried[1]?.body['opId']).toBe(sent[0]?.body['opId']);
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();

    // The next one offers the repository used last, and can run a schedule instead.
    click('.more-actions');
    click('[data-action="list-adhoc"]');
    await flush();
    expect(root.querySelector<HTMLSelectElement>('[data-field="repo"]')!.value).toBe('D:/git/support');
    change('[data-field="schedule"]', 'nightly');
    expect(root.querySelector('[data-field="prompt"]')).toBeNull();
    expect(root.querySelector('[data-action="list-sheet-go"]')?.textContent).toBe('Run');
    click('[data-action="list-sheet-go"]');
    await flush();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/page-adhoc')).at(-1)?.body).toMatchObject({ schedule: 'nightly' });
    expect(posts.filter((post) => post.url.endsWith('/page-adhoc')).at(-1)?.body).not.toHaveProperty('prompt');

    // A provider picked while the hub answers stays picked.
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => void (release = resolve));
    answers['/providers'] = { status: 200, body: { defaultProvider: 'codex', installed: ['claude', 'codex'] }, wait: slow };
    click('.more-actions');
    click('[data-action="list-adhoc"]');
    change('[data-field="provider"]', 'claude');
    release();
    await flush();
    await flush();
    expect(root.querySelector<HTMLSelectElement>('[data-field="provider"]')!.value).toBe('claude');
    click('[data-action="list-sheet-cancel"]');

    // Providers the hub could not list leave Claude, and say so.
    answers['/providers'] = { status: 500, body: { error: 'The hub is busy.' } };
    click('.more-actions');
    click('[data-action="list-adhoc"]');
    await flush();
    await flush();
    expect(root.querySelector<HTMLSelectElement>('[data-field="provider"]')!.value).toBe('claude');
    expect(root.querySelector('.sheet-field .sheet-error')?.textContent).toBe('The hub is busy. Using Claude.');
    root.querySelector('#list-sheet .sheet')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();
    page.close();
  });

  it('starts a conversation in a folder the hub knows, asking for the provider only when both are installed, and opens it', async () => {
    const { page, source } = start();

    answers['/providers'] = { status: 200, body: { defaultProvider: 'codex', installed: ['claude', 'codex'] } };
    answers['/page-folder-conversation'] = { status: 200, body: { workItemId: 9, folder: 'D:/git/support' } };
    hello(source);
    click('.more-actions');
    click('[data-action="list-folder"]');
    await flush();
    await flush();
    expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('New conversation in a folder');
    expect([...root.querySelectorAll('[data-field="folder"] option')].map((one) => one.textContent)).toEqual(['Choose a folder', 'D:/w1', 'D:/git/support']);
    expect(root.querySelector<HTMLSelectElement>('[data-field="provider"]')!.value).toBe('codex');
    expect(root.querySelector<HTMLButtonElement>('[data-action="list-sheet-go"]')!.disabled).toBe(true);
    change('[data-field="folder"]', 'D:/git/support');
    change('[data-field="provider"]', 'claude');
    click('[data-action="list-sheet-go"]');
    await flush();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/page-folder-conversation'))?.body).toMatchObject({ window: 'pk', folder: 'D:/git/support', provider: 'claude' });
    expect(posts.filter((post) => post.url.endsWith('/select')).at(-1)?.body['workItemId']).toBe(9);
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();

    // One provider installed: nothing to choose.
    answers['/providers'] = { status: 200, body: { defaultProvider: 'claude', installed: ['codex'] } };
    answers['/page-folder-conversation'] = { status: 400, body: { error: 'D:/w1 is not a folder the page offers.' } };
    click('.more-actions');
    click('[data-action="list-folder"]');
    await flush();
    await flush();
    expect(root.querySelector('[data-field="provider"]')).toBeNull();
    change('[data-field="folder"]', 'D:/w1');
    click('[data-action="list-sheet-go"]');
    await flush();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/page-folder-conversation')).at(-1)?.body).toMatchObject({ folder: 'D:/w1', provider: 'codex' });
    expect(root.querySelector('#list-sheet .sheet-error')?.textContent).toBe('D:/w1 is not a folder the page offers.');
    // A press on the backdrop closes it; one on the sheet does not.
    root.querySelector<HTMLElement>('#list-sheet .sheet')!.click();
    expect(root.querySelector('#list-sheet .sheet')).not.toBeNull();
    root.querySelector<HTMLElement>('#list-sheet .sheet-backdrop')!.click();
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();
    page.close();
  });
});
