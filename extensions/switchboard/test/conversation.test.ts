import type { ItemView, MessageView, ReplyView, SessionView, StatusView, WindowScope } from '@switchboard/hub';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { applyEvent, awaitingReply, EMPTY_CONVERSATION, isWorking, stateIcon, statusLine, timeline, withEarlier } from '../src/conversationModel.js';
import type { ConversationState } from '../src/conversationModel.js';
import { linkTarget, previewLinks, supportsSecondarySidebar } from '../src/links.js';
import { shortTitle, startConversation, STATUS_NEW_MS } from '../src/webview/conversationMain.js';
import { ago, linkAllowed, renderConversation, renderMarkdown } from '../src/webview/conversationRender.js';

const T0 = Date.UTC(2026, 10, 19, 12);
const SCOPE: WindowScope = { kind: 'item', workItemId: 2, key: 'k1', title: 'Fix the <inbox> badge', cwd: 'D:/w', scopeGen: 1, sessionId: 's2' };
const SESSION: SessionView = { id: 's2', kind: 'task', title: 'Task session aaaa', state: 'running', waitingFor: null, launch: 'l', current: true, conversation: 'full', reason: null, rules: 'current' };

// Each item's ord is its time unless a test gives it another.
const reply = (id: string, at: number, patch: Partial<ReplyView> = {}): ReplyView => ({ type: 'reply', id, sessionId: 's2', at, ord: at, provisional: false, kind: 'reply', answers: null, opening: `Reply ${id}`, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, ...patch });
const message = (id: string, at: number, text: string, patch: Partial<MessageView> = {}): MessageView => ({ type: 'message', id, sessionId: 's2', at, ord: at, origin: 'terminal', text, provisional: false, withdrawn: false, delivery: null, error: null, ...patch });
const typed = (id: string, delivery: 'open' | 'sent' | 'not-sent' | 'uncertain', error: string | null = null): ItemView => ({ type: 'message', id, sessionId: 's2', at: T0, ord: T0, origin: 'typed', text: `Typed ${id}`, provisional: delivery === 'open' || delivery === 'sent', withdrawn: false, delivery, error });

const hello = (items: ItemView[] = [], patch: Partial<{ scope: WindowScope | null; sessions: SessionView[]; more: boolean; status: StatusView | null }> = {}) => ({ type: 'hello', scope: SCOPE, sessions: [SESSION], items, more: false, status: null, ...patch });

describe('the conversation state', () => {
  it('starts from each hello, adds and replaces items in time order, and takes only its current session\'s state', () => {
    let state = applyEvent(EMPTY_CONVERSATION, hello([message('m1', T0, 'Why?')]));

    state = applyEvent(state, { type: 'reply', reply: reply('r1', T0 + 2, { source: 'screen' }) });
    state = applyEvent(state, { type: 'message', message: message('m2', T0 + 1, 'Also') });
    state = applyEvent(state, { type: 'reply', reply: reply('r1', T0 + 3, { opening: 'Whole.' }) });
    state = applyEvent(state, { type: 'session', session: { ...SESSION, id: 'other', state: 'ended' } });
    state = applyEvent(state, { type: 'session', session: { ...SESSION, state: 'idle' } });
    state = applyEvent(state, { type: 'notice' });

    expect(state.items.map((item) => item.id)).toEqual(['m1', 'm2', 'r1']);
    expect(state.items[2]).toMatchObject({ opening: 'Whole.', source: 'transcript' });
    expect(state.session?.state).toBe('idle');
    expect(state.connected).toBe(true);

    const moved = applyEvent(applyEvent(state, { type: 'scope', scope: { ...SCOPE, workItemId: 3, sessionId: null } }), hello([], { scope: { ...SCOPE, workItemId: 3, sessionId: null }, sessions: [] }));

    expect(moved).toEqual({ scope: { ...SCOPE, workItemId: 3, sessionId: null }, session: null, items: [], more: false, connected: true, status: null });
  });

  it("keeps items in the transcript's order, by ord and not by time, with a sent message and a screen copy after them until their lines are read", () => {
    let state = applyEvent(EMPTY_CONVERSATION, hello([message('m1', T0, 'First?', { ord: 1 }), reply('r1', T0 + 9000, { ord: 2 })]));
    const ids = () => state.items.map((item) => item.id);

    state = applyEvent(state, { type: 'message', message: message('m2', T0 + 1, 'Second?', { ord: 3, provisional: true }) });
    state = applyEvent(state, { type: 'reply', reply: reply('r2', T0 + 2, { ord: 4, source: 'screen', provisional: true }) });
    state = applyEvent(state, { type: 'reply', reply: reply('r3', T0 + 3, { ord: 5 }) });
    expect(ids()).toEqual(['m1', 'r1', 'r3', 'm2', 'r2']);

    // The screen copy's transcript line is read, then the line where Claude received the message.
    state = applyEvent(state, { type: 'reply', reply: reply('r2', T0 + 2, { ord: 6 }) });
    state = applyEvent(state, { type: 'message', message: message('m2', T0 + 1, 'Second?', { ord: 7 }) });
    expect(ids()).toEqual(['m1', 'r1', 'r3', 'r2', 'm2']);

    // A sent message Claude never received leaves the timeline.
    state = applyEvent(state, { type: 'message', message: message('m3', T0 + 4, 'Never', { ord: 8, withdrawn: true }) });
    expect(timeline(state.items).map((entry) => entry.item.id)).toEqual(['m1', 'r1', 'r3', 'r2', 'm2']);
  });

  it('drops a typed message that was not sent, from an event, a hello or a page of earlier items', () => {
    const empty = applyEvent(EMPTY_CONVERSATION, hello());
    const shown = applyEvent(empty, { type: 'message', message: typed('m1', 'open') });

    expect(shown.items.map((item) => item.id)).toEqual(['m1']);
    expect(applyEvent(shown, { type: 'message', message: typed('m1', 'not-sent', 'The session has ended.') }).items).toEqual([]);
    expect(applyEvent(empty, { type: 'message', message: typed('m2', 'not-sent', 'x') }).items).toEqual([]);
    expect(applyEvent(EMPTY_CONVERSATION, hello([typed('m1', 'not-sent', 'x'), typed('m2', 'uncertain', 'y')])).items.map((item) => item.id)).toEqual(['m2']);
    expect(withEarlier(empty, [typed('m1', 'not-sent', 'x'), typed('m2', 'sent')], false).items.map((item) => item.id)).toEqual(['m2']);
  });

  it('puts earlier items before the shown ones once each', () => {
    const state = applyEvent(EMPTY_CONVERSATION, hello([reply('r3', T0 + 3)], { more: true }));

    expect(withEarlier(state, [reply('r1', T0 + 1), reply('r3', T0 + 3)], false)).toMatchObject({ items: [{ id: 'r1' }, { id: 'r3' }], more: false });
  });

  it('leaves out withdrawn copies and puts a rewrite in the place of the reply it rewrote', () => {
    const entries = timeline([
      reply('r1', T0, { rewrittenBy: 'r3' }),
      message('m1', T0 + 1, 'the other one'),
      reply('r2', T0 + 2, { withdrawn: true }),
      reply('r3', T0 + 3, { replaces: 'r1' }),
      reply('r4', T0 + 4, { rewrittenBy: 'r5' }),
      reply('r5', T0 + 5, { replaces: 'r4', withdrawn: true }),
    ]);

    expect(entries.map((entry) => `${entry.item.id}${entry.type === 'reply' && entry.earlier !== null ? `<${entry.earlier.id}` : ''}`)).toEqual(['r3<r1', 'm1', 'r4']);

    // Rewritten twice: the last rewrite alone, in the first reply's place.
    const chain = timeline([reply('a', T0, { rewrittenBy: 'b' }), reply('b', T0 + 1, { replaces: 'a', rewrittenBy: 'c' }), reply('c', T0 + 2, { replaces: 'b' })]);

    expect(chain.map((entry) => `${entry.item.id}${entry.type === 'reply' && entry.earlier !== null ? `<${entry.earlier.id}` : ''}`)).toEqual(['c<b']);
  });

  it("names the header's codicon for each state", () => {
    expect(stateIcon(SESSION)).toEqual({ icon: 'sync~spin', text: 'Working' });
    expect(stateIcon({ ...SESSION, state: 'waiting', waitingFor: 'question' }).icon).toBe('question');
    expect(stateIcon({ ...SESSION, state: 'waiting', waitingFor: 'permission' }).icon).toBe('shield');
    expect(stateIcon({ ...SESSION, state: 'idle' }).icon).toBe('check');
    expect(stateIcon({ ...SESSION, state: 'ended' }).icon).toBe('circle-slash');
    expect(stateIcon({ ...SESSION, state: 'starting' }).icon).toBe('sync~spin');
    expect(stateIcon(null).icon).toBe('circle-slash');
  });

  it('waits for a reply under the latest message only while the session works, as the header spins, until a reply comes', () => {
    const items = [message('m1', T0, 'One'), reply('r1', T0 + 1), message('m2', T0 + 2, 'Two'), reply('a1', T0 + 3, { kind: 'aside' }), reply('n1', T0 + 4, { kind: 'note' })];

    for (const state of ['starting', 'running', 'waiting', 'idle', 'ended'] as const) {
      const session = { ...SESSION, state };

      expect(isWorking(session)).toBe(stateIcon(session).icon === 'sync~spin');
      expect(awaitingReply(items, timeline(items), session)).toBe(isWorking(session) || state === 'waiting' ? 2 : -1);
    }

    expect(awaitingReply(items, timeline(items), null)).toBe(-1);
    expect(awaitingReply([...items, reply('r2', T0 + 5)], timeline([...items, reply('r2', T0 + 5)]), SESSION)).toBe(-1);
    expect(awaitingReply([reply('r1', T0)], timeline([reply('r1', T0)]), SESSION)).toBe(-1);

    // A rewrite of the earlier reply answers the latest message, though the timeline shows it above that message.
    const rewritten = [message('m1', T0, 'One'), reply('r1', T0 + 1, { rewrittenBy: 'r2' }), message('m2', T0 + 2, 'Two'), reply('r2', T0 + 3, { replaces: 'r1' })];

    expect(awaitingReply(rewritten, timeline(rewritten), SESSION)).toBe(-1);
    // A reply ends the wait when it answers the latest message or a later one, wherever the timeline shows it; one answering an earlier message
    // does not, such as the reply to the first message written after the second was sent.
    const batch = [message('m1', T0, 'One'), message('m2', T0 + 1, 'Two'), reply('r1', T0 + 2, { answers: 'm1' })];

    expect(awaitingReply(batch, timeline(batch), SESSION)).toBe(1);
    expect(awaitingReply([...batch, reply('r2', T0 + 3, { answers: 'm2' })], timeline(batch), SESSION)).toBe(-1);
    // A withdrawn screen copy is no reply.
    expect(awaitingReply([...items, reply('r3', T0 + 5, { withdrawn: true })], timeline(items), SESSION)).toBe(2);
  });
});

describe('the Conversation view page', () => {
  const state = (items: ItemView[], patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items, more: false, connected: true, status: null, ...patch });

  it('draws the header, messages as boxes, replies whole, asides, notes and rewrites, escaping every text', () => {
    const html = renderConversation(
      state([
        message('m1', T0, 'Is <b>it</b> fixed?'),
        reply('r1', T0 + 1, { opening: 'Yes, **fixed**.\n\n| a | b |\n|---|---|\n| 1 | 2 |', rewrittenBy: 'r3' }),
        reply('r2', T0 + 2, { kind: 'aside', opening: 'Reading <script>alert(1)</script>' }),
        reply('n1', T0 + 2, { kind: 'note', opening: 'Conversation continued from another session.' }),
        reply('r3', T0 + 3, { opening: 'Both fixed.', replaces: 'r1' }),
      ]),
      new Set(['earlier:r3']),
    );
    const root = document.createElement('div');

    root.innerHTML = html;
    expect(root.querySelector('.header .codicon')?.className).toBe('codicon codicon-sync codicon-modifier-spin');
    expect(root.querySelector('.header .title')?.textContent).toBe('Fix the <inbox> badge');
    expect(root.querySelector('.message .box')?.textContent).toBe('Is <b>it</b> fixed?');
    root.innerHTML = renderConversation(state([message('m1', T0, 'Sent', { provisional: true })]));
    expect(root.querySelector('.message')?.className).toBe('message provisional');
    root.innerHTML = html;
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.className)).toEqual(['message', 'reply reply', 'reply aside', 'note']);
    expect(root.querySelector('.reply.reply .body > p')?.innerHTML).toBe('Both fixed.');
    expect(root.querySelector<HTMLDetailsElement>('.fold.earlier')?.open).toBe(true);
    expect(root.querySelector('.fold.earlier .was table')).not.toBeNull();
    expect(root.querySelector('.fold.earlier .was')?.innerHTML).toContain('<strong>fixed</strong>');
    // Raw HTML in a reply stays text.
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('.reply.aside')?.textContent).toContain('<script>');
  });

  it('says why the view cannot talk to a session, that it shows a session without the rules whole, and when there is nothing to show', () => {
    const ended = renderConversation(state([], { session: { ...SESSION, state: 'ended', conversation: 'read-only', reason: 'The session has ended. Open it in the terminal to resume it.', rules: 'none' } }));

    expect(ended).toContain('The session has ended. Open it in the terminal to resume it.');
    expect(ended).toContain('its replies show whole');
    expect(ended).toContain('No messages yet.');
    expect(renderConversation(state([], { session: { ...SESSION, conversation: 'none', reason: 'background' } }))).not.toContain('data-action="terminal"');
    expect(renderConversation({ ...EMPTY_CONVERSATION, connected: true })).toContain('This window has no Switchboard session.');
    expect(renderConversation(EMPTY_CONVERSATION)).toContain('Connecting to Switchboard');
    expect(renderConversation(state([reply('r1', T0)], { more: true }))).toContain('data-action="earlier"');
  });

  it('stamps each message and reply with its time, not a note, and puts a divider before a turn that starts on another day', () => {
    const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute).getTime();
    const root = document.createElement('div');

    root.innerHTML = renderConversation(
      state([
        message('m1', at(19, 13, 46), '/support-process #453532'),
        reply('r1', at(19, 13, 47)),
        reply('n1', at(19, 13, 48), { kind: 'note', opening: 'Conversation continued from another session.' }),
        reply('a1', at(19, 14, 5), { kind: 'aside', opening: 'Reading' }),
        message('m2', at(20, 9, 0), 'Next day'),
        reply('r2', at(20, 21, 30)),
      ]),
      new Set(),
      at(20, 22, 0),
    );

    const stamps = (id: string) => root.querySelector(`li[data-id="${id}"] > .stamp-line .stamp`)?.textContent ?? null;

    expect(['m1', 'r1', 'n1', 'a1', 'm2', 'r2'].map(stamps)).toEqual(['1:46 PM', '1:47 PM', null, '2:05 PM', '9:00 AM', '9:30 PM']);
    expect(root.querySelector('li[data-id="m1"] time')?.getAttribute('datetime')).toBe(new Date(at(19, 13, 46)).toISOString());
    expect(root.querySelector('li[data-id="m1"] time')?.getAttribute('title')).toMatch(/^2026-11-19 13:46:00 \S+$/);
    // The stamp sits above a message's box, and a slash command shows in the editor font.
    expect([...root.querySelector('li[data-id="m1"]')!.children].map((child) => child.className)).toEqual(['stamp-line', 'box command']);
    expect(root.querySelector('li[data-id="m2"] .box')?.className).toBe('box');
    // No divider before the first turn; one, without the year, before the turn on the next day, which the keys skip.
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.className)).toEqual(['m1', 'r1', 'n1', 'a1', 'day', 'm2', 'r2']);
    expect(root.querySelector('.day')?.textContent).toBe('Fri, Nov 20');
    expect(root.querySelector('.day')?.getAttribute('role')).toBe('separator');

    // A reply after midnight in the same turn gets no divider, the next turn does; a turn in an earlier year shows its year.
    root.innerHTML = renderConversation(state([message('m1', at(19, 23, 50), 'Late'), reply('r1', at(20, 0, 10)), message('m2', at(20, 0, 20), 'Still')], { session: { ...SESSION, state: 'idle' } }), new Set(), at(20, 1, 0));
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.getAttribute('data-id') ?? li.className)).toEqual(['m1', 'r1', 'day', 'm2']);
    root.innerHTML = renderConversation(state([message('m1', new Date(2026, 11, 30, 9).getTime(), 'Old'), message('m2', new Date(2026, 11, 31, 9).getTime(), 'New')]), new Set(), new Date(2027, 2, 1).getTime());
    expect(root.querySelector('.day')?.textContent).toBe('Thu, Dec 31, 2026');
  });

  it("shows a spinner under the operator's latest message while the session works on a reply, gone when the reply arrives or the turn ends", () => {
    const root = document.createElement('div');
    const asked = [reply('r1', T0, { opening: 'Hi' }), message('m1', T0 + 1, 'Why?'), reply('a1', T0 + 2, { kind: 'aside', opening: 'Reading' })];

    root.innerHTML = renderConversation(state(asked));
    expect([...root.querySelectorAll('.timeline > li')].map((li) => li.className)).toEqual(['reply reply', 'message', 'working', 'reply aside']);
    expect(root.querySelector('.working .codicon')?.className).toBe('codicon codicon-loading codicon-modifier-spin');
    expect(root.querySelector('.working')?.getAttribute('data-id')).toBeNull();
    expect(root.querySelector('.working [role="status"]')?.textContent).toBe('Working on a reply');
    expect(root.querySelector('.working .codicon')?.getAttribute('aria-hidden')).toBe('true');

    root.innerHTML = renderConversation(state([...asked, reply('r2', T0 + 3)]));
    expect(root.querySelector('.working')).toBeNull();
    root.innerHTML = renderConversation(state(asked, { session: { ...SESSION, state: 'idle' } }));
    expect(root.querySelector('.working')).toBeNull();
    root.innerHTML = renderConversation(state(asked, { session: { ...SESSION, state: 'ended' } }));
    expect(root.querySelector('.working')).toBeNull();
    // It stands still while the session waits on a question.
    root.innerHTML = renderConversation(state(asked, { session: { ...SESSION, state: 'waiting', waitingFor: 'question' } }));
    expect(root.querySelector('.working .codicon')?.className).toBe('codicon codicon-loading');
  });

  it('draws file:, drive-letter, relative and spaced links as links, and unsafe schemes as text', () => {
    const href = (text: string) => /data-href="([^"]*)"/.exec(renderMarkdown(text))?.[1] ?? null;

    expect(href('[Index.cshtml](file:///D:/git/widgets/Widgets.Web/Views/Home/Index.cshtml)')).toBe('file:///D:/git/widgets/Widgets.Web/Views/Home/Index.cshtml');
    expect(href('[c.ts:3](file:///D:/a%20b/c.ts#L3)')).toBe('file:///D:/a%20b/c.ts#L3');
    expect(href('[c.ts](<D:/a b/c.ts#L4>)')).toBe('D:/a%20b/c.ts#L4');
    expect(href('[a](../src/a.ts#L42)')).toBe('../src/a.ts#L42');
    expect(href('[a](#L9)')).toBe('#L9');
    for (const unsafe of ['javascript:alert(1)', 'JavaScript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,x', 'mailto:x@y.z', 'command:workbench.action.quit', 'vscode://file/D:/a.ts']) {
      expect(href(`[x](${unsafe})`)).toBeNull();
    }
    expect(linkAllowed(' javascript:x')).toBe(false);
  });

  it("keeps a link's target for the extension and never lets the page follow it", () => {
    expect(renderMarkdown('See [a.ts:4](./src/a.ts#L4) and https://x.test')).toBe('<p>See <a href="#" data-href="./src/a.ts#L4">a.ts:4</a> and <a href="#" data-href="https://x.test">https://x.test</a></p>\n');
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a');
  });

  it('copies a code block as written and a reply as its Markdown, and shows a check for 2 seconds once copied', () => {
    vi.useFakeTimers();

    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    const vscode = { postMessage: (message: { type: string }) => posted.push(message), getState: () => null, setState: () => undefined };
    const show = (items: ItemView[]) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state(items, { session: { ...SESSION, state: 'idle' } }) } }));
    const copied = (id: number, ok: boolean) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'copied', id, ok } }));

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    show([
      reply('r1', T0, { opening: 'Run:\n\n```sh\nnpm run build && echo "<done>"\n```\n\nThen **check** it.' }),
      reply('r2', T0 + 1, { source: 'screen', provisional: true }),
      reply('n1', T0 + 2, { kind: 'note', opening: 'Conversation continued from another session.' }),
    ]);

    // A copy button in each code block's frame, and one under each reply read from the transcript.
    const code = root.querySelector<HTMLButtonElement>('li[data-id="r1"] .body > .code-block > button.copy[data-action="copy-code"]')!;
    const response = root.querySelector<HTMLButtonElement>('li[data-id="r1"] > .actions > button.copy[data-action="copy-reply"]')!;

    expect(code.nextElementSibling?.tagName).toBe('PRE');
    expect(code.querySelector('.codicon')?.className).toBe('codicon codicon-copy');
    expect(response.getAttribute('aria-label')).toBe('Copy response to clipboard');
    expect(root.querySelector('li[data-id="r2"] .actions')).toBeNull();
    expect(root.querySelector('li[data-id="n1"] .actions')).toBeNull();

    code.click();
    response.click();
    expect(posted.filter((message) => message.type === 'copy')).toEqual([
      { type: 'copy', id: 1, text: 'npm run build && echo "<done>"' },
      { type: 'copy', id: 2, text: 'Run:\n\n```sh\nnpm run build && echo "<done>"\n```\n\nThen **check** it.' },
    ]);

    // A failed write shows nothing; a written one shows the check until 2 seconds pass.
    copied(1, false);
    expect(code.querySelector('.codicon')?.className).toBe('codicon codicon-copy');
    copied(2, true);
    expect(response.querySelector('.codicon')?.className).toBe('codicon codicon-check');
    expect(response.title).toBe('Copied');
    expect(live.textContent).toBe('Copied');
    vi.advanceTimersByTime(1_999);
    expect(response.querySelector('.codicon')?.className).toBe('codicon codicon-check');
    vi.advanceTimersByTime(1);
    expect(response.querySelector('.codicon')?.className).toBe('codicon codicon-copy');
    expect(response.title).toBe('Copy response');

    // Enter on a copy button presses it rather than toggling the reply's fold.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });

    response.focus();
    response.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    vi.useRealTimers();
  });

  it('posts ready, draws each state, posts a link, a fold and Open in terminal, and moves between items with the keys', () => {
    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: unknown[] = [];
    let saved: unknown = { open: ['earlier:w2'] };
    const vscode = { postMessage: (message: unknown) => posted.push(message), getState: () => saved, setState: (next: unknown) => (saved = next) };

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    expect(posted).toEqual([{ type: 'ready' }]);
    expect(root.textContent).toContain('Connecting to Switchboard');

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state([reply('r1', T0, { opening: 'Before', rewrittenBy: 'w2' }), reply('w2', T0 + 1, { opening: 'See [a](./a.ts#L2)', replaces: 'r1' })]) } }));
    expect(root.querySelector<HTMLDetailsElement>('details.fold')?.open).toBe(true);
    expect(root.textContent).not.toContain('Show more');

    root.querySelector<HTMLElement>('a[data-href]')!.click();
    root.querySelector<HTMLElement>('[data-action="terminal"]')!.click();
    expect(posted.slice(1)).toEqual([{ type: 'open', href: './a.ts#L2' }, { type: 'terminal' }]);

    const fold = root.querySelector<HTMLDetailsElement>('details.fold')!;

    fold.open = false;
    fold.dispatchEvent(new Event('toggle'));
    expect(saved).toMatchObject({ open: [] });

    // A second reply arrives and is announced once.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state([reply('r1', T0, { opening: 'One' }), reply('r2', T0 + 1, { opening: 'Two' })]) } }));
    expect(live.textContent).toBe('Two');

    const list = root.querySelector<HTMLElement>('.timeline')!;

    list.focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-id')).toBe('r1');
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-id')).toBe('r2');

    // The keys skip the spinner under a message the session is working on. jsdom has no CSS.escape, which a redraw with a focused item uses.
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state([reply('r1', T0, { opening: 'One' }), message('m3', T0 + 1, 'Three?'), reply('a3', T0 + 2, { kind: 'aside', opening: 'Reading' })]) } }));
    expect(root.querySelector('.timeline > li.working')).not.toBeNull();
    root.querySelector<HTMLElement>('li[data-id="m3"]')!.focus();
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-id')).toBe('a3');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

describe('the composer', () => {
  const state = (patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items: [], more: false, connected: true, status: null, ...patch });

  function page() {
    // Pages of earlier tests still listen on the window, and jsdom has no CSS.escape for the one that kept a focused item.
    if (typeof CSS === 'undefined') {
      vi.stubGlobal('CSS', { escape: (value: string) => value });
    }

    const root = document.createElement('div');
    const live = document.createElement('div');
    const host = document.createElement('div');
    const posted: Array<{ type: string; [field: string]: unknown }> = [];
    const vscode = { postMessage: (message: { type: string }) => posted.push(message), getState: () => null, setState: () => undefined };

    document.body.replaceChildren(root, host, live);
    startConversation(root, live, vscode, host);

    const input = host.querySelector('textarea')!;
    const show = (next: ConversationState) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: next } }));
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

      input.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const sent = (id: number, error: string | null) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'sent', id, error } }));

    return { host, input, posted, show, press, sent };
  }

  it('sends the text on Enter, keeps it read-only until the hub took it, and empties the box then', () => {
    const { input, posted, show, press, sent, host } = page();

    show(state());
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe('Message Fix the <inbox> badge…');

    input.value = 'Fix it\nplease';
    // Shift+Enter is a new line, left to the box.
    expect(press('Enter', { shiftKey: true })).toBe(false);
    expect(press('Enter', { isComposing: true })).toBe(false);
    expect(posted.filter((message) => message.type === 'send')).toEqual([]);
    expect(press('Enter')).toBe(true);
    expect(posted.filter((message) => message.type === 'send')).toEqual([{ type: 'send', id: 1, text: 'Fix it\nplease', target: { scopeGen: 1, sessionId: 's2', launch: 'l' } }]);
    expect(input.readOnly).toBe(true);
    expect(host.classList.contains('sending')).toBe(true);

    // A second Enter while the first is sent posts nothing.
    press('Enter');
    expect(posted.filter((message) => message.type === 'send')).toHaveLength(1);

    // An answer for another send changes nothing.
    sent(7, null);
    expect(input.value).toBe('Fix it\nplease');
    sent(1, null);
    expect(input.value).toBe('');
    expect(input.readOnly).toBe(false);
    expect(host.classList.contains('sending')).toBe(false);

    // An empty box sends nothing.
    input.value = '   ';
    press('Enter');
    expect(posted.filter((message) => message.type === 'send')).toHaveLength(1);
  });

  it('draws the footer with a send button, enabled only while there is text the session can take, which sends as Enter does', () => {
    const { input, posted, show, sent, host } = page();
    const send = host.querySelector<HTMLButtonElement>('.composer > .composer-footer > button.send')!;
    const type = (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
    };

    expect(host.querySelector('.composer > textarea + .composer-footer > .composer-controls')?.childElementCount).toBe(0);
    expect(send.querySelector('.codicon')?.className).toBe('codicon codicon-arrow-up');
    expect(send.getAttribute('aria-label')).toBe('Send');
    show(state());
    expect(send.disabled).toBe(true);
    type('  ');
    expect(send.disabled).toBe(true);
    type('Ship it');
    expect(send.disabled).toBe(false);
    send.click();
    expect(posted.filter((message) => message.type === 'send')).toEqual([{ type: 'send', id: 1, text: 'Ship it', target: { scopeGen: 1, sessionId: 's2', launch: 'l' } }]);
    // Disabled while the hub has the message, and again once the box empties.
    expect(send.disabled).toBe(true);
    send.click();
    expect(posted.filter((message) => message.type === 'send')).toHaveLength(1);
    sent(1, null);
    expect(send.disabled).toBe(true);

    // A session that cannot take messages disables it whatever the box holds.
    type('More');
    expect(send.disabled).toBe(false);
    show(state({ session: { ...SESSION, state: 'ended', conversation: 'read-only', reason: 'The session has ended.' } }));
    expect(send.disabled).toBe(true);
    send.click();
    expect(posted.filter((message) => message.type === 'send')).toHaveLength(1);
  });

  it('names the work item in the placeholder without its leading tags, cut at a word', () => {
    expect(shortTitle('[Feedback] Event Time-slot no longer a Choice to select for UI')).toBe('Event Time-slot no longer a Choice to');
    expect(shortTitle('[Support][Bug]  Fix the badge')).toBe('Fix the badge');
    expect(shortTitle('[Only a tag]')).toBe('[Only a tag]');
    expect(shortTitle('A'.repeat(60))).toBe('A'.repeat(40));
  });

  it("keeps the text and shows the hub's refusal above the box until it is dismissed", () => {
    const { input, posted, show, press, sent, host } = page();

    show(state());
    input.value = 'Hello';
    press('Enter');
    sent(1, 'The session has ended. Open it in the terminal to resume it.');

    const error = host.querySelector<HTMLElement>('.composer-error')!;

    expect(error.nextElementSibling?.className).toBe('composer');
    expect(input.value).toBe('Hello');
    expect(input.readOnly).toBe(false);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('The session has ended. Open it in the terminal to resume it.');
    input.dispatchEvent(new Event('input'));
    expect(error.hidden).toBe(false);
    error.querySelector<HTMLButtonElement>('button.dismiss')!.click();
    expect(error.hidden).toBe(true);
    expect(posted.filter((message) => message.type === 'send')).toHaveLength(1);
  });

  it('puts the text of a message that was not sent back in the box, below a draft after a blank line, with why above it', () => {
    const { input, show, press, sent, host } = page();
    const unsent = (text: string, error: string) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'unsent', returned: [{ text, error }] } }));
    const error = host.querySelector<HTMLElement>('.composer-error')!;

    show(state());
    unsent('First', 'The terminal holder did not answer.');
    expect(input.value).toBe('First');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('The terminal holder did not answer.');

    input.value = 'A draft\n';
    unsent('Second', 'The session has ended. Open it in the terminal to resume it.');
    expect(input.value).toBe('A draft\n\nSecond');
    expect(error.textContent).toBe('The session has ended. Open it in the terminal to resume it.');

    // While another message is being sent, the text comes back once the hub answered it.
    input.value = 'Third';
    press('Enter');
    unsent('Fourth', 'A newer session of this work item started; the message was not sent.');
    expect(input.value).toBe('Third');
    sent(1, null);
    expect(input.value).toBe('Fourth');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('A newer session of this work item started; the message was not sent.');
  });

  it('is disabled with the reason for a session the view cannot talk to, and hidden in a window with no work item', () => {
    const { input, posted, show, press, host } = page();

    show(state({ session: { ...SESSION, state: 'ended', conversation: 'read-only', reason: 'The session has ended. Open it in the terminal to resume it.' } }));
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('The session has ended. Open it in the terminal to resume it.');
    input.value = 'Hello';
    press('Enter');
    expect(posted.filter((message) => message.type === 'send')).toEqual([]);

    show(state({ session: null }));
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('No session has started yet.');

    show(state({ connected: false }));
    expect(input.disabled).toBe(true);

    show({ ...EMPTY_CONVERSATION, connected: true });
    expect(host.hidden).toBe(true);
  });

  it('keeps a draft when the window moves to a newer session, and sends it to the session the page then shows', () => {
    const { input, posted, show, press } = page();

    show(state());
    input.value = 'Half written';
    show(state({ scope: { ...SCOPE, scopeGen: 2, sessionId: 's9' }, session: { ...SESSION, id: 's9', launch: 'l9' } }));
    expect(input.value).toBe('Half written');
    press('Enter');
    expect(posted.filter((message) => message.type === 'send')).toEqual([{ type: 'send', id: 1, text: 'Half written', target: { scopeGen: 2, sessionId: 's9', launch: 'l9' } }]);
  });

  it('never takes the focus from the composer when a redraw puts it back on the timeline item it was on', () => {
    const { input, show } = page();
    const items = [reply('r1', T0), reply('r2', T0 + 1)];

    show(state({ items }));

    const list = document.querySelector<HTMLElement>('.timeline')!;

    list.focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-id')).toBe('r1');
    show(state({ items }));
    expect(document.activeElement?.getAttribute('data-id')).toBe('r1');
    input.focus();
    show(state({ items: [...items, reply('r3', T0 + 2)] }));
    expect(document.activeElement).toBe(input);
  });

  it("draws a typed message's delivery under its box, with why it did not go, and none under a terminal message", () => {
    const root = document.createElement('div');

    root.innerHTML = renderConversation(state({ items: [message('m0', T0, 'from the terminal'), typed('m1', 'open'), typed('m2', 'sent'), typed('m3', 'not-sent', 'The session has <ended>.'), typed('m4', 'uncertain', 'The transcript does not show the message.')] }));

    expect([...root.querySelectorAll('.message')].map((li) => li.querySelector('.delivery')?.textContent ?? null)).toEqual([
      null,
      'sending',
      'sent',
      'not sent · The session has <ended>.',
      'uncertain · The transcript does not show the message.',
    ]);
    expect(root.querySelector('.delivery.not-sent')).not.toBeNull();
  });
});

describe('reply links and the secondary side bar', () => {
  it('opens web pages, and files at their line relative to the session folder, and drops other schemes', () => {
    expect(linkTarget('https://github.com/o/r/pull/1', 'D:/w')).toEqual({ url: 'https://github.com/o/r/pull/1' });
    expect(linkTarget('./src/a.ts#L42', 'D:/w')).toMatchObject({ line: 42 });
    expect((linkTarget('./src/a.ts#L42', 'D:/w') as { file: string }).file.replaceAll('\\', '/')).toBe('D:/w/src/a.ts');
    expect(linkTarget('src/b.ts#L4-L9', 'D:/w')).toMatchObject({ line: 4 });
    expect(linkTarget('D:/x/c.ts', null)).toEqual({ file: 'D:/x/c.ts', line: null });
    expect(linkTarget('src/d.ts', null)).toBeNull();
    expect(linkTarget('javascript:alert(1)', 'D:/w')).toBeNull();
    expect(linkTarget('mailto:x@y.z', 'D:/w')).toBeNull();
  });

  it('opens a file: URL, a drive-letter path and a path with spaces at their line', () => {
    expect(linkTarget('file:///D:/git/widgets/Views/Index.cshtml', 'D:/w')).toEqual({ file: 'D:/git/widgets/Views/Index.cshtml', line: null });
    expect(linkTarget('file:///D:/a%20b/c.ts#L3', null)).toEqual({ file: 'D:/a b/c.ts', line: 3 });
    expect(linkTarget('file://localhost/D:/c.ts#L7-L9', null)).toEqual({ file: 'D:/c.ts', line: 7 });
    expect(linkTarget('file:///D%3A/c.ts', null)).toEqual({ file: 'D:/c.ts', line: null });
    expect(linkTarget('D:/a%20b/c.ts#L5', null)).toEqual({ file: 'D:/a b/c.ts', line: 5 });
    expect((linkTarget('./my%20dir/a.ts#L2', 'D:/w') as { file: string }).file.replaceAll('\\', '/')).toBe('D:/w/my dir/a.ts');
    expect(linkTarget('D:/x/100%25%23.ts#L1', null)).toEqual({ file: 'D:/x/100%#.ts', line: 1 });
    expect(linkTarget('D:/x/50%.ts', null)).toEqual({ file: 'D:/x/50%.ts', line: null });
    expect(linkTarget('file:javascript:alert(1)', 'D:/w')).toBeNull();
  });

  it('puts the view in the secondary side bar from VS Code 1.106', () => {
    expect(supportsSecondarySidebar('1.146.0')).toBe(true);
    expect(supportsSecondarySidebar('1.106.0')).toBe(true);
    expect(supportsSecondarySidebar('1.105.1')).toBe(false);
    expect(supportsSecondarySidebar('2.0.0')).toBe(true);
  });
});

describe('the status row', () => {
  const state = (patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items: [], more: false, connected: true, status: null, ...patch });
  const status = (id: string, markdown: string, patch: Partial<StatusView> = {}): StatusView => ({ id, sessionId: 's2', at: T0, markdown, fallback: false, ...patch });

  it("takes the hello's status and each status of the window's session or work item, and drops another session's", () => {
    let current = applyEvent(EMPTY_CONVERSATION, hello([], { status: status('stage-2', 'Reading', { fallback: true }) }));

    expect(current.status?.markdown).toBe('Reading');
    current = applyEvent(current, { type: 'status', status: status('st-1', 'Done.') });
    expect(current.status?.id).toBe('st-1');
    expect(applyEvent(current, { type: 'status', status: status('st-9', 'Theirs.', { sessionId: 's3' }) }).status?.id).toBe('st-1');
    expect(applyEvent(current, { type: 'status', status: status('stage-3', 'Theirs.', { sessionId: null, fallback: true }) }).status?.id).toBe('st-1');
    expect(applyEvent(current, { type: 'status', status: status('stage-2', 'Stage.', { sessionId: null, fallback: true }) }).status?.id).toBe('stage-2');
    expect(applyEvent(current, { type: 'status', status: null }).status).toBeNull();
    expect(applyEvent(current, hello()).status).toBeNull();
    // A scope event that moves the window drops the row until the next hello; one that keeps it keeps the row.
    expect(applyEvent(current, { type: 'scope', scope: { ...SCOPE, workItemId: 3, sessionId: 's3' } }).status).toBeNull();
    expect(applyEvent(current, { type: 'scope', scope: { ...SCOPE, sessionId: 's9' } }).status).toBeNull();
    expect(applyEvent(current, { type: 'scope', scope: { ...SCOPE, title: 'Renamed' } }).status?.id).toBe('st-1');
  });

  it("points a status's relative and absolute file links at files for the Markdown preview, and leaves web links, anchors and code alone", () => {
    const cwd = process.platform === 'win32' ? 'D:\\w' : '/w';
    const url = (path: string) => pathToFileURL(join(cwd, path)).href;
    const out = previewLinks('See [a](./src/a.ts#L42), [b](<src/b c.ts>), [web](https://x.test/a) and [top](#x).\n```\n[c](c.ts)\n```\n[d](d.ts)', cwd);

    expect(out.split('\n')[0]).toBe(`See [a](${url('src/a.ts')}#L42), [b](${url('src/b c.ts')}), [web](https://x.test/a) and [top](#x).`);
    expect(out.split('\n')[4]).toBe(`[d](${url('d.ts')})`);
    expect(out.split('\n').slice(1, 4)).toEqual(['```', '[c](c.ts)', '```']);
    // With no folder, a relative link stays as written.
    expect(previewLinks('[a](a.ts)', null)).toBe('[a](a.ts)');
  });

  it('says what the view reads of a session with older rules or none', () => {
    const notice = (rules: SessionView['rules']) => renderConversation(state({ session: { ...SESSION, rules } }), new Set(), T0);

    expect(notice('older')).toContain('This session started with older conversation rules, so the view reads only the tags they explained. Resume it to give it the current ones.');
    expect(notice('none')).toContain('This session started without the conversation rules, so its replies show whole.');
    expect(notice('current')).not.toContain('class="notice"');
  });

  it('leaves a reply that is only a status out of the timeline', () => {
    expect(timeline([reply('r1', T0, { opening: '' }), reply('r2', T0 + 1)]).map((entry) => entry.item.id)).toEqual(['r2']);
  });

  it('says how long ago a status came, and gives its first line without Markdown marks', () => {
    expect(ago(T0, T0 + 59_000)).toBe('just now');
    expect(ago(T0, T0 + 4 * 60_000)).toBe('4 min ago');
    expect(ago(T0, T0 + 3 * 3_600_000)).toBe('3 h ago');
    expect(ago(T0, T0 + 50 * 3_600_000)).toBe('2 d ago');
    expect(statusLine('\n## **Where** it stands\n- x')).toBe('Where it stands');
    expect(statusLine('- 1. `a.ts` fixed')).toBe('a.ts fixed');
  });

  it('pins the status under the header, folded to its first line, with the whole status escaped when open and the tools to open it', () => {
    const html = renderConversation(state({ status: status('st-1', '## Done <img src=x onerror=alert(1)>\n\n| a |\n|---|\n| 1 |') }), new Set(), T0 + 4 * 60_000);
    const root = document.createElement('div');

    root.innerHTML = html;

    const row = root.querySelector<HTMLDetailsElement>('.status > details.status-row')!;

    expect(root.firstElementChild?.className).toBe('header');
    expect(root.children[1]?.className).toBe('status');
    expect(row.open).toBe(false);
    expect(row.querySelector('summary .codicon-pulse')).not.toBeNull();
    expect(row.querySelector('summary')!.textContent).toBe('Status·4 min agoDone <img src=x onerror=alert(1)>');
    expect(root.querySelector('img')).toBeNull();
    expect(row.querySelector('.status-body table')).not.toBeNull();
    expect(root.querySelector('[data-action="status-open"]')).not.toBeNull();
    expect(root.querySelector('[data-action="statuses"]')).not.toBeNull();
    expect(root.querySelector('.status-new')).toBeNull();

    root.innerHTML = renderConversation(state({ status: status('st-1', 'x') }), new Set(['status']), T0, true);
    expect(root.querySelector<HTMLDetailsElement>('details.status-row')!.open).toBe(true);
    expect(root.querySelector('.status-new')?.textContent).toBe('New');

    // The stage stands in, dimmed, with nothing to open; no status and no stage, no row.
    root.innerHTML = renderConversation(state({ status: status('stage-2', 'Reading the inbox code', { fallback: true }) }), new Set(), T0);
    expect(root.querySelector('details.status-row.fallback .status-first')?.textContent).toBe('Reading the inbox code');
    expect(root.querySelector('[data-action="status-open"]')).toBeNull();
    expect(renderConversation(state(), new Set(), T0)).not.toContain('status-row');
  });

  it('marks a status that replaced the one shown as New until it is opened or a minute passes, redraws its age, and posts its tools', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const root = document.createElement('div');
    const live = document.createElement('div');
    const posted: Array<{ type: string }> = [];
    const vscode = { postMessage: (message: { type: string }) => posted.push(message), getState: () => null, setState: () => undefined };
    const show = (patch: Partial<ConversationState>) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: state(patch) } }));

    document.body.replaceChildren(root, live);
    startConversation(root, live, vscode);
    show({ status: status('stage-2', 'Reading', { fallback: true }) });
    expect(root.querySelector('.status-new')).toBeNull();

    // The first status after the stage, and each that replaces it, is New.
    show({ status: status('st-1', 'First.') });
    expect(root.querySelector('.status-new')).not.toBeNull();
    expect(live.textContent).toBe('New status: First.');
    expect(root.querySelector('.status-age')?.textContent).toBe('just now');
    vi.advanceTimersByTime(STATUS_NEW_MS);
    expect(root.querySelector('.status-new')).toBeNull();
    vi.advanceTimersByTime(3 * 60_000);
    expect(root.querySelector('.status-age')?.textContent).toBe('4 min ago');

    show({ status: status('st-2', '## Second') });
    expect(root.querySelector('.status-new')).not.toBeNull();
    // A redraw with the same status keeps the mark; opening the row clears it.
    show({ status: status('st-2', '## Second') });
    expect(root.querySelector('.status-new')).not.toBeNull();

    const row = root.querySelector<HTMLDetailsElement>('details.status-row')!;

    row.open = true;
    row.dispatchEvent(new Event('toggle'));
    expect(root.querySelector('.status-new')).toBeNull();

    show({ status: status('st-3', 'Third.') });
    root.querySelector<HTMLElement>('[data-action="status-open"]')!.click();
    expect(root.querySelector('.status-new')).toBeNull();
    root.querySelector<HTMLElement>('[data-action="statuses"]')!.click();
    expect(posted.filter((message) => message.type.startsWith('status'))).toEqual([{ type: 'status-open' }, { type: 'statuses' }]);

    // Another session's first status is not New.
    show({ scope: { ...SCOPE, sessionId: 's5' }, session: { ...SESSION, id: 's5' }, status: status('st-5', 'Other.', { sessionId: 's5' }) });
    expect(root.querySelector('.status-new')).toBeNull();
    vi.useRealTimers();
  });
});
