import { describe, expect, it } from 'vitest';
import { answersIn, answerText, complete, parseQuestions, unansweredCard , cardOutcome, questionLines, questionSegments } from '../src/questions.js';
import type { CardItem, QuestionChoice } from '../src/questions.js';

/** The shape the conversation rules show, with a second question. */
const ASKED = 'Two things before I start:\n\n1. Which port?\n   - A) 8765 (recommended)\n   - B) 8799\n2. **Keep the old route?**\n   - A) Yes\n   - B) No, remove it\n   - C) Keep it behind a flag\n\nSay if neither fits.';
const choices = (entries: Array<[number, Partial<QuestionChoice>]>): Map<number, QuestionChoice> => new Map(entries.map(([index, choice]) => [index, { letters: [], other: '', ...choice }]));

describe('parsing lettered questions', () => {
  it('reads numbered questions with options lettered from A, each on its own line, as the conversation rules show them', () => {
    expect(parseQuestions(ASKED)).toEqual([
      { number: 1, text: 'Which port?', multi: false, options: [{ letter: 'A', text: '8765 (recommended)' }, { letter: 'B', text: '8799' }] },
      { number: 2, text: 'Keep the old route?', multi: false, options: [{ letter: 'A', text: 'Yes' }, { letter: 'B', text: 'No, remove it' }, { letter: 'C', text: 'Keep it behind a flag' }] },
    ]);
  });

  it('takes the option shapes Claude writes, a bold or parenthesised letter, a lower-case one, and a line that continues an option or a question', () => {
    const questions = parseQuestions('1) Scope\n   for this run\n**A)** Only the inbox\n(b) Everything\n  including the dock\nc) Nothing\n\n2. Name?\n   A. Short\n   B: Long');

    expect(questions.map((question) => [question.number, question.text, question.options.map((option) => `${option.letter} ${option.text}`)])).toEqual([
      [1, 'Scope for this run', ['A Only the inbox', 'B Everything including the dock', 'C Nothing']],
      [2, 'Name?', ['A Short', 'B Long']],
    ]);
  });

  it('reads a lone question with lettered options and no number, answered by its letter alone', () => {
    const questions = parseQuestions('Which one should I keep?\n\n- A) The first\n- B) The second');

    expect(questions).toEqual([{ number: null, text: 'Which one should I keep?', multi: false, options: [{ letter: 'A', text: 'The first' }, { letter: 'B', text: 'The second' }] }]);
    expect(answerText(questions, choices([[0, { letters: ['B'] }]]))).toBe('B');
    expect(answerText(questions, choices([[0, { other: 'neither' }]]))).toBe('Other: neither');
    expect(answersIn('b', questions).get(0)?.letters).toEqual(['B']);
    // Several picks of a lone question read back as they were sent.
    const several = parseQuestions('Which should run? Pick any that apply.\n\n- A) Lint\n- B) Tests');

    expect(answerText(several, choices([[0, { letters: ['A', 'B'] }]]))).toBe('A, B');
    expect(answersIn('A, B', several).get(0)?.letters).toEqual(['A', 'B']);
  });

  it('marks a question that says it takes several options', () => {
    expect(parseQuestions('1. Which checks should run? Pick any that apply.\n   - A) Lint\n   - B) Tests')[0]?.multi).toBe(true);
    expect(parseQuestions('1. Which one? Choose one or more.\n   - A) Lint\n   - B) Tests')[0]?.multi).toBe(true);
    expect(parseQuestions(ASKED)[0]?.multi).toBe(false);
  });

  it('finds no question in lists, prose, code or shapes whose answers could not be told apart', () => {
    // A numbered list with no options, one option alone, letters out of order or not from A, and initials.
    expect(parseQuestions('1. Build\n2. Test\n3. Ship')).toEqual([]);
    expect(parseQuestions('1. Which?\n   - A) Only one')).toEqual([]);
    expect(parseQuestions('1. Which?\n   - B) One\n   - C) Two')).toEqual([]);
    expect(parseQuestions('1. Which?\n   - A) One\n   - C) Two')).toEqual([]);
    expect(parseQuestions('1. Which?\n   - A) One\n   - B) Two\n   - D) Four')).toEqual([]);
    expect(parseQuestions('Asked J. Smith and\nK. Jones about it.')).toEqual([]);
    // Options inside a fenced block are code.
    expect(parseQuestions('```\n1. Which?\n   - A) One\n   - B) Two\n```')).toEqual([]);
    // A paragraph after the question's line ends it.
    expect(parseQuestions('1. Which?\nI think so.\n- A) One\n- B) Two').map((question) => question.number)).toEqual([null]);
    // A number used twice, or a lone run beside numbered questions.
    expect(parseQuestions('1. One?\n   - A) x\n   - B) y\n1. Again?\n   - A) x\n   - B) y')).toEqual([]);
    expect(parseQuestions('1. One?\n   - A) x\n   - B) y\n\nAlso:\n\n- A) p\n- B) q')).toEqual([]);
    expect(parseQuestions('- A) p\n- B) q')).toEqual([]);
  });
});

describe('the answer a card sends', () => {
  const questions = parseQuestions(ASKED);

  it('names each answered question by number and letter, an Other answer by its text, and leaves out unanswered ones', () => {
    expect(answerText(questions, choices([[0, { letters: ['A'] }], [1, { letters: ['B'] }]]))).toBe('1A, 2B');
    expect(answerText(questions, choices([[0, { letters: ['A'] }], [1, { other: '  use   port 8800 ' }]]))).toBe('1A, 2 Other: use port 8800');
    expect(answerText(questions, choices([[1, { letters: ['C', 'A'] }]]))).toBe('2A, 2C');
    expect(answerText(questions, choices([[0, { other: '   ' }]]))).toBe('');
    // A comma in an Other text puts each answer on its own line.
    expect(answerText(questions, choices([[0, { other: 'both, in turn' }], [1, { letters: ['A'] }]]))).toBe('1 Other: both, in turn\n2A');
  });

  it('reads the choices back from the message, sent by a card or typed', () => {
    expect(answersIn('1A, 2 Other: use port 8800', questions)).toEqual(choices([[0, { letters: ['A'] }], [1, { other: 'use port 8800' }]]));
    expect(answersIn('1 Other: both, in turn\n2A', questions)).toEqual(choices([[0, { other: 'both, in turn' }], [1, { letters: ['A'] }]]));
    expect(answersIn('1B and 2 C please', questions)).toEqual(choices([[0, { letters: ['B'] }], [1, { letters: ['C'] }]]));
    // A lone Other answer keeps its commas, and Other text is never read for picks.
    expect(answerText(questions.slice(0, 1), choices([[0, { other: 'both, in turn' }]]))).toBe('1 Other: both, in turn');
    expect(answersIn('1 Other: both, in turn', questions)).toEqual(choices([[0, { other: 'both, in turn' }]]));
    expect(answersIn('1 Other: neither; use 2B later\n2A', questions)).toEqual(choices([[0, { other: 'neither; use 2B later' }], [1, { letters: ['A'] }]]));
    expect(answersIn('1A, 2 Other: none', questions)).toEqual(choices([[0, { letters: ['A'] }], [1, { other: 'none' }]]));
    // A letter a question does not have, or a number no question has, is no answer.
    expect(answersIn('1C, 3A, port 8765A', questions)).toEqual(new Map());
  });
});

describe('a complete card', () => {
  it('needs a pick or Other text for every question before Submit', () => {
    const questions = parseQuestions(ASKED);

    expect(complete(questions, choices([[0, { letters: ['A'] }], [1, { other: 'later' }]]))).toBe(true);
    expect(complete(questions, choices([[0, { letters: ['A'] }]]))).toBe(false);
    expect(complete(questions, choices([[0, { letters: ['A'] }], [1, { other: '   ' }]]))).toBe(false);
  });
});

describe('an unanswered card (PRD R103)', () => {
  const message = (withdrawn = false, delivery: string | null = 'sent', patch: Partial<Extract<CardItem, { type: 'message' }>> = {}): CardItem => ({ type: 'message', withdrawn, delivery, ...patch });
  const reply = (id: string, opening: string, patch: Partial<Extract<CardItem, { type: 'reply' }>> = {}): CardItem => ({ type: 'reply', id, kind: 'reply', opening, rewrittenBy: null, withdrawn: false, ...patch });

  it('is a reply after the newest message that asks lettered questions', () => {
    expect(unansweredCard([message(), reply('r1', ASKED)], null)).toBe(true);
    expect(unansweredCard([reply('r1', ASKED)], null)).toBe(true);
    expect(unansweredCard([message(), reply('r1', ASKED), reply('r2', 'Working on it.')], null)).toBe(true);
    // A withdrawn message never reached Claude, so it answers nothing.
    expect(unansweredCard([reply('r1', ASKED), message(true)], null)).toBe(true);
    // Nor does one still waiting to be typed, which may come back not sent.
    expect(unansweredCard([reply('r1', ASKED), message(false, 'open')], null)).toBe(true);
    expect(unansweredCard([reply('r1', ASKED), message(false, null)], null)).toBe(false);
  });

  it('is still open under a provisional message queued before the card, and answered by one queued after it', () => {
    // A notice an earlier run left queued shows after the transcript's items, dated before the card.
    expect(unansweredCard([reply('r1', ASKED, { at: 500 }), message(false, null, { provisional: true, at: 100 })], null)).toBe(true);
    expect(unansweredCard([reply('r1', ASKED, { at: 500 }), message(false, null, { provisional: true, at: 600 })], null)).toBe(false);
    expect(unansweredCard([reply('r1', ASKED, { at: 500 }), message(false, null, { provisional: false, at: 100 })], null)).toBe(false);
    expect(unansweredCard([reply('r1', '', { at: 500 }), message(false, null, { provisional: true, at: 100 })], { replyId: 'r1', markdown: ASKED })).toBe(true);
  });

  it('is none once any message follows, or when the reply is an aside, a note, rewritten, withdrawn or asks no lettered question', () => {
    expect(unansweredCard([reply('r1', ASKED), message()], null)).toBe(false);
    expect(unansweredCard([message(), reply('r1', ASKED, { kind: 'aside' })], null)).toBe(false);
    expect(unansweredCard([message(), reply('r1', ASKED, { kind: 'note' })], null)).toBe(false);
    expect(unansweredCard([message(), reply('r1', ASKED, { rewrittenBy: 'r2' }), reply('r2', 'Never mind.')], null)).toBe(false);
    expect(unansweredCard([message(), reply('r1', ASKED, { withdrawn: true })], null)).toBe(false);
    expect(unansweredCard([message(), reply('r1', '1. Build\n2. Test')], null)).toBe(false);
    expect(unansweredCard([], null)).toBe(false);
  });

  it('is the newest status asking lettered questions, written in a reply after the newest message', () => {
    expect(unansweredCard([message(), reply('r1', '')], { replyId: 'r1', markdown: ASKED })).toBe(true);
    expect(unansweredCard([reply('r1', ''), message()], { replyId: 'r1', markdown: ASKED })).toBe(false);
    expect(unansweredCard([message(), reply('r1', '')], { replyId: 'r1', markdown: 'Done.' })).toBe(false);
    // A status whose reply is older than the items read is answered by the message read after it.
    expect(unansweredCard([message(), reply('r2', 'Ok.')], { replyId: 'r1', markdown: ASKED })).toBe(false);
  });
});

describe('where the questions are, and how a later message left them', () => {
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

  it('counts a message as an answer only when it answers one of the questions, else as skipping them', () => {
    const questions = parseQuestions(asked);

    expect(cardOutcome(null, questions)).toBeNull();
    expect(cardOutcome('1A, 2B', questions)).toBe('answered');
    expect(cardOutcome('2 Other: none', questions)).toBe('answered');
    expect(cardOutcome('Never mind, do the docs first.', questions)).toBe('skipped');
    // A number with a letter for a question the card does not ask answers nothing.
    expect(cardOutcome('3A', questions)).toBe('skipped');
  });
});
