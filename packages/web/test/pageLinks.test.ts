import { afterEach, onTestFinished, beforeEach, describe, expect, it, vi } from 'vitest';
import { html } from './html.js';
import { LINK_ANSWER_MS, loadMermaid, startPage } from '../src/main.js';
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

  it('raises a needs-you alert the hub sends as a silent notification per work item whose click shows it, with the chime only when asked', async () => {
    const notices: FakeNotice[] = [];
    const asked = vi.fn(async () => 'granted');

    class FakeNotice {
      static permission = 'default';
      static requestPermission = asked;
      onclick: (() => void) | null = null;
      closed = false;

      constructor(
        readonly title: string,
        readonly options: NotificationOptions,
      ) {
        notices.push(this);
      }

      close(): void {
        this.closed = true;
      }
    }

    vi.stubGlobal('Notification', FakeNotice);
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const { page, source } = start();

    hello(source);
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/page-focus')).at(-1)?.body).toMatchObject({ notify: false });
    // Asked once, on the first press in the page; the answer tells the hub the page may now alert.
    asked.mockImplementation(async () => ((FakeNotice.permission = 'granted'), 'granted'));
    document.dispatchEvent(new Event('pointerdown'));
    document.dispatchEvent(new Event('pointerdown'));
    expect(asked).toHaveBeenCalledTimes(1);
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/page-focus')).at(-1)?.body).toMatchObject({ notify: true });
    FakeNotice.permission = 'denied';
    // Not allowed yet: no notification, but the message shows in the toast, neutral.
    source.emit('needs', { items: [{ workItemId: 2, message: 'Switchboard: Side — Review, then approve' }], sound: false });
    expect(notices).toEqual([]);
    expect(root.querySelector('.toast.info .toast-open')?.textContent).toBe('Switchboard: Side — Review, then approve');

    FakeNotice.permission = 'granted';
    source.emit('needs', { items: [{ workItemId: 2, message: 'Switchboard: Side — Review, then approve' }], sound: false });
    expect(notices.map((one) => [one.title, one.options])).toEqual([['Switchboard', { body: 'Side — Review, then approve', tag: 'switchboard-needs-2', silent: true }]]);
    notices[0]!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(notices[0]!.closed).toBe(true);
    expect(location.hash).toBe('#w=2');

    const oscillators = vi.fn();

    vi.stubGlobal(
      'AudioContext',
      class {
        currentTime = 0;
        destination = {};
        createOscillator = () => {
          const one = { frequency: { value: 0 }, connect: (next: unknown) => next, start: () => {}, stop: () => oscillators(one.frequency.value) };

          return one;
        };
        createGain = () => ({ gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: (next: unknown) => next });
        close = async () => {};
      },
    );
    source.emit('needs', { items: [{ workItemId: 1, message: 'Switchboard: Fix it — Answer a question' }], sound: false });
    expect(oscillators).not.toHaveBeenCalled();
    source.emit('needs', { items: [{ workItemId: 1, message: 'Switchboard: Fix it — Answer a question' }], sound: true });
    expect(oscillators.mock.calls).toEqual([[880], [1320]]);
    page.close();
    vi.unstubAllGlobals();
  });

  it('asks the hub to open a link in the default browser when installed as an app, and shows its refusal', async () => {
    const { page, source, opened } = start();
    const links = [{ label: 'PR #5', url: 'https://github.com/o/r/pull/5', kind: 'pr' as const, badge: '5', glyph: null, mentioned: false }, { label: 'Bad', url: 'file:///C:/x', kind: 'url' as const, badge: 'Bad', glyph: null, mentioned: false }];

    installed = true;
    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', links })])] });
    posts = [];
    click('button.actions');
    click('.actions-menu [data-link="0"]');
    await flush();
    expect(opened).toEqual([]);
    expect(posts.map((post) => post.url)).toEqual(['/v1/conversation/row-open']);
    // The hub gets the row's own URL, unmarked, and checks it against the row itself.
    expect(posts[0]!.body).toMatchObject({ window: 'pk', workItemId: 1, url: 'https://github.com/o/r/pull/5' });

    answers['/row-open'] = { status: 409, body: { error: 'The work item no longer links to this.' } };
    click('button.actions');
    click('.actions-menu [data-link="0"]');
    await flush();
    await flush();
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The work item no longer links to this.');
    page.close();
  });

  it("opens a link in the device's own browser from an installed page on another device, which the hub would open on the computer", async () => {
    const opened: string[] = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, openUrl: (url) => opened.push(url), standalone: () => true, local: false });
    const links = [{ label: 'PR #5', url: 'https://github.com/o/r/pull/5', kind: 'pr' as const, badge: '5', glyph: null, mentioned: false }];

    hello(FakeSource.last!, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', links })])] });
    // The computer's pane is paired, which a page on another device leaves aside: its pills open their links.
    FakeSource.last!.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null } });
    posts = [];
    click('button.actions');
    click('.actions-menu [data-link="0"]');
    click('#list [data-work-item="1"] .pill.link.pr');
    await flush();
    expect(posts.map((post) => post.url)).not.toContain('/v1/conversation/row-open');
    expect(opened).toEqual(['https://github.com/o/r/pull/5', 'https://github.com/o/r/pull/5']);
    page.close();

    // Left to the browser, the link opens in a new tab without an opener or referrer.
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const own = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, standalone: () => true, local: false });

    hello(FakeSource.last!, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', links })])] });
    click('button.actions');
    click('.actions-menu [data-link="0"]');
    await flush();
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/5', '_blank', 'noopener,noreferrer');
    own.close();
  });

  it("opens a row's links and pills in the extension's tab group on another device, and in a new tab once the extension no longer answers", async () => {
    const opened: string[] = [];
    const sent: Array<Record<string, unknown>> = [];
    let installedExtension = true;
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const toExtension = async (_id: string, message: Record<string, unknown>) => (sent.push(message), installedExtension ? (message['type'] === 'links' ? { links: true } : { opened: true }) : null);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, openUrl: (url) => opened.push(url), standalone: () => true, local: false, toExtension });
    const links = [{ label: 'PR #5', url: 'https://github.com/o/r/pull/5', kind: 'pr' as const, badge: '5', glyph: null, mentioned: false }];

    await flush();
    hello(FakeSource.last!, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1', links })])] });
    posts = [];
    click('button.actions');
    click('.actions-menu [data-link="ticket"]');
    click('#list [data-work-item="1"] .pill.link.pr');
    await flush();
    expect(sent).toEqual([{ type: 'links' }, { type: 'open', url: 'https://github.com/o/r/issues/1', until: 10_000 + LINK_ANSWER_MS - 500 }, { type: 'open', url: 'https://github.com/o/r/pull/5', until: 10_000 + LINK_ANSWER_MS - 500 }]);
    expect(opened).toEqual([]);
    expect(posts.map((post) => post.url)).not.toContain('/v1/conversation/row-open');

    // The extension was removed: the open falls back to a new tab, and once the page shows again it no longer asks the extension.
    installedExtension = false;
    click('#list [data-work-item="1"] .pill.link.pr');
    await flush();
    expect(opened).toEqual(['https://github.com/o/r/pull/5']);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    sent.length = 0;
    click('#list [data-work-item="1"] .pill.link.pr');
    await flush();
    expect(sent).toEqual([]);
    expect(opened).toEqual(['https://github.com/o/r/pull/5', 'https://github.com/o/r/pull/5']);
    page.close();
  });

  it('opens the link in a new tab when the extension does not answer in time, and opens tabs itself until the extension answers the next probe', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });

    const opened: string[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    // The extension answers the probe but never an open.
    const toExtension = (_id: string, message: Record<string, unknown>) => (sent.push(message), message['type'] === 'links' ? Promise.resolve({ links: true }) : new Promise<unknown>(() => {}));
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, openUrl: (url) => opened.push(url), standalone: () => false, local: false, toExtension });
    const links = [{ label: 'PR #5', url: 'https://github.com/o/r/pull/5', kind: 'pr' as const, badge: '5', glyph: null, mentioned: false }];
    const turn = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    await turn();
    hello(FakeSource.last!, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', links })])] });
    click('#list [data-work-item="1"] .pill.link.pr');
    await turn();
    vi.advanceTimersByTime(LINK_ANSWER_MS - 1);
    expect(opened).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(opened).toEqual(['https://github.com/o/r/pull/5']);
    // The next link opens at once, without asking the extension.
    sent.length = 0;
    click('#list [data-work-item="1"] .pill.link.pr');
    expect(sent).toEqual([]);
    expect(opened).toEqual(['https://github.com/o/r/pull/5', 'https://github.com/o/r/pull/5']);
    // Once it answers the probe again, links go to it.
    document.dispatchEvent(new Event('visibilitychange'));
    await turn();
    click('#list [data-work-item="1"] .pill.link.pr');
    expect(sent.at(-1)).toEqual({ type: 'open', url: 'https://github.com/o/r/pull/5', until: 10_000 + LINK_ANSWER_MS - 500 });
    page.close();
  });

  it("lists Open ticket and each link in the actions menu, more than two in an Open link submenu, a long label cut with its whole text in the tooltip", async () => {
    const { page, source, opened } = start();
    const link = (label: string, url: string) => ({ label, url, kind: 'url' as const, badge: label, glyph: null, mentioned: false });
    const long = 'A link label that a session reported which runs far past the limit';

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1', links: [link('PR #5', 'https://github.com/o/r/pull/5'), link(long, 'https://example.test/long')] })])] });
    click('button.actions');
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Open ticket', 'Open PR #5', `Open ${long.slice(0, 42).trimEnd()}…`]);
    expect(root.querySelector('.actions-menu [data-link="1"]')!.getAttribute('title')).toBe(`Open ${long}`);
    click('.actions-menu [data-link="ticket"]');
    expect(opened).toEqual(['https://github.com/o/r/issues/1']);
    expect(root.querySelector('.actions-menu')).toBeNull();

    source.emit('list', { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', links: [link('One', 'https://example.test/1'), link('Two', 'https://example.test/2'), link('Three', 'https://example.test/3')] })])] });
    click('button.actions');
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Open link']);
    click('.actions-menu [data-action="link-menu"]');
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Open link', 'One', 'Two', 'Three']);
    expect(root.querySelector('.actions-menu [data-action="link-menu"]')!.getAttribute('aria-expanded')).toBe('true');
    click('.actions-menu [data-link="2"]');
    expect(opened.at(-1)).toBe('https://example.test/3');
    // The submenu starts closed the next time the menu opens.
    click('button.actions');
    expect(root.querySelectorAll('.actions-menu .submenu-row')).toHaveLength(0);
    page.close();
  });

  it("shows a Claude session's permission prompt from its screen while it waits, and presses the option clicked for that prompt", async () => {
    const { page, source } = start();
    const prompt = { id: 'p1', lines: [' Bash command', ' echo hi', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'], options: [{ key: '1', label: 'Yes', selected: true }, { key: '2', label: 'No', selected: false }], next: false };

    answers['/prompt-key'] = { status: 200, body: { done: true } };
    answers['/prompt'] = { status: 200, body: { prompt } };
    hello(source, { sessions: [session({ state: 'waiting', waitingFor: 'permission' })] });
    await flush();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/prompt'))?.body).toMatchObject({ sessionId: 's', scopeGen: 3 });
    expect(root.querySelector('.prompt-screen')!.textContent).toContain('Do you want to proceed?');
    expect([...root.querySelectorAll('.prompt-card [data-action="prompt-key"]')].map((button) => button.textContent)).toEqual(['1 Yes', '2 No', 'Cancel (Esc)']);
    expect(root.querySelector('.working-detail')!.textContent).toBe('Claude asks in its terminal; answer it below.');

    click('.prompt-card [data-prompt-key="2"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/prompt-key'))?.body).toMatchObject({ sessionId: 's', launch: 'L', prompt: 'p1', key: '2' });

    // Once the session works again the card goes.
    source.emit('session', { session: session({ state: 'running' }) });
    await flush();
    expect(root.querySelector('.prompt-card')).toBeNull();
    page.close();
  });

  it("opens New conversation… as an empty draft in the shown work item, starting nothing until its first message is sent", async () => {
    const { page, source } = start();
    const input = root.querySelector<HTMLTextAreaElement>('#composer textarea')!;
    const typed = (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
    };
    const draftPosts = () => posts.filter((post) => post.url.endsWith('/page-conversation'));

    answers['/providers'] = { status: 200, body: { defaultProvider: 'codex', installed: ['claude', 'codex'] } };
    answers['/page-conversation'] = { status: 200, body: { workItemId: 1, sessionId: 's2' } };
    hello(source);
    typed('The work item draft');
    click('[data-action="picker"]');
    expect([...root.querySelectorAll('.conversation-menu .menu-row')].map((row) => row.textContent)).toEqual(['Fix it', 'Side', 'New session in this work item…']);
    click('[data-action="new-conversation"]');
    await flush();

    // An empty draft in the same work item, its composer focused, its provider the shown conversation's; nothing is made.
    expect(root.querySelector('.conversation-menu')).toBeNull();
    expect(root.querySelector('#panel .new-draft')!.textContent).toContain('It starts when you send its first message');
    expect(root.querySelector('button.picker .title')!.textContent).toBe('Fix it');
    expect(root.querySelector('button.picker .picker-session')!.textContent).toBe('New session');
    expect(root.querySelector('button.picker')!.getAttribute('title')).toBe('New session · Fix it');
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect([...root.querySelectorAll('.draft-note [data-action="draft-provider"]')].map((one) => [one.textContent, one.getAttribute('aria-pressed')])).toEqual([['Claude', 'true'], ['Codex', 'false']]);
    expect(draftPosts()).toEqual([]);

    // Dictation for the session shown never fills the draft, which is no session's.
    source.emit('draft', { text: 'spoken words', sessionId: 's' });
    expect(input.value).toBe('');

    // Cancel leaves it, starting nothing, with the work item's own draft back.
    click('[data-action="draft-cancel"]');
    expect(root.querySelector('.draft-note')).toBeNull();
    expect(input.value).toBe('The work item draft');
    expect(draftPosts()).toEqual([]);

    // Another selection leaves it too.
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    await flush();
    typed('Never sent');
    click('#list [data-work-item="2"]');
    expect(root.querySelector('.draft-note')).toBeNull();
    expect(draftPosts()).toEqual([]);
    click('#list [data-work-item="1"]');
    await flush();

    // A refused send keeps the draft and its text, with why.
    answers['/page-conversation'] = { status: 409, body: { error: 'A session of this work item is in a turn.' } };
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    await flush();
    click('[data-action="draft-provider"][data-provider="codex"]');
    typed('Why did it fail?');
    click('button.send');
    await flush();
    await flush();
    expect(draftPosts().at(-1)?.body).toMatchObject({ window: 'pk', scopeGen: 3, provider: 'codex', text: 'Why did it fail?' });
    expect(draftPosts().at(-1)?.body).not.toHaveProperty('workItemId');
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('A session of this work item is in a turn.');
    expect(root.querySelector('.draft-note')).not.toBeNull();
    expect(input.value).toBe('Why did it fail?');

    // Sent: the hub starts the session with the message and shows it; the draft goes and the work item's own draft comes back.
    const refused = draftPosts().at(-1)!.body['opId'];

    answers['/page-conversation'] = { status: 200, body: { workItemId: 1, sessionId: 's2' } };
    click('button.send');
    await flush();
    await flush();
    expect(draftPosts()).toHaveLength(2);
    expect(draftPosts().at(-1)!.body['opId']).toBe(refused);
    expect(root.querySelector('.draft-note')).toBeNull();
    expect(root.querySelector('#panel .new-draft')).toBeNull();
    expect(input.value).toBe('The work item draft');
    page.close();
  });

  it("presets New conversation…'s provider to the session shown, an earlier one included, not to the work item's current one", async () => {
    const { page, source } = start();

    answers['/providers'] = { status: 200, body: { defaultProvider: 'claude', installed: ['claude', 'codex'] } };
    hello(source, { sessions: [session({ provider: 'codex' })] });
    click('[data-action="picker"]');
    click('[data-action="new-conversation"]');
    await flush();
    expect(root.querySelector('.draft-note [aria-pressed="true"]')!.textContent).toBe('Codex');
    page.close();
  });

  it("opens every work item on the Conversation tab in the phone's layout, whatever tab it kept or the column would show, and keeps a tab chosen until another work item opens", async () => {
    window.innerWidth = 375;
    history.replaceState(null, '', '#');
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    let refuse = false;
    const answer = (url: string) => (refuse && url.endsWith('/select') ? 409 : 200);
    const open = () => startPage(root, { fetch: (async (url: string, init?: { body?: string }) => (posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) }), { status: answer(url), ok: answer(url) === 200, json: async () => ({}), text: async () => '' })) as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, standalone: () => true, toExtension: async () => ({ ok: true }) });
    let page = open();
    let source = FakeSource.last!;
    const shown = () => root.querySelector<HTMLElement>('#head .tab.selected')?.dataset['tab'];
    const paired = { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null };
    const rows = [listGroup('progress', [listRow(1, { title: 'Fix it', url: 'https://github.com/o/r/issues/1' }), listRow(2, { title: 'Side', url: 'https://github.com/o/r/issues/2' })])];
    // Each opening rule that picks another tab: an artifact kept for the work item, Browser chosen for every work item, no status report yet.
    const kept = { groups: rows, openOn: 'browser', status: null, tabs: { tab: 'artifact:chat/p.html', closed: [] } };

    hello(source, { ...kept, scope: null });
    source.emit('pane', { pane: paired });
    click('[data-work-item="1"]');
    await flush();
    hello(source, kept);
    source.emit('pane', { pane: paired });
    expect(root.classList.contains('listing')).toBe(false);
    expect(shown()).toBe('conversation');

    // A tab chosen there stays while the work item is open.
    click('#head [data-tab="history"]');
    source.emit('pane', { pane: { ...paired, shown: true } });
    expect(shown()).toBe('history');

    // Back to the list and the same work item again: the conversation, with no new hello.
    click('.header > button.back-toggle');
    expect(root.classList.contains('listing')).toBe(true);
    click('[data-work-item="1"]');
    expect(root.classList.contains('listing')).toBe(false);
    expect(shown()).toBe('conversation');

    // Another work item, as from the header's list: the conversation.
    click('#head [data-tab="history"]');
    click('.header > button.back-toggle');
    click('[data-work-item="2"]');
    await flush();
    hello(source, { ...kept, scope: { ...scope, workItemId: 2 }, tabs: { tab: 'console', closed: [] } });
    expect(shown()).toBe('conversation');

    // A conversation of its dropdown the hub refuses to open leaves the open one's tab as it was.
    click('#head [data-tab="history"]');
    click('.header > button.back-toggle');
    refuse = true;
    click('[data-work-item="1"]');
    await flush();
    refuse = false;
    expect(shown()).toBe('history');

    // A reload: the conversation.
    page.close();
    page = open();
    source = FakeSource.last!;
    hello(source, { ...kept, scope: { ...scope, workItemId: 2 } });
    source.emit('pane', { pane: paired });
    expect(shown()).toBe('conversation');
    page.close();
  });



  it('creates tabs for every attached web link on selection and opens a pill only after its row is selected', async () => {
    window.innerWidth = 1920;
    const sent: Record<string, unknown>[] = [];
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 200, ok: true, json: async () => ({}) }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000,
      toExtension: async (_id, message) => { sent.push(message); return { ok: true }; },
    });
    const source = FakeSource.last!;
    const links = Array.from({ length: 14 }, (_, i) => ({ label: `Site ${i}`, url: `http://site${i}.test:8080/path?q=1#part`, kind: 'url' as const, badge: `Site ${i}`, glyph: null, mentioned: false }));
    links[0]!.url = 'https://desk.zoho.com/agent/ticket/1';
    links[1]!.url = 'https://forum.example.com/t/2';
    const groups = [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1', links }), listRow(2, { url: 'https://desk.zoho.com/agent/ticket/2', links: [links[1]!] })])];
    hello(source, { settings: { iframeBrowser: true }, groups }); await flush();
    expect(root.querySelectorAll('#detail [data-action="iframe-open"]')).toHaveLength(15);
    expect(root.querySelector('#detail iframe.browser')).toBeNull();
    posts = []; sent.length = 0;
    click('#list [data-work-item="2"] .pill.link'); await flush();
    expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).toEqual([2]);
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([]);
    hello(source, { settings: { iframeBrowser: true }, groups, scope: { ...scope, workItemId: 2 } }); await flush();
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([{ type: 'iframe-launch', workItemId: 2, url: 'https://forum.example.com/t/2' }]);
    expect(root.querySelector('#detail [data-action="iframe-open"][aria-selected="true"]')?.getAttribute('data-url')).toBe('https://forum.example.com/t/2');
    click('#list [data-work-item="2"] .pill.link'); await flush();
    expect(root.querySelectorAll('#detail [data-action="iframe-open"]')).toHaveLength(2);
    page.close();
  });

  it('honors the last pill after an acknowledged selection whose hello is late, and drops refused pill requests', async () => {
    const sent: Record<string, unknown>[] = [];
    let refuse = false;
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); const denied = refuse && url.endsWith('/select'); return { status: denied ? 409 : 200, ok: !denied, json: async () => denied ? { error: 'That work item is gone.' } : {} }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000,
      toExtension: async (_id, message) => { sent.push(message); return { ok: true }; },
    });
    const source = FakeSource.last!;
    const groups = [listGroup('progress', [listRow(1, { url: 'https://forum.example.com/t/forum/one' }), listRow(2, { url: 'https://desk.zoho.com/agent/ticket/2' })])];
    hello(source, { settings: { iframeBrowser: true }, groups }); await flush(); posts = []; sent.length = 0;
    click('#list [data-work-item="2"] .pill.ticket'); await flush();
    // The hub acknowledged 2, but its hello has not arrived. A click on 1 must still ask the hub to return to 1.
    click('#list [data-work-item="1"] .pill.ticket'); await flush();
    expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).toEqual([2, 1]);
    hello(source, { settings: { iframeBrowser: true }, groups, scope: { ...scope, workItemId: 2 } }); await flush();
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([]);
    hello(source, { settings: { iframeBrowser: true }, groups }); await flush();
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([{ type: 'iframe-launch', workItemId: 1, url: 'https://forum.example.com/t/forum/one' }]);
    sent.length = 0; refuse = true;
    click('#list [data-work-item="2"] .pill.ticket'); await flush();
    expect(root.textContent).toContain('That work item is gone.');
    hello(source, { settings: { iframeBrowser: true }, groups, scope: { ...scope, workItemId: 2 } }); await flush();
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([]);
    page.close();
  });

  it('keeps rapid pill and tab clicks embedded while the new work item waits for site rules', async () => {
    const postMessage = vi.fn();
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    onTestFinished(() => { vi.restoreAllMocks(); });
    const sent: Record<string, unknown>[] = [];
    const opened = vi.fn();
    let hold = false;
    let resolve!: (value: unknown) => void;
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 200, ok: true, json: async () => ({}) }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, openUrl: opened,
      toExtension: async (_id, message) => { sent.push(message); return hold && message['type'] === 'iframe-enable' ? new Promise((done) => { resolve = done; }) : { ok: true }; },
    });
    const source = FakeSource.last!;
    const link = { label: 'Forum', url: 'https://forum.example.com/t/forum/topic', kind: 'url' as const, badge: 'Forum', glyph: null, mentioned: false };
    const groups = [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' }), listRow(2, { url: 'https://desk.zoho.com/agent/ticket/2', links: [link] })])];
    hello(source, { settings: { iframeBrowser: true }, groups }); await flush(); sent.length = 0;
    hold = true;
    click('#list [data-work-item="2"] .pill.ticket'); await flush();
    hello(source, { settings: { iframeBrowser: true }, groups, scope: { ...scope, workItemId: 2 } }); await flush();
    click('#list [data-work-item="2"] .pill.link'); await flush();
    expect(sent.filter((message) => !String(message['type']).startsWith('iframe-'))).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
    click('[data-action="iframe-open"][data-url="https://desk.zoho.com/agent/ticket/2"]');
    hold = false; resolve({ ok: true }); await flush();
    expect(root.querySelector('[data-action="iframe-open"][aria-selected="true"]')?.getAttribute('data-url')).toBe('https://desk.zoho.com/agent/ticket/2');
    page.close();
  });

  it('uses the local default browser for Ctrl or Meta pill clicks without selecting or calling the extension, and shows refusals', async () => {
    const sent = vi.fn(async () => ({ ok: true }));
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 409, ok: false, json: async () => ({ error: 'The work item no longer links to this.' }) }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: true, standalone: () => false, toExtension: sent,
    });
    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1), listRow(2, { url: 'https://desk.zoho.com/agent/ticket/2' })])] }); await flush();
    posts = []; sent.mockClear();
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      root.querySelector('#list [data-work-item="2"] .pill.ticket')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifier })); await flush();
    }
    expect(posts.map((post) => post.url)).toEqual(['/v1/conversation/row-open', '/v1/conversation/row-open']);
    expect(posts[0]!.body).toMatchObject({ workItemId: 2, url: 'https://desk.zoho.com/agent/ticket/2' });
    expect(sent).not.toHaveBeenCalled();
    expect(root.querySelector('#list .row.selected')?.getAttribute('data-work-item')).toBe('1');
    expect(root.querySelector('.toast.warning .toast-text')?.textContent).toBe('The work item no longer links to this.');
    page.close();
  });

  it('opens a Ctrl-clicked pill on the remote device without asking the hub or the extension', async () => {
    const opened = vi.fn(), sent = vi.fn(async () => ({ ok: true }));
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 200, ok: true, json: async () => ({}) }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, openUrl: opened, toExtension: sent,
    });
    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1), listRow(2, { url: 'https://forum.example.com/t/2' })])] }); await flush();
    posts = []; sent.mockClear();
    root.querySelector('#list [data-work-item="2"] .pill.ticket')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })); await flush();
    expect(opened).toHaveBeenCalledExactlyOnceWith('https://forum.example.com/t/2');
    expect(posts).toEqual([]); expect(sent).not.toHaveBeenCalled();
    page.close();
  });

  it('EmbeddedTabs_BrowserThatCannotInstallTheExtension_MakesNoBrowserTabsNorAsksForItAndOpensLinksOutside', async () => {
    window.innerWidth = 1920;
    const opened = vi.fn();
    const sent: Record<string, unknown>[] = [];
    // An iPhone's browser, say: no extension answers, and none can be installed.
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 200, ok: true, json: async () => ({}) }; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, standalone: () => false, openUrl: opened,
      extensionInstallable: () => false, toExtension: async (_id, message) => { sent.push(message); return null; },
    });
    const pr = { label: 'PR #7', url: 'https://github.com/o/r/pull/7', kind: 'pr' as const, badge: '7', glyph: null, mentioned: false };

    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1', links: [pr] }), listRow(2, { url: 'https://github.com/o/r/issues/2' })])] }); await flush();
    expect(root.querySelector('[data-action="iframe-open"]')).toBeNull();
    expect(root.querySelector('[data-side="browser"], [data-tab="browser"]')).toBeNull();
    expect(root.textContent).not.toContain('extension');
    // The work item's links open as ordinary links, in a new tab, its own row's and another row's alike.
    posts = [];
    click('#list [data-work-item="1"] .pill.ticket'); await flush();
    click('#list [data-work-item="2"] .pill.ticket'); await flush();
    expect(opened.mock.calls).toEqual([['https://github.com/o/r/issues/1'], ['https://github.com/o/r/issues/2']]);
    expect(sent.filter((message) => message['type'] === 'iframe-launch')).toEqual([]);
    expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
    page.close();
  });

  it('EmbeddedTabs_DesktopChromiumWithoutTheExtension_SelectsTheLinkTabAndOffersABrowserTabAndTheExtension', async () => {
    window.innerWidth = 1920;
    const opened = vi.fn();
    const page = startPage(root, {
      fetch: (async () => ({ status: 200, ok: true, json: async () => ({}) })) as unknown as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, standalone: () => false, openUrl: opened,
      extensionInstallable: () => true, toExtension: async () => null,
    });
    const issue = 'https://github.com/o/r/issues/1';
    const pr = { label: 'PR #7', url: 'https://github.com/o/r/pull/7', kind: 'pr' as const, badge: '7', glyph: null, mentioned: false };
    const selected = (): string | null | undefined => root.querySelector('#detail [data-action="iframe-open"][aria-selected="true"]')?.getAttribute('data-url');
    const button = (label: string): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>('#detail .detail-body button')].find((one) => one.textContent === label);

    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: issue, links: [pr] })])] }); await flush();
    // The tab chosen selects, not the first one.
    click(`#detail [data-action="iframe-open"][data-url="${pr.url}"]`); await flush();
    expect(selected()).toBe(pr.url);
    expect(root.querySelector('#detail')!.textContent).toContain('Install the Switchboard browser extension in this browser, then select Retry.');
    expect(button('Retry')).not.toBeUndefined();
    button('Open in a browser tab')!.click();
    expect(opened.mock.calls).toEqual([[pr.url]]);
    button('Get the browser extension')!.click(); await flush();
    expect(root.querySelector('#list-sheet .sheet')?.textContent).toContain('Get the browser extension');
    expect(root.querySelector('#list-sheet a[download]')?.getAttribute('href')).toBe('/page/switchboard-extension.zip');
    click('#list-sheet [data-action="list-sheet-cancel"]'); await flush();
    click(`#detail [data-action="iframe-open"][data-url="${issue}"]`); await flush();
    expect(selected()).toBe(issue);
    button('Open in a browser tab')!.click();
    expect(opened.mock.calls.at(-1)).toEqual([issue]);
    // Closing the link tab shown shows the one after it, with none before it; closing the last one, not shown, keeps the tab shown.
    click(`#detail [data-action="iframe-close"][data-url="${issue}"]`);
    expect(selected()).toBe(pr.url);
    click('#detail .artifact-tab[data-path="chat/p.html"] .tab-open');
    click(`#detail [data-action="iframe-close"][data-url="${pr.url}"]`);
    expect(root.querySelector('#detail .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/p.html');
    expect(root.querySelector('#detail .link-tab')).toBeNull();
    page.close();
  });

  it('EmbeddedTabs_ExtensionAnswersWhereItCouldNotBeTold_ShowsTheLinkTabs', async () => {
    window.innerWidth = 1920;
    const page = startPage(root, {
      fetch: (async () => ({ status: 200, ok: true, json: async () => ({}) })) as unknown as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, standalone: () => false,
      extensionInstallable: () => false, toExtension: async () => ({ ok: true }),
    });

    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' })])] }); await flush();
    expect(root.querySelector('#detail [data-action="iframe-open"]')?.getAttribute('data-url')).toBe('https://github.com/o/r/issues/1');
    page.close();
  });

  it('shows the experimental GitHub frame on a remote page only after extension confirmation and removes it when disabled', async () => {
    window.innerWidth = 1920;
    const sent: unknown[] = [];
    let resolve!: (reply: unknown) => void;
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { posts.push({ url, body: init?.body ? JSON.parse(init.body) : {} }); return { status: 200, ok: true, json: async () => ({}) } as Response; }) as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false, standalone: () => false, extensionInstallable: () => true,
      toExtension: async (_id, message) => { sent.push(message); return message['type'] === 'iframe-check' ? new Promise((done) => { resolve = done; }) : { ok: true }; },
    });
    const source = FakeSource.last!;
    hello(source, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' })])] });
    expect(root.querySelector('[data-action="iframe-open"]')).not.toBeNull();
    click('#detail [data-action="iframe-open"]');
    expect(root.querySelector('iframe[title="GitHub browser experiment"]')).toBeNull();
    resolve({ ok: true }); await flush();
    const frame = root.querySelector<HTMLIFrameElement>('iframe[title="GitHub browser experiment"]')!;
    expect(root.textContent).toContain('Open with sign-in support');
    // With the extension, the pane offers neither a browser tab nor the extension.
    expect(root.querySelector('.iframe-actions')).toBeNull();
    expect(root.textContent).not.toContain('Get the browser extension');
    source.emit('reply', { reply: reply('r9', 9) }); expect(root.querySelector('iframe[title="GitHub browser experiment"]')).toBe(frame);
    click('[data-action="artifact"][data-path="chat/p.html"]');
    expect(root.querySelector('#detail .detail-body')!.classList.contains('framed')).toBe(true);
    click('#detail [data-action="iframe-open"]');
    expect(root.querySelector('#detail .detail-body')!.classList.contains('framed')).toBe(false);
    expect(posts.filter((post) => post.url.endsWith('/pane-pair') || post.url.endsWith('/pane-rect'))).toEqual([]);
    source.emit('settings', { settings: { iframeBrowser: false } });
    expect(root.querySelector('iframe[title="GitHub browser experiment"]')).toBeNull(); expect(sent.at(-1)).toEqual({ type: 'iframe-disable' });
    page.close();
  });


  it('accepts a host link handoff only from its extension parent and opens the requested link tab', async () => {
    const postMessage = vi.fn();
    const parentWindow = { postMessage } as unknown as Window;
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parentWindow);
    onTestFinished(() => { vi.restoreAllMocks(); });
    window.innerWidth = 1920;
    const focusPosts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const page = startPage(root, {
      fetch: (async (url: string, init?: { body?: string }) => { focusPosts.push({ url, body: init?.body === undefined ? {} : JSON.parse(init.body) }); return { status: 200, ok: true, json: async () => ({}) }; }) as unknown as typeof globalThis.fetch,
      EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000,
      toExtension: async () => ({ ok: true }),
    });
    hello(FakeSource.last!, { settings: { iframeBrowser: true }, groups: [listGroup('progress', [listRow(1, { url: 'https://github.com/o/r/issues/1' })])] });
    await flush();
    const url = 'https://github.com/o/r/pull/99';
    const data = { type: 'switchboard-iframe-select', workItemId: 1, url };
    window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin: 'https://evil.test', data }));
    expect(root.querySelector(`[data-action="iframe-open"][data-url="${url}"]`)).toBeNull();
    window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin: 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije', data }));
    expect(root.querySelector(`[data-action="iframe-open"][data-url="${url}"]`)?.getAttribute('aria-selected')).toBe('true');
    expect(postMessage.mock.calls.some(([message]) => message.url === url)).toBe(true);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    const focus = () => focusPosts.filter((post) => post.url.endsWith('/page-focus')).at(-1)?.body['focused'];
    expect(focus()).toBe(false);
    window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin: 'https://github.com', data: { type: 'switchboard-iframe-focus', focused: true } }));
    expect(focus()).toBe(false);
    window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin: 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije', data: { type: 'switchboard-iframe-focus', focused: true } }));
    expect(focus()).toBe(true);
    window.dispatchEvent(new MessageEvent('message', { source: parentWindow, origin: 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije', data: { type: 'switchboard-iframe-focus', focused: false } }));
    expect(focus()).toBe(false);
    page.close();
  });

});
