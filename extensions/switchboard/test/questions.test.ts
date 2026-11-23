import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ItemView, MessageView, ReplyView, ScopeView, SessionView, StatusView } from '@switchboard/hub';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationState } from '../src/conversationModel.js';
import { startConversation } from '../src/webview/conversationMain.js';
import { renderConversation } from '../src/webview/conversationRender.js';

const T0 = Date.UTC(2026, 10, 19, 12);
const SCOPE: ScopeView = { kind: 'item', workItemId: 2, key: 'k1', folder: 'D:/w', title: 'Fix the badge', cwd: 'D:/w', scopeGen: 1, sessionId: 's2', conversations: [{ workItemId: 2, title: 'Fix the badge', primary: true, sessionId: 's2', state: 'idle', conversation: 'full', unread: 0 }] };
const SESSION: SessionView = { id: 's2', kind: 'task', title: 'Task session aaaa', state: 'idle', waitingFor: null, launch: 'l', current: true, conversation: 'full', reason: null, persona: null };
const reply = (id: string, at: number, opening: string, patch: Partial<ReplyView> = {}): ReplyView => ({ type: 'reply', id, sessionId: 's2', at, ord: at, provisional: false, kind: 'reply', answers: null, opening, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null }, ...patch });
const message = (id: string, at: number, text: string, patch: Partial<MessageView> = {}): MessageView => ({ type: 'message', id, sessionId: 's2', workItemId: 2, at, ord: at, origin: 'typed', text, provisional: false, withdrawn: false, delivery: 'sent', error: null, ...patch });
const state = (items: ItemView[], patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items, more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: null, settings: { briefReplies: true }, ...patch });

/** The shape the conversation rules show, with a second question. */
const ASKED = 'Two things before I start:\n\n1. Which port?\n   - A) 8765 (recommended)\n   - B) 8799\n2. **Keep the old route?**\n   - A) Yes\n   - B) No, remove it\n   - C) Keep it behind a flag\n\nSay if neither fits.';
/** The shape the new rules ask for. */
const NEW = 'Two decisions:\n\n1. **Port.** Which port? {#port-choice}\n   Today it is 8765.\n   - A) 8765 (recommended) — the default.\n   - B) 8799 — free on this machine.\n2. Keep the old route? {#keep-route}\n   - A) Keep it\n   - B) Remove it';
const QUESTIONS = { sessionId: 's2', since: 0, open: 2, oldest: 'reply:r1', drafts: {}, dismissed: [] };

describe('question cards in the Conversation view', () => {
  function page() {
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

    const post = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
    const show = (next: ConversationState) => post({ type: 'state', state: next });
    const card = () => root.querySelector<HTMLElement>('.question-card');
    const option = (letter: string) => root.querySelector<HTMLButtonElement>(`.qc-option[data-letter="${letter}"]`)!;
    const button = (action: string) => root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
    const sends = () => posted.filter((one) => one.type === 'send');
    const drafts = () => posted.filter((one) => one.type === 'card-draft');

    return { root, host, posted, post, show, card, option, button, sends, drafts };
  }

  it('draws the shared card under a reply that asks, one question at a time, and none under an aside or a plain reply', () => {
    const root = document.createElement('div');

    root.innerHTML = renderConversation(state([reply('r2', T0 - 1, 'Done.'), reply('r1', T0, NEW), reply('r3', T0 + 2, '[aside] x\n\n1. Q?\n- A) a\n- B) b', { kind: 'aside' })], { questions: QUESTIONS }));

    const cards = root.querySelectorAll('.question-card');

    expect(cards).toHaveLength(1);
    expect(cards[0]!.closest('li')?.dataset['id']).toBe('r1');
    expect(cards[0]!.querySelector('.qc-progress')?.textContent).toBe('Question 1 of 2');
    expect(cards[0]!.querySelector('.qc-topic')?.textContent).toBe('Port');
    expect(cards[0]!.querySelector('.qc-context')?.textContent).toBe('Today it is 8765.');
    expect([...cards[0]!.querySelectorAll('.qc-option .qc-label')].map((one) => one.textContent)).toEqual(['8765', '8799', 'Other']);
    expect(cards[0]!.querySelector('.qc-recommended')).not.toBeNull();
    // The question's id and the questions themselves are left out of the reply's text.
    expect(root.querySelector('li[data-id="r1"] .body')?.textContent?.trim()).toBe('Two decisions:');
    // The view's build takes the shared styles.
    expect(readFileSync(join(__dirname, '../esbuild.js'), 'utf8')).toContain("'@switchboard/conversation/questionCard.css'");
  });

  it('picks, moves on, keeps the draft on the hub, and sends the picks for the hub to write', () => {
    vi.useFakeTimers();

    try {
      const { show, option, button, sends, drafts, post, card } = page();

      show(state([reply('r1', T0, NEW)], { questions: QUESTIONS }));
      option('B').click();
      expect(option('B').getAttribute('aria-checked')).toBe('true');
      expect(drafts().at(-1)).toMatchObject({ card: 'reply:r1', draft: { step: 'port-choice', picks: { 'port-choice': { letters: ['B'], other: null } } }, target: { scopeGen: 1, sessionId: 's2', launch: 'l' } });
      vi.advanceTimersByTime(200);
      expect(card()!.dataset['step']).toBe('keep-route');
      expect(button('card-send').textContent).toBe('Send 1 of 2');
      option('A').click();
      expect(button('card-send').textContent).toBe('Send 2 answers');
      button('card-send').click();
      expect(sends()).toEqual([{ type: 'send', id: 1_000_000, target: { scopeGen: 1, sessionId: 's2', launch: 'l' }, answers: [{ card: 'reply:r1', slug: 'port-choice', letters: ['B'], other: '' }, { card: 'reply:r1', slug: 'keep-route', letters: ['A'], other: '' }] }]);
      expect(button('card-send').textContent).toBe('Sending…');
      // A refusal shows on the card and keeps its picks.
      post({ type: 'sent', id: 1_000_000, error: 'That question was withdrawn.' });
      expect(card()!.querySelector('.qc-error')?.textContent).toBe('That question was withdrawn.');
      expect(option('A').getAttribute('aria-checked')).toBe('true');
      // Taken, the message settles the questions.
      show(state([reply('r1', T0, NEW), message('m1', T0 + 1, '[answers]\n- port-choice: Which port? → B) 8799\n- keep-route: Keep the old route? → A) Keep it', { answers: [{ replyId: 'r1', slug: 'port-choice', letters: ['B'], other: '', via: 'card' }, { replyId: 'r1', slug: 'keep-route', letters: ['A'], other: '', via: 'card' }] })], { questions: { ...QUESTIONS, open: 0, oldest: null } }));
      expect(card()!.querySelector('.qc-done .qc-progress')?.textContent).toBe('All 2 questions answered');
      expect(card()!.querySelector('.qc-done [data-action="goto-message"]')?.textContent).toBe('Your answer');
      expect(card()!.querySelectorAll('.qc-row')).toHaveLength(0);
      expect([...document.querySelectorAll('.answers-line')].map((one) => one.textContent)).toEqual(['Port: 8799', 'Keep the old route? Keep it']);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the hub's draft from another window, Other's text, and Dismiss in the card's menu", () => {
    vi.useFakeTimers();

    const { show, root, option, button, posted, drafts } = page();

    show(state([reply('r1', T0, NEW)], { questions: { ...QUESTIONS, drafts: { 'reply:r1': { step: 'keep-route', picks: { 'port-choice': { letters: ['A'], other: null } } } } } }));
    expect(root.querySelector('.question-card')!.getAttribute('data-step')).toBe('keep-route');
    button('card-other').click();

    const field = root.querySelector<HTMLTextAreaElement>('textarea.qc-other')!;

    expect(field).not.toBeNull();
    field.value = 'later';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(drafts().at(-1)).toMatchObject({ draft: { step: 'keep-route', picks: { 'keep-route': { letters: [], other: '' } } } });
    // The text reaches the hub once the typing pauses.
    vi.advanceTimersByTime(400);
    expect(drafts().at(-1)).toMatchObject({ draft: { step: 'keep-route', picks: { 'keep-route': { letters: [], other: 'later' } } } });
    vi.useRealTimers();
    button('card-back').click();
    expect(option('A').getAttribute('aria-checked')).toBe('true');
    button('card-menu').click();
    button('card-dismiss').click();
    expect(posted.filter((one) => one.type === 'card-dismiss')).toMatchObject([{ card: 'reply:r1', slug: 'port-choice', target: { sessionId: 's2' } }]);
  });

  it('answers from the keyboard: a letter picks, Enter goes on, Backspace goes back', () => {
    const { show, root, option } = page();
    const key = (name: string) => root.querySelector('.question-card')!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

    show(state([reply('r1', T0, NEW)], { questions: QUESTIONS }));
    key('a');
    expect(option('A').getAttribute('aria-checked')).toBe('true');
    key('Enter');
    expect(root.querySelector('.question-card')!.getAttribute('data-step')).toBe('keep-route');
    key('Backspace');
    expect(root.querySelector('.question-card')!.getAttribute('data-step')).toBe('port-choice');
  });

  it('keeps a card open under a message that answers nothing, and shows withdrawn and replaced questions as rows', () => {
    const { show, card } = page();

    show(state([reply('r1', T0, NEW), message('m1', T0 + 1, 'Hold off for now.')], { questions: QUESTIONS }));
    expect(card()!.querySelector('.qc-option')).not.toBeNull();
    show(state([reply('r1', T0, NEW), reply('r2', T0 + 1, 'Ok.\n[withdraw: port-choice — settled]'), reply('r3', T0 + 2, '1. Keep it? {#keep-route}\n   - A) Yes\n   - B) No')], { questions: QUESTIONS }));
    expect([...card()!.querySelectorAll('.qc-state')].map((one) => one.getAttribute('title'))).toEqual(['Withdrawn', 'Replaced']);
    expect(card()!.querySelector('.qc-row-detail')?.textContent).toBe('Withdrawn by the session: "settled"');
  });

  it('keeps the old rules for a card asked before the cutover: the next message answers or skips it', () => {
    const { show, card } = page();

    show(state([reply('r1', T0, ASKED), message('m1', T0 + 1, '1A, 2B')]));
    expect(card()!.querySelectorAll('.qc-row')).toHaveLength(0);
    expect([...document.querySelectorAll('.answer-ref-answer')].map((one) => one.textContent)).toEqual(['→ 8765', '→ No, remove it']);
    show(state([reply('r1', T0, ASKED), message('m1', T0 + 1, 'Later.')]));
    expect(card()!.querySelector('.qc-state')?.getAttribute('title')).toBe('Skipped');
  });

  it('returns an answer message that was not sent to its card, not the composer', () => {
    const { show, post, card, host } = page();

    show(state([reply('r1', T0, NEW)], { questions: QUESTIONS }));
    post({ type: 'unsent', returned: [{ text: '[answers]\n- port-choice: Which port? → A) 8765', error: 'The session ended.', workItemId: 2 }] });
    expect(card()!.querySelector('.qc-error')?.textContent).toBe('The session ended.');
    expect(host.querySelector('textarea')?.value ?? '').toBe('');
  });

  it('leaves questions that end a reply out of its text, since the card draws them, and folds questions written mid-message into one line', () => {
    const { show, root } = page();
    const ending = 'Two things before I start:\n\n1. Which port?\n   - A) 8765\n   - B) 8799';

    show(state([reply('r1', T0, ending)]));
    expect(root.querySelector('li[data-id="r1"] > .body')?.textContent?.trim()).toBe('Two things before I start:');
    expect(root.querySelector('li[data-id="r1"] .question-card')).not.toBeNull();
    // ASKED has text after its questions, against the rules: they stay in place, folded, and open on a click.
    show(state([reply('r1', T0, ASKED)]));

    const fold = root.querySelector<HTMLDetailsElement>('li[data-id="r1"] > .body > details.questions-fold')!;

    expect(fold.querySelector('summary')?.textContent).toBe('2 questions — answer below');
    expect(fold.open).toBe(false);
    expect(fold.textContent).toContain('Which port?');
    expect(root.querySelector('li[data-id="r1"] > .body')?.textContent).toContain('Say if neither fits.');
    fold.open = true;
    fold.dispatchEvent(new Event('toggle'));
    show(state([reply('r1', T0, ASKED)]));
    expect(root.querySelector<HTMLDetailsElement>('details.questions-fold')!.open).toBe(true);
    // The copy button still copies the reply whole.
    expect(root.querySelector('li[data-id="r1"] [data-action="copy-reply"]')).not.toBeNull();
    // Questions before a spoken passage fold too, with the whole reply shown, rather than leaving the text.
    show(state([reply('r1', T0, `${ending}\n\nThen I start.`, { speak: 'Then I start.' })], { settings: { briefReplies: false } }));
    expect(root.querySelector('li[data-id="r1"] details.questions-fold summary')?.textContent).toBe('1 question — answer below');
    expect(root.querySelector('li[data-id="r1"] .reply-primary')?.textContent?.trim()).toBe('Then I start.');
  });

  it("shows a status's questions on the Status tab as plain Markdown, with no card or fold", () => {
    const { show, root } = page();
    const status: StatusView = { id: 'st-r1', sessionId: 's2', at: T0, markdown: `Blocked on two choices.\n\n${ASKED}`, fallback: false, unread: false };

    show(state([reply('r1', T0, '')], { status }));
    root.querySelector<HTMLElement>('[role="tab"][data-tab="status"]')!.click();
    expect(root.querySelector('.status-tab .status-body')?.textContent).toContain('Blocked on two choices.');
    expect(root.querySelectorAll('.status-tab .status-body ol > li')).toHaveLength(2);
    expect(root.querySelector('.question-card')).toBeNull();
    expect(root.querySelector('.questions-fold')).toBeNull();
  });

  it('shows how many questions wait over the composer while the answerable card is off screen, and goes to it on a click', () => {
    const { show, root, host } = page();
    const scrolled: string[] = [];
    let cardTop = -500;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const original = Element.prototype.getBoundingClientRect;

    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.classList.contains('scroll') ? rect(0, 400) : this.classList.contains('question-card') ? rect(cardTop, 200) : rect(0, 0);
    };
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset['card'] ?? '');
    };

    try {
      const chip = () => host.querySelector<HTMLElement>('.question-waiting');

      show(state([reply('r1', T0, ASKED), reply('r2', T0 + 1, 'Checking the ports.', { kind: 'aside' })]));
      expect(chip()!.hidden).toBe(false);
      expect(chip()!.textContent).toBe('2 questions waiting');
      chip()!.click();
      expect(scrolled).toEqual(['reply:r1']);
      // In view, it hides; scrolled away again, it shows.
      cardTop = 100;
      root.querySelector('.scroll')!.dispatchEvent(new Event('scroll'));
      expect(chip()!.hidden).toBe(true);
      cardTop = 390;
      root.querySelector('.scroll')!.dispatchEvent(new Event('scroll'));
      expect(chip()!.hidden).toBe(false);
      // Over the composer on another tab too, where the card is not shown; a click goes back to it.
      root.querySelector<HTMLElement>('[role="tab"][data-tab="artifacts"]')!.click();
      expect(chip()!.hidden).toBe(false);
      chip()!.click();
      expect(root.querySelector('[role="tab"][data-tab="conversation"]')?.getAttribute('aria-selected')).toBe('true');
      expect(scrolled).toEqual(['reply:r1', 'reply:r1']);
      // Answered, skipped or superseded, or while the view cannot answer, there is none.
      for (const [items, patch] of [
        [[reply('r1', T0, ASKED), message('m1', T0 + 1, '1A')], {}],
        [[reply('r1', T0, ASKED), message('m1', T0 + 1, 'Later.')], {}],
        [[reply('r1', T0, ASKED), reply('r2', T0 + 1, 'Never mind.')], {}],
        [[reply('r1', T0, ASKED)], { connected: false }],
        [[reply('r1', T0, ASKED)], { session: { ...SESSION, state: 'ended' as const, conversation: 'read-only' as const } }],
      ] as Array<[ItemView[], Partial<ConversationState>]>) {
        show(state(items, patch));
        expect(chip()!.hidden).toBe(true);
      }
      // A status's questions get no card, so no chip.
      show(state([reply('r1', T0, '')], { status: { id: 'st-r1', sessionId: 's2', at: T0, markdown: '1. Go?\n   - A) Yes\n   - B) No', fallback: false, unread: false } }));
      expect(chip()!.hidden).toBe(true);
    } finally {
      // Own properties shadow Element.prototype's, which other tests stub.
      delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect;
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });

  it('says the session waits for an answer or a permission in the terminal while a menu holds it, with Open in terminal', () => {
    const { show, root, posted } = page();

    show(state([], { session: { ...SESSION, state: 'waiting', waitingFor: 'question' } }));
    expect(root.querySelector('.working.waiting .working-label')?.textContent).toBe('Waiting for your answer');
    root.querySelector<HTMLElement>('.working.waiting button')!.click();
    expect(posted.at(-1)).toEqual({ type: 'terminal' });
    show(state([], { session: { ...SESSION, state: 'waiting', waitingFor: 'permission' } }));
    expect(root.querySelector('.working.waiting .working-label')?.textContent).toBe('Waiting for permission');
    show(state([], { session: { ...SESSION, state: 'running' } }));
    expect(root.querySelector('.working.waiting')).toBeNull();
  });
});
