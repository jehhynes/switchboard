import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeline } from '../src/model.js';
import { html } from './html.js';
import { loadMermaid, startPage, SEND_RETRY_MS } from '../src/main.js';
import { BACKOFF_MS, GRACE_MS, JITTER } from '../src/connection.js';
import { NAVIGATION_MS } from '../src/request.js';
import { drawAtOnce } from './frame.js';
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

  it("opens another work item under its own head with a placeholder at once, never the one shown before, until its hello", async () => {
    const { page, source } = start();

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(3, { title: 'Other work' })])] });
    expect(root.querySelector('#panel .timeline')).not.toBeNull();
    answers['/select'] = { status: 200, body: {}, wait: new Promise(() => {}) };
    root.querySelector<HTMLElement>('[data-work-item="3"]')!.click();
    expect(root.querySelector('#head .opening-title')?.textContent).toBe('Other work');
    expect(root.querySelector('#panel .timeline')).toBeNull();
    expect(root.querySelector('#panel .opening-note')?.textContent).toContain('Opening…');
    // The composer keeps its place, hidden by page.css, so nothing moves when the work item comes.
    expect(root.querySelector<HTMLElement>('#composer')!.hidden).toBe(false);
    expect(root.classList.contains('item-opening')).toBe(true);
    // The row it opens is the one marked.
    expect(root.querySelector('[data-work-item="3"]')!.classList.contains('selected')).toBe(true);
    // An event for the work item shown before changes nothing.
    source.emit('reply', { reply: reply('r9', 9) });
    expect(root.querySelector('#panel .timeline')).toBeNull();
    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(3, { title: 'Other work' })])], scope: { ...scope, workItemId: 3, title: 'Other work', conversations: [{ ...scope.conversations[0]!, workItemId: 3, title: 'Other work' }] } });
    expect(root.querySelector('#head .opening-title')).toBeNull();
    expect(root.querySelector('#panel .timeline')).not.toBeNull();
    page.close();
  });

  it("keeps the placeholder through the opened work item's scope event until its own hello, so the previous conversation never shows under it", async () => {
    const { page, source } = start();

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(3, { title: 'Other work' })])] });
    answers['/select'] = { status: 200, body: {}, wait: new Promise(() => {}) };
    root.querySelector<HTMLElement>('[data-work-item="3"]')!.click();
    source.emit('scope', { scope: { ...scope, workItemId: 3, title: 'Other work', scopeGen: 4, conversations: [{ ...scope.conversations[0]!, workItemId: 3, title: 'Other work' }] } });
    expect(root.querySelector('#panel .opening-note')).not.toBeNull();
    expect(root.querySelector('#panel .timeline')).toBeNull();
    page.close();
  });

  it('opens the work item the route asked for at the start as a row click does, its refusal in its place', async () => {
    history.replaceState(null, '', '#w=3');
    answers['/select'] = { status: 409, body: { error: 'Its worktree is missing.' } };

    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(3, { title: 'Other work' })])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    await vi.waitFor(() => expect(root.querySelector('#panel .opening-why')?.textContent).toBe('Its worktree is missing.'));
    expect(root.querySelector('#head .opening-title')?.textContent).toBe('Other work');
    // The phone's start puts the list's entry under the route's, and the address lands back on the route once the history settles.
    await vi.waitFor(() => expect(location.hash).toBe('#w=3'));
    page.close();
  });

  it("keeps a send's opId over a refusal for an unbound key and a reload, and drops it once the hub took the message", async () => {
    const { page, source } = start();

    hello(source);

    const box = () => root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    const sends = () => posts.filter((post) => post.url.endsWith('/send'));
    const type = (text: string) => {
      box().value = text;
      box().dispatchEvent(new Event('input'));
    };

    type('Ship it');
    answers['/send'] = { status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } };
    click('button.send');
    await flush();
    await flush();
    page.close();

    // The reload: the same message sent again is the same operation.
    const again = start();

    hello(again.source);
    type('Ship it');
    answers['/send'] = { status: 200, body: { message: { id: 'm9' } } };
    click('button.send');
    await flush();
    await flush();
    expect(sends().map((post) => post.body['opId'])).toEqual([sends()[0]!.body['opId'], sends()[0]!.body['opId']]);
    expect(localStorage.getItem('switchboard.sendOps')).toBe('{}');

    // A refusal for a scope generation the page had not caught up with leaves it unsettled; another message replaces it.
    await vi.waitFor(() => expect(box().value).toBe(''));
    type('Next');
    answers['/send'] = { status: 409, body: { error: "The window's conversation changed." } };
    click('button.send');
    await vi.waitFor(() => expect(sends().at(-1)!.body['text']).toBe('Next'));
    // The hub keeps its old text for this refusal, which the page says in its own words.
    await vi.waitFor(() => expect(root.querySelector('#toast .toast-text')?.textContent).toBe('You switched to another session, so that was not done. Try again.'));
    const stale = sends().at(-1)!.body['opId'];

    expect(JSON.parse(localStorage.getItem('switchboard.sendOps')!)).toEqual({ '1': { key: expect.stringContaining('Next'), opId: stale } });
    type('Something else');
    answers['/send'] = { status: 200, body: { message: { id: 'm10' } } };
    click('button.send');
    await vi.waitFor(() => expect(sends().at(-1)!.body['text']).toBe('Something else'));
    expect(sends().at(-1)!.body['opId']).not.toBe(stale);

    // Another page of this device kept a newer unsettled send meanwhile: this page's answer leaves it.
    let release: () => void = () => {};

    await vi.waitFor(() => expect(box().value).toBe(''));
    type('Third');
    answers['/send'] = { status: 200, body: { message: { id: 'm11' } }, wait: new Promise<void>((resolve) => void (release = resolve)) };
    click('button.send');
    await vi.waitFor(() => expect(sends().at(-1)!.body['text']).toBe('Third'));
    localStorage.setItem('switchboard.sendOps', JSON.stringify({ '1': { key: 'other', opId: 'newer' } }));
    release();
    await vi.waitFor(() => expect(box().value).toBe(''));
    expect(JSON.parse(localStorage.getItem('switchboard.sendOps')!)).toEqual({ '1': { key: 'other', opId: 'newer' } });
    again.page.close();
  });

  it('lets a later tap open a work item after an open that hung, once the open times out', async () => {
    vi.useFakeTimers();

    const { page, source } = start();

    hello(source);
    answers['/select'] = { status: 200, body: {}, wait: new Promise(() => {}) };
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.filter((post) => post.url.endsWith('/select'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(NAVIGATION_MS);
    delete answers['/select'];
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).toEqual([2, 2]);
    page.close();
  });

  it('changes nothing for a drop shorter than the grace period, then shows the offline banner, dims the page and turns off the composer until a hello', async () => {
    vi.useFakeTimers();

    const { page, source } = start();

    hello(source);

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

    expect(root.querySelector('.header .conn-dot')?.getAttribute('aria-label')).toBe('Connected');
    source.emit('error', {});
    await vi.advanceTimersByTimeAsync(GRACE_MS - 100);
    expect(root.querySelector('.conn-banner')).toBeNull();
    expect(root.classList.contains('stale')).toBe(false);
    expect(input.disabled).toBe(false);
    expect(root.querySelector('.header .conn-dot')?.className).toBe('conn-dot live');
    // The page asked the hub and opened a new stream, which brings no hello.
    expect(FakeSource.last).not.toBe(source);
    expect(posts.some((post) => post.url === '/page/ping')).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect([...root.querySelectorAll('.conn-banner')].map((one) => one.textContent)).toEqual(Array(2).fill('Offline. Showing what was here at ' + new Date(10_000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '.Retry'));
    expect(root.classList.contains('stale')).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('Messages cannot be sent while offline.');
    expect(root.querySelector('.header .conn-dot')?.className).toBe('conn-dot waiting');
    hello(FakeSource.last!);
    expect(root.querySelector('.conn-banner')).toBeNull();
    expect(root.classList.contains('stale')).toBe(false);
    expect(input.disabled).toBe(false);
    page.close();
  });

  it("keeps the conversation shown through a reconnect, until the new stream's hello for the work item replaces it", async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();

    hello(source);
    source.emit('error', {});
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]! * (1 + JITTER));

    const next = FakeSource.last!;

    // The new stream's key is not bound yet: its hello has no work item, and the page selects it again.
    next.emit('hello', { key: 'pk2', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    expect(root.querySelectorAll('#panel .timeline > li').length).toBeGreaterThan(0);
    expect(root.querySelector<HTMLElement>('#composer')!.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.filter((post) => post.url.endsWith('/select')).at(-1)?.body).toMatchObject({ window: 'pk2', workItemId: 1 });
    hello(next, { key: 'pk2', items: [message('m7', 7)] });
    expect([...root.querySelectorAll('#panel .timeline > li[data-id]')].map((item) => item.getAttribute('data-id'))).toEqual(['m7']);
    page.close();
  });

  it("shows Can't reach Switchboard in the page's place when it never connected, tries at once on Try now, and goes once a hello comes", async () => {
    vi.useFakeTimers();
    answers['/page/ping'] = { status: 503, body: {} };

    const { page, source } = start();

    source.emit('error', {});
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    const screen = root.querySelector('.conn-screen')!;

    expect(screen.querySelector('h2')?.textContent).toBe("Switchboard is not reachable");
    expect(screen.querySelector('.conn-screen-status')?.textContent).toMatch(/^Trying again in \d+ s\.$/);
    // Only this computer can start the hub.
    expect(screen.querySelector('a[href="switchboard:start"]')?.textContent).toBe('Start Switchboard');
    expect(root.classList.contains('unreachable')).toBe(true);

    const pings = posts.filter((post) => post.url === '/page/ping').length;

    root.querySelector<HTMLElement>('.conn-screen [data-action="conn-retry"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.filter((post) => post.url === '/page/ping')).toHaveLength(pings + 1);
    delete answers['/page/ping'];
    await vi.advanceTimersByTimeAsync(5_000);
    hello(FakeSource.last!);
    expect(root.querySelector('.conn-screen')).toBeNull();
    expect(root.classList.contains('unreachable')).toBe(false);
    page.close();
  });

  it('shows the Signed out screen in place of the page once the hub says the sign-in is gone, and stops trying', async () => {
    vi.useFakeTimers();

    const { page, source } = start();

    hello(source);
    answers['/page/ping'] = { status: 200, body: { build: '', signedIn: false } };
    source.emit('error', {});
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]! * (1 + JITTER));
    expect(root.querySelector('.conn-screen h2')?.textContent).toBe('Signed out');
    expect(root.querySelector('.conn-screen')?.textContent).toContain('This browser is signed out. Run node ~/.switchboard/hub.js web on this computer and open the link it prints.');
    expect(root.querySelector('.header .conn-dot')?.getAttribute('aria-label')).toBe('Signed out');

    const pings = posts.filter((post) => post.url === '/page/ping').length;

    await vi.advanceTimersByTimeAsync(120_000);
    expect(posts.filter((post) => post.url === '/page/ping')).toHaveLength(pings);
    page.close();
  });

  it('tries a send whose answer was lost again with the same opId, and the same text sent again after it failed reuses it', async () => {
    vi.useFakeTimers();

    const { page, source } = start();

    hello(source);

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    const sends = () => posts.filter((post) => post.url.endsWith('/send'));

    input.value = 'Ship it';
    input.dispatchEvent(new Event('input'));
    answers['/send'] = { status: 503, body: { error: 'The hub is restarting onto a new build; try again in a few seconds.' } };
    click('button.send');
    await vi.advanceTimersByTimeAsync(SEND_RETRY_MS);
    expect(sends().length).toBeGreaterThan(2);
    expect(new Set(sends().map((post) => post.body['opId'])).size).toBe(1);
    expect(root.querySelector('#toast .toast-text')?.textContent).toBe('Your message was not sent. Switchboard is restarting. Try again in a moment.');
    expect(input.value).toBe('Ship it');

    const first = sends()[0]!.body['opId'];

    answers['/send'] = { status: 200, body: { message: { id: 'm9' } } };
    click('button.send');
    await vi.advanceTimersByTimeAsync(0);
    expect(sends().at(-1)!.body['opId']).toBe(first);
    expect(input.value).toBe('');

    // Another message is another operation.
    input.value = 'And the docs';
    input.dispatchEvent(new Event('input'));
    click('button.send');
    await vi.advanceTimersByTimeAsync(0);
    expect(sends().at(-1)!.body['opId']).not.toBe(first);
    page.close();
  });

});
