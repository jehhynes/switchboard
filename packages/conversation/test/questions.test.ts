import { describe, expect, it } from 'vitest';
import { answerBrief, answerMessage, answersIn, BATCH, cardLinks, carriedQuestions, cardSteps, cardUtterance, currentStep, deriveSlug, draftAnswers, moveStep, parseQuestions, pickLetter, questionBrief, questionLedger, questionLines, questionSegments, questionSpeech, resolveAnswers, sendLabel, setComment, stripQuestionMarkup, withdrawals, withoutEndingQuestions, withoutMultiAsk } from '../src/questions.js';
import type { CardLinks, LedgerItem, LinkItem, QuestionLedger, StoredAnswer } from '../src/questions.js';

/** The shape the conversation rules show, with a second question. */
const ASKED = 'Two things before I start:\n\n1. Which port?\n   - A) 8765 (recommended)\n   - B) 8799\n2. **Keep the old route?**\n   - A) Yes\n   - B) No, remove it\n   - C) Keep it behind a flag\n\nSay if neither fits.';

/** The shape the new rules ask for: ids, topics, context and options with descriptions. */
const NEW = [
  'Three decisions before I do the phone layout:',
  '',
  '1. **Persona registration.** Register a persona as soon as you save it, or only after its voice check passes? {#persona-registered}',
  '   Today Save registers it at once. I keep building the phone layout whichever you pick.',
  "   - A) Register on save (recommended) — keeps today's behaviour; a broken voice shows an error the first time it speaks.",
  '   - B) Register after the voice check — Save takes about 2 s longer.',
  '     A new persona cannot be picked until its check plays.',
  '2. **Phone layout:** How should the persona list look on a phone? {#phone-layout}',
  '   - A) One card per persona -- about a day of work.',
  '   - B) Two-column table',
  '3. **Design first?** Mock up the phone layout before I build it? {#design-first}',
  '   - A) Design with mockups first',
  '   - B) Build it directly',
].join('\n');

describe('parsing questions (PRD R103)', () => {
  it('reads the slug, topic, context, labels, descriptions and the recommendation the rules ask for', () => {
    const [first, second, third] = parseQuestions(NEW);

    expect(first).toEqual({
      number: 1,
      slug: 'persona-registered',
      written: true,
      topic: 'Persona registration',
      text: 'Register a persona as soon as you save it, or only after its voice check passes?',
      context: 'Today Save registers it at once. I keep building the phone layout whichever you pick.',
      multi: false,
      options: [
        { letter: 'A', label: 'Register on save', description: "keeps today's behaviour; a broken voice shows an error the first time it speaks.", recommended: true, text: 'Register on save' },
        { letter: 'B', label: 'Register after the voice check', description: 'Save takes about 2 s longer. A new persona cannot be picked until its check plays.', recommended: false, text: 'Register after the voice check' },
      ],
    });
    // A topic ending in ":" or "?", and an option split on " -- ".
    expect(second).toMatchObject({ slug: 'phone-layout', topic: 'Phone layout', text: 'How should the persona list look on a phone?', context: '' });
    expect(second!.options[0]).toMatchObject({ label: 'One card per persona', description: 'about a day of work.' });
    expect(second!.options[1]).toMatchObject({ label: 'Two-column table', description: '', recommended: false });
    expect(third).toMatchObject({ slug: 'design-first', topic: 'Design first?', text: 'Mock up the phone layout before I build it?' });
  });

  it('keeps reading the old shape, with derived slugs, no context and label-only options', () => {
    const questions = parseQuestions(ASKED);

    expect(questions.map((question) => [question.number, question.slug, question.written, question.topic, question.text, question.context])).toEqual([
      [1, 'port', false, null, 'Which port?', ''],
      [2, 'keep-old-route', false, null, 'Keep the old route?', ''],
    ]);
    // "(recommended)" is lifted off an old option's label too.
    expect(questions[0]!.options).toEqual([
      { letter: 'A', label: '8765', description: '', recommended: true, text: '8765' },
      { letter: 'B', label: '8799', description: '', recommended: false, text: '8799' },
    ]);
  });

  it('derives a meaningful slug from the topic or the first significant words, and suffixes a slug used twice in one reply', () => {
    expect(deriveSlug('Persona registration', 'Anything?')).toBe('persona-registration');
    expect(deriveSlug(null, 'Should we register a persona on save?')).toBe('register-persona-save');
    expect(deriveSlug(null, '42 is the port?')).toBe('q-42-port');
    expect(deriveSlug(null, 'Ok?')).toBe('question');

    const twice = parseQuestions('1. Port? {#port-choice}\n   - A) 1\n   - B) 2\n2. Port again? {#port-choice}\n   - A) 3\n   - B) 4\n3. Port? \n   - A) x\n   - B) y\n4. Port? \n   - A) x\n   - B) y');

    expect(twice.map((question) => question.slug)).toEqual(['port-choice', 'port-choice-2', 'port', 'port-2']);
    // A malformed id is text, not a slug.
    expect(parseQuestions('1. Which? {#Q1}\n   - A) x\n   - B) y')[0]).toMatchObject({ slug: 'question', written: false, text: 'Which? {#Q1}' });
  });

  it('gives every question of a reply its own slug: a suffix fits within 40 characters and never takes a slug another question wrote', () => {
    const ask = (slugs: string[]): string => slugs.map((slug, index) => `${index + 1}. Which? {#${slug}}\n   - A) x\n   - B) y`).join('\n');
    const long = `a${'b'.repeat(38)}c`;
    const cut = `a${'b'.repeat(36)}-c`;

    expect(long).toHaveLength(40);
    expect(parseQuestions(ask([long, long, long])).map((question) => question.slug)).toEqual([long, `${long.slice(0, 38)}-2`, `${long.slice(0, 38)}-3`]);
    // A cut that ends on a hyphen loses it before the suffix.
    expect(parseQuestions(ask([cut, cut])).map((question) => question.slug)).toEqual([cut, `a${'b'.repeat(36)}-2`]);
    // A written `port-choice-2` keeps its slug; the repeated `port-choice` takes the next free one.
    expect(parseQuestions(ask(['port-choice', 'port-choice', 'port-choice-2'])).map((question) => question.slug)).toEqual(['port-choice', 'port-choice-3', 'port-choice-2']);
    expect(parseQuestions(ask(['port-choice', 'port-choice-2', 'port-choice', 'port-choice'])).map((question) => question.slug)).toEqual(['port-choice', 'port-choice-2', 'port-choice-3', 'port-choice-4']);

    // So the ledger holds each question once, under its own key.
    const ledger = questionLedger([reply('r1', ask(['port-choice', 'port-choice', 'port-choice-2']))]);

    expect(ledger.cards.get('reply:r1')!.questions.map((one) => one.key)).toEqual(['reply:r1#port-choice', 'reply:r1#port-choice-3', 'reply:r1#port-choice-2']);
    expect(ledger.open).toHaveLength(3);
    expect(new Set(ledger.open).size).toBe(3);
  });

  it('takes the option shapes Claude writes, a bold or parenthesised letter, a lower-case one, and lines that continue the context or an option', () => {
    const questions = parseQuestions('1) Scope\n   for this run\n**A)** Only the inbox\n(b) Everything\n  including the dock\nc) Nothing\n\n2. Name?\n   A. Short\n   B: Long');

    expect(questions.map((question) => [question.number, question.text, question.context, question.options.map((option) => `${option.letter} ${option.label}|${option.description}`)])).toEqual([
      [1, 'Scope', 'for this run', ['A Only the inbox|', 'B Everything|including the dock', 'C Nothing|']],
      [2, 'Name?', '', ['A Short|', 'B Long|']],
    ]);
  });

  it('reads a lone question with lettered options and no number', () => {
    const questions = parseQuestions('Which one should I keep?\n\n- A) The first\n- B) The second');

    expect(questions).toMatchObject([{ number: null, slug: 'one-keep', text: 'Which one should I keep?' }]);
  });

  it('marks a question that says it takes several options, in its text or its context', () => {
    expect(parseQuestions('1. Which checks should run? Pick any that apply.\n   - A) Lint\n   - B) Tests')[0]?.multi).toBe(true);
    expect(parseQuestions('1. Which checks should run?\n   Choose one or more.\n   - A) Lint\n   - B) Tests')[0]?.multi).toBe(true);
    expect(parseQuestions(ASKED)[0]?.multi).toBe(false);
  });

  it('finds no question in lists, prose, code or shapes whose answers could not be told apart', () => {
    expect(parseQuestions('1. Build\n2. Test\n3. Ship')).toEqual([]);
    expect(parseQuestions('1. Which?\n   - A) Only one')).toEqual([]);
    expect(parseQuestions('1. Which?\n   - B) One\n   - C) Two')).toEqual([]);
    expect(parseQuestions('1. Which?\n   - A) One\n   - C) Two')).toEqual([]);
    expect(parseQuestions('1. Which?\n   - A) One\n   - B) Two\n   - D) Four')).toEqual([]);
    expect(parseQuestions('Asked J. Smith and\nK. Jones about it.')).toEqual([]);
    expect(parseQuestions('```\n1. Which? {#which-one}\n   - A) One\n   - B) Two\n```')).toEqual([]);
    expect(parseQuestions('1. Which?\nI think so.\n- A) One\n- B) Two').map((question) => question.number)).toEqual([null]);
    expect(parseQuestions('1. One?\n   - A) x\n   - B) y\n1. Again?\n   - A) x\n   - B) y')).toEqual([]);
    expect(parseQuestions('1. One?\n   - A) x\n   - B) y\n\nAlso:\n\n- A) p\n- B) q')).toEqual([]);
    expect(parseQuestions('- A) p\n- B) q')).toEqual([]);
  });

  it('parses more than four questions and options past D, which the rules ask against, without dropping any', () => {
    const many = parseQuestions(Array.from({ length: 6 }, (_, index) => `${index + 1}. Question ${index + 1}? {#question-${index + 1}}\n   - A) x\n   - B) y\n   - C) z\n   - D) w\n   - E) v`).join('\n'));

    expect(many).toHaveLength(6);
    expect(many[0]!.options.map((option) => option.letter)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});

describe('withdraw lines and the markup the views hide', () => {
  it('reads the slugs, all, and a reason inside or after the brackets, outside code', () => {
    expect(withdrawals('Done.\n[withdraw: persona-registered, design-first]\n[withdraw: phone-layout — your message settled it]\n[withdraw: all] -- starting over\n```\n[withdraw: in-code]\n```\nSay [withdraw: inline] mid-line.')).toEqual([
      { slugs: ['persona-registered', 'design-first'], reason: null },
      { slugs: ['phone-layout'], reason: 'your message settled it' },
      { slugs: 'all', reason: 'starting over' },
    ]);
  });

  it('strips withdraw lines and question ids, and leaves code and other text alone', () => {
    expect(stripQuestionMarkup('Hello.\n[withdraw: a-b-c]\n1. **Port?** Which? {#port-choice}\n   - A) x\n```\n1. Which? {#kept-in-code}\n```')).toBe('Hello.\n1. **Port?** Which?\n   - A) x\n```\n1. Which? {#kept-in-code}\n```');
  });
});

describe('the answer message the hub writes (design § 4)', () => {
  const [first, second, third] = parseQuestions(NEW);

  it('writes one line per answered question with its slug, its text, and the label alone', () => {
    expect(answerMessage([{ question: first!, letters: ['A'], other: '' }, { question: second!, letters: [], other: '' }, { question: third!, letters: [], other: ' only for the list,\n  not the  sheet ' }])).toBe(
      '[answers]\n- persona-registered: Register a persona as soon as you save it, or only after its voice check passes? → A) Register on save\n- design-first: Mock up the phone layout before I build it? → Comment: only for the list, not the sheet',
    );
  });

  it('joins several picks with "; ", puts the comment last, writes a dismissal, and is empty with nothing answered', () => {
    const multi = parseQuestions('1. Where? Pick any that apply. {#where-shown}\n   - A) Web page\n   - B) Dock\n   - C) VS Code view')[0]!;

    expect(answerMessage([{ question: multi, letters: ['C', 'A'], other: 'and the phone' }])).toBe('[answers]\n- where-shown: Where? Pick any that apply. → A) Web page; C) VS Code view; Comment: and the phone');
    expect(answerMessage([{ question: first!, letters: ['B'], other: ' only for new personas ' }])).toBe('[answers]\n- persona-registered: Register a persona as soon as you save it, or only after its voice check passes? → B) Register after the voice check; Comment: only for new personas');
    expect(answerMessage([{ question: first!, letters: [], other: '', dismissed: true }])).toBe('[answers]\n- persona-registered: Register a persona as soon as you save it, or only after its voice check passes? → No answer (dismissed)');
    expect(answerMessage([{ question: first!, letters: [], other: '   ' }])).toBe('');
  });
});

describe('resolving a message against the open questions (design § 4)', () => {
  const questions = parseQuestions(NEW);
  const open = questions.map((question) => ({ replyId: 'r1', question }));

  it('reads [answers] lines by slug, an arrow in the Other text included, and a dismissal', () => {
    const text = '[spoken] [voice] [answers]\n- persona-registered: Register a persona as soon as you save it, or only after its voice check passes? → B) Register after the voice check\n- design-first: Mock up the phone layout before I build it? → Other: only → the list; not the sheet\n- phone-layout: How should the persona list look on a phone? → No answer (dismissed)\n- unknown-slug: Gone? → A) x';

    expect(resolveAnswers(text, open)).toEqual([
      { replyId: 'r1', slug: 'persona-registered', letters: ['B'], other: '' },
      { replyId: 'r1', slug: 'design-first', letters: [], other: 'only → the list; not the sheet' },
      { replyId: 'r1', slug: 'phone-layout', letters: [], other: '', dismissed: true },
    ]);
  });

  it('reads a pick with a comment, a comment alone, and an older Other line in [answers]', () => {
    const text = '[answers]\n- persona-registered: Register a persona as soon as you save it, or only after its voice check passes? → B) Register after the voice check; Comment: only for new ones\n- design-first: Mock up the phone layout before I build it? → Comment: list only\n- phone-layout: How should the persona list look on a phone? → A) x; Other: older form';

    expect(resolveAnswers(text, open)).toEqual([
      { replyId: 'r1', slug: 'persona-registered', letters: ['B'], other: 'only for new ones' },
      { replyId: 'r1', slug: 'design-first', letters: [], other: 'list only' },
      { replyId: 'r1', slug: 'phone-layout', letters: ['A'], other: 'older form' },
    ]);
    expect(resolveAnswers('comment: list only', open, { replyId: 'r1', slug: 'design-first' })).toEqual([{ replyId: 'r1', slug: 'design-first', letters: [], other: 'list only' }]);
  });

  it('reads "slug B", "slug: B", several on one line, and "slug other: …"', () => {
    expect(resolveAnswers('persona-registered B, phone-layout: a', open)).toEqual([
      { replyId: 'r1', slug: 'persona-registered', letters: ['B'], other: '' },
      { replyId: 'r1', slug: 'phone-layout', letters: ['A'], other: '' },
    ]);
    expect(resolveAnswers('design-first other: only the list', open)).toEqual([{ replyId: 'r1', slug: 'design-first', letters: [], other: 'only the list' }]);
    expect(resolveAnswers('design-first comment: only the list', open)).toEqual([{ replyId: 'r1', slug: 'design-first', letters: [], other: 'only the list' }]);
    // A lower-case letter in running text is not a pick.
    expect(resolveAnswers('phone-layout a lot better now', open)).toEqual([]);
  });

  it('answers the current question with a lone letter or "other: …", and the only open question without one', () => {
    expect(resolveAnswers('b.', open, { replyId: 'r1', slug: 'phone-layout' })).toEqual([{ replyId: 'r1', slug: 'phone-layout', letters: ['B'], other: '' }]);
    expect(resolveAnswers('[voice] Bee', open, { replyId: 'r1', slug: 'design-first' })).toEqual([{ replyId: 'r1', slug: 'design-first', letters: ['B'], other: '' }]);
    expect(resolveAnswers('Other: mock the list only', open, { replyId: 'r1', slug: 'design-first' })).toEqual([{ replyId: 'r1', slug: 'design-first', letters: [], other: 'mock the list only' }]);
    expect(resolveAnswers('B', open.slice(1, 2))).toEqual([{ replyId: 'r1', slug: 'phone-layout', letters: ['B'], other: '' }]);
    // With several open and no current question, a lone letter answers nothing.
    expect(resolveAnswers('B', open)).toEqual([]);
    // A letter the question does not offer.
    expect(resolveAnswers('C', open, { replyId: 'r1', slug: 'phone-layout' })).toEqual([]);
  });

  it('reads legacy "1A" against the newest card only, and an unrelated message as nothing', () => {
    const older = parseQuestions(ASKED).map((question) => ({ replyId: 'r0', question }));

    expect(resolveAnswers('1A, 3 Other: maybe', [...older, ...open])).toEqual([
      { replyId: 'r1', slug: 'design-first', letters: [], other: 'maybe' },
      { replyId: 'r1', slug: 'persona-registered', letters: ['A'], other: '' },
    ]);
    expect(resolveAnswers('Hold off on the voice check idea, it is flaky.', open)).toEqual([]);
    expect(resolveAnswers('anything', [])).toEqual([]);
  });
});

const reply = (id: string, opening: string, patch: Partial<Extract<LedgerItem, { type: 'reply' }>> = {}): LedgerItem => ({ type: 'reply', id, kind: 'reply', opening, rewrittenBy: null, withdrawn: false, at: 10, ...patch });
const message = (id: string, text: string, patch: Partial<Extract<LedgerItem, { type: 'message' }>> = {}): LedgerItem => ({ type: 'message', id, text, withdrawn: false, delivery: 'sent', at: 20, ...patch });
const stored = (replyId: string, slug: string, letters: string[], other = '', extra: Partial<StoredAnswer> = {}): StoredAnswer => ({ replyId, slug, letters, other, via: 'card', ...extra });
const states = (ledger: QuestionLedger): Record<string, string> => Object.fromEntries([...ledger.questions.values()].map((one) => [one.key, one.state]));

describe('the question ledger (design § 5.2)', () => {
  it('keeps questions open across a message that answers nothing', () => {
    const ledger = questionLedger([reply('r1', NEW), message('m1', 'Hold off on the voice check idea.', { answers: [] })]);

    expect(ledger.open).toEqual(['reply:r1#persona-registered', 'reply:r1#phone-layout', 'reply:r1#design-first']);
    expect(ledger.answers.size).toBe(0);
  });

  it('answers by the links stored on the message, which win over its text, and shows Sending while it is open', () => {
    const ledger = questionLedger([reply('r1', NEW), message('m1', 'persona-registered A', { delivery: 'open', answers: [stored('r1', 'phone-layout', ['B'])] })]);

    expect(states(ledger)).toEqual({ 'reply:r1#persona-registered': 'open', 'reply:r1#phone-layout': 'answered', 'reply:r1#design-first': 'open' });
    expect(ledger.questions.get('reply:r1#phone-layout')!.answer).toEqual({ messageId: 'm1', letters: ['B'], other: '', via: 'card', sending: true });
    expect(ledger.answers.get('m1')!.map((one) => one.key)).toEqual(['reply:r1#phone-layout']);
  });

  it('resolves a message stored without links by its text, and ignores one not sent', () => {
    const ledger = questionLedger([reply('r1', NEW), message('m0', 'design-first B', { delivery: 'not-sent' }), message('m1', 'persona-registered B, design-first A')]);

    expect(states(ledger)).toEqual({ 'reply:r1#persona-registered': 'answered', 'reply:r1#phone-layout': 'open', 'reply:r1#design-first': 'answered' });
    expect(ledger.questions.get('reply:r1#design-first')!.answer).toMatchObject({ messageId: 'm1', letters: ['A'], via: 'typed' });
  });

  it('withdraws by a withdraw line with its reason, by all, and asks nothing in an aside, a note or a withdrawn reply', () => {
    const one = questionLedger([reply('r1', NEW), reply('r2', 'Settled.\n[withdraw: persona-registered — your message settled it]')]);

    expect(states(one)['reply:r1#persona-registered']).toBe('withdrawn');
    expect(one.questions.get('reply:r1#persona-registered')!.reason).toBe('your message settled it');
    expect(one.open).toHaveLength(2);
    expect(questionLedger([reply('r1', NEW), reply('r2', '[withdraw: all]')]).open).toEqual([]);
    expect(questionLedger([reply('r1', NEW, { kind: 'aside' }), reply('r2', NEW, { kind: 'note' }), reply('r3', NEW, { withdrawn: true })]).cards.size).toBe(0);
  });

  it('replaces an open question asked again by slug, and opens a new one for a slug reused after an answer', () => {
    const again = '1. **Design first?** Mock up only the list, or the list and the edit sheet? {#design-first}\n   - A) Only the list\n   - B) List and edit sheet';
    const ledger = questionLedger([reply('r1', NEW), reply('r2', again)]);

    expect(states(ledger)['reply:r1#design-first']).toBe('replaced');
    expect(ledger.questions.get('reply:r1#design-first')!.replacedBy).toBe('reply:r2#design-first');
    expect(ledger.open).toContain('reply:r2#design-first');

    const reused = questionLedger([reply('r1', NEW), message('m1', 'x', { answers: [stored('r1', 'design-first', ['A'])] }), reply('r2', again)]);

    expect(states(reused)['reply:r1#design-first']).toBe('answered');
    expect(states(reused)['reply:r2#design-first']).toBe('open');
  });

  it('carries a rewritten reply\'s questions over by slug, as they stood, and withdraws the ones the rewrite no longer asks', () => {
    const rewrite = '1. **Phone layout:** How should it look? {#phone-layout}\n   - A) Cards\n   - B) Table\n2. **Persona registration.** Register on save? {#persona-registered}\n   - A) Yes, on save\n   - B) After the check';
    const ledger = questionLedger([reply('r1', NEW, { rewrittenBy: 'r2' }), message('m1', 'x', { answers: [stored('r1', 'persona-registered', ['B'])] }), reply('r2', rewrite)]);

    expect(states(ledger)).toEqual({
      'reply:r1#persona-registered': 'answered',
      'reply:r1#phone-layout': 'replaced',
      'reply:r1#design-first': 'withdrawn',
      'reply:r2#phone-layout': 'open',
      'reply:r2#persona-registered': 'answered',
    });
    expect(ledger.open).toEqual(['reply:r2#phone-layout']);
  });

  it('dismisses the questions the operator dismissed, and records a dismissal an answer message reports', () => {
    expect(states(questionLedger([reply('r1', NEW)], { dismissed: ['reply:r1#phone-layout'] }))['reply:r1#phone-layout']).toBe('dismissed');

    const told = questionLedger([reply('r1', NEW), message('m1', '[answers]', { answers: [stored('r1', 'persona-registered', ['A']), stored('r1', 'phone-layout', [], '', { dismissed: true })] })]);

    expect(states(told)['reply:r1#phone-layout']).toBe('dismissed');
    expect(told.questions.get('reply:r1#phone-layout')!.answer?.messageId).toBe('m1');
  });

  it('keeps the old rules for a card asked before the cutover: answered, skipped or superseded, and only the newest open', () => {
    const before = questionLedger([reply('r0', ASKED, { at: 1 }), message('m1', '1A, 2B', { at: 2 }), reply('r1', ASKED, { at: 3 }), message('m2', 'thanks', { at: 4 }), reply('r2', ASKED, { at: 5 }), reply('r3', 'Ok.', { at: 6 })], { since: 100 });

    expect(states(before)).toEqual({ 'reply:r0#port': 'answered', 'reply:r0#keep-old-route': 'answered', 'reply:r1#port': 'skipped', 'reply:r1#keep-old-route': 'skipped', 'reply:r2#port': 'superseded', 'reply:r2#keep-old-route': 'superseded' });
    expect(before.questions.get('reply:r0#keep-old-route')!.answer).toMatchObject({ letters: ['B'], via: 'legacy' });
    expect(before.open).toEqual([]);

    const waiting = questionLedger([reply('r0', ASKED, { at: 1 })], { since: 100 });

    expect(waiting.open).toEqual(['reply:r0#port', 'reply:r0#keep-old-route']);
    expect(waiting.cards.get('reply:r0')!.legacy).toBe(true);
    // A card after the cutover follows the new rules beside an old one.
    expect(questionLedger([reply('r0', ASKED, { at: 1 }), message('m1', 'unrelated', { at: 2 }), reply('r1', NEW, { at: 200 }), message('m2', 'unrelated', { at: 201 })], { since: 100 }).open).toHaveLength(3);
  });

  it('lets a reply after the cutover supersede an old card, and keeps a dismissal made before a later reply asks the slug again', () => {
    const old = questionLedger([reply('r0', ASKED, { at: 1 }), reply('r1', 'Working on it.', { at: 200 })], { since: 100 });

    expect(states(old)['reply:r0#port']).toBe('superseded');
    expect(old.open).toEqual([]);

    const again = '1. **Design first?** Only the list? {#design-first}\n   - A) Yes\n   - B) No';
    const ledger = questionLedger([reply('r1', NEW, { at: 10 }), reply('r2', again, { at: 30 })], { dismissed: [{ key: 'reply:r1#design-first', at: 20 }] });

    expect(states(ledger)['reply:r1#design-first']).toBe('dismissed');
    expect(states(ledger)['reply:r2#design-first']).toBe('open');

    // Placed after the item that was newest when it was made, whatever the times say.
    const same = questionLedger([reply('r1', NEW, { at: 10 }), reply('r2', again, { at: 10 })], { dismissed: [{ key: 'reply:r1#design-first', at: 10, after: 'r1' }] });

    expect(states(same)['reply:r1#design-first']).toBe('dismissed');
    expect(states(same)['reply:r2#design-first']).toBe('open');
  });

  it('lists the cards in conversation order', () => {
    const ledger = questionLedger([reply('r1', NEW), reply('r2', ASKED)]);

    expect([...ledger.cards.keys()]).toEqual(['reply:r1', 'reply:r2']);
  });
});

describe('questions carried past retention (PRD R103)', () => {
  // Each item at its index, so a dismissal placed after an item and the carried questions line up with the whole conversation.
  const items: LedgerItem[] = [
    reply('r1', NEW),
    message('m1', '[answers]', { answers: [stored('r1', 'persona-registered', ['A'])] }),
    reply('r2', 'Settled.\n[withdraw: phone-layout — not needed]'),
    reply('r3', '1. Design first, really? {#design-first}\n   - A) Yes\n   - B) No\n2. Which port? {#port-choice}\n   - A) 1\n   - B) 2'),
    message('m2', 'port-choice B'),
    reply('r4', '1. Keep the route? {#keep-route}\n   - A) Keep\n   - B) Remove', { rewrittenBy: 'r5' }),
    message('m3', 'keep-route A', { delivery: 'not-sent' }),
    reply('r5', '1. Keep the old route? {#keep-route}\n   - A) Keep\n   - B) Remove'),
    reply('r6', '1. Which colour? {#colour-choice}\n   - A) Red\n   - B) Blue', { rewrittenBy: 'r8' }),
    message('m4', '[answers]', { answers: [stored('r6', 'colour-choice', ['B'])] }),
    message('m5', 'Unrelated.'),
    reply('r8', '1. Which colour now? {#colour-choice}\n   - A) Red\n   - B) Blue'),
    reply('r9', '1. Ship it? {#ship-it}\n   - A) Yes\n   - B) No'),
    reply('r10', '1. Pick one? {#pick-one}\n   - A) x\n   - B) y', { rewrittenBy: 'r11' }),
    message('m6', 'Unrelated.'),
    reply('r11', '1. Pick one, really? {#pick-one}\n   - A) x\n   - B) y'),
  ].map((item, index) => ({ ...item, at: index }));
  // The operator dismissed r3's design-first after m2, and r10's pick-one by its time alone, and has told the session of neither.
  const dismissed = [
    { key: 'reply:r3#design-first', at: 4, after: 'm2' },
    { key: 'reply:r10#pick-one', at: 13.5, after: null },
  ];
  const untold = new Set(['reply:r3#design-first', 'reply:r10#pick-one']);
  const whole = questionLedger(items, { dismissed });

  it('leaves the same open questions and states, wherever retention cut the conversation, as the whole conversation does', () => {
    expect(whole.open).toEqual(['reply:r5#keep-route', 'reply:r9#ship-it']);
    expect(states(whole)).toMatchObject({ 'reply:r3#design-first': 'dismissed', 'reply:r8#colour-choice': 'answered', 'reply:r3#port-choice': 'answered', 'reply:r11#pick-one': 'dismissed' });

    for (let cut = 0; cut <= items.length; cut++) {
      // Retention deletes the oldest items a few at a time, each batch folded into what the batch before carried.
      let carried: ReturnType<typeof carriedQuestions> = [];

      for (let at = 0; at < cut; at += 2) {
        const kept = new Set(items.slice(Math.min(at + 2, cut)).map((item) => item.id));

        carried = carriedQuestions(items.slice(at, Math.min(at + 2, cut)), { dismissed, carried, untold, later: (id) => kept.has(id) });
      }

      const after = questionLedger(items.slice(cut), { dismissed, carried });

      expect({ cut, open: after.open }).toEqual({ cut, open: whole.open });

      for (const key of ['reply:r3#design-first', 'reply:r5#keep-route', 'reply:r8#colour-choice', 'reply:r9#ship-it', 'reply:r10#pick-one', 'reply:r11#pick-one']) {
        // A question whose reply was deleted is still known while it is unresolved; a settled one goes with its reply.
        const kept = whole.questions.get(key)!.state === 'open' || untold.has(key) || items.slice(cut).some((item) => key.startsWith(`reply:${item.id}#`));

        expect({ cut, key, state: after.questions.get(key)?.state }).toEqual({ cut, key, state: kept ? whole.questions.get(key)!.state : undefined });
      }
    }
  });

  it('places a dismissal by its time against the items as they come, whatever their times, as the whole conversation does', () => {
    // r1 is rewritten by r2, read with an earlier time than r1; the dismissal by time falls between them, so it comes after r2 is read.
    const odd: LedgerItem[] = [reply('r1', '1. Pick? {#pick-one}\n   - A) x\n   - B) y', { at: 10, rewrittenBy: 'r2' }), reply('r2', '1. Pick, really? {#pick-one}\n   - A) x\n   - B) y', { at: 1 }), message('m1', 'Later.', { at: 20 })];
    const late = [{ key: 'reply:r1#pick-one', at: 5, after: null }];
    const full = questionLedger(odd, { dismissed: late });

    expect(full.open).toEqual(['reply:r2#pick-one']);

    for (let cut = 1; cut <= odd.length; cut++) {
      let carried: ReturnType<typeof carriedQuestions> = [];

      for (let at = 0; at < cut; at++) {
        const kept = new Set(odd.slice(at + 1).map((item) => item.id));

        carried = carriedQuestions(odd.slice(at, at + 1), { dismissed: late, carried, untold: new Set(['reply:r1#pick-one']), later: (id) => kept.has(id) });
      }

      expect({ cut, open: questionLedger(odd.slice(cut), { dismissed: late, carried }).open }).toEqual({ cut, open: full.open });
    }
  });

  it('carries only what is unresolved: open, dismissed and not told yet, or waiting for its reply\'s rewrite', () => {
    const carried = carriedQuestions(items.slice(0, 9), { dismissed, untold });

    expect(carried.map((one) => [one.key, one.state, one.rewrittenBy])).toEqual([
      ['reply:r3#design-first', 'dismissed', null],
      ['reply:r5#keep-route', 'open', null],
      ['reply:r6#colour-choice', 'open', 'r8'],
    ]);
    // Once the session is told of the dismissal, it is not carried again.
    expect(carriedQuestions(items.slice(0, 9), { dismissed }).map((one) => one.key)).not.toContain('reply:r3#design-first');
    // A carried question can be answered by a stored link, and leaves the carry once its answer is deleted too.
    const answered = questionLedger([message('m9', '[answers]', { answers: [stored('r5', 'keep-route', ['B'])], at: 30 })], { carried });

    expect(answered.questions.get('reply:r5#keep-route')).toMatchObject({ state: 'answered', answer: { messageId: 'm9', letters: ['B'] } });
    expect(carriedQuestions([message('m9', '[answers]', { answers: [stored('r5', 'keep-route', ['B'])], at: 30 })], { carried }).map((one) => one.key)).toEqual(['reply:r6#colour-choice']);
  });
});

describe('a card\'s draft and stepper (design § 6)', () => {
  const ledger = questionLedger([reply('r1', NEW)]);
  const card = ledger.cards.get('reply:r1')!;

  it('starts at the first question, picks a single option and stays on it, drops it when picked again unless told not to', () => {
    expect(currentStep(card, undefined)!.question.slug).toBe('persona-registered');

    const first = pickLetter(card, undefined, 'persona-registered', 'A');

    expect(first).toEqual({ step: 'persona-registered', picks: { 'persona-registered': { letters: ['A'], other: null } } });
    expect(currentStep(card, first)!.question.slug).toBe('persona-registered');
    expect(pickLetter(card, first, 'persona-registered', 'B').picks['persona-registered']!.letters).toEqual(['B']);
    expect(pickLetter(card, first, 'persona-registered', 'A').picks['persona-registered']!.letters).toEqual([]);
    expect(pickLetter(card, first, 'persona-registered', 'A', false).picks['persona-registered']!.letters).toEqual(['A']);
    // A letter the question does not offer changes nothing.
    expect(pickLetter(card, first, 'phone-layout', 'D')).toBe(first);
  });

  it('keeps a comment beside a pick either way round, a comment alone answers, and moves Back, Next and to a step', () => {
    const picked = pickLetter(card, undefined, 'phone-layout', 'A');
    const commented = setComment(card, picked, 'phone-layout', 'but wider');

    expect(commented.picks['phone-layout']).toEqual({ letters: ['A'], other: 'but wider' });
    expect(pickLetter(card, commented, 'phone-layout', 'B').picks['phone-layout']).toEqual({ letters: ['B'], other: 'but wider' });
    expect(pickLetter(card, commented, 'phone-layout', 'A').picks['phone-layout']).toEqual({ letters: [], other: 'but wider' });
    expect(draftAnswers(card, pickLetter(card, commented, 'phone-layout', 'A')).map(({ one }) => one.question.slug)).toEqual(['phone-layout']);
    expect(setComment(card, picked, 'phone-layout', '').picks['phone-layout']).toEqual({ letters: ['A'], other: '' });
    expect(moveStep(card, picked, 'next').step).toBe('design-first');
    expect(moveStep(card, picked, 'back').step).toBe('persona-registered');
    expect(moveStep(card, { step: 'persona-registered', picks: {} }, 'back').step).toBe('persona-registered');
    expect(moveStep(card, undefined, 'design-first').step).toBe('design-first');
  });

  it('sends only the answered questions, and labels Send for one, all and some', () => {
    const draft = { step: 'design-first', picks: { 'persona-registered': { letters: ['A'], other: null }, 'design-first': { letters: [], other: 'list only' }, 'phone-layout': { letters: [], other: '  ' } } };

    expect(draftAnswers(card, draft).map(({ one }) => one.question.slug)).toEqual(['persona-registered', 'design-first']);
    expect(sendLabel(1, 1)).toBe('Send answer');
    expect(sendLabel(3, 3)).toBe('Send 3 answers');
    expect(sendLabel(2, 3)).toBe('Send 2 of 3');
  });

  it('steps through at most four questions at a time', () => {
    const six = Array.from({ length: 6 }, (_, index) => `${index + 1}. Question ${index + 1}? {#question-${index + 1}}\n   - A) x\n   - B) y`).join('\n');
    const big = questionLedger([reply('r9', six)]).cards.get('reply:r9')!;

    expect(cardSteps(big).map((one) => one.question.slug)).toEqual(['question-1', 'question-2', 'question-3', 'question-4']);
    expect(BATCH).toBe(4);
  });
});

describe('voice (design § 7)', () => {
  it('reads the current question with its place, topic, context and options, and no slug or Markdown', () => {
    const question = parseQuestions(NEW)[0]!;

    expect(questionSpeech(question, 1, 3)).toBe(
      "Question 1 of 3. Persona registration. Register a persona as soon as you save it, or only after its voice check passes? Today Save registers it at once. I keep building the phone layout whichever you pick. A: Register on save, recommended: keeps today's behaviour; a broken voice shows an error the first time it speaks. B: Register after the voice check: Save takes about 2 s longer. A new persona cannot be picked until its check plays. Or say Comment and your words.",
    );
    expect(questionSpeech(parseQuestions('1. **Port** in use? {#port-choice}\n   - A) `8765`\n   - B) 8799')[0]!, 1, 1)).toBe('Port in use? A: 8765. B: 8799. Or say Comment and your words.');
    // A multi-choice question says so, once.
    expect(questionSpeech(parseQuestions('1. Where? {#where-shown}\n   Pick any number.\n   - A) Web page\n   - B) Dock')[0]!, 1, 1)).toBe('Where? Pick any number. Select all that apply. A: Web page. B: Dock. Or say Comment and your words.');
    expect(questionSpeech(parseQuestions('1. Where should it show? Select all that apply. {#where-shown}\n   - A) Web page\n   - B) Dock')[0]!, 1, 1)).toBe('Where should it show? Select all that apply. A: Web page. B: Dock. Or say Comment and your words.');
    expect(questionSpeech(parseQuestions('1. Where should it show? {#where-shown}\n   Any that apply.\n   - A) Web page\n   - B) Dock')[0]!, 1, 1)).toBe('Where should it show? Any that apply. Select all that apply. A: Web page. B: Dock. Or say Comment and your words.');
  });

  it('reads the card grammar from a whole utterance, homophones included, and nothing else', () => {
    expect(['B', 'bee', 'Be.', 'option C', 'see', 'sea', 'dee', 'ay', 'eh', 'B please'].map(cardUtterance)).toEqual([
      { type: 'pick', letter: 'B' },
      { type: 'pick', letter: 'B' },
      { type: 'pick', letter: 'B' },
      { type: 'pick', letter: 'C' },
      { type: 'pick', letter: 'C' },
      { type: 'pick', letter: 'C' },
      { type: 'pick', letter: 'D' },
      { type: 'pick', letter: 'A' },
      { type: 'pick', letter: 'A' },
      { type: 'pick', letter: 'B' },
    ]);
    expect(cardUtterance('The second one.')).toEqual({ type: 'pick-index', index: 1 });
    expect(cardUtterance('the recommended one')).toEqual({ type: 'recommended' });
    expect(cardUtterance('Comment, only the list.')).toEqual({ type: 'comment', text: 'only the list' });
    expect(cardUtterance('Other, only the list.')).toEqual({ type: 'comment', text: 'only the list' });
    expect(cardUtterance('comment')).toEqual({ type: 'comment', text: '' });
    expect(['back', 'Next.', 'skip', 'repeat', 'send', 'send them'].map((one) => cardUtterance(one)?.type)).toEqual(['back', 'next', 'next', 'repeat', 'send', 'send']);
    expect(['fix the login flow', 'B and C', 'be careful', 'otherwise fine', ''].map(cardUtterance)).toEqual([null, null, null, null, null]);
  });
});

describe('the legacy rules before the cutover: how each card was left, and the links between cards and answers (PRD R103)', () => {
  const message = (id: string, text: string, patch: Partial<Extract<LinkItem, { type: 'message' }>> = {}): LinkItem => ({ type: 'message', id, text, withdrawn: false, delivery: 'sent', at: 0, ...patch });
  const reply = (id: string, opening: string, patch: Partial<Extract<LinkItem, { type: 'reply' }>> = {}): LinkItem => ({ type: 'reply', id, kind: 'reply', opening, rewrittenBy: null, withdrawn: false, at: 0, ...patch });
  const outcomes = (links: CardLinks): Array<[string, string | null, string | null]> => [...links.cards].map(([key, card]) => [key, card.outcome, card.message?.id ?? null]);

  it('links a typed or sent answer and its card both ways, with the options and Other text chosen', () => {
    const links = cardLinks([reply('r1', ASKED), message('m1', '1B, 2 Other: keep it for a week')]);

    expect(outcomes(links)).toEqual([['reply:r1', 'answered', 'm1']]);
    expect(links.answers.get('m1')).toEqual([{ key: 'reply:r1', lines: [{ question: '1. Which port?', answer: 'B) 8799' }, { question: '2. Keep the old route?', answer: 'Other: keep it for a week' }] }]);
    expect(links.open).toBeNull();
    // Several options of one question, and only the questions answered.
    expect(cardLinks([reply('r1', ASKED), message('m1', '2A and 2C')]).answers.get('m1')![0]!.lines).toEqual([{ question: '2. Keep the old route?', answer: 'A) Yes, C) Keep it behind a flag' }]);
    // Marks in a question or an option are dropped from its line.
    expect(cardLinks([reply('r1', '1. Use **[the docs](d.md)**?\n   - A) `yes` *now*\n   - B) No')]).cards.get('reply:r1')!.questions[0]!.text).toBe('Use **[the docs](d.md)**?');
    expect(cardLinks([reply('r1', '1. Use **[the docs](d.md)**?\n   - A) `yes` *now*\n   - B) No'), message('m1', '1A')]).answers.get('m1')![0]!.lines).toEqual([{ question: '1. Use the docs?', answer: 'A) yes now' }]);
  });

  it('skips a card the next message ignores, with no link from that message, and leaves a card open under a message not yet sent', () => {
    const skipped = cardLinks([reply('r1', ASKED), message('m1', 'Do the docs first.')]);

    expect(outcomes(skipped)).toEqual([['reply:r1', 'skipped', 'm1']]);
    expect(skipped.answers.size).toBe(0);
    expect(cardLinks([reply('r1', ASKED), message('m1', '1A', { delivery: 'open' })])).toMatchObject({ open: 'reply:r1', answers: new Map() });
    expect(cardLinks([reply('r1', ASKED, { at: 500 }), message('m1', '1A', { provisional: true, at: 100 })]).open).toBe('reply:r1');
  });

  it('supersedes an unanswered card with a later reply, so only the newest reply\'s card is answerable, but not with an aside, a note or a status alone', () => {
    const links = cardLinks([reply('r1', ASKED), reply('r2', 'Ignore the question I asked; I found the port.'), message('m1', 'Good.')]);

    expect(outcomes(links)).toEqual([['reply:r1', 'superseded', null]]);
    expect(links.answers.size).toBe(0);
    expect(links.open).toBeNull();
    expect(outcomes(cardLinks([reply('r1', ASKED), reply('r2', 'Asking again.\n\n1. Port?\n   - A) 1\n   - B) 2'), message('m1', '1A')]))).toEqual([['reply:r1', 'superseded', null], ['reply:r2', 'answered', 'm1']]);
    expect(cardLinks([reply('r1', ASKED), reply('r2', 'Checking.', { kind: 'aside' }), reply('r3', 'Note.', { kind: 'note' }), reply('r4', ''), reply('r5', 'Gone.', { withdrawn: true })]).open).toBe('reply:r1');
    // An answer queued before the later reply, shown after it until the session reads it, still answers the card it saw, and no newer one; read
    // after the reply, it answers the newer card, as the session takes it.
    const queued = cardLinks([reply('r1', ASKED, { at: 10 }), reply('r2', 'Still working.\n\n1. Port?\n   - A) 1\n   - B) 2', { at: 30 }), message('m1', '1A', { provisional: true, delivery: null, at: 20 })]);

    expect(outcomes(queued)).toEqual([['reply:r1', 'answered', 'm1'], ['reply:r2', null, null]]);
    expect(queued.answers.get('m1')!.map((one) => one.key)).toEqual(['reply:r1']);
    expect(outcomes(cardLinks([reply('r1', ASKED, { at: 10 }), reply('r2', 'Still working.\n\n1. Port?\n   - A) 1\n   - B) 2', { at: 30 }), message('m1', '1A', { at: 40 })]))).toEqual([['reply:r1', 'superseded', null], ['reply:r2', 'answered', 'm1']]);
    // With no newer card, the next message that answers a superseded card is linked to it, sent before the reply or after; one that does not
    // leaves it superseded.
    expect(outcomes(cardLinks([reply('r1', ASKED, { at: 10 }), reply('r2', 'Done.', { at: 30 }), message('m1', '2B', { at: 40 })]))).toEqual([['reply:r1', 'answered', 'm1']]);
    expect(outcomes(cardLinks([reply('r1', ASKED, { at: 10 }), reply('r2', 'Done.', { at: 30 }), message('m1', 'Thanks.', { at: 40 }), message('m2', '1A', { at: 50 })]))).toEqual([['reply:r1', 'superseded', null]]);
    // A message queued before the card neither answers it nor ends the chance of the answer queued after it.
    const notice = { provisional: true, delivery: null };

    expect(outcomes(cardLinks([reply('r1', ASKED, { at: 10 }), reply('r2', 'Done.', { at: 20 }), message('m0', '1A', { ...notice, at: 5 })]))).toEqual([['reply:r1', 'superseded', null]]);
    expect(outcomes(cardLinks([reply('r1', ASKED, { at: 10 }), reply('r2', 'Done.', { at: 20 }), message('m0', 'Agents stopped.', { ...notice, at: 5 }), message('m1', '1A', { ...notice, at: 15 })]))).toEqual([['reply:r1', 'answered', 'm1']]);
    // A settled card stays as its message left it.
    expect(outcomes(cardLinks([reply('r1', ASKED), message('m1', '1A'), reply('r2', 'Done.')]))).toEqual([['reply:r1', 'answered', 'm1']]);
    // A rewrite draws the card in place of the reply it replaced, which has none.
    expect(outcomes(cardLinks([reply('r1', ASKED, { rewrittenBy: 'r2' }), reply('r2', ASKED)]))).toEqual([['reply:r2', null, null]]);
  });
});


describe('where the questions are', () => {
  const asked = 'Two things before I go on.\n\n1. Which port?\n   - A) 8765\n   - B) 8799\n2. Which checks?\n   - A) Unit\n   - B) Live\n     and the smoke run';

  it('finds the lines from the first question to the last option or its continuation, and the line a lone run asks', () => {
    expect(questionLines(asked)).toEqual({ first: 2, last: 8 });
    expect(questionLines('Intro\n\nPick one:\n- A) x\n- B) y\n\nThen more.')).toEqual({ first: 2, last: 4 });
    expect(questionLines('No questions.')).toBeNull();
  });

  it('cuts the Markdown into runs of text and of questions, keeping the text between two questions as its own run', () => {
    expect(questionSegments(asked)).toEqual([{ questions: 0, text: 'Two things before I go on.\n' }, { questions: 2, text: asked.split('\n').slice(2).join('\n') }]);
    expect(questionSegments('Intro\n1. Port?\n   - A) 1\n   - B) 2\n\nMore after.')).toEqual([{ questions: 0, text: 'Intro' }, { questions: 1, text: '1. Port?\n   - A) 1\n   - B) 2' }, { questions: 0, text: '\nMore after.' }]);
    expect(questionSegments('1. Port?\n   - A) 1\n   - B) 2\n\nWhy it matters.\n\n2. Name?\n   - A) x\n   - B) y')).toEqual([{ questions: 1, text: '1. Port?\n   - A) 1\n   - B) 2' }, { questions: 0, text: '\nWhy it matters.\n' }, { questions: 1, text: '2. Name?\n   - A) x\n   - B) y' }]);
    expect(questionSegments('Nothing asked.')).toBeNull();
  });

  it('leaves out the run of questions that ends the Markdown, and keeps questions written mid-message', () => {
    expect(withoutEndingQuestions(asked)).toBe('Two things before I go on.\n');
    expect(withoutEndingQuestions('Intro\n1. Port?\n   - A) 1\n   - B) 2\n\nMore after.')).toBe('Intro\n1. Port?\n   - A) 1\n   - B) 2\n\nMore after.');
    expect(withoutEndingQuestions('Nothing asked.')).toBe('Nothing asked.');
  });

});

describe('the legacy answer reading', () => {
  it('reads "1A", "1 A", "2A, 2C", "1A and 2B" and an Other answer from a message', () => {
    const questions = parseQuestions(ASKED);

    expect(answersIn('1A, 2 Other: use port 8800', questions)).toEqual(new Map([[0, { letters: ['A'], other: '' }], [1, { letters: [], other: 'use port 8800' }]]));
    expect([...answersIn('1B and 2 C please', questions)]).toEqual([[0, { letters: ['B'], other: '' }], [1, { letters: ['C'], other: '' }]]);
    expect(answersIn('1C, 3A, port 8765A', questions)).toEqual(new Map());
  });
});

describe('slugs and labels written loosely', () => {
  it('leaves a backticked slug before a dash or colon out of the question, deriving the id from the whole line as before', () => {
    const dash = parseQuestions("Should it count?\n\n`row-actions-terminal` — The dock's row menu has two items. Its Console tab covers them.\n- A) Count it\n- B) Add both")[0]!;
    const colon = parseQuestions('1. **`port-choice`:** Which port?\n   - A) 8765\n   - B) 8799')[0]!;

    const longer = parseQuestions('1. `use-the-new-api` — Switch to it now?\n   - A) Yes\n   - B) No')[0]!;

    expect(dash).toMatchObject({ slug: 'row-actions-terminal', written: false, text: "The dock's row menu has two items. Its Console tab covers them." });
    expect(colon).toMatchObject({ slug: 'port-choice', text: 'Which port?' });
    // The id stays the one derived before the lead was recognized, so an answer stored for it still settles the question.
    expect(longer).toMatchObject({ slug: 'use-new-api', text: 'Switch to it now?' });
    const ledger = questionLedger([{ type: 'reply', id: 'r1', kind: 'reply', opening: '1. `use-the-new-api` — Switch to it now?\n   - A) Yes\n   - B) No', rewrittenBy: null, withdrawn: false, at: 1 }, { type: 'message', id: 'm1', text: 'x', withdrawn: false, delivery: 'sent', at: 2, answers: [{ replyId: 'r1', slug: 'use-new-api', letters: ['A'], other: '', via: 'card' }] }], { since: 0 });
    expect(ledger.cards.get('reply:r1')!.questions[0]!.state).toBe('answered');
  });

  it('keeps the derived id when a topic follows the backticked lead', () => {
    expect(parseQuestions('1. `use-the-new-api` — **API choice.** Switch to it now?\n   - A) Yes\n   - B) No')[0]).toMatchObject({ slug: 'use-new-api', topic: 'API choice', text: 'Switch to it now?' });
  });

  it('takes the backticked slug off the question lines the views show, leaving other prose alone', () => {
    const once = stripQuestionMarkup('1. `package-lock` — keep this file.\n2. `old-name` — rename it? {#rename-choice}\n   - A) Rename\n   - B) Keep');

    expect(once).toBe('1. `package-lock` — keep this file.\n2. rename it?\n   - A) Rename\n   - B) Keep');
    expect(stripQuestionMarkup(once)).toBe(once);
    expect(stripQuestionMarkup("Intro `not-a-q` — prose.\n\nShould it?\n`row-actions-terminal` — The dock.\n- A) x\n- B) y")).toBe("Intro `not-a-q` — prose.\n\nShould it?\nThe dock.\n- A) x\n- B) y");
    expect(stripQuestionMarkup('1. **`port-choice`:** Which port?\n   - A) 1\n   - B) 2')).toBe('1. Which port?\n   - A) 1\n   - B) 2');
  });

  it('keeps a backticked lead that is not a slug as question text, and a {#slug} the line ends with as the id', () => {
    expect(parseQuestions('1. `npm ci` — run it now?\n   - A) Yes, now\n   - B) Later')[0]).toMatchObject({ written: false, text: '`npm ci` — run it now?' });
    expect(parseQuestions('1. `old-name` — rename it? {#rename-choice}\n   - A) Rename\n   - B) Keep')[0]).toMatchObject({ slug: 'rename-choice', written: true, text: 'rename it?' });
  });

  it('reads "(recommended): " as the end of an option\'s label and the start of its description', () => {
    const [option] = parseQuestions('1. Which? {#which-one}\n   - A) Start right away; remember the choice (recommended): what you type is answered at once\n   - B) Ask first')[0]!.options;

    expect(option).toMatchObject({ label: 'Start right away; remember the choice', description: 'what you type is answered at once', recommended: true });
    expect(parseQuestions('1. Which? {#which-one}\n   - A) **Start now (recommended):** begin today\n   - B) Later')[0]!.options[0]).toMatchObject({ label: 'Start now', description: 'begin today', recommended: true });
  });
});

describe('the short forms the answered rows and the Answers bubble show', () => {
  const [topic, asks, plainText] = parseQuestions(['1. **Port.** Which port? {#port-choice}', '   - A) 8765', '   - B) 8799', '2. Today it registers at once. Register after the check instead? {#register-later}', '   - A) Yes', '   - B) No', '3. The page has no menu. {#page-menu}', '   - A) Add one', '   - B) Leave it'].join('\n'));

  it('names a question by its topic, else its asking sentence, else its whole text', () => {
    expect(questionBrief(topic!)).toBe('Port');
    expect(questionBrief(asks!)).toBe('Register after the check instead?');
    expect(questionBrief(plainText!)).toBe('The page has no menu.');
  });

  it('gives the chosen labels without letters or Markdown, then the comment, or the dismissal', () => {
    const [question] = parseQuestions('1. Which? {#which-one}\n   - A) **Start now**\n   - B) Ask first\n   - C) Never');

    expect(answerBrief(question!, ['A', 'C'], '  my  own ')).toBe('Start now; Never; Comment: my own');
    expect(answerBrief(question!, [], 'my own')).toBe('Comment: my own');
    expect(answerBrief(question!, [], '', true)).toBe('No answer (dismissed)');
  });
});

describe('several options (rules.ts, "Select all that apply.")', () => {
  it('takes several options when the question asks for them, by the rules\' phrase or the older ones, and one otherwise', () => {
    const [asked, older, single] = parseQuestions(
      '1. Which pages need the header? Select all that apply. {#header-pages}\n   - A) List\n   - B) Settings\n2. Where? {#where-shown}\n   Pick one or more.\n   - A) Web\n   - B) Dock\n3. Which port? {#port-choice}\n   - A) 8765\n   - B) 8799',
    );

    expect([asked!.multi, older!.multi, single!.multi]).toEqual([true, true, false]);
    expect(asked!.text).toBe('Which pages need the header? Select all that apply.');
  });

  it('leaves a closing request for several out of the shown text only, and never empties it', () => {
    const shown = (line: string): string => withoutMultiAsk(parseQuestions(`1. ${line} {#some-slug}\n   - A) x\n   - B) y`)[0]!);

    expect(shown('Which pages? Select all that apply.')).toBe('Which pages?');
    expect(shown('Which pages? (select all that apply)')).toBe('Which pages?');
    expect(shown('Which pages? Choose any that apply')).toBe('Which pages?');
    expect(shown('Select all that apply.')).toBe('Select all that apply.');
    // A request inside the sentence, not closing it, stays.
    expect(shown('Which page is the select all that apply page?')).toBe('Which page is the select all that apply page?');
  });
});
