/**
 * The question card (PRD R103, architecture.md § Conversation view), drawn by the web page as HTML
 * strings: one question at a time, with progress dots, the topic, question and context, full-width options with their descriptions and no
 * letters, a Comment field, Back and Next or Send; the questions already settled as rows under it. Its buttons carry `data-action`s each front
 * end handles: `card-pick`, `card-step`, `card-back`, `card-next`, `card-send`, `card-menu`, `card-dismiss`, `goto-card` and
 * `goto-message`. It never scrolls or handles touch itself, so a pan over it scrolls the conversation. Imports only the questions module, for
 * browser bundles.
 */
import { answerBrief, cardLater, cardSteps, currentStep, draftAnswers, picked, plain, questionBrief, sendLabel, withoutMultiAsk } from './questions.js';
import type { CardDraft, LedgerCard, LedgerQuestion } from './questions.js';

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A description as a sentence: its first letter in capitals, as the card shows it on a line of its own. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a card needs besides its ledger entry and draft. */
export interface CardRender {
  /** Whether the card takes answers: the composer could send. */
  canAnswer: boolean;
  /** Why it cannot, shown under it, such as an ended session; null for none. */
  note?: string | null;
  /** A Send is under way. */
  sending?: boolean;
  /** Why the last Send was refused; null for none. */
  error?: string | null;
  /** Its header menu is open. */
  menuOpen?: boolean;
  /** Inline Markdown as HTML, the front end's own renderer. */
  inline(text: string): string;
}

/** A settled state's name, which its icon's tooltip and an assistive reader give, and its codicon. */
const STATE: Record<LedgerQuestion['state'], [name: string, icon: string]> = {
  open: ['Open', 'circle-large-outline'],
  answered: ['Answered', 'check'],
  withdrawn: ['Withdrawn', 'close'],
  replaced: ['Replaced', 'arrow-swap'],
  // Unanswered covers both a message that did not answer it and a later reply that came first: the operator acts the same on either.
  dismissed: ['Skipped', 'dash'],
  skipped: ['Unanswered', 'debug-step-over'],
  superseded: ['Unanswered', 'debug-step-over'],
};

/** A question's short form as an answer line starts it: "Port:", "The page has no menu:", or "Design first?" as it is. */
export function briefLead(brief: string): string {
  return /[?!:]$/.test(brief) ? brief : `${brief.replace(/\.$/, '')}:`;
}

/** What a settled question's row says: the chosen labels after its question on the same line, or its state's note under it. */
function rowDetail(one: LedgerQuestion): string {
  switch (one.state) {
    case 'answered':
      return one.answer === null ? '' : escape(answerBrief(one.question, one.answer.letters, one.answer.other) || '–');
    case 'withdrawn':
      return one.reason === null ? 'Withdrawn by the session.' : `Withdrawn by the session: "${escape(one.reason)}"`;
    case 'replaced':
      return `Replaced by a newer version of this question. ${one.replacedBy === null ? '' : `<button type="button" class="qc-link" data-action="goto-card" data-target-card="${escape(one.replacedBy.split('#')[0]!)}">Go to it</button>`}`;
    case 'dismissed':
      return one.answer === null ? 'You skipped it; the session is told with your next answers.' : 'You skipped it; the session was told.';
    case 'skipped':
      return 'Unanswered: your next message did not answer it.';
    case 'superseded':
      return 'Unanswered: a later reply came before you answered.';
    default:
      return '';
  }
}

/** Whether a card has only answered questions, none still being sent: its header then says it all, and it shows no rows. */
function allAnswered(card: LedgerCard): boolean {
  return card.questions.every((one) => one.state === 'answered' && one.answer?.sending !== true);
}

/**
 * The settled questions as rows, each with its state's icon: the question's short form (`questionBrief`), then the chosen labels on the same
 * line, or struck through when withdrawn or replaced with its state's note under it; the whole question in its tooltip.
 */
function settledRows(rows: readonly LedgerQuestion[], render: CardRender): string {
  if (rows.length === 0) {
    return '';
  }

  return `<ul class="qc-settled">${rows
    .map((one) => {
      const [name, icon] = one.answer?.sending === true ? ['Sending…', 'sync'] : STATE[one.state];
      const struck = one.state === 'withdrawn' || one.state === 'replaced';
      const whole = plain(one.question.text).replace(/\s+/g, ' ');
      const brief = questionBrief(one.question);
      const answered = one.state === 'answered';

      return (
        `<li class="qc-row qc-${one.state}"><span class="qc-state" title="${escape(name)}"><span class="codicon codicon-${icon}" aria-hidden="true"></span><span class="qc-sr">${escape(name)}</span></span>` +
        `<span class="qc-row-main" title="${escape(whole)}"><span class="qc-row-question${struck ? ' qc-struck' : ''}">${render.inline(answered ? briefLead(brief) : brief)}</span>${answered ? ' ' : ''}<span class="qc-row-detail">${rowDetail(one)}</span></span></li>`
      );
    })
    .join('')}</ul>`;
}

/** The header's line once every question is settled: "All 3 questions answered", and the Your answer link at its right. */
function doneHead(card: LedgerCard): string {
  const total = card.questions.length;
  const answered = card.questions.filter((one) => one.state === 'answered');
  const message = answered.at(-1)?.answer?.messageId ?? null;
  const what = answered.length === total ? (total === 1 ? 'Question answered' : `All ${total} questions answered`) : total === 1 ? 'Question closed' : `All ${total} questions closed`;
  const link = message === null ? '' : `<button type="button" class="qc-link qc-cross-link" data-action="goto-message" data-target="${escape(message)}" title="Show your answer">Your answer</button>`;

  return `<div class="qc-head qc-done"><span class="qc-progress">${what}</span>${link}</div>`;
}

/** What a multi-choice question's card says under it. */
const MULTI_HINT = 'Select all that apply';

/** The words an assistive reader hears for a step: "Question 2 of 3: How should the persona list look on a phone?" */
export function stepAnnouncement(card: LedgerCard, draft: CardDraft | undefined): string {
  const steps = cardSteps(card);
  const current = currentStep(card, draft);

  return current === null ? '' : `Question ${steps.indexOf(current) + 1} of ${steps.length}: ${withoutMultiAsk(current.question).replace(/[*_`]/g, '')}${current.question.multi ? ` ${MULTI_HINT}.` : ''}`;
}

/** A question card as HTML: the open stepper over the settled rows, or the settled summary once nothing is open. */
export function renderQuestionCard(card: LedgerCard, draft: CardDraft | undefined, render: CardRender): string {
  const key = escape(card.key);
  const steps = cardSteps(card);
  const settled = card.questions.filter((one) => one.state !== 'open');
  const later = cardLater(card);
  const note = render.note == null ? '' : `<p class="qc-note">${escape(render.note)}</p>`;

  if (steps.length === 0) {
    return `<div class="question-card qc qc-settled-card${allAnswered(card) ? ' qc-collapsed' : ''}" data-card="${key}" data-card-key="${key}" role="group" aria-label="Questions, closed">${doneHead(card)}${allAnswered(card) ? '' : settledRows(card.questions, render)}</div>`;
  }

  const current = currentStep(card, draft)!;
  const at = steps.indexOf(current);
  const slug = escape(current.question.slug);
  const question = current.question;
  const pick = draft?.picks[question.slug];
  const locked = !render.canAnswer || render.sending === true;
  const disabled = locked ? ' disabled' : '';
  const dots = steps
    .map((one, index) => {
      const done = picked(draft?.picks[one.question.slug]);

      return `<button type="button" class="qc-dot${index === at ? ' qc-current' : ''}${done ? ' qc-filled' : ''}" data-action="card-step" data-card="${key}" data-slug="${escape(one.question.slug)}" aria-label="${escape(`Question ${index + 1}${done ? ', answered' : ''}`)}"${index === at ? ' aria-current="step"' : ''}></button>`;
    })
    .join('');
  const menu = render.canAnswer
    ? `<span class="qc-menu-anchor"><button type="button" class="qc-menu-button" data-action="card-menu" data-card="${key}" aria-haspopup="menu" aria-expanded="${render.menuOpen === true}" title="More actions"><span class="codicon codicon-ellipsis" aria-hidden="true"></span></button>${
        render.menuOpen === true ? `<span class="qc-menu" role="menu"><button type="button" role="menuitem" data-action="card-dismiss" data-card="${key}" data-slug="${slug}" title="Skip this question; the session is told with your next answers">Skip this question</button></span>` : ''
      }</span>`
    : '';
  const head = `<div class="qc-head"><span class="qc-progress">Question ${at + 1} of ${steps.length}</span>${steps.length > 1 ? `<span class="qc-dots">${dots}</span>` : ''}${menu}</div>`;
  const shown = withoutMultiAsk(question);
  const hintId = `qc-hint-${key}-${slug}`;
  const body =
    (question.topic === null ? '' : `<div class="qc-topic">${escape(question.topic)}</div>`) +
    `<div class="qc-question">${render.inline(shown)}</div>` +
    (question.context === '' ? '' : `<div class="qc-context">${render.inline(question.context)}</div>`) +
    (question.multi ? `<div class="qc-hint" id="${escape(hintId)}">${MULTI_HINT}</div>` : '');
  const role = question.multi ? 'checkbox' : 'radio';
  // The letters stay in the data only: an option shows a radio or check mark, and the keys 1 to 8 pick by position.
  const options = question.options
    .map((option) => {
      const on = pick?.letters.includes(option.letter) === true;

      return (
        `<button type="button" class="qc-option${on ? ' qc-selected' : ''}" role="${role}" aria-checked="${on}" data-action="card-pick" data-card="${key}" data-slug="${slug}" data-letter="${option.letter}"${disabled}>` +
        `<span class="qc-mark qc-mark-${role}" aria-hidden="true"></span><span class="qc-option-body"><span class="qc-label">${render.inline(option.label)}</span>${option.recommended ? '<span class="qc-recommended">Recommended</span>' : ''}${
          option.description === '' ? '' : `<span class="qc-desc">${render.inline(sentenceCase(option.description))}</span>`
        }</span></button>`
      );
    })
    .join('');
  const commentId = `qc-comment-${key}-${slug}`;
  const comment =
    `<div class="qc-comment-box"><label class="qc-comment-label" for="${escape(commentId)}">Comment</label>` +
    `<textarea id="${escape(commentId)}" class="qc-comment" data-card="${key}" data-slug="${slug}" rows="2" placeholder="Add to your choice, or answer in your own words"${disabled}>${escape(pick?.other ?? '')}</textarea></div>`;
  const count = draftAnswers(card, draft).length;
  const last = at === steps.length - 1;
  const forward = last
    ? `<button type="button" class="qc-primary" data-action="card-send" data-card="${key}"${locked || count === 0 ? ' disabled' : ''}>${render.sending === true ? 'Sending…' : sendLabel(count, steps.length)}</button>`
    : `<button type="button" class="qc-primary" data-action="card-next" data-card="${key}"${locked || !picked(pick) ? ' disabled' : ''}>Next</button>`;
  const footer = render.canAnswer
    ? `<div class="qc-footer"><button type="button" class="qc-secondary" data-action="card-back" data-card="${key}"${locked || at === 0 ? ' disabled' : ''}>Back</button>${render.error == null ? '' : `<span class="qc-error" role="alert">${escape(render.error)}</span>`}${forward}</div>`
    : '';
  const more = later === 0 ? '' : `<p class="qc-later">${later} more question${later === 1 ? '' : 's'} after these</p>`;

  return `<div class="question-card qc" data-card="${key}" data-card-key="${key}" data-step="${slug}" role="group" aria-label="${escape(`Questions: question ${at + 1} of ${steps.length}`)}" tabindex="-1">${head}<span class="qc-sr" aria-live="polite">${escape(stepAnnouncement(card, draft))}</span>${body}<div class="qc-options" role="${question.multi ? 'group' : 'radiogroup'}" aria-label="${escape(plain(shown))}"${question.multi ? ` aria-describedby="${escape(hintId)}"` : ''}>${options}</div>${comment}${more}${footer}${note}${settledRows(settled, render)}</div>`;
}

/**
 * What a key pressed while a card has the focus does (design § 6): 1–8 pick the option at that place, since the card shows no letters, Down and
 * Up move the focus between its options, Enter goes on or sends, Backspace goes back.
 */
export function cardKeyAction(key: string, inField: boolean): { type: 'pick'; index: number } | { type: 'move'; by: 1 | -1 } | { type: 'forward' } | { type: 'back' } | null {
  if (inField) {
    return null;
  }

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    return { type: 'move', by: key === 'ArrowDown' ? 1 : -1 };
  }

  if (/^[1-8]$/.test(key)) {
    return { type: 'pick', index: Number(key) - 1 };
  }

  return key === 'Enter' ? { type: 'forward' } : key === 'Backspace' ? { type: 'back' } : null;
}

/** Whether a message's text is an answer message the hub wrote, or one typed in its shape. */
export function isAnswerMessage(text: string): boolean {
  return /^\s*(?:\[(?:spoken|expressive|voice|partial)\][ \t]*)*\[answers\]/i.test(text);
}

/**
 * An answer message as the Answers bubble shows it (design § 4): the tag hidden, a Questions link to the first card it answered at the right of
 * its title, and a line per question, "Short question: Choice", its short form dimmed and the chosen labels bold; the slugs stay in the message text only. `answered` are
 * the questions the ledger says it answered; a line for any other question shows the message's own text.
 */
export function renderAnswersBubble(text: string, answered: readonly LedgerQuestion[]): string {
  const body = text.replace(/^\s*(?:\[(?:spoken|expressive|voice|partial)\][ \t]*)*\[answers\][ \t]*\n?/i, '');
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const match = /^-\s*([a-z][a-z0-9-]{2,39}):\s*(.*)$/i.exec(line);

      if (match === null) {
        return `<div class="answers-line">${escape(line)}</div>`;
      }

      const one = answered.find((question) => question.question.slug === match[1]!.toLowerCase());
      const rest = match[2]!;
      const asked = one === undefined ? null : plain(one.question.text).replace(/\s+/g, ' ');
      const split = asked !== null && rest.startsWith(`${asked} → `) ? asked.length : rest.indexOf(' → ');
      const said = split === -1 ? '' : rest.slice(split + 3);
      const dismissed = said === 'No answer (dismissed)';
      const question = one === undefined ? (split === -1 ? rest : rest.slice(0, split)) : plain(questionBrief(one.question));
      const other = said.search(/(?:^|; )(?:Comment|Other): /);
      const picks = other === -1 ? said : said.slice(0, other);
      const answer = dismissed ? 'Skipped' : one?.answer == null ? picks.replace(/(^|; )[A-H]\) /g, '$1') + (other === -1 ? '' : said.slice(other).replace(/^(; )?Other: /, '$1Comment: ')) : answerBrief(one.question, one.answer.letters, one.answer.other);
      const shown = answer === '' ? '' : ` <span class="${dismissed ? 'answers-dismissed' : 'answers-answer'}">${escape(answer)}</span>`;

      return `<div class="answers-line"${asked === null ? '' : ` title="${escape(asked)}"`}><span class="answers-question">${escape(answer === '' ? question : briefLead(question))}</span>${shown}</div>`;
    })
    .join('');
  const card = answered[0]?.card;
  const link = card === undefined ? '' : `<button type="button" class="answers-link qc-cross-link" data-action="goto-card" data-target-card="${escape(card)}" title="Show the questions">Questions</button>`;

  return `<div class="answers-bubble"><div class="answers-head"><span class="answers-title">Answers</span>${link}</div>${lines}</div>`;
}

/** What the chip over the composer says while questions are open (PRD R103), shared by both front ends. */
export function questionsWaiting(count: number): string {
  return `<span class="codicon codicon-question" aria-hidden="true"></span>${count} question${count === 1 ? '' : 's'} waiting`;
}
