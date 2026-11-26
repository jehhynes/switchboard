import { afterEach, onTestFinished, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeline } from '../src/model.js';
import { collapsedGroups } from '../src/render.js';
import { startPage } from '../src/main.js';
import { BACKOFF_MS, JITTER } from '../src/connection.js';
import { drawAtOnce } from './frame.js';
import { message, reply, session, scope, listRow, listGroup, resizeTo, FakeSource } from './pageFixtures.js';

describe('the page', () => {
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let root: HTMLElement;

  beforeEach(() => {
    posts = [];
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#w=1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const start = () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return { status: 200, ok: true, json: async () => ({}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });

    return { page, source: FakeSource.last! };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));


  it('takes the voice back over the new stream after a hub restart with no tap, and offers the new build without ever reloading by itself', async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    history.replaceState(null, '', '#');

    const width = window.innerWidth;
    const tick = () => vi.advanceTimersByTimeAsync(0);
    const sockets: Array<{ url: string; sent: unknown[]; onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; onclose: ((event: { code: number; reason: string }) => void) | null }> = [];
    const contexts: Array<{ closed: boolean }> = [];
    const reload = vi.fn();

    vi.stubGlobal('AudioContext', class {
      state = 'running';
      destination = {};
      onstatechange = null;
      closed = false;
      audioWorklet = { addModule: async () => undefined };
      resume = async () => undefined;
      close = async () => void (this.closed = true);
      createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
      constructor() {
        contexts.push(this);
      }
    });
    vi.stubGlobal('AudioWorkletNode', class {
      port = { postMessage: () => undefined, onmessage: null };
      connect(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal('WebSocket', class {
      binaryType = 'blob';
      readonly sent: unknown[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      constructor(readonly url: string) {
        sockets.push(this);
      }
      send(data: unknown): void {
        this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
      }
      close(): void {}
    });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getAudioTracks: () => [{ muted: false, readyState: 'live', stop: () => undefined }] }) } });
    onTestFinished(() => void Reflect.deleteProperty(navigator, 'mediaDevices'));
    onTestFinished(() => void vi.unstubAllGlobals());

    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return { status: 200, ok: true, json: async () => (url === '/page/ping' ? { build: 'b2' } : url.endsWith('/page-voice-ticket') ? { ticket: 't1' } : {}), text: async () => '' } as unknown as Response;
    });

    window.innerWidth = 375;

    const paired = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, build: 'b1', reload });
    const phone = FakeSource.last!;
    const hello = (key: string) => FakeSource.last!.emit('hello', { key, groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });

    hello('pk');
    phone.emit('voice', { voice: { enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null } });
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    await tick();
    expect(sockets.map((one) => one.url)).toEqual([expect.stringMatching(/\/v1\/voice\/socket\?window=pk&ticket=t1$/)]);
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'welcome', at: 0 }) });
    await tick();
    await tick();

    // The hub restarts onto build b2: it closes the voice for the restart, and the page's stream fails until the new hub answers.
    sockets[0]!.onclose?.({ code: 4002, reason: 'Switchboard is restarting.' });
    phone.emit('error', {});
    expect(phone.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]! * (1 + JITTER));
    expect(contexts.map((one) => one.closed)).toEqual([false]);
    // The page opens its stream again itself, after asking the hub's build.
    expect(FakeSource.last).not.toBe(phone);

    // The new stream has a new key: the voice socket opens with it and takes the voice back.
    hello('pk2');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets.map((one) => one.url)).toEqual([expect.stringMatching(/window=pk&ticket=t1$/), expect.stringMatching(/window=pk2&ticket=t1$/)]);
    sockets[1]!.onopen?.();
    expect(sockets[1]!.sent).toEqual([{ type: 'hello', resume: true }]);
    sockets[1]!.onmessage?.({ data: JSON.stringify({ type: 'welcome', at: 0 }) });
    await vi.advanceTimersByTimeAsync(6_000);
    // No reload for the new build: the page offers one, since a reload would end the phone's audio until the next tap.
    expect(reload).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
    expect(root.querySelector('.conn-update')?.textContent).toBe('Update readyReload to use the new version of Switchboard.Reload');
    expect(root.querySelector('.conn-update .codicon-sync')?.getAttribute('aria-hidden')).toBe('true');

    // Not once the voice is off on this phone either; only the chip's Reload reloads.
    sockets[1]!.onclose?.({ code: 4003, reason: 'Voice is no longer allowed on this device.' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(reload).not.toHaveBeenCalled();
    root.querySelector<HTMLElement>('[data-action="conn-reload"]')!.click();
    expect(reload).toHaveBeenCalledTimes(1);
    window.innerWidth = width;
    paired.close();
  });

  it("draws the phone's layout on a phone on its side, wider than 768 px, and the tablet's on an iPad (isPhone)", async () => {
    history.replaceState(null, '', '#');

    const width = window.innerWidth;
    const groups = [listGroup('progress', [listRow(1), listRow(2)])];
    const mics = () => posts.filter((post) => post.url.endsWith('/mic')).map((post) => post.body['on']);
    let t = 0;
    const swipe = (target: Element): void => {
      // Fake timers fake performance too, so its clock is mocked after them.
      vi.useFakeTimers();
      vi.spyOn(performance, 'now').mockImplementation(() => t);
      for (const [type, x] of [['touchstart', 150], ['touchmove', 165], ['touchmove', 330]] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });

        Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: 200 }] });
        t += 16;
        target.dispatchEvent(event);
      }

      target.dispatchEvent(Object.defineProperty(new Event('touchend', { bubbles: true }), 'touches', { value: [] }));
      vi.advanceTimersByTime(400);
      vi.useRealTimers();
    };

    onTestFinished(() => {
      window.innerWidth = width;
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });
    // An iPhone 14 on its side: 844 px wide, its screen 390 by 844.
    vi.stubGlobal('screen', { width: 390, height: 844 });
    window.innerWidth = 844;

    const phone = start();

    phone.source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    expect(document.documentElement.classList.contains('phone')).toBe(true);
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [] });
    // Separate views, no drawer, and the conversation a history entry of its own, as in portrait.
    expect(root.classList.contains('listing')).toBe(false);
    expect(root.classList.contains('drawers')).toBe(false);
    expect(history.state).toEqual({ switchboardConversation: true });
    // Back leaves the work item, so the mic on for it turns off.
    phone.source.emit('voice', { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: true, error: null } });
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    expect(root.classList.contains('listing')).toBe(true);
    expect(mics()).toEqual([false]);
    // A swipe right over the conversation goes back too.
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    expect(root.classList.contains('listing')).toBe(false);
    swipe(root.querySelector('#panel .timeline')!);
    expect(root.classList.contains('listing')).toBe(true);
    phone.page.close();
    expect(document.documentElement.classList.contains('phone')).toBe(false);

    // An iPad Air on its side, 1180 px wide, gets the pinned list beside the conversation, and a swipe stays.
    vi.stubGlobal('screen', { width: 820, height: 1180 });
    window.innerWidth = 1180;
    history.replaceState(null, '', '#');
    root = document.createElement('div');
    document.body.replaceChildren(root);

    const tablet = start();

    tablet.source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    expect(document.documentElement.classList.contains('phone')).toBe(false);
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    tablet.source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [] });
    expect(root.classList.contains('drawers')).toBe(false);
    expect(root.querySelector('.list-pin')).not.toBeNull();
    expect(history.state).not.toEqual({ switchboardConversation: true });
    swipe(root.querySelector('#panel .timeline')!);
    expect(root.classList.contains('listing')).toBe(false);

    // Turned to portrait, 820 px wide, it keeps the tablet's layout; a window narrowed under 768 px gets the phone's.
    resizeTo(820);
    expect(document.documentElement.classList.contains('phone')).toBe(false);
    resizeTo(700);
    expect(document.documentElement.classList.contains('phone')).toBe(true);
    expect(root.classList.contains('drawers')).toBe(false);
    tablet.page.close();
  });

  it('goes back to the list on a phone with a swipe right over the conversation, as Back does, but not over a menu or from a wider page', async () => {
    history.replaceState(null, '', '#');
    vi.useFakeTimers();

    const { page, source } = start();
    const groups = [listGroup('progress', [listRow(1), listRow(2)])];
    const main = root.querySelector<HTMLElement>('.main')!;
    let t = 0;
    const swipe = (target: Element): void => {
      for (const [type, x] of [['touchstart', 150], ['touchmove', 165], ['touchmove', 330]] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });

        Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: 400 }] });
        t += 16;
        target.dispatchEvent(event);
      }

      target.dispatchEvent(Object.defineProperty(new Event('touchend', { bubbles: true }), 'touches', { value: [] }));
      vi.advanceTimersByTime(400);
    };

    vi.spyOn(performance, 'now').mockImplementation(() => t);
    source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [] });
    expect(root.classList.contains('listing')).toBe(false);

    // With the header's dropdown open the swipe is the menu's, and the conversation stays.
    root.querySelector<HTMLElement>('.header .picker')!.click();
    expect(root.querySelector('.menu, [role="menu"]')).not.toBeNull();
    swipe(root.querySelector('#panel .timeline')!);
    expect(root.classList.contains('listing')).toBe(false);
    root.querySelector<HTMLElement>('.header .picker')!.click();
    expect(root.querySelector('.menu, [role="menu"]')).toBeNull();

    swipe(root.querySelector('#panel .timeline')!);
    expect(root.classList.contains('listing')).toBe(true);
    expect(root.classList.contains('swiping')).toBe(false);
    expect(main.style.transform).toBe('');
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));

    // From tablet width the list is beside the conversation, and a swipe does nothing.
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    resizeTo(1024);
    swipe(root.querySelector('#panel .timeline')!);
    expect(root.classList.contains('listing')).toBe(false);
    vi.useRealTimers();
    vi.restoreAllMocks();
    page.close();
  });

  it('leaves an iOS edge swipe to browser history before and after the conversation marker is cleared', async () => {
    history.replaceState(null, '', '#');
    const userAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');

    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
    onTestFinished(() => {
      if (userAgent === undefined) {
        Reflect.deleteProperty(navigator, 'userAgent');
      } else {
        Object.defineProperty(navigator, 'userAgent', userAgent);
      }
    });

    const { page, source } = start();
    const groups = [listGroup('progress', [listRow(1)])];

    source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [] });
    expect(history.state).toEqual({ switchboardConversation: true });

    const target = root.querySelector<HTMLElement>('#panel .timeline')!;

    const drag = (): void => {
      for (const [type, x] of [['touchstart', 5], ['touchmove', 25], ['touchmove', 190]] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });

        Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: 400 }] });
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(root.classList.contains('swiping')).toBe(false);
      }
    };

    drag();
    history.replaceState(null, '', '#w=1');
    drag();
    history.replaceState({ switchboardConversation: true }, '', '#w=1');

    expect(root.querySelector<HTMLElement>('.main')!.style.transform).toBe('');
    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));

    history.back();
    await popped;
    expect(root.classList.contains('listing')).toBe(true);
    const returned = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));

    history.forward();
    await returned;
    page.close();
  });

it("makes a phone's conversation a history entry, which the browser's back leaves as Back does and its forward opens again", async () => {
    history.replaceState(null, '', '#');

    const { page, source } = start();
    const groups = [listGroup('progress', [listRow(1), listRow(2)])];
    const popped = () => new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    const entries = history.length;

    source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    expect(history.length).toBe(entries + 1);
    expect(location.hash).toBe('#w=1');

    // Back, as Android's back button gives it: the list, on the selected row, and the list's entry is the list's address, so a reload shows it.
    let pop = popped();

    history.back();
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));
    expect(location.hash).toBe('#list');
    // Forward opens the conversation again.
    pop = popped();
    history.forward();
    await pop;
    expect(root.classList.contains('listing')).toBe(false);

    // The Back button takes the entry with it, so the browser's back from the list leaves the page as before.
    pop = popped();
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    expect(root.classList.contains('listing')).toBe(true);
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(history.state).toBeNull();
    expect(location.hash).toBe('#list');

    // Another conversation chosen from the header's dropdown replaces the entry rather than adding one.
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    source.emit('hello', { key: 'pk', groups, scope: { ...scope, workItemId: 2, conversations: [...scope.conversations, { ...scope.conversations[0]!, workItemId: 2, title: 'Item 2', primary: false }] }, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    const after = history.length;

    root.querySelector<HTMLElement>('.header .picker')!.click();
    root.querySelector<HTMLElement>('.header [role="menu"] [data-action="select"][data-work-item="1"]')!.click();
    expect(history.length).toBe(after);
    expect(location.hash).toBe('#w=1');

    // A row opened before Back's own step back lands keeps an entry of its own.
    pop = popped();
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    await pop;
    expect(root.classList.contains('listing')).toBe(false);
    expect(history.state).toEqual({ switchboardConversation: true });
    expect(location.hash).toBe('#w=2');
    page.close();
  });

it('steps back through history once for Back, select and Back in quick succession, and drops a refused row\'s entry, and keeps a reloaded conversation\'s entry', async () => {
    // The entries a phone's page made before the reload: the list's, and the conversation's over it.
    history.replaceState(null, '', '#list');
    history.pushState({ switchboardConversation: true }, '', '#w=1');

    const entries = history.length;

    const fetch = vi.fn(async (url: string) => ({ status: url.endsWith('/select') && refuse ? 404 : 200, ok: true, json: async () => (refuse ? { error: 'That work item is gone.' } : {}), text: async () => '' }) as unknown as Response);
    let refuse = false;
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;
    const groups = [listGroup('progress', [listRow(1), listRow(2)])];

    // A reload keeps the conversation's entry over the list's, adding none, so Back steps back to the list's.
    expect(history.state).toEqual({ switchboardConversation: true });
    expect(history.length).toBe(entries);
    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });

    const back = vi.spyOn(history, 'back');
    const popped = () => new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    let pop = popped();

    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    expect(back).toHaveBeenCalledOnce();
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(location.hash).toBe('#list');
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(history.state).toEqual({ switchboardConversation: true });

    pop = popped();

    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    expect(back).toHaveBeenCalledTimes(2);
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(history.state).toBeNull();

    // A refused first open from the list shows why in its place; Back to the list takes its entry back with it.
    source.emit('hello', { key: 'pk2', groups, scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    refuse = true;
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(history.state).toEqual({ switchboardConversation: true });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(root.querySelector('#panel .opening-why')?.textContent).toBe('That work item is gone.');
    pop = popped();
    root.querySelector<HTMLElement>('[data-action="open-back"]')!.click();
    await pop;
    expect(back).toHaveBeenCalledTimes(3);
    expect(root.classList.contains('listing')).toBe(true);
    expect(history.state).toBeNull();
    back.mockRestore();
    page.close();
  });

it("turns the mic off through Back's path when a phone's conversation is left by a swipe or the browser's back (PRD R119)", async () => {
    history.replaceState(null, '', '#');
    window.innerWidth = 375;

    const voice = (mic: string) => ({ voice: { enabled: true, here: true, mic, speaking: null, speakReplies: true, error: null } });
    const mics = () => posts.filter((post) => post.url.endsWith('/mic')).map((post) => post.body['on']);
    const groups = [listGroup('progress', [listRow(1)])];
    const { page, source } = start();
    const open = async (): Promise<void> => {
      root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
      await flush();
      source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [] });
      source.emit('voice', voice('listening'));
    };
    const swipe = async (): Promise<void> => {
      const target = root.querySelector('#panel .timeline')!;

      for (const [type, x] of [['touchstart', 150], ['touchmove', 165], ['touchmove', 330]] as const) {
        target.dispatchEvent(Object.defineProperty(new Event(type, { bubbles: true, cancelable: true }), 'touches', { value: [{ clientX: x, clientY: 400 }] }));
      }

      // The swipe goes Back's path, whose step back through history lands as a popstate after the conversation slides away.
      const landed = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));

      target.dispatchEvent(Object.defineProperty(new Event('touchend', { bubbles: true }), 'touches', { value: [] }));
      await landed;
      await vi.waitFor(() => expect(root.classList.contains('listing')).toBe(true), { timeout: 4_000 });
    };

    source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    await open();
    await swipe();
    expect(root.classList.contains('listing')).toBe(true);
    expect(mics()).toEqual([false]);

    // The browser's back, as Android's back button gives it.
    await open();

    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));

    history.back();
    await popped;
    await vi.waitFor(() => expect(root.classList.contains('listing')).toBe(true));
    expect(mics()).toEqual([false, false]);
    // Speech goes on: no Stop is sent.
    expect(posts.some((post) => post.url.endsWith('/stop-speaking'))).toBe(false);
    page.close();
  });

  it('adds no history entry from tablet width, where the list stays beside the conversation', () => {
    history.replaceState(null, '', '#');
    window.innerWidth = 1024;

    const { page, source } = start();
    const entries = history.length;

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    expect(history.length).toBe(entries);
    expect(location.hash).toBe('#w=1');
    page.close();
  });

  it("shows a refused open in the work item's place under its own title, with Try again and Back to the list", async () => {
    history.replaceState(null, '', '#');

    const fetch = vi.fn(async (url: string) => ({ status: url.endsWith('/select') ? 404 : 200, ok: !url.endsWith('/select'), json: async () => (url.endsWith('/select') ? { error: 'That work item is gone.' } : {}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });

    FakeSource.last!.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1), listRow(2)])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    expect(root.classList.contains('listing')).toBe(false);
    // At once: its title and a placeholder.
    expect(root.querySelector('#head .opening-title')?.textContent).toBe('Item 1');
    expect(root.querySelector('#panel .opening-note')?.textContent).toContain('Opening…');
    await flush();
    await flush();
    expect(root.classList.contains('listing')).toBe(false);
    expect(root.querySelector('#head .opening-title')?.textContent).toBe('Item 1');
    expect(root.querySelector('#panel .opening-failed h3')?.textContent).toBe("This work item did not open");
    expect(root.querySelector('#panel .opening-why')?.textContent).toBe('That work item is gone.');
    expect(location.hash).toBe('#w=1');

    const selects = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/select')).length;

    // Not asked again until Try again.
    expect(selects()).toBe(1);
    root.querySelector<HTMLElement>('[data-action="open-retry"]')!.click();
    expect(selects()).toBe(2);
    expect(root.querySelector('#panel .opening-note')).not.toBeNull();
    await flush();
    await flush();
    root.querySelector<HTMLElement>('[data-action="open-back"]')!.click();
    expect(root.classList.contains('listing')).toBe(true);
    expect(location.hash).toBe('');
    // The next select hides it.
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(root.querySelector('#head .opening-title')?.textContent).toBe('Item 2');
    page.close();
  });

  it('keeps every column in its place while another work item opens and after its open fails, with a placeholder strip and the composer kept hidden', async () => {
    history.replaceState(null, '', '#');
    window.innerWidth = 1440;

    let refuse = false;
    const fetch = vi.fn(async (url: string) => {
      const refused = refuse && url.endsWith('/select');

      return { status: refused ? 404 : 200, ok: !refused, json: async () => (refused ? { error: 'That work item is gone.' } : {}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;
    const groups = [listGroup('progress', [listRow(1), listRow(2)])];
    const composer = root.querySelector<HTMLElement>('#composer')!;
    const labels = (selector: string) => [...root.querySelectorAll(selector)].map((one) => one.textContent);
    const scope2 = { ...scope, workItemId: 2, scopeGen: 4, title: 'Item 2', conversations: [{ ...scope.conversations[0]!, workItemId: 2, title: 'Item 2' }] };

    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    expect(root.classList.contains('wide')).toBe(true);
    expect(composer.hidden).toBe(false);
    root.querySelector<HTMLElement>('#detail .panel-max')!.click();
    expect(root.classList.contains('maximized')).toBe(true);
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    // The maximized column restores, so the placeholder shows.
    expect(root.classList.contains('maximized')).toBe(false);
    // At once: the column stays, its strip History and Console dimmed over a loading note, and the composer keeps its place, hidden by page.css.
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.classList.contains('item-opening')).toBe(true);
    expect(labels('#detail .detail-head .opening-tabs .tab')).toEqual(['History', 'Console']);
    expect(root.querySelector('#detail .detail-head .opening-tabs')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('#detail .detail-body .opening-side')?.textContent).toContain('Loading…');
    expect(root.querySelector('#head .opening-tabs')).toBeNull();
    expect(root.querySelector('#panel .opening-note')).not.toBeNull();
    expect(composer.hidden).toBe(false);
    // Its hello: the work item's own strip and status in the same column.
    source.emit('hello', { key: 'pk', groups, scope: scope2, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.classList.contains('item-opening')).toBe(false);
    expect(root.querySelector('#detail .opening-tabs')).toBeNull();
    expect(root.querySelector('#detail .detail-head [data-side="history"]')).not.toBeNull();
    expect(root.querySelector('#detail .detail-body .opening-side')).toBeNull();

    // Where the tabs fold into the conversation's, the placeholder strip is under its head; a refused open keeps it, and the column comes back
    // with no loading note when the page widens.
    resizeTo(1000);
    refuse = true;
    root.querySelector<HTMLElement>('#head [data-tab="history"]')!.click();
    expect(root.classList.contains('off-conversation')).toBe(true);
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    // It opens on the Chat tab, so the composer keeps its place meanwhile.
    expect(root.classList.contains('off-conversation')).toBe(false);
    expect(labels('#head .opening-tabs .tab')).toEqual(['Chat', 'History', 'Console']);
    await flush();
    await flush();
    expect(root.querySelector('#panel .opening-failed')).not.toBeNull();
    expect(root.classList.contains('wide')).toBe(false);
    expect(labels('#head .opening-tabs .tab')).toEqual(['Chat', 'History', 'Console']);
    resizeTo(1440);
    expect(root.classList.contains('wide')).toBe(true);
    expect(labels('#detail .detail-head .opening-tabs .tab')).toEqual(['History', 'Console']);
    expect(root.querySelector('#detail .detail-body')?.textContent).toBe('');
    expect(root.querySelector('#head .opening-tabs')).toBeNull();
    page.close();
  });

  it('opens and collapses a group from its header, keeping the focus on the header', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)]), listGroup('done', [listRow(5)])], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });

    const done = root.querySelector<HTMLElement>('[data-group="done"] .group-head')!;

    expect(root.querySelector('[data-work-item="5"]')).toBeNull();
    done.focus();
    done.click();
    expect(root.querySelector('[data-work-item="5"]')).not.toBeNull();
    expect(done.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(done);
    root.querySelector<HTMLElement>('[data-group="progress"] .group-head')!.click();
    // The selected row stays in its collapsed group.
    expect([...root.querySelectorAll('[data-group="progress"] .row')].map((row) => row.getAttribute('data-work-item'))).toEqual(['1']);
    done.click();
    expect(root.querySelector('[data-work-item="5"]')).toBeNull();
    page.close();
  });

  it("keeps each group's open or closed choice across a reload, and a band's only until then", () => {
    const groups = [listGroup('progress', [listRow(1)]), listGroup('snoozed', [listRow(4)]), listGroup('done', [listRow(5, { band: 'Today' }), listRow(6, { band: 'Two weeks ago' })])];
    const first = start();

    first.source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-group="done"] .group-head')!.click();
    root.querySelector<HTMLElement>('[data-group="progress"] .group-head')!.click();
    root.querySelector<HTMLElement>('.band-head[data-band="done:Two weeks ago"]')!.click();
    expect(root.querySelector('[data-work-item="6"]')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('switchboard.groups')!)).toEqual({ done: true, progress: false });
    first.page.close();

    const second = start();

    second.source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    const open = () => [...root.querySelectorAll('.group-head')].map((head) => [head.getAttribute('data-group'), head.getAttribute('aria-expanded')]);

    expect(open()).toEqual([['progress', 'false'], ['snoozed', 'false'], ['done', 'true']]);
    // The band the operator opened starts closed again after the reload.
    expect(root.querySelector('[data-work-item="6"]')).toBeNull();
    expect(root.querySelector('[data-work-item="5"]')).not.toBeNull();
    second.page.close();
    // A kept value that does not read leaves the defaults.
    expect(collapsedGroups('not json')).toEqual(new Set(['done', 'snoozed']));
    expect(collapsedGroups('["done"]')).toEqual(new Set(['done', 'snoozed']));
    expect(collapsedGroups('{"snoozed":true,"review":false,"done":"yes"}')).toEqual(new Set(['done', 'review']));
  });

  it('sends the composer\'s text to the session it shows, with its scope generation and launch, and keeps a draft per work item', async () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

    expect(input.disabled).toBe(false);
    // The same short placeholder in every conversation, not its title.
    expect(input.placeholder).toBe('Message…');
    input.value = 'hello there';
    input.dispatchEvent(new Event('input'));
    expect(JSON.parse(localStorage.getItem('switchboard.drafts')!)).toEqual({ 1: 'hello there' });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();

    const sent = posts.find((post) => post.url.endsWith('/send'));

    expect(sent?.body).toMatchObject({ window: 'pk', scopeGen: 3, sessionId: 's', launch: 'L', text: 'hello there' });
    await flush();
    expect(input.value).toBe('');
    expect(localStorage.getItem('switchboard.drafts')).toBe('{}');
    page.close();
  });

  it("shows dictation's live words dimmed after the box's text and the hub's draft in it, never over text typed after it (architecture.md § Dictation)", () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    const live = root.querySelector<HTMLElement>('.live-words')!;

    expect(live.hidden).toBe(true);
    source.emit('words', { messageId: 'u1', text: 'fix the' });
    expect(live.hidden).toBe(false);
    expect(live.textContent).toBe('fix the');
    // With an empty box they start the line, with no space before them.
    expect(live.dataset['lead']).toBe('');
    source.emit('draft', { text: 'fix the', sessionId: 's' });
    source.emit('words', { messageId: 'u1', text: 'login' });
    // Then they continue the draft's line, after a space, in the layer under the box.
    expect(root.querySelector('.live-mirror')!.contains(live)).toBe(true);
    expect(root.querySelector('.mirror-text')!.textContent).toBe('fix the');
    expect(live.dataset['lead']).toBe(' ');
    source.emit('draft', { text: 'fix the login', sessionId: 's' });
    source.emit('words', { messageId: 'u1', text: '' });
    expect(live.hidden).toBe(true);
    expect(input.value).toBe('fix the login');
    source.emit('draft', { text: 'fix the login flow', sessionId: 's' });
    expect(input.value).toBe('fix the login flow');
    // Another session's draft, and one that would replace typed text, leave the box alone.
    source.emit('draft', { text: 'elsewhere', sessionId: 'other' });
    expect(input.value).toBe('fix the login flow');
    input.value = 'my own words';
    source.emit('draft', { text: 'fix the login flow now', sessionId: 's' });
    expect(input.value).toBe('my own words');
    page.close();
  });

  it('keeps dictation listening while the box has the focus: says so, joins each piece to the end of what was typed, keeps the caret, and tells the hub (architecture.md § Dictation)', async () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: true, error: null } });

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    const hint = root.querySelector<HTMLElement>('.composer-hint')!;
    const told = () => posts.filter((post) => post.url.endsWith('/composer')).map((post) => post.body);

    // Unfocused, spoken turns send on their own, so there is no hint.
    expect(hint.hidden).toBe(true);
    input.focus();
    await flush();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('press Send');
    expect(told().at(-1)).toMatchObject({ focused: true, draft: '', listen: true });

    // The first piece fills the empty box.
    source.emit('draft', { text: 'fix the', sessionId: 's', added: 'fix the' });
    expect(input.value).toBe('fix the');
    // Typed before the hub heard it, with the caret inside the text: the next piece joins the end, and the caret stays.
    input.value = 'fix the sign-in';
    input.setSelectionRange(3, 3);
    source.emit('draft', { text: 'fix the flow', sessionId: 's', added: 'flow' });
    expect(input.value).toBe('fix the sign-in flow');
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
    await flush();
    expect(told().at(-1)).toMatchObject({ focused: true, draft: 'fix the sign-in flow', listen: true });
    // Typed again, and two pieces the hub joined to drafts that crossed the page's: each joins once, and nothing typed is lost.
    input.value = 'fix the sign-in flow, please';
    input.setSelectionRange(input.value.length, input.value.length);
    source.emit('draft', { text: 'fix the sign-in flow now', sessionId: 's', added: 'now' });
    source.emit('draft', { text: 'fix the sign-in flow then', sessionId: 's', added: 'then' });
    expect(input.value).toBe('fix the sign-in flow, please now then');
    // A caret at the end stays where it was too, before the words dictated after it.
    expect([input.selectionStart, input.selectionEnd]).toEqual([28, 28]);
    // A draft the hub set otherwise replaces the box only while it holds nothing typed since, as the hub's emptied draft after a turn sent,
    // even once the page told the hub the typing, since the draft may predate it.
    input.value = 'my own words';
    source.emit('draft', { text: 'something else', sessionId: 's' });
    expect(input.value).toBe('my own words');
    input.dispatchEvent(new Event('input'));
    // The page tells the hub after a pause in the typing.
    await vi.waitFor(() => expect(told().at(-1)).toMatchObject({ draft: 'my own words' }));
    source.emit('draft', { text: '', sessionId: 's' });
    expect(input.value).toBe('my own words');
    input.value = '';
    source.emit('draft', { text: 'from the hub', sessionId: 's' });
    expect(input.value).toBe('from the hub');
    source.emit('draft', { text: '', sessionId: 's' });
    expect(input.value).toBe('');

    // Leaving the box hides the hint; with the mic off it shows on no focus.
    input.blur();
    await flush();
    expect(hint.hidden).toBe(true);
    expect(told().at(-1)).toMatchObject({ focused: false, listen: true });
    // Unfocused, a piece joins an edited box too, and the hub's emptied draft once the turn sent it clears it.
    input.value = 'one edited';
    source.emit('draft', { text: 'one edited two', sessionId: 's', added: 'two' });
    expect(input.value).toBe('one edited two');
    source.emit('draft', { text: '', sessionId: 's' });
    expect(input.value).toBe('');
    // A piece joined to a draft the hub had before the edit reached it: the box keeps the edit, and the hub is told the box.
    input.value = 'mine';
    source.emit('draft', { text: 'three', sessionId: 's', added: 'three' });
    expect(input.value).toBe('mine three');
    await flush();
    expect(told().at(-1)).toMatchObject({ focused: false, draft: 'mine three' });
    source.emit('draft', { text: '', sessionId: 's' });
    expect(input.value).toBe('');
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'off', speaking: null, speakReplies: true, error: null } });
    input.focus();
    expect(hint.hidden).toBe(true);
    page.close();
  });

  it("fills the box with a draft that came while a message was being sent once the send answered, keeps each conversation's draft baseline, and clears live words on a switch", async () => {
    const { page, source } = start();
    const helloOn = (workItemId: number, sessionId: string) =>
      source.emit('hello', { key: 'pk', groups: [], scope: { ...scope, workItemId, sessionId }, sessions: [session({ id: sessionId })], items: [], more: false, state: null, artifacts: [] });

    helloOn(1, 's');

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    const live = root.querySelector<HTMLElement>('.live-words')!;

    input.value = 'typed first';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    // Dictation goes on while the typed message is being sent.
    source.emit('draft', { text: 'spoken next', sessionId: 's' });
    expect(input.value).toBe('typed first');
    await flush();
    await flush();
    expect(input.value).toBe('spoken next');

    // A, then B, then A again: A's draft still follows the hub, since nothing was typed over it.
    source.emit('words', { messageId: 'u1', text: 'half heard' });
    helloOn(2, 's2');
    expect(live.hidden).toBe(true);
    source.emit('draft', { text: 'for two', sessionId: 's2' });
    expect(input.value).toBe('for two');
    helloOn(1, 's');
    expect(input.value).toBe('spoken next');
    source.emit('draft', { text: 'spoken next and more', sessionId: 's' });
    expect(input.value).toBe('spoken next and more');
    page.close();
  });

it('shows the context meter as one ring in the composer, its numbers in the tooltip, and sends /compact from its menu only after Compact is confirmed (architecture.md § Context meter)', async () => {
    const { page, source } = start();
    const context = { used: 150_000, window: 200_000, compactAt: 167_000, model: 'claude-sonnet-4-6' };

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ context })], items: [], more: false, state: null, artifacts: [] });

    const slot = root.querySelector<HTMLElement>('.composer-controls .context-meter')!;
    const ring = () => slot.querySelector<HTMLButtonElement>('button.context-ring')!;
    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

    expect(ring().textContent).toBe('');
    expect(ring().classList.contains('warn')).toBe(true);
    expect(ring().title).toContain('Context: 75% · 150k / 200k tokens');
    expect(slot.querySelector('.context-menu')).toBeNull();
    source.emit('session', { session: session({ context: { ...context, used: 20_000 } }) });
    expect(ring().classList.contains('ok')).toBe(true);

    input.value = 'my draft';
    ring().click();
    expect(ring().getAttribute('aria-expanded')).toBe('true');
    expect(slot.querySelector('.context-menu')!.textContent).toContain('Context: 10% · 20k / 200k tokens');
    slot.querySelector<HTMLButtonElement>('[data-context="compact"]')!.click();
    expect(posts.some((post) => post.url.endsWith('/send'))).toBe(false);
    expect(document.activeElement).toBe(slot.querySelector('[data-context="compact-confirm"]'));
    slot.querySelector<HTMLButtonElement>('[data-context="cancel"]')!.click();
    expect(slot.querySelector('[data-context="compact-confirm"]')).toBeNull();
    slot.querySelector<HTMLButtonElement>('[data-context="compact"]')!.click();
    slot.querySelector<HTMLButtonElement>('[data-context="compact-confirm"]')!.click();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/send')).map((post) => post.body)).toMatchObject([{ window: 'pk', scopeGen: 3, sessionId: 's', launch: 'L', text: '/compact', command: true }]);
    expect(slot.querySelector('.context-menu')).toBeNull();
    expect(input.value).toBe('my draft');

    // Escape and a click elsewhere close the menu.
    ring().click();
    slot.querySelector('.context-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(slot.querySelector('.context-menu')).toBeNull();
    ring().click();
    document.body.click();
    expect(slot.querySelector('.context-menu')).toBeNull();
    page.close();
  });

  it('reads the context details once on Show details, shows them while loading, a refusal with Try again, and drops them when the menu closes (architecture.md § Context meter)', async () => {
    let answer: { status: number; body: unknown } = { status: 409, body: { error: 'Claude Code did not answer the usage request; this version may not offer it.' } };
    let release: () => void = () => {};
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      if (url.endsWith('/context-details')) {
        await new Promise<void>((done) => (release = done));
      }

      const reply = url.endsWith('/context-details') ? answer : { status: 200, body: {} };

      return { status: reply.status, ok: reply.status === 200, json: async () => reply.body, text: async () => JSON.stringify(reply.body) } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ context: { used: 20_000, window: 200_000, compactAt: 167_000, model: 'claude-sonnet-4-6' } })], items: [], more: false, state: null, artifacts: [] });

    const slot = root.querySelector<HTMLElement>('.context-meter')!;
    const menu = () => slot.querySelector<HTMLElement>('.context-menu');

    slot.querySelector<HTMLButtonElement>('button.context-ring')!.click();
    // Opening the menu reads nothing.
    expect(posts.some((post) => post.url.endsWith('/context-details'))).toBe(false);
    expect(menu()!.querySelector('.context-details')).toBeNull();
    slot.querySelector<HTMLButtonElement>('[data-context="details"]')!.click();
    await flush();
    expect(menu()!.querySelector('[role="status"]')!.textContent).toBe('Loading details…');
    expect(slot.querySelector('[data-context="details"]')).toBeNull();
    release();
    await vi.waitFor(() => expect(menu()!.querySelector('.context-error')?.textContent).toBe('Claude Code did not answer the usage request; this version may not offer it.'));
    expect(posts.filter((post) => post.url.endsWith('/context-details')).map((post) => post.body)).toMatchObject([{ window: 'pk', scopeGen: 3, sessionId: 's' }]);

    answer = { status: 200, body: { details: { provider: 'claude', model: 'claude-sonnet-4-6', effort: null, parts: { cacheRead: 15_000, cacheWrite: 4_000, input: 600, output: 400, reasoning: null }, compacted: null, windows: [{ minutes: 300, limit: null, usedPercent: 12, resetsAt: null }], limit: null } } };
    slot.querySelector<HTMLButtonElement>('[data-context="details"]')!.click();
    await flush();
    release();
    await vi.waitFor(() => expect(menu()!.querySelector('.context-details')).not.toBeNull());
    expect(menu()!.querySelector('.context-details')!.textContent).toContain('Cache read15k');
    expect(menu()!.querySelector('.context-details')!.textContent).toContain('5-hour12%');
    expect(slot.querySelector('[data-context="compact"]')).not.toBeNull();

    // An answer that comes after the page moved to another conversation is dropped, also once the page comes back.
    slot.querySelector<HTMLButtonElement>('button.context-ring')!.click();
    slot.querySelector<HTMLButtonElement>('button.context-ring')!.click();
    slot.querySelector<HTMLButtonElement>('[data-context="details"]')!.click();
    await flush();
    source.emit('hello', { key: 'pk', groups: [], scope: { ...scope, workItemId: 2, sessionId: 's2', scopeGen: 4 }, sessions: [session({ id: 's2' })], items: [], more: false, state: null, artifacts: [] });
    release();
    await flush();
    await flush();
    source.emit('hello', { key: 'pk', groups: [], scope: { ...scope, scopeGen: 5 }, sessions: [session({ context: { used: 20_000, window: 200_000, compactAt: 167_000, model: 'claude-sonnet-4-6' } })], items: [], more: false, state: null, artifacts: [] });
    if (menu() === null) slot.querySelector<HTMLButtonElement>('button.context-ring')!.click();
    expect(menu()!.querySelector('.context-details')).toBeNull();
    expect(slot.querySelector('[data-context="details"]')).not.toBeNull();
    slot.querySelector<HTMLButtonElement>('[data-context="details"]')!.click();
    await flush();
    release();
    await vi.waitFor(() => expect(menu()!.querySelector('.context-details')).not.toBeNull());

    // Closed and opened again, the menu asks anew.
    slot.querySelector<HTMLButtonElement>('button.context-ring')!.click();
    slot.querySelector<HTMLButtonElement>('button.context-ring')!.click();
    expect(menu()!.querySelector('.context-details')).toBeNull();
    expect(slot.querySelector('[data-context="details"]')).not.toBeNull();
    page.close();
  });

  it('shows an unknown context as the empty ring, and offers no Compact for a session the composer cannot talk to', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ conversation: 'read-only', reason: 'Ended.' })], items: [], more: false, state: null, artifacts: [] });

    const slot = root.querySelector<HTMLElement>('.context-meter')!;

    expect(slot.querySelector('button')!.classList.contains('unknown')).toBe(true);
    slot.querySelector('button')!.click();
    expect(slot.querySelector('.context-menu')!.textContent).toContain('Context size unknown');
    expect(slot.querySelector('[data-context="compact"]')).toBeNull();
    page.close();
  });

  it('disables the composer with the reason for a session it cannot talk to', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ conversation: 'read-only', state: 'idle', reason: 'The session is unobserved: sessions.installHooks is off.' })], items: [], more: false, state: null, artifacts: [] });

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('The session is unobserved: sessions.installHooks is off.');
    page.close();
  });
});
