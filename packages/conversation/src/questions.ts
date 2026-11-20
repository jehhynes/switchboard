/**
 * Structured questions (architecture.md § Conversation view, voice-design § 5): numbered questions with lettered options, each option on a line of
 * its own, which a reply or a status asks in its Markdown. The view and the web page draw them as a card whose Submit sends an ordinary message
 * such as "1A, 2B", and the hub reads them to tell when a turn ends waiting on the operator's answer (PRD R103). Imports nothing, so a browser
 * bundle takes it through `@switchboard/conversation/questions`.
 */

/** One lettered option, its letter in capitals. */
export interface QuestionOption {
  letter: string;
  text: string;
}

/** One question: its written number, or null for a lone question with no number, its text, and whether it takes several options. */
export interface Question {
  number: number | null;
  text: string;
  multi: boolean;
  options: QuestionOption[];
}

/** A numbered question, as "1. Which port?", "**2) Scope**" or "- 3. Name?". */
const QUESTION = /^\s{0,3}(?:[-*+]\s+)?(?:\*\*|__)?(\d{1,2})[.)](?:\*\*|__)?\s+(.*\S)\s*$/;
/**
 * A lettered option on a line of its own, as "- A) 8765", "(b) Later" or "C. Skip", optionally bold. Only A to H, and "X." only in capitals, so
 * initials such as "J. Smith" are not read as options (claude-collab's rule).
 */
const OPTION = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:\(([A-Ha-h])\)|([A-Ha-h])\)|([A-H])[.:])(?:\*\*|__)?\s+(.*\S)\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
/** A question that says it takes several options. */
const MULTI = /\b(?:all that apply|any that apply|one or more|(?:choose|pick|select) (?:any|all|several|multiple|more than one)|multiple choices?)\b/i;

/** Removes bold marks around the whole text, or one a line's own regular expression left at an end, so "**A) Yes**" reads "Yes". */
function unbold(text: string): string {
  const marks = text.match(/\*\*|__/g)?.length ?? 0;
  const wrapped = /^(\*\*|__)([^*_].*?)\1$/.exec(text);

  return wrapped !== null && marks === 2 ? wrapped[2]!.trim() : marks % 2 === 1 ? text.replace(/^(\*\*|__)|(\*\*|__)$/, '').trim() : text;
}

interface Block {
  number: number | null;
  text: string;
  options: QuestionOption[];
}

/**
 * The questions a reply's or a status's Markdown asks, outside fenced code: each numbered question followed by at least two options lettered
 * from A in order, or a lone unnumbered run of such options under the line that asks it. A numbered list item with no options is not a question.
 * Returns none when the shape is ambiguous: a number used twice, or an unnumbered run beside other questions, whose answers could not be told apart.
 */
export function parseQuestions(markdown: string): Question[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  let last: QuestionOption | null = null;
  let previous = '';
  let fence: string | null = null;

  const close = (): void => {
    if (open !== null && open.options.length >= 2) {
      blocks.push(open);
    }

    open = null;
    last = null;
  };

  for (const line of markdown.replace(/\r/g, '').split('\n')) {
    const fenced = FENCE.exec(line);

    if (fence !== null) {
      fence = fenced !== null && fenced[1]!.startsWith(fence) ? null : fence;
      continue;
    }

    if (fenced !== null) {
      close();
      fence = fenced[1]!;
      continue;
    }

    const option = OPTION.exec(line);

    if (option !== null) {
      const letter = (option[1] ?? option[2] ?? option[3]!).toUpperCase();
      const text = unbold(option[4]!);
      const current: Block | null = open;

      if (current === null || letter !== String.fromCharCode(65 + current.options.length)) {
        // A letter out of order spoils the question it would belong to, rather than leaving it cut short.
        if (current !== null && letter !== 'A') {
          open = null;
          last = null;
        }

        close();

        if (letter !== 'A') {
          previous = line;
          continue;
        }

        // A run of options with no numbered question above it asks the line before it.
        open = { number: null, text: unbold(previous.replace(/^\s*(?:[-*+]\s+|#{1,6}\s+)?/, '').trim()), options: [] };
      }

      last = { letter, text };
      open!.options.push(last);
      previous = line;
      continue;
    }

    const question = QUESTION.exec(line);

    if (question !== null) {
      close();
      open = { number: Number(question[1]), text: unbold(question[2]!), options: [] };
      previous = line;
      continue;
    }

    if (line.trim() === '') {
      continue;
    }

    // An indented line continues the option or the question above it; any other line ends the question.
    if (open !== null && /^\s/.test(line)) {
      const block: Block = open;

      if (last !== null) {
        last.text = `${last.text} ${line.trim()}`;
      } else {
        block.text = `${block.text} ${line.trim()}`;
      }
    } else {
      close();
    }

    previous = line;
  }

  close();

  const numbered = blocks.map((block) => block.number).filter((number) => number !== null);

  if (blocks.length === 0 || new Set(numbered).size !== numbered.length || (numbered.length !== blocks.length && blocks.length > 1) || (blocks[0]!.number === null && blocks[0]!.text === '')) {
    return [];
  }

  return blocks.map((block) => ({ ...block, multi: MULTI.test(block.text) }));
}

/** What the operator chose for one question: the letters picked, and the text of its Other field. */
export interface QuestionChoice {
  letters: string[];
  other: string;
}

/** Whether every question has a pick or Other text, as Claude Code's form asks before Submit, since any later message answers the whole card. */
export function complete(questions: readonly Question[], choices: ReadonlyMap<number, QuestionChoice>): boolean {
  return questions.every((_question, index) => (choices.get(index)?.letters.length ?? 0) > 0 || (choices.get(index)?.other.trim() ?? '') !== '');
}

/**
 * The message a card sends (voice-design § 5): each answered question by its number and letter, as "1A, 2B"; a question with several options
 * picked once per option, as "2A, 2C"; an Other answer as "2 Other: use port 8799". A lone unnumbered question answers with its letter alone.
 * When an Other text holds a comma or a semicolon, each answer goes on its own line, so that text cannot run into the next answer. Unanswered
 * questions are left out; empty when none is answered.
 */
export function answerText(questions: readonly Question[], choices: ReadonlyMap<number, QuestionChoice>): string {
  const answers: string[] = [];
  let free = false;

  questions.forEach((question, index) => {
    const choice = choices.get(index);
    const prefix = question.number === null ? '' : String(question.number);
    const letters = question.options.map((option) => option.letter).filter((letter) => choice?.letters.includes(letter));
    const other = choice?.other.trim().replace(/\s+/g, ' ') ?? '';

    for (const letter of letters) {
      answers.push(`${prefix}${letter}`);
    }

    if (other !== '') {
      free ||= /[,;]/.test(other);
      answers.push(`${prefix === '' ? '' : `${prefix} `}Other: ${other}`);
    }
  });

  return answers.join(free ? '\n' : ', ');
}

/**
 * The choices a message gave a card's questions, read loosely from its text: "1A", "1 A", "2A, 2C", "1A and 2B", an Other answer as
 * `answerText` writes it, and a lone letter for a lone unnumbered question, so a card answered by typing shows what was picked as one answered
 * with Submit does.
 */
export function answersIn(message: string, questions: readonly Question[]): Map<number, QuestionChoice> {
  let text = message;
  const found = new Map<number, QuestionChoice>();
  const pick = (index: number, letter: string): void => {
    const question = questions[index];

    if (question === undefined || !question.options.some((option) => option.letter === letter)) {
      return;
    }

    const choice = found.get(index) ?? { letters: [], other: '' };

    if (!choice.letters.includes(letter)) {
      choice.letters.push(letter);
    }

    found.set(index, choice);
  };

  // An Other answer runs to the end of its line, or to the next answer when the answers share one line; its text is never read for picks.
  const others = /(?:^|\n|, )\s*(?:(\d{1,2})\s+)?Other:\s*(.*?)\s*(?=\n|, (?:\d{1,2}\s?[A-H]\b|(?:\d{1,2}\s+)?Other:|[A-H](?:,|$))|$)/g;

  for (const other of text.matchAll(others)) {
    const index = other[1] === undefined ? (questions.length === 1 ? 0 : -1) : questions.findIndex((question) => question.number === Number(other[1]));

    if (index !== -1 && other[2] !== '') {
      found.set(index, { letters: found.get(index)?.letters ?? [], other: other[2]! });
    }
  }

  text = text.replace(others, '\n');

  if (questions.length === 1 && questions[0]!.number === null) {
    // Each answer of a lone question is its letter alone, as "B" or "A, B".
    for (const part of text.split(/,|\n|\band\b/)) {
      const lone = /^\s*\(?([A-Ha-h])\)?\s*[.!]?\s*$/.exec(part);

      if (lone !== null) {
        pick(0, lone[1]!.toUpperCase());
      }
    }

    return found;
  }

  for (const match of text.matchAll(/\b(\d{1,2})\s?([A-H])\b/g)) {
    pick(questions.findIndex((question) => question.number === Number(match[1])), match[2]!);
  }

  return found;
}
