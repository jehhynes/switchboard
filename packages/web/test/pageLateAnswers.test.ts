import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startPage } from '../src/main.js';
import { drawAtOnce } from './frame.js';
import { message, reply, session, scope, FakeSource } from './pageFixtures.js';

describe('the page against late answers', () => {
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let root: HTMLElement;
  let pending: Array<{ url: string; resolve: (answer: { status: number; body: unknown }) => void }>;

  beforeEach(() => {
    posts = [];
    pending = [];
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#');
  });

  const start = (held: RegExp) => {
    const fetch = vi.fn((url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const reply = (answer: { status: number; body: unknown }) => ({ status: answer.status, ok: answer.status === 200, json: async () => answer.body, text: async () => '' }) as unknown as Response;

      return held.test(url) ? new Promise<Response>((resolve) => pending.push({ url, resolve: (answer) => resolve(reply(answer)) })) : Promise.resolve(reply({ status: 200, body: {} }));
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });

    return { page, source: FakeSource.last! };
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const scopeOf = (workItemId: number, scopeGen: number, sessionId: string) => ({ ...scope, workItemId, scopeGen, sessionId, conversations: [1, 2].map((id) => ({ ...scope.conversations[0]!, workItemId: id, title: `W${id}`, sessionId: `s${id}` })) });
  const helloFor = (source: FakeSource, workItemId: number, scopeGen: number, items: unknown[] = []) => source.emit('hello', { key: 'pk', groups: [], scope: scopeOf(workItemId, scopeGen, `s${workItemId}`), sessions: [session({ id: `s${workItemId}` })], items, more: true, state: null, artifacts: [] });
  const type = (text: string) => {
    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  };

  it('keeps a message refused before its send answered, and puts one refused after the page moved on back in its own draft', async () => {
    const { page, source } = start(/send/);

    helloFor(source, 1, 3);
    type('first words');
    source.emit('message', { message: message('m1', 9, { workItemId: 1, delivery: 'not-sent', error: 'The holder did not answer.', text: 'first words' }) });
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm1' } } });
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('first words');
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The holder did not answer.');

    type('second words');
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm2' } } });
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('');
    helloFor(source, 2, 4);
    source.emit('message', { message: message('m2', 10, { workItemId: 1, delivery: 'not-sent', error: 'The session ended.', text: 'second words' }) });
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('');
    helloFor(source, 1, 5);
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('second words');
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The session ended.');
    page.close();
  });

  it("drops another conversation's history that answers after the page moved on", async () => {
    const { page, source } = start(/history/);

    helloFor(source, 1, 3, [message('a1', 1, { workItemId: 1 })]);
    root.querySelector<HTMLElement>('[data-action="earlier"]')!.click();
    helloFor(source, 2, 4, [message('b1', 1, { workItemId: 2 })]);
    pending.shift()!.resolve({ status: 200, body: { items: [message('a0', 0, { workItemId: 1 })], more: false } });
    await flush();
    expect(page.state().items.map((item) => item.id)).toEqual(['b1']);
    page.close();
  });

  it('ends on the work item clicked last, whatever order the selects answer in', async () => {
    const { page, source } = start(/select/);

    helloFor(source, 1, 3);
    root.querySelector<HTMLElement>('[data-action="picker"]')!.click();
    root.querySelector<HTMLElement>('.conversation-menu [data-work-item="2"]')!.click();
    root.querySelector<HTMLElement>('[data-action="picker"]')!.click();
    root.querySelector<HTMLElement>('.conversation-menu [data-work-item="1"]')!.click();
    expect(pending).toHaveLength(1);
    source.emit('scope', { scope: scopeOf(2, 4, 's2') });
    helloFor(source, 2, 4);
    pending.shift()!.resolve({ status: 200, body: { scopeGen: 4 } });
    await flush();
    expect(pending.map((one) => one.url)).toEqual(['/v1/conversation/select']);
    expect(posts.at(-1)!.body['workItemId']).toBe(1);
    expect(location.hash).toBe('#w=1');
    page.close();
  });

  it("unlocks a card whose answer was refused after the hub took it", async () => {
    const { page, source } = start(/send/);

    helloFor(source, 1, 3, [reply('r1', 1, { opening: 'Pick:\n- A) x\n- B) y' })]);
    root.querySelector<HTMLElement>('[data-action="card-pick"][data-letter="A"]')!.click();
    root.querySelector<HTMLElement>('[data-action="card-send"]')!.click();
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm5' } } });
    await flush();
    source.emit('message', { message: message('m5', 9, { workItemId: 1, delivery: 'not-sent', error: 'The session ended.', text: '[answers]\n- pick: Pick: → A) x' }) });
    expect(root.querySelector('.qc-error')!.textContent).toBe('The session ended.');
    expect(root.querySelector<HTMLButtonElement>('[data-action="card-send"]')!.disabled).toBe(false);
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.value).toBe('');
    page.close();
  });

  it("answers a Codex session's permission and questions with the answer command", async () => {
    const { page, source } = start(/never/);
    const requests = [
      { id: 'q1', title: 'Codex asks', kind: 'question', questions: [{ id: 'port', question: 'Port?', options: ['8765', '8799'] }, { id: 'key', question: 'Key?', options: [], secret: true }], decisions: [] },
      { id: 'p1', title: 'Run npm test?', kind: 'permission', questions: [], decisions: ['accept', 'decline'] },
      { id: 'u1', title: 'Something else', kind: 'unsupported', questions: [], decisions: [] },
    ];

    source.emit('hello', { key: 'pk', groups: [], scope: scopeOf(1, 3, 's1'), sessions: [session({ id: 's1', provider: 'codex', state: 'waiting', waitingFor: 'question', requests } as never)], items: [], more: false, state: null, artifacts: [] });
    expect(root.querySelector('#panel')!.textContent).toContain('Answer it in the terminal.');
    expect(root.querySelector<HTMLInputElement>('.request-field[data-field="q1:key"]')!.type).toBe('password');
    root.querySelector<HTMLElement>('[data-action="request-decision"][data-decision="accept"]')!.click();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/answer'))?.body).toMatchObject({ sessionId: 's1', requestId: 'p1', answer: 'accept', scopeGen: 3 });

    root.querySelector<HTMLElement>('[data-action="request-option"][data-value="8799"]')!.click();
    root.querySelector<HTMLElement>('[data-action="request-answer"]')!.click();
    await flush();
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('Answer "Key?" first.');

    const secret = root.querySelector<HTMLInputElement>('.request-field[data-field="q1:key"]')!;

    secret.value = 'abc';
    secret.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLElement>('[data-action="request-answer"]')!.click();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/answer')).at(-1)?.body).toMatchObject({ requestId: 'q1', answer: { port: '8799', key: 'abc' } });
    page.close();
  });
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  /** Types `text` into the box as the operator does, the caret at its end. */
  const typeIn = (text: string) => {
    const input = root.querySelector('textarea')!;

    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event('input'));
  };
  const key = (name: string, init: KeyboardEventInit = {}) => root.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
  const commands = { status: 200, body: { commands: [{ name: 'compact', description: 'Compact it' }, { name: 'clear', description: '' }] } };
  const sends = () => posts.filter((post) => post.url.endsWith('/send')).map((post) => post.body);

  it('sends a /name recalled or typed again by hand escaped, and the chosen one as a command while the text starts with it (architecture.md § Slash commands)', async () => {
    const { page, source } = start(/commands/);
    const input = root.querySelector('textarea')!;

    helloFor(source, 1, 3, [message('m1', 1, { text: '/compact' })]);
    const choose = async () => {
      typeIn('/co');
      pending.shift()!.resolve(commands);
      await flush();
      key('Tab');
      expect(input.value).toBe('/compact ');
    };

    // Chosen, then emptied: an earlier /compact recalled goes as a message.
    await choose();
    typeIn('');
    key('ArrowUp');
    expect(input.value).toBe('/compact');
    key('Enter');
    await flush();
    expect(sends().at(-1)).toMatchObject({ text: '/compact' });
    expect(sends().at(-1)).not.toHaveProperty('command');

    // Chosen, a walk up and back down: the draft comes back still chosen.
    await choose();
    key('ArrowUp');
    expect(input.value).toBe('/compact');
    key('ArrowDown');
    expect(input.value).toBe('/compact ');
    key('Enter');
    await flush();
    expect(sends().at(-1)).toMatchObject({ text: '/compact ', command: true });

    // Chosen, emptied and typed again by hand: a message.
    await choose();
    typeIn('');
    typeIn('/compact');
    pending.shift()!.resolve({ status: 200, body: { commands: [] } });
    await flush();
    key('Escape');
    key('Enter');
    await flush();
    expect(sends().at(-1)).toMatchObject({ text: '/compact' });
    expect(sends().at(-1)).not.toHaveProperty('command');
    expect(sends()).toHaveLength(3);
    page.close();
  });
  it("drops the composer list's answer that comes after Escape, a dictated piece or another selection, and closes an open list on a selection", async () => {
    const { page, source } = start(/commands|files/);
    const menu = root.querySelector<HTMLElement>('.composer-menu')!;

    helloFor(source, 1, 3);
    typeIn('/co');
    key('Escape');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(true);

    // A window blur also drops an answer still on its way.
    typeIn('/co');
    window.dispatchEvent(new Event('blur'));
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(true);

    // A piece dictation joins changes the text the answer was for.
    typeIn('/co');
    source.emit('draft', { text: 'now', sessionId: 's1', added: 'now' });
    expect(root.querySelector('textarea')!.value).toBe('/co now');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(true);

    // A list already open closes on a piece, so Enter sends the text rather than picking for the text before it.
    typeIn('/co');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(false);
    source.emit('draft', { text: 'now more', sessionId: 's1', added: 'more' });
    expect(menu.hidden).toBe(true);
    expect(root.querySelector('textarea')!.value).toBe('/co more');

    // Another work item chosen before its scope comes.
    typeIn('see @sr');
    click('[data-action="picker"]');
    click('.conversation-menu [data-work-item="2"]');
    pending.shift()!.resolve({ status: 200, body: { files: [{ path: 'src/a.ts', dir: false }] } });
    await flush();
    expect(menu.hidden).toBe(true);

    // Sending closes a list open for the text sent, and drops one still on its way.
    typeIn('/co');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(false);
    root.querySelector<HTMLButtonElement>('.composer button.send')!.click();
    expect(menu.hidden).toBe(true);
    await flush();
    typeIn('/co');
    root.querySelector<HTMLButtonElement>('.composer button.send')!.click();
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(true);

    // A list already open closes at once.
    helloFor(source, 1, 5);
    typeIn('see @sr');
    pending.shift()!.resolve({ status: 200, body: { files: [{ path: 'src/a.ts', dir: false }] } });
    await flush();
    expect(menu.hidden).toBe(false);
    click('[data-action="picker"]');
    click('.conversation-menu [data-work-item="2"]');
    expect(menu.hidden).toBe(true);
    page.close();
  });
  it('picks from the composer list only on a bare Enter or Tab, and leaves keys an input method composes with to it', async () => {
    const { page, source } = start(/commands/);
    const input = root.querySelector('textarea')!;
    const menu = root.querySelector<HTMLElement>('.composer-menu')!;

    helloFor(source, 1, 3);
    typeIn('/co');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.hidden).toBe(false);

    // Shift+Enter and Shift+Tab keep their own meaning, a new line and the focus moving back.
    expect(key('Enter', { shiftKey: true })).toBe(true);
    expect(key('Tab', { shiftKey: true })).toBe(true);
    // Ctrl, Alt or Meta with Enter or Tab do nothing.
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
      expect(key('Enter', { [modifier]: true })).toBe(false);
      expect(key('Tab', { [modifier]: true })).toBe(false);
    }

    // An input method's Enter, marked as composing or only by key code 229, is its own, with the list open or not.
    key('Enter', { isComposing: true });
    key('Enter', { keyCode: 229 });
    expect(input.value).toBe('/co');
    expect(menu.hidden).toBe(false);
    key('Escape');
    key('Enter', { isComposing: true });
    key('Enter', { keyCode: 229 });
    await flush();
    expect(input.value).toBe('/co');
    expect(sends()).toEqual([]);
    page.close();
  });
  it('keeps the focus in the box while a send is on its way with the mic on, keeping dictation in the draft, and gives it up only once the hub took the message (architecture.md § Dictation)', async () => {
    const { page, source } = start(/send/);
    const input = root.querySelector('textarea')!;
    const told = () => posts.filter((post) => post.url.endsWith('/composer')).map((post) => post.body);

    helloFor(source, 1, 3);
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: true, error: null } });
    input.focus();
    typeIn('fix it');
    const before = told().length;

    key('Enter');
    await flush();
    expect(document.activeElement).toBe(input);
    // The hub takes its draft with the message: no update empties it first, which could reach the hub before the send.
    expect(told().slice(before)).toEqual([]);

    // A piece heard meanwhile waits for the answer; refused, it joins the text kept, and the hub's draft becomes the box's.
    source.emit('draft', { text: 'and more', sessionId: 's1', added: 'and more' });
    pending.shift()!.resolve({ status: 409, body: { error: 'The session ended.' } });
    await flush();
    expect(input.value).toBe('fix it and more');
    expect(document.activeElement).toBe(input);
    expect(told().at(-1)).toMatchObject({ focused: true, draft: 'fix it and more' });

    // Sent with Send, whose press leaves the focus in the box, and taken: the box empties and gives up the focus, so spoken turns send on
    // their own again.
    const sendButton = root.querySelector<HTMLButtonElement>('.composer button.send')!;

    expect(sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))).toBe(false);
    sendButton.click();
    await flush();
    expect(document.activeElement).toBe(input);
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm5' } } });
    await flush();
    expect(input.value).toBe('');
    expect(document.activeElement).not.toBe(input);
    expect(told().at(-1)).toMatchObject({ focused: false, draft: '' });
    expect(sends().map((one) => one['text'])).toEqual(['fix it', 'fix it and more']);
    page.close();
  });
  it("names the composer list and its active option for screen readers, as the box's list", async () => {
    const { page, source } = start(/commands/);
    const input = root.querySelector('textarea')!;
    const menu = root.querySelector<HTMLElement>('.composer-menu')!;
    const selected = () => [...menu.querySelectorAll('[role="option"]')].map((option) => option.getAttribute('aria-selected'));

    helloFor(source, 1, 3);
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-controls')).toBe(menu.id);
    expect(menu.getAttribute('role')).toBe('listbox');
    typeIn('/c');
    pending.shift()!.resolve(commands);
    await flush();
    expect(menu.getAttribute('aria-label')).toBe('Slash commands');
    expect(selected()).toEqual(['true', 'false']);
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)!.textContent).toContain('/compact');
    key('ArrowDown');
    expect(selected()).toEqual(['false', 'true']);
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)!.textContent).toContain('/clear');
    key('Escape');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);

    // Nothing found is an option that cannot be chosen, and no option is active.
    typeIn('/z');
    pending.shift()!.resolve({ status: 200, body: { commands: [] } });
    await flush();
    expect(menu.querySelector('[role="option"]')!.getAttribute('aria-disabled')).toBe('true');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    page.close();
  });
  it("sends a message with the last dictated piece its box holds, after every composer update, and keeps only the pieces heard while it is on its way (architecture.md § Dictation)", async () => {
    const { page, source } = start(/send/);
    const input = root.querySelector('textarea')!;
    const told = () => posts.filter((post) => post.url.endsWith('/composer')).map((post) => post.body);

    helloFor(source, 1, 3);
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: true, error: null } });
    input.focus();
    typeIn('Also,');
    source.emit('draft', { text: 'Also, fix it', sessionId: 's1', added: 'fix it', piece: 41 });
    expect(input.value).toBe('Also, fix it');
    key('Enter');
    await flush();
    const sent = sends().at(-1)!;
    const seqs = told().map((body) => body['seq'] as number);

    expect(sent).toMatchObject({ text: 'Also, fix it', heard: 41 });
    expect(seqs.length).toBeGreaterThan(0);
    expect(sent['composerSeq']).toBeGreaterThan(Math.max(...seqs));

    // The hub's text still holds the message until it takes it: only the piece is kept. A blur meanwhile tells the focus alone, numbered
    // after the send.
    source.emit('draft', { text: 'Also, fix it and more', sessionId: 's1', added: 'and more', piece: 42 });
    input.blur();
    expect(told().at(-1)).toEqual({ scopeGen: 3, window: 'pk', opId: expect.any(String), focused: false, listen: true, seq: (sent['composerSeq'] as number) + 1, heard: 42 });
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm5' } } });
    await flush();
    expect(input.value).toBe('and more');

    // Refused, the box keeps its text and the piece heard meanwhile joins it once.
    input.focus();
    key('Enter');
    await flush();
    expect(sends().at(-1)).toMatchObject({ text: 'and more', heard: 42 });
    source.emit('draft', { text: 'and more again', sessionId: 's1', added: 'again', piece: 43 });
    pending.shift()!.resolve({ status: 409, body: { error: 'The session ended.' } });
    await flush();
    expect(input.value).toBe('and more again');
    expect(told().at(-1)).toMatchObject({ focused: true, draft: 'and more again' });
    page.close();
  });
  it('keeps a piece heard while a message is on its way over an older draft event, and as the draft of a work item no longer shown (architecture.md § Dictation)', async () => {
    const { page, source } = start(/send/);
    const input = root.querySelector('textarea')!;

    helloFor(source, 1, 3);
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: true, error: null } });
    input.focus();
    typeIn('fix it');
    key('Enter');
    await flush();
    // An older draft without a piece, then a piece: taken, the box holds the piece, which the older draft does not drop.
    source.emit('draft', { text: '', sessionId: 's1' });
    source.emit('draft', { text: 'fix it and more', sessionId: 's1', added: 'and more', piece: 42 });
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm5' } } });
    await flush();
    expect(input.value).toBe('and more');

    // Sent, then another work item shown before the answer: a piece heard meanwhile becomes the first work item's draft.
    input.focus();
    key('Enter');
    await flush();
    expect(sends().at(-1)).toMatchObject({ text: 'and more', heard: 42 });
    helloFor(source, 2, 4);
    source.emit('draft', { text: 'and more then lint', sessionId: 's1', added: 'then lint', piece: 43 });
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm6' } } });
    await flush();
    expect(input.value).toBe('');
    helloFor(source, 1, 5);
    expect(input.value).toBe('then lint');

    // A piece for the session shown meanwhile joins its box once the send answered, after the operator's edits, and its next send names it.
    key('Enter');
    await flush();
    helloFor(source, 2, 6);
    typeIn('Also,');
    source.emit('draft', { text: 'check it', sessionId: 's2', added: 'check it', piece: 44 });
    expect(input.value).toBe('Also,');
    pending.shift()!.resolve({ status: 200, body: { message: { id: 'm7' } } });
    await flush();
    expect(input.value).toBe('Also, check it');
    key('Enter');
    await flush();
    expect(sends().at(-1)).toMatchObject({ text: 'Also, check it', heard: 44 });
    page.close();
  });
});
