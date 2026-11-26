import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPage } from '../src/main.js';
import { bareKey, filterGroups, FOLDER_CHECK_MS, isKey, OTHER_MODEL, rangeSince, renderListHeader, renderMoreMenu, RUN_AS_KEY, SEARCH_DELAY_MS } from '../src/listHeader.js';
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

const listRow = (workItemId: number, patch: Partial<PageRow> = {}): PageRow => ({ workItemId, ticketId: null, title: `Item ${workItemId}`, priority: null, time: null, ticket: `gh ${workItemId}`, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: null, ...patch });
const listGroup = (key: string, rows: PageRow[], patch: Partial<PageGroup> = {}): PageGroup => ({ key, title: key, glyph: '\u{ea70}', empty: null, rows, ...patch });
const github: SourceGroup = { kind: 'github', enabled: true, title: 'gh: polled\nClick to stop polling gh', sources: [{ name: 'gh', enabled: true }] };
const zoho: SourceGroup = { kind: 'zoho', label: 'Zoho Desk', enabled: true, title: 'desk: polled\nhelp: not polled\nClick to choose', sources: [{ name: 'desk', enabled: true }, { name: 'help', enabled: false }] };
const header = (patch: Partial<PageHeader> = {}): PageHeader => ({ notes: [], sources: [github, zoho], repoRoots: ['D:/w1'], schedules: [], ...patch });
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
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  const hello = (source: FakeSource, patch: Record<string, unknown> = {}) => source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], header: header(), scope: null, ...patch });

  it("draws each source kind's logo, grey while off, with the hub's tooltip, and a plug for a kind without a logo", () => {
    const host = document.createElement('div');

    host.innerHTML = html(renderListHeader(header({ sources: [github, { ...zoho, enabled: false }, { kind: 'jira', enabled: true, title: 'jira: polled', sources: [{ name: 'jira', enabled: true }] }] }), { menu: null, sheet: null, search: closed() }));

    const buttons = [...host.querySelectorAll<HTMLElement>('.source-toggle')];

    // The app's icon and name come first; page.css shows them only on a phone, where no window title names the app (the operator's decision).
    const title = host.querySelector('.list-header > .list-title:first-child');

    expect(title?.textContent).toBe('Switchboard');
    expect(title?.querySelector('img.list-title-icon')?.getAttribute('src')).toBe('icon-192.png');
    expect(title?.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(buttons.map((one) => one.getAttribute('aria-label'))).toEqual(['gh', 'Zoho Desk', 'jira']);
    expect(buttons[0]!.title).toBe('gh: polled\nClick to stop polling gh');
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1]!.getAttribute('aria-haspopup')).toBe('menu');
    expect(buttons[0]!.querySelector('svg.source-logo.github:not(.off)')).not.toBeNull();
    expect(buttons[1]!.querySelector('svg.source-logo.zoho.off')).not.toBeNull();
    expect(buttons[2]!.querySelector('.codicon-plug.source-logo')).not.toBeNull();
    // No sources, no icons.
    host.innerHTML = html(renderListHeader(header({ sources: [] }), { menu: null, sheet: null, search: closed() }));
    expect(host.querySelector('.header-sources')).toBeNull();
  });

  it('draws a plugin path with its color and width in the header and phone menu, and grays disabled icons', () => {
    const icon = { viewBox: '0 0 24 24', path: 'M0 0H24V24H0Z', color: '#357abc', width: 24, fillRule: 'evenodd' as const };
    const sources = [{ kind: 'forum', label: 'Community', icon, enabled: true, title: 'forum', sources: [{ name: 'forum', enabled: true }] }];
    const host = document.createElement('div');

    host.innerHTML = html(renderListHeader(header({ sources }), { menu: null, sheet: null, search: closed() }));
    const svg = host.querySelector<SVGElement>('svg.source-logo.custom')!;
    expect(svg.getAttribute('viewBox')).toBe(icon.viewBox);
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(icon.path);
    expect(svg.querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd');
    expect(svg.style.getPropertyValue('--source-icon-color')).toBe(icon.color);
    expect(svg.style.getPropertyValue('--source-icon-width')).toBe('24px');
    expect(svg.classList.contains('off')).toBe(false);

    host.innerHTML = html(renderListHeader(header({ sources: [{ ...sources[0]!, enabled: false }] }), { menu: null, sheet: null, search: closed() }));
    expect(host.querySelector('svg.source-logo.custom.off path')?.getAttribute('d')).toBe(icon.path);

    host.innerHTML = html(renderMoreMenu(header({ sources: [{ ...sources[0]!, sources: [{ name: 'forum', enabled: false }] }] })));
    expect(host.querySelector('svg.source-logo.custom.off path')?.getAttribute('d')).toBe(icon.path);
  });

  it("turns a kind's one source on or off with a click, opens a check menu for several that stays open, and shows a refusal in the toast", async () => {
    const { page, source } = start();

    hello(source);
    click('.source-toggle[data-kind="github"]');
    await flush();
    expect(posts.at(-1)).toMatchObject({ url: '/v1/conversation/page-source', body: { window: 'pk', name: 'gh', enabled: false } });
    expect(root.querySelector('.source-menu')).toBeNull();

    click('.source-toggle[data-kind="zoho"]');
    expect(root.querySelector('.source-menu')?.getAttribute('aria-label')).toBe('Zoho Desk sources');
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
    expect(root.querySelector('.toast.warning .toast-text')?.textContent).toBe('No source is named help.');
    click('[data-action="toast-dismiss"]');
    expect(root.querySelector('.toast')).toBeNull();

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
  // A request's answer takes a few more turns through the page's timeouts (request.ts).
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
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
    // A day the month back lacks is its last day.
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
    // The search goes after its pause.
    await vi.waitFor(() => expect(posts.filter((post) => post.url.endsWith('/page-search')).at(-1)?.body['text']).toBe('older'));
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

  it("lists More Actions in its groups, the sources first for a phone", async () => {
    const { page, source } = start();

    hello(source);
    click('.more-actions');
    expect(root.querySelector('.more-actions')?.getAttribute('aria-expanded')).toBe('true');
    expect(menuRows()).toEqual(['gh', 'desk', 'help', '-', 'Held sessions', '-', 'Refresh sources', 'Reload', 'Show hub log', 'Get the browser extension…', 'Download app shortcut…', '-', 'Pair a device…', 'Open Settings']);
    // The source rows are the phone's: page.css hides them outside the phone's layout, where the icons are in the header.
    expect([...root.querySelectorAll('.more-menu .more-source')]).toHaveLength(4);
    expect(root.querySelector('.more-menu [data-source="help"]')?.getAttribute('aria-checked')).toBe('false');
    click('.more-menu [data-source="help"]');
    await flush();
    expect(posts.at(-1)).toMatchObject({ url: '/v1/conversation/page-source', body: { name: 'help', enabled: true } });
    expect(root.querySelector('.more-menu')).not.toBeNull();

    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ sources: [] }) });
    expect(menuRows()[0]).toBe('Held sessions');

    // Refresh sources polls; the hub's refusal shows in the toast.
    answers['/page-poll'] = { status: 409, body: { error: 'Every source is off.' } };
    click('.more-menu [data-action="list-poll"]');
    await flush();
    await flush();
    expect(posts.at(-1)?.url).toBe('/v1/conversation/page-poll');
    expect(root.querySelector('.more-menu')).toBeNull();
    expect(root.querySelector('.toast.warning .toast-text')?.textContent).toBe('Every source is off.');

    // Reload reloads the page, for an installed app with no browser reload, and closes the menu.
    const before = reloads;

    click('.more-actions');
    click('.more-menu [data-action="list-reload"]');
    expect(reloads).toBe(before + 1);
    expect(root.querySelector('.more-menu')).toBeNull();

    click('.more-actions');
    click('.more-menu [data-action="list-log"]');
    expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('Hub log');
    expect(root.querySelector('[aria-label="Filter hub log"]')).not.toBeNull();
    click('#list-sheet [data-action="list-sheet-cancel"].sheet-button');

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
    // The toast stays live over it: a failure is read out and Dismiss works.
    expect(root.querySelector('#toast')?.closest('[inert]')).toBeNull();
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

  it("shows the last work item that started needing the operator in the toast, neutral, opens it on a click, and hides it after 10 s off the pointer (PRD R65)", async () => {
    vi.useFakeTimers();
    const { source } = start();

    hello(source, { groups: [listGroup('blocked', [listRow(1), listRow(2)])] });
    source.emit('needs', { items: [{ workItemId: 1, message: 'gh 1 is waiting for your answer.' }, { workItemId: 2, message: 'gh 2 asks for permission.' }] });
    expect(root.querySelector('.toast.info .toast-open')?.textContent).toBe('gh 2 asks for permission.');
    expect(root.querySelector('.toast')?.getAttribute('role')).toBe('status');
    // The pointer on it keeps it; off it, 10 s hide it.
    root.querySelector('.toast-open')!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(15_000);
    expect(root.querySelector('.toast')).not.toBeNull();
    root.querySelector('#toast')!.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(9_000);
    expect(root.querySelector('.toast')).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(root.querySelector('.toast')).toBeNull();

    // A click on the message opens its work item and clears it; Dismiss only clears.
    source.emit('needs', { items: [{ workItemId: 1, message: 'gh 1 is waiting for your answer.' }] });
    click('.toast-open');
    expect(root.querySelector('.toast')).toBeNull();
    expect(location.hash).toBe('#w=1');
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.filter((one) => one.url.endsWith('/select')).map((one) => one.body['workItemId'])).toEqual([1]);
    source.emit('needs', { items: [{ workItemId: 2, message: 'gh 2 asks for permission.' }] });
    click('[data-action="toast-dismiss"]');
    expect(root.querySelector('.toast')).toBeNull();
    expect(location.hash).toBe('#w=1');
  });

  it("shows the hub's notes under the header in the warning colour, and the held-session note, which opens what Held sessions opens", () => {
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

  it('lists held sessions from both entry points, confirms Stop, refreshes, and shows hub refusals verbatim', async () => {
    const { page, source } = start(false);
    const orphan = { session: 'orphan', item: 'No work item', nativeSessionId: '-', cwd: 'D:/scratch/<folder>', state: 'live', idle: '2h 5m', memory: '128 MB', clients: 0, orphan: true, exited: false, terminal: null };
    const owned = { ...orphan, session: 'owned', item: 'gh 8', nativeSessionId: 'native-8', state: 'idle', clients: 2, orphan: false, terminal: {} };
    answers['/held-list'] = { status: 200, body: { held: [orphan, owned, { ...owned, session: 'exited', state: 'exited', exited: true }] } };
    hello(source, { header: header({ heldNote: '1 held session without a work item' }) });
    click('.more-actions');
    click('[data-action="list-later-held"]');
    expect(root.querySelector('.held-sheet')?.textContent).toContain('Loading…');
    await flush();
    expect(root.querySelectorAll('.held-row')).toHaveLength(3);
    expect([...root.querySelectorAll('.held-row dd')].slice(0, 8).map((cell) => cell.textContent)).toEqual(['No work item', 'orphan', '-', 'D:/scratch/<folder>', 'live', '2h 5m', '128 MB', '0']);
    expect(root.querySelector('.held-row dd[title="D:/scratch/<folder>"]')?.children).toHaveLength(0);
    expect(root.querySelector<HTMLButtonElement>('[data-action="list-held-open"][data-id="orphan"]')!.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-action="list-held-stop"][data-id="exited"]')!.disabled).toBe(true);
    const open = root.querySelector('[data-action="list-held-open"][data-id="owned"]');
    answers['/held-open'] = { status: 403, body: { error: 'Do this from the page on the computer that runs Switchboard.' } };
    click('[data-action="list-held-open"][data-id="owned"]');
    await flush(); await flush();
    expect(root.querySelector('.sheet-error')?.textContent).toBe('Do this from the page on the computer that runs Switchboard.');
    expect(root.querySelector('[data-action="list-held-open"][data-id="owned"]')).toBe(open);
    expect(posts.find((post) => post.url.endsWith('/held-open'))?.body).toMatchObject({ window: 'pk', id: 'owned' });
    click('[data-action="list-held-stop"][data-id="orphan"]');
    expect(root.querySelector('.held-confirm .sheet-title')?.textContent).toBe('Stop held session orphan?');
    expect(root.querySelector('.held-confirm .sheet-detail')?.textContent).toBe("Session orphan in D:/scratch/<folder>. Its process ends and anything it is doing stops.");
    expect(document.activeElement?.textContent).toBe('Cancel');
    click('[data-action="list-held-cancel"]');
    await flush();
    expect(posts.some((post) => post.url.endsWith('/held-stop'))).toBe(false);
    click('[data-action="list-held-stop"][data-id="owned"]');
    expect(root.querySelector('.held-confirm .sheet-title')?.textContent).toBe('Stop the held session of gh 8?');
    answers['/held-stop'] = { status: 404, body: { error: 'No held session owned.' } };
    click('[data-action="list-held-confirm"]');
    await flush(); await flush();
    expect(root.querySelector('.sheet-error')?.textContent).toBe('No held session owned.');
    click('[data-action="list-held-stop"][data-id="orphan"]');
    answers['/held-stop'] = { status: 200, body: { stopped: 'orphan' } };
    answers['/held-list'] = { status: 200, body: { held: [] } };
    click('[data-action="list-held-confirm"]');
    await flush(); await flush();
    expect(posts.filter((post) => post.url.endsWith('/held-stop')).map((post) => post.body['id'])).toEqual(['owned', 'orphan']);
    expect(root.querySelector('.held-sheet')?.textContent).toContain('Stopped held session orphan.');
    expect(root.querySelector('.held-sheet')?.textContent).toContain('No held sessions. Code Mode sessions appear here while the terminal holder keeps them.');
    click('#list-sheet .sheet-button.primary');
    click('.held-note');
    await flush();
    expect(root.querySelector('.held-sheet')).not.toBeNull();
    page.close();
  });

  it('refreshes held state while open, preserves focus, and ignores answers after closing', async () => {
    vi.useFakeTimers();
    const { page, source } = start();
    const row = { session: 's', item: 'gh 8', nativeSessionId: 'native', cwd: 'D:/w', state: 'running', idle: '0m', memory: '-', clients: 1, orphan: false, exited: false, terminal: {} };
    answers['/held-list'] = { status: 200, body: { held: [row] } };
    hello(source);
    click('.more-actions'); click('[data-action="list-later-held"]');
    await vi.advanceTimersByTimeAsync(0);
    const button = root.querySelector<HTMLElement>('[data-action="list-held-stop"]')!;
    button.focus();
    answers['/held-list'] = { status: 200, body: { held: [{ ...row, state: 'idle', clients: 0 }] } };
    await vi.advanceTimersByTimeAsync(5000);
    expect(root.querySelector('.held-row')?.textContent).toContain('idle');
    expect(document.activeElement).toBe(button);
    let refreshDone: () => void = () => {};
    answers['/held-list'] = { status: 200, body: { held: [row] }, wait: new Promise<void>((resolve) => { refreshDone = resolve; }) };
    await vi.advanceTimersByTimeAsync(5000);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    refreshDone();
    await vi.advanceTimersByTimeAsync(0);
    click('[data-action="list-held-stop"]');
    await vi.advanceTimersByTimeAsync(10000);
    expect(root.querySelector('.held-confirm')).not.toBeNull();
    click('[data-action="list-held-cancel"]');
    await vi.advanceTimersByTimeAsync(0);
    let release: () => void = () => {};
    answers['/held-list'] = { status: 200, body: { held: [] }, wait: new Promise<void>((resolve) => { release = resolve; }) };
    click('[data-action="list-held-refresh"]');
    click('#list-sheet .sheet-button.primary');
    release();
    await vi.advanceTimersByTimeAsync(10000);
    expect(root.querySelector('.held-sheet')).toBeNull();
    page.close();
  });

  it('drops a list started before Stop and refreshes after that action', async () => {
    vi.useFakeTimers();
    const { page, source } = start();
    const row = { session: 's', item: 'No work item', nativeSessionId: '-', cwd: 'D:/w', state: 'live', idle: '0m', memory: '-', clients: 0, orphan: true, exited: false, terminal: null };
    answers['/held-list'] = { status: 200, body: { held: [row] } };
    hello(source, { header: header({ heldNote: '1 held session without a work item' }) });
    click('.held-note');
    await vi.advanceTimersByTimeAsync(0);
    let release: () => void = () => {};
    answers['/held-list'] = { status: 200, body: { held: [row] }, wait: new Promise<void>((resolve) => { release = resolve; }) };
    await vi.advanceTimersByTimeAsync(5000);
    click('[data-action="list-held-stop"]');
    answers['/held-stop'] = { status: 200, body: { stopped: 's' } };
    click('[data-action="list-held-confirm"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('.held-sheet')?.textContent).toContain('Stopped held session s.');
    expect(root.querySelector<HTMLButtonElement>('[data-action="list-held-stop"]')!.disabled).toBe(false);
    answers['/held-list'] = { status: 200, body: { held: [] } };
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('.held-row')).toBeNull();
    expect(root.querySelector('.held-sheet')?.textContent).toContain('No held sessions.');
    page.close();
  });

  it('recovers from a list refusal and ignores a closed sheet while a new one loads', async () => {
    const { page, source } = start();
    hello(source, { header: header({ heldNote: '1 held session without a work item' }) });
    answers['/held-list'] = { status: 500, body: { error: 'The holder did not answer.' } };
    click('.held-note');
    await flush();
    expect(root.querySelector('.sheet-error')?.textContent).toBe('The holder did not answer.');
    answers['/held-list'] = { status: 200, body: { held: [] } };
    click('[data-action="list-held-refresh"]');
    await flush();
    expect(root.querySelector('.sheet-error')).toBeNull();
    let release: () => void = () => {};
    answers['/held-list'] = { status: 200, body: { held: [] }, wait: new Promise<void>((resolve) => { release = resolve; }) };
    click('[data-action="list-held-refresh"]');
    click('#list-sheet .sheet-button.primary');
    answers['/held-list'] = { status: 403, body: { error: 'Remote access no longer allows this device.' } };
    click('.held-note');
    await flush();
    expect(root.querySelector('.sheet-error')?.textContent).toBe('Remote access no longer allows this device.');
    release();
    await flush();
    expect(root.querySelector('.sheet-error')?.textContent).toBe('Remote access no longer allows this device.');
    page.close();
  });

  it('shows the note for a lost phone after the warning notes, as an untoned voice note, and nothing while the voice is off by choice (PRD R119)', () => {
    const { source } = start();
    const lost = 'Voice stopped unexpectedly on the paired device. Select Voice on this device there, or Talk here on this computer.';

    hello(source);
    // Voice off by choice: the hub sends where the voice is, and no note.
    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ voiceDevice: 'none' }) });
    expect(root.querySelector('.list-note')).toBeNull();
    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ notes: ['Voice: the voice process stopped.'], voiceNote: lost, voiceDevice: 'none' }) });
    expect([...root.querySelectorAll('.list-note')].map((note) => [note.className, note.textContent])).toEqual([
      ['list-note', 'Voice: the voice process stopped.'],
      ['list-note voice-note', lost],
    ]);
    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header() });
    expect(root.querySelector('.voice-note')).toBeNull();
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

  it('offers a shortcut download on this computer and on a paired device, without a local hub command', () => {
    for (const local of [true, false]) {
      const { page, source } = start(local); hello(source);
      click('.more-actions'); click('.more-menu [data-action="list-shortcut"]');
      expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('Download app shortcut');
      expect(root.querySelector<HTMLButtonElement>('#list-sheet button.primary')?.disabled).toBe(false);
      expect(root.querySelector('#list-sheet button.primary')?.textContent).toBe('Download shortcut');
      expect(root.querySelector<HTMLInputElement>('#list-sheet input')?.value).toBe('Default');
      expect(document.activeElement?.tagName).toBe('SELECT');
      expect(root.querySelector('#list-sheet')?.textContent).toContain('No installer or local hub is needed.');
      click('#list-sheet [data-action="list-sheet-cancel"]');
      expect(root.querySelector('#list-sheet .sheet')).toBeNull(); page.close();
    }
    expect(posts.every((post) => post.url === '/v1/conversation/page-focus')).toBe(true);
  });

  it('pairs a device from this computer with a QR code and a code, lists the signed-in devices and signs one out, and offers none of it on a paired device (architecture.md § Remote access)', async () => {
    const remote = start(false);

    hello(remote.source);
    click('.more-actions');
    // Settings stays on this computer too; the menu ends with Voice on this device, off until tapped.
    expect(menuRows().slice(-8)).toEqual(['-', 'Refresh sources', 'Reload', 'Show hub log', 'Get the browser extension…', 'Download app shortcut…', '-', 'Voice on this device']);
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

  const PLACES = { recent: ['D:/git/switchboard'], repoRoots: ['D:/git/widgets', 'D:/git/support'], worktrees: ['D:/git/widgets.worktrees/i19139'], computer: ['C:/Users/me', 'C:/', 'D:/'] };
  const PROVIDERS_ANSWER = {
    defaultProvider: 'claude',
    installed: ['claude', 'codex'],
    models: { claude: 'sonnet', codex: '' },
    modelChoices: { claude: [{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }], codex: [{ id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' }] },
  };
  const go = () => root.querySelector<HTMLButtonElement>('[data-action="list-sheet-go"]')!;
  const openForm = async (source: FakeSource, patch: Partial<PageHeader> = {}) => {
    hello(source, { header: header(patch) });
    click('[data-action="list-new-session"]');
    await flush();
    await flush();
  };
  const sent = (command: string) => posts.filter((post) => post.url.endsWith(`/${command}`));

  it('draws its sheets at the page\'s root, over every column, with the list under them inert, and gives the focus back to the button that opened one', async () => {
    const { page, source } = start();
    const press = (selector: string) => {
      root.querySelector(selector)!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      click(selector);
    };

    answers['/providers'] = { status: 200, body: PROVIDERS_ANSWER };
    answers['/page-folders'] = { status: 200, body: PLACES };
    hello(source, { header: header() });
    // Not inside the list's column, whose drawer and phone views would stack or hide it.
    expect(root.querySelector('#list-sheet')!.parentElement).toBe(root);
    press('[data-action="list-new-session"]');
    await flush();
    await flush();
    expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('New session');
    expect(root.querySelector('.side')!.closest('[inert]')).not.toBeNull();
    expect(root.querySelector('#list-sheet')!.hasAttribute('inert')).toBe(false);
    press('#list-sheet [data-action="list-sheet-cancel"].sheet-button');
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();
    expect(root.querySelector('[inert]')).toBeNull();
    // Back to New session, not More Actions.
    expect(document.activeElement).toBe(root.querySelector('[data-action="list-new-session"]'));

    // One opened from More Actions' menu gives it back to More Actions.
    press('.more-actions');
    press('.more-menu [data-action="list-extension"]');
    root.querySelector('#list-sheet .sheet')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('.more-actions'));
    page.close();
  });

  it('opens one New session form from the + button, on the folder used last, the default provider and Default model (PRD R122)', async () => {
    const { page, source } = start();

    answers['/providers'] = { status: 200, body: PROVIDERS_ANSWER };
    answers['/page-folders'] = { status: 200, body: PLACES };
    answers['/page-new-session'] = { status: 200, body: { workItemId: 11, folder: 'D:/git/switchboard', run: 'now' } };
    await openForm(source);

    expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('New session');
    expect(root.querySelector<HTMLInputElement>('[data-field="folder"]')!.value).toBe('D:/git/switchboard');
    expect([...root.querySelectorAll('.provider-option')].map((one) => [one.textContent, one.getAttribute('aria-pressed')])).toEqual([['Claude', 'true'], ['Codex', 'false']]);
    // Each provider's mark, as the conversation dropdown draws it.
    expect([...root.querySelectorAll('.provider-option .provider-option-mark svg path')]).toHaveLength(2);
    expect([...root.querySelectorAll('[data-field="model"] option')].map((one) => one.textContent)).toEqual(['Default (sonnet)', 'opus', 'sonnet', 'Other…']);
    expect(root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.placeholder).toBe('Optional. Leave empty to open an empty session.');
    // No message, no Run as; no schedules, no More options.
    expect(root.querySelector('.run-as')).toBeNull();
    expect(root.querySelector('.more-options')).toBeNull();
    expect(go().textContent).toBe('Start');

    // Codex has its own models, and its Default names the provider's own.
    click('[data-provider="codex"]');
    expect([...root.querySelectorAll('[data-field="model"] option')].map((one) => one.textContent)).toEqual(["Default (Codex's default)", 'GPT-6.2 Sol', 'Other…']);
    click('[data-provider="claude"]');
    // Other… shows a box; Start waits for a name in it.
    change('[data-field="model"]', OTHER_MODEL);
    expect(go().disabled).toBe(true);
    change('[data-field="otherModel"]', 'claude-opus-4-1');
    expect(go().disabled).toBe(false);
    click('[data-action="list-sheet-go"]');
    await flush();
    await flush();
    expect(sent('page-new-session')[0]?.body).toEqual({ window: 'pk', opId: expect.any(String), folder: 'D:/git/switchboard', provider: 'claude', model: 'claude-opus-4-1', run: 'now' });
    expect(sent('select').at(-1)?.body['workItemId']).toBe(11);
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();
    // More Actions no longer makes work.
    click('.more-actions');
    expect(root.querySelector('.more-menu [data-action="list-new-session"]')).toBeNull();
    page.close();
  });

  it('shows Run as once there is a message, sends a task for either task choice and remembers the choice on this device, keeping a refusal in the form', async () => {
    const { page, source } = start();

    answers['/providers'] = { status: 200, body: { ...PROVIDERS_ANSWER, installed: ['codex'], defaultProvider: 'claude' } };
    answers['/page-folders'] = { status: 200, body: PLACES };
    answers['/page-new-session'] = { status: 409, body: { error: 'Code Mode sessions need hooks.' } };
    await openForm(source);

    // One provider installed: no switch, and that provider.
    expect(root.querySelector('.provider-switch')).toBeNull();
    change('[data-field="prompt"]', '  Find why the inbox badge counts archived threads.  ');
    expect([...root.querySelectorAll('.run-as .sheet-choice')].map((one) => one.textContent)).toEqual(['Conversation, start now', 'Task, start when a slot is free', 'Task, wait for Start']);
    expect(root.querySelector<HTMLInputElement>('[data-field="run"][value="now"]')!.checked).toBe(true);
    change('[data-field="run"][value="wait"]', true);
    expect(go().textContent).toBe('Create');
    click('[data-action="list-sheet-go"]');
    await flush();
    await flush();
    expect(sent('page-new-session')[0]?.body).toMatchObject({ provider: 'codex', model: null, prompt: 'Find why the inbox badge counts archived threads.', run: 'wait' });
    expect(root.querySelector('#list-sheet .sheet-error')?.textContent).toBe('Code Mode sessions need hooks.');
    expect(localStorage.getItem(RUN_AS_KEY)).toBeNull();

    // A retry is the same request, so the hub creates once; the task's row opens too.
    answers['/page-new-session'] = { status: 200, body: { workItemId: 12, folder: 'D:/git/switchboard', run: 'wait' } };
    click('[data-action="list-sheet-go"]');
    await flush();
    await flush();
    expect(sent('page-new-session')[1]?.body['opId']).toBe(sent('page-new-session')[0]?.body['opId']);
    expect(sent('select').at(-1)?.body['workItemId']).toBe(12);
    expect(localStorage.getItem(RUN_AS_KEY)).toBe('wait');

    // The next form offers it; an empty message still starts an empty conversation.
    click('[data-action="list-new-session"]');
    await flush();
    await flush();
    change('[data-field="prompt"]', 'x');
    expect(root.querySelector<HTMLInputElement>('[data-field="run"][value="wait"]')!.checked).toBe(true);
    change('[data-field="run"][value="queue"]', true);
    expect(go().textContent).toBe('Start');
    change('[data-field="prompt"]', ' ');
    expect(root.querySelector('.run-as')).toBeNull();
    click('[data-action="list-sheet-go"]');
    await flush();
    await flush();
    expect(sent('page-new-session').at(-1)?.body).toMatchObject({ run: 'now' });
    expect(sent('page-new-session').at(-1)?.body).not.toHaveProperty('prompt');
    page.close();
  });

  it('offers the folders by group, filters them by what is typed and has the hub check a typed path', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, source } = start();

    answers['/providers'] = { status: 200, body: PROVIDERS_ANSWER };
    answers['/page-folders'] = { status: 200, body: PLACES };
    hello(source);
    click('[data-action="list-new-session"]');
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    click('[data-action="list-folder-toggle"]');
    const rows = () => [...root.querySelectorAll('.folder-menu > li')].map((li) => li.textContent);
    expect(rows()).toEqual(['Recent', 'D:/git/switchboard', 'Repo roots', 'D:/git/widgets', 'D:/git/support', 'Worktrees', 'D:/git/widgets.worktrees/i19139', 'Browse…']);
    change('[data-field="folder"]', 'widgets');
    expect(rows()).toEqual(['Repo roots', 'D:/git/widgets', 'Worktrees', 'D:/git/widgets.worktrees/i19139', 'Browse…']);
    click('[data-action="list-folder-pick"][data-path="D:/git/widgets"]');
    expect(root.querySelector<HTMLInputElement>('[data-field="folder"]')!.value).toBe('D:/git/widgets');
    expect(root.querySelector('.folder-menu')).toBeNull();

    // A typed path is checked shortly after the last key; the hub's refusal shows under the field and holds Start.
    answers['/page-folders'] = { status: 400, body: { error: 'D:/nowhere is not a folder a session can run in.' } };
    change('[data-field="folder"]', 'D:/nowhere');
    expect(sent('page-folders').filter((post) => post.body['path'] === 'D:/nowhere')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FOLDER_CHECK_MS);
    await vi.runOnlyPendingTimersAsync();
    expect(sent('page-folders').filter((post) => post.body['path'] === 'D:/nowhere')).toHaveLength(1);
    expect(root.querySelector('.folder-field .sheet-error')?.textContent).toBe('D:/nowhere is not a folder a session can run in.');
    expect(go().disabled).toBe(true);
    page.close();
  });

  it('FolderBrowser_FolderWithoutSubfolders_SaysWhatToDoInTwoSentences', async () => {
    const { page, source } = start(false);

    answers['/providers'] = { status: 200, body: PROVIDERS_ANSWER };
    answers['/page-folders'] = { status: 200, body: { ...PLACES, computer: [] } };
    await openForm(source);
    change('[data-field="folder"]', '');
    click('[data-action="list-folder-browse"]');
    answers['/page-folders'] = { status: 200, body: { path: 'D:/git/widgets', parent: 'D:/git', folders: [], more: false } };
    click('[data-action="list-browse-open"][data-path="D:/git/widgets"]');
    await flush();
    await flush();
    expect(root.querySelector('.folder-empty')?.textContent?.trim()).toBe('No folders here. Use this folder, or go up a level.');
    expect(root.querySelector<HTMLButtonElement>('[data-action="list-browse-use"]')!.disabled).toBe(false);
    page.close();
  });

  it("browses the hub's folders from Browse… and uses the chosen one, saying a paired device is limited", async () => {
    const { page, source } = start(false);

    answers['/providers'] = { status: 200, body: PROVIDERS_ANSWER };
    answers['/page-folders'] = { status: 200, body: { ...PLACES, computer: [] } };
    await openForm(source);
    // Typing opens the list; with no folder, Browse… starts at the starting places.
    change('[data-field="folder"]', '');
    click('[data-action="list-folder-browse"]');
    expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('Choose a folder');
    expect([...root.querySelectorAll('.folder-browser > li')].map((li) => li.textContent)).toEqual(['Recent', 'D:/git/switchboard', 'Repo roots', 'D:/git/widgets', 'D:/git/support', 'Worktrees', 'D:/git/widgets.worktrees/i19139']);
    expect(root.querySelector('#list-sheet')?.textContent).toContain('On a paired device: only folders under recent folders, repo roots and worktrees.');
    expect(root.querySelector<HTMLButtonElement>('[data-action="list-browse-use"]')!.disabled).toBe(true);

    answers['/page-folders'] = { status: 200, body: { path: 'D:/git/widgets', parent: null, folders: [{ name: 'apps', path: 'D:/git/widgets/apps' }], more: false } };
    click('[data-action="list-browse-open"][data-path="D:/git/widgets"]');
    await flush();
    await flush();
    expect(sent('page-folders').at(-1)?.body).toMatchObject({ path: 'D:/git/widgets' });
    expect([...root.querySelectorAll('.folder-crumb')].map((one) => one.textContent)).toEqual(['D:', 'git', 'widgets']);
    expect([...root.querySelectorAll('.folder-browser .folder-name')].map((one) => one.textContent)).toEqual(['apps']);
    // The starting places are one click away from any folder.
    click('[data-action="list-browse-places"]');
    expect(root.querySelector('.folder-crumbs')).toBeNull();
    expect([...root.querySelectorAll('.folder-browser > li')][0]?.textContent).toBe('Recent');
    click('[data-action="list-browse-open"][data-path="D:/git/widgets"]');
    await flush();
    await flush();

    answers['/page-folders'] = { status: 400, body: { error: 'D:/git/widgets/apps cannot be read.' } };
    click('[data-action="list-browse-open"][data-path="D:/git/widgets/apps"]');
    await flush();
    await flush();
    expect(root.querySelector('#list-sheet .sheet-error')?.textContent).toBe('D:/git/widgets/apps cannot be read.');
    // The listing it could not replace stays, and its folder is used.
    click('[data-action="list-browse-use"]');
    expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('New session');
    expect(root.querySelector<HTMLInputElement>('[data-field="folder"]')!.value).toBe('D:/git/widgets');
    // Escape leaves the browser for the form, then closes the form.
    click('[data-action="list-folder-toggle"]');
    click('[data-action="list-folder-browse"]');
    await flush();
    root.querySelector('#list-sheet .sheet')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('#list-sheet .sheet-title')?.textContent).toBe('New session');
    root.querySelector('#list-sheet .sheet')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();
    page.close();
  });

  it("runs a schedule now from More options, hiding the other fields, and reports a provider lookup that failed", async () => {
    const { page, source } = start();

    answers['/providers'] = { status: 500, body: { error: 'The hub is busy.' } };
    answers['/page-folders'] = { status: 200, body: PLACES };
    answers['/page-adhoc'] = { status: 200, body: { done: true, workItemId: 21 } };
    await openForm(source, { schedules: [{ name: 'nightly', playbook: 'dev:sweep' }] });

    expect(root.querySelector('#list-sheet .sheet-error')?.textContent).toBe('The hub is busy.');
    expect(go().disabled).toBe(true);
    click('[data-action="list-more-options"]');
    expect([...root.querySelectorAll('[data-field="schedule"] option')].map((one) => one.textContent)).toEqual(['None', 'Run nightly now · dev:sweep']);
    change('[data-field="schedule"]', 'nightly');
    expect(root.querySelector('[data-field="folder"]')).toBeNull();
    expect(root.querySelector('[data-field="prompt"]')).toBeNull();
    expect(go().textContent).toBe('Run');
    expect(go().disabled).toBe(false);
    click('[data-action="list-sheet-go"]');
    await flush();
    await flush();
    expect(sent('page-adhoc').at(-1)?.body).toEqual({ window: 'pk', opId: expect.any(String), schedule: 'nightly' });
    expect(sent('page-new-session')).toHaveLength(0);
    expect(sent('select').at(-1)?.body['workItemId']).toBe(21);
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();
    // A press on the backdrop closes the form; one on the sheet does not.
    click('[data-action="list-new-session"]');
    root.querySelector<HTMLElement>('#list-sheet .sheet')!.click();
    expect(root.querySelector('#list-sheet .sheet')).not.toBeNull();
    root.querySelector<HTMLElement>('#list-sheet .sheet-backdrop')!.click();
    expect(root.querySelector('#list-sheet .sheet')).toBeNull();
    page.close();
  });
});
