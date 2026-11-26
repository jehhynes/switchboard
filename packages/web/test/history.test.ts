import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPage } from '../src/main.js';
import { EMPTY_HISTORY_UI, entryShown, gapText, historyAction, historyUrl, renderHistory, RUN_LIMIT } from '../src/history.js';
import type { HistoryOpen } from '../src/history.js';
import { html } from './html.js';
import type { HistoryCategory, HistoryEntry, HistoryView, PageGroup, PageRow } from '@switchboard/protocol';
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

const T0 = new Date(2026, 9, 7, 9, 0, 0).getTime();
const MINUTE = 60_000;
const CATEGORIES: HistoryCategory[] = [
  { key: 'you', label: 'You', icon: 'account' },
  { key: 'session', label: 'Sessions', icon: 'terminal' },
  { key: 'ticket', label: 'Ticket', icon: 'issues' },
];
const entry = (key: string, at: number, patch: Partial<HistoryEntry> = {}): HistoryEntry => ({ key, at, category: 'you', icon: 'play', text: `Entry ${key}`, lines: [], detail: null, shortId: null, links: [], tone: null, reconstructed: false, refused: null, stateChange: false, ...patch });
const view = (patch: Partial<HistoryView> = {}): HistoryView => ({
  key: 'gh 77',
  title: 'Inbox <badge>',
  url: 'https://github.com/o/r/issues/77',
  facts: [{ label: 'Status', value: 'Running' }],
  links: [{ label: 'Open ticket', icon: 'link-external', title: 'https://github.com/o/r/issues/77', open: { type: 'openUrl', url: 'https://github.com/o/r/issues/77' } }],
  reconstructed: false,
  recordedSince: null,
  sections: [
    {
      key: 'w1',
      workItemId: 1,
      title: 'dev:build',
      status: 'Running',
      tone: 'accent',
      facts: ['Started 09:00'],
      prompt: null,
      entries: [
        entry('a', T0),
        entry('b', T0 + 2 * MINUTE, { category: 'session', text: 'Session started', shortId: 'abc12345', detail: 'Which branch?', tone: 'warning', links: [{ label: 'Open', icon: 'folder-opened', title: 'D:/w1', open: { type: 'openFolder', path: 'D:/w1' } }] }),
        entry('c', T0 + 24 * 60 * MINUTE, { refused: 'Not now.', lines: ['gh 78 moved'] }),
      ],
    },
    { key: 'ticket', workItemId: null, title: 'Ticket', status: '', tone: null, facts: [], prompt: 'Fix the badge', entries: [entry('t', T0, { category: 'ticket', text: 'Switchboard first saw the ticket' })] },
  ],
  ...patch,
});
const open = (patch: Partial<HistoryOpen> = {}): HistoryOpen => ({ ticketId: 77, key: 'gh 77', view: view(), categories: CATEGORIES, error: null, ui: { ...EMPTY_HISTORY_UI }, ...patch });

describe("the page's History (architecture.md § Web page)", () => {
  it('draws the state at the top of History, before the ticket, and the state alone for a row that offers no ticket History', () => {
    const root = document.createElement('div');
    const state = { id: 'st-1', sessionId: 's1', at: T0, headline: '2/5 fixing tests', body: 'Two left.', stale: null, unread: true } as const;

    root.innerHTML = html(renderHistory(open(), state, T0 + 60_000));
    expect(root.querySelector('.history-view')!.firstElementChild!.className).toBe('state-view unread');
    expect(root.querySelector('.state-headline')?.textContent).toBe('2/5 fixing tests');
    expect(root.querySelector('.state-view + .hist-hero')).not.toBeNull();
    root.innerHTML = html(renderHistory(null, state, T0 + 60_000));
    expect(root.querySelector('.history-view')?.getAttribute('aria-label')).toBe('History');
    expect(root.querySelector('.state-body')?.textContent?.trim()).toBe('Two left.');
    expect(root.querySelector('.hist-hero')).toBeNull();
    root.innerHTML = html(renderHistory(null, null, T0));
    expect(root.querySelector('.history-view')?.textContent).toBe('No state yet. It appears here when the session sets one.');
  });

  it("draws the History tab's header, chips, sections with day headings, gaps and marks, the first section open", () => {
    const root = document.createElement('div');

    root.innerHTML = html(renderHistory(open(), null, T0));
    expect(root.querySelector('.history-view')?.getAttribute('aria-label')).toBe('gh 77 History');
    expect(root.querySelector('.hist-headline h1')?.textContent).toBe('Inbox <badge>');
    expect(root.querySelector('.hist-key')?.textContent).toBe('gh 77');
    expect([...root.querySelectorAll('.hist-facts dt')].map((fact) => fact.textContent)).toEqual(['Status']);
    expect([...root.querySelectorAll('.hist-chip')].map((chip) => [chip.textContent, chip.getAttribute('aria-pressed')])).toEqual([['You', 'true'], ['Sessions', 'true'], ['Ticket', 'true']]);
    expect([...root.querySelectorAll<HTMLDetailsElement>('details.hist-section')].map((section) => [section.dataset['section'], section.open])).toEqual([['w1', true], ['ticket', false]]);
    expect(root.querySelectorAll('[data-section="w1"] .hist-day')).toHaveLength(2);
    expect([...root.querySelectorAll('[data-section="w1"] .hist-gap')].map((gap) => gap.textContent)).toEqual(['', '+2m', '+23h 58m']);
    expect(root.querySelector('[data-entry="b"]')?.className).toBe('hist-entry cat-session tone-warning');
    expect(root.querySelector('[data-entry="b"] .hist-sid')?.textContent).toBe('abc12345');
    expect(root.querySelector('[data-entry="b"] .hist-detail')?.textContent).toBe('Which branch?');
    expect(root.querySelector('[data-entry="c"] .refused-mark')?.textContent).toBe('refused');
    expect([...root.querySelectorAll('[data-entry="c"] .hist-detail')].map((one) => one.textContent)).toEqual(['Not now.']);
    expect(root.querySelector('[data-entry="c"] .hist-lines li')?.textContent).toBe('gh 78 moved');
    expect(root.querySelector('[data-section="ticket"] .hist-prompt-text')?.textContent).toBe('Fix the badge');
    // An http link opens in a tab; a folder opens the work item in VS Code, which its tooltip says.
    expect(root.querySelector('.hist-hero-links button.hist-link')?.getAttribute('data-url')).toBe('https://github.com/o/r/issues/77');
    expect(root.querySelector('[data-entry="b"] button.hist-link')?.getAttribute('data-action')).toBe('history-folder');
    expect(root.querySelector('[data-entry="b"] button.hist-link')?.getAttribute('title')).toBe('D:/w1\nOpens the work item in VS Code.');
    expect(root.querySelector('[data-entry="b"] .hist-link.off')).toBeNull();
    expect(root.querySelector('.hist-banner')).toBeNull();
  });

  it('filters by chip and text with the count of what shows, collapses a long run of state changes, and says when logging began', () => {
    const root = document.createElement('div');

    root.innerHTML = html(renderHistory(open({ ui: { ...EMPTY_HISTORY_UI, hidden: ['session'] } }), null, T0));
    expect(root.querySelector('[data-section="w1"] .hist-count')?.textContent).toBe('2 of 3');
    expect(root.querySelector('.hist-chip[data-category="session"]')?.getAttribute('aria-pressed')).toBe('false');
    root.innerHTML = html(renderHistory(open({ ui: { ...EMPTY_HISTORY_UI, query: 'BRANCH', sections: { ticket: true } } }), null, T0));
    expect(root.querySelectorAll('[data-section="w1"] .hist-entry')).toHaveLength(1);
    expect(root.querySelector('[data-section="ticket"] .hist-empty')?.textContent).toBe('No entries match the filter. Clear it to see every entry.');
    expect(entryShown(entry('x', T0, { links: [{ label: 'PR #9', icon: 'git-pull-request', title: '', open: { type: 'openUrl', url: 'https://x' } }] }), { ...EMPTY_HISTORY_UI, query: 'pr #9' })).toBe(true);

    const states = Array.from({ length: RUN_LIMIT + 1 }, (_, index) => entry(`s${index}`, T0 + index * 1000, { category: 'session', stateChange: true }));
    const long = view({ reconstructed: true, recordedSince: T0, sections: [{ ...view().sections[0]!, entries: states }] });

    root.innerHTML = html(renderHistory(open({ view: long }), null, T0));
    expect(root.querySelector('.hist-run summary')?.textContent).toBe(`${RUN_LIMIT + 1} session state changes, 09:00:00 to 09:00:05`);
    expect(root.querySelector<HTMLDetailsElement>('.hist-run details')?.open).toBe(false);
    root.innerHTML = html(renderHistory(open({ view: long, ui: { ...EMPTY_HISTORY_UI, runs: ['s0'] } }), null, T0));
    expect(root.querySelector<HTMLDetailsElement>('.hist-run details')?.open).toBe(true);
    root.innerHTML = html(renderHistory(open({ view: { ...long, sections: [{ ...long.sections[0]!, entries: states.slice(0, RUN_LIMIT) }] } }), null, T0));
    expect(root.querySelector('.hist-run')).toBeNull();
    expect(root.querySelector('.hist-banner')?.textContent).toContain('Switchboard began logging on 2026-10-07 09:00.');
    // Before the hub answers, and when it cannot.
    root.innerHTML = html(renderHistory(open({ view: null }), null, T0));
    expect(root.querySelector('.hist-body .empty:not(.state-empty)')?.textContent).toBe('Loading…');
    root.innerHTML = html(renderHistory(open({ view: null, error: 'Unknown ticket 77.' }), null, T0));
    expect(root.querySelector('.hist-error')?.textContent).toBe('Unknown ticket 77.');
    expect(root.querySelector('.hist-body .empty:not(.state-empty)')).toBeNull();
    expect(gapText(45_000)).toBe('45s');
    expect(gapText(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    expect(historyUrl({ label: 'f', icon: 'file', title: '', open: { type: 'openUrl', url: 'D:/report.md' } })).toBeNull();
    // A file opens in a file tab, a session in the conversation by its work item and Switchboard ID; a session without them opens nowhere.
    expect(historyAction({ label: 'f', icon: 'file', title: '', open: { type: 'openUrl', url: 'D:/report.md' } })).toEqual({ 'data-action': 'history-file', 'data-path': 'D:/report.md' });
    // A web link carries its label, which names its link tab.
    expect(historyAction({ label: 'PR #9', icon: 'git-pull-request', title: '', open: { type: 'openUrl', url: 'https://x.test/9' } })).toEqual({ 'data-action': 'history-open', 'data-url': 'https://x.test/9', 'data-label': 'PR #9' });
    expect(historyAction({ label: 's', icon: 'terminal', title: '', open: { type: 'open', sessionId: 'native-1', session: 's1', workItemId: 4 } })).toEqual({ 'data-action': 'history-session', 'data-work-item': '4', 'data-session': 's1' });
    expect(historyAction({ label: 's', icon: 'terminal', title: '', open: { type: 'open', sessionId: 'native-1' } })).toBeNull();
    expect(historyAction({ label: 'x', icon: 'x', title: '', open: { type: 'javascript' } })).toBeNull();
  });
});

describe("the page's History tab in use", () => {
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let answers: Record<string, { status: number; body: unknown }>;
  let opened: string[];
  let root: HTMLElement;

  beforeEach(() => {
    posts = [];
    answers = {};
    opened = [];
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#w=1');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const start = (deps: Partial<Parameters<typeof startPage>[1]> = {}) => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const answer = Object.entries(answers).find(([name]) => url.endsWith(name))?.[1] ?? { status: 200, body: {} };

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body, text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => T0, openUrl: (url) => opened.push(url), ...deps });

    return { page, source: FakeSource.last! };
  };
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  };
  const row = (patch: Partial<PageRow> = {}): PageRow => ({ workItemId: 1, ticketId: null, title: 'Inbox badge', priority: null, time: null, ticket: 'gh 77', sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: { ticketId: 77, key: 'gh 77' }, ...patch });
  const groups = (rows: PageRow[]): PageGroup[] => [{ key: 'progress', title: 'In progress', glyph: 'p', empty: null, rows }];
  const conversation = (workItemId: number) => ({ workItemId, title: `Item ${workItemId}`, primary: true, sessionId: `s${workItemId}`, state: 'idle', conversation: 'full', unread: 0 });
  const scopeOf = (workItemId: number) => ({ kind: 'page', key: 'pk', folder: 'D:/w', title: `Item ${workItemId}`, scopeGen: workItemId, conversations: [conversation(workItemId)], workItemId, cwd: 'D:/w', sessionId: `s${workItemId}` });
  const rows = [row(), row({ workItemId: 2, ticket: 'gh 78', history: { ticketId: 78, key: 'gh 78' } }), row({ workItemId: 3, history: null }), row({ workItemId: null, ticketId: 79, url: 'https://github.com/o/r/issues/79', history: { ticketId: 79, key: 'gh 79' } })];
  const hello = (source: FakeSource, workItemId = 1) => source.emit('hello', { key: 'pk', groups: groups(rows), scope: scopeOf(workItemId), sessions: [], items: [], more: false, status: null, artifacts: [] });
  const histories = () => posts.filter((one) => one.url === '/v1/conversation/page-history').map((one) => one.body['ticketId']);
  const historyTab = () => root.querySelector<HTMLElement>('[data-side="history"], [data-tab="history"]');
  /** Opens a work item as a click on its row does, then its stream's `hello`. */
  const openItem = (source: FakeSource, workItemId: number) => {
    root.querySelector<HTMLElement>(`#list [data-action="select"][data-work-item="${workItemId}"]`)!.click();
    hello(source, workItemId);
  };
  const openFromMenu = () => {
    root.querySelector<HTMLElement>('.header [data-action="actions"]')!.click();
    root.querySelector<HTMLElement>('.actions-menu [data-action="row-history"]')!.click();
  };

  it('drops an answer that a later read overtook', async () => {
    const releases: Array<(body: unknown) => void> = [];
    const fetch = vi.fn((url: string) =>
      url.endsWith('/page-history')
        ? new Promise<Response>((resolve) => releases.push((body) => resolve({ status: 200, ok: true, json: async () => body } as unknown as Response)))
        : Promise.resolve({ status: 200, ok: true, json: async () => ({}) } as unknown as Response),
    );
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => T0 });
    const source = FakeSource.last!;

    vi.useFakeTimers();
    hello(source);
    openFromMenu();
    source.emit('list', { groups: groups(rows) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(releases).toHaveLength(2);
    releases[1]!({ view: view({ title: 'Newer' }), categories: CATEGORIES });
    await vi.advanceTimersByTimeAsync(0);
    releases[0]!({ view: view({ title: 'Older' }), categories: CATEGORIES });
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('.history-view h1')?.textContent).toBe('Newer');
    page.close();
  });

  it("selects the open work item's History tab from the header's actions menu, follows its chips and filter, and reads it again only while it shows", async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    const { page, source } = start();

    hello(source);
    // History is always in the strip, but reads nothing while another tab shows.
    expect(historyTab()?.getAttribute('aria-selected')).toBe('false');
    await flush();
    expect(histories()).toEqual([]);
    openFromMenu();
    expect(root.querySelector('.actions-menu')).toBeNull();
    expect(historyTab()?.textContent).toBe('History');
    expect(historyTab()?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(historyTab());
    // The state stands at its top while the ticket's History loads.
    expect(root.querySelector('.history-pane .history-view .state-empty')).not.toBeNull();
    expect(root.querySelector('.history-pane .history-view > .empty:not(.state-empty)')?.textContent).toBe('Loading…');
    // No bar of its own and no close mark: the tab names it.
    expect(root.querySelector('.hist-bar, .hist-close')).toBeNull();
    expect(root.querySelector('[data-action="close-history"]')).toBeNull();
    await flush();
    expect(histories()).toEqual([77]);
    expect(root.querySelector('.history-view h1')?.textContent).toBe('Inbox <badge>');

    // A chip, the filter and a section the operator closed stay through the next read.
    root.querySelector<HTMLElement>('.hist-chip[data-category="session"]')!.click();
    expect(root.querySelector('[data-section="w1"] .hist-count')?.textContent).toBe('2 of 3');
    const filter = root.querySelector<HTMLInputElement>('.hist-filter')!;

    filter.value = 'first saw';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('[data-section="ticket"] .hist-count')?.textContent).toBe('1');
    expect(root.querySelector('[data-section="w1"] .hist-count')?.textContent).toBe('0 of 3');
    const section = root.querySelector<HTMLDetailsElement>('[data-section="w1"]')!;

    section.open = false;
    section.dispatchEvent(new Event('toggle'));
    root.querySelector<HTMLElement>('[data-action="history-all"][data-all="open"]')!.click();
    expect([...root.querySelectorAll<HTMLDetailsElement>('details.hist-section')].map((one) => one.open)).toEqual([true, true]);

    // A list change reads it again a second later, and so does the 30-second tick; a failed read keeps the view and says why.
    source.emit('list', { groups: groups(rows) });
    source.emit('list', { groups: groups(rows) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(histories()).toEqual([77, 77]);
    answers['/page-history'] = { status: 409, body: { error: 'Unknown ticket 77.' } };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(histories()).toEqual([77, 77, 77]);
    expect(root.querySelector('.hist-error')?.textContent).toBe('Unknown ticket 77.');
    expect(root.querySelector('.history-view h1')).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>('.hist-filter')!.value).toBe('first saw');

    // An http link opens in a tab.
    root.querySelector<HTMLElement>('.hist-hero-links .hist-link')!.click();
    expect(opened).toEqual(['https://github.com/o/r/issues/77']);

    // Another tab stops the reads, a list change included.
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    expect(root.querySelector('.history-view')).toBeNull();
    source.emit('list', { groups: groups(rows) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(histories()).toEqual([77, 77, 77]);

    // Chosen again, it shows what it showed with the operator's settings, and reads again.
    answers['/page-history'] = { status: 200, body: { view: view({ title: 'Renamed' }), categories: CATEGORIES } };
    historyTab()!.click();
    expect(root.querySelector('.history-view h1')?.textContent).toBe('Inbox <badge>');
    expect(root.querySelector('.hist-chip[data-category="session"]')?.getAttribute('aria-pressed')).toBe('false');
    await flush();
    expect(histories()).toEqual([77, 77, 77, 77]);
    expect(root.querySelector('.history-view h1')?.textContent).toBe('Renamed');
    page.close();
  });

  it("keeps whether each work item's History tab is open with its tabs, and closing one leaves the others' as they were", async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    const { page, source } = start();
    const kept = () => JSON.parse(localStorage.getItem('switchboard.tabs') ?? '{}') as Record<string, { history?: boolean; tab?: string }>;

    hello(source);
    openFromMenu();
    await flush();
    // History cannot close, so a work item's kept tabs no longer say whether it is open.
    expect(kept()['w1']).not.toHaveProperty('history');
    expect(kept()['w1']?.tab).toBe('history');

    // Every work item has the tab; the strip opens on the conversation (PRD R109).
    openItem(source, 2);
    expect(historyTab()?.getAttribute('aria-selected')).toBe('false');
    expect(kept()['w2']).not.toHaveProperty('history');
    openItem(source, 1);
    expect(historyTab()).not.toBeNull();
    expect(root.querySelector('[data-tab="conversation"]')?.getAttribute('aria-selected')).toBe('true');
    page.close();
  });

  it("opens History chosen from another row's menu once that work item's hello has put its kept tabs back, kept or not", async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    const pick = () => {
      root.querySelector<HTMLElement>('#list .row[data-row="item:2"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      root.querySelector<HTMLElement>('.row-menu [data-action="row-history"]')!.click();
    };
    let { page, source } = start();

    // Work item 2 has kept tabs with History closed.
    hello(source);
    openItem(source, 2);
    openItem(source, 1);
    pick();
    source.emit('scope', { scope: scopeOf(2) });
    await flush();
    hello(source, 2);
    await flush();
    expect(historyTab()?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(historyTab());
    expect(histories()).toEqual([78]);
    page.close();

    // And with none kept.
    localStorage.clear();
    history.replaceState(null, '', '#w=1');
    ({ page, source } = start());
    hello(source);
    pick();
    source.emit('scope', { scope: scopeOf(2) });
    await flush();
    hello(source, 2);
    await flush();
    expect(historyTab()?.getAttribute('aria-selected')).toBe('true');
    page.close();
  });

  it("follows the open work item's ticket, and offers no History where the row offers none or no work item is open", async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    const { page, source } = start();

    hello(source);
    openFromMenu();
    await flush();
    root.querySelector<HTMLElement>('.hist-chip[data-category="you"]')!.click();
    expect(histories()).toEqual([77]);

    // Another work item's conversation opens on its own tabs; History chosen there reads that work item's ticket, at Loading… first.
    openItem(source, 2);
    expect(historyTab()?.getAttribute('aria-selected')).toBe('false');
    openFromMenu();
    expect(root.querySelector('.history-view .empty:not(.state-empty)')?.textContent).toBe('Loading…');
    await flush();
    expect(histories()).toEqual([77, 78]);
    expect(root.querySelector('.hist-chip[data-category="you"]')?.getAttribute('aria-pressed')).toBe('true');

    // Back on the first, the strip opens on the conversation (PRD R109). History chosen, its chips are as the operator set them.
    openItem(source, 1);
    expect(historyTab()?.getAttribute('aria-selected')).toBe('false');
    historyTab()!.click();
    await flush();
    expect(histories()).toEqual([77, 78, 77]);
    expect(root.querySelector('.hist-chip[data-category="you"]')?.getAttribute('aria-pressed')).toBe('false');

    // A work item whose row offers no ticket History has the tab, showing only the state, and no menu item, and reads nothing.
    openItem(source, 3);
    historyTab()!.click();
    expect(root.querySelector('.history-view')?.getAttribute('aria-label')).toBe('History');
    expect(root.querySelector('.history-view .hist-hero, .history-view .empty:not(.state-empty)')).toBeNull();
    root.querySelector<HTMLElement>('.header [data-action="actions"]')?.click();
    expect(root.querySelector('[data-action="row-history"]')).toBeNull();

    // A pool ticket's menu has no History, since it has no work item whose tab would show it.
    root.querySelector<HTMLElement>('[data-action="pool-menu"]')!.click();
    expect(root.querySelector('.row-menu .menu-row')).not.toBeNull();
    expect(root.querySelector('.row-menu [data-action="row-history"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(histories()).toEqual([77, 78, 77]);
    page.close();
  });

  it("opens a History link's file in a file tab, its session in the conversation and its folder with Open in VS Code", async () => {
    vi.useFakeTimers();
    const links = [
      { label: 'Draft', icon: 'file', title: 'D:/w/draft.md', open: { type: 'openUrl', url: 'D:/w/draft.md' } },
      { label: 'Open in terminal', icon: 'terminal', title: 'Attach', open: { type: 'open', sessionId: 's0', session: 's0', workItemId: 1 } },
      { label: 'Open', icon: 'folder-opened', title: 'D:/w', open: { type: 'openFolder', path: 'D:/w' } },
    ];
    const withLinks = view({ sections: [{ ...view().sections[0]!, entries: [entry('l', T0, { links })] }] });

    answers['/page-history'] = { status: 200, body: { view: withLinks, categories: CATEGORIES } };
    answers['/select'] = { status: 200, body: { scopeGen: 2 } };
    answers[`path=${encodeURIComponent('D:/w/draft.md')}`] = { status: 200, body: { path: 'D:/w/draft.md', name: 'draft.md', kind: 'markdown', contents: '# Draft', tooLarge: false, size: 7, entries: null, more: false } };
    const { page, source } = start();

    hello(source);
    openFromMenu();
    await flush();
    expect(root.querySelector('[data-entry="l"] [data-action="history-session"]')?.textContent).toBe('Show session');
    root.querySelector<HTMLElement>('[data-entry="l"] [data-action="history-file"]')!.click();
    await flush();
    expect(posts.some((one) => one.url.startsWith('/v1/conversation/local-file?') && one.url.includes(encodeURIComponent('D:/w/draft.md')))).toBe(true);

    historyTab()!.click();
    await flush();
    root.querySelector<HTMLElement>('[data-entry="l"] [data-action="history-session"]')!.click();
    await flush();
    expect(posts.filter((one) => one.url === '/v1/conversation/select').at(-1)?.body).toMatchObject({ workItemId: 1, sessionId: 's0' });

    root.querySelector<HTMLElement>('[data-entry="l"] [data-action="history-folder"]')!.click();
    await flush();
    expect(posts.filter((one) => one.url === '/v1/conversation/row-command').at(-1)?.body).toMatchObject({ workItemId: 1, label: 'Open in VS Code' });
    page.close();
  });

  it('opens a History web link as a conversation link opens: in a link tab where the page shows them, else in a browser tab', async () => {
    vi.useFakeTimers();
    const url = 'https://forum.example.com/t/5';
    const web = { label: 'Forum thread', icon: 'link-external', title: url, open: { type: 'openUrl', url } };

    answers['/page-history'] = { status: 200, body: { view: view({ links: [web] }), categories: CATEGORIES } };

    for (const embedded of [true, false]) {
      opened = [];
      root = document.createElement('div');
      document.body.replaceChildren(root);
      // The extension embeds links, but does not open them in its tab group.
      const { page, source } = start({ extensionInstallable: () => true, toExtension: async (_id, message) => (message['type'] === 'links' ? null : { ok: true }) });

      source.emit('hello', { key: 'pk', groups: groups(rows), scope: scopeOf(1), sessions: [], items: [], more: false, status: null, artifacts: [], settings: { iframeBrowser: embedded } });
      await flush();
      openFromMenu();
      await flush();
      root.querySelector<HTMLElement>('.hist-hero-links [data-action="history-open"]')!.click();
      await flush();
      const tab = root.querySelector<HTMLElement>('[data-action="iframe-open"][aria-selected="true"]');

      if (embedded) {
        // Its tab is named by the History link's label.
        expect(tab?.dataset['url']).toBe(url);
        expect(tab?.textContent).toBe('Forum thread');
        expect(opened).toEqual([]);
      } else {
        expect(tab).toBeNull();
        expect(opened).toEqual([url]);
      }

      page.close();
    }
  });

  it("puts History in a phone's one tab strip after Conversation and Changes, selected once the menu opens it", async () => {
    vi.stubGlobal('innerWidth', 390);
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    const { page, source } = start();

    hello(source);
    expect(document.documentElement.classList.contains('phone')).toBe(true);
    const tabs = () => [...root.querySelectorAll('#head .tabs > .tab')].map((one) => one.textContent);

    expect(tabs()).toEqual(['Conversation', 'Changes', 'History']);
    openFromMenu();
    expect(tabs()).toEqual(['Conversation', 'Changes', 'History']);
    expect(historyTab()?.getAttribute('aria-selected')).toBe('true');
    await flush();
    expect(root.querySelector('#panel.history-pane .history-view h1')?.textContent).toBe('Inbox <badge>');
    page.close();
  });
});
