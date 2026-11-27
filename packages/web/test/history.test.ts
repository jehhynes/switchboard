import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPage } from '../src/main.js';
import { earlierLabel, EMPTY_HISTORY_UI, entryShown, expandable, historyAction, historyReports, historyUrl, needsYou, renderHistory, renderReportSheet, reportIndex, reportOption, reportStep, RUN_LIMIT } from '../src/history.js';
import type { HistoryHead, HistoryOpen } from '../src/history.js';
import { html } from './html.js';
import type { HistoryCategory, HistoryEntry, HistoryView, PageGroup, PageRow, StateView } from '@switchboard/protocol';
import { drawAtOnce } from './frame.js';
import { resizeTo } from './pageFixtures.js';

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
const entry = (key: string, at: number, patch: Partial<HistoryEntry> = {}): HistoryEntry => ({ key, at, category: 'you', icon: 'play', text: `Entry ${key}`, lines: [], detail: null, shortId: null, links: [], tone: null, reconstructed: false, refused: null, stateChange: false, stateId: null, body: null, stage: false, ...patch });
const view = (patch: Partial<HistoryView> = {}): HistoryView => ({
  key: 'gh 77',
  title: 'Inbox <badge>',
  url: 'https://github.com/o/r/issues/77',
  repo: 'r',
  status: 'Running',
  tone: 'accent',
  playbook: 'dev:build',
  facts: ['Yours since 2026-10-07 09:00'],
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

const HEAD: HistoryHead = { key: 'gh 77', title: 'Inbox badge from the row', sourceKind: 'github', playbook: 'dev:build', status: 'Running', needsYou: null, workItemId: 1, sessionId: 's1' };
const pinned = (patch: Partial<StateView> = {}): StateView => ({ id: 'st-1', sessionId: 's1', at: T0 - 4 * MINUTE, headline: '2/5 fixing tests', body: 'Two **left**.', stale: null, unread: true, shortId: 'abc12345', endedAt: null, ...patch });
const draw = (o: HistoryOpen | null, state: StateView | null = null, head: Partial<HistoryHead> = {}, now = T0 + 25 * 60 * MINUTE, local = true): HTMLElement => {
  const root = document.createElement('div');

  root.innerHTML = html(renderHistory(o, state, now, { ...HEAD, ...head }, local));
  return root;
};
const texts = (root: HTMLElement, selector: string): string[] => [...root.querySelectorAll(selector)].map((one) => one.textContent ?? '');

describe("the page's History (architecture.md § Web page)", () => {
  it('heads the page with the key, repository, links, the title as its only h1, and one line of status, playbook and summary', () => {
    const root = draw(open());
    const headings = [...root.querySelectorAll('h1, h2, h3')];

    expect(root.querySelector('.history-view')?.getAttribute('aria-label')).toBe('gh 77 History');
    // The title is the page's first heading and stands above the pinned state; groups are h2, the pinned state's headline alone is h3.
    expect(headings[0]?.tagName).toBe('H1');
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    expect(root.querySelector('h1')?.textContent).toBe('Inbox <badge>');
    expect(root.querySelector('.hist-head')!.compareDocumentPosition(root.querySelector('.hist-now')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(texts(root, 'h2 .hist-group-title')).toEqual(['dev:build', 'Ticket']);
    expect(root.querySelector('.hist-key')?.textContent).toBe('gh 77');
    expect(root.querySelector('.hist-key svg.source-logo.github')).not.toBeNull();
    expect(root.querySelector('.hist-repo')?.textContent).toBe('r');
    expect(texts(root, '.hist-meta > *')).toEqual(['Running', 'dev:build', 'Yours since 2026-10-07 09:00']);
    expect(root.querySelector('.hist-head-links button.hist-link')?.getAttribute('data-url')).toBe('https://github.com/o/r/issues/77');
  });

  it('shows the head from the row before History loads, after a failed read, and for a row with no ticket History; a pool ticket has no state', () => {
    let root = draw(open({ view: null }), pinned());

    expect(root.querySelector('h1')?.textContent).toBe('Inbox badge from the row');
    expect(root.querySelector('.hist-key')?.textContent).toBe('gh 77');
    expect(texts(root, '.hist-meta > *')).toEqual(['Running', 'dev:build']);
    expect(root.querySelector('.hist-now .hist-now-headline')?.textContent).toBe('2/5 fixing tests');
    expect(root.querySelector('.hist-empty')?.textContent).toBe('Loading…');
    root = draw(open({ view: null, error: 'Unknown ticket 77.' }), pinned());
    expect(root.querySelector('.hist-error')?.textContent).toBe('Unknown ticket 77.');
    expect(root.querySelector('h1')?.textContent).toBe('Inbox badge from the row');
    expect(root.querySelector('.hist-empty')).toBeNull();
    root = draw(null, null);
    expect(root.querySelector('.history-view')?.getAttribute('aria-label')).toBe('gh 77 History');
    expect(root.querySelector('.hist-now.empty')?.textContent).toBe('No state yet. It appears here when the session sets one.');
    expect(root.querySelector('.hist-empty')?.textContent).toBe('No History for this work item. It shows for a work item with a ticket.');
    root = draw(open(), null, { workItemId: null });
    expect(root.querySelector('.hist-now')).toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('Inbox <badge>');
  });

  it("replaces the status pill with Waiting on you while the row waits on the operator, and never names another group's status in the head", () => {
    expect(needsYou({ mark: { kind: 'permission', glyph: '', title: 'Approve a permission' } })).toBe('permission prompt');
    expect(needsYou({ mark: { kind: 'question', glyph: '', title: '' } })).toBe('a question');
    expect(needsYou({ mark: { kind: 'review', glyph: '', title: '' } })).toBe('approval');
    expect(needsYou({ mark: { kind: 'running', glyph: '', title: '' }, questions: 2 })).toBe('2 questions');
    expect(needsYou({ mark: { kind: 'running', glyph: '', title: '' } })).toBeNull();
    expect(needsYou(null)).toBeNull();

    let root = draw(open(), null, { needsYou: 'permission prompt' });

    expect(root.querySelector('.hist-meta .hist-pill')?.textContent).toBe('Waiting on you · permission prompt');
    expect(root.querySelector('.hist-meta .hist-pill')?.className).toContain('tone-warning');
    // History opened for an older work item: the head takes that work item's status and playbook, not the newest's.
    const older = view({ status: 'Running', playbook: 'dev:build', sections: [{ ...view().sections[0]!, key: 'w2', workItemId: 2, title: 'dev:build', status: 'Running' }, { ...view().sections[0]!, key: 'w1', workItemId: 1, title: 'dev:plan', status: 'Done', tone: 'success' }] });

    root = draw(open({ view: older }), pinned(), { playbook: null });
    expect(texts(root, '.hist-meta > *').slice(0, 2)).toEqual(['Done', 'dev:plan']);
    // Its group comes first, holding the pinned state, the newer ones after it in the hub's order.
    expect([...root.querySelectorAll<HTMLElement>('.hist-group')].map((group) => group.dataset['section'])).toEqual(['w1', 'w2']);
    expect(root.querySelector('.hist-now')?.closest('.hist-group')?.getAttribute('data-section')).toBe('w1');
  });

  it('pins the state at the head of the open work item\'s timeline: Now, as of the last turn, the last state, or another session\'s, unread only while its own', () => {
    let root = draw(open(), pinned(), {}, T0);
    const now = root.querySelector('.hist-now')!;

    expect(now.closest('[data-section]')?.getAttribute('data-section')).toBe('w1');
    expect(now.parentElement!.firstElementChild).toBe(now);
    expect(now.getAttribute('data-unread')).toBe('st-1');
    expect(root.querySelectorAll('[data-unread]')).toHaveLength(1);
    expect(now.querySelector('.hist-now-label')?.textContent).toBe('Now');
    expect(now.querySelector('.hist-now-sub')?.textContent).toBe('State from session abc12345 · 4 min ago');
    expect(now.querySelector('h3')?.textContent).toBe('2/5 fixing tests');
    expect(now.querySelector('.hist-now-body strong')?.textContent).toBe('left');
    expect(now.querySelector('.unread-dot')).not.toBeNull();
    root = draw(open(), pinned({ stale: 'turn', unread: false }), {}, T0);
    expect(root.querySelector('.hist-now')?.className).toBe('hist-now stale');
    expect(root.querySelector('.hist-now-label')?.textContent).toBe('As of the last turn');
    expect(root.querySelector('[data-unread]')).toBeNull();
    root = draw(open(), pinned({ stale: 'session', unread: false, endedAt: new Date(2026, 9, 7, 9, 30).getTime() }), {}, T0);
    expect(root.querySelector('.hist-now-label')?.textContent).toBe('Last state');
    expect(root.querySelector('.hist-now-sub')?.textContent).toBe('Session abc12345 ended 9:30 AM · state from 4 min ago');
    root = draw(open(), pinned({ sessionId: 's0', shortId: '7c21', stale: 'session', unread: false }), {}, T0);
    expect(root.querySelector('.hist-now-sub')?.textContent).toBe('From session 7c21 · 4 min ago');
    root = draw(open(), pinned({ sessionId: null, shortId: null, stale: 'session', unread: false }), {}, T0);
    expect(root.querySelector('.hist-now-sub')?.textContent).toBe('State from 4 min ago');
  });

  it('draws one timeline newest first: day headings, state entries as headlines that open the State reports sheet, with no Details, groups and their facts', () => {
    const states = [
      entry('s1', T0 + MINUTE, { category: 'state', icon: 'pulse', text: 'Oldest', stateId: 'r1', body: 'Body one' }),
      entry('s2', T0 + 2 * MINUTE, { category: 'state', icon: 'pulse', text: 'Second', stateId: 'r2', body: 'Body two' }),
      entry('s3', T0 + 3 * MINUTE, { category: 'state', icon: 'pulse', text: 'Third', stateId: 'r3', body: 'Body three' }),
      entry('s4', T0 + 4 * MINUTE, { category: 'state', icon: 'pulse', text: 'Fourth', stateId: 'r4', body: 'Body four' }),
      entry('g', T0 + 5 * MINUTE, { category: 'state', icon: 'pulse', text: 'Planning', stateId: 'stage-s1-5', stage: true }),
    ];
    const timeline = view({ sections: [{ ...view().sections[0]!, entries: [...view().sections[0]!.entries, ...states].sort((a, b) => a.at - b.at) }, view().sections[1]!, { key: 'w0', workItemId: 0, title: 'dev:plan', status: 'Done', tone: 'success', facts: ['Created 2026-10-06 09:00'], prompt: null, entries: [entry('p', T0 - 1440 * MINUTE, { category: 'state', icon: 'pulse', text: 'Plan written', stateId: 'p1' })] }] });
    const root = draw(open({ view: timeline }), pinned(), {}, T0 + 24 * 60 * MINUTE + MINUTE);

    expect(texts(root, '[data-section="w1"] .hist-entry .hist-words')).toEqual(['Entry c', 'Planning', 'Fourth', 'Third', 'Second', 'Session started', 'Oldest', 'Entry a']);
    expect(texts(root, '[data-section="w1"] .hist-day')).toEqual(['Today', 'Yesterday']);
    expect(root.querySelector('[data-entry="g"] .hist-tag')?.textContent).toBe('stage report');
    // A state entry shows its headline and time only: the headline is a button opening the sheet at it in its group, and its body is not drawn.
    expect(root.querySelectorAll('.hist-entry details, .hist-entry .md-doc')).toHaveLength(0);
    expect(root.textContent).not.toContain('Body four');
    const link = root.querySelector<HTMLElement>('[data-entry="s1"] button.hist-words')!;

    expect([link.textContent, link.dataset['action'], link.dataset['section'], link.dataset['state'], link.getAttribute('aria-haspopup')]).toEqual(['Oldest', 'history-report', 'w1', 'r1', 'dialog']);
    expect(root.querySelector('[data-entry="g"] button.hist-words')?.getAttribute('data-state')).toBe('stage-s1-5');
    // Entries other than states keep plain text.
    expect(root.querySelector('[data-entry="a"] .hist-words')?.tagName).toBe('SPAN');
    expect(root.querySelector('[data-entry="s1"] time')?.textContent).toBe('9:01 AM');
    // The open work item's group carries no status pill, since the head says it; another shows its own and, closed, its last state and size.
    expect(root.querySelector('[data-section="w1"] .hist-pill')).toBeNull();
    expect(root.querySelector('[data-section="w1"] .hist-group-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('[data-section="w0"] .hist-pill')?.textContent).toBe('Done');
    expect(root.querySelector('[data-section="w0"] .hist-group-facts')?.textContent).toBe('Created 2026-10-06 09:00 · Plan written · 1 entry');
    expect(root.querySelector('[data-section="w0"] .hist-group-facts span')?.getAttribute('title')).toBe('Last state');
    expect(root.querySelector('[data-section="w0"] .hist-entry')).toBeNull();
    expect(root.querySelector('[data-section="ticket"] .hist-prompt')).toBeNull();
  });

  it("leaves the pinned reply state out of the timeline and names its stage entry Stage report, keeping that entry's attribution and details", () => {
    const entries = [
      entry('r', T0, { category: 'state', icon: 'pulse', text: '2/5 fixing tests', stateId: 'st-1', body: 'Two left.' }),
      entry('g', T0 + MINUTE, { category: 'state', icon: 'pulse', text: 'Planning', stateId: 'stage-1', stage: true, shortId: 'abc12345', lines: ['Status: Running → Blocked'], refused: null }),
    ];
    let root = draw(open({ view: view({ sections: [{ ...view().sections[0]!, entries }] }) }), pinned());

    expect(root.querySelector('[data-entry="r"]')).toBeNull();
    expect(root.querySelector('[data-entry="g"] .hist-words')?.textContent).toBe('Planning');
    root = draw(open({ view: view({ sections: [{ ...view().sections[0]!, entries }] }) }), pinned({ id: 'stage-1' }));
    expect(root.querySelector('[data-entry="r"]')).not.toBeNull();
    expect(root.querySelector('[data-entry="g"]')?.className).toContain('pinned-stage');
    expect(root.querySelector('[data-entry="g"] .hist-words')?.textContent).toBe('Stage report');
    expect(root.querySelector('[data-entry="g"] .hist-sid')?.textContent).toBe('abc12345');
    expect(texts(root, '[data-entry="g"] .hist-lines li')).toEqual(['Status: Running → Blocked']);
  });

  it('puts the text filter on a line of its own with Expand all and Collapse all, and Filters and the chips after it', () => {
    const root = draw(open({ ui: { ...EMPTY_HISTORY_UI, hidden: ['session'], chips: true } }), pinned());
    const tools = root.querySelector<HTMLElement>('.hist-tools')!;
    const find = tools.querySelector<HTMLElement>('.hist-find')!;

    // The filter's line holds the field and the two buttons only, so no chip or count can take the field's width.
    expect(tools.firstElementChild).toBe(find);
    expect([...find.querySelectorAll('input, button')].map((one) => one.getAttribute('aria-label'))).toEqual(['Filter the timeline', 'Expand all', 'Collapse all']);
    expect(find.querySelector('.hist-chips-toggle, .hist-chip')).toBeNull();
    // Filters, then every chip, after the filter's line, in that order.
    expect([...tools.children].slice(1).map((one) => one.getAttribute('data-category') ?? one.textContent)).toEqual(['Filters · 1 hidden', ...CATEGORIES.map((one) => one.key)]);
    expect(tools.className).toBe('hist-tools chips-open');
  });

  it('filters by chip and text, a body included, counting what matches, keeps the pinned state when a filter hides everything, and collapses a long run', () => {
    let root = draw(open({ ui: { ...EMPTY_HISTORY_UI, hidden: ['session'] } }), pinned());

    expect(root.querySelector('[data-section="w1"] .hist-group-facts')?.textContent).toBe('Started 09:00 · 2 of 3 match');
    expect(root.querySelector('.hist-chip[data-category="session"]')?.getAttribute('aria-pressed')).toBe('false');
    root = draw(open({ ui: { ...EMPTY_HISTORY_UI, query: 'nothing like this' } }), pinned());
    expect(root.querySelectorAll('.hist-entry')).toHaveLength(0);
    expect(root.querySelector('.hist-now-headline')?.textContent).toBe('2/5 fixing tests');
    expect(root.querySelector('[data-section="w1"] .hist-empty')?.textContent).toBe('No entries match the filter. Clear it to see every entry.');
    expect(entryShown(entry('x', T0, { body: 'The **retry** loop' }), { ...EMPTY_HISTORY_UI, query: 'retry' })).toBe(true);
    expect(entryShown(entry('x', T0, { links: [{ label: 'PR #9', icon: 'git-pull-request', title: '', open: { type: 'openUrl', url: 'https://x' } }] }), { ...EMPTY_HISTORY_UI, query: 'pr #9' })).toBe(true);
    expect(entryShown(entry('x', T0, { category: 'state' }), { ...EMPTY_HISTORY_UI, hidden: ['state'] })).toBe(false);

    const states = Array.from({ length: RUN_LIMIT + 1 }, (_, index) => entry(`s${index}`, T0 + index * MINUTE, { category: 'session', stateChange: true }));
    const long = view({ reconstructed: true, recordedSince: T0, sections: [{ ...view().sections[0]!, entries: states }] });

    root = draw(open({ view: long }));
    expect(root.querySelector('.hist-run summary')?.textContent).toBe(`${RUN_LIMIT + 1} session state changes, 9:00 AM to 9:05 AM`);
    expect(root.querySelector<HTMLDetailsElement>('.hist-run details')?.dataset['run']).toBe('s5');
    expect(root.querySelector<HTMLDetailsElement>('.hist-run details')?.open).toBe(false);
    expect(expandable(long, EMPTY_HISTORY_UI, HEAD, null, T0)).toMatchObject({ sections: { w1: true }, runs: ['s5'] });
    // A run the filter hides now is opened too, so clearing the filter shows it as Expand all left it.
    expect(expandable(long, { ...EMPTY_HISTORY_UI, query: 'nothing like this' }, HEAD, null, T0).runs).toEqual(['s5']);
    root = draw(open({ view: long, ui: { ...EMPTY_HISTORY_UI, runs: ['s5'] } }));
    expect(root.querySelector<HTMLDetailsElement>('.hist-run details')?.open).toBe(true);
    root = draw(open({ view: { ...long, sections: [{ ...long.sections[0]!, entries: states.slice(0, RUN_LIMIT) }] } }));
    expect(root.querySelector('.hist-run')).toBeNull();
    expect(root.querySelector('.hist-banner')?.textContent).toContain('Switchboard began logging on Wed, Oct 7, 9:00 AM.');
  });

  it('draws each entry with its marks, details, lines and links, and opens a link where the page can', () => {
    const root = draw(open());

    expect(root.querySelector('[data-entry="b"]')?.className).toBe('hist-entry cat-session tone-warning');
    expect(root.querySelector('[data-entry="b"] .hist-sid')?.textContent).toBe('abc12345');
    expect(root.querySelector('[data-entry="b"] .hist-detail')?.textContent).toBe('Which branch?');
    expect(root.querySelector('[data-entry="c"] .refused-mark')?.textContent).toBe('refused');
    expect(texts(root, '[data-entry="c"] .hist-detail')).toEqual(['Not now.']);
    expect(root.querySelector('[data-entry="c"] .hist-lines li')?.textContent).toBe('gh 78 moved');
    expect(root.querySelector('[data-entry="b"] button.hist-link')?.getAttribute('data-action')).toBe('history-folder');
    expect(root.querySelector('[data-entry="b"] button.hist-link')?.getAttribute('title')).toBe('D:/w1\nOpens the work item in VS Code.');
    expect(root.querySelector('.hist-banner')).toBeNull();
    expect(historyUrl({ label: 'f', icon: 'file', title: '', open: { type: 'openUrl', url: 'D:/report.md' } })).toBeNull();
    // A file opens in a file tab, a session in the conversation by its work item and Switchboard ID; a session without them opens nowhere.
    expect(historyAction({ label: 'f', icon: 'file', title: '', open: { type: 'openUrl', url: 'D:/report.md' } })).toEqual({ 'data-action': 'history-file', 'data-path': 'D:/report.md' });
    // A web link carries its label, which names its link tab.
    expect(historyAction({ label: 'PR #9', icon: 'git-pull-request', title: '', open: { type: 'openUrl', url: 'https://x.test/9' } })).toEqual({ 'data-action': 'history-open', 'data-url': 'https://x.test/9', 'data-label': 'PR #9' });
    expect(historyAction({ label: 's', icon: 'terminal', title: '', open: { type: 'open', sessionId: 'native-1', session: 's1', workItemId: 4 } })).toEqual({ 'data-action': 'history-session', 'data-work-item': '4', 'data-session': 's1' });
    expect(historyAction({ label: 's', icon: 'terminal', title: '', open: { type: 'open', sessionId: 'native-1' } })).toBeNull();
    expect(historyAction({ label: 'x', icon: 'x', title: '', open: { type: 'javascript' } })).toBeNull();
  });

  it("shows a folder link as text on a paired device's page, which cannot open VS Code", () => {
    const root = draw(open(), null, {}, T0 + 25 * 60 * MINUTE, false);

    expect(root.querySelector('[data-entry="b"] [data-action="history-folder"]')).toBeNull();
    expect(root.querySelector('[data-entry="b"] .hist-link.off')?.textContent).toBe('Open');
    expect(root.querySelector('[data-entry="b"] .hist-link.off')?.getAttribute('title')).toBe('D:/w1');
    expect(historyAction({ label: 'Open', icon: 'folder-opened', title: '', open: { type: 'openFolder', path: 'D:/w' } }, false)).toBeNull();
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
  /** Opens the History tab as the operator asks for it, from the conversation header's ··· menu, which selects it. */
  const openTab = () => {
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
    openTab();
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

  it("selects the open work item's History tab, follows its chips and filter, and reads it again only while it shows", async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    const { page, source } = start();

    hello(source);
    // History has no tab until asked for, and reads nothing meanwhile.
    expect(historyTab()).toBeNull();
    await flush();
    expect(histories()).toEqual([]);
    openTab();
    expect(historyTab()?.textContent).toBe('History');
    expect(historyTab()?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('.actions-menu')).toBeNull();
    // The head and the state stand at its top while the ticket's History loads.
    expect(root.querySelector('.history-pane .history-view h1')?.textContent).toBe('Item 1');
    expect(root.querySelector('.history-pane .history-view .hist-now.empty')).not.toBeNull();
    expect(root.querySelector('.history-pane .history-view > .hist-empty')?.textContent).toBe('Loading…');
    // No bar of its own: the tab names it, and its close mark closes it.
    expect(root.querySelector('.hist-bar, .hist-close')).toBeNull();
    expect(root.querySelector('.history-tab [data-action="close-history"]')?.getAttribute('aria-label')).toBe('Close History');
    await flush();
    expect(histories()).toEqual([77]);
    expect(root.querySelector('.history-view h1')?.textContent).toBe('Inbox <badge>');

    // A chip, the filter and a group the operator closed stay through the next read.
    root.querySelector<HTMLElement>('.hist-chip[data-category="session"]')!.click();
    expect(root.querySelector('[data-section="w1"] .hist-group-facts')?.textContent).toBe('Started 09:00 · 2 of 3 match');
    const filter = root.querySelector<HTMLInputElement>('.hist-filter')!;

    filter.value = 'first saw';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('[data-section="ticket"] .hist-group-facts')?.textContent).toBe('1 entry');
    expect(root.querySelector('[data-section="w1"] .hist-group-facts')?.textContent).toBe('Started 09:00 · 0 of 3 match');
    const toggles = () => [...root.querySelectorAll('.hist-group-toggle')].map((one) => one.getAttribute('aria-expanded'));

    root.querySelector<HTMLElement>('[data-action="history-section"][data-section="w1"]')!.click();
    expect(toggles()).toEqual(['false', 'false']);
    root.querySelector<HTMLElement>('[data-action="history-all"][data-all="open"]')!.click();
    expect(toggles()).toEqual(['true', 'true']);
    root.querySelector<HTMLElement>('[data-action="history-all"][data-all="close"]')!.click();
    expect(toggles()).toEqual(['false', 'false']);
    root.querySelector<HTMLElement>('[data-action="history-all"][data-all="open"]')!.click();

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
    root.querySelector<HTMLElement>('.hist-head-links .hist-link')!.click();
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

  it('reads History again soon after a new pinned state, not after the same state changes', async () => {
    vi.useFakeTimers();
    const older = Array.from({ length: 4 }, (_, index) => entry(`r${index}`, T0 + index * MINUTE, { category: 'state', icon: 'pulse', text: `State ${index}`, stateId: `r${index}`, body: `Body ${index}` }));

    answers['/page-history'] = { status: 200, body: { view: view({ sections: [{ ...view().sections[0]!, entries: older }] }), categories: CATEGORIES } };
    const { page, source } = start();

    hello(source);
    openTab();
    await flush();
    expect(histories()).toEqual([77]);
    source.emit('state', { state: pinned({ id: 'st-9' }) });
    source.emit('state', { state: pinned({ id: 'st-9', body: 'Grown.' }) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(histories()).toEqual([77, 77]);
    source.emit('state', { state: pinned({ id: 'st-9', stale: 'turn' }) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(histories()).toEqual([77, 77]);
    expect(root.querySelector('.hist-now-headline')?.textContent).toBe('2/5 fixing tests');

    page.close();
  });

  it('pages through the work item\'s state reports in a sheet from Earlier reports or a timeline headline, by buttons, picker and keys', async () => {
    vi.useFakeTimers();
    const older = Array.from({ length: 3 }, (_, index) => entry(`r${index}`, T0 + index * MINUTE, { category: 'state', icon: 'pulse', text: `State ${index}`, stateId: `r${index}`, body: `Body ${index}`, shortId: index === 0 ? '7c21' : 'abc12345' }));

    answers['/page-history'] = { status: 200, body: { view: view({ sections: [{ ...view().sections[0]!, entries: older }] }), categories: CATEGORIES } };
    const { page, source } = start();

    hello(source);
    openTab();
    await flush();
    // The pinned state is newer than the read, so the sheet adds it as the latest.
    source.emit('state', { state: pinned({ id: 'st-9', at: T0 + 10 * MINUTE }) });
    const sheet = () => root.querySelector<HTMLElement>('.hist-report-sheet');
    const shown = () => [sheet()?.querySelector('.hist-report-headline')?.textContent, sheet()?.querySelector('.hist-report-count')?.textContent];
    const earlier = root.querySelector<HTMLElement>('.hist-now [data-action="history-report"]')!;

    expect(earlier.textContent).toBe('Earlier reports · 3');
    earlier.click();
    expect(sheet()?.getAttribute('role')).toBe('dialog');
    expect(sheet()?.getAttribute('aria-labelledby')).toBe('hist-report-title');
    expect(shown()).toEqual(['2/5 fixing tests', '4 of 4 · latest']);
    expect(document.activeElement?.className).toContain('hist-report-pick');
    // It is a layer over the page, drawn outside History's pane, which is inert under it.
    expect(sheet()?.closest('.history-pane')).toBeNull();
    expect(root.querySelector('.history-pane')?.closest('[inert]')).not.toBeNull();
    root.querySelector<HTMLElement>('[data-action="history-report-step"][data-step="-1"]')!.click();
    expect(shown()).toEqual(['State 2', '3 of 4']);
    expect(sheet()?.querySelector('.hist-report-body')?.textContent?.trim()).toBe('Body 2');
    // Left from the sheet's buttons steps older; at the oldest it stays.
    const older1 = root.querySelector<HTMLElement>('[data-action="history-report-step"][data-step="-1"]')!;

    older1.focus();
    for (let press = 0; press < 4; press++) older1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(shown()).toEqual(['State 0', '1 of 4']);
    expect(root.querySelector<HTMLButtonElement>('[data-action="history-report-step"][data-step="-1"]')!.disabled).toBe(true);
    // The disabled button gives the focus to the picker.
    expect(document.activeElement?.className).toContain('hist-report-pick');
    // The picker jumps to any report; Back to latest returns.
    const pick = root.querySelector<HTMLSelectElement>('.hist-report-pick')!;

    pick.value = 'r1';
    pick.dispatchEvent(new Event('input', { bubbles: true }));
    expect(shown()).toEqual(['State 1', '2 of 4']);
    // A read keeps the sheet where it was.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(shown()).toEqual(['State 1', '2 of 4']);
    root.querySelector<HTMLElement>('[data-action="history-report-latest"]')!.click();
    expect(shown()).toEqual(['2/5 fixing tests', '4 of 4 · latest']);
    expect(root.querySelector('[data-action="history-report-latest"]')).toBeNull();
    // Escape closes it and gives the focus back to Earlier reports.
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(sheet()).toBeNull();
    expect(document.activeElement?.className).toBe('hist-now-earlier');

    // A timeline headline opens it at that report; a press inside the sheet keeps it, one on its backdrop or X closes it.
    root.querySelector<HTMLElement>('[data-entry="r0"] [data-action="history-report"]')!.click();
    expect(shown()).toEqual(['State 0', '1 of 4']);
    sheet()!.querySelector<HTMLElement>('.hist-report-headline')!.click();
    expect(sheet()).not.toBeNull();
    root.querySelector<HTMLElement>('.sheet-backdrop')!.click();
    expect(sheet()).toBeNull();
    expect(document.activeElement?.closest('[data-entry]')?.getAttribute('data-entry')).toBe('r0');
    root.querySelector<HTMLElement>('[data-entry="r2"] [data-action="history-report"]')!.click();
    root.querySelector<HTMLElement>('.sheet-close')!.click();
    expect(sheet()).toBeNull();
    expect(root.querySelector('.history-pane')?.closest('[inert]')).toBeNull();
    // Another tab hides the sheet with History; History shown again shows it where it was.
    root.querySelector<HTMLElement>('[data-entry="r2"] [data-action="history-report"]')!.click();
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    expect(sheet()).toBeNull();
    root.querySelector<HTMLElement>('[data-tab="history"]')!.click();
    expect(shown()).toEqual(['State 2', '3 of 4']);
    page.close();
  });

  it("keeps whether each work item's History tab is open with its tabs, and closing one leaves the others' as they were", async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    let { page, source } = start();
    const kept = () => JSON.parse(localStorage.getItem('switchboard.tabs') ?? '{}') as Record<string, { history?: boolean; tab?: string }>;

    hello(source);
    openTab();
    await flush();
    expect(kept()['w1']).toMatchObject({ history: true, tab: 'history' });

    // Opened for one work item only: another has none, and the first has it again, the strip on the conversation (PRD R109).
    openItem(source, 2);
    expect(historyTab()).toBeNull();
    expect(kept()['w2']).not.toHaveProperty('history');
    openTab();
    openItem(source, 1);
    expect(historyTab()?.getAttribute('aria-selected')).toBe('false');
    expect(root.querySelector('[data-tab="conversation"]')?.getAttribute('aria-selected')).toBe('true');

    // Its close mark closes it for that work item alone; the tab shown closed, the strip shows its neighbour or the conversation.
    historyTab()!.click();
    root.querySelector<HTMLElement>('.history-tab [data-action="close-history"]')!.click();
    expect(historyTab()).toBeNull();
    expect(root.querySelector('[data-tab="conversation"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(root.querySelector('[data-tab="conversation"]'));
    expect(kept()['w1']).not.toHaveProperty('history');
    expect(kept()['w2']).toMatchObject({ history: true });
    // No read while it is closed.
    const reads = histories().length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(histories()).toHaveLength(reads);
    page.close();

    // A reload keeps each as it was left on this device.
    history.replaceState(null, '', '#w=2');
    ({ page, source } = start());
    hello(source, 2);
    expect(historyTab()).not.toBeNull();
    openItem(source, 1);
    expect(historyTab()).toBeNull();
    page.close();
  });

  it('CloseDoc_ArtifactAfterHistory_ShowsHistoryAndFocusesIt', async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    const { page, source } = start();

    hello(source);
    source.emit('artifact', { artifact: { path: 'chat/a.md', owner: 'chat', kind: 'note', title: 'A', ext: 'md', type: 'markdown', updatedAt: 1 } });
    openTab();
    root.querySelector<HTMLElement>('#head .artifact-tab[data-path="chat/a.md"] .tab-open')!.click();
    root.querySelector<HTMLElement>('#head [data-action="close-artifact"][data-path="chat/a.md"]')!.click();
    // History is the closed tab's neighbour before it, so it shows, with the focus, rather than the conversation.
    expect(historyTab()?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(historyTab());
    page.close();
  });

  it('HeaderActions_OpenWorkItemWithoutAListRow_OffersHistory', async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope: scopeOf(1), sessions: [], items: [], more: false, state: pinned(), artifacts: [] });
    root.querySelector<HTMLElement>('.header [data-action="actions"]')!.click();
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((one) => one.textContent)).toEqual(['History']);
    root.querySelector<HTMLElement>('.actions-menu [data-action="open-history"]')!.click();
    expect(root.querySelector('.actions-menu')).toBeNull();
    expect(historyTab()?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('.history-view .hist-now-headline')?.textContent).toBe('2/5 fixing tests');
    page.close();
  });

  it('ChangesFallback_LeftForHistory_IsNotReadAgainWhenTheWorkItemReopens', async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    resizeTo(1800);
    const { page, source } = start();
    const changesReads = () => posts.filter((one) => one.url === '/v1/conversation/changes?window=pk').length;

    hello(source);
    await flush();
    expect(changesReads()).toBe(1);
    openTab();
    await flush();
    openItem(source, 2);
    await flush();
    // Work item 2 has History closed, so its column falls back to Changes and reads it.
    expect(root.querySelector('#detail .changes-tab')?.getAttribute('aria-selected')).toBe('true');
    const reads = changesReads();

    expect(reads).toBeGreaterThan(1);
    openItem(source, 1);
    await flush();
    // Back on work item 1, History shows again, and Changes, open only as the fallback before, is neither kept open nor read.
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(JSON.parse(localStorage.getItem('switchboard.tabs')!)['w1']).toMatchObject({ changes: false, history: true });
    expect(changesReads()).toBe(reads);
    page.close();
  });

  it('HistoryTab_Route_OpensItAndKeepsItOverAReload', async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    resizeTo(1800);
    history.replaceState(null, '', '#w=1&t=history');
    let { page, source } = start();

    hello(source);
    await flush();
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(histories()).toEqual([77]);
    page.close();

    // The route without History, as a reload of the address keeps: the tab is still open, kept for the work item.
    history.replaceState(null, '', '#w=1');
    ({ page, source } = start());
    hello(source);
    expect(root.querySelector('#detail [data-side="history"]')).not.toBeNull();
    page.close();
  });

  it('HistoryTab_ClosedOnAWidePage_LeavesTheColumnOnChangesWithNoUnreadDot', async () => {
    vi.useFakeTimers();
    answers['/page-history'] = { status: 200, body: { view: view(), categories: CATEGORIES } };
    resizeTo(1800);
    const { page, source } = start();
    const side = () => root.querySelector('#detail [role="tab"][aria-selected="true"]');
    const changesReads = () => posts.filter((one) => one.url === '/v1/conversation/changes?window=pk').length;

    source.emit('hello', { key: 'pk', groups: groups(rows), scope: scopeOf(1), sessions: [], items: [], more: false, state: pinned({ id: 'st-9', unread: true }), artifacts: [] });
    await flush();
    // Closed, the column shows Changes, its first tab, and reads its list; nothing anywhere marks the unread state.
    expect(root.querySelector('#detail [data-side="history"]')).toBeNull();
    expect(side()?.classList.contains('changes-tab')).toBe(true);
    expect(changesReads()).toBe(1);
    expect(root.querySelector('.tabs .unread-dot, .tab-more .unread-dot')).toBeNull();
    expect(histories()).toEqual([]);

    // Opened from the menu it is selected after Changes; the close mark leaves the column on Changes again.
    openTab();
    await flush();
    expect([...root.querySelectorAll('#detail .side-switch > [data-id]')].map((one) => one.getAttribute('data-id'))).toEqual(['changes', 'files', 'history']);
    expect(side()?.getAttribute('data-side')).toBe('history');
    expect(histories()).toEqual([77]);
    root.querySelector<HTMLElement>('#detail [data-action="close-history"]')!.click();
    expect(side()?.classList.contains('changes-tab')).toBe(true);
    expect(root.querySelector('#detail [data-side="history"]')).toBeNull();
    expect(root.querySelector('.tabs .unread-dot')).toBeNull();
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
    openTab();
    await flush();
    root.querySelector<HTMLElement>('.hist-chip[data-category="you"]')!.click();
    expect(histories()).toEqual([77]);

    // Another work item's conversation opens on its own tabs, History closed; History chosen there reads that work item's ticket, at Loading… first.
    openItem(source, 2);
    expect(historyTab()).toBeNull();
    openTab();
    expect(root.querySelector('.history-view > .hist-empty')?.textContent).toBe('Loading…');
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

    // A work item whose row offers no ticket History has the menu item all the same, its tab showing its head, the state and why, and reads nothing.
    openItem(source, 3);
    openTab();
    expect(root.querySelector('.history-view h1')?.textContent).toBe('Item 3');
    expect(root.querySelector('.history-view .hist-empty')?.textContent).toBe('No History for this work item. It shows for a work item with a ticket.');
    expect(root.querySelector('.history-view .hist-toolbar')).toBeNull();

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
    openTab();
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

  it("shows a History folder link as text on a paired device's page", async () => {
    vi.useFakeTimers();
    const links = [{ label: 'Open', icon: 'folder-opened', title: 'D:/w', open: { type: 'openFolder', path: 'D:/w' } }];
    const withLinks = view({ sections: [{ ...view().sections[0]!, entries: [entry('l', T0, { links })] }] });

    answers['/page-history'] = { status: 200, body: { view: withLinks, categories: CATEGORIES } };
    answers['/select'] = { status: 200, body: { scopeGen: 2 } };
    const { page, source } = start({ local: false });

    hello(source);
    openTab();
    await flush();
    expect(root.querySelector('[data-entry="l"] .hist-link.off')?.textContent).toBe('Open');
    expect(root.querySelector('[data-action="history-folder"]')).toBeNull();
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
      openTab();
      await flush();
      root.querySelector<HTMLElement>('.hist-head-links [data-action="history-open"]')!.click();
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

    expect(tabs()).toEqual(['Chat', 'Changes', 'Files']);
    openTab();
    expect(tabs()).toEqual(['Chat', 'Changes', 'Files', 'History']);
    expect(historyTab()?.getAttribute('aria-selected')).toBe('true');
    await flush();
    expect(root.querySelector('#panel.history-pane .history-view h1')?.textContent).toBe('Inbox <badge>');
    page.close();
  });
});

describe("History's State reports (operator decision 2026-11-27)", () => {
  const report = (key: string, minutes: number, patch: Partial<HistoryEntry> = {}) => entry(key, T0 + minutes * MINUTE, { category: 'state', icon: 'pulse', text: `State ${key}`, stateId: key, body: `Body ${key}`, shortId: 'abc12345', ...patch });
  const drawSheet = (o: HistoryOpen, state: StateView | null, now: number): HTMLElement => {
    const root = document.createElement('div');

    root.innerHTML = html(renderReportSheet(o, state, now, HEAD)!);
    return root;
  };
  const withStates = (entries: HistoryEntry[], other: HistoryEntry[] = []) =>
    view({ sections: [{ ...view().sections[0]!, entries: [...view().sections[0]!.entries, ...entries].sort((a, b) => a.at - b.at) }, { ...view().sections[0]!, key: 'w2', workItemId: 2, entries: other }] });

  it('lists a group\'s reports oldest first, one per state, the pinned state added and current, and none for a group it does not know', () => {
    const states = withStates([report('a', 1, { shortId: '7c21' }), report('b', 2, { stage: true, body: null }), report('b', 3, { text: 'State b again' }), report('c', 4)], [report('x', 1)]);

    expect(historyReports(states, 'w1', null, HEAD).map((one) => [one.id, one.headline, one.body, one.shortId, one.stage])).toEqual([
      ['a', 'State a', 'Body a', '7c21', false],
      // A state logged twice, as a stage entry and a reply, is one report at its first time, keeping its body and stage mark.
      ['b', 'State b again', 'Body b', 'abc12345', true],
      ['c', 'State c', 'Body c', 'abc12345', false],
    ]);
    // The pinned state the read does not hold yet is the newest; one it holds takes the current headline and body.
    expect(historyReports(states, 'w1', pinned({ id: 'n', at: T0 + 9 * MINUTE }), HEAD).map((one) => one.id)).toEqual(['a', 'b', 'c', 'n']);
    expect(historyReports(states, 'w1', pinned({ id: 'c', at: T0 + 4 * MINUTE, headline: 'Now', body: 'Grown' }), HEAD).at(-1)).toMatchObject({ id: 'c', headline: 'Now', body: 'Grown' });
    // Another work item's group pages through its own reports, without the pinned state.
    expect(historyReports(states, 'w2', pinned({ id: 'n' }), HEAD).map((one) => one.id)).toEqual(['x']);
    expect(historyReports(states, 'gone', pinned(), HEAD)).toEqual([]);
    expect(historyReports(view(), 'w1', null, HEAD)).toEqual([]);
  });

  it('steps older and newer within the reports, held at both ends, and falls back to the newest for a report no longer there', () => {
    const reports = historyReports(withStates([report('a', 1), report('b', 2), report('c', 3)]), 'w1', null, HEAD);

    expect(reportIndex(reports, 'a')).toBe(0);
    expect(reportIndex(reports, 'gone')).toBe(2);
    expect(reportIndex([], 'a')).toBe(-1);
    expect(reportStep(reports, 'b', -1)).toBe('a');
    expect(reportStep(reports, 'a', -1)).toBe('a');
    expect(reportStep(reports, 'b', 1)).toBe('c');
    expect(reportStep(reports, 'c', 1)).toBe('c');
    expect(reportStep(reports, 'a', Infinity)).toBe('c');
    expect(reportStep([], 'a', 1)).toBeNull();
  });

  it('offers Earlier reports on the pinned state only with an earlier report, counting them', () => {
    // No reports, and the pinned state alone: no control.
    expect(draw(open(), pinned()).querySelector('.hist-now-earlier')).toBeNull();
    expect(draw(open({ view: withStates([report('st-1', -4)]) }), pinned()).querySelector('.hist-now-earlier')).toBeNull();
    // No state and no view yet: none either.
    expect(draw(open({ view: withStates([report('a', 1)]) }), null).querySelector('.hist-now-earlier')).toBeNull();
    expect(draw(open({ view: null }), pinned()).querySelector('.hist-now-earlier')).toBeNull();
    const button = draw(open({ view: withStates([report('a', -9), report('b', -8)]) }), pinned()).querySelector<HTMLElement>('.hist-now [data-action="history-report"]')!;

    expect([button.textContent, button.dataset['section'], button.dataset['state'], button.getAttribute('aria-haspopup')]).toEqual(['Earlier reports · 2', 'w1', 'st-1', 'dialog']);
    expect(button.querySelector('.codicon-history')).not.toBeNull();
    // A pinned state older than another session's reports counts those as newer, not earlier.
    const reports = historyReports(withStates([report('a', -9), report('b', 5), report('c', 6)]), 'w1', pinned(), HEAD);

    expect(earlierLabel(reports, 'a')).toBe('Newer reports · 3');
    expect(earlierLabel(reports, 'st-1')).toBe('Earlier reports · 1');
    expect(earlierLabel(reports, 'c')).toBe('Earlier reports · 3');
    expect(earlierLabel(historyReports(withStates([report('b', 5), report('c', 6)]), 'w1', pinned(), HEAD), 'st-1')).toBe('Newer reports · 2');
  });

  it('draws the sheet with one report, where it stands, Older and Newer disabled at the ends, a picker newest first, and Back to latest once paged back', () => {
    const states = withStates([report('a', -9, { shortId: '7c21' }), report('b', -8, { stage: true, body: null })]);
    const sheet = (id: string, now = T0) => drawSheet(open({ view: states, ui: { ...EMPTY_HISTORY_UI, report: { section: 'w1', id } } }), pinned(), now).querySelector<HTMLElement>('.sheet')!;
    const disabled = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('.hist-report-step')].map((one) => [one.getAttribute('aria-label'), one.disabled]);
    let root = sheet('st-1');

    expect(root.classList.contains('hist-report-sheet')).toBe(true);
    expect(root.querySelector('#hist-report-title')?.textContent).toBe('State reports');
    expect(root.querySelector('.sheet-close')?.getAttribute('aria-label')).toBe('Close');
    expect(root.closest('.sheet-backdrop')?.getAttribute('data-action')).toBe('history-report-close');
    expect(root.querySelector('.hist-report-count')?.textContent).toBe('3 of 3 · latest');
    expect(root.querySelector('.hist-report-headline')?.textContent).toBe('2/5 fixing tests');
    expect(root.querySelector('.hist-report-body strong')?.textContent).toBe('left');
    expect(texts(root, '.hist-report-meta > *')).toEqual([expect.stringMatching(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, 8:56 AM$/), 'Session abc12345']);
    expect(root.querySelector('[data-action="history-report-latest"]')).toBeNull();
    expect(disabled(root)).toEqual([['Older report', false], ['Newer report', true]]);
    // The picker lists every report newest first, naming the session since two wrote them.
    const pick = root.querySelector<HTMLSelectElement>('select.hist-report-pick')!;

    expect(pick.getAttribute('aria-label')).toBe('Choose a state report');
    expect([...pick.options].map((one) => [one.value, one.textContent, one.selected])).toEqual([
      ['st-1', '8:56 AM · 2/5 fixing tests · session abc12345', true],
      ['b', '8:52 AM · State b · session abc12345', false],
      ['a', '8:51 AM · State a · session 7c21', false],
    ]);
    // Paged back: both steps, Back to latest, and a stage report with no body says so.
    root = sheet('b');
    expect(root.querySelector('.hist-report-count')?.textContent).toBe('2 of 3');
    expect(disabled(root)).toEqual([['Older report', false], ['Newer report', false]]);
    expect(root.querySelector('[data-action="history-report-latest"]')?.textContent).toBe('Back to latest');
    expect(root.querySelector('.hist-report-meta .hist-tag')?.textContent).toBe('stage report');
    expect(root.querySelector('.hist-report-none')?.textContent).toBe('No detail: a stage report sets a headline alone.');
    // A reply state with no body says only that.
    expect(drawSheet(open({ view: withStates([report('h', -9, { body: null }), report('i', -8)]), ui: { ...EMPTY_HISTORY_UI, report: { section: 'w1', id: 'h' } } }), pinned(), T0).querySelector('.hist-report-none')?.textContent).toBe('No detail.');
    root = sheet('a');
    expect(disabled(root)).toEqual([['Older report', true], ['Newer report', false]]);
    expect(texts(root, '.hist-report-meta > *')).toEqual([expect.stringMatching(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, 8:51 AM$/), 'Session 7c21']);
    // A report gone since the sheet opened shows the newest; days before today name their day.
    expect(sheet('gone').querySelector('.hist-report-count')?.textContent).toBe('3 of 3 · latest');
    expect(sheet('a', T0 + 24 * 60 * MINUTE).querySelector('.hist-report-meta time')?.textContent).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, 8:51 AM$/);
  });

  it('names no session in the picker when one session wrote every report, and draws no sheet for a group with no reports', () => {
    const one = historyReports(withStates([report('a', 1)]), 'w1', null, HEAD)[0]!;

    expect(reportOption(one, false, T0)).toBe('9:01 AM · State a');
    expect(reportOption(one, true, T0 + 2 * 24 * 60 * MINUTE)).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, 9:01 AM · State a · session abc12345$/);
    expect(reportOption({ ...one, shortId: null }, true, T0)).toBe('9:01 AM · State a');
    expect(renderReportSheet(open({ ui: { ...EMPTY_HISTORY_UI, report: { section: 'w1', id: 'a' } } }), null, T0, HEAD)).toBeNull();
    expect(renderReportSheet(open({ view: null, ui: { ...EMPTY_HISTORY_UI, report: { section: 'w1', id: 'a' } } }), pinned(), T0, HEAD)).toBeNull();
    expect(renderReportSheet(open(), pinned(), T0, HEAD)).toBeNull();
    expect(renderReportSheet(null, pinned(), T0, HEAD)).toBeNull();
    // The History tab itself never draws the sheet.
    expect(draw(open({ view: withStates([report('a', 1)]), ui: { ...EMPTY_HISTORY_UI, report: { section: 'w1', id: 'a' } } }), pinned()).querySelector('.sheet')).toBeNull();
  });
});
