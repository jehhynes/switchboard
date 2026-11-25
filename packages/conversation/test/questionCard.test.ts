// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { briefLead, cardKeyAction, isAnswerMessage, questionsWaiting, renderAnswersBubble, renderQuestionCard, stepAnnouncement } from '../src/questionCard.js';
import { questionLedger } from '../src/questions.js';
import type { LedgerItem } from '../src/questions.js';

const NEW = [
  '1. **Persona registration.** Register on save, or after its voice check? {#persona-registered}',
  '   Today Save registers it at once.',
  "   - A) Register on save (recommended) — keeps today's behaviour.",
  '   - B) Register after the voice check — Save takes about 2 s longer.',
  '2. **Phone layout:** How should the list look? {#phone-layout}',
  '   - A) One card per persona',
  '   - B) Two-column table',
  '3. **Design first?** Mock it up first? {#design-first}',
  '   - A) Mock up first',
  '   - B) Build directly',
].join('\n');
const reply = (id: string, opening: string): LedgerItem => ({ type: 'reply', id, kind: 'reply', opening, rewrittenBy: null, withdrawn: false, at: 10 });
const inline = (text: string): string => text.replace(/[&<>]/g, '');
const host = (html: string): HTMLElement => {
  const div = document.createElement('div');

  div.innerHTML = html;
  return div;
};

describe('the question card (design § 6)', () => {
  const ledger = questionLedger([reply('r1', NEW)]);
  const card = ledger.cards.get('reply:r1')!;

  it('shows one question at a time with its progress, topic, context, options without letters and a Comment field, no slug, and Next disabled until a pick', () => {
    const view = host(renderQuestionCard(card, undefined, { canAnswer: true, inline }));

    expect(view.querySelector('.qc-progress')?.textContent).toBe('Question 1 of 3');
    expect(view.querySelectorAll('.qc-dot')).toHaveLength(3);
    expect(view.querySelector('.qc-head')?.textContent).toBe('Question 1 of 3');
    expect(view.textContent).not.toContain('persona-registered');
    expect(view.querySelector('.qc-topic')?.textContent).toBe('Persona registration');
    expect(view.querySelector('.qc-question')?.textContent).toBe('Register on save, or after its voice check?');
    expect(view.querySelector('.qc-context')?.textContent).toBe('Today Save registers it at once.');
    expect([...view.querySelectorAll('.qc-option')].map((one) => one.textContent)).toEqual(["Register on saveRecommendedKeeps today's behaviour.", 'Register after the voice checkSave takes about 2 s longer.']);
    expect([...view.querySelectorAll('.qc-option')].map((one) => [one.getAttribute('role'), one.querySelector('.qc-mark')?.className, one.querySelector('.qc-mark')?.getAttribute('aria-hidden')])).toEqual(Array(2).fill(['radio', 'qc-mark qc-mark-radio', 'true']));
    expect(view.querySelector('.qc-letter, .qc-summary, .qc-chip, [data-action="card-other"]')).toBeNull();
    expect(view.querySelector('.qc-options')?.getAttribute('role')).toBe('radiogroup');
    expect(view.querySelector('.qc-hint')).toBeNull();
    // The Comment field is always there, empty, and labelled.
    const comment = view.querySelector<HTMLTextAreaElement>('textarea.qc-comment')!;

    expect(comment.textContent).toBe('');
    expect(view.querySelector(`label[for="${comment.id}"]`)?.textContent).toBe('Comment');
    expect(view.querySelector('[data-action="card-back"]')?.hasAttribute('disabled')).toBe(true);
    expect(view.querySelector('[data-action="card-next"]')?.hasAttribute('disabled')).toBe(true);
    expect(view.querySelector('.qc-sr')?.textContent).toBe('Question 1 of 3: Register on save, or after its voice check?');
  });

  it('marks the pick, fills its dot and enables Next', () => {
    const view = host(renderQuestionCard(card, { step: 'persona-registered', picks: { 'persona-registered': { letters: ['A'], other: null } } }, { canAnswer: true, inline }));

    expect(view.querySelector('.qc-option.qc-selected')?.getAttribute('data-letter')).toBe('A');
    expect(view.querySelector('.qc-option[data-letter="A"]')?.getAttribute('aria-checked')).toBe('true');
    expect(view.querySelector('.qc-dot.qc-filled')).not.toBeNull();
    expect(view.querySelector('[data-action="card-next"]')?.hasAttribute('disabled')).toBe(false);
  });

  it('shows a comment beside a pick, and offers Send 2 of 3 on the last step when one question is left', () => {
    const view = host(renderQuestionCard(card, { step: 'design-first', picks: { 'persona-registered': { letters: ['A'], other: null }, 'design-first': { letters: ['B'], other: 'only the list' } } }, { canAnswer: true, inline }));

    expect(view.querySelector('textarea.qc-comment')?.textContent).toBe('only the list');
    expect(view.querySelector('.qc-option.qc-selected')?.getAttribute('data-letter')).toBe('B');
    expect(view.querySelector('[data-action="card-send"]')?.textContent).toBe('Send 2 of 3');
    expect(view.querySelector('[data-action="card-send"]')?.hasAttribute('disabled')).toBe(false);
    expect(view.querySelector('[data-action="card-next"]')).toBeNull();
  });

  it('disables Send on the last step with nothing picked, and everything while a Send is under way', () => {
    expect(host(renderQuestionCard(card, { step: 'design-first', picks: {} }, { canAnswer: true, inline })).querySelector('[data-action="card-send"]')?.hasAttribute('disabled')).toBe(true);

    const sending = host(renderQuestionCard(card, { step: 'design-first', picks: { 'design-first': { letters: ['A'], other: null } } }, { canAnswer: true, sending: true, inline }));

    expect(sending.querySelector('[data-action="card-send"]')?.textContent).toBe('Sending…');
    expect([...sending.querySelectorAll('.qc-option')].every((one) => one.hasAttribute('disabled'))).toBe(true);
  });

  it('is read-only with a note and no footer or menu when it cannot be answered, and shows a refusal', () => {
    const ended = host(renderQuestionCard(card, undefined, { canAnswer: false, note: 'Session ended — open in terminal to continue.', inline }));

    expect(ended.querySelector('.qc-footer')).toBeNull();
    expect(ended.querySelector('.qc-menu-button')).toBeNull();
    expect(ended.querySelector('.qc-note')?.textContent).toBe('Session ended — open in terminal to continue.');
    expect(host(renderQuestionCard(card, undefined, { canAnswer: true, error: 'That question was withdrawn.', inline })).querySelector('.qc-error')?.textContent).toBe('That question was withdrawn.');
  });

  it('offers Dismiss in the header menu, for the current question', () => {
    const view = host(renderQuestionCard(card, { step: 'phone-layout', picks: {} }, { canAnswer: true, menuOpen: true, inline }));

    expect(view.querySelector('.qc-menu-button')?.getAttribute('aria-expanded')).toBe('true');
    expect(view.querySelector('[data-action="card-dismiss"]')?.getAttribute('data-slug')).toBe('phone-layout');
    expect(host(renderQuestionCard(card, undefined, { canAnswer: true, inline })).querySelector('[data-action="card-dismiss"]')).toBeNull();
  });

  it('shows withdrawn and replaced questions as struck rows under the stepper, with the reason and a link to the new question', () => {
    const again = '1. **Design first?** Only the list? {#design-first}\n   - A) Only the list\n   - B) Both';
    const changed = questionLedger([reply('r1', NEW), reply('r2', 'Ok.\n[withdraw: persona-registered — your message settled it]'), reply('r3', again)]);
    const view = host(renderQuestionCard(changed.cards.get('reply:r1')!, undefined, { canAnswer: true, inline }));

    expect(view.querySelector('.qc-progress')?.textContent).toBe('Question 1 of 1');
    expect([...view.querySelectorAll('.qc-row')].map((row) => [row.querySelector('.qc-state')?.getAttribute('title'), row.querySelector('.qc-state .codicon')?.className, row.querySelector('.qc-struck')?.textContent, row.querySelector('.qc-row-detail')?.textContent])).toEqual([
      ['Withdrawn', 'codicon codicon-close', 'Persona registration', 'Withdrawn by the session: "your message settled it"'],
      ['Replaced', 'codicon codicon-arrow-swap', 'Design first?', 'Replaced by a newer version of this question. Go to it'],
    ]);
    expect(view.querySelector('.qc-row-main')?.getAttribute('title')).toBe('Register on save, or after its voice check?');
    expect(view.querySelector('[data-action="goto-card"]')?.getAttribute('data-target-card')).toBe('reply:r3');
    expect(view.querySelector('[data-action="card-send"]')?.textContent).toBe('Send answer');
  });

  it('folds to its header once every question is answered, with the Your answer link and no rows', () => {
    const answered = questionLedger([
      reply('r1', NEW),
      { type: 'message', id: 'm1', text: '[answers]', withdrawn: false, delivery: 'sent', at: 20, answers: ['persona-registered', 'phone-layout', 'design-first'].map((slug) => ({ replyId: 'r1', slug, letters: ['A'], other: '', via: 'card' as const })) },
    ]);
    const view = host(renderQuestionCard(answered.cards.get('reply:r1')!, undefined, { canAnswer: true, inline }));

    expect(view.querySelector('.qc-done .qc-progress')?.textContent).toBe('All 3 questions answered');
    expect(view.querySelector('.qc-done [data-action="goto-message"]')?.getAttribute('data-target')).toBe('m1');
    expect(view.querySelector('.qc-done [data-action="goto-message"]')?.textContent).toBe('Your answer');
    expect(view.querySelector('.qc-collapsed')).not.toBeNull();
    expect(view.querySelectorAll('.qc-row')).toHaveLength(0);
    expect(view.querySelector('.qc-option')).toBeNull();
  });

  it('keeps its rows with a state icon each when its questions differ in state, an answer as "Short question: Choice"', () => {
    const ask = ['1. **Port.** Which port? {#port-choice}', '   - A) 8765; the default port (recommended): nothing changes', '   - B) 8799', '2. Keep the old route for now? {#keep-route}', '   - A) Keep it', '   - B) Remove it'].join('\n');
    const mixed = questionLedger([reply('r1', ask), { type: 'message', id: 'm1', text: '[answers]', withdrawn: false, delivery: 'sent', at: 20, answers: [{ replyId: 'r1', slug: 'port-choice', letters: ['A'], other: 'and log it', via: 'card' }, { replyId: 'r1', slug: 'keep-route', letters: [], other: '', via: 'card', dismissed: true }] }]);
    const view = host(renderQuestionCard(mixed.cards.get('reply:r1')!, undefined, { canAnswer: true, inline }));

    expect(view.querySelector('.qc-done .qc-progress')?.textContent).toBe('All 2 questions settled');
    expect(view.querySelector('.qc-collapsed')).toBeNull();
    expect([...view.querySelectorAll('.qc-row')].map((row) => [row.querySelector('.qc-state')?.getAttribute('title'), row.querySelector('.qc-state .codicon')?.className, row.querySelector('.qc-row-main')?.textContent])).toEqual([
      ['Answered', 'codicon codicon-check', 'Port: 8765; the default port; Comment: and log it'],
      ['Dismissed', 'codicon codicon-dash', 'Keep the old route for now?You dismissed it; the session was told.'],
    ]);
    expect(view.textContent).not.toMatch(/port-choice|keep-route|A\)|recommended/);
  });

  it('shows a dismissed question as a row that says the session is told', () => {
    const dismissed = questionLedger([reply('r1', NEW)], { dismissed: ['reply:r1#persona-registered', 'reply:r1#phone-layout', 'reply:r1#design-first'] });
    const view = host(renderQuestionCard(dismissed.cards.get('reply:r1')!, undefined, { canAnswer: true, inline }));

    expect(view.querySelector('.qc-done')?.textContent).toBe('All 3 questions settled');
    expect(view.querySelector('.qc-row-detail')?.textContent).toBe('You dismissed it; the session is told with your next answers.');
  });

  it('says how many more questions wait after the first four', () => {
    const six = Array.from({ length: 6 }, (_, index) => `${index + 1}. Question ${index + 1}? {#question-${index + 1}}\n   - A) x\n   - B) y`).join('\n');
    const view = host(renderQuestionCard(questionLedger([reply('r9', six)]).cards.get('reply:r9')!, undefined, { canAnswer: true, inline }));

    expect(view.querySelectorAll('.qc-dot')).toHaveLength(4);
    expect(view.querySelector('.qc-later')?.textContent).toBe('2 more questions after these');
  });

  it('escapes what the session wrote in the slug-free parts it does not render as Markdown', () => {
    const tricky = questionLedger([reply('r1', '1. **<b>Topic</b>.** Which? {#tricky-one}\n   - A) x\n   - B) y')]);

    expect(renderQuestionCard(tricky.cards.get('reply:r1')!, undefined, { canAnswer: true, inline })).toContain('&#60;b&#62;Topic&#60;/b&#62;');
  });

  it('announces the step for assistive readers', () => {
    expect(stepAnnouncement(card, { step: 'phone-layout', picks: {} })).toBe('Question 2 of 3: How should the list look?');
  });
});

describe('the card keys (design § 6)', () => {
  it('picks by place with 1–8, moves with Down and Up, goes on with Enter and back with Backspace, takes no letters, and leaves a field\'s typing alone', () => {
    expect(cardKeyAction('2', false)).toEqual({ type: 'pick', index: 1 });
    expect(cardKeyAction('8', false)).toEqual({ type: 'pick', index: 7 });
    expect(cardKeyAction('9', false)).toBeNull();
    expect(cardKeyAction('ArrowDown', false)).toEqual({ type: 'move', by: 1 });
    expect(cardKeyAction('ArrowUp', false)).toEqual({ type: 'move', by: -1 });
    expect(cardKeyAction('b', false)).toBeNull();
    expect(cardKeyAction('O', false)).toBeNull();
    expect(cardKeyAction('2', true)).toBeNull();
    expect(cardKeyAction('ArrowDown', true)).toBeNull();
    expect(cardKeyAction('Enter', false)).toEqual({ type: 'forward' });
    expect(cardKeyAction('Backspace', false)).toEqual({ type: 'back' });
    expect(cardKeyAction('z', false)).toBeNull();
  });
});

describe('the Answers bubble (design § 4)', () => {
  it('hides the tag and the slugs, shows each line as "Short question: Choice", with the Questions link in its header', () => {
    const ledger = questionLedger([reply('r1', NEW), { type: 'message', id: 'm1', text: 'x', withdrawn: false, delivery: 'sent', at: 20, answers: [{ replyId: 'r1', slug: 'persona-registered', letters: ['A'], other: '', via: 'card' }] }]);
    const text = '[spoken] [answers]\n- persona-registered: Register on save, or after its voice check? → A) Register on save\n- design-first: Mock it up first? → Comment: a → b\n- phone-layout: How should the list look? → No answer (dismissed)\n- old-one: Which? → B) Two; C) Three';
    const view = host(renderAnswersBubble(text, ledger.answers.get('m1')!));

    expect(isAnswerMessage(text)).toBe(true);
    expect(isAnswerMessage('persona-registered A')).toBe(false);
    expect(view.querySelector('.answers-head .answers-title')?.textContent).toBe('Answers');
    expect([...view.querySelectorAll('.answers-line')].map((line) => [line.querySelector('.answers-question')?.textContent, line.querySelector('.answers-answer, .answers-dismissed')?.textContent])).toEqual([
      ['Persona registration:', 'Register on save'],
      ['Mock it up first?', 'Comment: a → b'],
      ['How should the list look?', 'Dismissed'],
      ['Which?', 'Two; Three'],
    ]);
    // An unknown question's comment keeps what looks like a letter, and an older Other line reads as a comment.
    expect(host(renderAnswersBubble('[answers]\n- gone-one: Which? → B) Two; Comment: Step A; B) keep it', [])).querySelector('.answers-answer')?.textContent).toBe('Two; Comment: Step A; B) keep it');
    expect(host(renderAnswersBubble('[answers]\n- gone-one: Which? → B) Two; Other: Step A', [])).querySelector('.answers-answer')?.textContent).toBe('Two; Comment: Step A');
    expect(host(renderAnswersBubble('[answers]\n- gone-one: Which? → Other: mine', [])).querySelector('.answers-answer')?.textContent).toBe('Comment: mine');
    expect(view.querySelector('.answers-line')?.getAttribute('title')).toBe('Register on save, or after its voice check?');
    expect(view.querySelector('.answers-head [data-action="goto-card"]')?.getAttribute('data-target-card')).toBe('reply:r1');
    expect(view.textContent).not.toMatch(/persona-registered|design-first|phone-layout|old-one/);
    expect(view.textContent).not.toContain('[answers]');
  });
});

describe('a multi-choice question', () => {
  it('says that several can be chosen, with check marks, a hint the group names, and the closing request said once', () => {
    const multi = questionLedger([reply('r1', '1. Which pages need the header? Select all that apply. {#header-pages}\n   - A) List\n   - B) Settings\n   - C) Voice')]);
    const view = host(renderQuestionCard(multi.cards.get('reply:r1')!, { step: 'header-pages', picks: { 'header-pages': { letters: ['A', 'C'], other: 'and the phone' } } }, { canAnswer: true, inline }));
    const hint = view.querySelector('.qc-hint')!;

    expect(view.querySelector('.qc-question')?.textContent).toBe('Which pages need the header?');
    expect(hint.textContent).toBe('Select all that apply');
    expect(view.querySelector('.qc-options')?.getAttribute('role')).toBe('group');
    expect(view.querySelector('.qc-options')?.getAttribute('aria-describedby')).toBe(hint.id);
    expect([...view.querySelectorAll('.qc-option')].map((one) => [one.getAttribute('role'), one.getAttribute('aria-checked'), one.querySelector('.qc-mark')?.className])).toEqual([
      ['checkbox', 'true', 'qc-mark qc-mark-checkbox'],
      ['checkbox', 'false', 'qc-mark qc-mark-checkbox'],
      ['checkbox', 'true', 'qc-mark qc-mark-checkbox'],
    ]);
    expect(view.querySelector('textarea.qc-comment')?.textContent).toBe('and the phone');
    expect(view.querySelector('.qc-sr')?.textContent).toBe('Question 1 of 1: Which pages need the header? Select all that apply.');
  });

  it('shows the hint for a question an older phrase made multi-choice, keeping its text', () => {
    const multi = questionLedger([reply('r1', '1. Where? Pick one or more. {#where-shown}\n   - A) Web\n   - B) Dock')]);
    const view = host(renderQuestionCard(multi.cards.get('reply:r1')!, undefined, { canAnswer: true, inline }));

    expect(view.querySelector('.qc-question')?.textContent).toBe('Where? Pick one or more.');
    expect(view.querySelector('.qc-hint')?.textContent).toBe('Select all that apply');
  });
});

describe('an answer line\'s question', () => {
  it('ends in a colon, which replaces a full stop and gives way to a question or exclamation mark', () => {
    expect(briefLead('Port')).toBe('Port:');
    expect(briefLead('The page has no menu.')).toBe('The page has no menu:');
    expect(briefLead('Design first?')).toBe('Design first?');
  });
});

describe('the waiting chip', () => {
  it('counts every open question', () => {
    expect(questionsWaiting(1)).toContain('1 question waiting');
    expect(questionsWaiting(5)).toContain('5 questions waiting');
  });
});

describe('the card\'s styles', () => {
  it('never scroll or take touch gestures, so a vertical pan over a card scrolls the conversation', () => {
    const css = readFileSync(join(__dirname, '../src/questionCard.css'), 'utf8');

    expect(css).not.toMatch(/overflow(?:-[xy])?\s*:\s*(?:auto|scroll)/);
    expect(css).not.toMatch(/touch-action\s*:\s*(?:none|pan-x|pinch-zoom)/);
    expect(css).not.toMatch(/overscroll-behavior/);
  });
});
