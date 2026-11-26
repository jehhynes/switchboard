import { afterEach, onTestFinished, beforeEach, describe, expect, it, vi } from 'vitest';
import { html } from './html.js';
import { loadMermaid, startPage } from '../src/main.js';
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

  it("draws a Markdown artifact's links as claude-collab does, redraws a new version in place, and opens it as drawn in a new window", async () => {
    const { page, source } = start();

    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan\n\n[page](p.html) [notes](plan/notes.txt) [up](../x.md) [web](https://example.com/a) [uri](file:///D:/w/src/a.ts#L3)\n\n| a | b |\n|---|---|\n| 1 | 2 |' };
    hello(source);
    click('#head .artifact-tab[data-path="chat/plan.md"]');
    await flush();
    await flush();

    const doc = root.querySelector<HTMLElement>('.artifact-doc')!;

    expect(root.querySelector('.artifact-badge')!.textContent).toBe('page');
    expect(doc.querySelector('table td')!.textContent).toBe('1');
    // Another artifact opens in place; another file of the folder in a new tab; a target outside the folder stays text.
    expect(doc.querySelector('a[data-path="chat/p.html"]')!.getAttribute('data-action')).toBe('artifact');
    expect(doc.querySelector('a[href$="plan/notes.txt"]')!.getAttribute('target')).toBe('_blank');
    expect(doc.querySelector('a.path-link')!.textContent).toBe('up');
    // A file: URI names no artifact: it opens in a file tab.
    expect([...doc.querySelectorAll<HTMLElement>('a.path-link')].map((one) => one.dataset['target'])).toEqual(['../x.md', 'D:/w/src/a.ts#L3']);
    expect(doc.querySelector('a[href="https://example.com/a"]')!.getAttribute('target')).toBe('_blank');

    // A new version is fetched again and keeps the reader's place.
    doc.scrollTop = 40;
    const fetches = posts.filter((post) => post.url.includes('/artifact/')).length;

    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan v2\n\n![pic](plan/pic.png) [page](p.html)' };
    source.emit('artifact', { artifact: { ...artifact('chat/plan.md', 'markdown', 'md'), updatedAt: 2_000 } });
    await flush();
    await flush();
    expect(posts.filter((post) => post.url.includes('/artifact/')).length).toBe(fetches + 1);
    expect(root.querySelector('.artifact-view')!.getAttribute('data-version')).toBe('2000');
    expect(root.querySelector('.artifact-doc h1')!.textContent).toBe('Plan v2');
    expect(root.querySelector<HTMLElement>('.artifact-doc')!.scrollTop).toBe(40);

    // The same version is not fetched again on a redraw.
    source.emit('unread', { unread: 0 });
    await flush();
    expect(posts.filter((post) => post.url.includes('/artifact/')).length).toBe(fetches + 1);

    // An answer that comes after a newer version replaced its own is dropped.
    let late: () => void = () => {};

    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan v3', wait: new Promise<void>((resolve) => (late = resolve)) };
    source.emit('artifact', { artifact: { ...artifact('chat/plan.md', 'markdown', 'md'), updatedAt: 3_000 } });
    await flush();
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan v2\n\n![pic](plan/pic.png) [page](p.html)' };
    source.emit('artifact', { artifact: { ...artifact('chat/plan.md', 'markdown', 'md'), updatedAt: 4_000 } });
    await flush();
    await flush();
    late();
    await flush();
    await flush();
    expect(root.querySelector('.artifact-view')!.getAttribute('data-version')).toBe('4000');
    expect(root.querySelector('.artifact-doc h1')!.textContent).toBe('Plan v2');

    // Another selection's artifact of the same path and time is fetched for it, never shown from the last one's.
    const before = posts.filter((post) => post.url.includes('/artifact/')).length;

    source.emit('scope', { scope: { ...scope, scopeGen: scope.scopeGen + 1 } });
    await flush();
    await flush();
    expect(posts.filter((post) => post.url.includes('/artifact/')).length).toBe(before + 1);

    // Open in new window: the drawn document, without copy buttons, as a page of its own.
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    let blob: Blob | null = null;

    Object.assign(URL, { createObjectURL: vi.fn((value: Blob) => ((blob = value), 'blob:x')), revokeObjectURL: vi.fn() });
    click('[data-action="artifact-window"]');
    expect(opened).toHaveBeenCalledWith('blob:x', '_blank', 'noopener');

    const html = await blob!.text();

    expect(html).toContain('<h1 data-anchor="plan-v2" id="plan-v2">Plan v2</h1>');
    expect(html).toContain('class="artifact-window"');
    expect(html).toContain('/page/page.css');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).not.toContain('data-action="close-artifact"');
    // Its pictures and links name the hub in full, since a blob: document has no base for the page's paths.
    expect(html).toContain(`src="${location.origin}/v1/conversation/artifact/pk/chat/plan/pic.png"`);
    expect(html).toContain(`href="${location.origin}/v1/conversation/artifact/pk/chat/p.html"`);
    expect(html).not.toContain('data-action="artifact"');

    // A link to another artifact opens it in place.
    answers['/artifact/'] = { status: 200, body: {}, text: '[page](p.html)' };
    source.emit('artifact', { artifact: { ...artifact('chat/plan.md', 'markdown', 'md'), updatedAt: 3_000 } });
    await flush();
    await flush();
    click('.artifact-doc a[data-path="chat/p.html"]');
    expect(root.querySelector('iframe')!.getAttribute('src')).toBe('/v1/conversation/artifact/pk/chat/p.html?v=1500');
    page.close();
  });

  it('scrolls to the heading or footnote a #name link in a Markdown artifact names, by click or Enter, without changing the route, and links them in a new window', async () => {
    const { page, source } = start();

    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan\n\n[to notes](#notes) and a note[^1] [hidden](#hidden)\n\n## Notes\n\n<details>\n<summary>Out</summary>\n\n<details>\n<summary>In</summary>\n\n### Hidden\n\n</details>\n</details>\n\n[^1]: The note.' };
    hello(source);
    click('#head .artifact-tab[data-path="chat/plan.md"]');
    await flush();
    await flush();

    const doc = root.querySelector<HTMLElement>('.artifact-doc')!;
    const shown: string[] = [];

    expect(doc.classList.contains('md-doc')).toBe(true);
    Object.assign(HTMLElement.prototype, { scrollIntoView(this: HTMLElement) { shown.push(this.getAttribute('data-anchor') ?? ''); } });
    onTestFinished(() => {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    });

    const hash = location.hash;

    click('.artifact-doc a.anchor-link[data-target="notes"]');
    click('.artifact-doc sup.footnote-ref a');
    doc.querySelector<HTMLElement>('.footnote-backref')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(shown).toEqual(['notes', '^fn1', '^fnref1']);
    // A place inside closed sections opens each of them first.
    expect([...doc.querySelectorAll('details')].map((one) => one.open)).toEqual([false, false]);
    click('.artifact-doc a.anchor-link[data-target="hidden"]');
    expect([...doc.querySelectorAll('details')].map((one) => one.open)).toEqual([true, true]);
    expect(shown.at(-1)).toBe('hidden');
    expect(location.hash).toBe(hash);

    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    let blob: Blob | null = null;

    Object.assign(URL, { createObjectURL: vi.fn((value: Blob) => ((blob = value), 'blob:x')), revokeObjectURL: vi.fn() });
    click('[data-action="artifact-window"]');
    expect(opened).toHaveBeenCalled();

    const html = await blob!.text();

    expect(html).toContain('<h2 data-anchor="notes" id="notes">Notes</h2>');
    expect(html).toMatch(/<a class="anchor-link" tabindex="0" role="link" data-target="notes" href="#notes">to notes<\/a>/);
    page.close();
  });

  it("moves a dragged Ready for review row with row-move, drawing its drop line, without the release's click, and shows a refused move in the toast (PRD R73)", async () => {
    const { page, source } = start();
    const move = (label: string) => ({ label, action: 'move' as const, icon: 'arrow-up', group: 'order' as const, confirm: null, input: null });
    const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

    hello(source, { groups: [listGroup('review', [listRow(1, { actions: [move('Move down')] }), listRow(2), listRow(3, { actions: [move('Move up')] })]), listGroup('progress', [listRow(4)])] });
    // The list from the top, Ready for review's heading 32 px tall, then its rows 40 px apart and In progress's.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = Number((this as HTMLElement).dataset?.['workItem'] ?? NaN);

      return this.id === 'list' ? rect(0, 600) : this.classList.contains('group-head') ? rect(this.closest('[data-group="review"]') === null ? 160 : 0, 32) : this.classList.contains('row') && id > 0 ? rect(id * 40, 40) : rect(0, 0);
    });

    const list = root.querySelector<HTMLElement>('#list')!;
    const row = (id: number) => list.querySelector<HTMLElement>(`.row[data-work-item="${id}"]`)!;
    const pointer = (target: Element, type: string, y: number) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: 20, clientY: y }));

    expect([1, 2, 3].map((id) => row(id).classList.contains('movable'))).toEqual([true, true, true]);
    expect(row(4).classList.contains('movable')).toBe(false);
    pointer(row(3), 'pointerdown', 140);
    pointer(list, 'pointermove', 50);
    expect(row(3).classList.contains('dragging')).toBe(true);
    expect([...list.querySelectorAll<HTMLElement>('.drop-above, .drop-below')].map((one) => [one.dataset['workItem'], one.classList.contains('drop-above')])).toEqual([['1', true]]);
    pointer(list, 'pointerup', 50);
    row(3).click();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/row-move')).map((post) => post.body)).toEqual([{ window: 'pk', opId: expect.any(String), workItemId: 3, after: null }]);
    expect(posts.some((post) => post.url.endsWith('/select'))).toBe(false);
    expect(list.querySelector('.dragging, .drop-above, .drop-below')).toBeNull();

    // Below the last row, the hub refuses: the toast says why.
    answers['/row-move'] = { status: 409, body: { error: 'The work item is not in Ready for review.' } };
    pointer(row(1), 'pointerdown', 60);
    pointer(list, 'pointermove', 150);
    expect(row(3).classList.contains('drop-below')).toBe(true);
    pointer(list, 'pointerup', 150);
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/row-move')).at(-1)?.body).toMatchObject({ workItemId: 1, after: 3 });
    expect(root.querySelector('#toast .toast-text')?.textContent).toBe('The work item is not in Ready for review.');
    page.close();
  });

  it('moves the selected Ready for review row with Alt+Up and Alt+Down, not while typing, with other keys held, or for a row in another group (PRD R73)', async () => {
    const { page, source } = start();
    const move = (label: string) => ({ label, action: 'move' as const, icon: 'arrow-up', group: 'order' as const, confirm: null, input: null });
    const press = (target: EventTarget, key: string, patch: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true, ...patch }));
    const moves = () => posts.filter((post) => post.url.endsWith('/row-action')).map((post) => [post.body['workItemId'], post.body['label']]);

    hello(source, { groups: [listGroup('review', [listRow(5, { actions: [move('Move down')] }), listRow(1, { actions: [move('Move to top'), move('Move up'), move('Move down')] })])] });
    expect(press(document.body, 'ArrowUp')).toBe(false);
    await flush();
    press(document.body, 'ArrowDown');
    await flush();
    expect(moves()).toEqual([[1, 'Move up'], [1, 'Move down']]);

    press(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!, 'ArrowUp');
    press(document.body, 'ArrowUp', { shiftKey: true });
    press(document.body, 'ArrowUp', { ctrlKey: true });
    press(document.body, 'ArrowUp', { altKey: false });
    await flush();
    expect(moves()).toHaveLength(2);

    // The last row has no Move down, and a row in another group none at all.
    source.emit('list', { groups: [listGroup('review', [listRow(5, { actions: [move('Move down')] }), listRow(1, { actions: [move('Move up')] })])] });
    expect(press(document.body, 'ArrowDown')).toBe(true);
    source.emit('list', { groups: [listGroup('progress', [listRow(1, { actions: [move('Move up')] })])] });
    press(document.body, 'ArrowUp');
    await flush();
    expect(moves()).toHaveLength(2);
    page.close();
  });

  it('counts the Blocked on you rows in the page title, and drops the count when none is left', () => {
    const { page, source } = start();

    hello(source, { groups: [listGroup('blocked', [listRow(1), listRow(4)]), listGroup('review', [listRow(5)])] });
    expect(document.title).toBe('(2) Switchboard');
    source.emit('list', { groups: [listGroup('blocked', []), listGroup('review', [listRow(5)])] });
    expect(document.title).toBe('Switchboard');
    page.close();
  });

  it("keeps a row's sheet modal: Snooze starts on its first choice, the page under it is inert, and closing it from Cancel or an Escape on the page's body gives the focus back to Actions", async () => {
    const { page, source } = start();
    const actions = [{ label: 'Snooze…', action: 'snooze', icon: 'clockface', group: 'state' as const, confirm: null, input: null }];
    // A press, as a pointer gives one, and the click after it; Safari's press does not focus a button.
    const press = (selector: string) => {
      root.querySelector(selector)!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      click(selector);
    };
    const snooze = () => {
      press('button.actions');
      press('.actions-menu [data-label="Snooze…"]');
    };

    hello(source, { groups: [listGroup('review', [listRow(1, { title: 'Fix it', actions })])] });
    snooze();
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Snooze Fix it');
    expect(document.activeElement).toBe(root.querySelector('.sheet input[name="snooze"]'));
    expect(root.querySelector('#head')!.closest('[inert]')).not.toBeNull();
    expect(root.querySelector('.side')!.closest('[inert]')).not.toBeNull();
    expect(root.querySelector('.sheet')!.closest('[inert]')).toBeNull();
    expect(root.querySelector('#toast')!.closest('[inert]')).toBeNull();
    press('.sheet [data-action="sheet-cancel"]');
    expect(root.querySelector('.sheet')).toBeNull();
    expect(root.querySelector('[inert]')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('button.actions'));

    // A press on the sheet's text leaves the focus on the page's body; Escape there still closes the sheet.
    snooze();
    (document.activeElement as HTMLElement).blur();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(root.querySelector('.sheet')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('button.actions'));
    page.close();
  });

  it("runs the selected work item's row actions from the header: the main button, Stop session and Delete after their question, Snooze with a choice, and Copy", async () => {
    const { page, source } = start();
    const actions = [
      { label: 'Approve', action: 'approve', icon: 'check', group: 'main' as const, confirm: null, input: null },
      { label: 'Stop session', action: 'stop', icon: 'debug-stop', group: 'work' as const, confirm: { question: 'Stop the session for gh 1?', detail: 'It stops.', action: 'Stop session' }, input: null },
      { label: 'Mark done', action: 'mark-done', icon: 'pass', group: 'state' as const, confirm: null, input: null },
      { label: 'Snooze…', action: 'snooze', icon: 'clockface', group: 'state' as const, confirm: null, input: null },
      { label: 'Move up', action: 'move', icon: 'arrow-up', group: 'order' as const, confirm: null, input: null },
      { label: 'Delete', action: 'delete', icon: 'trash', group: 'asking' as const, confirm: { question: 'Delete gh 1?', detail: 'Gone.', action: 'Delete' }, input: null },
    ];
    const clipboard = vi.fn(async () => undefined);

    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
    hello(source, { groups: [listGroup('review', [listRow(1, { title: 'Fix it', actions, main: 'Approve', pastes: ['Reply'] })])] });
    expect(root.querySelector('.header .row-main')!.textContent).toBe('Approve');
    // Its label is its tooltip too and a span of its own, which the phone's layout keeps for a screen reader and does not draw (page.css).
    expect(root.querySelector('.header .row-main')!.getAttribute('title')).toBe('Approve');
    expect(root.querySelector('.header .row-main > .row-main-label')!.textContent).toBe('Approve');
    click('.header .row-main');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ window: 'pk', scopeGen: 3, workItemId: 1, label: 'Approve' });
    expect(root.querySelector('.header .row-main .codicon-check')).not.toBeNull();

    click('button.actions');
    // The row menu's groups: main, work, state, order, what the row opens, and what asks first.
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Approve', 'Stop session', 'Mark done', 'Snooze…', 'Move up', 'Copy Reply', 'Delete']);
    expect(root.querySelectorAll('.actions-menu .menu-separator')).toHaveLength(5);
    click('.actions-menu [data-label="Move up"]');
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/row-action')).at(-1)?.body).toMatchObject({ workItemId: 1, label: 'Move up' });
    click('button.actions');
    click('.actions-menu [data-label="Stop session"]');
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Stop the session for gh 1?');
    posts = [];
    click('.sheet [data-action="sheet-cancel"]');
    expect(root.querySelector('.sheet')).toBeNull();
    expect(posts).toEqual([]);

    click('button.actions');
    click('.actions-menu [data-label="Delete"]');
    // The question starts on Cancel, and neither Enter nor Ctrl+Enter deletes.
    expect(document.activeElement).toBe(root.querySelector('.sheet [data-action="sheet-cancel"]'));
    root.querySelector('.sheet')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    root.querySelector('.sheet')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await flush();
    expect(posts).toEqual([]);
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Delete gh 1?');
    answers['/row-action'] = { status: 409, body: { error: 'The work item no longer offers this.' } };
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ label: 'Delete', workItemId: 1 });
    // A refusal shows in the toast, in the warning colours, rather than over the composer.
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The work item no longer offers this.');
    expect(root.querySelector('.toast')!.getAttribute('role')).toBe('alert');
    expect(root.querySelector('#composer .toast, #composer [role="alert"]')).toBeNull();
    expect(root.querySelector('.sheet')).toBeNull();

    answers['/row-action'] = { status: 200, body: { done: true } };
    posts = [];
    click('button.actions');
    click('.actions-menu [data-label="Snooze…"]');
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Snooze Fix it');
    const second = root.querySelectorAll<HTMLInputElement>('.sheet input[name="snooze"]')[1]!;
    const note = root.querySelector<HTMLTextAreaElement>('.snooze-comment')!;

    second.checked = true;
    second.dispatchEvent(new Event('change', { bubbles: true }));
    note.value = 'after the release';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    // A stream event redraws the page; the choice and the comment stay.
    source.emit('list', { groups: [listGroup('review', [listRow(1, { title: 'Fix it', actions, main: 'Approve', pastes: ['Reply'] })])] });
    expect(root.querySelectorAll<HTMLInputElement>('.sheet input[name="snooze"]')[1]!.checked).toBe(true);
    expect(root.querySelector<HTMLTextAreaElement>('.snooze-comment')!.value).toBe('after the release');
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ label: 'Snooze…', until: expect.any(Number), comment: 'after the release' });

    answers['/row-paste'] = { status: 200, body: { text: 'Dear Ana' } };
    click('button.actions');
    click('.actions-menu [data-action="row-paste"]');
    await flush();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-paste'))?.body).toMatchObject({ workItemId: 1, label: 'Reply' });
    expect(clipboard).toHaveBeenCalledWith('Dear Ana');
    // A copy that worked says so in the neutral toast.
    expect(root.querySelector('.toast.info .toast-text')?.textContent).toBe('Copied Reply.');

    // A draft the hub could not read says why, in the warning colours.
    answers['/row-paste'] = { status: 409, body: { error: 'Reply could not be read: the file is gone.' } };
    click('button.actions');
    click('.actions-menu [data-action="row-paste"]');
    await flush();
    await flush();
    expect(root.querySelector('.toast.warning .toast-text')?.textContent).toBe('Reply could not be read: the file is gone.');
    expect(clipboard).toHaveBeenCalledTimes(1);

    // The menu belongs to the work item it was opened on.
    click('button.actions');
    click('#list [data-work-item="1"]');
    expect(root.querySelector('.actions-menu')).toBeNull();
    page.close();
  });

  it('opens a Copy submenu of the labels for several drafts, copies the one chosen with "Copied <label>.", and shows a draft the clipboard refused to copy by hand', async () => {
    const { page, source } = start();
    let allowed = true;
    const clipboard = vi.fn(async () => (allowed ? undefined : Promise.reject(new Error('NotAllowedError'))));

    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
    hello(source, { groups: [listGroup('review', [listRow(1, { pastes: ['Reply', 'Summary'] })])] });
    click('button.actions');
    // One Copy item, closed, in place of an item per draft.
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Copy']);
    expect(root.querySelector('.actions-menu [data-action="copy-menu"]')!.getAttribute('aria-expanded')).toBe('false');
    click('.actions-menu [data-action="copy-menu"]');
    expect(root.querySelector('.actions-menu [data-action="copy-menu"]')!.getAttribute('aria-expanded')).toBe('true');
    expect([...root.querySelectorAll('.actions-menu .submenu-row')].map((row) => row.textContent)).toEqual(['Reply', 'Summary']);

    answers['/row-paste'] = { status: 200, body: { text: 'Done: the fix.' } };
    click('.actions-menu .submenu-row[data-label="Summary"]');
    await flush();
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-paste'))?.body).toMatchObject({ workItemId: 1, label: 'Summary' });
    expect(clipboard).toHaveBeenCalledWith('Done: the fix.');
    expect(root.querySelector('.toast.info .toast-text')?.textContent).toBe('Copied Summary.');
    // The menu closed with its submenu, which opens closed next time.
    expect(root.querySelector('.actions-menu')).toBeNull();
    click('button.actions');
    expect(root.querySelector('.actions-menu .submenu-row')).toBeNull();

    // A refused clipboard confirms nothing: the sheet shows the text to copy.
    allowed = false;
    click('.actions-menu [data-action="copy-menu"]');
    click('.actions-menu .submenu-row[data-label="Reply"]');
    await flush();
    await flush();
    await flush();
    expect(root.querySelector('.sheet-title')?.textContent).toBe('Copy Reply');
    expect(root.querySelector<HTMLTextAreaElement>('.sheet-text')?.value).toBe('Done: the fix.');
    expect(root.querySelector('.toast-text')?.textContent).not.toBe('Copied Reply.');
    page.close();
  });

  it("asks for a control's text in an input sheet, with its choice, and sends the text and a changed choice by the control's label", async () => {
    const { page, source } = start();
    const guided = { label: 'Start with guidance…', action: 'start', icon: 'comment', group: 'work' as const, confirm: null, input: { question: 'Start with guidance', detail: 'It ends the prompt.', action: 'Start', text: null, choice: { label: 'Playbook', value: 'dev:build', values: ['dev:build', 'dev:fix'] } } };
    const prompted = { label: 'Start with prompt…', action: 'start', icon: 'edit', group: 'main' as const, confirm: null, input: { question: 'Start with prompt', detail: 'The session runs it.', action: 'Start', text: 'Fix the build', choice: null } };
    const comment = { label: 'Add comment…', action: 'comment', icon: 'comment', group: 'notes' as const, confirm: null, input: { question: 'Add comment', detail: 'Kept here.', action: 'Add', text: null, choice: null } };
    const type = (selector: string, value: string) => {
      const field = root.querySelector<HTMLTextAreaElement | HTMLSelectElement>(selector)!;

      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    };

    answers['/row-action'] = { status: 200, body: { done: true } };
    hello(source, { groups: [listGroup('unstarted', [listRow(1, { title: 'Fix it', actions: [prompted, guided, comment], main: 'Start with prompt…' })])] });
    // A main control that asks for text opens its sheet, with the text it starts with.
    click('.header .row-main');
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Start with prompt');
    expect(root.querySelector<HTMLTextAreaElement>('.sheet-input')!.value).toBe('Fix the build');
    expect(document.activeElement).toBe(root.querySelector('.sheet-input'));
    type('.sheet-input', 'Fix the tests');
    root.querySelector('.sheet-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/row-action')).at(-1)?.body).toMatchObject({ workItemId: 1, label: 'Start with prompt…', text: 'Fix the tests' });
    expect(root.querySelector('.sheet')).toBeNull();

    click('button.actions');
    // Add comment… is its own group.
    expect(root.querySelectorAll('.actions-menu .menu-separator')).toHaveLength(2);
    click('.actions-menu [data-label="Start with guidance…"]');
    expect(root.querySelector<HTMLSelectElement>('.sheet-select')!.value).toBe('dev:build');
    // Neither a text nor a changed choice: the button waits.
    expect(root.querySelector<HTMLButtonElement>('.sheet [data-action="sheet-go"]')!.disabled).toBe(true);
    type('.sheet-select', 'dev:fix');
    expect(root.querySelector<HTMLButtonElement>('.sheet [data-action="sheet-go"]')!.disabled).toBe(false);
    posts = [];
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ label: 'Start with guidance…', text: '', choice: 'dev:fix' });

    click('button.actions');
    click('.actions-menu [data-label="Add comment…"]');
    type('.sheet-input', '   ');
    expect(root.querySelector<HTMLButtonElement>('.sheet [data-action="sheet-go"]')!.disabled).toBe(true);
    type('.sheet-input', ' Asked Ana ');
    // A stream event redraws the page; the text stays.
    source.emit('list', { groups: [listGroup('unstarted', [listRow(1, { title: 'Fix it', actions: [prompted, guided, comment], main: 'Start with prompt…' })])] });
    expect(root.querySelector<HTMLTextAreaElement>('.sheet-input')!.value).toBe(' Asked Ana ');
    posts = [];
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).toMatchObject({ label: 'Add comment…', text: 'Asked Ana' });
    expect(posts.find((post) => post.url.endsWith('/row-action'))?.body).not.toHaveProperty('choice');

    // Cancel posts nothing.
    click('button.actions');
    click('.actions-menu [data-label="Add comment…"]');
    posts = [];
    click('.sheet [data-action="sheet-cancel"]');
    expect(posts).toEqual([]);
    page.close();
  });

  it("runs Open in VS Code through the hub and opens Open report's draft in a file tab from the menu's opens group, and shows a refusal", async () => {
    const { page, source } = start();
    const opens = [{ label: 'Open in VS Code', icon: 'vscode' }, { label: 'Open report', icon: 'symbol-file', file: 'D:/git/wt/1/reply.md' }];

    answers['/local-file?'] = { status: 200, body: { path: 'D:/git/wt/1/reply.md', name: 'reply.md', kind: 'markdown', contents: '# Reply', tooLarge: false, size: 7, entries: null, more: false } };

    hello(source, { groups: [listGroup('review', [listRow(1, { title: 'Fix it', opens, pastes: ['Reply'], url: 'https://github.com/o/r/issues/1' })])] });
    click('button.actions');
    // One group: Copy, then what opens in VS Code, then the ticket.
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Copy Reply', 'Open in VS Code', 'Open report', 'Open ticket']);
    expect(root.querySelectorAll('.actions-menu .menu-separator')).toHaveLength(0);
    expect(root.querySelector('.actions-menu [data-label="Open in VS Code"] .codicon-vscode')).not.toBeNull();
    // Open report reads its draft through local-file into a file tab, never through VS Code.
    click('.actions-menu [data-action="row-report"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/row-command'))).toBeUndefined();
    expect(posts.some((post) => post.url.startsWith('/v1/conversation/local-file?') && post.url.endsWith(`path=${encodeURIComponent('D:/git/wt/1/reply.md')}`))).toBe(true);
    expect(root.querySelector('.actions-menu')).toBeNull();
    expect(root.querySelector('[data-action="local-tab"]')?.textContent).toContain('reply.md');

    answers['/row-command'] = { status: 409, body: { error: 'VS Code did not start: Code.exe was not found beside code on PATH.' } };
    click('button.actions');
    click('.actions-menu [data-label="Open in VS Code"]');
    await flush();
    await flush();
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('VS Code did not start: Code.exe was not found beside code on PATH.');
    page.close();
  });

  it("opens each document in one tab whatever opened it: a link or Open report to an artifact's file in the artifact's tab, and a file by two spellings in one tab", async () => {
    window.innerWidth = 1440;
    const { page, source } = start();
    const draft = 'D:/w/.wip/artifacts/w1/chat/review.md';
    const read = (path: string, name: string, artifact?: string) => ({ status: 200, body: { path, name, kind: 'markdown', contents: '# Doc', tooLarge: false, size: 5, entries: null, more: false, ...(artifact === undefined ? {} : { artifact }) } });

    answers[`path=${encodeURIComponent(draft)}`] = read(draft, 'review.md', 'chat/review.md');
    answers[`path=${encodeURIComponent('.wip/artifacts/w1/chat/plan.md')}`] = read('D:/w/.wip/artifacts/w1/chat/plan.md', 'plan.md', 'chat/plan.md');
    answers['notes.md'] = read('D:/w/notes.md', 'notes.md');
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan' };
    hello(source, {
      groups: [listGroup('review', [listRow(1, { title: 'Fix it', opens: [{ label: 'Open report', icon: 'symbol-file', file: draft }] })])],
      items: [reply('r1', 2, { opening: 'See [plan](.wip/artifacts/w1/chat/plan.md), [notes](notes.md) and [the same notes](D:/w/notes.md).' })],
      artifacts: [artifact('chat/plan.md', 'markdown', 'md'), artifact('chat/review.md', 'markdown', 'md')],
    });

    const reads = () => posts.filter((post) => post.url.startsWith('/v1/conversation/local-file?')).length;
    const files = () => [...root.querySelectorAll('#detail .local-tab .tab-label')].map((label) => label.textContent);
    const shownArtifact = () => root.querySelector<HTMLElement>('#detail .artifact-tab.selected')?.dataset['path'];

    // A link to an artifact's file shows the artifact's tab once read, and no file tab; the link again reads it again, so the hub checks it.
    click('#panel a.path-link[data-target=".wip/artifacts/w1/chat/plan.md"]');
    await flush();
    expect(files()).toEqual([]);
    expect(shownArtifact()).toBe('chat/plan.md');
    click('#detail [data-side="history"]');
    const read1 = reads();

    click('#panel a.path-link[data-target=".wip/artifacts/w1/chat/plan.md"]');
    await flush();
    expect(reads()).toBe(read1 + 1);
    expect(shownArtifact()).toBe('chat/plan.md');

    // Two spellings of one file give one tab, the first.
    click('#panel a.path-link[data-target="notes.md"]');
    await flush();
    click('#panel a.path-link[data-target="D:/w/notes.md"]');
    await flush();
    expect(files()).toEqual(['notes.md']);
    expect(root.querySelector('#detail .local-tab.selected .tab-label')?.textContent).toBe('notes.md');

    // Open report on a draft that is an artifact selects that artifact.
    click('button.actions');
    click('.actions-menu [data-action="row-report"]');
    await flush();
    expect(shownArtifact()).toBe('chat/review.md');
    expect(files()).toEqual(['notes.md']);
    page.close();
  });

it("opens an artifact's file link by a fresh read each time: a link retargeted since opens the file, and a refused read says why", async () => {
    window.innerWidth = 1440;
    const { page, source } = start();
    const plan = '.wip/artifacts/w1/chat/plan.md';
    const link = `#panel a.path-link[data-target="${plan}"]`;
    const read = (path: string, artifact?: string) => ({ status: 200, body: { path, name: 'plan.md', kind: 'markdown', contents: '# Doc', tooLarge: false, size: 5, entries: null, more: false, ...(artifact === undefined ? {} : { artifact }) } });
    const shown = () => root.querySelector('#detail .side-switch > .selected[data-id]')?.getAttribute('data-id');
    const settle = async () => {
      await flush();
      await flush();
    };

    answers['local-file'] = read(`D:/w/${plan}`, 'chat/plan.md');
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan' };
    hello(source, { items: [reply('r1', 2, { opening: `See [plan](${plan}).` })] });
    click(link);
    await settle();
    expect(shown()).toBe('artifact:chat/plan.md');
    click('#detail [data-side="history"]');

    // The link now resolves to a file outside the artifact folder: it opens that file, not the artifact it named before.
    answers['local-file'] = read('D:/elsewhere/plan.md');
    click(link);
    await settle();
    expect(shown()).toBe('file:D:/elsewhere/plan.md');
    click('#detail .local-tab.selected [data-action="local-close"]');
    click('#detail [data-side="history"]');

    // A read the hub refuses now, as on a paired device, says why and opens no artifact.
    answers['local-file'] = { status: 403, body: { error: 'This device can only open files in the work item’s folders.' } };
    click(link);
    await settle();
    expect(shown()).toBe(`file:${plan}`);
    expect(root.querySelector('#detail .local-view .empty')?.textContent).toBe('This device can only open files in the work item’s folders.');
    page.close();
  });

  it('leaves the tab the operator moved to when a file read answers late as an artifact, and keeps the artifact for the column of a narrow page', async () => {
    window.innerWidth = 1440;
    const plan = '.wip/artifacts/w1/chat/plan.md';
    const artifactRead = { status: 200, body: { path: `D:/w/${plan}`, name: 'plan.md', kind: 'markdown', contents: '# Plan', tooLarge: false, size: 6, entries: null, more: false, artifact: 'chat/plan.md' } };
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs')).length;
    let release = (): void => {};

    answers['local-file'] = { ...artifactRead, wait: new Promise((resolve) => (release = resolve)) };
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan' };

    const { page, source } = start();

    hello(source, { items: [reply('r1', 2, { opening: `See [plan](${plan}).` })] });
    click(`#panel a.path-link[data-target="${plan}"]`);
    await flush();
    click('#detail [data-side="history"]');

    const before = kept();

    release();
    await flush();
    await flush();
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('#detail .local-tab')).toBeNull();
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/plan.md"]')).not.toBeNull();
    expect(kept()).toBe(before);
    page.close();

    // A file tab restored on a narrow page waits for the column while the Conversation shows; read as an artifact, the artifact waits there instead.
    window.innerWidth = 1000;
    localStorage.setItem('switchboard.tabs', JSON.stringify({ w1: { side: 'file', tab: 'conversation', artifact: null, changes: false, changesFile: null, files: [{ target: plan, line: null }], file: 0, history: false } }));
    answers['local-file'] = artifactRead;

    const keptBefore = kept();
    const narrow = start();

    hello(narrow.source);
    await flush();
    await flush();
    expect(root.querySelector('#head [data-tab="conversation"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.classList.contains('off-conversation')).toBe(false);
    expect(root.querySelector('#head .local-tab')).toBeNull();
    resizeTo(1920);
    expect(root.querySelector('#detail .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/plan.md');
    expect(kept()).toBe(keptBefore);
    narrow.page.close();
  });

  it('reads a file tab whose read is still on its way across a reconnect again once that read answers, loading or loaded, and never shows the earlier answer', async () => {
    window.innerWidth = 1440;
    history.replaceState(null, '', '#w=1');
    const { page, source } = start();
    const items = [reply('r1', 2, { opening: 'See [notes](notes.md).' })];
    const reads = () => posts.filter((post) => post.url.startsWith('/v1/conversation/local-file?')).length;
    const text = () => root.querySelector('#detail .detail-body .local-view > .artifact-doc')?.textContent?.trim();
    let release = (): void => {};

    answers['local-file'] = { status: 403, body: { error: 'Not this page.' }, wait: new Promise((resolve) => (release = resolve)) };
    hello(source, { items });
    click('#panel a.path-link');
    await flush();
    expect(reads()).toBe(1);

    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Fresh', tooLarge: false, size: 7, entries: null, more: false } };
    source.emit('hello', { key: 'pk9', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    hello(source, { key: 'pk9', scope: { ...scope, scopeGen: 6 }, items });
    await flush();
    await flush();
    // A tab is read once at a time, so the new stream's read waits for the earlier one.
    expect(reads()).toBe(1);

    release();
    await flush();
    await flush();
    await flush();
    expect(reads()).toBe(2);
    expect(text()).toBe('Fresh');
    expect(root.querySelector('#detail .local-view .empty')).toBeNull();

    // A loaded tab read again as a turn ends, its read still on its way at a reconnect, is read again then, and the earlier answer never shows.
    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Stale', tooLarge: false, size: 7, entries: null, more: false }, wait: new Promise((resolve) => (release = resolve)) };
    source.emit('session', { session: session({ state: 'running' }) });
    source.emit('session', { session: session({ state: 'idle' }) });
    await flush();
    expect(reads()).toBe(3);
    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Current', tooLarge: false, size: 9, entries: null, more: false } };
    source.emit('hello', { key: 'pk10', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    hello(source, { key: 'pk10', scope: { ...scope, scopeGen: 7 }, items });
    await flush();
    expect(reads()).toBe(3);
    expect(text()).toBe('Fresh');

    release();
    await flush();
    await flush();
    await flush();
    expect(reads()).toBe(4);
    expect(text()).toBe('Current');
    page.close();
  });

  it('closes the tab shown to its neighbour in the strip, the one before it else after it, keeps the selection when another tab closes, and keeps no choice for the tab shown next', async () => {
    window.innerWidth = 1440;
    const { page, source } = start();

    answers['/local-file?'] = { status: 404, body: { error: 'Not found.' } };
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan' };
    hello(source, { items: [reply('r1', 2, { opening: 'See [a](src/a.ts) and [b](src/b.ts).' })] });

    const shown = () => root.querySelector('#detail .side-switch > .selected[data-id]')?.getAttribute('data-id');
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs')).map((post) => post.body);

    click('#detail .artifact-tab[data-path="chat/p.html"] .tab-open');
    click('#panel a.path-link[data-target="src/a.ts"]');
    click('#panel a.path-link[data-target="src/b.ts"]');
    await flush();
    click('#detail .local-tab [data-action="local-tab"]');
    expect([...root.querySelectorAll('#detail .side-switch > [data-id]')].map((tab) => tab.getAttribute('data-id'))).toEqual(['history', 'artifact:chat/p.html', 'artifact:chat/plan.md', 'file:src/a.ts', 'file:src/b.ts', 'changes', 'console']);
    expect(shown()).toBe('file:src/a.ts');

    // Closing a tab not shown changes nothing else, a file's or an artifact's.
    const before = kept().length;

    click('#detail .local-tab:not(.selected) [data-action="local-close"]');
    expect(shown()).toBe('file:src/a.ts');
    click('#detail .artifact-tab[data-path="chat/plan.md"] .tab-close');
    expect(shown()).toBe('file:src/a.ts');
    expect(kept().slice(before)).toEqual([expect.objectContaining({ close: { path: 'chat/plan.md', updatedAt: 1_500 } })]);

    // Closing the tab shown shows the one before it, an artifact here, then with no document left Status; neither is kept as a choice.
    click('#detail .local-tab.selected [data-action="local-close"]');
    expect(shown()).toBe('artifact:chat/p.html');
    expect(kept().slice(before)).toHaveLength(1);
    click('#detail .artifact-tab.selected .tab-close');
    expect(shown()).toBe('history');
    expect(kept().slice(before)).toEqual([expect.objectContaining({ close: { path: 'chat/plan.md', updatedAt: 1_500 } }), expect.objectContaining({ close: { path: 'chat/p.html', updatedAt: 1_500 } })]);
    page.close();
  });

  it('shows the conversation in place of an artifact another device closes on a narrow page, and Status on a wide one, keeping no choice', () => {
    window.innerWidth = 1000;
    const { page, source } = start();
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs')).length;

    hello(source);
    click('#head .artifact-tab[data-path="chat/plan.md"] .tab-open');
    expect(root.querySelector('#head .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/plan.md');

    const before = kept();

    source.emit('tabs', { workItemId: 1, tabs: { tab: null, closed: [{ path: 'chat/plan.md', updatedAt: 1_500 }] } });
    expect(root.querySelector('#head .artifact-tab[data-path="chat/plan.md"]')).toBeNull();
    expect(root.querySelector('#head [data-tab="conversation"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.classList.contains('off-conversation')).toBe(false);
    // On a wider page the column shows Status, as it would have.
    resizeTo(1920);
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(kept()).toBe(before);
    page.close();
  });

  it('reads the file tab shown again when chosen, after a turn and on a reconnect, keeping its place and its view through a failed read, and a newer read wins', async () => {
    window.innerWidth = 1440;
    // The page asks for its work item, so it shows it again on a new stream.
    history.replaceState(null, '', '#w=1');
    const { page, source } = start();
    const read = (contents: string, wait?: Promise<void>) => ({ status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents, tooLarge: false, size: 7, entries: null, more: false }, ...(wait === undefined ? {} : { wait }) });
    const items = [reply('r1', 2, { opening: 'See [notes](notes.md).' })];
    const doc = () => root.querySelector<HTMLElement>('#detail .detail-body .local-view > .artifact-doc');
    const text = () => doc()?.textContent?.trim();
    const reads = () => posts.filter((post) => post.url.startsWith('/v1/conversation/local-file?')).length;
    const settle = async () => {
      await flush();
      await flush();
    };
    let release = (): void => {};

    answers['local-file'] = read('# One');
    hello(source, { items });
    click('#panel a.path-link');
    await settle();
    expect(text()).toBe('One');
    doc()!.scrollTop = 200;
    doc()!.dispatchEvent(new Event('scroll'));

    // A turn that ends reads it again, showing what it read until the answer comes, then the new text where the reader was.
    answers['local-file'] = read('# Two', new Promise((resolve) => (release = resolve)));
    source.emit('session', { session: session({ state: 'running' }) });
    expect(reads()).toBe(1);
    source.emit('session', { session: session({ state: 'idle' }) });
    await settle();
    expect(reads()).toBe(2);
    expect(text()).toBe('One');
    release();
    await settle();
    expect(text()).toBe('Two');
    expect(doc()!.scrollTop).toBe(200);

    // Chosen again, it reads again; a failed read keeps what it shows.
    answers['local-file'] = { status: 500, body: { error: 'The disk is busy.' } };
    click('#detail [data-side="history"]');
    click('#detail [data-action="local-tab"]');
    await settle();
    expect(reads()).toBe(3);
    expect(text()).toBe('Two');

    // A reconnect tries it again once the new stream shows the work item.
    answers['local-file'] = read('# Three');
    source.emit('hello', { key: 'pk9', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side' })])], scope: null, sessions: [], items: [], more: false, state: null, artifacts: [] });
    expect(reads()).toBe(3);
    hello(source, { key: 'pk9', scope: { ...scope, scopeGen: 6 }, items });
    await settle();
    expect(reads()).toBe(4);
    expect(text()).toBe('Three');

    // Chosen again while a read is on its way, the tab is read again once that read answers, and the earlier answer is dropped.
    answers['local-file'] = read('# Old', new Promise((resolve) => (release = resolve)));
    click('#detail [data-action="local-tab"]');
    answers['local-file'] = read('# New');
    click('#detail [data-action="local-tab"]');
    await settle();
    expect(reads()).toBe(5);
    release();
    await settle();
    expect(reads()).toBe(6);
    expect(text()).toBe('New');
    page.close();
  });

  it('drops a file read for a work item the page has left, and gives a restored file tab to its artifact without keeping a choice or opening a closed one', async () => {
    window.innerWidth = 1440;
    const plan = '.wip/artifacts/w1/chat/plan.md';
    const tabs = (target: string) => ({ side: 'file', tab: 'conversation', artifact: null, changes: false, changesFile: null, files: [{ target, line: null }], file: 0, history: false });

    localStorage.setItem('switchboard.tabs', JSON.stringify({ w1: tabs(plan) }));
    answers['local-file'] = { status: 200, body: { path: `D:/w/${plan}`, name: 'plan.md', kind: 'markdown', contents: '# Plan', tooLarge: false, size: 6, entries: null, more: false, artifact: 'chat/plan.md' } };
    answers['/artifact/'] = { status: 200, body: {}, text: '# Plan' };

    const { page, source } = start();
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs')).map((post) => post.body);

    hello(source);
    await flush();
    await flush();
    expect(root.querySelector('#detail .artifact-tab.selected')?.getAttribute('data-path')).toBe('chat/plan.md');
    expect(root.querySelector('#detail .local-tab')).toBeNull();
    expect(kept()).toEqual([]);
    page.close();

    // Closed on every device, it stays closed: Status shows.
    localStorage.setItem('switchboard.tabs', JSON.stringify({ w1: tabs(plan) }));
    const again = start();

    hello(again.source, { tabs: { tab: null, closed: [{ path: 'chat/plan.md', updatedAt: 1_500 }] } });
    await flush();
    await flush();
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/plan.md"]')).toBeNull();
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(kept()).toEqual([]);

    // A read that answers after the page has left its work item is dropped, there and on the work item's return.
    let release = (): void => {};

    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Late', tooLarge: false, size: 6, entries: null, more: false }, wait: new Promise((resolve) => (release = resolve)) };
    again.source.emit('reply', { reply: reply('r2', 3, { opening: 'See [notes](notes.md).' }) });
    click('#panel a.path-link[data-target="notes.md"]');
    click('[data-work-item="2"]');
    hello(again.source, { scope: { ...scope, workItemId: 2, scopeGen: 4 } });
    answers['local-file'] = { status: 200, body: { path: 'D:/w/notes.md', name: 'notes.md', kind: 'markdown', contents: '# Now', tooLarge: false, size: 5, entries: null, more: false } };
    click('[data-work-item="1"]');
    hello(again.source, { scope: { ...scope, scopeGen: 5 }, items: [reply('r2', 3, { opening: 'See [notes](notes.md).' })] });
    await flush();
    await flush();
    release();
    await flush();
    await flush();
    expect(root.querySelector('#detail .local-view > .artifact-doc')?.textContent?.trim()).toBe('Now');
    again.page.close();
  });

  it('ends its listeners when it closes, so a page started again on the same root handles each click once', () => {
    window.innerWidth = 1440;
    const first = start();

    hello(first.source);
    first.page.close();

    const second = start();

    hello(second.source);
    posts = [];
    click('#detail [data-side="console"]');
    expect(posts.filter((post) => post.url.endsWith('/page-tabs')).map((post) => post.body)).toEqual([expect.objectContaining({ tab: 'console' })]);
    second.page.close();
  });

  it("lists a pool ticket with a menu under its row instead of a conversation, and runs its Start, Start with guidance and Snooze through pool-action", async () => {
    const { page, source, opened } = start();
    const actions = [
      { label: 'Start', action: 'pick', icon: 'play', group: 'main' as const, confirm: null, input: null },
      { label: 'Start with guidance…', action: 'pick', icon: 'comment', group: 'work' as const, confirm: null, input: { question: 'Start with guidance', detail: 'It ends the prompt.', action: 'Start', text: null, choice: null } },
      { label: 'Snooze…', action: 'snooze', icon: 'clockface', group: 'state' as const, confirm: null, input: null },
    ];
    const pool = listRow(0, { workItemId: null, ticketId: 9, title: 'Pool ticket', ticket: 'gh 9', url: 'https://github.com/o/r/issues/9', actions, main: 'Start' });

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })]), listGroup('unstarted', [pool])] });
    posts = [];
    const row = () => root.querySelector<HTMLElement>('#list [data-action="pool-menu"][data-row="ticket:9"]')!;

    expect(root.querySelector('#list .row-menu')).toBeNull();
    const shown = vi.fn();

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: shown, configurable: true });
    row().click();
    // The menu is fixed to the viewport and flips where it has no room, so the list does not scroll for it.
    expect(shown.mock.contexts).not.toContain(root.querySelector('#list .row-menu'));
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    expect([...root.querySelectorAll('#list .row-menu .menu-row')].map((one) => one.textContent)).toEqual(['Start', 'Start with guidance…', 'Snooze…', 'Open ticket']);
    // Its click selects nothing: a pool ticket has no conversation.
    expect(posts).toEqual([]);

    answers['/pool-action'] = { status: 200, body: { done: true } };
    click('#list .row-menu [data-label="Start"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/pool-action'))?.body).toMatchObject({ window: 'pk', ticketId: 9, label: 'Start' });
    expect(posts.find((post) => post.url.endsWith('/pool-action'))?.body).not.toHaveProperty('workItemId');
    expect(root.querySelector('#list .row-menu')).toBeNull();

    row().click();
    click('#list .row-menu [data-label="Start with guidance…"]');
    root.querySelector<HTMLTextAreaElement>('.sheet-input')!.value = 'Use staging';
    root.querySelector('.sheet-input')!.dispatchEvent(new Event('input', { bubbles: true }));
    posts = [];
    answers['/pool-action'] = { status: 409, body: { error: 'The ticket is no longer in the pool.' } };
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/pool-action'))?.body).toMatchObject({ ticketId: 9, label: 'Start with guidance…', text: 'Use staging' });
    // A pool ticket's refusal shows in the toast too.
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('The ticket is no longer in the pool.');

    row().click();
    click('#list .row-menu [data-label="Snooze…"]');
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Snooze Pool ticket');
    answers['/pool-action'] = { status: 200, body: { done: true } };
    posts = [];
    click('.sheet [data-action="sheet-go"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/pool-action'))?.body).toMatchObject({ ticketId: 9, label: 'Snooze…', until: expect.any(Number) });

    // The menu closes on Escape and on a press outside it, and without the browser pane its pill opens the ticket without opening the menu.
    row().click();
    root.querySelector('#list .row-menu .menu-row')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('#list .row-menu')).toBeNull();
    row().click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('#list .row-menu')).toBeNull();
    row().querySelector<HTMLElement>('.pill.ticket')!.click();
    expect(opened).toEqual(['https://github.com/o/r/issues/9']);
    expect(root.querySelector('#list .row-menu')).toBeNull();
    page.close();
  });

  it("offers no Open in terminal, which the Console tab replaces, while the session has a console", async () => {
    const { page, source } = start();

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it', pastes: ['Reply'], opens: [{ label: 'Open in VS Code', icon: 'vscode' }] })])] });
    expect(root.querySelector('[data-tab="console"]')).not.toBeNull();
    click('button.actions');
    expect([...root.querySelectorAll('.actions-menu .menu-row')].map((row) => row.textContent)).toEqual(['Copy Reply', 'Open in VS Code']);
    page.close();
  });

  it("opens a row's ticket and link pills in a new tab without selecting the row while the page has no browser pane, and only http or https links", async () => {
    const { page, source, opened } = start();
    const links = [
      { label: 'PR #5', url: 'https://github.com/o/r/pull/5', kind: 'pr' as const, badge: '5', glyph: '\u{ea64}', mentioned: false },
      { label: 'Notes', url: 'https://example.test/a?b=1#top', kind: 'url' as const, badge: 'Notes', glyph: null, mentioned: false },
      { label: 'Bad', url: 'javascript:alert(1)', kind: 'url' as const, badge: 'Bad', glyph: null, mentioned: false },
    ];

    hello(source, { groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Other', url: 'https://github.com/o/r/issues/2', links })])] });
    // The pane is on but not paired, so it shows no links.
    source.emit('pane', { pane: { enabled: true, extension: 'unpaired', extensionId: 'ext', marker: null, shown: false, error: null } });
    posts = [];
    click('#list [data-work-item="2"] .pill.ticket');
    click('#list [data-work-item="2"] .pill.link.pr');
    click('#list [data-work-item="2"] .pill.link[title^="Notes"]');
    click('#list [data-work-item="2"] .pill.link[title^="Bad"]');
    await flush();
    expect(opened).toEqual(['https://github.com/o/r/issues/2', 'https://github.com/o/r/pull/5', 'https://example.test/a?b=1#top']);
    // The pill's click is not the row's: nothing is selected.
    expect(posts.filter((post) => post.url.endsWith('/select'))).toEqual([]);
    expect(root.querySelector('#list .row.selected')?.getAttribute('data-work-item')).toBe('1');
    // A row without a ticket URL, such as an ad-hoc one, has a ticket pill that opens nothing.
    expect(root.querySelector('#list [data-work-item="1"] .pill.ticket')!.hasAttribute('data-action')).toBe(false);
    page.close();
  });


  it('says it is the installed app as it opens its stream', async () => {
    installed = true;

    const { page, source } = start();

    expect(source.url).toBe('/v1/conversation/events?page=1&installed=1');
    page.close();

    installed = false;

    const again = start();

    expect(again.source.url).toBe('/v1/conversation/events?page=1');
    again.page.close();
  });

});
