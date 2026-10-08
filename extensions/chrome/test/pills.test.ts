import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Card } from '@switchboard/core/group';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_MS } from '../src/board.js';
import { MARK_GLYPHS } from '../src/marks.js';
import { applyPills, cardsByIssue, readCards, watchPills } from '../src/pills.js';

const COLUMN = readFileSync(join(import.meta.dirname, 'fixtures', 'column.html'), 'utf8');
const reply = (status: number, body: string) => async () => new Response(body, { status });

const card = (id: string) => document.querySelector<HTMLElement>(`[data-board-card-id="${id}"]`)!;
const pills = () =>
  [...document.querySelectorAll<HTMLElement>('.switchboard-pill')].map((pill) => ({
    card: pill.closest('[data-board-card-id]')?.getAttribute('data-board-card-id'),
    after: pill.previousElementSibling?.id,
    namespace: pill.querySelector('.switchboard-namespace')?.textContent,
    text: pill.textContent,
    group: pill.dataset['switchboardGroup'],
    title: pill.title,
  }));

const needs: Card = { url: 'https://github.com/GitHub/Roadmap/issues/1035', playbook: 'dev:review-pr', group: 'needs', snoozed: false };
const working: Card = { url: 'https://github.com/github/roadmap/issues/1090', playbook: 'dev:new-dev', group: 'working', snoozed: false };

describe('readCards', () => {
  const body = JSON.stringify({ cards: [needs, { url: 'https://desk.example.test/1', playbook: null, group: 'unstarted', snoozed: true }] });

  it('reads the cards from the hub\'s browser endpoint', async () => {
    const fetchUrl = vi.fn(reply(200, body));

    expect(await readCards(fetchUrl)).toEqual([needs, { url: 'https://desk.example.test/1', playbook: null, group: 'unstarted', snoozed: true }]);
    expect(fetchUrl).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:47615/cards');
  });

  it('returns null for a failed request, an older hub\'s 404 or another body', async () => {
    expect(await readCards(async () => Promise.reject(new TypeError('Failed to fetch')))).toBeNull();
    expect(await readCards(reply(404, '{"error":"not found"}'))).toBeNull();
    expect(await readCards(reply(200, 'not json'))).toBeNull();
    expect(await readCards(reply(200, 'null'))).toBeNull();
    expect(await readCards(reply(200, '{}'))).toBeNull();
    expect(await readCards(reply(200, '{"cards":[null]}'))).toBeNull();
    expect(await readCards(reply(200, JSON.stringify({ cards: [{ ...needs, group: 'toString' }] })))).toBeNull();
    expect(await readCards(reply(200, JSON.stringify({ cards: [{ ...needs, playbook: 1 }] })))).toBeNull();
    expect(await readCards(reply(200, JSON.stringify({ cards: [{ ...needs, snoozed: 'no' }] })))).toBeNull();
    expect(await readCards(reply(200, JSON.stringify({ cards: [{ ...needs, url: 2 }] })))).toBeNull();
    expect(await readCards(reply(200, JSON.stringify({ cards: [{ ...needs, mark: 'toString' }] })))).toBeNull();
    expect(await readCards(reply(200, JSON.stringify({ cards: [{ ...needs, mark: 'waiting' }] })))).toBeNull();
  });

  it('accepts a mark, a null mark and a card without one', async () => {
    const cards = [{ ...needs, mark: 'question' }, { ...working, mark: null }, needs];

    expect(await readCards(reply(200, JSON.stringify({ cards })))).toEqual(cards);
  });
});

describe('cardsByIssue', () => {
  it('keys GitHub issue cards by owner/repo#number and leaves out other URLs', () => {
    const map = cardsByIssue([needs, { ...working, url: 'https://github.com/o/r/pull/3' }, { ...working, url: 'https://desk.example.test/1' }]);

    expect([...map.keys()]).toEqual(['github/roadmap#1035']);
  });
});

describe('applyPills', () => {
  beforeEach(() => {
    document.body.innerHTML = COLUMN;
  });

  it('puts a pill after the issue reference of each matching card, warning-coloured only for Needs you', () => {
    applyPills(document, cardsByIssue([needs, working, { url: 'https://github.com/github/roadmap/issues/1153', playbook: null, group: 'unstarted', snoozed: true }]));

    expect(pills()).toEqual([
      { card: '88050488', after: 'board-card-header-title-88050488', namespace: 'dev:', text: 'dev:review-pr', group: 'needs', title: 'Switchboard: Needs you. Click to open in VS Code.' },
      { card: '94970044', after: 'board-card-header-title-94970044', namespace: 'dev:', text: 'dev:new-dev', group: 'working', title: 'Switchboard: Working. Click to open in VS Code.' },
      { card: '126571572', after: 'board-card-header-title-126571572', namespace: '', text: 'Unstarted', group: 'snoozed', title: 'Switchboard: Snoozed. Click to open in VS Code.' },
    ]);
  });

  it('colours a Needs you pill with content.css and leaves others the default colour', () => {
    document.head.innerHTML = `<style>${readFileSync(join(import.meta.dirname, '..', 'src', 'content.css'), 'utf8')}</style>`;
    applyPills(document, cardsByIssue([needs, working]));

    const colour = (id: string) => getComputedStyle(card(id).querySelector('.switchboard-pill')!).color;

    expect(colour('88050488')).toBe('var(--fgColor-attention, #9a6700)');
    expect(colour('94970044')).toBe('var(--fgColor-default, #1f2328)');
    document.head.innerHTML = '';
  });

  it('puts the panel row\'s mark before the playbook and names it in the tooltip', () => {
    applyPills(document, cardsByIssue([
      { ...needs, mark: 'question' },
      { ...working, group: 'unstarted', mark: 'queued' },
      { url: 'https://github.com/github/roadmap/issues/1153', playbook: 'dev:gc-plan', group: 'needs', mark: 'blocked', snoozed: true },
    ]));

    const marks = [...document.querySelectorAll('.switchboard-pill')].map((pill) => {
      const mark = pill.firstElementChild!;

      return [mark.tagName, mark.getAttribute('class'), mark.getAttribute('data-switchboard-mark'), mark.getAttribute('aria-hidden'), pill.textContent, (pill as HTMLElement).title];
    });

    expect(marks).toEqual([
      ['SPAN', 'switchboard-mark', 'question', 'true', '\u{eb32}dev:review-pr', 'Switchboard: Needs you · Answer a question. Click to open in VS Code.'],
      ['SPAN', 'switchboard-mark', 'queued', 'true', '\u{ea82}dev:new-dev', 'Switchboard: Unstarted · Queued. Click to open in VS Code.'],
      ['SPAN', 'switchboard-mark', 'blocked', 'true', '\u{ead1}dev:gc-plan', 'Switchboard: Snoozed · Blocked. Click to open in VS Code.'],
    ]);
  });

  it('draws each mark with the codicon the panel shows for it', () => {
    const css = readFileSync(createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.css'), 'utf8');
    const glyph = (name: string) => String.fromCodePoint(parseInt(new RegExp(`\\.codicon-${name}:before \\{ content: "\\\\(\\w+)" \\}`).exec(css)![1]!, 16));
    const panel = { question: 'question', send: 'send', review: 'eye', blocked: 'debug-pause', failed: 'error', queued: 'clock', setup: 'tools', running: 'sync', triaging: 'loading', 'done-session': 'check', 'done-operator': 'account', 'done-unassigned': 'sign-out' };

    expect(MARK_GLYPHS).toEqual(Object.fromEntries(Object.entries(panel).map(([mark, name]) => [mark, glyph(name)])));
  });

  it('shows no mark for a null mark or a hub that sends none', () => {
    applyPills(document, cardsByIssue([{ ...needs, mark: null }, working]));

    expect(document.querySelectorAll('.switchboard-mark')).toHaveLength(0);
    expect(pills().map((pill) => pill.title)).toEqual(['Switchboard: Needs you. Click to open in VS Code.', 'Switchboard: Working. Click to open in VS Code.']);
  });

  it('colours a Failed mark with content.css and spins Running and Triaging', () => {
    document.head.innerHTML = `<style>${readFileSync(join(import.meta.dirname, '..', 'src', 'content.css'), 'utf8')}</style>`;
    applyPills(document, cardsByIssue([{ ...needs, mark: 'failed' }, { ...working, mark: 'running' }, { url: 'https://github.com/github/roadmap/issues/1153', playbook: null, group: 'unstarted', mark: 'triaging', snoozed: false }]));

    const style = (id: string) => getComputedStyle(card(id).querySelector('.switchboard-mark')!);

    expect(style('88050488').color).toBe('var(--fgColor-danger, #d1242f)');
    expect(style('88050488').animationName).toBe('none');
    expect(style('94970044').animationName).toBe('switchboard-spin');
    expect(style('126571572').animationName).toBe('switchboard-spin');
    document.head.innerHTML = '';
  });

  it('replaces a pill whose mark changed', () => {
    applyPills(document, cardsByIssue([{ ...working, mark: 'setup' }]));
    applyPills(document, cardsByIssue([{ ...working, mark: 'running' }]));

    expect([...document.querySelectorAll('.switchboard-mark')].map((mark) => mark.getAttribute('data-switchboard-mark'))).toEqual(['running']);
  });

  it('matches the title link, not an issue linked in the card fields', () => {
    card('94970044').querySelector('ul[aria-label="Fields"]')!.insertAdjacentHTML('beforeend', '<li><a href="https://github.com/github/roadmap/issues/1035">Parent</a></li>');
    applyPills(document, cardsByIssue([needs]));

    expect(pills().map((pill) => pill.card)).toEqual(['88050488']);
  });

  it('replaces a pill whose card changed and removes pills whose card is gone', () => {
    applyPills(document, cardsByIssue([needs, working]));
    applyPills(document, cardsByIssue([{ ...needs, playbook: 'dev:review-pr-followup', group: 'working' }]));

    expect(pills()).toEqual([
      { card: '88050488', after: 'board-card-header-title-88050488', namespace: 'dev:', text: 'dev:review-pr-followup', group: 'working', title: 'Switchboard: Working. Click to open in VS Code.' },
    ]);

    applyPills(document, new Map());
    expect(pills()).toEqual([]);
  });

  it('makes no mutation when applied again unchanged', async () => {
    const cards = cardsByIssue([{ ...needs, mark: 'question' }, working]);

    applyPills(document, cards);

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    applyPills(document, cards);
    await Promise.resolve();
    observer.disconnect();

    expect(records).toEqual([]);
  });

  it('adds nothing to a card GitHub has emptied out of view', () => {
    card('88050488').replaceChildren();
    applyPills(document, cardsByIssue([needs]));

    expect(pills()).toEqual([]);
  });
});

describe('watchPills', () => {
  let watch: { stop(): void } | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    watch?.stop();
    watch = null;
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('reads nothing while no board is on the page, then reads, applies and refreshes', async () => {
    let time = 0;
    const read = vi.fn(async (): Promise<Card[] | null> => [needs]);

    document.body.innerHTML = '<main>repository page</main>';
    watch = watchPills(document, read, () => time);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(read).not.toHaveBeenCalled();

    document.body.innerHTML = COLUMN;
    await vi.advanceTimersByTimeAsync(60);
    expect(read).toHaveBeenCalledTimes(1);
    expect(pills().map((pill) => pill.card)).toEqual(['88050488']);

    // A card GitHub renders again gets its pill back without another read.
    const fresh = card('88050488').cloneNode(true) as Element;

    fresh.querySelector('.switchboard-pill')!.remove();
    card('88050488').replaceWith(fresh);
    await vi.advanceTimersByTimeAsync(60);
    expect(pills().map((pill) => pill.card)).toEqual(['88050488']);
    expect(read).toHaveBeenCalledTimes(1);

    time = REFRESH_MS;
    read.mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(read).toHaveBeenCalledTimes(2);
    expect(pills()).toEqual([]);
  });

  it('reads again on refresh before REFRESH_MS has passed', async () => {
    const read = vi.fn(async (): Promise<Card[] | null> => [needs]);

    document.body.innerHTML = COLUMN;
    const watcher = watchPills(document, read, () => 0);
    watch = watcher;
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    read.mockResolvedValueOnce([working]);
    watcher.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(pills().map((pill) => pill.card)).toEqual(['94970044']);
  });

  it('reads again when the tab becomes visible and ignores a read that a later read overtook', async () => {
    const replies: ((cards: Card[]) => void)[] = [];

    document.body.innerHTML = COLUMN;
    watch = watchPills(document, () => new Promise((resolve) => replies.push(resolve)), () => 0);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(replies).toHaveLength(2);

    replies[1]!([working]);
    await vi.advanceTimersByTimeAsync(0);
    replies[0]!([needs]);
    await vi.advanceTimersByTimeAsync(0);

    expect(pills().map((pill) => pill.card)).toEqual(['94970044']);
  });
});
