import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postSnooze, snoozableKeys, snoozeMessage, watchSnoozeControls } from '../src/snooze.js';
import type { SnoozeAnswer, SnoozeControls } from '../src/snooze.js';
import type { Card } from '@switchboard/core/group';
import { issueKey } from '../src/board.js';
import { watchPills } from '../src/pills.js';

const COLUMN = readFileSync(join(import.meta.dirname, 'fixtures', 'column.html'), 'utf8');
const ISSUE = 'https://github.com/github/roadmap/issues/1090';
// Monday 5 October 2026, 9:54 local time.
const MONDAY = new Date(2026, 9, 5, 9, 54);
const six = (month: number, day: number) => new Date(2026, month, day, 6).getTime();

describe('postSnooze (PRD R66)', () => {
  it('posts the URL and wake time as JSON to the hub\'s snooze route', async () => {
    const fetchUrl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"done":true}', { status: 200 }));

    expect(await postSnooze(fetchUrl, ISSUE, 1_800_000_000_000)).toEqual({ done: true });
    expect(fetchUrl).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:47615/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"url":"https://github.com/github/roadmap/issues/1090","until":1800000000000}',
      cache: 'no-store',
    });
  });

  it('returns the hub\'s error, its status when the body has none, and a stopped hub', async () => {
    const reply = (status: number, body: string) => async () => new Response(body, { status });

    expect(await postSnooze(reply(404, '{"error":"Switchboard has no ticket for x."}'), ISSUE, null)).toEqual({ error: 'Switchboard has no ticket for x.' });
    expect(await postSnooze(reply(409, '{"error":"The snooze time has passed."}'), ISSUE, 1)).toEqual({ error: 'The snooze time has passed.' });
    expect(await postSnooze(reply(403, 'forbidden'), ISSUE, null)).toEqual({ error: 'Switchboard answered 403.' });
    expect(await postSnooze(reply(500, '{"error":""}'), ISSUE, null)).toEqual({ error: 'Switchboard answered 500.' });
    expect(await postSnooze(async () => Promise.reject(new TypeError('Failed to fetch')), ISSUE, null)).toEqual({ error: 'Switchboard is not running.' });
  });
});

describe('snoozeMessage', () => {
  it('accepts a snooze with a URL and a wake time or null, and nothing else', () => {
    expect(snoozeMessage({ type: 'snooze', url: ISSUE, until: 5 })).toEqual({ url: ISSUE, until: 5 });
    expect(snoozeMessage({ type: 'snooze', url: ISSUE, until: null })).toEqual({ url: ISSUE, until: null });
    expect(snoozeMessage({ type: 'snoozed' })).toBeNull();
    expect(snoozeMessage({ type: 'snooze', url: ISSUE })).toBeNull();
    expect(snoozeMessage({ type: 'snooze', url: ISSUE, until: Number.NaN })).toBeNull();
    expect(snoozeMessage({ type: 'snooze', url: 7, until: null })).toBeNull();
    expect(snoozeMessage(null)).toBeNull();
  });
});

describe('snoozableKeys', () => {
  it('keeps the issue keys of cards outside Done, and none without cards', () => {
    const card = (url: string, group: 'needs' | 'working' | 'unstarted' | 'done', snoozed = false) => ({ url, playbook: 'dev:x', group, snoozed });

    expect([...snoozableKeys([card('https://github.com/O/R/issues/1', 'needs'), card('https://github.com/o/r/issues/2', 'unstarted', true), card('https://github.com/o/r/issues/3', 'done'), card('https://desk.example.test/4', 'working')])]).toEqual(['o/r#1', 'o/r#2']);
    expect(snoozableKeys(null).size).toBe(0);
  });
});

describe('watchSnoozeControls', () => {
  let controls: SnoozeControls | null = null;

  beforeEach(() => {
    document.body.innerHTML = COLUMN;
  });

  afterEach(() => {
    controls?.stop();
    controls = null;
    document.body.innerHTML = '';
  });

  const card = (id: string) => document.querySelector(`[data-board-card-id="${id}"]`)!;
  const bell = () => document.querySelector<HTMLButtonElement>('.switchboard-snooze-bell');
  const menu = () => document.querySelector<HTMLElement>('.switchboard-snooze-menu');
  const items = () => [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const hover = (target: Element) => target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

  function start(answer: (url: string, until: number | null) => Promise<SnoozeAnswer>) {
    const send = vi.fn(answer);
    const onSnoozed = vi.fn();

    controls = watchSnoozeControls(document, send, onSnoozed, () => MONDAY);

    return { send, onSnoozed };
  }

  it('shows the bell over a hovered issue card, outside GitHub\'s card, and hides it off the cards', () => {
    start(async () => ({ done: true }));
    expect(bell()).toBeNull();

    hover(card('94970044').querySelector('h3')!);
    expect(bell()?.hidden).toBe(false);
    expect(bell()?.title).toBe('Snooze in Switchboard');
    expect(bell()?.parentElement).toBe(document.body);
    expect(card('94970044').querySelector('.switchboard-snooze-bell')).toBeNull();

    hover(bell()!);
    expect(bell()?.hidden).toBe(false);

    hover(document.querySelector('[data-board-column]')!);
    expect(bell()?.hidden).toBe(true);
  });

  it('shows no bell on a card whose title is not a GitHub issue', () => {
    start(async () => ({ done: true }));
    card('94970044').querySelector('h3')!.closest('a')!.setAttribute('href', 'https://github.com/github/roadmap/pull/1090');

    hover(card('94970044'));
    expect(bell()).toBeNull();
  });

  it('shows no bell on a card the hub does not list', () => {
    controls = watchSnoozeControls(document, async () => ({ done: true }), () => {}, () => MONDAY, (url) => url === ISSUE);

    hover(card('88050488'));
    expect(bell()).toBeNull();

    hover(card('94970044'));
    expect(bell()?.hidden).toBe(false);
  });

  it('takes the snoozable cards from the pills\' accepted read, not from a read a later one overtook', async () => {
    const replies: ((cards: Card[]) => void)[] = [];
    let snoozable = new Set<string>();
    const pills = watchPills(document, () => new Promise((resolve) => replies.push(resolve)), () => 0, (cards) => (snoozable = snoozableKeys(cards)));

    controls = watchSnoozeControls(document, async () => ({ done: true }), () => {}, () => MONDAY, (url) => snoozable.has(issueKey(url) ?? ''));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(replies).toHaveLength(2);

    replies[1]!([{ url: ISSUE, playbook: 'dev:review', group: 'needs', snoozed: false }]);
    await vi.waitFor(() => expect(card('94970044').querySelector('.switchboard-pill')).not.toBeNull());
    replies[0]!([{ url: 'https://github.com/github/roadmap/issues/1035', playbook: 'dev:old', group: 'needs', snoozed: false }]);
    await new Promise((done) => setTimeout(done, 0));

    expect(card('88050488').querySelector('.switchboard-pill')).toBeNull();
    hover(card('88050488'));
    expect(bell()).toBeNull();
    hover(card('94970044'));
    expect(bell()?.hidden).toBe(false);
    pills.stop();
  });

  it('offers the R49 choices with their wake times, and sends the chosen one for the hovered card', async () => {
    const { send, onSnoozed } = start(async () => ({ done: true }));

    hover(card('94970044'));
    bell()!.click();

    expect(items().map((item) => item.textContent)).toEqual([
      'TomorrowTue, Oct 6, 6:00 AM',
      'In 2 daysWed, Oct 7, 6:00 AM',
      'In 3 daysThu, Oct 8, 6:00 AM',
      'Next weekMon, Oct 12, 6:00 AM',
      'In 2 weeksMon, Oct 19, 6:00 AM',
      'In 4 weeksMon, Nov 2, 6:00 AM',
      'Indefinitely',
    ]);

    items()[3]!.click();
    expect(send).toHaveBeenCalledExactlyOnceWith(ISSUE, six(9, 12));
    expect(items().every((item) => item.disabled)).toBe(true);

    await vi.waitFor(() => expect(onSnoozed).toHaveBeenCalledTimes(1));
    expect(menu()).toBeNull();
    expect(bell()?.hidden).toBe(true);
  });

  it('sends null for Indefinitely', async () => {
    const { send } = start(async () => ({ done: true }));

    hover(card('88050488'));
    bell()!.click();
    items()[6]!.click();

    expect(send).toHaveBeenCalledExactlyOnceWith('https://github.com/github/roadmap/issues/1035', null);
  });

  it('shows the hub\'s refusal in the menu and keeps the choices open', async () => {
    const { onSnoozed } = start(async () => ({ error: 'Switchboard has no ticket for https://github.com/github/roadmap/issues/1090.' }));

    hover(card('94970044'));
    bell()!.click();
    items()[0]!.click();

    await vi.waitFor(() => expect(menu()?.querySelector('[role="status"]')?.textContent).toBe('Switchboard has no ticket for https://github.com/github/roadmap/issues/1090.'));
    expect(items().some((item) => item.disabled)).toBe(false);
    expect(onSnoozed).not.toHaveBeenCalled();
  });

  it('closes the menu on a second bell click, Escape, a click outside, a scroll, and keeps it while hovering other cards', () => {
    start(async () => ({ done: true }));
    hover(card('94970044'));

    bell()!.click();
    bell()!.click();
    expect(menu()).toBeNull();

    bell()!.click();
    hover(card('88050488'));
    expect(menu()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu()).toBeNull();

    hover(card('94970044'));
    bell()!.click();
    items()[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu()).not.toBeNull();
    document.querySelector('[data-board-column]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu()).toBeNull();

    hover(card('94970044'));
    bell()!.click();
    document.querySelector('[data-dnd-drop-type="card"]')!.dispatchEvent(new Event('scroll'));
    expect(menu()).toBeNull();
    expect(bell()?.hidden).toBe(true);
  });

  it('opens the menu below the bell, or above it when the viewport has no room below', () => {
    start(async () => ({ done: true }));
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(230);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720);

    const at = (top: number) => {
      hover(card('94970044'));
      bell()!.getBoundingClientRect = () => ({ top, bottom: top + 24, left: 300, right: 324 }) as DOMRect;
      bell()!.click();

      const style = { top: menu()!.style.top, left: menu()!.style.left };

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      return style;
    };

    expect(at(100)).toEqual({ top: '128px', left: '104px' });
    expect(at(626)).toEqual({ top: '392px', left: '104px' });
    vi.restoreAllMocks();
  });

  it('shows the bell on a new card after GitHub replaces the body while the menu is open', () => {
    start(async () => ({ done: true }));
    hover(card('94970044'));
    bell()!.click();

    document.body.innerHTML = COLUMN;
    hover(card('88050488'));

    expect(menu()).toBeNull();
    expect(bell()?.hidden).toBe(false);
    expect(bell()?.isConnected).toBe(true);
  });

  it('appends the bell again after the page body is replaced, and removes it when stopped', () => {
    start(async () => ({ done: true }));
    hover(card('94970044'));

    document.body.innerHTML = COLUMN;
    hover(card('94970044'));
    expect(document.querySelectorAll('.switchboard-snooze-bell')).toHaveLength(1);

    controls!.stop();
    controls = null;
    expect(bell()).toBeNull();
    hover(card('94970044'));
    expect(bell()).toBeNull();
  });
});
