import type { ItemView, MessageView, ReplyView, SessionView, WindowScope } from '@switchboard/hub';
import { describe, expect, it, vi } from 'vitest';
import { applyEvent, awaitingReply, EMPTY_CONVERSATION, isWorking, stateIcon, timeline, withEarlier } from '../src/conversationModel.js';
import type { ConversationState } from '../src/conversationModel.js';
import { linkTarget, supportsSecondarySidebar } from '../src/links.js';
import { startConversation } from '../src/webview/conversationMain.js';
import { renderConversation, renderMarkdown } from '../src/webview/conversationRender.js';

const T0 = Date.UTC(2026, 10, 19, 12);
const SCOPE: WindowScope = { kind: 'item', workItemId: 2, key: 'k1', title: 'Fix the <inbox> badge', cwd: 'D:/w', scopeGen: 1, sessionId: 's2' };
const SESSION: SessionView = { id: 's2', kind: 'task', title: 'Task session aaaa', state: 'running', waitingFor: null, launch: 'l', current: true, conversation: 'full', reason: null, rules: 'current' };

// Each item's ord is its time unless a test gives it another.
const reply = (id: string, at: number, patch: Partial<ReplyView> = {}): ReplyView => ({ type: 'reply', id, sessionId: 's2', at, ord: at, provisional: false, kind: 'reply', answers: null, opening: `Reply ${id}`, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, ...patch });
const message = (id: string, at: number, text: string, patch: Partial<MessageView> = {}): MessageView => ({ type: 'message', id, sessionId: 's2', at, ord: at, origin: 'terminal', text, provisional: false, withdrawn: false, delivery: null, error: null, ...patch });

const hello = (items: ItemView[] = [], patch: Partial<{ scope: WindowScope | null; sessions: SessionView[]; more: boolean }> = {}) => ({ type: 'hello', scope: SCOPE, sessions: [SESSION], items, more: false, ...patch });

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

    expect(moved).toEqual({ scope: { ...SCOPE, workItemId: 3, sessionId: null }, session: null, items: [], more: false, connected: true });
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
  const state = (items: ItemView[], patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items, more: false, connected: true, ...patch });

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

  it("keeps a link's target for the extension and never lets the page follow it", () => {
    expect(renderMarkdown('See [a.ts:4](./src/a.ts#L4) and https://x.test')).toBe('<p>See <a href="#" data-href="./src/a.ts#L4">a.ts:4</a> and <a href="#" data-href="https://x.test">https://x.test</a></p>\n');
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a');
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

  it('puts the view in the secondary side bar from VS Code 1.106', () => {
    expect(supportsSecondarySidebar('1.146.0')).toBe(true);
    expect(supportsSecondarySidebar('1.106.0')).toBe(true);
    expect(supportsSecondarySidebar('1.105.1')).toBe(false);
    expect(supportsSecondarySidebar('2.0.0')).toBe(true);
  });
});
