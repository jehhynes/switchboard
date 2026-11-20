/**
 * Lettered questions (architecture.md § Conversation view, voice-design § 5) as the page reads them: a numbered question followed by at least two
 * options lettered from A, each on its own line, or a lone run of such options under the line that asks it. A card's Submit sends an ordinary
 * message such as "1A, 2B", the same shape the VS Code view sends.
 */

export interface Question {
  number: number | null;
  text: string;
  multi: boolean;
  options: Array<{ letter: string; text: string }>;
}

export interface Choice {
  letters: string[];
  other: string;
}

const QUESTION = /^\s{0,3}(?:[-*+]\s+)?(?:\*\*|__)?(\d{1,2})[.)](?:\*\*|__)?\s+(.*\S)\s*$/;
const OPTION = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:\(([A-Ha-h])\)|([A-Ha-h])\)|([A-H])[.:])(?:\*\*|__)?\s+(.*\S)\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const MULTI = /\b(?:all that apply|any that apply|one or more|(?:choose|pick|select) (?:any|all|several|multiple|more than one)|multiple choices?)\b/i;

function unbold(text: string): string {
  const wrapped = /^(\*\*|__)([^*_].*?)\1$/.exec(text);
  const marks = text.match(/\*\*|__/g)?.length ?? 0;

  return wrapped !== null && marks === 2 ? wrapped[2]!.trim() : marks % 2 === 1 ? text.replace(/^(\*\*|__)|(\*\*|__)$/, '').trim() : text;
}

/** The questions a reply's or a status's Markdown asks, outside fenced code; none when their answers could not be told apart. */
export function parseQuestions(markdown: string): Question[] {
  const blocks: Array<Omit<Question, 'multi'>> = [];
  let open: Omit<Question, 'multi'> | null = null;
  let previous = '';
  let fence: string | null = null;
  const close = (): void => {
    if (open !== null && open.options.length >= 2) {
      blocks.push(open);
    }

    open = null;
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
      const current = open as Omit<Question, 'multi'> | null;

      if (current === null || letter !== String.fromCharCode(65 + current.options.length)) {
        if (current !== null && letter !== 'A') {
          open = null;
        }

        close();

        if (letter !== 'A') {
          previous = line;
          continue;
        }

        open = { number: null, text: unbold(previous.replace(/^\s*(?:[-*+]\s+|#{1,6}\s+)?/, '').trim()), options: [] };
      }

      open!.options.push({ letter, text: unbold(option[4]!) });
      previous = line;
      continue;
    }

    const question = QUESTION.exec(line);

    if (question !== null) {
      close();
      open = { number: Number(question[1]), text: unbold(question[2]!), options: [] };
    } else if (line.trim() !== '') {
      const current = open as Omit<Question, 'multi'> | null;

      if (current !== null && /^\s/.test(line)) {
        const last = current.options.at(-1);

        if (last === undefined) {
          current.text = `${current.text} ${line.trim()}`;
        } else {
          last.text = `${last.text} ${line.trim()}`;
        }
      } else {
        close();
      }
    } else {
      continue;
    }

    previous = line;
  }

  close();

  const numbered = blocks.flatMap((block) => (block.number === null ? [] : [block.number]));

  if (blocks.length === 0 || new Set(numbered).size !== numbered.length || (numbered.length !== blocks.length && blocks.length > 1) || (blocks[0]!.number === null && blocks[0]!.text === '')) {
    return [];
  }

  return blocks.map((block) => ({ ...block, multi: MULTI.test(block.text) }));
}

/** Whether every question has a pick or an Other text. */
export function complete(questions: readonly Question[], choices: ReadonlyMap<number, Choice>): boolean {
  return questions.every((_question, index) => (choices.get(index)?.letters.length ?? 0) > 0 || (choices.get(index)?.other.trim() ?? '') !== '');
}

/** The message a card sends: "1A, 2B", "2A, 2C" for several picks, "2 Other: text"; one answer a line when an Other text holds a comma. */
export function answerText(questions: readonly Question[], choices: ReadonlyMap<number, Choice>): string {
  const answers: string[] = [];
  let lines = false;

  questions.forEach((question, index) => {
    const choice = choices.get(index);
    const prefix = question.number === null ? '' : String(question.number);
    const other = choice?.other.trim().replace(/\s+/g, ' ') ?? '';

    for (const option of question.options.filter((one) => choice?.letters.includes(one.letter))) {
      answers.push(`${prefix}${option.letter}`);
    }

    if (other !== '') {
      lines ||= /[,;]/.test(other);
      answers.push(`${prefix === '' ? '' : `${prefix} `}Other: ${other}`);
    }
  });

  return answers.join(lines ? '\n' : ', ');
}

/** The picks a later message gave a card, read loosely ("1A", "1 A", "2A and 2C", a lone letter for a lone question), for an answered card. */
export function answersIn(message: string, questions: readonly Question[]): Map<number, Choice> {
  const found = new Map<number, Choice>();
  const pick = (index: number, letter: string): void => {
    if (questions[index]?.options.some((option) => option.letter === letter) !== true) {
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

  for (const other of message.matchAll(others)) {
    const index = other[1] === undefined ? (questions.length === 1 ? 0 : -1) : questions.findIndex((question) => question.number === Number(other[1]));

    if (index !== -1 && other[2] !== '') {
      found.set(index, { letters: found.get(index)?.letters ?? [], other: other[2]! });
    }
  }

  const text = message.replace(others, '\n');

  if (questions.length === 1 && questions[0]!.number === null) {
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
