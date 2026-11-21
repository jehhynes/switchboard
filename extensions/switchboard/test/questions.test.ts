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
const state = (items: ItemView[], patch: Partial<ConversationState> = {}): ConversationState => ({ scope: SCOPE, session: SESSION, items, more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: null, settings: { expandReplies: false }, ...patch });

/** The shape the conversation rules show, with a second question. */
const ASKED = 'Two things before I start:\n\n1. Which port?\n   - A) 8765 (recommended)\n   - B) 8799\n2. **Keep the old route?**\n   - A) Yes\n   - B) No, remove it\n   - C) Keep it behind a flag\n\nSay if neither fits.';
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
    const option = (question: number, letter: string) => root.querySelector<HTMLButtonElement>(`.question-option[data-question="${question}"][data-letter="${letter}"]`)!;
    const other = (question: number) => root.querySelector<HTMLInputElement>(`.question-other[data-question="${question}"]`)!;
    const submit = () => root.querySelector<HTMLButtonElement>('.question-submit')!;
    const sends = () => posted.filter((one) => one.type === 'send');

    return { root, host, posted, post, show, card, option, other, submit, sends };
  }

  it('draws a card under a reply that asks lettered questions, as Claude Code\'s question form, and none under an aside or a plain reply', () => {
    const root = document.createElement('div');

    root.innerHTML = renderConversation(state([reply('r1', T0, ASKED), reply('r2', T0 + 1, 'Done.'), reply('r3', T0 + 2, '[aside] x\n\n1. Q?\n- A) a\n- B) b', { kind: 'aside' })]));

    const cards = root.querySelectorAll('.question-card');

    expect(cards).toHaveLength(1);
    expect(cards[0]!.closest('li')?.dataset['id']).toBe('r1');
    expect([...cards[0]!.querySelectorAll('.question-text')].map((one) => one.textContent)).toEqual(['1. Which port?', '2. Keep the old route?']);
    expect([...cards[0]!.querySelectorAll('.question-option')].map((one) => one.textContent)).toEqual(['A 8765 (recommended)', 'B 8799', 'A Yes', 'B No, remove it', 'C Keep it behind a flag']);
    expect(cards[0]!.querySelectorAll('[role="radiogroup"]')).toHaveLength(2);
    expect(cards[0]!.querySelectorAll('.question-other')).toHaveLength(2);
    expect(cards[0]!.querySelector<HTMLButtonElement>('.question-submit')?.disabled).toBe(true);
    // The reply itself still shows whole.
    expect(root.querySelector('li[data-id="r1"] .body')?.textContent).toContain('Say if neither fits.');

    const css = readFileSync(join(__dirname, '../src/webview/conversation.css'), 'utf8');

    expect(css).toMatch(/\.question-card \{[^}]*border-radius: 8px;[^}]*background: var\(--vscode-input-background\)/);
    expect(css).toMatch(/\.question-mark\.radio\.checked \{ border-color: var\(--vscode-button-background\); \}/);
    expect(css).toMatch(/\.question-option\.dimmed \{ opacity: 0\.6; \}/);
  });

  it('picks one option per question, clears it when picked again, and sends the answer as an ordinary message on Submit', () => {
    const { show, option, submit, sends, post, card } = page();

    show(state([reply('r1', T0, ASKED)]));
    option(0, 'A').click();
    option(0, 'B').click();
    expect(option(0, 'A').getAttribute('aria-checked')).toBe('false');
    expect(option(0, 'B').getAttribute('aria-checked')).toBe('true');
    // Every question needs an answer first.
    expect(submit().disabled).toBe(true);
    option(1, 'C').click();
    expect(submit().disabled).toBe(false);
    option(1, 'C').click();
    expect(option(1, 'C').classList.contains('checked')).toBe(false);
    option(1, 'A').click();
    submit().click();
    expect(sends()).toEqual([{ type: 'send', id: 1_000_000, text: '1B, 2A', target: { scopeGen: 1, sessionId: 's2', launch: 'l' } }]);
    // Locked while it is sent and after the hub took it, until the message shows.
    expect(submit().textContent).toBe('Sending…');
    expect(option(0, 'A').disabled).toBe(true);
    submit().click();
    expect(sends()).toHaveLength(1);
    post({ type: 'sent', id: 1_000_000, error: null });
    expect(submit().disabled).toBe(true);
    show(state([reply('r1', T0, ASKED), message('m1', T0 + 1, '1B, 2A')]));
    expect(card()?.classList.contains('answered')).toBe(true);
    expect(card()?.querySelector('.question-submit')).toBeNull();
    expect(card()?.querySelector('.question-state')?.textContent).toBe('Answered');
    expect(option(0, 'B').getAttribute('aria-checked')).toBe('true');
    expect(option(0, 'A').classList.contains('dimmed')).toBe(true);
  });

  it('keeps the choices and shows why when the hub refuses the answer, and takes back an answer that was not sent', () => {
    const { show, option, submit, sends, post, card, host } = page();

    show(state([reply('r1', T0, ASKED)]));
    option(0, 'A').click();
    option(1, 'A').click();
    submit().click();
    post({ type: 'sent', id: sends().at(-1)!['id'], error: 'The session has ended.' });
    expect(card()?.querySelector('.question-error')?.textContent).toBe('The session has ended.');
    expect(option(0, 'A').getAttribute('aria-checked')).toBe('true');
    expect(submit().disabled).toBe(false);

    // The hub took it, then it was not sent: it goes back to the card, not the composer.
    submit().click();
    post({ type: 'sent', id: sends().at(-1)!['id'], error: null });
    post({ type: 'unsent', returned: [{ text: '1A, 2A', error: 'Claude Code did not take the message.', workItemId: 2 }] });
    expect(card()?.querySelector('.question-error')?.textContent).toBe('Claude Code did not take the message.');
    expect(submit().disabled).toBe(false);
    expect(host.querySelector('textarea')?.value).toBe('');
  });

  it('takes an Other answer from its field, which replaces a single question\'s pick and submits on Enter, and checkboxes for several', () => {
    const { show, option, other, submit, sends, root } = page();
    const multi = '1. Which checks? Pick any that apply.\n   - A) Lint\n   - B) Tests\n2. Port?\n   - A) 8765\n   - B) 8799';

    show(state([reply('r1', T0, multi)]));
    expect(root.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
    option(0, 'A').click();
    option(0, 'B').click();
    expect(option(0, 'A').getAttribute('aria-checked')).toBe('true');
    option(1, 'A').click();

    const field = other(1);

    field.focus();
    field.value = 'use 8800';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    // The pick goes, and the field keeps the focus over the redraw.
    expect(option(1, 'A').getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(other(1));
    expect(other(1).value).toBe('use 8800');
    other(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(sends().map((one) => one['text'])).toEqual(['1A, 1B, 2 Other: use 8800']);
    expect(submit().disabled).toBe(true);
  });

  it('marks a card answered by any later message, showing what a typed answer picked, and takes no answer while the composer could not send', () => {
    const { show, option, root } = page();

    show(state([reply('r1', T0, ASKED), message('m1', T0 + 1, '1B', { origin: 'terminal', delivery: null })]));
    expect(root.querySelector('.question-card.answered')).not.toBeNull();
    expect(option(0, 'B').getAttribute('aria-checked')).toBe('true');
    expect(option(1, 'A').classList.contains('dimmed')).toBe(true);
    expect(root.querySelector('.question-other')).toBeNull();

    // A message that ignores the questions sets the card aside as Skipped, with no picks; a later reply can ask again.
    show(state([reply('r1', T0, ASKED), message('m1', T0 + 1, 'Not now'), reply('r2', T0 + 2, ASKED)]));
    expect([...root.querySelectorAll('.question-card')].map((one) => one.className)).toEqual(['question-card skipped', 'question-card']);
    expect(root.querySelector('.question-card.skipped .question-state')?.textContent).toBe('Skipped: your next message did not answer these questions');
    expect(root.querySelector('.question-card.skipped [aria-checked="true"]')).toBeNull();
    expect(root.querySelector('.question-card.skipped')?.getAttribute('aria-label')).toBe('Questions, skipped');
    // A message still being sent leaves the card open.
    show(state([reply('r1', T0, ASKED), message('m1', T0 + 1, '1A', { delivery: 'open', provisional: true })]));
    expect(root.querySelector('.question-card')?.className).toBe('question-card');

    for (const session of [{ ...SESSION, state: 'ended' as const, conversation: 'read-only' as const, reason: 'Ended.' }, SESSION]) {
      show(state([reply('r1', T0, ASKED)], { session, connected: session === SESSION ? false : true }));
      expect(root.querySelector('.question-submit')).toBeNull();
      expect(root.querySelector('.question-other')).toBeNull();
      expect(option(0, 'A').disabled).toBe(true);
    }
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
    show(state([reply('r1', T0, `${ending}\n\nThen I start.`, { speak: 'Then I start.' })], { settings: { expandReplies: true } }));
    expect(root.querySelector('li[data-id="r1"] details.questions-fold summary')?.textContent).toBe('1 question — answer below');
    expect(root.querySelector('li[data-id="r1"] .speech-bubble')?.textContent?.trim()).toBe('Then I start.');
  });

  it('draws a card under the status on the Status tab, answered by a message after the reply it came from', () => {
    const { show, root, option, submit, sends } = page();
    const status: StatusView = { id: 'st-r1', sessionId: 's2', at: T0, markdown: `Blocked on two choices.\n\n${ASKED}`, fallback: false, unread: false };

    show(state([reply('r1', T0, '')], { status }));
    root.querySelector<HTMLElement>('[role="tab"][data-tab="status"]')!.click();
    expect(root.querySelector('.status-tab .question-card')).not.toBeNull();
    option(1, 'B').click();
    // Every question needs an answer before Submit, since the next message answers the whole card.
    expect(submit().disabled).toBe(true);
    submit().click();
    expect(sends()).toEqual([]);
    option(0, 'A').click();
    submit().click();
    expect(sends().map((one) => one['text'])).toEqual(['1A, 2B']);
    show(state([reply('r1', T0, ''), message('m1', T0 + 1, '1A, 2B')], { status }));
    expect(root.querySelector('.status-tab .question-card.answered')).not.toBeNull();
    // The stage before the first status asks nothing.
    show(state([], { status: { ...status, id: 'stage-2', fallback: true } }));
    expect(root.querySelector('.question-card')).toBeNull();
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

  it('leaves the Up and Down keys in an Other field to the field', () => {
    const { show, other } = page();

    show(state([reply('r0', T0 - 1, 'Hi'), reply('r1', T0, ASKED)]));

    const field = other(0);

    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(field);
  });
  it('answers a rewrite that asks again only with a message after the rewrite, not the one before the reply it rewrote', () => {
    const root = document.createElement('div');

    root.innerHTML = renderConversation(state([reply('r1', T0, 'Ask later.', { rewrittenBy: 'r2' }), message('m1', T0 + 1, 'More'), reply('r2', T0 + 2, ASKED, { replaces: 'r1' })]));
    expect(root.querySelector('.question-card')?.classList.contains('answered')).toBe(false);
    expect(root.querySelector('.question-submit')).not.toBeNull();
  });

  it('keeps the focus on the option picked on the Status tab, and sends a not-sent composer message from another conversation back to the composer', () => {
    const { show, root, option, submit, post, host } = page();
    const status: StatusView = { id: 'st-r1', sessionId: 's2', at: T0, markdown: ASKED, fallback: false, unread: false };

    show(state([reply('r1', T0, '')], { status }));
    root.querySelector<HTMLElement>('[role="tab"][data-tab="status"]')!.click();
    option(1, 'B').focus();
    option(1, 'B').click();
    expect(document.activeElement).toBe(option(1, 'B'));
    option(0, 'A').click();

    // An answer still being typed can come back to its card; once sent, a later composer message with the same text that was not sent is the composer's.
    submit().click();
    post({ type: 'sent', id: 1_000_000, error: null });
    show(state([reply('r1', T0, ''), message('m1', T0 + 1, '1A, 2B', { delivery: 'open', provisional: true })], { status }));
    // A message that was not sent leaves the conversation as it comes back.
    show(state([reply('r1', T0, '')], { status }));
    post({ type: 'unsent', returned: [{ text: '1A, 2B', error: 'Not sent.', workItemId: 2 }] });
    expect(root.querySelector('.question-error')?.textContent).toBe('Not sent.');
    expect(host.querySelector('textarea')?.value).toBe('');
    submit().click();
    post({ type: 'sent', id: 1_000_001, error: null });
    show(state([reply('r1', T0, ''), message('m1', T0 + 1, '1A, 2B')], { status }));
    root.querySelector<HTMLElement>('[role="tab"][data-tab="conversation"]')!.click();
    post({ type: 'unsent', returned: [{ text: '1A, 2B', error: 'Not sent.', workItemId: 2 }] });
    expect(host.querySelector('textarea')?.value).toBe('1A, 2B');
  });
});
