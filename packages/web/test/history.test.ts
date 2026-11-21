import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPage } from '../src/main.js';
import { EMPTY_HISTORY_UI, entryShown, gapText, historyUrl, renderHistory, RUN_LIMIT } from '../src/history.js';
import type { HistoryOpen } from '../src/history.js';
import { html } from './html.js';
import type { HistoryCategory, HistoryEntry, HistoryView, PageGroup, PageRow } from '@switchboard/protocol';

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
  it("draws the History tab's header, chips, sections with day headings, gaps and marks, the first section open", () => {
    const root = document.createElement('div');

    root.innerHTML = html(renderHistory(open()));
    expect(root.querySelector('.hist-bar-title')?.textContent).toBe('gh 77 History');
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
    // An http link opens in a tab; a folder, a session or a file opens only from VS Code or the dock, which its tooltip says.
    expect(root.querySelector('.hist-hero-links button.hist-link')?.getAttribute('data-url')).toBe('https://github.com/o/r/issues/77');
    expect(root.querySelector('[data-entry="b"] .hist-link.off')?.getAttribute('title')).toBe('D:/w1\nOpen it from VS Code or the dock.');
    expect(root.querySelector('[data-entry="b"] button.hist-link')).toBeNull();
    expect(root.querySelector('.hist-banner')).toBeNull();
  });

  it('filters by chip and text with the count of what shows, collapses a long run of state changes, and says when logging began', () => {
    const root = document.createElement('div');

    root.innerHTML = html(renderHistory(open({ ui: { ...EMPTY_HISTORY_UI, hidden: ['session'] } })));
    expect(root.querySelector('[data-section="w1"] .hist-count')?.textContent).toBe('2 of 3');
    expect(root.querySelector('.hist-chip[data-category="session"]')?.getAttribute('aria-pressed')).toBe('false');
    root.innerHTML = html(renderHistory(open({ ui: { ...EMPTY_HISTORY_UI, query: 'BRANCH', sections: { ticket: true } } })));
    expect(root.querySelectorAll('[data-section="w1"] .hist-entry')).toHaveLength(1);
    expect(root.querySelector('[data-section="ticket"] .hist-empty')?.textContent).toBe('No entries match the filter. Clear it to see every entry.');
    expect(entryShown(entry('x', T0, { links: [{ label: 'PR #9', icon: 'git-pull-request', title: '', open: { type: 'openUrl', url: 'https://x' } }] }), { ...EMPTY_HISTORY_UI, query: 'pr #9' })).toBe(true);

    const states = Array.from({ length: RUN_LIMIT + 1 }, (_, index) => entry(`s${index}`, T0 + index * 1000, { category: 'session', stateChange: true }));
    const long = view({ reconstructed: true, recordedSince: T0, sections: [{ ...view().sections[0]!, entries: states }] });

    root.innerHTML = html(renderHistory(open({ view: long })));
    expect(root.querySelector('.hist-run summary')?.textContent).toBe(`${RUN_LIMIT + 1} session state changes, 09:00:00 to 09:00:05`);
    expect(root.querySelector<HTMLDetailsElement>('.hist-run details')?.open).toBe(false);
    root.innerHTML = html(renderHistory(open({ view: long, ui: { ...EMPTY_HISTORY_UI, runs: ['s0'] } })));
    expect(root.querySelector<HTMLDetailsElement>('.hist-run details')?.open).toBe(true);
    root.innerHTML = html(renderHistory(open({ view: { ...long, sections: [{ ...long.sections[0]!, entries: states.slice(0, RUN_LIMIT) }] } })));
    expect(root.querySelector('.hist-run')).toBeNull();
    expect(root.querySelector('.hist-banner')?.textContent).toContain('Switchboard began logging on 2026-10-07 09:00.');
    // Before the hub answers, and when it cannot.
    root.innerHTML = html(renderHistory(open({ view: null })));
    expect(root.querySelector('.hist-body .empty')?.textContent).toBe('Loading…');
    root.innerHTML = html(renderHistory(open({ view: null, error: 'Unknown ticket 77.' })));
    expect(root.querySelector('.hist-error')?.textContent).toBe('Unknown ticket 77.');
    expect(root.querySelector('.hist-body .empty')).toBeNull();
    expect(gapText(45_000)).toBe('45s');
    expect(gapText(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    expect(historyUrl({ label: 'f', icon: 'file', title: '', open: { type: 'openUrl', url: 'D:/report.md' } })).toBeNull();
  });
});

describe("the page's History in use", () => {
  it('drops an answer that a later read overtook', async () => {
    const releases: Array<(body: unknown) => void> = [];
    const fetch = vi.fn((url: string) =>
      url.endsWith('/page-history')
        ? new Promise<Response>((resolve) => releases.push((body) => resolve({ status: 200, ok: true, json: async () => body } as unknown as Response)))
        : Promise.resolve({ status: 200, ok: true, json: async () => ({}) } as unknown as Response),
    );
    const root = document.createElement('div');

    document.body.replaceChildren(root);
    history.replaceState(null, '', '#');
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => T0 });
    const source = FakeSource.last!;
    const row: PageRow = { workItemId: null, ticketId: 77, title: 'Inbox badge', priority: null, time: null, ticket: 'gh 77', sourceKind: 'github', url: '', playbook: '', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], terminal: false, band: null, voice: null, history: { ticketId: 77, key: 'gh 77' } };

    vi.useFakeTimers();
    source.emit('hello', { key: 'pk', groups: [{ key: 'unstarted', title: 'Unstarted', glyph: 'u', empty: null, rows: [row] }], scope: null });
    root.querySelector<HTMLElement>('[data-action="pool-menu"]')!.click();
    root.querySelector<HTMLElement>('[data-action="row-history"]')!.click();
    source.emit('list', { groups: [{ key: 'unstarted', title: 'Unstarted', glyph: 'u', empty: null, rows: [row] }] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(releases).toHaveLength(2);
    releases[1]!({ view: view({ title: 'Newer' }), categories: CATEGORIES });
    await vi.advanceTimersByTimeAsync(0);
    releases[0]!({ view: view({ title: 'Older' }), categories: CATEGORIES });
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('#history h1')?.textContent).toBe('Newer');
    page.close();
  });

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
    history.replaceState(null, '', '#');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const start = () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const answer = Object.entries(answers).find(([name]) => url.endsWith(name))?.[1] ?? { status: 200, body: {} };

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body, text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => T0, openUrl: (url) => opened.push(url) });

    return { page, source: FakeSource.last! };
  };
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  };
  const row = (patch: Partial<PageRow> = {}): PageRow => ({ workItemId: null, ticketId: 77, title: 'Inbox badge', priority: null, time: null, ticket: 'gh 77', sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], terminal: false, band: null, voice: null, history: { ticketId: 77, key: 'gh 77' }, ...patch });
  const groups = (rows: PageRow[]): PageGroup[] => [{ key: 'unstarted', title: 'Unstarted', glyph: 'u', empty: null, rows }];
  const histories = () => posts.filter((one) => one.url === '/v1/conversation/page-history').map((one) => one.body['ticketId']);

  it("opens a row's History from its menu in the conversation's place, follows its chips and filter, reads it again, and closes", async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: groups([row()]), scope: null });
    root.querySelector<HTMLElement>('[data-action="pool-menu"]')!.click();
    root.querySelector<HTMLElement>('.row-menu [data-action="row-history"]')!.click();
    expect(root.classList.contains('history')).toBe(true);
    expect(root.classList.contains('listing')).toBe(false);
    expect(root.querySelector('#history .hist-body .empty')?.textContent).toBe('Loading…');
    expect(document.activeElement).toBe(root.querySelector('.hist-close'));
    await flush();
    expect(histories()).toEqual([77]);
    expect(root.querySelector('#history h1')?.textContent).toBe('Inbox <badge>');

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
    source.emit('list', { groups: groups([row({ title: 'Inbox badge, renamed' })]) });
    source.emit('list', { groups: groups([row()]) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(histories()).toEqual([77, 77]);
    answers['/page-history'] = { status: 409, body: { error: 'Unknown ticket 77.' } };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(histories()).toEqual([77, 77, 77]);
    expect(root.querySelector('.hist-error')?.textContent).toBe('Unknown ticket 77.');
    expect(root.querySelector('#history h1')).not.toBeNull();
    expect(root.querySelector<HTMLElement>('.hist-filter')!.getAttribute('value') ?? root.querySelector<HTMLInputElement>('.hist-filter')!.value).toBe('first saw');

    // An http link opens in a tab.
    root.querySelector<HTMLElement>('.hist-hero-links .hist-link')!.click();
    expect(opened).toEqual(['https://github.com/o/r/issues/77']);

    // Escape closes it, and no read follows.
    root.querySelector<HTMLElement>('.hist-close')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.classList.contains('history')).toBe(false);
    expect(root.querySelector('#history')?.children).toHaveLength(0);
    // The focus goes back to the row whose menu opened it.
    expect(document.activeElement).toBe(root.querySelector('[data-action="pool-menu"]'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(histories()).toEqual([77, 77, 77]);
    page.close();
  });

  it("opens the selected work item's History from the header's actions menu, keeps its settings for the ticket, and leaves for a row the list opens", async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    answers['/select'] = { status: 200, body: {} };
    history.replaceState(null, '', '#w=1');
    const { page, source } = start();
    const scope = { kind: 'page', key: 'pk', folder: 'D:/w', title: 'Inbox badge', scopeGen: 1, conversations: [{ workItemId: 1, title: 'Inbox badge', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };

    source.emit('hello', { key: 'pk', groups: groups([row({ workItemId: 1, ticketId: null }), row({ workItemId: 2, ticketId: null, history: null })]), scope, sessions: [], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-action="actions"]')!.click();
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((one) => one.textContent)).toContain('History');
    root.querySelector<HTMLElement>('.actions-menu [data-action="row-history"]')!.click();
    await flush();
    expect(histories()).toEqual([77]);
    expect(root.querySelector('.actions-menu')).toBeNull();
    root.querySelector<HTMLElement>('.hist-chip[data-category="you"]')!.click();
    root.querySelector<HTMLElement>('.hist-close')!.click();
    expect(root.classList.contains('history')).toBe(false);
    expect(document.activeElement).toBe(root.querySelector('.header [data-action="actions"]'));

    // Opened again, it keeps the chips the operator set.
    root.querySelector<HTMLElement>('[data-action="actions"]')!.click();
    root.querySelector<HTMLElement>('.actions-menu [data-action="row-history"]')!.click();
    await flush();
    expect(root.querySelector('.hist-chip[data-category="you"]')?.getAttribute('aria-pressed')).toBe('false');

    // A row the list opens shows its conversation in History's place; a row with no History has no History item.
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(root.classList.contains('history')).toBe(false);
    page.close();
  });
});
