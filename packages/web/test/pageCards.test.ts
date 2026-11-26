import { join } from 'node:path';
import { afterEach, onTestFinished, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeline } from '../src/model.js';
import { parseQuestions } from '@switchboard/conversation/questions';
import { html } from './html.js';
import { COMMENT_SETTLE_MS, loadMermaid, startPage } from '../src/main.js';
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

  it('links an answer and its card both ways, each going to the other and highlighting it, and supersedes an old card with a later reply', () => {
    const { page, source } = start();
    const scrolled: string[] = [];
    const asked = '1. Move this work to a Code Mode session?\n   - A) Not now, keep it here\n   - B) Yes';

    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset['cardKey'] ?? this.dataset['id'] ?? '');
    };
    hello(source, { items: [reply('r1', 2, { opening: asked }), message('m1', 3, { text: '1A' })] });

    const ref = root.querySelector<HTMLButtonElement>('li[data-id="m1"] .bubble > .answer-ref')!;

    expect(ref.textContent).toBe('↳Move this work to a Code Mode session?→ Not now, keep it here');
    click('li[data-id="m1"] .answer-ref');
    expect(scrolled).toEqual(['reply:r1']);
    expect(root.querySelector('.question-card')!.classList.contains('linked')).toBe(true);
    expect(root.querySelector('.question-card .qc-done .qc-progress')!.textContent).toBe('Question answered');
    click('.question-card [data-action="goto-message"]');
    expect(scrolled).toEqual(['reply:r1', 'm1']);
    expect(root.querySelector('li[data-id="m1"]')!.classList.contains('linked')).toBe(true);

    // Before the cutover, a later reply supersedes the card, which takes no answer.
    hello(source, { items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Ignore the question I asked.' })] });
    expect(root.querySelector('.question-card .qc-state')!.getAttribute('title')).toBe('Superseded');
    expect(root.querySelector('.question-card .qc-row-detail')!.textContent).toBe('Superseded: a later reply came after it.');
    expect(root.querySelector('.qc-option, [data-action="card-send"]')).toBeNull();

    // After it, a reply with text leaves the question open, and an Answers message shows as its bubble.
    const questions = { sessionId: 's', since: 0, open: 0, oldest: null, drafts: {}, dismissed: [] };

    hello(source, { questions, items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Working on it.' }), message('m1', 4, { text: '[answers]\n- code-mode-session: Move this work to a Code Mode session? → B) Yes', answers: [{ replyId: 'r1', slug: 'move-work-code', letters: ['B'], other: '', via: 'card' }] })] });
    expect(root.querySelector('li[data-id="m1"] .answers-title')!.textContent).toBe('Answers');
    expect(root.querySelector('li[data-id="m1"] .answers-answer')!.textContent).toBe('Yes');
    expect(root.querySelector('li[data-id="m1"] .box')!.textContent).not.toMatch(/\[answers\]|code-mode-session/);
    expect(root.querySelector('.question-card.qc-collapsed .qc-progress')!.textContent).toBe('Question answered');
    // An Answers message the transcript does not show leaves its question open on the card, to answer again there.
    hello(source, { questions, items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Working on it.' }), message('m1', 4, { delivery: 'unconfirmed', text: '[answers]\n- code-mode-session: Move this work to a Code Mode session? → B) Yes', answers: [{ replyId: 'r1', slug: 'move-work-code', letters: ['B'], other: '', via: 'card' }] })] });
    expect(root.querySelector('.question-card.qc-collapsed')).toBeNull();
    expect(root.querySelector('.question-card [data-action="card-send"]')).not.toBeNull();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    page.close();
  });

  it("opens a row's work item at its oldest open card when its waiting questions are pressed, by click or by key", async () => {
    window.innerWidth = 700;

    const { page, source } = start();
    const scrolled: string[] = [];
    const asked = '1. Port?\n   - A) 1\n   - B) 2';

    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset['cardKey'] ?? '');
    };

    try {
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };

      hello(source, { groups: [listGroup('progress', [listRow(1, { questions: 1 }), listRow(2, { questions: 3 })])], questions, items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Checking.', kind: 'aside' })] });
      click('[data-work-item="1"] .questions');
      await flush();
      expect(scrolled).toEqual(['reply:r1']);
      expect(document.activeElement).toBe(root.querySelector('.question-card.qc'));
      // The row's waiting questions are a keyboard stop with its row, and Enter on them does the same.
      const badge = root.querySelector<HTMLElement>('[data-work-item="1"] .questions')!;

      root.querySelector<HTMLElement>('[data-work-item="1"]')!.focus();
      expect(badge.tabIndex).toBe(0);
      expect(root.querySelector<HTMLElement>('[data-work-item="2"] .questions')!.tabIndex).toBe(-1);
      badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flush();
      expect(scrolled).toEqual(['reply:r1', 'reply:r1']);
      badge.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      await flush();
      expect(scrolled).toEqual(['reply:r1', 'reply:r1', 'reply:r1']);
      // With no question open any more, a press opens the work item and goes to no card.
      source.emit('questions', { questions: { ...questions, open: 0, oldest: null } });
      click('[data-work-item="1"] .questions');
      await flush();
      expect(scrolled).toEqual(['reply:r1', 'reply:r1', 'reply:r1']);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      page.close();
    }
  });

  it('shows the conversation and reads it back to an older card a waiting-questions press goes to, and says so when it cannot', async () => {
    window.innerWidth = 700;

    const { page, source } = start();
    const scrolled: string[] = [];
    const asked = '1. Port?\n   - A) 1\n   - B) 2';
    const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };

    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset['cardKey'] ?? '');
    };

    try {
      hello(source, { groups: [listGroup('progress', [listRow(1, { questions: 1 })])], questions, items: [reply('r2', 3, { opening: 'Checking.', kind: 'aside' })], more: true });
      root.querySelector<HTMLElement>('[data-tab="history"]')!.click();
      expect(root.classList.contains('off-conversation')).toBe(true);
      // A read slower than the jump's wait still ends at the card.
      let answer = (): void => {};

      answers['/history'] = { status: 200, body: { items: [reply('r1', 2, { opening: asked })], more: false }, wait: new Promise<void>((done) => (answer = done)) };
      click('[data-work-item="1"] .questions');
      await flush();
      await flush();
      const later = Date.now() + 60_000;

      vi.spyOn(Date, 'now').mockReturnValue(later);
      answer();
      await flush();
      await flush();
      await flush();
      expect(root.classList.contains('off-conversation')).toBe(false);
      expect(posts.filter((post) => post.url.includes('/history'))).toHaveLength(1);
      expect(scrolled).toEqual(['reply:r1']);

      // A read the hub refuses ends the jump with a warning, and asks no more.
      hello(source, { groups: [listGroup('progress', [listRow(1, { questions: 1 })])], questions: { ...questions, oldest: 'reply:r0' }, items: [reply('r2', 3, { opening: 'Checking.', kind: 'aside' })], more: true });
      answers['/history'] = { status: 409, body: { error: 'Stale.' } };
      click('[data-work-item="1"] .questions');
      await flush();
      await flush();
      await flush();
      expect(posts.filter((post) => post.url.includes('/history'))).toHaveLength(2);
      expect(root.querySelector('.toast.warning .toast-text')?.textContent).toBe('Switchboard could not read the conversation back to its question card.');
      expect(scrolled).toEqual(['reply:r1']);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      page.close();
    }
  });

  it('shows how many questions wait over the composer while the answerable card is off screen, and goes to it on a click', () => {
    window.innerWidth = 700;

    const { page, source } = start();
    const scrolled: string[] = [];
    let cardTop = -500;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const original = Element.prototype.getBoundingClientRect;
    const asked = '1. Port?\n   - A) 1\n   - B) 2';

    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.id === 'panel' ? rect(0, 400) : this.classList.contains('question-card') ? rect(cardTop, 200) : original.call(this);
    };
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset['cardKey'] ?? '');
    };

    try {
      const chip = () => root.querySelector<HTMLElement>('#composer > .question-waiting');

      hello(source, { items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Checking.', kind: 'aside' })] });
      expect(chip()!.hidden).toBe(false);
      expect(chip()!.textContent).toBe('1 question waiting');
      click('#composer .question-waiting');
      expect(scrolled).toEqual(['reply:r1']);
      cardTop = 100;
      root.querySelector('#panel')!.dispatchEvent(new Event('scroll'));
      expect(chip()!.hidden).toBe(true);
      cardTop = -500;
      root.querySelector('#panel')!.dispatchEvent(new Event('scroll'));
      expect(chip()!.hidden).toBe(false);
      // On another tab, where the card is not shown, too; a click goes back to it.
      cardTop = 100;
      root.querySelector<HTMLElement>('[data-tab="history"]')!.click();
      expect(chip()!.hidden).toBe(false);
      click('#composer .question-waiting');
      expect(root.classList.contains('off-conversation')).toBe(false);
      expect(scrolled).toEqual(['reply:r1', 'reply:r1']);
      expect(chip()!.hidden).toBe(true);
      // The hub's count is every open question of the conversation, across cards, and the chip goes to the oldest.
      cardTop = -500;
      hello(source, { items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Checking.', kind: 'aside' })], questions: { sessionId: 's', since: 0, open: 3, oldest: 'reply:r1', drafts: {}, dismissed: [] } });
      expect(chip()!.textContent).toBe('3 questions waiting');
      source.emit('questions', { questions: { sessionId: 's', since: 0, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] } });
      expect(chip()!.textContent).toBe('2 questions waiting');
      // Another session's questions change nothing.
      source.emit('questions', { questions: { sessionId: 'other', since: 0, open: 9, oldest: 'reply:x', drafts: {}, dismissed: [] } });
      expect(chip()!.textContent).toBe('2 questions waiting');
      // Answered or superseded, or while the page cannot answer, there is none.
      hello(source, { items: [reply('r1', 2, { opening: asked }), message('m1', 3, { text: '1B' })] });
      expect(chip()!.hidden).toBe(true);
      hello(source, { items: [reply('r1', 2, { opening: asked }), reply('r2', 3, { opening: 'Never mind.' })] });
      expect(chip()!.hidden).toBe(true);
      hello(source, { items: [reply('r1', 2, { opening: asked })], sessions: [session({ conversation: 'read-only' })] });
      expect(chip()!.hidden).toBe(true);
    } finally {
      // Own properties shadow Element.prototype's, which other tests stub.
      delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect;
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      resizeTo(1024);
      page.close();
    }
  });

  it('draws the cards carried past retention in a Still open section at the top, answers them as any card, and the chip goes there (PRD R103)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scrolled: string[] = [];
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const original = Element.prototype.getBoundingClientRect;

    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.id === 'panel' ? rect(0, 400) : this.classList.contains('question-card') ? rect(-500, 200) : original.call(this);
    };
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset['cardKey'] ?? '');
    };

    try {
      const { page, source } = start();
      const asked = '1. **Port.** Which port? {#port-choice}\n   - A) 1\n   - B) 2\n2. Keep the route? {#keep-route}\n   - A) Keep\n   - B) Remove';
      const gone = parseQuestions(asked).map((question) => ({ key: `reply:gone#${question.slug}`, card: 'reply:gone', replyId: 'gone', question, state: 'open' as const, answer: null, reason: null, replacedBy: null }));
      const questions = { sessionId: 's', since: 0, open: 2, oldest: 'reply:gone', drafts: {}, dismissed: [], carried: gone };
      const section = () => root.querySelector('#panel .still-open');
      const items = [reply('r9', 9, { opening: 'Step.', kind: 'aside' })];
      const step = () => section()!.querySelector('.question-card')!.getAttribute('data-step');

      hello(source, { items, questions });
      expect(section()!.querySelector('.still-open-title')!.textContent).toBe('Still open');
      // The section comes before the timeline, which draws no card for these questions.
      expect(section()!.compareDocumentPosition(root.querySelector('.timeline')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(root.querySelectorAll('.timeline .question-card')).toHaveLength(0);
      expect(section()!.querySelector('.question-card')!.getAttribute('data-card-key')).toBe('reply:gone');
      expect(section()!.querySelector('.qc-progress')!.textContent).toBe('Question 1 of 2');

      // The chip goes to the carried card.
      const chip = root.querySelector<HTMLElement>('#composer > .question-waiting')!;

      expect(chip.hidden).toBe(false);
      expect(chip.textContent).toBe('2 questions waiting');
      click('#composer .question-waiting');
      expect(scrolled).toEqual(['reply:gone']);

      // One question at a time, with the draft on the hub and a send of the answered one only.
      click('.still-open [data-action="card-pick"][data-letter="B"]');
      expect(posts.filter((post) => post.url.endsWith('/card-draft')).at(-1)?.body).toMatchObject({ sessionId: 's', card: 'reply:gone', draft: { step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: null } } } });
      expect(step()).toBe('port-choice');
      click('.still-open [data-action="card-next"]');
      expect(step()).toBe('keep-route');
      expect(section()!.querySelector('textarea.qc-comment')).not.toBeNull();
      click('.still-open [data-action="card-send"]');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/send'))?.body['answers']).toEqual([{ card: 'reply:gone', slug: 'port-choice', letters: ['B'], other: '' }]);

      // Answered in part, the card stays with its open question and the answered one as a row; Dismiss is in its menu.
      const answered = { ...gone[0]!, state: 'answered' as const, answer: { messageId: 'm10', letters: ['B'], other: '', via: 'card' as const, sending: false } };

      source.emit('questions', { questions: { ...questions, open: 1, carried: [answered, gone[1]!] } });
      expect(step()).toBe('keep-route');
      expect(section()!.querySelectorAll('.qc-row')).toHaveLength(1);
      click('.still-open [data-action="card-menu"]');
      click('.still-open [data-action="card-dismiss"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/card-dismiss'))?.body).toMatchObject({ sessionId: 's', card: 'reply:gone', slug: 'keep-route' });

      // Settled, or withdrawn, it leaves the section, and the chip with it.
      source.emit('questions', { questions: { ...questions, open: 0, oldest: null, carried: [] } });
      expect(section()).toBeNull();
      expect(chip.hidden).toBe(true);

      // An answer the page holds settles it before the hub's next event.
      hello(source, { items: [...items, message('m10', 10, { text: '[answers]', answers: [{ replyId: 'gone', slug: 'port-choice', letters: ['A'], other: '', via: 'card' }, { replyId: 'gone', slug: 'keep-route', letters: ['B'], other: '', via: 'card' }] })], questions });
      expect(section()).toBeNull();

      // A reply the page still holds keeps its card under it, once.
      hello(source, { items: [reply('gone', 1, { opening: asked }), ...items], questions });
      expect(section()).toBeNull();
      expect(root.querySelectorAll('.question-card')).toHaveLength(1);
      expect(root.querySelector('li[data-id="gone"] .question-card')).not.toBeNull();

      // The hub's state is current, so a message the page holds from before it is not read against it again: a typed "B" that answered nothing
      // then leaves the question open, and the answer the hub links to a question is shown with its message.
      const linked = { ...gone[0]!, state: 'answered' as const, answer: { messageId: 'm11', letters: ['A'], other: '', via: 'card' as const, sending: false } };

      hello(source, { items: [message('m8', 8, { text: 'B' }), ...items, message('m11', 11, { text: '[answers]\n- port-choice: Which port? → A) 1', answers: [{ replyId: 'gone', slug: 'port-choice', letters: ['A'], other: '', via: 'card' }] })], questions: { ...questions, open: 1, carried: [linked, gone[1]!] } });
      expect(step()).toBe('keep-route');
      expect(root.querySelector('li[data-id="m11"] .answers-answer')!.textContent).toBe('1');
      expect(root.querySelector('li[data-id="m11"] [data-action="goto-card"]')!.getAttribute('data-target-card')).toBe('reply:gone');

      // A session that cannot take answers shows the card locked, as under a reply.
      hello(source, { items, questions, sessions: [session({ conversation: 'read-only' })] });
      expect(section()!.querySelector<HTMLButtonElement>('[data-action="card-pick"]')!.disabled).toBe(true);
      page.close();
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect;
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      vi.useRealTimers();
    }
  });

  it('steps through a card one question at a time, keeps its draft on the hub, and sends the picks for the hub to write, showing a refusal on the card', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const { page, source } = start();
      const asked = '1. **Port.** Which port? {#port-choice}\n   - A) 1\n   - B) 2\n2. Keep the route? {#keep-route}\n   - A) Keep\n   - B) Remove';
      const questions = { sessionId: 's', since: 0, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      const drafts = () => posts.filter((post) => post.url.endsWith('/card-draft')).map((post) => post.body['draft']);
      const step = () => root.querySelector('.question-card')!.getAttribute('data-step');

      hello(source, { items: [reply('r1', 2, { opening: asked })], questions });
      expect(root.querySelector('.qc-progress')!.textContent).toBe('Question 1 of 2');
      click('[data-action="card-pick"][data-letter="B"]');
      expect(root.querySelector('[data-letter="B"]')!.getAttribute('aria-checked')).toBe('true');
      expect(drafts().at(-1)).toEqual({ step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: null } } });
      // A pick stays on its question, so a comment can follow it; Next moves on.
      await vi.advanceTimersByTimeAsync(1000);
      expect(step()).toBe('port-choice');
      click('[data-action="card-next"]');
      expect(step()).toBe('keep-route');
      expect(root.querySelector('[data-action="card-send"]')!.textContent).toBe('Send 1 of 2');
      click('[data-action="card-back"]');
      expect(step()).toBe('port-choice');
      click('[data-action="card-next"]');
      // The Comment field's text reaches the hub once the typing pauses.
      const other = root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;

      other.value = 'keep it, for now';
      other.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      expect(drafts().at(-1)).toEqual({ step: 'keep-route', picks: { 'port-choice': { letters: ['B'], other: null }, 'keep-route': { letters: [], other: 'keep it, for now' } } });

      // The hub's draft, as another device changed it, shows once the hub has carried this page's last draft back to it.
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': drafts().at(-1) } } });
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': { step: 'keep-route', picks: { 'port-choice': { letters: ['A'], other: null }, 'keep-route': { letters: ['A'], other: null } } } } } });
      expect(root.querySelector('[data-letter="A"]')!.getAttribute('aria-checked')).toBe('true');
      expect(root.querySelector('[data-action="card-send"]')!.textContent).toBe('Send 2 answers');

      answers['/send'] = { status: 409, body: { error: 'That question was withdrawn.' } };
      click('[data-action="card-send"]');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/send'))?.body).toMatchObject({ sessionId: 's', launch: 'L', scopeGen: 3, answers: [{ card: 'reply:r1', slug: 'port-choice', letters: ['A'], other: '' }, { card: 'reply:r1', slug: 'keep-route', letters: ['A'], other: '' }] });
      expect(posts.find((post) => post.url.endsWith('/send'))?.body).not.toHaveProperty('text');
      expect(root.querySelector('.qc-error')!.textContent).toBe('That question was withdrawn.');
      expect(root.querySelector<HTMLButtonElement>('[data-action="card-send"]')!.disabled).toBe(false);

      // Dismiss is in the card's menu.
      click('[data-action="card-menu"]');
      click('[data-action="card-dismiss"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/card-dismiss'))?.body).toMatchObject({ sessionId: 's', card: 'reply:r1', slug: 'keep-route' });
      page.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a pick with a comment, and a comment typed just before a pick, Next or Send, never waiting for the pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const { page, source } = start();
      const asked = '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2\n2. Keep the route? {#keep-route}\n   - A) Keep\n   - B) Remove';
      const drafts = () => posts.filter((post) => post.url.endsWith('/card-draft')).map((post) => post.body['draft']);
      const type = (text: string) => {
        const field = root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;

        field.value = text;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      };

      hello(source, { items: [reply('r1', 2, { opening: asked })], questions: { sessionId: 's', since: 0, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] } });
      // A comment typed, then at once a pick: the pick's draft carries the comment.
      type('unless 2 is taken');
      click('[data-action="card-pick"][data-letter="A"]');
      expect(drafts().at(-1)).toEqual({ step: 'port-choice', picks: { 'port-choice': { letters: ['A'], other: 'unless 2 is taken' } } });
      // Picking the picked option again drops it and leaves the comment as the answer.
      click('[data-action="card-pick"][data-letter="A"]');
      expect(root.querySelector('[data-letter="A"]')!.getAttribute('aria-checked')).toBe('false');
      expect(root.querySelector<HTMLButtonElement>('[data-action="card-next"]')!.disabled).toBe(false);
      // A comment alone enables Next at once, before the typing pauses.
      type('');
      expect(root.querySelector<HTMLButtonElement>('[data-action="card-next"]')!.disabled).toBe(true);
      type('either');
      expect(root.querySelector<HTMLButtonElement>('[data-action="card-next"]')!.disabled).toBe(false);
      click('[data-action="card-pick"][data-letter="B"]');
      // Next straight after typing carries the newest comment.
      type('unless it is taken');
      click('[data-action="card-next"]');
      expect(drafts().at(-1)).toEqual({ step: 'keep-route', picks: { 'port-choice': { letters: ['B'], other: 'unless it is taken' } } });
      // Send counts a comment typed alone at once.
      expect(root.querySelector('[data-action="card-send"]')!.textContent).toBe('Send 1 of 2');
      type('next week');
      expect(root.querySelector('[data-action="card-send"]')!.textContent).toBe('Send 2 answers');
      click('[data-action="card-pick"][data-letter="B"]');
      click('[data-action="card-send"]');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/send'))?.body['answers']).toEqual([
        { card: 'reply:r1', slug: 'port-choice', letters: ['B'], other: 'unless it is taken' },
        { card: 'reply:r1', slug: 'keep-route', letters: ['B'], other: 'next week' },
      ]);
      page.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a card's menu on Escape, before the maximized column, and on a press outside it, moves through it with Down, and opens it above its button where the conversation has no room below", async () => {
    const width = window.innerWidth;

    window.innerWidth = 1440;

    const { page, source } = start();
    const asked = '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2';
    const menuOpen = () => root.querySelector('.qc-menu') !== null;

    hello(source, { items: [reply('r1', 2, { opening: asked })], questions: { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] } });
    click('#detail .panel-max');
    click('[data-action="card-menu"]');
    expect(menuOpen()).toBe(true);
    // Down from its button reaches Dismiss.
    root.querySelector<HTMLElement>('[data-action="card-menu"]')!.focus();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(root.querySelector('[data-action="card-dismiss"]'));
    // A letter there is the menu's, not an answer.
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    expect(root.querySelector('[data-letter="A"]')!.getAttribute('aria-checked')).toBe('false');
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(menuOpen()).toBe(false);
    expect(root.classList.contains('maximized')).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('[data-action="card-menu"]'));

    // A press inside keeps it, one outside closes it.
    click('[data-action="card-menu"]');
    root.querySelector('.qc-menu')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menuOpen()).toBe(true);
    root.querySelector('.qc-head')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menuOpen()).toBe(false);

    // Placed in the conversation's box (top 100, bottom 400 on a 600 px page): its button 30 px above the box's bottom opens it upward.
    const rect = (top: number, height: number) => ({ left: 300, right: 340, top, bottom: top + height, width: 40, height, x: 300, y: top, toJSON: () => ({}) }) as DOMRect;

    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1440, configurable: true });
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 600, configurable: true });
    vi.spyOn(root.querySelector('#panel')!, 'getBoundingClientRect').mockReturnValue(rect(100, 300));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('qc-menu-anchor') ? rect(346, 24) : this.classList.contains('qc-menu') ? rect(374, 60) : rect(0, 0);
    });
    click('[data-action="card-menu"]');
    expect(root.querySelector('.qc-menu')!.classList.contains('flip-y')).toBe(true);
    // Near the box's top it opens down, as drawn.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('qc-menu-anchor') ? rect(120, 24) : this.classList.contains('qc-menu') ? rect(148, 60) : rect(0, 0);
    });
    root.querySelector('#panel')!.dispatchEvent(new Event('scroll'));
    expect(root.querySelector('.qc-menu')!.classList.contains('flip-y')).toBe(false);
    // The page's own size again, for the tests after this one.
    delete (document.documentElement as { clientWidth?: number }).clientWidth;
    delete (document.documentElement as { clientHeight?: number }).clientHeight;
    window.innerWidth = width;
    page.close();
  });

  it("closes the page's menus, not its sheets, when its window loses the focus, as to a press in a website's frame", async () => {
    const { page, source } = start();
    const asked = '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2';
    const actions = [{ label: 'Snooze…', action: 'snooze', icon: 'clockface', group: 'state' as const, confirm: null, input: null }];
    const blur = () => window.dispatchEvent(new Event('blur'));

    hello(source, { groups: [listGroup('review', [listRow(1, { title: 'Fix it', actions })])], items: [reply('r1', 2, { opening: asked })], questions: { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] } });
    for (const [opener, menu] of [['button.actions', '.actions-menu'], ['button.view-options', '.view-options-menu'], ['[data-action="card-menu"]', '.qc-menu'], ['.more-actions', '.more-menu']]) {
      click(opener!);
      expect(root.querySelector(menu!)).not.toBeNull();
      blur();
      expect(root.querySelector(menu!)).toBeNull();
    }

    // The composer's file list and the context meter's menu too.
    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

    answers['/files'] = { status: 200, body: { files: [{ path: 'src/a.ts', dir: false }] } };
    input.value = '@a';
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event('input'));
    await flush();
    await flush();
    expect(root.querySelector<HTMLElement>('.composer-menu')!.hidden).toBe(false);
    blur();
    expect(root.querySelector<HTMLElement>('.composer-menu')!.hidden).toBe(true);
    source.emit('session', { session: session({ context: { used: 20_000, window: 200_000, compactAt: 167_000, model: 'claude-sonnet-4-6' } }) });
    click('button.context-ring');
    expect(root.querySelector('.context-menu')).not.toBeNull();
    blur();
    expect(root.querySelector('.context-menu')).toBeNull();

    click('button.actions');
    click('.actions-menu [data-label="Snooze…"]');
    blur();
    expect(root.querySelector('.sheet-title')!.textContent).toBe('Snooze Fix it');
    page.close();
  });

  it('answers a card from the keyboard: numbers pick by place, arrows move between options, Enter goes on and sends, Backspace goes back', async () => {
    const { page, source } = start();
    const asked = '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2\n2. Keep the route? {#keep-route}\n   - A) Keep\n   - B) Remove';
    const key = (name: string, target: Element = root.querySelector('.question-card')!) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    const step = () => root.querySelector('.question-card')!.getAttribute('data-step');

    hello(source, { items: [reply('r1', 2, { opening: asked })], questions: { sessionId: 's', since: 0, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] } });
    // Letters no longer pick; the second option is 2.
    key('b');
    expect(root.querySelector('[data-letter="B"]')!.getAttribute('aria-checked')).toBe('false');
    key('2');
    expect(root.querySelector('[data-letter="B"]')!.getAttribute('aria-checked')).toBe('true');
    key('9');
    expect(root.querySelector('[data-letter="B"]')!.getAttribute('aria-checked')).toBe('true');
    // Down and Up move the focus between the options, stopping at the ends.
    key('ArrowDown');
    expect(document.activeElement?.getAttribute('data-letter')).toBe('A');
    key('ArrowDown', document.activeElement!);
    key('ArrowDown', document.activeElement!);
    expect(document.activeElement?.getAttribute('data-letter')).toBe('B');
    key('ArrowUp', document.activeElement!);
    expect(document.activeElement?.getAttribute('data-letter')).toBe('A');
    key('Enter');
    expect(step()).toBe('keep-route');
    key('Backspace');
    expect(step()).toBe('port-choice');
    key('Enter');
    // Keys typed in the Comment field are its text, not picks; Shift+Enter there adds a line.
    expect(key('1', root.querySelector('textarea.qc-comment')!)).toBe(true);
    expect(root.querySelector('textarea.qc-comment')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))).toBe(true);
    expect(step()).toBe('keep-route');
    root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!.value = 'later';
    root.querySelector('textarea.qc-comment')!.dispatchEvent(new Event('input', { bubbles: true }));
    key('Enter', root.querySelector('textarea.qc-comment')!);
    await flush();
    expect(posts.find((post) => post.url.endsWith('/send'))?.body).toMatchObject({ answers: [{ slug: 'port-choice', letters: ['B'] }, { slug: 'keep-route', letters: [], other: 'later' }] });
    page.close();
  });

  it('keeps Other text typed before the pause through a questions event, waits for each card on its own, and sends it to the conversation it was typed in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const { page, source } = start();
      const questions = { sessionId: 's', since: 0, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      const drafts = () => posts.filter((post) => post.url.endsWith('/card-draft')).map((post) => post.body);
      const field = (card: string) => root.querySelector<HTMLTextAreaElement>(`textarea.qc-comment[data-card="${card}"]`)!;
      const type = (card: string, text: string) => {
        field(card).value = text;
        field(card).dispatchEvent(new Event('input', { bubbles: true }));
      };

      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' }), reply('r2', 3, { opening: '1. Keep the route? {#keep-route}\n   - A) Keep\n   - B) Remove' })], questions });
      await vi.advanceTimersByTimeAsync(0);
      posts = [];

      type('reply:r1', 'first');
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS / 2);
      // Typing in another card leaves this one's pause running.
      type('reply:r2', 'second');
      // The hub's older draft, as another device last sent it, does not take the place of the text not sent yet.
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': { step: 'port-choice', picks: { 'port-choice': { letters: ['A'], other: null } } } } } });
      expect(field('reply:r1').value).toBe('first');
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS / 2);
      expect(drafts()).toEqual([expect.objectContaining({ sessionId: 's', scopeGen: 3, card: 'reply:r1', draft: { step: 'port-choice', picks: { 'port-choice': { letters: [], other: 'first' } } } })]);
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS / 2);
      expect(drafts().map((one) => [one['card'], (one['draft'] as { picks: Record<string, { other: string }> }).picks])).toEqual([
        ['reply:r1', { 'port-choice': { letters: [], other: 'first' } }],
        ['reply:r2', { 'keep-route': { letters: [], other: 'second' } }],
      ]);

      // Opening another work item first sends the text still waiting to the conversation it was typed in, and nothing follows after the pause.
      posts = [];
      type('reply:r1', 'third');
      click('#list [data-work-item="2"]');
      await vi.advanceTimersByTimeAsync(0);
      // The composer's own report may come between; the card's text goes before the select.
      expect(posts.map((post) => post.url.split('/').at(-1)).filter((name) => name !== 'composer')).toEqual(['card-draft', 'select']);
      expect(drafts()[0]).toMatchObject({ sessionId: 's', scopeGen: 3, card: 'reply:r1', draft: { picks: { 'port-choice': { other: 'third' } } } });
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      expect(drafts()).toHaveLength(1);
      page.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the newest Other text through a questions event from before the hub took it, so Send sends it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const { page, source } = start();
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      const field = () => root.querySelector<HTMLTextAreaElement>('textarea.qc-comment[data-card="reply:r1"]')!;
      const older = { step: 'port-choice', picks: { 'port-choice': { letters: [], other: 'older' } } };

      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })], questions });
      field().value = 'newest';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      expect(posts.filter((post) => post.url.endsWith('/card-draft')).at(-1)?.body['draft']).toEqual({ step: 'port-choice', picks: { 'port-choice': { letters: [], other: 'newest' } } });

      // The hub answered; events it sent before it took the draft arrive after, with an older draft or none.
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': older } } });
      expect(field().value).toBe('newest');
      source.emit('questions', { questions: { ...questions, drafts: {} } });
      expect(field().value).toBe('newest');
      click('[data-action="card-send"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.find((post) => post.url.endsWith('/send'))?.body['answers']).toEqual([{ card: 'reply:r1', slug: 'port-choice', letters: [], other: 'newest' }]);
      page.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows another device\'s draft once its own is carried back, whatever order the answers and events come in, and opens the work item chosen last', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const { page, source } = start();
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      const field = () => root.querySelector<HTMLTextAreaElement>('textarea.qc-comment[data-card="reply:r1"]')!;
      const draft = (other: string) => ({ step: 'port-choice', picks: { 'port-choice': { letters: [], other } } });
      // Another device picks B.
      const picked = { step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: null } } };
      const chose = () => root.querySelector('.question-card[data-card="reply:r1"] [data-letter="B"]')!.getAttribute('aria-checked');
      const type = async (text: string) => {
        field().value = text;
        field().dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      };
      const held = () => {
        let release = (): void => {};
        const wait = new Promise<void>((resolve) => (release = resolve));

        return { wait, release };
      };

      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })], questions });
      await vi.advanceTimersByTimeAsync(0);

      // Its own draft carried back, then another device's, both before the hub's answer: the other device's shows once the answer comes.
      let slow = held();

      answers['/card-draft'] = { status: 200, body: {}, wait: slow.wait };
      await type('mine');
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': draft('mine') } } });
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': picked } } });
      expect(field().value).toBe('mine');
      expect(chose()).toBe('false');
      slow.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(chose()).toBe('true');

      // An older draft refused after the newest was carried back changes nothing.
      await vi.advanceTimersByTimeAsync(0);
      slow = held();
      answers['/card-draft'] = { status: 409, body: { error: 'x' }, wait: slow.wait };
      await type('first');
      answers['/card-draft'] = { status: 200, body: {} };
      await type('second');
      // The comment keeps the other device's pick beside it.
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': { step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: 'second' } } } } } });
      slow.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(field().value).toBe('second');
      expect(chose()).toBe('true');
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': { step: 'port-choice', picks: { 'port-choice': { letters: ['A'], other: null } } } } } });
      expect(root.querySelector('.question-card[data-card="reply:r1"] [data-letter="A"]')!.getAttribute('aria-checked')).toBe('true');

      // A work item chosen while Other text is on its way wins over one chosen before it.
      await vi.advanceTimersByTimeAsync(0);
      slow = held();
      answers['/card-draft'] = { status: 200, body: {}, wait: slow.wait };
      field().value = 'leaving';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      posts = [];
      click('#list [data-work-item="2"]');
      click('#list [data-work-item="1"]');
      slow.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.filter((post) => post.url.endsWith('/card-draft')).map((post) => (post.body['draft'] as ReturnType<typeof draft>).picks['port-choice'].other)).toEqual(['leaving']);
      expect(posts.filter((post) => post.url.endsWith('/select')).map((post) => post.body['workItemId'])).not.toContain(2);
      page.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('trusts a matching questions event for a draft whose answer never came, so another device\'s draft still shows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, source } = start();
    try {
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })], questions });
      await vi.advanceTimersByTimeAsync(0);
      let release = () => {};
      answers['/card-draft'] = { status: 200, body: {}, wait: new Promise<void>(done => release = done) };
      const field = root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;
      field.value = 'acknowledged';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      const mine = { step: 'port-choice', picks: { 'port-choice': { letters: [], other: 'acknowledged' } } };
      const other = { step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: null } } };
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': mine } } });
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': other } } });
      await vi.advanceTimersByTimeAsync(20_000);
      release();
      expect(root.querySelector('.question-card [data-letter="B"]')!.getAttribute('aria-checked')).toBe('true');
    } finally {
      page.close();
      vi.useRealTimers();
    }
  });

  it('sends Other text at the scope generation the same session is shown at after a reconnect, and keeps it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, source } = start();
    try {
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      const items = [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })];
      hello(source, { items, questions });
      await vi.advanceTimersByTimeAsync(0);
      const field = () => root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;
      field().value = 'keep across reconnect';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      // The stream reconnects and the hub shows the same session at a new scope generation before the typing pauses.
      hello(source, { key: 'reconnected', items, questions, scope: { ...scope, scopeGen: 1 } });
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      expect(posts.filter((post) => post.url.endsWith('/card-draft')).at(-1)?.body).toMatchObject({ sessionId: 's', scopeGen: 1, draft: { picks: { 'port-choice': { other: 'keep across reconnect' } } } });
      expect(field()?.value).toBe('keep across reconnect');
    } finally {
      page.close();
      vi.useRealTimers();
    }
  });

  it('waits for every Other text still on its way before it opens another work item', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, source } = start();
    try {
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })], questions });
      await vi.advanceTimersByTimeAsync(0);
      const type = (text: string) => {
        const field = root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;
        field.value = text;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      };
      let first = () => {};
      let second = () => {};
      answers['/card-draft'] = { status: 200, body: {}, wait: new Promise<void>(done => first = done) };
      type('first');
      click('#list [data-work-item="2"]');
      answers['/card-draft'] = { status: 200, body: {}, wait: new Promise<void>(done => second = done) };
      type('second');
      click('#list [data-work-item="1"]');
      first();
      await vi.advanceTimersByTimeAsync(0);
      posts = [];
      click('#list [data-work-item="2"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.filter(post => post.url.endsWith('/select'))).toEqual([]);
      second();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      page.close();
      vi.useRealTimers();
    }
  });

  it('keeps newer Other text when an older draft the hub carried back times out, so Send sends the newer text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, source } = start();
    let release = () => {};
    try {
      const questions = { sessionId: 's', since: 0, open: 1, oldest: 'reply:r1', drafts: {}, dismissed: [] };
      hello(source, { items: [reply('r1', 2, { opening: '1. Which port? {#port-choice}\n   - A) 1\n   - B) 2' })], questions });
      await vi.advanceTimersByTimeAsync(0);
      answers['/card-draft'] = { status: 200, body: {}, wait: new Promise<void>(done => release = done) };
      const field = () => root.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;
      field().value = 'acknowledged';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(COMMENT_SETTLE_MS);
      source.emit('questions', { questions: { ...questions, drafts: { 'reply:r1': { step: 'port-choice', picks: { 'port-choice': { letters: [], other: 'acknowledged' } } } } } });
      await vi.advanceTimersByTimeAsync(19_900);
      field().value = 'newest still typing';
      field().dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);
      expect(field()?.value).toBe('newest still typing');
      click('[data-action="card-send"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(posts.filter(post => post.url.endsWith('/send')).at(-1)?.body['answers']).toEqual([{ card: 'reply:r1', slug: 'port-choice', letters: [], other: 'newest still typing' }]);
    } finally {
      release();
      page.close();
      vi.useRealTimers();
    }
  });

  it("fits each fade to its details' lines when drawn, and opens for good, with no fade, details too short to fade", () => {
    // The page's other observers are left out: only the one that observes the fades' details.
    const observed: Element[] = [];
    let fit: ((entries: Array<{ target: Element }>) => void) | null = null;
    const had = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');

    vi.stubGlobal('ResizeObserver', class {
      constructor(readonly callback: (entries: Array<{ target: Element }>) => void) {}

      observe(target: Element): void {
        if (target.classList.contains('reply-more-text')) {
          observed.push(target);
          fit = this.callback;
        }
      }

      unobserve(target: Element): void {
        if (observed.includes(target)) {
          observed.splice(observed.indexOf(target), 1);
        }
      }

      disconnect(): void {
        if (fit === this.callback) {
          observed.length = 0;
          disconnected = true;
        }
      }
    });
    let disconnected = false;
    // Each paragraph of details is one line, 20 px below the one before.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        const text = this.startContainer;
        const box = text.parentElement!.closest('.reply-more-text')!;
        const index = [...box.querySelectorAll('p')].indexOf(text.parentElement as HTMLParagraphElement);

        return [{ top: index * 20, bottom: index * 20 + 16, height: 16, width: 100 }];
      },
    });
    onTestFinished(() => {
      vi.unstubAllGlobals();
      if (had === undefined) {
        delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
      } else {
        Object.defineProperty(Range.prototype, 'getClientRects', had);
      }
    });
    const { page, source } = start();
    const paragraphs = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}.`).join('\n\n');

    // The newest reply shows whole, with no fade to fit, until a newer one comes.
    hello(source, { items: [reply('r1', 2, { opening: `Short.\n\n${paragraphs(3)}`, speak: 'Short.' }), reply('r2', 3, { opening: `Long.\n\n${paragraphs(6)}`, speak: 'Long.' }), reply('n1', 4, { opening: 'Next.' })], settings: { briefReplies: true } });
    expect(observed.map((text) => text.closest<HTMLElement>('li.reply')!.dataset['id'])).toEqual(['r1', 'r2']);
    fit!(observed.map((target) => ({ target })));

    // Three lines hide nothing worth a click: the reply opens, with no fade and nothing to click, and is no longer observed.
    const short = root.querySelector('li[data-id="r1"]')!;
    expect(short.classList.contains('folded')).toBe(false);
    expect(short.querySelector('.reply-fade')).toBeNull();
    expect(short.querySelector('.reply-more .reply-details')!.textContent).toContain('Line 3.');
    // Six lines fold after two whole lines and a third fading out.
    const fade = root.querySelector<HTMLElement>('li[data-id="r2"] .reply-fade')!;
    expect(root.querySelector('li[data-id="r2"]')!.classList.contains('folded')).toBe(true);
    expect([fade.style.getPropertyValue('--sb-fade-height'), fade.style.getPropertyValue('--sb-fade-solid')]).toEqual(['56px', '36px']);
    expect(observed.map((text) => text.closest<HTMLElement>('li.reply')!.dataset['id'])).toEqual(['r2']);
    // Opened, it is no longer observed either.
    click('li[data-id="r2"] .reply-fade');
    expect(observed).toEqual([]);

    // A focused fade that a wider page makes too short to fade gives the focus to its reply as it opens.
    source.emit('reply', { reply: reply('r3', 5, { opening: `Wide.\n\n${paragraphs(5)}`, speak: 'Wide.' }) });
    expect(observed).toEqual([]);
    source.emit('reply', { reply: reply('n2', 6, { opening: 'Next.' }) });
    const wide = root.querySelector<HTMLElement>('li[data-id="r3"] .reply-fade')!;
    fit!(observed.map((target) => ({ target })));
    expect(root.querySelector('li[data-id="r3"]')!.classList.contains('folded')).toBe(true);
    wide.focus();
    wide.querySelectorAll('p')[4]!.remove();
    wide.querySelectorAll('p')[3]!.remove();
    fit!(observed.map((target) => ({ target })));
    expect(root.querySelector('li[data-id="r3"]')!.classList.contains('folded')).toBe(false);
    expect(document.activeElement).toBe(root.querySelector('li.reply[data-id="r3"]'));

    // Closing the page lets go of the fades still folded.
    source.emit('reply', { reply: reply('r4', 7, { opening: `Last.\n\n${paragraphs(6)}`, speak: 'Last.' }) });
    source.emit('reply', { reply: reply('n3', 8, { opening: 'Next.' }) });
    expect(observed).toHaveLength(1);
    page.close();
    expect(disconnected).toBe(true);
    expect(observed).toEqual([]);
  });

  it('opens a folded reply for good on a click on its fade, with no Show less', () => {
    const { page, source } = start();

    hello(source, { items: [reply('r1', 2, { opening: 'Short.\n\nWhole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: true } });
    root.querySelector<HTMLElement>('li[data-id="r1"] .reply-fade')!.focus();
    click('li[data-id="r1"] .reply-fade');
    expect(root.querySelector('li[data-id="r1"] .reply-details')!.closest('.reply-fade')).toBeNull();
    expect(root.querySelector('li[data-id="r1"] .reply-fade')).toBeNull();
    expect(root.querySelector('li[data-id="r1"]')!.classList.contains('folded')).toBe(false);
    // The fade goes, and the reply takes its focus rather than leaving it to the page.
    expect(document.activeElement).toBe(root.querySelector('li.reply[data-id="r1"]'));
    expect(root.querySelector('#panel')!.textContent).not.toContain('Show less');
    // The reply stays open as the state changes.
    source.emit('reply', { reply: reply('r2', 4, { opening: 'Next.', speak: 'Next.' }) });
    expect(root.querySelector('#panel')!.textContent).toContain('Whole reply.');
    page.close();
  });

  it('shows the newest reply whole and folds it only once a newer reply comes, leaving a reply opened by a click open', () => {
    const { page, source } = start();
    const folded = (id: string) => root.querySelector(`li[data-id="${id}"]`)!.classList.contains('folded');

    hello(source, { items: [reply('r1', 2, { opening: 'First.\n\nDetails of r1.', speak: 'First.' })], settings: { briefReplies: true } });
    expect(folded('r1')).toBe(false);
    expect(shownText()).toContain('Details of r1.');
    source.emit('reply', { reply: reply('r2', 3, { opening: 'Second.\n\nDetails of r2.', speak: 'Second.' }) });
    expect(folded('r1')).toBe(true);
    expect(folded('r2')).toBe(false);
    expect(shownText()).not.toContain('Details of r1.');
    expect(shownText()).toContain('Details of r2.');
    // Opened by a click, it stays open as newer replies come, and the one they replace folds.
    click('li[data-id="r1"] .reply-fade');
    source.emit('reply', { reply: reply('r3', 4, { opening: 'Third.' }) });
    expect(folded('r1')).toBe(false);
    expect(folded('r2')).toBe(true);
    page.close();
  });

  it("follows a link in a folded reply's faded lines as a link, and opens the reply on a click on the faded text around it", () => {
    const { page, source } = start();
    const folded = () => root.querySelector('li[data-id="r1"]')!.classList.contains('folded');

    hello(source, { items: [reply('r1', 2, { opening: 'Fixed it.\n\nSee [the log](https://example.com/log) for more.', speak: 'Fixed it.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: true } });
    const link = root.querySelector<HTMLAnchorElement>('li[data-id="r1"] .reply-fade a')!;
    const followed: boolean[] = [];

    link.addEventListener('click', (event) => { followed.push(true); event.preventDefault(); });
    link.click();
    expect(followed).toEqual([true]);
    expect(folded()).toBe(true);
    click('li[data-id="r1"] .reply-fade p');
    expect(folded()).toBe(false);
    expect(root.querySelector('li[data-id="r1"] .reply-more a')!.hasAttribute('tabindex')).toBe(false);
    page.close();
  });

  it('opens a folded reply on a click on its text or Enter or Space on its fade, but not on a click on a link, a selection or a modified key', () => {
    const { page, source } = start();
    const folded = (id: string) => root.querySelector(`li[data-id="${id}"]`)!.classList.contains('folded');
    const keyOn = (target: Element, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    const items = ['r1', 'r2', 'r3', 'r4'].map((id, index) => reply(id, index + 1, { opening: `See [the PR](https://example.com/${id}).\n\nDetails of ${id}.`, speak: `See [the PR](https://example.com/${id}).` }));

    hello(source, { items: [...items, reply('n1', 5, { opening: 'Next.' })], settings: { briefReplies: true } });
    // A link in the primary response opens as a link and leaves the reply folded.
    const link = root.querySelector<HTMLAnchorElement>('li[data-id="r1"] .reply-primary a')!;
    const opened: boolean[] = [];
    link.addEventListener('click', (event) => { opened.push(true); event.preventDefault(); });
    link.click();
    expect(opened).toEqual([true]);
    expect(folded('r1')).toBe(true);
    // A click on the primary response's text opens it.
    click('li[data-id="r1"] .reply-primary p');
    expect(folded('r1')).toBe(false);
    expect(root.querySelector('li[data-id="r1"] .body')!.textContent).toContain('Details of r1.');
    // A click that ends a drag selecting text leaves it folded.
    const text = root.querySelector('li[data-id="r2"] .reply-primary p')!;
    document.getSelection()!.selectAllChildren(text);
    click('li[data-id="r2"] .reply-primary p');
    expect(folded('r2')).toBe(true);
    document.getSelection()!.removeAllRanges();
    // Enter and Space on the fade open the reply and move the focus to it; a key with Ctrl does not.
    const fade3 = root.querySelector<HTMLElement>('li[data-id="r3"] .reply-fade')!;
    fade3.focus();
    expect(keyOn(fade3, { key: 'Enter', ctrlKey: true })).toBe(true);
    expect(folded('r3')).toBe(true);
    expect(keyOn(fade3, { key: 'Enter' })).toBe(false);
    expect(folded('r3')).toBe(false);
    expect(document.activeElement).toBe(root.querySelector('li.reply[data-id="r3"]'));
    const fade4 = root.querySelector<HTMLElement>('li[data-id="r4"] .reply-fade')!;
    expect(keyOn(fade4, { key: ' ' })).toBe(false);
    expect(folded('r4')).toBe(false);
    page.close();
  });

  it("sets voice.briefReplies from View options' Collapse details on this computer's page, follows the hub's settings, and keeps a paired device's choice on that device", async () => {
    const { page, source } = start();
    const briefRow = () => root.querySelector('[data-action="toggle-brief-replies"]');

    // Collapse details is off by default: a reply shows whole.
    hello(source, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })] });
    expect(shownText()).toContain('Whole reply.');
    click('.header button.view-options');
    expect(briefRow()!.getAttribute('aria-checked')).toBe('false');
    expect(briefRow()!.getAttribute('role')).toBe('menuitemcheckbox');
    click('[data-action="toggle-brief-replies"]');
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/brief-replies')).map((post) => post.body)).toEqual([expect.objectContaining({ window: 'pk', on: true })]);
    // The checkbox and the replies follow settings.json as the hub reloads it, not the click.
    expect(briefRow()!.getAttribute('aria-checked')).toBe('false');
    source.emit('settings', { settings: { briefReplies: true, diffLayout: 'auto', diffWrap: 'auto' } });
    expect(briefRow()!.getAttribute('aria-checked')).toBe('true');
    expect(shownText()).not.toContain('Whole reply.');

    // A second click before the hub's settings event reverses the first; the saves go one at a time, so the last click's value is the one kept.
    let answer = () => {};
    const sent = () => posts.filter((post) => post.url.endsWith('/brief-replies')).map((post) => post.body['on']);

    answers['/brief-replies'] = { status: 200, body: {}, wait: new Promise<void>((done) => (answer = done)) };
    click('[data-action="toggle-brief-replies"]');
    click('[data-action="toggle-brief-replies"]');
    click('[data-action="toggle-brief-replies"]');
    click('[data-action="toggle-brief-replies"]');
    await flush();
    expect(sent()).toEqual([true, false]);
    delete answers['/brief-replies'];
    answer();
    await flush();
    await flush();
    expect(sent()).toEqual([true, false, true]);
    source.emit('settings', { settings: { briefReplies: true, diffLayout: 'auto', diffWrap: 'auto' } });

    // A refusal shows why, and the setting stays as it was.
    answers['/brief-replies'] = { status: 409, body: { error: 'settings.json is not valid JSON: Unexpected token.' } };
    click('[data-action="toggle-brief-replies"]');
    await flush();
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/brief-replies')).at(-1)!.body).toMatchObject({ on: false });
    expect(root.querySelector('.toast.warning .toast-text')!.textContent).toBe('settings.json is not valid JSON: Unexpected token.');
    expect(briefRow()!.getAttribute('aria-checked')).toBe('true');
    page.close();

    // This computer's page never reads a paired device's choice.
    expect(localStorage.getItem('switchboard.briefReplies')).toBeNull();

    // A paired device may not change settings.json (architecture.md § Remote access), so its Collapse details starts from voice.briefReplies
    // and, once toggled, is kept on the device and posts nothing.
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const pairedPage = () => startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false });
    const briefPosts = () => fetch.mock.calls.filter((call) => String((call as unknown[])[0]).endsWith('/brief-replies'));
    let paired = pairedPage();

    hello(FakeSource.last!, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: false } });
    click('.header button.view-options');
    expect([...root.querySelectorAll('.view-options-menu .menu-row')].map((row) => row.textContent!.trim()).slice(0, 2)).toEqual(['Show message details', 'Collapse details']);
    expect(briefRow()!.getAttribute('aria-checked')).toBe('false');
    expect(shownText()).toContain('Whole reply.');
    click('[data-action="toggle-brief-replies"]');
    await flush();
    expect(briefPosts()).toEqual([]);
    expect(localStorage.getItem('switchboard.briefReplies')).toBe('1');
    expect(briefRow()!.getAttribute('aria-checked')).toBe('true');
    expect(shownText()).not.toContain('Whole reply.');

    // The device's choice outlasts the hub's settings and a reload.
    FakeSource.last!.emit('settings', { settings: { briefReplies: false, diffLayout: 'auto', diffWrap: 'auto' } });
    expect(briefRow()!.getAttribute('aria-checked')).toBe('true');
    paired.close();
    paired = pairedPage();
    hello(FakeSource.last!, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: false } });
    expect(shownText()).not.toContain('Whole reply.');
    click('.header button.view-options');
    click('[data-action="toggle-brief-replies"]');
    expect(localStorage.getItem('switchboard.briefReplies')).toBe('0');
    expect(briefRow()!.getAttribute('aria-checked')).toBe('false');
    expect(shownText()).toContain('Whole reply.');
    expect(briefPosts()).toEqual([]);
    paired.close();
  });

  it("starts a paired device's Collapse details from the Expand replies it kept before, inverted, and drops the old key once toggled", async () => {
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const pairedPage = () => startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, local: false });
    const briefRow = () => root.querySelector('[data-action="toggle-brief-replies"]');

    localStorage.setItem('switchboard.expandReplies', '0');
    let paired = pairedPage();

    hello(FakeSource.last!, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: false } });
    expect(shownText()).not.toContain('Whole reply.');
    click('.header button.view-options');
    expect(briefRow()!.getAttribute('aria-checked')).toBe('true');
    click('[data-action="toggle-brief-replies"]');
    expect(localStorage.getItem('switchboard.briefReplies')).toBe('0');
    expect(localStorage.getItem('switchboard.expandReplies')).toBeNull();
    paired.close();

    localStorage.removeItem('switchboard.briefReplies');
    localStorage.setItem('switchboard.expandReplies', '1');
    paired = pairedPage();
    hello(FakeSource.last!, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: true } });
    expect(shownText()).toContain('Whole reply.');
    paired.close();
    localStorage.clear();
  });

  it('opens the dropdown, selects another conversation, pages back, and folds a focused reply', async () => {
    const { page, source } = start();

    hello(source, { items: [reply('r1', 2, { opening: 'Whole reply.', speak: 'Short.' }), reply('n1', 3, { opening: 'Next.' })], settings: { briefReplies: true } });
    expect(root.querySelector('#panel')!.textContent).toContain('Short.');
    click('[data-action="more"]');
    expect(shownText()).toContain('Whole reply.');
    click('[data-action="picker"]');
    expect([...root.querySelectorAll('.conversation-menu .menu-row')].map((row) => row.textContent)).toEqual(['Fix it', 'Side', 'New conversation…']);
    click('.conversation-menu [data-work-item="2"]');
    await flush();
    expect(posts.find((post) => post.url.endsWith('/select'))?.body['workItemId']).toBe(2);
    expect(location.hash).toBe('#w=2');
    answers['/history'] = { status: 200, body: { items: [message('m0', 0)], more: false } };
    click('[data-action="earlier"]');
    await flush();
    await flush();
    expect(page.state().items[0]!.id).toBe('m0');
    page.close();
  });

  it('lists files after @ and commands after /, inserts the choice, and walks earlier messages with Up', async () => {
    const { page, source } = start();

    hello(source);

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;

    answers['/files'] = { status: 200, body: { files: [{ path: 'src/my file.ts', dir: false }] } };
    input.value = 'see @my';
    input.setSelectionRange(7, 7);
    input.dispatchEvent(new Event('input'));
    await flush();
    await flush();
    expect(posts.some((post) => post.url === '/v1/conversation/files?window=pk&q=my')).toBe(true);
    expect(root.querySelector('.composer-menu')!.textContent).toContain('src/my file.ts');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(input.value).toBe('see @"src/my file.ts" ');

    answers['/commands'] = { status: 200, body: { commands: [{ name: 'review', description: 'Review it' }, { name: 'clear', description: '' }] } };
    input.value = '/re';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event('input'));
    await flush();
    await flush();
    expect(root.querySelector('.composer-menu')!.textContent).toContain('/review');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(input.value).toBe('/review ');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(posts.find((post) => post.url.endsWith('/send'))?.body).toMatchObject({ text: '/review ', command: true });

    input.value = '';
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(input.value).toBe('text m1');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(input.value).toBe('');
    page.close();
  });

  it('closes only the composer list, or stops only the speech, on an Escape in the composer, leaving the maximized column and keeping speech for a later Escape', async () => {
    const width = window.innerWidth;

    window.innerWidth = 1440;

    const { page, source } = start();

    hello(source);
    click('#detail .panel-max');
    expect(root.classList.contains('maximized')).toBe(true);

    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
    const escape = (target: HTMLElement) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const stops = () => posts.filter((post) => post.url.endsWith('/stop-speaking')).length;

    answers['/files'] = { status: 200, body: { files: [{ path: 'src/a.ts', dir: false }] } };
    input.value = '@a';
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event('input'));
    await flush();
    await flush();
    expect(root.querySelector<HTMLElement>('.composer-menu')!.hidden).toBe(false);
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'off', speaking: 'r1', speakReplies: true, error: null } });
    // The first Escape closes the list alone: the column stays maximized and the reply goes on.
    escape(input);
    await flush();
    expect(root.querySelector<HTMLElement>('.composer-menu')!.hidden).toBe(true);
    expect(root.classList.contains('maximized')).toBe(true);
    expect(stops()).toBe(0);
    // The next stops the speech alone.
    escape(input);
    await flush();
    expect(stops()).toBe(1);
    expect(root.classList.contains('maximized')).toBe(true);
    // With nothing left in the composer, Escape restores the column.
    source.emit('voice', { voice: { enabled: true, here: true, mic: 'off', speaking: null, speakReplies: true, error: null } });
    escape(input);
    expect(root.classList.contains('maximized')).toBe(false);
    window.innerWidth = width;
    page.close();
  });

});
