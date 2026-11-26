import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeline } from '../src/model.js';
import { renderMicButton } from '../src/render.js';
import { html } from './html.js';
import { REPLAY_TIP, SPEAKING_TIP } from '@switchboard/conversation/voiceControls';
import { SEND_RETRY_MS } from '../src/main.js';
import { loadMermaid, startPage } from '../src/main.js';
import { BACKOFF_MS, GRACE_MS, JITTER } from '../src/connection.js';
import { NAVIGATION_MS } from '../src/request.js';
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

  it('puts back a message a stopped hub left unsent, only that, with why, and drives the voice from its buttons', async () => {
    const { page, source } = start();

    hello(source);
    // A message a stopped hub left, which every page showing the session takes back.
    source.emit('message', { message: message('m9', 9, { delivery: 'not-sent', error: 'The holder did not answer.', text: 'lost words' }), giveBack: true });
    // One this page did not send stays out of its composer.
    source.emit('message', { message: message('m8', 8, { delivery: 'not-sent', error: 'x', text: 'not mine' }) });
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('lost words');
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The holder did not answer.');
    // While the voice is elsewhere, one Talk here takes the cluster's place; here, Speak replies, with no Stop beside it while a reply plays.
    expect(root.querySelector('[data-voice="speak-replies"]')).toBeNull();
    click('[data-voice="talk-here"]');
    source.emit('voice', { voice: { enabled: true, here: true, speaking: 'r1', speakReplies: true, error: null } });
    // The cluster sits with the mic and Send, never among the message tools beside the context meter.
    expect(root.querySelector('.composer-footer > .composer-end > .voice-controls ~ .send')).not.toBeNull();
    expect(root.querySelector('.composer-controls .voice-controls')).toBeNull();
    expect(root.querySelectorAll('.voice-controls button')).toHaveLength(1);
    expect(root.querySelector('.voice-controls .codicon-debug-stop')).toBeNull();
    expect(root.querySelector('[data-voice="speak-replies"]')!.getAttribute('title')).toBe(SPEAKING_TIP);
    // The speaker turns Speak replies off, which stops the reply playing.
    click('[data-voice="speak-replies"]');
    await flush();
    expect(posts.filter((post) => /talk-here|speak-replies/.test(post.url)).map((post) => post.body['on'] ?? 'talk')).toEqual(['talk', false]);
    expect(posts.some((post) => post.url.endsWith('/stop-speaking'))).toBe(false);
    // Off, a reply plays only as a Replay, which the speaker stops.
    source.emit('voice', { voice: { enabled: true, here: true, speaking: 'r1', speakReplies: false, error: null } });
    expect(root.querySelector('[data-voice="stop"]')!.getAttribute('title')).toBe(REPLAY_TIP);
    click('[data-voice="stop"]');
    await flush();
    expect(posts.some((post) => post.url.endsWith('/stop-speaking'))).toBe(true);
    source.emit('voice', { voice: { enabled: true, here: true, speaking: 'r1', speakReplies: true, error: null } });

    // The mic is packages/conversation's button, and drives the computer's voice process.
    expect(root.querySelector('.composer-mic')!.innerHTML).toBe(renderMicButton({ enabled: true, here: true, speaking: 'r1', speakReplies: true, error: null }));
    click('.composer-mic [data-voice="mic"]');
    // Starting from the click, before the hub answers.
    expect(root.querySelector('.composer-mic .mic.starting')).not.toBeNull();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/mic'))?.body).toMatchObject({ on: true, scopeGen: 3 });
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'paused-other-app', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic .mic')!.getAttribute('title')).toContain('another app is using the microphone');
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic .mic.listening')).not.toBeNull();
    await flush();
    // The tap's start, timed from the click, goes to the hub log once the voice confirmed it.
    expect(posts.filter((post) => post.url.endsWith('/mic-timing')).map((post) => [post.body['outcome'], (post.body['steps'] as Array<{ step: string }>).map((one) => one.step)])).toEqual([['paused-other-app', ['hub answered', 'voice confirmed']]]);

    // Focusing the box and leaving it tell the hub, for the focus rule of dictation.
    const box = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    // A report the page sent before, such as at a redraw, is not this focus's.
    const earlier = posts.length;

    box.focus();
    box.blur();
    await vi.waitFor(() => expect(posts.slice(earlier).filter((post) => post.url.endsWith('/composer')).map((post) => post.body['focused'])).toEqual([true, false]));
    page.close();
  });

  it('offers Send again on an unconfirmed message, which puts its text in the composer and sends nothing', async () => {
    const { page, source } = start();

    hello(source);
    source.emit('message', { message: message('m7', 7, { delivery: 'unconfirmed', error: 'The transcript does not show this message.', text: 'lost words' }) });
    await flush();
    expect(root.querySelector('li[data-id="m7"] .delivery')!.textContent).toBe('not confirmed');
    expect(root.querySelector('li[data-id="m7"] .delivery')!.getAttribute('title')).toBe('The transcript does not show this message.');
    click('li[data-id="m7"] [data-action="resend-message"]');
    await flush();
    expect(root.querySelector('textarea')!.value).toBe('lost words');
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('Check the terminal first: Claude may have this message already.');
    expect(posts.some((post) => post.url.endsWith('/send'))).toBe(false);
    page.close();
  });

  it('shows a paired device\'s mic off while the voice is elsewhere, so its tap can take the voice to the phone, and fetches its audio worklet ahead (PRD R119)', () => {
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false });
    const source = FakeSource.last!;

    hello(source);
    const worklets = () => fetch.mock.calls.filter((call) => String((call as unknown[])[0]).endsWith('/page/voice-worklet.js')).length;

    // The audio worklet is fetched once voice is on, ahead of the tap, and once only.
    source.emit('voice', { voice: { enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic [data-voice="mic"]')?.getAttribute('data-on')).toBe('true');
    source.emit('voice', { voice: { enabled: true, here: false, mic: 'off', speaking: null, speakReplies: false, error: null } });
    expect(worklets()).toBe(1);
    page.close();

    // This computer's page shows Talk here instead.
    const local = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: true });

    hello(FakeSource.last!);
    FakeSource.last!.emit('voice', { voice: { enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null } });
    expect(root.querySelector('.composer-mic [data-voice="mic"]')).toBeNull();
    expect(worklets()).toBe(1);
    local.close();
  });

  it('marks an unread reply seen once it has shown for a second on a focused page', async () => {
    vi.useFakeTimers();

    let now = 10_000;
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });
      return { status: 200, ok: true, json: async () => ({}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => now });

    hello(FakeSource.last!);
    // The unread reply's dot is its plain bullet: unread replies are marked only on conversations not selected (PRD R100).
    expect(root.querySelector('.reply[data-unread="r1"] .dot')!.getAttribute('title')).toBeNull();
    now += 1_100;
    await vi.advanceTimersByTimeAsync(300);
    expect(posts.find((post) => post.url.endsWith('/seen'))?.body).toMatchObject({ sessionId: 's', ids: ['r1'], scopeGen: 3 });
    page.close();
  });

  it('marks a state seen on History, and again when its body changes under the same ID', async () => {
    vi.useFakeTimers();

    let now = 10_000;
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });
      return { status: 200, ok: true, json: async () => ({}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => now });
    const seenState = () => posts.filter((post) => post.url.endsWith('/seen') && (post.body['ids'] as string[]).includes('st-r1')).length;

    hello(FakeSource.last!);
    root.querySelector<HTMLElement>('[data-tab="history"]')!.click();
    now += 1_100;
    await vi.advanceTimersByTimeAsync(300);
    expect(seenState()).toBe(1);
    // Seen, it is not reported again while it stays as it was.
    FakeSource.last!.emit('state', { state: { id: 'st-r1', sessionId: 's', at: 5_000, headline: 'Working on it', body: 'Same.', stale: null, unread: false } });
    now += 1_100;
    await vi.advanceTimersByTimeAsync(300);
    expect(seenState()).toBe(1);
    // A changed body marks it unread again, and it is reported once more.
    FakeSource.last!.emit('state', { state: { id: 'st-r1', sessionId: 's', at: 5_000, headline: 'Working on it', body: 'More.', stale: null, unread: true } });
    await vi.advanceTimersByTimeAsync(300);
    now += 1_100;
    await vi.advanceTimersByTimeAsync(300);
    expect(seenState()).toBe(2);
    page.close();
  });

  it('starts on the work item and tab this device kept when the address has none, as an installed app started again, and keeps each tab change', async () => {
    window.innerWidth = 375;
    localStorage.setItem('switchboard.route', '#w=1&t=status');

    const { page, source } = start();

    // At once: the work item, before its hello.
    expect(location.hash).toBe('#w=1&t=history');
    // The stream's first hello, before the page selected the work item on it.
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    expect(location.hash).toBe('#w=1&t=history');
    hello(source);
    expect(root.classList.contains('listing')).toBe(false);
    // Where the column folds into the conversation's strip, the opening shows the Conversation tab (PRD R109), and the address follows it.
    expect(root.querySelector<HTMLElement>('#head .tab.selected')?.dataset['tab']).toBe('conversation');
    expect(location.hash).toBe('#w=1');
    if (root.querySelector('#head [data-action="artifact"][data-path="chat/plan.md"]') === null) {
      click('#head .tab-more-button');
    }

    click('#head [data-action="artifact"][data-path="chat/plan.md"]');
    expect(location.hash).toBe('#w=1&t=artifact%3Achat%2Fplan.md');
    expect(localStorage.getItem('switchboard.route')).toBe('#w=1&t=artifact%3Achat%2Fplan.md');
    click('#head [data-tab="conversation"]');
    expect(location.hash).toBe('#w=1');
    expect(localStorage.getItem('switchboard.route')).toBe('#w=1');
    page.close();
    window.innerWidth = 1024;
  });

  it("keeps the conversation's place for a reload by the first item in view, and comes back to it", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#w=1');
    sessionStorage.clear();

    const first = start();
    const panel = root.querySelector<HTMLElement>('#panel')!;

    hello(first.source);
    Object.defineProperty(panel, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 500, configurable: true });
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 600 } as DOMRect);

    for (const [id, top] of [['m1', -200], ['r1', 80]] as const) {
      vi.spyOn(panel.querySelector<HTMLElement>(`li[data-id="${id}"]`)!, 'getBoundingClientRect').mockReturnValue({ top, bottom: top + 150 } as DOMRect);
    }

    panel.scrollTop = 40;
    panel.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem('switchboard.scroll')!)).toEqual({ '1 conversation s': { id: 'r1', offset: -20, pinned: false, top: 40 } });
    first.page.close();
    vi.restoreAllMocks();

    // The reload: the item that was first in view goes back 20 px above the pane's top.
    const second = start();
    const again = root.querySelector<HTMLElement>('#panel')!;
    const realQuery = again.querySelectorAll.bind(again);

    vi.spyOn(again, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 600 } as DOMRect);
    vi.spyOn(again, 'querySelectorAll').mockImplementation(((selector: string) => {
      const found = realQuery(selector);

      for (const item of found) {
        if ((item as HTMLElement).dataset['id'] === 'r1') {
          vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({ top: 400, bottom: 550 } as DOMRect);
        }
      }

      return found;
    }) as typeof again.querySelectorAll);
    Object.defineProperty(again, 'scrollHeight', { value: 2000, configurable: true });
    hello(second.source);
    // From the end (scrollHeight), up by the anchor's offset: 2000 + (400 - 100 - -20).
    expect(again.scrollTop).toBe(2000 + 320);
    second.page.close();
    window.innerWidth = 1024;
  });

  it('restores the Changes tab at its file, a local file tab at its line, and the History tab, from the route after a reload, and keeps them in it', async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1&t=changes&f=src%2Fa.ts');
    // The reads' answers do not matter here: only that the page asks for them.
    answers['/v1/conversation/changes'] = { status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } };
    answers['/page-history'] = { status: 409, body: { error: 'No such ticket.' } };
    answers['/local-file'] = { status: 404, body: { error: 'not found' } };

    const first = start();

    hello(first.source);
    await flush();
    expect(root.querySelector('#detail .detail-body')!.classList.contains('diff-pane')).toBe(true);
    expect(posts.some((post) => post.url.startsWith('/v1/conversation/changes?'))).toBe(true);
    expect(location.hash).toBe('#w=1&t=changes&f=src%2Fa.ts');
    first.page.close();

    history.replaceState(null, '', '#w=1&t=file&p=D%3A%2Fw%2FREADME.md&l=4');
    posts = [];

    const second = start();

    hello(second.source);
    await flush();
    expect(posts.some((post) => post.url.includes('/local-file') && post.url.includes(encodeURIComponent('D:/w/README.md')))).toBe(true);
    expect(location.hash).toBe('#w=1&t=file&p=D%3A%2Fw%2FREADME.md&l=4');
    expect(localStorage.getItem('switchboard.route')).toBe('#w=1&t=file&p=D%3A%2Fw%2FREADME.md&l=4');
    second.page.close();

    // History is a tab of the work item's: an address from before, which named it apart as `h`, opens that tab.
    history.replaceState(null, '', '#w=1&h=7&hk=gh%207');
    posts = [];

    const third = start();

    hello(third.source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', history: { ticketId: 7, key: 'gh 7' } })])] });
    await flush();
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(posts.find((post) => post.url.endsWith('/page-history'))?.body).toMatchObject({ ticketId: 7 });
    expect(location.hash).toBe('#w=1&t=history');
    third.page.close();
    window.innerWidth = 1024;
  });

  it("shows the list after a phone's Back and a reload, keeps Back to the list over a reload with no new entries, and opens the kept route from an empty hash", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#w=1');

    const entries = history.length;
    const groups = [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side' })])];
    const listHello = (source: FakeSource) => source.emit('hello', { key: 'pk', groups, scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    const popped = () => new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    const first = start();

    // Started on a conversation, the page puts the list's entry under it.
    expect(history.length).toBe(entries + 1);
    expect(history.state).toEqual({ switchboardConversation: true });
    expect(location.hash).toBe('#w=1');
    hello(first.source);
    expect(localStorage.getItem('switchboard.route')).toBe('#w=1');
    first.page.close();

    // A reload of that entry adds none, and the browser's back still goes to the list.
    const second = start();

    expect(history.length).toBe(entries + 1);
    hello(second.source);
    expect(root.classList.contains('listing')).toBe(false);

    let pop = popped();

    history.back();
    await pop;
    expect(root.classList.contains('listing')).toBe(true);
    expect(location.hash).toBe('#list');
    second.page.close();

    // A reload of the list shows the list, not the work item this device kept.
    posts = [];

    const third = start();

    listHello(third.source);
    await flush();
    expect(root.classList.contains('listing')).toBe(true);
    expect(posts.some((post) => post.url.endsWith('/select'))).toBe(false);
    expect(location.hash).toBe('#list');
    expect(localStorage.getItem('switchboard.route')).toBe('#w=1');
    third.page.close();

    // An empty hash, as an installed app starts at its start URL, opens the route this device kept.
    history.replaceState(null, '', '#');
    posts = [];

    const fourth = start();

    listHello(fourth.source);
    await flush();
    expect(posts.find((post) => post.url.endsWith('/select'))?.body['workItemId']).toBe(1);
    expect(location.hash).toBe('#w=1');
    fourth.page.close();
    pop = popped();
    history.back();
    await pop;
    window.innerWidth = 1024;
  });

  it("puts #list in the address for a phone's Back from a conversation with no entry of its own, as after a wider page narrowed, and keeps the device's route", () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const { page, source } = start();

    hello(source);
    expect(history.state).toBeNull();
    resizeTo(375);
    click('.header > button.back-toggle');
    expect(root.classList.contains('listing')).toBe(true);
    expect(location.hash).toBe('#list');
    expect(localStorage.getItem('switchboard.route')).toMatch(/^#w=1\b/);
    page.close();
    window.innerWidth = 1024;
  });

  it("applies a phone's conversation entry's route on the browser's forward, showing the Conversation tab with the route's tab kept for the column", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#list');
    history.pushState({ switchboardConversation: true }, '', '#w=2&t=status');

    const popped = () => new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    let pop = popped();

    history.back();
    await pop;

    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side' })])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    await flush();
    expect(root.classList.contains('listing')).toBe(true);
    expect(posts.some((post) => post.url.endsWith('/select'))).toBe(false);
    pop = popped();
    history.forward();
    await pop;
    await flush();
    expect(root.classList.contains('listing')).toBe(false);
    expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).toEqual([2]);
    hello(source, { scope: { ...scope, workItemId: 2 } });
    expect(root.querySelector<HTMLElement>('#head .tab.selected')?.dataset['tab']).toBe('conversation');
    expect(location.hash).toBe('#w=2');
    // The route's tab is the column's choice: a wider page shows it.
    resizeTo(1440);
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    page.close();
    window.innerWidth = 1024;
  });

  it('applies an address edited by hand on a wide page, gives way to Status for an artifact closed on every device, and moves no tab on a tabs event', async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1&t=artifact%3Achat%2Fplan.md');

    const entries = history.length;
    const { page, source } = start();
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs'));
    const selected = () => root.querySelector('#detail .artifact-tab.selected');

    // Closed on every device: the route does not open it again.
    hello(source, { tabs: { tab: null, closed: [{ path: 'chat/plan.md', updatedAt: 1_500 }] } });
    await flush();
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(selected()).toBeNull();
    expect(location.hash).toBe('#w=1&t=history');
    expect(kept()).toEqual([]);
    // A wide page adds no history entry.
    expect(history.length).toBe(entries);

    // The address edited by hand: its route, as no choice of the operator's.
    history.pushState(null, '', '#w=1&t=artifact%3Achat%2Fp.html');
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(selected()?.getAttribute('data-path')).toBe('chat/p.html');
    expect(location.hash).toBe('#w=1&t=artifact%3Achat%2Fp.html');
    expect(kept()).toEqual([]);

    // A tabs event, as another device's kept tab, only reconciles the closed artifacts.
    source.emit('tabs', { workItemId: 1, tabs: { tab: 'artifact:chat/plan.md', closed: [] } });
    expect(selected()?.getAttribute('data-path')).toBe('chat/p.html');
    expect(location.hash).toBe('#w=1&t=artifact%3Achat%2Fp.html');
    page.close();
    window.innerWidth = 1024;
  });

  it("brings back a link tab added from the conversation and the link selected over a reload and another work item, with and without the extension", async () => {
    window.innerWidth = 1920;

    const issue = 'https://github.com/o/r/issues/1';
    const pr = { label: 'PR #7', url: 'https://github.com/o/r/pull/7', kind: 'pr' as const, badge: '7', glyph: null, mentioned: false };
    const docs = 'https://docs.example.com/guide';
    const groups = [listGroup('progress', [listRow(1, { title: 'Fix it', url: issue, links: [pr] }), listRow(2, { title: 'Side', url: 'https://github.com/o/r/issues/2' })])];
    const selected = (): string | null | undefined => root.querySelector('#detail [data-action="iframe-open"][aria-selected="true"]')?.getAttribute('data-url');
    const links = (): Array<string | null> => [...root.querySelectorAll('#detail [data-action="iframe-open"]')].map((tab) => tab.getAttribute('data-url'));
    const open = (extension: boolean) =>
      startPage(root, {
        fetch: (async (url: string, init?: { body?: string }) => {
          posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
          return { status: 200, ok: true, json: async () => ({}) };
        }) as unknown as typeof globalThis.fetch,
        EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, standalone: () => false, openUrl: () => undefined,
        extensionInstallable: () => true, toExtension: async () => (extension ? { ok: true } : null),
      });

    history.replaceState(null, '', '#w=1');

    const first = open(true);

    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups });
    await flush();
    // A web link of the conversation opens a link tab of its own, named by its link.
    root.querySelector('#panel .timeline')!.insertAdjacentHTML('beforeend', `<li><div class="body"><a href="${docs}" target="_blank">Guide</a></div></li>`);
    root.querySelector<HTMLElement>(`#panel a[href="${docs}"]`)!.click();
    await flush();
    expect(selected()).toBe(docs);
    // The ticket's link tab closed.
    click(`#detail [data-action="iframe-close"][data-url="${issue}"]`);
    click(`#detail [data-action="iframe-open"][data-url="${pr.url}"]`);
    await flush();
    expect(links()).toEqual([pr.url, docs]);
    expect(location.hash).toBe(`#w=1&t=link&u=${encodeURIComponent(pr.url)}`);

    // Another work item and back.
    click('#list [data-work-item="2"]');
    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups, scope: { ...scope, workItemId: 2, scopeGen: 4 } });
    await flush();
    expect(links()).toEqual(['https://github.com/o/r/issues/2']);
    click('#list [data-work-item="1"]');
    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups, scope: { ...scope, scopeGen: 5 } });
    await flush();
    expect(links()).toEqual([pr.url, docs]);
    expect(selected()).toBe(pr.url);
    window.dispatchEvent(new Event('pagehide'));
    first.close();

    // A reload, with the extension and without it: the same tabs, the ticket's still closed, and the link the route names selected.
    for (const extension of [true, false]) {
      history.replaceState(null, '', `#w=1&t=link&u=${encodeURIComponent(docs)}`);

      const again = open(extension);

      hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups });
      await flush();
      expect(links()).toEqual([pr.url, docs]);
      expect(selected()).toBe(docs);
      expect(root.querySelector('#detail .detail-body')!.textContent).toContain(extension ? 'Open with sign-in support' : 'Open in a browser tab');
      again.close();
    }
  });

  it("keeps New conversation…'s draft over a reload, with its provider and text, until it is cancelled", async () => {
    answers['/providers'] = { status: 200, body: { defaultProvider: 'claude', installed: ['claude', 'codex'] } };
    history.replaceState(null, '', '#w=1');

    const first = start();
    const input = () => root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

    hello(first.source);
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    await flush();
    click('[data-action="draft-provider"][data-provider="codex"]');
    input().value = 'Start over';
    input().dispatchEvent(new Event('input'));
    first.page.close();

    const second = start();

    hello(second.source);
    await flush();
    expect(root.querySelector('#panel .new-draft')).not.toBeNull();
    expect(input().value).toBe('Start over');
    expect(root.querySelector('.draft-note [aria-pressed="true"]')!.textContent).toBe('Codex');
    click('[data-action="draft-cancel"]');
    expect(root.querySelector('.draft-note')).toBeNull();
    second.page.close();

    // Cancelled, it is gone after a reload too.
    const third = start();

    hello(third.source);
    await flush();
    expect(root.querySelector('.draft-note')).toBeNull();
    expect(input().value).toBe('');
    third.page.close();
  });

  it("gives a reload of the current session its own place, not an earlier session's, and brings History back to its place", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#w=1');
    sessionStorage.clear();
    // Only the earlier session's place.
    sessionStorage.setItem('switchboard.scroll', JSON.stringify({ '1 conversation old': { id: 'r1', offset: -20, pinned: false, top: 40 } }));

    const first = start();
    const panel = root.querySelector<HTMLElement>('#panel')!;

    Object.defineProperty(panel, 'scrollHeight', { value: 2000, configurable: true });
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 600 } as DOMRect);
    hello(first.source);
    // At the end, as a conversation with no place of its own.
    expect(panel.scrollTop).toBe(2000);
    first.page.close();
    vi.restoreAllMocks();

    // History's body scrolls under its toolbar, and its place is the body's.
    window.innerWidth = 1440;
    answers['/page-history'] = { status: 200, body: { view: { key: 'gh 7', title: 'Fix it', url: '', facts: [], links: [], reconstructed: false, recordedSince: null, sections: [] }, categories: [] } };
    history.replaceState(null, '', '#w=1&t=history');

    const withHistory = { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', history: { ticketId: 7, key: 'gh 7' } })])] };
    const second = start();

    hello(second.source, withHistory);
    await vi.waitFor(() => expect(root.querySelector('#detail .hist-body .hist-hero')).not.toBeNull());
    root.querySelector<HTMLElement>('#detail .hist-body')!.scrollTop = 180;
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem('switchboard.scroll')!)['1 history']).toMatchObject({ top: 180 });
    second.page.close();

    const third = start();

    hello(third.source, withHistory);
    await vi.waitFor(() => expect(root.querySelector('#detail .hist-body .hist-hero')).not.toBeNull());
    expect(root.querySelector<HTMLElement>('#detail .hist-body')!.scrollTop).toBe(180);
    third.page.close();
    window.innerWidth = 1024;
  });

  it('keeps the Changes tab and a tab\'s scroll place through a new session of the work item, as Approve starts, reading the tab again, and drops them for another work item', async () => {
    window.innerWidth = 375;
    answers['/v1/conversation/changes'] = { status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } };

    const { page, source } = start();
    const reads = () => posts.filter((post) => post.url.startsWith('/v1/conversation/changes?')).length;

    hello(source);
    click('#head [data-action="diff-tab"]');
    await flush();
    expect(root.querySelector('#panel')!.classList.contains('diff-pane')).toBe(true);
    const before = reads();

    // Approve runs the approval prompt in a new session of the same work item: the hub sends `scope`, then its `hello`.
    source.emit('scope', { scope: { ...scope, scopeGen: 4, sessionId: 's2' } });
    hello(source, { scope: { ...scope, scopeGen: 4, sessionId: 's2' }, sessions: [session({ id: 's2', title: 'Task session s2', state: 'running' })], items: [] });
    await flush();
    expect(root.querySelector('#panel')!.classList.contains('diff-pane')).toBe(true);
    // The new session can change the worktree, so the open tab reads its list again.
    expect(reads()).toBe(before + 1);

    // A tab's scroll place stays too.
    click('#head [data-tab="history"]');
    const panel = root.querySelector<HTMLElement>('#panel')!;

    panel.scrollTop = 237;
    source.emit('scope', { scope: { ...scope, scopeGen: 5, sessionId: 's4' } });
    hello(source, { scope: { ...scope, scopeGen: 5, sessionId: 's4' }, sessions: [session({ id: 's4' })], items: [] });
    await flush();
    expect(root.querySelector('#head [data-tab="history"]')!.getAttribute('aria-selected')).toBe('true');
    expect(panel.scrollTop).toBe(237);

    // Another work item starts from its own tabs.
    hello(source, { scope: { ...scope, workItemId: 2, scopeGen: 6, sessionId: 's3' }, sessions: [session({ id: 's3' })] });
    await flush();
    expect(root.querySelector('#panel')!.classList.contains('diff-pane')).toBe(false);
    page.close();
    window.innerWidth = 1024;
  });

  it("lists the work item's earlier sessions newest first in the dropdown, opens one read-only and goes back to the current one", async () => {
    const earlier = [
      { sessionId: 's1', title: 'Task session s1', state: 'ended' as const, startedAt: 10_000 - 3 * 3_600_000, provider: 'claude' },
      { sessionId: 's0', title: 'Setup session s0', state: 'ended' as const, startedAt: 10_000 - 2 * 86_400_000, provider: 'claude' },
    ];
    const listed = { ...scope, sessionId: 's2', conversations: [{ ...scope.conversations[0]!, sessionId: 's2', sessionTitle: 'Fix the badge count', sessionStartedAt: 1_200, sessions: earlier }] };
    const { page, source } = start();
    const selects = () => posts.filter((post) => post.url.endsWith('/select')).map((post) => ({ workItemId: post.body['workItemId'], sessionId: post.body['sessionId'] }));

    const openPicker = () => root.querySelector('.conversation-menu') !== null || click('button.picker');

    hello(source, { scope: listed, sessions: [session({ id: 's2', title: 'Task session s2' })] });
    openPicker();
    expect([...root.querySelectorAll('.conversation-menu .conversation-row')].map((row) => [row.querySelector('.title')!.textContent, row.getAttribute('aria-checked'), row.querySelector('.menu-note')?.textContent ?? null])).toEqual([
      ['Fix the badge count', 'true', null],
      ['Task session s1', 'false', '3 h ago'],
      ['Setup session s0', 'false', '2 d ago'],
    ]);
    expect(root.querySelector('.session-row .codicon')!.getAttribute('aria-label')).toBe('Ended');

    // The artifact open stays open through choosing a session.
    click('[data-action="artifact"][data-path="chat/plan.md"] .tab-open, [data-action="artifact"][data-path="chat/plan.md"]');
    expect(root.querySelector('.artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/plan.md');
    openPicker();
    click('.session-row[data-session="s1"]');
    await flush();
    expect(selects()).toEqual([{ workItemId: 1, sessionId: 's1' }]);
    expect(root.querySelector('.artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/plan.md');

    // Choosing the current session again before the hub's scope for s1 came asks for it, so the late scope cannot win.
    openPicker();
    click('.conversation-menu [data-action="select"][data-work-item="1"]');
    await flush();
    expect(selects()).toEqual([{ workItemId: 1, sessionId: 's1' }, { workItemId: 1, sessionId: undefined }]);
    openPicker();
    click('.session-row[data-session="s1"]');
    await flush();
    expect(selects()).toHaveLength(3);

    // The hub shows it read-only: the composer is off, the note says why and offers the current session, and the button names the session.
    const shown = { ...listed, scopeGen: 4, sessionId: 's1', earlier: true };

    source.emit('scope', { scope: shown });
    hello(source, { scope: shown, sessions: [session({ id: 's1', title: 'Task session s1', state: 'ended', conversation: 'read-only', reason: 'This is an earlier session of the work item, shown read-only.' })], items: [reply('old', 1)] });
    expect(root.querySelector('.session-note-text')!.textContent).toBe('An earlier session of this work item, shown read-only.');
    expect(root.querySelector('[data-action="resume"]')).toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>('#composer textarea, textarea')!.disabled).toBe(true);
    expect(root.querySelector<HTMLTextAreaElement>('#composer textarea, textarea')!.placeholder).toBe('Show the current session to send a message.');
    // The button shows the work item's title over the earlier session's name, with its provider's mark, both in its tooltip.
    expect(root.querySelector('button.picker .title')!.textContent).toBe('Fix it');
    expect(root.querySelector('button.picker .picker-session')!.textContent).toBe('Task session s1');
    expect(root.querySelector('button.picker .provider')!.getAttribute('aria-label')).toBe('Claude');
    expect(root.querySelector('button.picker')!.getAttribute('title')).toBe('Task session s1 · Fix it');
    // Its timeline ends where the current session started: an artifact written before then shows in it, one written after only in the current one.
    for (const [path, updatedAt] of [['chat/early.md', 1_100], ['chat/late.md', 1_300]] as const) {
      source.emit('artifact', { artifact: { path, owner: 'chat', kind: 'note', title: path, ext: 'md', type: 'markdown', updatedAt } });
    }
    expect(root.querySelector('#panel .artifact-open[data-path="chat/early.md"]')).not.toBeNull();
    expect(root.querySelector('#panel .artifact-open[data-path="chat/late.md"]')).toBeNull();
    openPicker();
    expect([...root.querySelectorAll('.conversation-menu .conversation-row')].map((row) => row.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);

    // A new stream, as after a hub restart, asks for the same earlier session again.
    hello(source, { key: 'pk2', scope: null, sessions: [], items: [] });
    await flush();
    expect(selects().slice(3)).toEqual([{ workItemId: 1, sessionId: 's1' }]);
    source.emit('scope', { scope: { ...shown, key: 'pk2', scopeGen: 5 } });
    hello(source, { key: 'pk2', scope: { ...shown, key: 'pk2', scopeGen: 5 }, sessions: [session({ id: 's1', state: 'ended', conversation: 'read-only' })], items: [reply('old', 1)] });
    await flush();
    expect(selects()).toHaveLength(4);

    // The conversation's own row, or the note's button, goes back to the current session.
    openPicker();
    click('.conversation-menu [data-action="select"][data-work-item="1"]');
    await flush();
    expect(selects().at(-1)).toEqual({ workItemId: 1, sessionId: undefined });
    // The note's button asks for the same, so it is not asked twice while the hub's scope is on its way.
    click('.session-note [data-action="select"]');
    await flush();
    expect(selects()).toHaveLength(5);
    page.close();
  });

  it("keeps a conversation's kept place through a reload onto another tab, gives it back on A to B to A, and reads the Changes tab again after a reconnect", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#w=1&t=status');

    const { page, source } = start();

    hello(source);

    // A to B: A's place is kept; back to A, the conversation takes it again rather than its end.
    const panel = root.querySelector<HTMLElement>('#panel')!;

    click('#head [data-tab="conversation"]');
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    hello(source, { scope: { ...scope, workItemId: 2, scopeGen: 4 } });
    // Where A was when it was left, as the operator had scrolled it.
    sessionStorage.setItem('switchboard.scroll', JSON.stringify({ '1 conversation s': { id: 'r1', offset: 0, pinned: false, top: 0 } }));
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 600 } as DOMRect);
    Object.defineProperty(panel, 'scrollHeight', { value: 2000, configurable: true });
    const realQuery = panel.querySelectorAll.bind(panel);

    vi.spyOn(panel, 'querySelectorAll').mockImplementation(((selector: string) => {
      const found = realQuery(selector);

      for (const item of found) {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({ top: (item as HTMLElement).dataset['id'] === 'r1' ? 400 : 0, bottom: 500 } as DOMRect);
      }

      return found;
    }) as typeof panel.querySelectorAll);
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    hello(source, { scope: { ...scope, scopeGen: 5 } });
    expect(panel.scrollTop).toBe(2000 + 300);
    vi.restoreAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    // The Changes tab, kept through a reconnect, reads its list again once the new stream shows the work item.
    answers['/v1/conversation/changes'] = { status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } };
    click('#head [data-action="diff-tab"]');
    const reads = () => posts.filter((post) => post.url.startsWith('/v1/conversation/changes?')).length;
    const before = reads();

    expect(before).toBeGreaterThan(0);

    source.emit('hello', { key: 'pk9', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side' })])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    expect(reads()).toBe(before);
    hello(source, { key: 'pk9', scope: { ...scope, scopeGen: 6 } });
    expect(reads()).toBe(before + 1);
    page.close();
    window.innerWidth = 1024;
  });

  it("keeps an artifact document's place over a reload", async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1&t=artifact%3Achat%2Fplan.md');
    sessionStorage.setItem('switchboard.scroll', JSON.stringify({ '1 artifact:chat/plan.md': { id: null, offset: 0, pinned: false, top: 240 } }));
    answers['/v1/conversation/artifact/'] = { status: 200, body: {}, text: '# Plan\n\nLong.' };

    const { page, source } = start();

    hello(source);
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>('#detail .artifact-doc')?.textContent).toContain('Long.'));
    expect(root.querySelector<HTMLElement>('#detail .artifact-doc')!.scrollTop).toBe(240);
    root.querySelector<HTMLElement>('#detail .artifact-doc')!.scrollTop = 300;
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem('switchboard.scroll')!)['1 artifact:chat/plan.md']).toMatchObject({ top: 300 });
    page.close();
    window.innerWidth = 1024;
  });

  it('keeps each tab its own scroll place for the work item, and gives it back when the tab shows again', () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#w=1');
    sessionStorage.clear();

    const { page, source } = start();
    const panel = root.querySelector<HTMLElement>('#panel')!;

    hello(source);
    click('#head [data-tab="history"]');
    // History scrolls its own body.
    panel.querySelector<HTMLElement>('.hist-body')!.scrollTop = 120;
    click('#head [data-tab="conversation"]');
    expect(JSON.parse(sessionStorage.getItem('switchboard.scroll')!)['1 history']).toMatchObject({ top: 120 });
    click('#head [data-tab="history"]');
    expect(panel.querySelector<HTMLElement>('.hist-body')!.scrollTop).toBe(120);
    page.close();
    window.innerWidth = 1024;
  });

  it("brings back a work item's file tabs in order, its Changes tab and the tab shown after another work item and after a reload, and forgets a closed tab", async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const groups = [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Other' })])];
    const scopeOf = (workItemId: number) => ({ ...scope, workItemId, scopeGen: 3 + workItemId, title: `Item ${workItemId}`, conversations: [{ ...scope.conversations[0]!, workItemId, title: `Item ${workItemId}` }] });
    const helloFor = (source: FakeSource, workItemId: number) => source.emit('hello', { key: 'pk', groups, scope: scopeOf(workItemId), sessions: [session()], items: [reply('r1', 2, { opening: 'See [a](src/a.ts#L3) and [b](src/b.ts).' })], more: false, state: null, artifacts: [artifact('chat/plan.md', 'markdown', 'md')] });
    const fileTabs = () => [...root.querySelectorAll<HTMLElement>('#detail .detail-head [data-action="local-tab"]')].map((one) => `${one.title}${one.getAttribute('aria-selected') === 'true' ? ' *' : ''}`);
    const shown = () => root.querySelector<HTMLElement>('#detail .detail-head [aria-selected="true"]');
    // Read or not, a file tab is named by its link's target.
    answers['local-file'] = { status: 404, body: { error: 'Not found.' } };
    answers['changes'] = { status: 404, body: { error: 'No changes here.' } };
    let { page, source } = start();

    helloFor(source, 1);
    click('#panel a.path-link');
    click('#panel a.path-link:nth-of-type(2)');
    click('#detail .changes-tab');
    click('#detail [data-action="local-tab"]');
    await flush();
    expect(fileTabs()).toEqual(['src/a.ts:3 *', 'src/b.ts']);
    expect(root.querySelector('#detail .changes-tab')).not.toBeNull();

    // Another work item opens on its own tabs.
    click('[data-work-item="2"]');
    helloFor(source, 2);
    await flush();
    expect(fileTabs()).toEqual([]);
    expect(shown()?.dataset['side']).toBe('history');
    click('#detail [data-side="console"]');
    expect(shown()?.dataset['side']).toBe('console');

    // Back: the same file tabs in their order, a.ts shown, and the Changes tab.
    click('[data-work-item="1"]');
    helloFor(source, 1);
    await flush();
    expect(fileTabs()).toEqual(['src/a.ts:3 *', 'src/b.ts']);
    expect(root.querySelector('#detail .changes-tab')).not.toBeNull();
    // And work item 2 again on Console.
    click('[data-work-item="2"]');
    helloFor(source, 2);
    expect(shown()?.dataset['side']).toBe('console');

    // A reload, with only the work item in the address, brings them back from this device's storage.
    click('[data-work-item="1"]');
    helloFor(source, 1);
    click('#detail .changes-tab');
    page.close();
    history.replaceState(null, '', '#w=1');
    ({ page, source } = start());
    helloFor(source, 1);
    await flush();
    expect(fileTabs()).toEqual(['src/a.ts:3', 'src/b.ts']);
    expect(root.querySelector('#detail .changes-tab')?.classList.contains('selected')).toBe(true);

    // A closed tab stays closed.
    click('#detail [data-action="local-close"]');
    await flush();
    click('[data-work-item="2"]');
    helloFor(source, 2);
    click('[data-work-item="1"]');
    helloFor(source, 1);
    await flush();
    expect(fileTabs()).toEqual(['src/b.ts']);
    expect(JSON.parse(localStorage.getItem('switchboard.tabs')!)).toMatchObject({ w1: { files: [{ target: 'src/b.ts', line: null }], changes: true } });
    page.close();
  });

  it("brings a file tab back to where it was scrolled, keeps the artifact shown before a dropdown conversation, and keeps another page's tab sets", async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');

    const groups = [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Other' })])];
    const both = [1, 2].map((id) => ({ ...scope.conversations[0]!, workItemId: id, title: `Item ${id}`, primary: id === 1 }));
    const helloFor = (source: FakeSource, workItemId: number) => source.emit('hello', { key: 'pk', groups, scope: { ...scope, workItemId, scopeGen: 3 + workItemId, conversations: both }, sessions: [session()], items: [reply('r1', 2, { opening: 'See [notes](notes.md).' })], more: false, state: null, artifacts: [artifact('chat/plan.md', 'markdown', 'md'), artifact('chat/p.html', 'html', 'html')] });
    const doc = () => root.querySelector<HTMLElement>('#detail .detail-body .local-view > .artifact-doc')!;

    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Notes', tooLarge: false, size: 7, entries: null, more: false } };
    answers['artifact'] = { status: 200, body: {}, text: '# Plan' };
    let { page, source } = start();

    helloFor(source, 1);
    click('#panel a.path-link');
    await flush();
    await flush();
    doc().scrollTop = 380;
    doc().dispatchEvent(new Event('scroll'));
    click('#detail [data-side="history"]');
    expect(root.querySelector('#detail .local-view')).toBeNull();
    // Back on the file tab, and after another work item and back, it is where it was left.
    click('#detail [data-action="local-tab"]');
    expect(doc().scrollTop).toBe(380);
    click('[data-work-item="2"]');
    helloFor(source, 2);
    click('[data-work-item="1"]');
    helloFor(source, 1);
    await flush();
    await flush();
    expect(doc().scrollTop).toBe(380);
    // The column folded into tabs and back draws the file anew, at the same place.
    resizeTo(1000);
    resizeTo(1440);
    expect(doc().scrollTop).toBe(380);

    // A folder's list scrolls in its own element, and comes back the same way.
    answers['local-file'] = { status: 200, body: { path: 'D:/w/src', name: 'src', kind: 'dir', contents: null, tooLarge: false, size: null, entries: [{ name: 'a.ts', dir: false }], more: false } };
    const entries = () => root.querySelector<HTMLElement>('#detail .detail-body .local-view > .local-entries')!;

    source.emit('reply', { reply: reply('r2', 3, { opening: 'And [src](src/).' }) });
    click('#panel a.path-link[data-target="src/"]');
    await flush();
    await flush();
    entries().scrollTop = 120;
    entries().dispatchEvent(new Event('scroll'));
    resizeTo(1000);
    resizeTo(1440);
    expect(entries().scrollTop).toBe(120);

    // An artifact shown on work item 1 stays its tab after a conversation of its dropdown and back.
    click('#detail .artifact-tab[data-path="chat/p.html"] .tab-open');
    expect(root.querySelector('#detail .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/p.html');
    click('#head [data-action="picker"]');
    click('#head [data-action="select"][data-work-item="2"]');
    helloFor(source, 2);
    click('#head [data-action="picker"]');
    click('#head [data-action="select"][data-work-item="1"]');
    helloFor(source, 1);
    expect(root.querySelector('#detail .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/p.html');

    // Another page of this device keeps work item 2's tabs meanwhile; this page's next change keeps them.
    const other = JSON.parse(localStorage.getItem('switchboard.tabs')!) as Record<string, unknown>;

    localStorage.setItem('switchboard.tabs', JSON.stringify({ ...other, w2: { side: 'console', tab: 'conversation', artifact: null, changes: false, changesFile: null, files: [], file: null } }));
    click('#detail [data-side="history"]');
    expect(JSON.parse(localStorage.getItem('switchboard.tabs')!)).toMatchObject({ w2: { side: 'console' }, w1: { side: 'history' } });
    page.close();
  });

});
