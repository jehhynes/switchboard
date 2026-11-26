import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postSnooze, postUnsnooze, snoozeMenus, snoozeMessage, unsnoozeMessage } from '../src/snooze.js';
import { remoteRoutes } from '../src/hub.js';
import type { SnoozeAnswer, SnoozeMenus } from '../src/snooze.js';

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

describe('postSnooze and postUnsnooze on another device (PRD R121)', () => {
  it("post to the routes on the page's origin", async () => {
    const fetchUrl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"done":true}', { status: 200 }));

    await postSnooze(fetchUrl, ISSUE, null, remoteRoutes('https://pc.tail.ts.net'));
    await postUnsnooze(fetchUrl, ISSUE, remoteRoutes('https://pc.tail.ts.net'));
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual(['https://pc.tail.ts.net/v1/browser/snooze', 'https://pc.tail.ts.net/v1/browser/unsnooze']);
  });
});

describe('postUnsnooze (PRD R66)', () => {
  it('posts the URL as JSON to the hub\'s unsnooze route and returns the hub\'s error', async () => {
    const fetchUrl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"done":true}', { status: 200 }));

    expect(await postUnsnooze(fetchUrl, ISSUE)).toEqual({ done: true });
    expect(fetchUrl).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:47615/unsnooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"url":"https://github.com/github/roadmap/issues/1090"}',
      cache: 'no-store',
    });
    expect(await postUnsnooze(async () => new Response('{"error":"Switchboard has no ticket for x."}', { status: 404 }), ISSUE)).toEqual({ error: 'Switchboard has no ticket for x.' });
    expect(await postUnsnooze(async () => Promise.reject(new TypeError('Failed to fetch')), ISSUE)).toEqual({ error: 'Switchboard is not running.' });
  });
});

describe('unsnoozeMessage', () => {
  it('accepts an unsnooze with a URL, and nothing else', () => {
    expect(unsnoozeMessage({ type: 'unsnooze', url: ISSUE })).toEqual({ url: ISSUE });
    expect(unsnoozeMessage({ type: 'snooze', url: ISSUE, until: null })).toBeNull();
    expect(unsnoozeMessage({ type: 'unsnooze' })).toBeNull();
    expect(unsnoozeMessage({ type: 'unsnooze', url: 7 })).toBeNull();
    expect(unsnoozeMessage(null)).toBeNull();
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

describe('snoozeMenus', () => {
  let menus: SnoozeMenus | null = null;
  let anchor: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<button id="anchor">More actions</button><div id="column"></div>';
    anchor = document.querySelector('#anchor')!;
    anchor.getBoundingClientRect = () => ({ top: 100, bottom: 124, left: 300, right: 324 }) as DOMRect;
  });

  afterEach(() => {
    menus?.stop();
    menus = null;
    document.body.innerHTML = '';
  });

  const menu = () => document.querySelector<HTMLElement>('.switchboard-snooze-menu');
  const items = () => [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const status = () => menu()?.querySelector('[role="status"]')?.textContent;

  function start(snooze: (url: string, until: number | null) => Promise<SnoozeAnswer> = async () => ({ done: true }), unsnooze: (url: string) => Promise<SnoozeAnswer> = async () => ({ done: true })) {
    const hub = { snooze: vi.fn(snooze), unsnooze: vi.fn(unsnooze) };
    const onChanged = vi.fn();

    menus = snoozeMenus(document, hub, onChanged, () => MONDAY);

    return { hub, onChanged, menus };
  }

  it('offers the R49 choices with their wake times in body, focuses the first after GitHub returns focus to its button, and sends the chosen one', async () => {
    const { hub, onChanged, menus } = start();

    menus.choose(ISSUE, anchor);

    anchor.focus();
    expect(menu()?.parentElement).toBe(document.body);
    await vi.waitFor(() => expect(document.activeElement).toBe(items()[0]));
    expect(items().map((item) => item.textContent)).toEqual([
      'TomorrowTue, Oct 6, 6:00 AM',
      'In 2 daysWed, Oct 7, 6:00 AM',
      'In 3 daysThu, Oct 8, 6:00 AM',
      'Next weekMon, Oct 12, 6:00 AM',
      'In 2 weeksMon, Oct 19, 6:00 AM',
      'In 4 weeksMon, Nov 2, 6:00 AM',
      'NeverUntil you unsnooze it',
    ]);
    expect(menu()?.querySelector('.switchboard-snooze-menu-heading')?.textContent).toBe('Snooze until');

    items()[3]!.click();
    expect(hub.snooze).toHaveBeenCalledExactlyOnceWith(ISSUE, six(9, 12));
    expect(items().every((item) => item.disabled)).toBe(true);

    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(menu()).toBeNull();
  });

  it('sends null for Never', () => {
    const { hub, menus } = start();

    menus.choose(ISSUE, anchor);
    items()[6]!.click();

    expect(hub.snooze).toHaveBeenCalledExactlyOnceWith(ISSUE, null);
  });

  it('shows the hub\'s refusal in the menu and keeps the choices open', async () => {
    const { onChanged, menus } = start(async () => ({ error: 'The snooze time has passed.' }));

    menus.choose(ISSUE, anchor);
    items()[0]!.click();

    await vi.waitFor(() => expect(status()).toBe('The snooze time has passed.'));
    expect(items().some((item) => item.disabled)).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('unsnoozes with no popup, and shows the hub\'s refusal under the anchor', async () => {
    const { hub, onChanged, menus } = start();

    menus.unsnooze(ISSUE, anchor);
    expect(hub.unsnooze).toHaveBeenCalledExactlyOnceWith(ISSUE);
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(menu()).toBeNull();
    expect(hub.snooze).not.toHaveBeenCalled();

    hub.unsnooze.mockResolvedValueOnce({ error: 'Switchboard is not running.' });
    menus.unsnooze(ISSUE, anchor);
    await vi.waitFor(() => expect(status()).toBe('Switchboard is not running.'));
    expect(menu()!.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape, a click outside and a column scroll, but not a click or scroll inside it', () => {
    const { menus } = start();

    menus.choose(ISSUE, anchor);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu()).toBeNull();

    menus.choose(ISSUE, anchor);
    items()[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    menu()!.dispatchEvent(new Event('scroll'));
    expect(menu()).not.toBeNull();
    document.querySelector('#column')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu()).toBeNull();

    menus.choose(ISSUE, anchor);
    document.querySelector('#column')!.dispatchEvent(new Event('scroll'));
    expect(menu()).toBeNull();

    menus.choose(ISSUE, anchor);
    menus.choose(ISSUE, anchor);
    expect(document.querySelectorAll('.switchboard-snooze-menu')).toHaveLength(1);
  });

  it('opens below the anchor, or above it when the viewport has no room below', () => {
    const { menus } = start();
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(230);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720);

    const at = (top: number) => {
      anchor.getBoundingClientRect = () => ({ top, bottom: top + 24, left: 300, right: 324 }) as DOMRect;
      menus.choose(ISSUE, anchor);

      return { top: menu()!.style.top, left: menu()!.style.left };
    };

    expect(at(100)).toEqual({ top: '128px', left: '104px' });
    expect(at(600)).toEqual({ top: '366px', left: '104px' });
    vi.restoreAllMocks();
  });

  it('removes its popup and stops listening when stopped', () => {
    const { menus: stopped } = start();

    stopped.choose(ISSUE, anchor);
    stopped.stop();
    menus = null;
    expect(menu()).toBeNull();
  });
});
