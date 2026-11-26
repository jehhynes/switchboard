import { afterEach, onTestFinished, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeline } from '../src/model.js';
import { DICTATION_GRACE_MS, SENT_NOTE_MS, startPage } from '../src/main.js';
import { drawAtOnce } from './frame.js';
import { message, reply, session, scope, listRow, listGroup, artifact, resizeTo, FakeSource } from './pageFixtures.js';

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


  it('redraws by changing only what differs, keeping the focus on a list row and the conversation at its end until the operator scrolls away', () => {
    const { page, source } = start();
    const panel = root.querySelector<HTMLElement>('#panel')!;
    const sized = (height: number) => {
      Object.defineProperty(panel, 'scrollHeight', { value: height, configurable: true });
      Object.defineProperty(panel, 'clientHeight', { value: 100, configurable: true });
    };
    const groups = [listGroup('progress', [listRow(1, { title: 'Fix it' })])];

    source.emit('hello', { key: 'pk', groups, scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [] });

    const row = root.querySelector<HTMLElement>('.row')!;

    row.focus();
    sized(300);
    source.emit('reply', { reply: reply('r2', 2) });
    expect(root.querySelector('.row')).toBe(row);
    expect(document.activeElement).toBe(row);
    expect(panel.scrollTop).toBe(300);
    // Scrolled up by the operator, the conversation stays where it is.
    panel.scrollTop = 50;
    panel.dispatchEvent(new Event('scroll'));
    sized(500);
    source.emit('reply', { reply: reply('r3', 3) });
    expect(panel.scrollTop).toBe(50);
    page.close();
  });

  it('draws a burst of events once, at the next frame, and a frame a draw since makes unneeded draws nothing', () => {
    const frames: Array<() => void> = [];
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: (run) => void frames.push(run), now: () => 10_000 });
    const source = FakeSource.last!;
    const replies = () => root.querySelectorAll('#panel .reply').length;

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });

    // A long history read arrives as one event per reply; none draws until the frame, which draws them all once.
    for (let index = 1; index <= 200; index++) {
      source.emit('reply', { reply: reply(`r${index}`, index) });
    }

    expect(frames).toHaveLength(1);
    expect(replies()).toBe(0);
    frames.shift()!();
    expect(replies()).toBe(200);

    // A draw before the frame, as a click's, leaves the frame nothing to draw.
    source.emit('reply', { reply: reply('r201', 201) });
    expect(frames).toHaveLength(1);
    root.querySelector<HTMLElement>('.row')!.click();
    expect(replies()).toBe(201);
    root.querySelector('#panel')!.replaceChildren();
    frames.shift()!();
    expect(replies()).toBe(0);
    // Nor does a frame asked for before the page closed.
    source.emit('reply', { reply: reply('r202', 202) });
    page.close();
    frames.shift()!();
    expect(replies()).toBe(0);
  });

  it('brings the conversation to its end on a send, wherever the operator had scrolled, and follows the turn row and the reply after it', async () => {
    const { page, source } = start();
    const panel = root.querySelector<HTMLElement>('#panel')!;
    const input = root.querySelector<HTMLTextAreaElement>('#composer textarea')!;
    const sized = (height: number) => {
      Object.defineProperty(panel, 'scrollHeight', { value: height, configurable: true });
      Object.defineProperty(panel, 'clientHeight', { value: 100, configurable: true });
    };

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [] });
    sized(500);
    panel.scrollTop = 50;
    panel.dispatchEvent(new Event('scroll'));
    input.value = 'Next?';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(panel.scrollTop).toBe(500);
    // Scrolled away while the send is on its way, the conversation stays where the operator put it until the next send.
    panel.scrollTop = 200;
    panel.dispatchEvent(new Event('scroll'));
    await flush();
    await flush();
    expect(posts.some((post) => post.url.endsWith('/send'))).toBe(true);
    expect(panel.scrollTop).toBe(200);
    input.value = 'And then?';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(panel.scrollTop).toBe(500);
    await flush();
    await flush();
    // The sent message, then the reply, grow the conversation; it stays at its end.
    sized(700);
    source.emit('message', { message: message('m1', 2, { text: 'Next?' }) });
    expect(panel.scrollTop).toBe(700);
    sized(900);
    source.emit('reply', { reply: reply('r2', 3) });
    expect(panel.scrollTop).toBe(900);
    page.close();
  });

  it('keeps the composer\'s box across tabs, says Sent in the toast after a send that ends off the Conversation tab, shows it for files dropped there, and shows an ended session\'s reason above the composer', async () => {
    const { page, source } = start();
    const composer = root.querySelector<HTMLElement>('#composer')!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-tab="history"]')!.click();
    expect(composer.hidden).toBe(false);

    const input = composer.querySelector('textarea')!;

    input.value = 'From the status';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    await flush();
    expect(posts.some((post) => post.url.endsWith('/send') && post.body['text'] === 'From the status')).toBe(true);
    expect(root.querySelector('.tab.selected')?.getAttribute('data-tab')).toBe('history');
    // The folded tabs hide the composer off the Conversation tab, so the toast says it went, not the composer's own line.
    expect(root.classList.contains('off-conversation')).toBe(true);
    expect(composer.querySelector<HTMLElement>('.composer-sent')!.hidden).toBe(true);
    expect(root.querySelector('.toast.info .toast-text')?.textContent).toBe('Sent. Its reply shows on the Conversation tab.');
    expect(SENT_NOTE_MS).toBe(4_000);

    // Files dropped on another tab show the Conversation tab, where the composer shows their chips.
    const dropped = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropped, 'dataTransfer', { value: { types: ['Files'], files: [new File(['d'], 'report.pdf', { type: 'application/pdf' })] } });
    root.querySelector('#panel')!.dispatchEvent(dropped);
    expect(dropped.defaultPrevented).toBe(true);
    expect(root.querySelector('.tab.selected')?.getAttribute('data-tab')).toBe('conversation');
    expect(root.classList.contains('off-conversation')).toBe(false);

    source.emit('session', { session: session({ state: 'ended', conversation: 'read-only', reason: 'The session has ended. Open it in the terminal to resume it.' }) });
    expect(root.querySelector('#note .session-note-text')?.textContent).toBe('The session has ended. Resume it to send a message.');
    expect(input.placeholder).toBe('Resume the session to send a message.');
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    expect(root.querySelector('#panel .notice')).toBeNull();

    // Resume runs the hub's resume for the session shown; a refusal shows over the composer.
    posts = [];
    root.querySelector<HTMLElement>('#note [data-action="resume"]')!.click();
    expect(root.querySelector<HTMLButtonElement>('#note [data-action="resume"]')!.disabled).toBe(true);
    await flush();
    expect(posts.find((post) => post.url.endsWith('/resume'))?.body).toMatchObject({ window: 'pk', scopeGen: 3, sessionId: 's' });
    expect(root.querySelector<HTMLButtonElement>('#note [data-action="resume"]')!.disabled).toBe(false);

    // A background session the page cannot talk to has only its reason.
    source.emit('session', { session: session({ state: 'ended', conversation: 'none', reason: 'Open it in Claude to talk to it.' }) });
    expect(root.querySelector('#note .session-note-text')?.textContent).toBe('Open it in Claude to talk to it.');
    expect(root.querySelector('#note [data-action="resume"]')).toBeNull();
    page.close();
  });

  it('marks #root.off-conversation while the tabs show another tab, which hides the composer, keeping the draft and dropping its focus, and never in the wide layout', () => {
    window.innerWidth = 700;

    const { page, source } = start();
    const composer = root.querySelector<HTMLElement>('#composer')!;
    const input = composer.querySelector('textarea')!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [] });
    expect(root.classList.contains('wide')).toBe(false);
    expect(root.classList.contains('off-conversation')).toBe(false);
    input.value = 'Half a thought';
    input.dispatchEvent(new Event('input'));
    input.focus();
    root.querySelector<HTMLElement>('[data-tab="history"]')!.click();
    expect(root.classList.contains('off-conversation')).toBe(true);
    // Hidden by the stylesheet only, so the box and its text stay; the hidden box gives up the focus.
    expect(composer.hidden).toBe(false);
    expect(document.activeElement).not.toBe(input);
    expect(root.querySelector('#composer textarea')).toBe(input);
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    expect(root.classList.contains('off-conversation')).toBe(false);
    expect(input.value).toBe('Half a thought');

    // In the wide layout the conversation's pane always shows the conversation, whatever the column shows.
    root.querySelector<HTMLElement>('[data-tab="history"]')!.click();
    expect(root.classList.contains('off-conversation')).toBe(true);
    resizeTo(1920);
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.classList.contains('off-conversation')).toBe(false);
    resizeTo(1024);
    page.close();
  });

  it('shows the composer on every tab while the mic is on for the session shown, hiding it at once after its own Mic off and after a grace otherwise', () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    window.innerWidth = 700;

    const { page, source } = start();
    const composer = root.querySelector<HTMLElement>('#composer')!;
    const input = composer.querySelector('textarea')!;
    const voice = (mic: string, patch: Record<string, unknown> = {}) => ({ voice: { enabled: true, here: true, mic, speaking: null, speakReplies: false, error: null, ...patch } });
    const offTab = () => root.classList.contains('off-conversation');

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [], ...voice('off') });
    root.querySelector<HTMLElement>('[data-tab="history"]')!.click();
    expect(offTab()).toBe(true);
    expect(root.classList.contains('dictating')).toBe(false);

    // Every state in which the mic is on keeps the composer under the History tab, the mic button in it, and lets its box keep the focus.
    for (const mic of ['listening', 'hearing', 'typing', 'paused-other-app', 'paused-by-voice', 'unavailable', 'starting']) {
      source.emit('voice', voice(mic));
      expect([mic, offTab(), root.classList.contains('dictating')]).toEqual([mic, false, true]);
    }
    expect(composer.querySelector('button[data-voice="mic"]')).not.toBeNull();
    input.focus();
    source.emit('voice', voice('typing'));
    expect(document.activeElement).toBe(input);

    // Mic off from its own button hides it as soon as the voice says the mic is off.
    source.emit('voice', voice('listening'));
    composer.querySelector<HTMLElement>('button[data-voice="mic"]')!.click();
    expect(offTab()).toBe(false);
    source.emit('voice', voice('off'));
    expect(offTab()).toBe(true);
    expect(document.activeElement).not.toBe(input);

    // The mic going off by other means, as the idle timeout, keeps it DICTATION_GRACE_MS, and the mic on again meanwhile keeps it for good.
    source.emit('voice', voice('listening'));
    source.emit('voice', voice('idle-off'));
    expect(offTab()).toBe(false);
    vi.advanceTimersByTime(DICTATION_GRACE_MS - 1);
    source.emit('voice', voice('hearing'));
    vi.advanceTimersByTime(DICTATION_GRACE_MS);
    expect(offTab()).toBe(false);
    source.emit('voice', voice('off'));
    vi.advanceTimersByTime(DICTATION_GRACE_MS - 1);
    expect(offTab()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(offTab()).toBe(true);
    expect(root.classList.contains('dictating')).toBe(false);

    // The voice in another window, or a session the page cannot talk to, is no mic on for this page.
    source.emit('voice', voice('listening', { here: false }));
    expect(offTab()).toBe(true);
    source.emit('voice', voice('listening'));
    expect(offTab()).toBe(false);
    source.emit('session', { session: session({ state: 'ended', conversation: 'read-only', reason: 'Ended.' }) });
    vi.advanceTimersByTime(DICTATION_GRACE_MS);
    expect(offTab()).toBe(true);

    // On the Conversation tab nothing changes, and the wide layout keeps the composer with the conversation, marking the mic for the maximized column.
    source.emit('session', { session: session() });
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    expect(offTab()).toBe(false);
    resizeTo(1920);
    expect(root.classList.contains('wide')).toBe(true);
    expect(root.classList.contains('dictating')).toBe(true);
    resizeTo(1024);
    page.close();
  });

  it('keeps the grace after a refused Mic off, and counts a Mic on still starting only for the work item it was tapped in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    window.innerWidth = 700;

    const fetch = vi.fn(async (url: string) =>
      (url.endsWith('/mic') ? { status: 409, ok: false, json: async () => ({ error: 'The mic did not change.' }), text: async () => '' } : { status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response,
    );
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;
    const voice = (mic: string) => ({ voice: { enabled: true, here: true, mic, speaking: null, speakReplies: false, error: null } });
    const offTab = () => root.classList.contains('off-conversation');
    const mic = () => root.querySelector<HTMLElement>('#composer button[data-voice="mic"]')!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [], ...voice('listening') });
    root.querySelector<HTMLElement>('[data-tab="history"]')!.click();
    expect(offTab()).toBe(false);

    // The hub refuses Mic off, so the mic stays on; the inactivity timeout later turns it off, and the grace still applies.
    mic().click();
    await flush();
    await flush();
    expect(root.querySelector('.toast.warning .toast-text')?.textContent).toBe('The mic did not change.');
    source.emit('voice', voice('idle-off'));
    expect(offTab()).toBe(false);
    vi.advanceTimersByTime(DICTATION_GRACE_MS);
    expect(offTab()).toBe(true);

    // A Mic on tap still starting shows the composer under History; another work item, whose mic is off, does not inherit it.
    mic().click();
    expect(offTab()).toBe(false);
    expect(root.classList.contains('dictating')).toBe(true);
    source.emit('hello', { key: 'pk', groups: [], scope: { ...scope, scopeGen: 4, workItemId: 2, conversations: [{ ...scope.conversations[0]!, workItemId: 2 }] }, sessions: [session()], items: [], more: false, state: null, artifacts: [], ...voice('off') });
    expect(root.classList.contains('dictating')).toBe(false);
    page.close();
  });

  it('opens the persona dialog from the view options menu, keeps it open over stream events, and pins the one picked', async () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return {
        status: 200,
        ok: true,
        json: async () => (url.endsWith('/personas') ? { personas: [{ id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm and brief.' }, { id: 'iris', name: 'Iris', voice: 'marin', style: 'none', personality: '' }] } : {}),
        text: async () => '',
      } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: { id: 'nova', name: 'Nova', pinned: true, tonePending: false } })], items: [], more: false, state: null, artifacts: [] });
    // The header has no persona button of its own any more.
    expect(root.querySelector('button.persona, .persona-anchor')).toBeNull();
    root.querySelector<HTMLElement>('button.view-options')!.click();

    const row = root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!;

    expect(row.querySelector('.title')?.textContent).toBe('Persona: Nova');
    expect(row.querySelector('.menu-note')?.textContent).toBe('Pinned');
    expect(row.querySelector('.codicon-pinned')).not.toBeNull();
    expect(row.getAttribute('aria-haspopup')).toBe('dialog');
    row.click();
    // The menu closes, the dialog opens with the rest of the page inert, and Close has the focus while the roster loads.
    expect(root.querySelector('.view-options-menu')).toBeNull();

    const dialog = root.querySelector<HTMLElement>('.persona-dialog[role="dialog"]')!;

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('.persona-body')?.textContent).toBe('Loading…');
    expect(document.activeElement?.classList.contains('persona-close')).toBe(true);
    expect(root.querySelector('#head')?.closest('[inert]')).not.toBeNull();
    expect(root.querySelector('#panel')?.closest('[inert]')).not.toBeNull();
    expect(dialog.closest('[inert]')).toBeNull();
    // The toast stays live over it: a failure is read out and Dismiss works.
    expect(root.querySelector('#toast')?.closest('[inert]')).toBeNull();
    await flush();
    await flush();
    source.emit('reply', { reply: reply('r1', 1) });

    const options = [...root.querySelectorAll<HTMLElement>('.persona-option')];

    expect(options.map((one) => [one.querySelector('.persona-name')?.textContent, one.getAttribute('aria-current')])).toEqual([
      ['NovaCurrent, pinned', 'true'],
      ['Iris', null],
    ]);
    expect(options[0]!.textContent).toContain('Voice Cedar · Style Pair');
    expect(options[0]!.querySelector('.persona-personality')?.textContent).toBe('Warm and brief.');
    expect(options[1]!.textContent).toContain('No personality');
    // The current persona takes the focus from Close once the roster shows.
    expect(document.activeElement).toBe(options[0]);
    expect(root.querySelector('.persona-bar [data-persona=""]')?.textContent).toBe('Clear pin');
    root.querySelector<HTMLElement>('.persona-option[data-persona="iris"]')!.click();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/persona'))?.body).toMatchObject({ sessionId: 's', personaId: 'iris' });
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    expect(root.querySelector('#head')?.closest('[inert]')).toBeNull();
    expect(document.activeElement?.classList.contains('view-options')).toBe(true);
    page.close();
  });

  it('clears a pin from the persona dialog, and closes it on Escape, on Close and on its backdrop but not on a press inside it', async () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return { status: 200, ok: true, json: async () => (url.endsWith('/personas') ? { personas: [{ id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: '' }] } : {}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;
    const open = async (): Promise<void> => {
      root.querySelector<HTMLElement>('button.view-options')!.click();
      root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!.click();
      await flush();
      await flush();
    };

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: { id: 'nova', name: 'Nova', pinned: true, tonePending: true } })], items: [], more: false, state: null, artifacts: [] });
    await open();
    expect(root.querySelector('.persona-body .persona-note')?.textContent).toBe("The session takes Nova's tone when it next resumes.");
    root.querySelector<HTMLElement>('.persona-body')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('.persona-backdrop')).not.toBeNull();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    expect(document.activeElement?.classList.contains('view-options')).toBe(true);
    await open();
    root.querySelector<HTMLElement>('.persona-close')!.click();
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    await open();
    root.querySelector<HTMLElement>('.persona-backdrop')!.click();
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    await open();
    root.querySelector<HTMLElement>('.persona-bar [data-persona=""]')!.click();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/persona'))?.body).toMatchObject({ sessionId: 's', personaId: null });
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    page.close();
  });

  it('names the persona the session has, pinned or not, or None, offering it only when it can take a pin, and pins from the dialog', async () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return { status: 200, ok: true, json: async () => (url.endsWith('/personas') ? { personas: [{ id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: '' }] } : {}), text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: false })], items: [], more: false, state: null, artifacts: [] });
    root.querySelector<HTMLElement>('button.view-options')!.click();
    expect(root.querySelector('.view-options-menu')).not.toBeNull();
    expect(root.querySelector('.view-options-menu [data-action="persona"]')).toBeNull();
    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: true })], items: [], more: false, state: null, artifacts: [] });

    const row = root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!;

    expect(row.querySelector('.title')?.textContent).toBe('Persona: None');
    expect(row.querySelector('.menu-note')).toBeNull();
    // A persona resolved at the start, from the playbook or the pool, is named with no pin.
    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: { id: 'iris', name: 'Iris', pinned: false, tonePending: false }, canPin: true })], items: [], more: false, state: null, artifacts: [] });
    expect(root.querySelector('.view-options-menu [data-action="persona"] .title')?.textContent).toBe('Persona: Iris');
    expect(root.querySelector('.view-options-menu [data-action="persona"] .menu-note')).toBeNull();
    expect(root.querySelector('.view-options-menu [data-action="persona"] .codicon-person')).not.toBeNull();
    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: true })], items: [], more: false, state: null, artifacts: [] });
    expect(row.title).toBe('No persona. Choose one for this session.');
    expect(row.querySelector('.codicon-person')).not.toBeNull();
    row.click();
    await flush();
    await flush();
    expect([...root.querySelectorAll('.persona-option')].map((one) => one.getAttribute('aria-current'))).toEqual([null]);
    expect(root.querySelector('.persona-bar')).toBeNull();
    root.querySelector<HTMLElement>('.persona-option[data-persona="nova"]')!.click();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/persona'))?.body).toMatchObject({ sessionId: 's', personaId: 'nova' });
    page.close();
  });

  it('closes the persona dialog when another conversation replaces it, and drops a roster answer for an earlier opening', async () => {
    const answers: Array<(value: Response) => void> = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      return url.endsWith('/personas') ? new Promise<Response>((resolve) => answers.push(resolve)) : ({ status: 200, ok: true, json: async () => ({}), text: async () => '' } as unknown as Response);
    });
    const roster = (name: string): Response => ({ status: 200, ok: true, json: async () => ({ personas: [{ id: name.toLowerCase(), name, voice: 'cedar', style: 'pair', personality: '' }] }), text: async () => '' }) as unknown as Response;
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;
    const open = (): void => {
      root.querySelector<HTMLElement>('button.view-options')!.click();
      root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!.click();
    };

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: true })], items: [], more: false, state: null, artifacts: [] });
    open();
    root.querySelector<HTMLElement>('.persona-close')!.click();
    open();
    answers[0]!(roster('Old'));
    await flush();
    await flush();
    expect(root.querySelector('.persona-body')?.textContent).toBe('Loading…');
    answers[1]!(roster('Nova'));
    await flush();
    await flush();
    expect([...root.querySelectorAll('.persona-option')].map((one) => one.getAttribute('data-persona'))).toEqual(['nova']);
    // Another conversation replaces the one the dialog opened for, so no pick can pin its session.
    source.emit('scope', { scope: { ...scope, scopeGen: scope.scopeGen + 1 } });
    expect(root.querySelector('.persona-backdrop')).toBeNull();
    expect(root.querySelector('#head')?.closest('[inert]')).toBeNull();
    expect(posts.some((post) => post.url.endsWith('/persona'))).toBe(false);
    page.close();
  });

  it("shows why the persona dialog has no roster", async () => {
    const fetch = vi.fn(async (url: string) => ({ status: 200, ok: true, json: async () => (url.endsWith('/personas') ? { personas: [] } : {}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const source = FakeSource.last!;

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: null, canPin: true })], items: [], more: false, state: null, artifacts: [] });
    root.querySelector<HTMLElement>('button.view-options')!.click();
    root.querySelector<HTMLElement>('.view-options-menu [data-action="persona"]')!.click();
    await flush();
    await flush();
    expect(root.querySelector('.persona-message')?.textContent).toBe('No personas. Add them to voice.personas in settings.json, with voice.enabled on.');
    expect(root.querySelector('.persona-option')).toBeNull();
    page.close();
  });

  it('brings the conversation back where the operator left it after the Status tab', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [] });

    const panel = root.querySelector<HTMLElement>('#panel')!;

    Object.defineProperties(panel, { scrollHeight: { value: 500, configurable: true }, clientHeight: { value: 100, configurable: true } });
    panel.scrollTop = 50;
    panel.dispatchEvent(new Event('scroll'));
    root.querySelector<HTMLElement>('[data-tab="history"]')!.click();
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    expect(panel.scrollTop).toBe(50);
    // And after an artifact opened from its row.
    source.emit('artifact', { artifact: { path: 'chat/a.md', owner: 'chat', kind: 'plan', title: 'Plan', ext: 'md', type: 'markdown', updatedAt: 1_500 } });
    root.querySelector<HTMLElement>('#panel [data-action="artifact"]')!.click();
    // The artifact opens in its own tab, chosen.
    expect(root.querySelector('.tab.selected')?.getAttribute('data-path')).toBe('chat/a.md');
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    expect(panel.scrollTop).toBe(50);
    page.close();
  });

  it('keeps each voice control its own button, so a focused speaker never turns into Talk here', () => {
    const { page, source } = start();
    const voice = { enabled: true, here: true, mic: 'off', speaking: 'r1', speakReplies: true, error: null, recognizer: null };

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [], voice });

    const speaker = root.querySelector<HTMLElement>('[data-voice="speak-replies"]')!;

    speaker.focus();
    source.emit('voice', { voice: { ...voice, here: false, speaking: null } });
    expect(speaker.isConnected).toBe(false);
    expect(root.querySelector('[data-voice="talk-here"]')).not.toBe(speaker);
    page.close();
  });

  it('keeps the focus on a voice control over an unrelated stream event, and opens one header menu at a time', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session({ persona: { id: 'p', name: 'P', pinned: false, tonePending: false } })], items: [], more: false, state: null, artifacts: [], voice: { enabled: true, here: true, mic: 'off', speaking: null, speakReplies: true, error: null, recognizer: null } });

    const control = root.querySelector<HTMLElement>('.voice-controls button')!;

    control.focus();
    source.emit('unread', { workItemId: 1, count: 1 });
    expect(document.activeElement).toBe(control);
    root.querySelector<HTMLElement>('button.view-options')!.click();
    root.querySelector<HTMLElement>('button.picker')!.click();
    expect(root.querySelectorAll('.conversation-menu')).toHaveLength(1);
    expect(root.querySelector('.view-options-menu')).toBeNull();
    page.close();
  });

  it('closes the conversation dropdown on a press outside the header and on Escape', () => {
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [], scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts: [] });
    root.querySelector<HTMLElement>('button.picker')!.click();
    expect(root.querySelector('.conversation-menu')).not.toBeNull();
    root.querySelector('.conversation-menu')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.conversation-menu')).not.toBeNull();
    root.querySelector('.timeline')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.conversation-menu')).toBeNull();
    root.querySelector<HTMLElement>('button.picker')!.click();
    root.querySelector<HTMLElement>('button.picker')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.conversation-menu')).toBeNull();
    page.close();
  });

  it('opens its page stream, selects the work item its address names, and reports its focus', async () => {
    const { page, source } = start();

    expect(source.url).toBe('/v1/conversation/events?page=1');
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    await flush();
    expect(posts.map((post) => [post.url, post.body['window']])).toEqual(expect.arrayContaining([['/v1/conversation/page-focus', 'pk'], ['/v1/conversation/select', 'pk']]));
    expect(posts.find((post) => post.url.endsWith('/select'))?.body['workItemId']).toBe(1);
    expect(root.querySelector('#list')!.textContent).toContain('Fix it');
    page.close();
    expect(source.closed).toBe(true);
  });

  it('shows the list as its own view on a narrow screen until a row is opened, and Back returns to it on the selected row', async () => {
    history.replaceState(null, '', '#');

    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1), listRow(2)])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    expect(root.classList.contains('listing')).toBe(true);
    // With no work item open, the pane says so in words that hold on a phone, where the list is its own view.
    expect(root.querySelector('#panel .empty')?.textContent).toBe('No work item open. Choose one in the list to see its conversation.');
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    expect(root.classList.contains('listing')).toBe(false);
    expect(location.hash).toBe('#w=1');
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1), listRow(2)])], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    expect(root.classList.contains('listing')).toBe(false);

    // Back is the header's first button, which CSS hides outside the phone's layout; the Work items button after it shows only where the list is a drawer.
    const back = root.querySelector<HTMLElement>('.header > button.back-toggle')!;

    expect(back.getAttribute('aria-label')).toBe('Back to work items');
    expect(back.previousElementSibling).toBeNull();
    expect(back.nextElementSibling!.classList.contains('list-toggle')).toBe(true);
    expect(root.querySelector('.back-bar')).toBeNull();
    back.click();
    expect(root.classList.contains('listing')).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('[data-work-item="1"]'));
    // The selection stays while the list shows; opening another row leaves the list.
    expect(root.querySelector('[data-work-item="1"]')!.classList.contains('selected')).toBe(true);
    root.querySelector<HTMLElement>('[data-work-item="2"]')!.click();
    expect(root.classList.contains('listing')).toBe(false);
    page.close();
  });

  it('turns the mic off when a phone\'s width leaves the conversation for the list, and not on a wide page or with the mic off (PRD R119)', async () => {
    history.replaceState(null, '', '#');

    const width = window.innerWidth;
    const voice = (mic: string) => ({ voice: { enabled: true, here: true, mic, speaking: 'r1', speakReplies: true, error: null } });
    const mics = () => posts.filter((post) => post.url.endsWith('/mic')).map((post) => post.body['on']);
    const { page, source } = start();
    const open = async (): Promise<void> => {
      root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
      await flush();
      source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    };

    window.innerWidth = 375;
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    await open();
    source.emit('voice', voice('listening'));
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    expect(mics()).toEqual([false]);
    // Speech goes on: no Stop is sent.
    expect(posts.some((post) => post.url.endsWith('/stop-speaking'))).toBe(false);

    // With the mic already off, Back sends nothing.
    await open();
    source.emit('voice', voice('off'));
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    expect(mics()).toEqual([false]);

    // A wide page keeps the conversation beside the list: nothing is left.
    window.innerWidth = 1440;
    await open();
    source.emit('voice', voice('listening'));
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    expect(mics()).toEqual([false]);
    page.close();

    // A paired device's page, which holds a phone's microphone, does the same, once.
    window.innerWidth = 375;
    posts.length = 0;
    root = document.createElement('div');
    document.body.replaceChildren(root);

    let holdMic: Promise<void> | null = null;
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      if (url.endsWith('/mic') && holdMic !== null) {
        await holdMic;
      }

      return { status: 200, ok: true, json: async () => (url.endsWith('/page-voice-ticket') ? { ticket: 't1' } : {}), text: async () => '' } as unknown as Response;
    });
    const paired = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false });
    const phone = FakeSource.last!;

    history.replaceState(null, '', '#');
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    phone.emit('voice', voice('listening'));
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    expect(mics()).toEqual([false]);

    // A Mic on still opening when Back is tapped is not turned on afterwards: the phone's audio and socket never answer here.
    const sockets: Array<{ onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null }> = [];

    vi.stubGlobal('AudioContext', class {
      state = 'running';
      destination = {};
      onstatechange = null;
      audioWorklet = { addModule: async () => undefined };
      resume = async () => undefined;
      close = async () => undefined;
      createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
    });
    vi.stubGlobal('AudioWorkletNode', class {
      port = { postMessage: () => undefined, onmessage: null };
      connect(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal('WebSocket', class {
      binaryType = 'blob';
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      send(): void {}
      close(): void {}
    });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getAudioTracks: () => [{ muted: false, readyState: 'live', stop: () => undefined }] }) } });
    onTestFinished(() => void Reflect.deleteProperty(navigator, 'mediaDevices'));
    onTestFinished(() => void vi.unstubAllGlobals());
    posts.length = 0;
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    phone.emit('voice', voice('off'));
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    // Starting from the tap, while the voice socket and the microphone open.
    expect(root.querySelector('.composer-mic .mic.starting')?.getAttribute('aria-busy')).toBe('true');
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    // The socket is welcomed only after Back.
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'welcome', at: 0 }) });
    await flush();
    await flush();
    expect(sockets).toHaveLength(1);
    expect(mics().filter((on) => on === true)).toEqual([]);

    // Back while the hub has not answered Mic on yet: the page sends Mic off after that answer.
    let answerMic!: () => void;

    holdMic = new Promise((resolve) => (answerMic = resolve));
    posts.length = 0;
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    phone.emit('voice', voice('off'));
    // The voice is already on this phone, its socket welcomed.
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    await flush();
    await flush();
    expect(sockets).toHaveLength(1);
    expect(mics()).toEqual([true]);
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    holdMic = null;

    const before = mics().length;

    answerMic();
    await flush();
    await flush();
    // Sent after the hub answered Mic on, so it cannot arrive first and leave the mic on.
    expect(mics().slice(before)).toEqual([false]);

    // Back, then the conversation again and Mic on, while the first Mic on is still unanswered: its late answer leaves the new mic alone.
    let answerFirst!: () => void;

    holdMic = new Promise((resolve) => (answerFirst = resolve));
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    phone.emit('voice', voice('off'));
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    await flush();
    await flush();
    root.querySelector<HTMLElement>('.header > button.back-toggle')!.click();
    await flush();
    root.querySelector<HTMLElement>('[data-work-item="1"]')!.click();
    await flush();
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    phone.emit('voice', voice('off'));
    holdMic = null;
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    await flush();
    await flush();

    const second = mics().length;

    answerFirst();
    await flush();
    await flush();
    expect(mics().slice(second)).toEqual([]);
    expect(mics().at(-1)).toBe(true);
    // Starting until the voice view says the mic listens.
    expect(root.querySelector('.composer-mic .mic.starting')).not.toBeNull();
    phone.emit('voice', voice('listening'));
    expect(root.querySelector('.composer-mic .mic.listening')).not.toBeNull();
    await flush();
    // The phone's steps, from the tap: its microphone, the hub's answer and the voice's confirmation.
    expect((posts.filter((post) => post.url.endsWith('/mic-timing')).at(-1)?.body['steps'] as Array<{ step: string }>).map((one) => one.step)).toEqual(['microphone allowed', 'capture connected', 'mic on sent', 'hub answered', 'voice confirmed']);
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    phone.emit('voice', voice('off'));
    // A refused microphone shows on the button, and the next tap tries again.
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })) } });
    root.querySelector<HTMLElement>('.composer-mic [data-voice="mic"]')!.click();
    await flush();
    await flush();
    expect(root.querySelector('.composer-mic .mic.unavailable')?.getAttribute('title')).toBe('The mic did not start: Microphone access was not allowed on this device. Click to try again.');
    expect(root.querySelector('.composer-mic [data-voice="mic"]')?.getAttribute('data-on')).toBe('true');
    // The failure belongs to its conversation: another one's mic shows the hub's state.
    phone.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1), listRow(2)])], scope: { ...scope, workItemId: 2 }, sessions: [session()], items: [], more: false, state: null, artifacts: [] });
    phone.emit('voice', voice('off'));
    expect(root.querySelector('.composer-mic .mic.unavailable')).toBeNull();
    window.innerWidth = width;
    paired.close();
  });

});
