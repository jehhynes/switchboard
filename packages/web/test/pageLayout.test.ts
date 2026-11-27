import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeline } from '../src/model.js';
import { html } from './html.js';
import { CHAT_MIN, DRAWER_HIDE_MS, DRAWER_REVEAL_MS, loadMermaid, SIDE_MAX, startPage, SWIPE_OPEN } from '../src/main.js';
import { drawAtOnce } from './frame.js';
import { message, reply, session, scope, listRow, listGroup, artifact, resizeTo, FakeSource } from './pageFixtures.js';

describe('the page in use', () => {
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let root: HTMLElement;
  let answers: Record<string, { status: number; body: unknown; text?: string; wait?: Promise<void> }>;
  let installed: boolean;

  beforeEach(() => {
    posts = [];
    answers = {};
    installed = false;
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const start = (loadDiagrams: () => Promise<boolean> = async () => false) => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const name = Object.keys(answers).find((one) => url.includes(one));
      const answer = name === undefined ? { status: 200, body: {} } : answers[name]!;

      await answer.wait;

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body, text: async () => answer.text ?? '' } as unknown as Response;
    });
    const mermaid = vi.fn(loadDiagrams);
    const opened: string[] = [];
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, loadMermaid: mermaid, openUrl: (url) => opened.push(url), standalone: () => installed });

    return { page, source: FakeSource.last!, mermaid, opened };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  /** The panel's text as read: a folded reply's fade is only a glimpse, hidden from screen readers. */
  const shownText = () => {
    const panel = root.querySelector('#panel')!.cloneNode(true) as Element;

    panel.querySelectorAll('.reply-fade-text').forEach((glimpse) => glimpse.remove());
    return panel.textContent;
  };
  const hello = (source: FakeSource, patch: Record<string, unknown> = {}) =>
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side', host: 'w' })])], scope: { ...scope, conversations: [...scope.conversations, { ...scope.conversations[0]!, workItemId: 2, title: 'Side', primary: false }] }, sessions: [session()], items: [message('m1', 1), reply('r1', 2, { unread: true, opening: '1. Port?\n   - A) 1\n   - B) 2', answers: 'm1' })], more: true, state: { id: 'st-r1', sessionId: 's', at: 5_000, headline: 'Working on it', body: '```mermaid\ngraph TD; A-->B;\n```', stale: null, unread: true }, artifacts: [artifact('chat/plan.md', 'markdown', 'md'), artifact('chat/p.html', 'html', 'html')], unread: 1, voice: { enabled: true, here: false, speaking: null, speakReplies: true, error: null }, ...patch });

  it("keeps the drawer open under a sheet from its header, past the pointer leaving it and a press in the sheet", () => {
    vi.useFakeTimers();
    localStorage.setItem('switchboard.listCollapsed', '1');
    window.innerWidth = 1024;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const isOpen = () => root.classList.contains('drawer-open');
    const side = root.querySelector<HTMLElement>('.side')!;

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])] });
    // Shown by a resting pointer, it hides once the pointer leaves, unless something holds it.
    root.querySelector('.sliver')!.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(DRAWER_REVEAL_MS);
    expect(isOpen()).toBe(true);
    root.querySelector<HTMLElement>('.more-actions')!.click();
    root.querySelector<HTMLElement>('.more-menu [data-action="list-extension"]')!.click();
    expect(root.querySelector('#list-sheet .sheet')).not.toBeNull();
    side.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(DRAWER_HIDE_MS * 3);
    expect(isOpen()).toBe(true);
    root.querySelector('#list-sheet .sheet')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(isOpen()).toBe(true);
    // Closed, the sheet no longer holds it.
    root.querySelector<HTMLElement>('#list-sheet .sheet-close')!.click();
    vi.advanceTimersByTime(DRAWER_HIDE_MS * 3);
    expect(isOpen()).toBe(false);
    vi.useRealTimers();
    page.close();
  });

  it('hides the unpinned list in a drawer while a work item is open, shown by its button or a resting pointer and hidden as an auto-hide', () => {
    vi.useFakeTimers();
    localStorage.setItem('switchboard.listCollapsed', '1');
    window.innerWidth = 1024;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const isOpen = () => root.classList.contains('drawer-open');
    const toggle = () => root.querySelector<HTMLElement>('.header > .list-toggle')!;
    const sliver = root.querySelector<HTMLElement>('.sliver')!;
    const side = root.querySelector<HTMLElement>('.side')!;

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', stripe: 'turn' }), listRow(2, { title: 'Two' }), listRow(3, { title: 'Three', stripe: 'warning' })])] });
    expect(root.classList.contains('listing')).toBe(false);
    expect(isOpen()).toBe(false);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    // Hidden, the sliver draws each striped row's stripe at its height, the selected row's the full height, cut to the list's view.
    vi.spyOn(root.querySelector('#list')!, 'getBoundingClientRect').mockReturnValue({ top: 40, bottom: 200 } as DOMRect);
    vi.spyOn(root.querySelector('[data-work-item="1"]')!, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 160 } as DOMRect);
    vi.spyOn(root.querySelector('[data-work-item="3"]')!, 'getBoundingClientRect').mockReturnValue({ top: 160, bottom: 220 } as DOMRect);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(50);
    expect([...sliver.children].map((bar) => [bar.className, (bar as HTMLElement).style.top, (bar as HTMLElement).style.height])).toEqual([
      ['stripe-turn', '100px', '60px'],
      ['stripe-warning', '168px', '32px'],
    ]);

    // The button shows it, with the focus on the open work item's row, and it stays while the pointer is elsewhere.
    toggle().click();
    expect(isOpen()).toBe(true);
    expect(root.classList.contains('drawer-held')).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));
    vi.advanceTimersByTime(2_000);
    expect(isOpen()).toBe(true);
    // Shown, it has no sliver.
    vi.advanceTimersByTime(50);
    expect(sliver.children).toHaveLength(0);
    // Escape hides it and gives the focus to the button.
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(toggle());

    // A press inside keeps it; one outside hides it; the button toggles it.
    toggle().click();
    side.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(isOpen()).toBe(true);
    root.querySelector('#panel')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(isOpen()).toBe(false);
    expect(root.classList.contains('drawer-held')).toBe(false);
    // The backdrop under it takes a press outside, which then only hides it.
    toggle().click();
    const backdrop = root.querySelector<HTMLElement>('.drawer-backdrop')!;

    backdrop.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(isOpen()).toBe(true);
    backdrop.click();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).not.toBe(root.querySelector('[data-work-item="1"]'));
    toggle().click();
    toggle().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    toggle().click();
    expect(isOpen()).toBe(false);

    // Choosing a work item hides it.
    toggle().click();
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(isOpen()).toBe(false);

    // A pointer resting on the sliver for 0.5 s shows it; leaving sooner, or a touch, does not.
    sliver.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(DRAWER_REVEAL_MS - 100);
    sliver.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(1_000);
    expect(isOpen()).toBe(false);
    sliver.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType: 'touch' }));
    vi.advanceTimersByTime(1_000);
    expect(isOpen()).toBe(false);
    sliver.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(DRAWER_REVEAL_MS);
    expect(isOpen()).toBe(true);
    // Shown by the pointer, it has no backdrop.
    expect(root.classList.contains('drawer-held')).toBe(false);
    // Shown that way, it stays while the pointer is over it, and hides 0.4 s after the pointer leaves, unless the search box has the focus.
    vi.advanceTimersByTime(2_000);
    expect(isOpen()).toBe(true);
    side.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(DRAWER_HIDE_MS - 100);
    expect(isOpen()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(isOpen()).toBe(false);

    const search = document.createElement('input');

    side.append(search);
    sliver.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(DRAWER_REVEAL_MS);
    search.focus();
    side.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(2_000);
    expect(isOpen()).toBe(true);
    search.blur();
    vi.advanceTimersByTime(DRAWER_HIDE_MS);
    expect(isOpen()).toBe(false);

    // Where the list is a column, or a phone's view, there is no drawer; narrowed to a phone, which hides the list, the focus goes to Back.
    toggle().click();
    expect(side.contains(document.activeElement)).toBe(true);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => ({ display: element === side ? 'none' : 'block' }) as CSSStyleDeclaration);
    resizeTo(700);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(root.querySelector('.header > .back-toggle'));
    vi.mocked(window.getComputedStyle).mockRestore();
    toggle().click();
    expect(isOpen()).toBe(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    page.close();
  });

  it('puts Status and Artifacts in a column beside the conversation on a wide screen, with their own switch and no toggle, and keeps the tabs otherwise', async () => {
    window.innerWidth = 1920;

    const { page, source } = start();

    hello(source);
    expect(root.querySelector('#head .tabs')).toBeNull();
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.querySelector('#panel .timeline')).not.toBeNull();
    expect(root.querySelector('#detail .history-view')).not.toBeNull();
    expect(root.querySelectorAll('#detail .artifact-tab')).toHaveLength(2);
    // An artifact row in the conversation opens in the column, and the conversation stays.
    click('#panel [data-action="artifact"][data-path="chat/p.html"]');
    expect(root.querySelector('#detail iframe')).not.toBeNull();
    expect(root.querySelector('#panel .timeline')).not.toBeNull();

    // Both side columns show whenever the width allows: no toggle, no shortcut, and no kept choice.
    localStorage.setItem('switchboard.layout', JSON.stringify({ list: false, detail: false }));
    expect(root.querySelector('[data-action="toggle-list"], [data-action="toggle-detail"], .layout-toggle')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, altKey: true, cancelable: true }));
    expect(root.classList.contains('list-hidden')).toBe(false);
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.querySelector('#head .tabs')).toBeNull();

    resizeTo(900);
    expect(root.querySelector('#head .tabs')).not.toBeNull();
    expect(root.querySelector('#detail .detail-body')!.innerHTML).toBe('');
    vi.unstubAllGlobals();
    page.close();
  });

  it('puts each top bar alone in its own box, with the tabs and the search box outside it, so its sticky position has no room to move (mechanics.md M176)', () => {
    window.innerWidth = 390;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();

    hello(source);
    (root.querySelector('.list-header .search-toggle') as HTMLElement).click();
    const bars = [...root.querySelectorAll('.bar-frame')];

    expect(bars.map((one) => [one.parentElement!.id || one.parentElement!.className, [...one.children].map((child) => child.classList[0])])).toEqual([
      ['side-head', ['list-header']],
      ['head', ['header']],
    ]);
    expect(root.querySelector('#head > .tabs')).not.toBeNull();
    expect(root.querySelector('.side-head .search-row')).not.toBeNull();
    expect(root.querySelector('.side-head .search-row')!.closest('.bar-frame')).toBeNull();
    page.close();
  });

  it('keeps the pinned list a column at every width outside the phone, folding the column into tabs, and brings a column back only past its need', () => {
    window.innerWidth = 1440;

    const { page, source } = start();
    const columns = (): string => `${root.classList.contains('drawers') ? 'drawer' : 'list'} + ${root.classList.contains('wide') ? 'column' : 'tabs'}`;

    hello(source);
    // The list's default 340 px, the conversation's 640 and the column's 360 fit 1440 px.
    expect(columns()).toBe('list + column');
    // Under 1340 px they do not: the column folds into the tabs, and the pinned list stays.
    resizeTo(1339);
    expect(columns()).toBe('list + tabs');
    expect(root.querySelector('#head .tabs')).not.toBeNull();
    // The column comes back only 40 px past its need, so a width at the edge does not flap; then it stays until it no longer fits.
    resizeTo(1360);
    expect(columns()).toBe('list + tabs');
    resizeTo(1380);
    expect(columns()).toBe('list + column');
    resizeTo(1340);
    expect(columns()).toBe('list + column');
    // The Surface's portrait width keeps the list too.
    resizeTo(912);
    expect(columns()).toBe('list + tabs');
    resizeTo(768);
    expect(columns()).toBe('list + tabs');
    // A phone has separate views, with neither.
    resizeTo(700);
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('wide')).toBe(false);
    page.close();
  });

  it("counts the pinned list's kept width, and stops its sash where the conversation, and the column while it shows, keep what they need", () => {
    localStorage.setItem('switchboard.sideWidth', '400');
    window.innerWidth = 1366;

    const { page, source } = start();
    const sash = root.querySelector<HTMLElement>('.side-sash')!;

    hello(source);
    // 400 + 640 + 360 is more than 1366 px, which the default 340 px list would fit: the column folds, and the list stays a column.
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('wide')).toBe(false);
    resizeTo(1440);
    expect(root.classList.contains('wide')).toBe(true);
    // End stops at 1440 - 640 - 360 px rather than SIDE_MAX, so the column stays.
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('440');
    expect(root.classList.contains('wide')).toBe(true);
    // With the column folded, End stops where the conversation keeps CHAT_MIN.
    resizeTo(912);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(String(912 - CHAT_MIN));
    expect(root.classList.contains('drawers')).toBe(false);
    page.close();
  });

  it('brings the column back when the conversation is narrowed on its sash, and folds it when widened again', () => {
    window.innerWidth = 1300;

    const { page, source } = start();
    const sash = root.querySelector<HTMLElement>('.chat-sash')!;

    hello(source);
    // The default 340 px list, the conversation at 640 px and the column at 360 px do not fit 1300 px.
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('wide')).toBe(false);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(localStorage.getItem('switchboard.chatWidth')).toBe(String(CHAT_MIN));
    // 340 + 400 + 360 px fit.
    expect(root.classList.contains('wide')).toBe(true);
    sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(root.classList.contains('wide')).toBe(false);
    expect(root.classList.contains('drawers')).toBe(false);
    page.close();
  });

  it('unpins the list into the drawer and pins it back from the pin at its header, from a click or the keyboard, keeping the choice on the device', () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const pin = () => root.querySelector<HTMLButtonElement>('.side-head .list-pin')!;

    hello(source);
    // Pinned by default: a column, and the pin offers to unpin it.
    expect(root.classList.contains('drawers')).toBe(false);
    expect(pin().getAttribute('aria-label')).toBe('Unpin list');
    expect(pin().title).toBe('Unpin list');
    expect(pin().querySelector('.codicon-pinned')).not.toBeNull();
    // Unpinned, the list is a drawer at any width, hidden, with the focus on the button that shows it.
    pin().focus();
    pin().click();
    expect(root.classList.contains('drawers')).toBe(true);
    expect(root.classList.contains('drawer-open')).toBe(false);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBe('1');
    expect(document.activeElement).toBe(root.querySelector('.header > .list-toggle'));
    expect(pin().getAttribute('aria-label')).toBe('Pin list');
    expect(pin().querySelector('.codicon-pin')).not.toBeNull();
    resizeTo(1920);
    expect(root.classList.contains('drawers')).toBe(true);
    // A reload keeps it unpinned.
    page.close();

    const again = start();

    hello(again.source);
    expect(root.classList.contains('drawers')).toBe(true);
    // Pinned from the open drawer, by Enter on the pin as a button takes it, the list is a column again, with the focus still on the pin.
    click('.header > .list-toggle');
    expect(root.classList.contains('drawer-open')).toBe(true);
    pin().focus();
    pin().click();
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('drawer-open')).toBe(false);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBeNull();
    expect(document.activeElement).toBe(pin());
    again.page.close();
  });

  it('leaves the pin out where the list is a column either way, with no work item open, and keeps it on the History tab', () => {
    window.innerWidth = 1180;
    localStorage.setItem('switchboard.listCollapsed', '1');
    history.replaceState(null, '', '#');

    const listing = start();

    // No work item open: the unpinned list is the side column, so a pin there would change nothing.
    hello(listing.source, { scope: null, sessions: [], items: [] });
    expect(root.classList.contains('listing')).toBe(true);
    expect(root.querySelector('.list-pin')).toBeNull();
    // Opening one makes it the drawer, whose header has the pin.
    listing.page.close();
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', history: { ticketId: 1, key: 'gh 1' } })])] });
    expect(root.classList.contains('drawers')).toBe(true);
    expect(root.querySelector('.side-head .list-pin')?.getAttribute('aria-label')).toBe('Pin list');
    // History is a tab of the open work item, so the list stays the drawer and keeps its pin.
    click('[data-tab="history"], [data-side="history"]');
    expect(root.querySelector('[data-tab="history"], [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.classList.contains('drawers')).toBe(true);
    expect(root.querySelector('.side-head .list-pin')?.getAttribute('aria-label')).toBe('Pin list');
    page.close();
  });

  it('has no pin in the phone\'s layout, where the list is its own view', () => {
    window.innerWidth = 700;

    const { page, source } = start();

    hello(source);
    expect(document.documentElement.classList.contains('phone')).toBe(true);
    // page.css hides it in the phone's layout; an unpinned choice kept on a wider window does not make a phone's list a drawer.
    localStorage.setItem('switchboard.listCollapsed', '1');
    resizeTo(699);
    expect(root.classList.contains('drawers')).toBe(false);
    page.close();
  });

  it("keeps nothing from a drag the browser cancels, on either sash", () => {
    localStorage.setItem('switchboard.sideWidth', '300');
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const side = root.querySelector<HTMLElement>('.side')!;
    const sash = root.querySelector<HTMLElement>('.side-sash')!;
    const drawerSash = root.querySelector<HTMLElement>('.drawer-sash')!;
    const width = () => root.style.getPropertyValue('--side-width');

    hello(source);
    vi.spyOn(side, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, width: parseFloat(width()) || 300 }) as DOMRect);
    sash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 380, bubbles: true }));
    expect(width()).toBe('380px');
    sash.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
    expect(root.classList.contains('resizing')).toBe(false);
    expect(width()).toBe('300px');
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('300');

    // The open drawer's sash sets the same width, and a cancelled drag keeps nothing there either.
    click('.side-head .list-pin');
    click('.header > .list-toggle');
    drawerSash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    drawerSash.dispatchEvent(new MouseEvent('pointermove', { clientX: 420, bubbles: true }));
    drawerSash.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
    expect(width()).toBe('300px');
    drawerSash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    drawerSash.dispatchEvent(new MouseEvent('pointermove', { clientX: 420, bubbles: true }));
    drawerSash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    // A release only sets the width: the drawer stays open and unpinned.
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('420');
    expect(root.classList.contains('drawers')).toBe(true);
    expect(root.classList.contains('drawer-open')).toBe(true);
    expect(localStorage.getItem('switchboard.listCollapsed')).toBe('1');
    page.close();
  });

  it('shows the drawer on a touch swiping right from the left edge, not on a mouse, a short or a mostly vertical swipe', () => {
    window.innerWidth = 1024;
    localStorage.setItem('switchboard.listCollapsed', '1');
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();
    const sliver = root.querySelector<HTMLElement>('.sliver')!;
    const isOpen = () => root.classList.contains('drawer-open');
    const pointer = (type: string, x: number, y: number, pointerType = 'touch') => sliver.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { pointerType, pointerId: 1, clientX: x, clientY: y, button: 0 }));

    hello(source);
    expect(root.classList.contains('drawers')).toBe(true);
    pointer('pointerdown', 2, 300, 'mouse');
    pointer('pointermove', 2 + SWIPE_OPEN + 10, 300, 'mouse');
    expect(isOpen()).toBe(false);
    pointer('pointerdown', 2, 300);
    pointer('pointermove', 2 + SWIPE_OPEN - 1, 300);
    pointer('pointerup', 2 + SWIPE_OPEN - 1, 300);
    expect(isOpen()).toBe(false);
    pointer('pointerdown', 2, 300);
    pointer('pointermove', 2 + SWIPE_OPEN, 300 + SWIPE_OPEN + 5);
    pointer('pointermove', 2 + SWIPE_OPEN + 20, 300 + SWIPE_OPEN + 5);
    expect(isOpen()).toBe(false);
    pointer('pointerup', 0, 0);
    pointer('pointerdown', 2, 300);
    pointer('pointermove', 2 + SWIPE_OPEN, 310);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));
    page.close();
  });

  it('maximizes the Status and Artifacts column over the whole page from its strip and restores it from the same button or Escape, only while it is a column', () => {
    window.innerWidth = 1440;

    const { page, source } = start();
    const button = () => root.querySelector<HTMLButtonElement>('#detail .detail-head .panel-max');

    hello(source);
    expect(button()!.getAttribute('aria-label')).toBe('Maximize panel');
    expect(button()!.title).toBe('Maximize panel');
    expect(button()!.querySelector('.codicon-screen-full')).not.toBeNull();
    // The strip's last control, after Changes.
    expect(button()!.parentElement!.lastElementChild).toBe(button());
    button()!.focus();
    button()!.click();
    expect(root.classList.contains('maximized')).toBe(true);
    expect(button()!.getAttribute('aria-label')).toBe('Restore panel');
    expect(button()!.querySelector('.codicon-screen-normal')).not.toBeNull();
    expect(document.activeElement).toBe(button());
    // The list and the conversation stay where they were, under it.
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.querySelector('#panel .timeline')).not.toBeNull();
    button()!.click();
    expect(root.classList.contains('maximized')).toBe(false);
    expect(button()!.getAttribute('aria-label')).toBe('Maximize panel');

    // Escape restores it, from an idle console too, but not from one typing into its session, which stops its keys (console.ts).
    button()!.click();
    const console = root.querySelector('#detail .detail-body')!.appendChild(document.createElement('div'));
    let typing = true;

    console.className = 'console';
    console.addEventListener('keydown', (event) => typing && event.stopPropagation());
    console.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.classList.contains('maximized')).toBe(true);
    typing = false;
    console.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.classList.contains('maximized')).toBe(false);
    expect(document.activeElement).toBe(button());
    button()!.click();
    button()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.classList.contains('maximized')).toBe(false);

    // Where the column folds into tabs it has no button, and a maximized column is restored; a reload keeps nothing.
    button()!.click();
    resizeTo(1100);
    expect(root.classList.contains('wide')).toBe(false);
    expect(root.classList.contains('maximized')).toBe(false);
    expect(root.querySelector('.panel-max')).toBeNull();
    resizeTo(1440);
    expect(root.classList.contains('maximized')).toBe(false);
    button()!.click();
    page.close();

    const again = start();

    hello(again.source);
    expect(root.classList.contains('maximized')).toBe(false);
    again.page.close();
  });

  it('has no maximize button on a phone, which shows one tab at a time', () => {
    window.innerWidth = 700;

    const { page, source } = start();

    hello(source);
    expect(root.querySelector('.panel-max')).toBeNull();
    page.close();
  });

  it('takes a list width kept elsewhere as it is', () => {
    localStorage.setItem('switchboard.sideWidth', '440');
    window.innerWidth = 1440;

    const { page, source } = start();

    hello(source);
    expect(root.classList.contains('wide')).toBe(true);
    // A width kept elsewhere is taken as it is, and a narrower page then folds the column, keeping the list a column.
    resizeTo(1400);
    expect(root.style.getPropertyValue('--side-width')).toBe('440px');
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.classList.contains('wide')).toBe(false);
    page.close();
  });

});
