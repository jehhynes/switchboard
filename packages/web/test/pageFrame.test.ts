import { afterEach, onTestFinished, beforeEach, describe, expect, it, vi } from 'vitest';
import { html } from './html.js';
import { loadMermaid, startPage } from '../src/main.js';
import { drawAtOnce } from './frame.js';
import { showToast } from '../src/toast.js';
import { message, reply, session, scope, listRow, listGroup, artifact, FakeSource } from './pageFixtures.js';

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

  it('hides the embedded browser under a menu only where the menu overlaps it, as the More menu does, and under a modal dialog always', async () => {
    const postMessage = vi.fn();
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    onTestFinished(() => { vi.restoreAllMocks(); });
    window.innerWidth = 1920;
    // The column's Browser tab at the right; the session dropdown drops over the conversation, the More menu over the Browser tab.
    const boxes: Record<string, { left: number; top: number; right: number; bottom: number }> = {
      'iframe-slot': { left: 1000, top: 120, right: 1900, bottom: 1000 },
      'conversation-menu': { left: 300, top: 60, right: 700, bottom: 600 },
      'tab-menu': { left: 1400, top: 100, right: 1880, bottom: 500 },
    };
    // Size observers that report only when the test says so, so the toast's host can say its toast grew.
    const sized: Array<{ report: () => void; watched: Element[] }> = [];
    vi.stubGlobal('ResizeObserver', class {
      readonly watched: Element[] = [];
      constructor(report: () => void) { sized.push({ report, watched: this.watched }); }
      observe(element: Element): void { this.watched.push(element); }
      unobserve(): void {}
      disconnect(): void {}
    });
    onTestFinished(() => { vi.unstubAllGlobals(); });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const box = Object.entries(boxes).find(([name]) => this.classList.contains(name))?.[1] ?? { left: 0, top: 0, right: 0, bottom: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
    });
    const page = startPage(root, {
      fetch: (async () => ({ status: 200, ok: true, json: async () => ({}) })) as unknown as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000,
      toExtension: async () => ({ ok: true }),
    });
    const source = FakeSource.last!;
    hello(source, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' })])] });
    for (let index = 0; index < 8; index++) {
      source.emit('artifact', { artifact: { path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 10_000 + index } });
    }
    await flush();
    click('#detail [data-action="iframe-open"]');
    await flush();
    // The column's strip narrowed to room for the chosen tab alone, so the rest go into More.
    boxes['side-switch'] = { left: 1000, top: 85, right: 1001, bottom: 120 };
    const shown = (): boolean => {
      const last = postMessage.mock.calls.map(([message]) => message as Record<string, unknown>).filter((message) => message['type'] === 'switchboard-iframe').at(-1);
      return last !== undefined && 'left' in last;
    };
    expect(shown()).toBe(true);

    // The session dropdown lies over the conversation, beside the frame, so the frame stays.
    click('[data-action="picker"]');
    await flush();
    expect(root.querySelector('.conversation-menu')).not.toBeNull();
    expect(shown()).toBe(true);
    click('[data-action="picker"]');
    await flush();

    // The More menu drops over the Browser tab, so the frame hides while it is open and comes back once it closes.
    click('#detail [data-action="tab-menu"]');
    await flush();
    expect(root.querySelector('#detail .tab-menu')).not.toBeNull();
    expect(shown()).toBe(false);
    click('#detail [data-action="tab-menu"]');
    await vi.waitFor(() => expect(shown()).toBe(true), { timeout: 4_000 });

    // A modal dialog hides it wherever its box lies.
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    root.append(modal);
    await flush();
    expect(shown()).toBe(false);
    modal.remove();
    await vi.waitFor(() => expect(shown()).toBe(true), { timeout: 4_000 });

    // A toast clear of the frame leaves it; one replaced in place by a longer text that reaches over it hides it, which only its size says.
    showToast('Short.', 'info');
    await flush();
    expect(shown()).toBe(true);
    boxes['toast'] = { left: 900, top: 100, right: 1500, bottom: 200 };
    for (const observer of sized.filter((one) => one.watched.some((element) => element.id === 'toast'))) observer.report();
    await flush();
    expect(shown()).toBe(false);
    root.querySelector('#toast [data-action="toast-dismiss"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(shown()).toBe(true), { timeout: 4_000 });

    // Update ready over the frame hides it too, and the frame comes back once the card goes.
    const update = document.createElement('div');
    update.className = 'conn-update';
    boxes['conn-update'] = { left: 1200, top: 800, right: 1600, bottom: 860 };
    root.querySelector('#connection')!.append(update);
    await flush();
    expect(shown()).toBe(false);
    update.remove();
    await vi.waitFor(() => expect(shown()).toBe(true), { timeout: 4_000 });
    page.close();
  });

  it('keeps the embedded browser showing under a menu or modal once its host cuts holes, sending the layers over it and the backdrop darkening', async () => {
    const postMessage = vi.fn();
    const parentWindow = { postMessage } as unknown as Window;
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parentWindow);
    onTestFinished(() => { vi.restoreAllMocks(); });
    window.innerWidth = 1920;
    const boxes: Record<string, { left: number; top: number; right: number; bottom: number }> = {
      'iframe-slot': { left: 1000, top: 120, right: 1900, bottom: 1000 },
      'tab-menu': { left: 1400, top: 100, right: 1880, bottom: 500 },
      'test-backdrop': { left: 0, top: 0, right: 1920, bottom: 1080 },
      'test-dialog': { left: 700, top: 300, right: 1300, bottom: 700 },
    };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const box = Object.entries(boxes).find(([name]) => this.classList.contains(name))?.[1] ?? { left: 0, top: 0, right: 0, bottom: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
    });
    const page = startPage(root, {
      fetch: (async () => ({ status: 200, ok: true, json: async () => ({}) })) as unknown as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000,
      toExtension: async () => ({ ok: true }),
    });
    const source = FakeSource.last!;
    hello(source, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' })])] });
    for (let index = 0; index < 8; index++) {
      source.emit('artifact', { artifact: { path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 10_000 + index } });
    }
    await flush();
    click('#detail [data-action="iframe-open"]');
    await flush();
    // The column's strip narrowed to room for the chosen tab alone, so the rest go into More.
    boxes['side-switch'] = { left: 1000, top: 85, right: 1001, bottom: 120 };
    click('#detail .link-tab.selected [data-action="iframe-open"]');
    await flush();
    const last = (): Record<string, unknown> | undefined => postMessage.mock.calls.map(([message]) => message as Record<string, unknown>).filter((message) => message['type'] === 'switchboard-iframe').at(-1);
    const answer = (origin: string): void => { window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin, data: { type: 'switchboard-iframe-holes' } })); };
    // Only the extension host's answer counts; another origin's leaves the page hiding the frame under the menu.
    answer('https://github.com');
    click('#detail [data-action="tab-menu"]');
    await flush();
    expect(last()).not.toHaveProperty('left');
    click('#detail [data-action="tab-menu"]');
    await vi.waitFor(() => expect(last()).toHaveProperty('left'), { timeout: 4_000 });
    answer('chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije');
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [], dim: 0, modal: false });

    // The More menu over the Browser tab is cut out of the frame, which stays.
    click('#detail [data-action="tab-menu"]');
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [{ left: 1400, top: 100, width: 480, height: 400 }], modal: false });
    click('#detail [data-action="tab-menu"]');
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [] });

    // A modal dialog over its backdrop: the frame darkens by the backdrop's alpha and the dialog is cut out.
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop test-backdrop';
    backdrop.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
    const dialog = document.createElement('div');
    dialog.className = 'test-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    backdrop.append(dialog);
    root.append(backdrop);
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [{ left: 700, top: 300, width: 600, height: 400 }], dim: 0.4, modal: true });
    // An opaque backdrop, as the phone's full-screen dialogs have, hides it.
    backdrop.style.backgroundColor = 'rgb(30, 30, 30)';
    dialog.classList.add('opaque');
    await flush();
    expect(last()).not.toHaveProperty('left');
    backdrop.remove();
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [], dim: 0, modal: false });

    // Update ready over the frame is cut out of it, so an embedded site never hides it.
    const update = document.createElement('div');
    update.className = 'conn-update';
    boxes['conn-update'] = { left: 1200, top: 800, right: 1600, bottom: 860 };
    root.querySelector('#connection')!.append(update);
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [{ left: 1200, top: 800, width: 400, height: 60 }], modal: false });
    update.remove();
    await flush();
    expect(last()).toMatchObject({ left: 1000, holes: [] });

    // A layer sliding over the frame is followed each frame while its transition runs, not only when it ends.
    const sliding = document.createElement('div');
    sliding.className = 'glass sliding';
    root.append(sliding);
    await flush();
    sliding.dispatchEvent(new Event('transitionrun', { bubbles: true }));
    boxes['sliding'] = { left: 950, top: 200, right: 1200, bottom: 400 };
    await vi.waitFor(() => expect(last()).toMatchObject({ holes: [{ left: 950, top: 200, width: 250, height: 200 }] }), { timeout: 4_000 });
    boxes['sliding'] = { left: 1000, top: 200, right: 1300, bottom: 400 };
    await vi.waitFor(() => expect(last()).toMatchObject({ holes: [{ left: 1000, width: 300 }] }), { timeout: 4_000 });
    sliding.dispatchEvent(new Event('transitionend', { bubbles: true }));
    const sent = postMessage.mock.calls.length;
    await new Promise((done) => setTimeout(done, 60));
    // Stopped, it is no longer followed.
    expect(postMessage.mock.calls.length).toBe(sent);
    page.close();
  });

});
