/**
 * Structured questions (architecture.md § Conversation view, PRD R103): numbered questions with lettered options, each option on a line of its
 * own, which a reply asks in its Markdown. Each question carries an id (`{#slug}`), an optional bold topic, a context paragraph and options
 * with a label and a description of what choosing it changes. The view and the web page draw them as a card answered one question at a time,
 * whose Send posts the structured answer and the hub writes the `[answers]` message (`answerMessage`). A question stays open until it is
 * answered, withdrawn, replaced or dismissed (`questionLedger`). Imports nothing, so a browser bundle takes it through
 * `@switchboard/conversation/questions`.
 */

/** One lettered option, its letter in capitals: its label, what choosing it changes, and whether the session recommends it. */
export interface QuestionOption {
  letter: string;
  label: string;
  description: string;
  recommended: boolean;
  /** The label, for callers written before options had descriptions. */
  text: string;
}

/**
 * One question: its written number, or null for a lone question with no number; its id, written by the session or derived from its text; its
 * topic, text and context; whether it takes several options.
 */
export interface Question {
  number: number | null;
  slug: string;
  /** Whether the session wrote the slug, rather than Switchboard deriving it. */
  written: boolean;
  topic: string | null;
  text: string;
  context: string;
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
/** A question that says it takes several options; the rules ask for "Select all that apply." (rules.ts). */
const MULTI = /\b(?:all that apply|any that apply|one or more|(?:choose|pick|select) (?:any|all|several|multiple|more than one)|multiple choices?)\b/i;
/** A question's id at the end of its line. */
const SLUG_MARK = /\s*\{#([a-z][a-z0-9-]{2,39})\}\s*$/;
/** A slug as the rules define it. */
export const SLUG = /^[a-z][a-z0-9-]{2,39}$/;
/** A withdraw line: `[withdraw: slug, slug]` or `[withdraw: all]`, with an optional ` — reason` inside or after the brackets. */
const WITHDRAW = /^\s{0,3}\[withdraw:\s*([^\]]*?)\s*\](?:\s*(?:—|--)\s*(.*\S))?\s*$/i;
/** How many questions of a card the stepper takes at a time; the rest follow once these are settled. */
export const BATCH = 4;

/** Removes bold marks around the whole text, or one a line's own regular expression left at an end, so "**A) Yes**" reads "Yes". */
function unbold(text: string): string {
  const marks = text.match(/\*\*|__/g)?.length ?? 0;
  const wrapped = /^(\*\*|__)([^*_].*?)\1$/.exec(text);

  return wrapped !== null && marks === 2 ? wrapped[2]!.trim() : marks % 2 === 1 ? text.replace(/^(\*\*|__)|(\*\*|__)$/, '').trim() : text;
}

interface Block {
  number: number | null;
  slug: string | null;
  topic: string | null;
  text: string;
  context: string;
  options: QuestionOption[];
  /** The block's first and last lines in the Markdown: its question, or the line a lone run asks, to its last option or continuation. */
  first: number;
  last: number;
  /** The topic and text a missing slug is derived from, when they differ from the question's own. */
  basis?: { topic: string | null; text: string };
}

/** A backticked slug that leads a question line before a dash or colon, as "`port-choice` — Which port?" or "**`port-choice`:** Which port?". */
const TICK_SLUG = /^(?:\*\*|__)?`([a-z][a-z0-9-]{2,39})`(?:\*\*|__)?\s*(?:—|–|--|:)(?:\*\*|__)?\s+(\S.*)$/;

/**
 * A question line's text split into its id, its bold topic and the question. A backticked slug leading the line is left out of the question; a
 * slug derived for such a line comes from the whole line, as before the lead was recognized, so answers stored for it still match.
 */
function questionHead(raw: string): { slug: string | null; topic: string | null; text: string; basis?: { topic: string | null; text: string } } {
  let rest = raw;
  let slug: string | null = null;
  const mark = SLUG_MARK.exec(rest) ?? /\s*\{#([a-z][a-z0-9-]{2,39})\}\s*(\*\*|__)$/.exec(rest);

  if (mark !== null) {
    slug = mark[1]!;
    rest = (rest.slice(0, mark.index) + (mark[2] ?? '')).trimEnd();
  }

  const tick = TICK_SLUG.exec(rest);

  if (tick !== null) {
    const whole = headParts(slug, rest);

    return { ...headParts(slug, tick[2]!), ...(slug === null ? { basis: { topic: whole.topic, text: whole.text } } : {}) };
  }

  return headParts(slug, rest);
}

/** A question line's text, its id taken off, split into its bold topic and the question. */
function headParts(slug: string | null, rest: string): { slug: string | null; topic: string | null; text: string } {
  // A bold lead of one to four words ending in ".", ":" or "?", inside or just after the bold marks.
  const lead = /^(\*\*|__)([^*_\n]{1,60}?)([.:?])\1\s+(\S.*)$/.exec(rest) ?? /^(\*\*|__)([^*_\n]{1,60}?)\1([.:?])\s+(\S.*)$/.exec(rest);

  if (lead !== null && lead[2]!.trim().split(/\s+/).length <= 4) {
    return { slug, topic: `${lead[2]!.trim()}${lead[3] === '?' ? '?' : ''}`, text: unbold(lead[4]!.trim()) };
  }

  return { slug, topic: null, text: unbold(rest) };
}

/**
 * An option's text split into its label, a description after " — " or " -- ", or after "(recommended): ", and a "(recommended)" mark lifted
 * off the label.
 */
function optionParts(letter: string, raw: string): QuestionOption {
  const marked = /\s*(?:\*\*)?\(recommended\)(?:\*\*)?:(?:\*\*)?\s+/i.exec(raw);
  const dashed = /\s+(?:—|--)\s+/.exec(raw);

  if (marked !== null && (dashed === null || marked.index < dashed.index)) {
    const label = unbold(raw.slice(0, marked.index).trim());

    return { letter, label, description: raw.slice(marked.index + marked[0].length).trim(), recommended: true, text: label };
  }

  const dash = dashed;
  let label = (dash === null ? raw : raw.slice(0, dash.index)).trim();
  const description = dash === null ? '' : raw.slice(dash.index + dash[0].length).trim();
  const mark = /\s*\(recommended\)\s*$/i.exec(label) ?? /\s*\*\*\(recommended\)\*\*\s*$/i.exec(label);

  if (mark !== null) {
    label = label.slice(0, mark.index).trim();
  }

  label = unbold(label);

  return { letter, label, description, recommended: mark !== null, text: label };
}

/** Words a derived slug leaves out. */
const STOP = new Set(['a', 'an', 'the', 'or', 'and', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'it', 'its', 'is', 'are', 'be', 'do', 'does', 'should', 'would', 'could', 'can', 'will', 'i', 'we', 'you', 'your', 'my', 'me', 'this', 'that', 'which', 'what', 'how', 'when', 'where', 'who', 'why', 'as', 'so', 'if', 'with', 'only', 'after', 'before', 'than', 'then', 'there', 'these', 'those']);

/** A slug made from a question's topic or its first three significant words, as `register-persona-save`; "question" when it has none. */
export function deriveSlug(topic: string | null, text: string): string {
  const words = (source: string): string[] =>
    source
      .toLowerCase()
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== '' && !STOP.has(word));
  const picked = (topic === null ? [] : words(topic)).slice(0, 4);
  const chosen = picked.length > 0 ? picked : words(text).slice(0, 3);
  let slug = chosen.join('-').slice(0, 40).replace(/-+$/, '');

  if (!/^[a-z]/.test(slug)) {
    slug = `q-${slug}`.replace(/-+$/, '');
  }

  return slug.length >= 3 ? slug : 'question';
}

/**
 * The questions a reply's Markdown asks, outside fenced code: each numbered question followed by at least two options lettered from A in order,
 * or a lone unnumbered run of such options under the line that asks it. A numbered list item with no options is not a question. Indented lines
 * between a question and its first option are its context; indented lines under an option continue its description. Returns none when the shape
 * is ambiguous: a number used twice, or an unnumbered run beside other questions, whose answers could not be told apart. A slug the reply uses
 * twice gets the first of `-2`, `-3`, … on its later questions that no other question of the reply uses, within 40 characters.
 */
export function parseQuestions(markdown: string): Question[] {
  const blocks = parseBlocks(markdown);
  const bases = blocks.map(({ slug, topic, text, basis }) => slug ?? (basis === undefined ? deriveSlug(topic, text) : deriveSlug(basis.topic, basis.text)));
  // Each slug's first question keeps it, so a written `port-choice-2` is never taken by the second `port-choice`; a later one gets the first free suffix.
  const taken = new Set(bases);
  const first = new Set<string>();

  return blocks.map(({ number, slug, topic, text, context, options, multi }, index) => {
    const base = bases[index]!;
    let id = base;

    if (first.has(base)) {
      for (let count = 2; taken.has(id); count++) {
        id = withSuffix(base, count);
      }

      taken.add(id);
    }

    first.add(base);
    return { number, slug: id, written: slug !== null, topic, text, context, multi, options };
  });
}

/** A slug with `-<count>`, its base cut first so the whole stays within 40 characters. */
function withSuffix(base: string, count: number): string {
  const suffix = `-${count}`;

  return `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/**
 * The lines a card's questions take in the Markdown, from the first question, or the line a lone run asks, to the last option or its
 * continuation, as 0-based line indexes; null when it asks none. A view that draws the card can leave these lines out of the text.
 */
export function questionLines(markdown: string): { first: number; last: number } | null {
  const blocks = parseBlocks(markdown);

  return blocks.length === 0 ? null : { first: blocks[0]!.first, last: blocks.at(-1)!.last };
}

function parseBlocks(markdown: string): Array<Block & { multi: boolean }> {
  const blocks: Block[] = [];
  let open: Block | null = null;
  let last: QuestionOption | null = null;
  let previous = '';
  let previousAt = -1;
  let fence: string | null = null;

  const close = (): void => {
    if (open !== null && open.options.length >= 2) {
      blocks.push(open);
    }

    open = null;
    last = null;
  };

  for (const [at, line] of markdown.replace(/\r/g, '').split('\n').entries()) {
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
          previousAt = at;
          continue;
        }

        // A run of options with no numbered question above it asks the line before it.
        const asked = questionHead(previous.replace(/^\s*(?:[-*+]\s+|#{1,6}\s+)?/, '').trim());

        open = { number: null, ...asked, context: '', options: [], first: previousAt === -1 ? at : previousAt, last: at };
      }

      last = optionParts(letter, option[4]!);
      open!.options.push(last);
      open!.last = at;
      previous = line;
      previousAt = at;
      continue;
    }

    const question = QUESTION.exec(line);

    if (question !== null) {
      close();
      open = { number: Number(question[1]), ...questionHead(question[2]!), context: '', options: [], first: at, last: at };
      previous = line;
      previousAt = at;
      continue;
    }

    if (line.trim() === '') {
      continue;
    }

    // An indented line continues the option or the question above it; any other line ends the question.
    if (open !== null && /^\s/.test(line)) {
      const block: Block = open;
      const more = line.trim();

      if (last !== null) {
        const option: QuestionOption = last;

        option.description = option.description === '' ? more : `${option.description} ${more}`;
      } else {
        block.context = block.context === '' ? more : `${block.context} ${more}`;
      }

      block.last = at;
    } else {
      close();
    }

    previous = line;
    previousAt = at;
  }

  close();

  const numbered = blocks.map((block) => block.number).filter((number) => number !== null);

  if (blocks.length === 0 || new Set(numbered).size !== numbered.length || (numbered.length !== blocks.length && blocks.length > 1) || (blocks[0]!.number === null && blocks[0]!.text === '')) {
    return [];
  }

  return blocks.map((block) => ({ ...block, multi: MULTI.test(`${block.text} ${block.context}`) }));
}

/** A reply's `[withdraw: …]` lines, outside fenced code: the slugs each names, or `all`, and its reason, or null. */
export function withdrawals(markdown: string): Array<{ slugs: string[] | 'all'; reason: string | null }> {
  const found: Array<{ slugs: string[] | 'all'; reason: string | null }> = [];
  let fence: string | null = null;

  for (const line of markdown.replace(/\r/g, '').split('\n')) {
    const fenced = FENCE.exec(line);

    if (fence !== null) {
      fence = fenced !== null && fenced[1]!.startsWith(fence) ? null : fence;
      continue;
    }

    if (fenced !== null) {
      fence = fenced[1]!;
      continue;
    }

    const match = WITHDRAW.exec(line);

    if (match === null) {
      continue;
    }

    // A reason inside the brackets follows the slugs after a dash.
    const inside = /^(.*?)\s+(?:—|--)\s+(.*\S)$/.exec(match[1]!);
    const list = (inside === null ? match[1]! : inside[1]!).trim();
    const reason = (inside?.[2] ?? match[2] ?? '').trim();
    const slugs = list.split(/[,\s]+/).map((one) => one.trim().replace(/^\{?#/, '').replace(/\}$/, '').toLowerCase()).filter((one) => one !== '');

    if (slugs.length > 0) {
      found.push({ slugs: slugs.includes('all') ? 'all' : slugs, reason: reason === '' ? null : reason });
    }
  }

  return found;
}

/**
 * The Markdown as the views show it: without `[withdraw: …]` lines and the `{#slug}` ids that end question lines, which are for the view
 * and the session, not the operator. Code is left as it is.
 */
export function stripQuestionMarkup(markdown: string): string {
  let fence: string | null = null;
  const kept: string[] = [];
  const lines = markdown.replace(/\r/g, '').split('\n');
  const starts = new Set(parseBlocks(markdown).map((block) => block.first));

  for (const [at, line] of lines.entries()) {
    const fenced = FENCE.exec(line);

    if (fence !== null || fenced !== null) {
      fence = fence === null ? fenced![1]! : fenced !== null && fenced[1]!.startsWith(fence) ? null : fence;
      kept.push(line);
      continue;
    }

    if (WITHDRAW.test(line)) {
      continue;
    }

    kept.push((starts.has(at) ? withoutTickSlug(line) : line).replace(/\s*\{#[a-z][a-z0-9-]{2,39}\}(\s*(?:\*\*|__)?)\s*$/, '$1'));
  }

  return kept.join('\n');
}

/** A question's line without the backticked slug that leads it. */
function withoutTickSlug(line: string): string {
  const parts = /^(\s{0,3}(?:[-*+]\s+)?(?:(?:\*\*|__)?\d{1,2}[.)](?:\*\*|__)?\s+)?(?:#{1,6}\s+)?)(.*)$/.exec(line)!;
  const tick = TICK_SLUG.exec(parts[2]!);

  return tick === null ? line : `${parts[1]}${tick[2]}`;
}

/**
 * A reply's or a status's Markdown cut into runs of text and runs of questions, in order, for a view that draws the questions as a card: blocks
 * with only blank lines between them are one run, and `count` is how many questions a run asks. Null when it asks none.
 */
export function questionSegments(markdown: string): Array<{ questions: number; text: string }> | null {
  const blocks = parseBlocks(markdown);

  if (blocks.length === 0) {
    return null;
  }

  const lines = markdown.replace(/\r/g, '').split('\n');
  const runs: Array<{ first: number; last: number; count: number }> = [];

  for (const block of blocks) {
    const previous = runs.at(-1);

    if (previous !== undefined && lines.slice(previous.last + 1, block.first).every((line) => line.trim() === '')) {
      previous.last = block.last;
      previous.count++;
    } else {
      runs.push({ first: block.first, last: block.last, count: 1 });
    }
  }

  const segments: Array<{ questions: number; text: string }> = [];
  let at = 0;

  for (const run of runs) {
    if (run.first > at) {
      segments.push({ questions: 0, text: lines.slice(at, run.first).join('\n') });
    }

    segments.push({ questions: run.count, text: lines.slice(run.first, run.last + 1).join('\n') });
    at = run.last + 1;
  }

  if (at < lines.length) {
    segments.push({ questions: 0, text: lines.slice(at).join('\n') });
  }

  return segments;
}

/**
 * The Markdown without the run of questions that ends it, which the card alone shows (`questionSegments`); unchanged when no run ends it, as
 * questions written mid-message stay in the text, folded. Focused mode reads it to tell whether Show more would show anything the card does not.
 */
export function withoutEndingQuestions(markdown: string): string {
  const segments = questionSegments(markdown);

  if (segments === null) {
    return markdown;
  }

  const last = segments.reduce((found, segment, index) => (segment.questions > 0 ? index : found), -1);

  return segments.slice(last + 1).every((segment) => segment.text.trim() === '') ? segments.slice(0, last).map((segment) => segment.text).join('\n') : markdown;
}

/** What the operator chose for one question: the letters picked, and the text of its Other field. */
export interface QuestionChoice {
  letters: string[];
  other: string;
}

/**
 * The choices a message gave a card's questions, read loosely from its text: "1A", "1 A", "2A, 2C", "1A and 2B", an Other answer as
 * the legacy card wrote it, and a lone letter for a lone unnumbered question, so a card answered by typing shows what was picked as one answered
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

/** A conversation item as the legacy rules read it. */
export type CardItem =
  | { type: 'message'; withdrawn: boolean; delivery?: string | null; provisional?: boolean; at?: number }
  | { type: 'reply'; id: string; kind: 'reply' | 'aside' | 'note'; opening: string; rewrittenBy: string | null; withdrawn: boolean; at?: number };

/**
 * Whether a reply takes the place of the cards before it that no message has settled, so only the newest reply's card can be answered: a reply,
 * not an aside or a note, that a rewrite has not replaced, was not withdrawn and has text besides a status, as when a session says to ignore a
 * question it asked.
 */
export function supersedes(item: CardItem): boolean {
  return item.type === 'reply' && item.kind === 'reply' && !item.withdrawn && item.rewrittenBy === null && item.opening.trim() !== '';
}

/** Whether a conversation item answers the cards before it, for `cardLinks`: a message that is not withdrawn and has left the composer's queue. */
export function answers(item: CardItem): boolean {
  return item.type === 'message' && !item.withdrawn && item.delivery !== 'open';
}

/**
 * Whether a message after a card written at `askedAt` answers it (`answers`). A provisional message shows after everything in the transcript
 * however long ago it was queued, so one queued before the card, such as a notice an earlier run left queued, was not written as its answer.
 */
export function answersCard(item: CardItem, askedAt: number): boolean {
  return answers(item) && !(item.type === 'message' && item.provisional === true && item.at !== undefined && item.at < askedAt);
}

/** A conversation item as `cardLinks` reads it: a message with its text, or a reply with the text a card is drawn from. */
export type LinkItem =
  | { type: 'message'; id: string; text: string; withdrawn: boolean; delivery?: string | null; provisional?: boolean; at: number }
  | { type: 'reply'; id: string; kind: 'reply' | 'aside' | 'note'; opening: string; rewrittenBy: string | null; withdrawn: boolean; at: number };

/** How a card was left: answered or skipped by the message after it (`cardOutcome`), or superseded by a later reply (`supersedes`). */
export type CardState = 'answered' | 'skipped' | 'superseded';

/** One card: its questions, how it was left, null while it can be answered, and the message that answered or skipped it. */
export interface CardSettled {
  questions: Question[];
  outcome: CardState | null;
  message: { id: string; text: string } | null;
}

/** One question a message answered, as its reference line shows it: the question with its number, and the options or Other text chosen. */
export interface AnswerLine {
  question: string;
  answer: string;
}

/** The cards of a conversation (`cardLinks`). */
export interface CardLinks {
  /** Each card by key: `reply:<reply ID>`. */
  cards: Map<string, CardSettled>;
  /** For each message that answered cards, by message ID: each card's key with what the message chose for its questions, in card order. */
  answers: Map<string, Array<{ key: string; lines: AnswerLine[] }>>;
  /** The newest card that can still be answered, by key; null for none. */
  open: string | null;
}

/** What a message chose for each question of a card, as reference lines. */
export function answerLines(questions: readonly Question[], choices: ReadonlyMap<number, QuestionChoice>): AnswerLine[] {
  return questions.flatMap((question, index) => {
    const choice = choices.get(index);
    const picked = question.options.filter((option) => choice?.letters.includes(option.letter)).map((option) => `${option.letter}) ${plain(option.text)}`);
    const answer = [...picked, ...(choice === undefined || choice.other === '' ? [] : [`Other: ${choice.other}`])].join(', ');

    return answer === '' ? [] : [{ question: `${question.number === null ? '' : `${question.number}. `}${plain(question.text)}`, answer }];
  });
}

/**
 * The legacy rules, for cards asked before the cutover (design § 9): the question cards of a conversation in conversation order, and how each was left (PRD R103): each reply's, not an aside's or a note's nor
 * one a rewrite replaced or withdrawn; a status's questions get no card. The first message after a card that answers it (`answersCard`) settles
 * it, answered or skipped (`cardOutcome`); a later reply first (`supersedes`) leaves it superseded, so only the newest reply's card can be answered; the next message still answers it when it answers no
 * newer card but its questions, as one sent before that reply but read after it. Each message that answered cards links back to them.
 */
export function cardLinks(items: readonly LinkItem[]): CardLinks {
  const cards = new Map<string, CardSettled>();
  const answered = new Map<string, Array<{ key: string; lines: AnswerLine[] }>>();
  let waiting: Array<{ key: string; at: number }> = [];
  const ask = (key: string, markdown: string, at: number): void => {
    const questions = parseQuestions(markdown);

    if (questions.length > 0) {
      cards.set(key, { questions, outcome: null, message: null });
      waiting.push({ key, at });
    }
  };

  const settle = (message: Extract<LinkItem, { type: 'message' }>): void => {
    waiting = waiting.filter(({ key, at }) => {
      if (!answersCard(message, at)) {
        return true;
      }

      const card = cards.get(key)!;
      const choices = answersIn(message.text, card.questions);

      card.outcome = choices.size > 0 ? 'answered' : 'skipped';
      card.message = { id: message.id, text: message.text };

      if (choices.size > 0) {
        answered.set(message.id, [...(answered.get(message.id) ?? []), { key, lines: answerLines(card.questions, choices) }]);
      }

      return false;
    });
  };
  // The cards superseded since the last message: a message that still answers one, as one sent before the reply that superseded it but read
  // after it, is linked to it.
  let superseded: Array<{ key: string; at: number }> = [];

  for (const item of items) {
    if (item.type === 'reply') {
      if (supersedes(item)) {
        for (const one of waiting) {
          cards.get(one.key)!.outcome = 'superseded';
        }

        superseded = [...superseded, ...waiting];
        waiting = [];
      }

      if (item.kind === 'reply' && !item.withdrawn && item.rewrittenBy === null) {
        ask(`reply:${item.id}`, item.opening, item.at);
      }
    } else if (answers(item)) {
      settle(item);

      // Only cards this message could have answered (`answersCard`): a notice queued before a card neither answers it nor ends its chance.
      const eligible = superseded.filter(({ at }) => answersCard(item, at));
      const late = answered.has(item.id) ? undefined : [...eligible].reverse().find(({ key }) => answersIn(item.text, cards.get(key)!.questions).size > 0)?.key;

      if (late !== undefined) {
        const card = cards.get(late)!;
        const choices = answersIn(item.text, card.questions);

        card.outcome = 'answered';
        card.message = { id: item.id, text: item.text };
        answered.set(item.id, [{ key: late, lines: answerLines(card.questions, choices) }]);
      }

      superseded = superseded.filter((one) => !eligible.includes(one));
    }
  }

  return { cards, answers: answered, open: waiting.at(-1)?.key ?? null };
}

// ---- Answers (the [answers] message) ----

/** The tag that starts the answer message the hub writes; a Switchboard tag like `[spoken]` and `[voice]`. */
export const ANSWERS_TAG = '[answers]';

/** What a message gave one question, as the hub stores it on the message (`answers`): by the reply that asked it and its slug. */
export interface StoredAnswer {
  replyId: string;
  slug: string;
  letters: string[];
  other: string;
  via: 'card' | 'typed' | 'voice';
  /** The operator dismissed the question; the message tells the session so. */
  dismissed?: boolean;
}

/** One line of an answer message: the question, and the letters and Other text chosen, or that it was dismissed. */
export interface AnswerEntry {
  question: Question;
  letters: readonly string[];
  other: string;
  dismissed?: boolean;
}

/** Inline Markdown as plain text for an answer line: link text without its target, and no bold, italic or code marks. */
export function plain(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|[^\w*])\*(\S(?:.*?\S)?)\*(?!\w)/g, '$1$2')
    .trim();
}

/** What an entry answers, as its line ends: "A) Label; C) Label; Comment: text", "Comment: text" alone, or "No answer (dismissed)". */
export function answerSummary(question: Question, letters: readonly string[], other: string, dismissed = false): string {
  if (dismissed) {
    return 'No answer (dismissed)';
  }

  const picked = question.options.filter((option) => letters.includes(option.letter)).map((option) => `${option.letter}) ${plain(option.label)}`);
  const free = other.replace(/\s+/g, ' ').trim();

  return [...picked, ...(free === '' ? [] : [`Comment: ${free}`])].join('; ');
}

/** The request for several options at the end of a question, as "Select all that apply." or "(select all that apply)". */
const MULTI_ASK = /\s*\(?(?:select|choose|pick) (?:all|any) that apply[.!]?\)?[.]?\s*$/i;

/** A question's text as the card shows it: without a closing "Select all that apply.", which the card says in its own hint. */
export function withoutMultiAsk(question: Question): string {
  const text = question.multi ? question.text.replace(MULTI_ASK, '').trim() : question.text;

  return text === '' ? question.text : text;
}

/**
 * A question as the answered rows and the Answers bubble name it: its topic, or else its sentence that asks, without the context. Markdown,
 * as the question wrote it.
 */
export function questionBrief(question: Question): string {
  if (question.topic !== null) {
    return question.topic.replace(/[.:]$/, '');
  }

  const sentences = question.text.split(/(?<=[.?!])\s+(?=[A-Z0-9"'`*_(])/);

  return sentences.length < 2 ? question.text : (sentences.filter((one) => /\?["'`*_)]*$/.test(one)).at(-1) ?? question.text);
}

/** What an answer chose, as the answered rows and the Answers bubble show it: the chosen labels without their letters, then "Comment: text". */
export function answerBrief(question: Question, letters: readonly string[], other: string, dismissed = false): string {
  if (dismissed) {
    return 'No answer (dismissed)';
  }

  const picked = question.options.filter((option) => letters.includes(option.letter)).map((option) => plain(option.label));
  const free = other.replace(/\s+/g, ' ').trim();

  return [...picked, ...(free === '' ? [] : [`Comment: ${free}`])].join('; ');
}

/**
 * The message the hub writes for answers (design § 4): `[answers]`, then one line per question in the order given,
 * `- <slug>: <question as plain text> → <answer>`. Entries with no pick, no comment and no dismissal are left out; empty when none is left.
 */
export function answerMessage(entries: readonly AnswerEntry[]): string {
  const lines = entries.flatMap((entry) => {
    const answer = answerSummary(entry.question, entry.letters, entry.other, entry.dismissed === true);

    return answer === '' ? [] : [`- ${entry.question.slug}: ${plain(entry.question.text).replace(/\s+/g, ' ')} → ${answer}`];
  });

  return lines.length === 0 ? '' : [ANSWERS_TAG, ...lines].join('\n');
}

/** The tags Switchboard types before a message, which answers are read without. */
const LEAD_TAGS = /^\s*(?:\[(?:spoken|expressive|voice|partial)\][ \t]*)+/i;

/** An open question as `resolveAnswers` reads it. */
export interface OpenQuestion {
  replyId: string;
  question: Question;
}

/** A pick a message gave a question, before it is stored with its `via`. */
export type ResolvedAnswer = Omit<StoredAnswer, 'via'>;

const LETTER_WORDS: Record<string, string> = { a: 'A', ay: 'A', eh: 'A', b: 'B', be: 'B', bee: 'B', c: 'C', see: 'C', sea: 'C', d: 'D', dee: 'D' };

/** A lone letter answer, as "B", "b.", "option B" or "(c)"; null for anything else. */
function loneLetter(text: string): string | null {
  const match = /^(?:option\s+)?\(?([a-h])\)?\s*[.!]?$/i.exec(text.trim());

  return match === null ? null : match[1]!.toUpperCase();
}

/**
 * The questions a message answers (design § 4), read once when the hub stores it, against the questions open then (`open`, in ask order):
 * `[answers]` lines by slug, their comment after `Comment:` or the older `Other:`; `slug B`, `slug: B, C`, `slug comment: …` or `slug other: …`; a lone letter, "comment: …" or "other: …" for `current`, the open card's
 * current question, or the only open question; and legacy "1A", "2 Other: …" against the newest card's open questions only. Letters a question
 * does not offer are dropped; empty when it answers none.
 */
export function resolveAnswers(message: string, open: readonly OpenQuestion[], current: { replyId: string; slug: string } | null = null): ResolvedAnswer[] {
  const text = message.replace(LEAD_TAGS, '').replace(/\r/g, '').trim();
  const found = new Map<string, ResolvedAnswer>();
  const bySlug = (slug: string): OpenQuestion | undefined => [...open].reverse().find((one) => one.question.slug === slug.toLowerCase());
  const put = (one: OpenQuestion, letters: string[], other: string, dismissed = false): void => {
    const valid = letters.filter((letter, index) => one.question.options.some((option) => option.letter === letter) && letters.indexOf(letter) === index);
    const free = other.replace(/\s+/g, ' ').trim();

    if (valid.length > 0 || free !== '' || dismissed) {
      found.set(`${one.replyId}#${one.question.slug}`, { replyId: one.replyId, slug: one.question.slug, letters: one.question.multi ? valid : valid.slice(0, 1), other: free, ...(dismissed ? { dismissed: true } : {}) });
    }
  };

  if (open.length === 0 || text === '') {
    return [];
  }

  if (text.toLowerCase().startsWith(ANSWERS_TAG)) {
    for (const line of text.slice(ANSWERS_TAG.length).split('\n')) {
      const match = /^\s*-\s*([a-z][a-z0-9-]{2,39}):\s*(.*)$/i.exec(line);
      const one = match === null ? undefined : bySlug(match[1]!);

      if (one === undefined) {
        continue;
      }

      // The question's own text may hold an arrow, so the answer starts after it when the line repeats it.
      const rest = match![2]!;
      const asked = plain(one.question.text).replace(/\s+/g, ' ');
      const after = rest.startsWith(asked) ? rest.slice(asked.length) : rest;
      const arrow = after.indexOf('→');
      const answer = (arrow === -1 ? after : after.slice(arrow + 1)).trim();

      if (/^no answer \(dismissed\)$/i.test(answer)) {
        put(one, [], '', true);
        continue;
      }

      const otherAt = /(?:^|;\s*)(?:Comment|Other):\s*/i.exec(answer);
      const picks = otherAt === null ? answer : answer.slice(0, otherAt.index);
      const letters = [...picks.matchAll(/(?:^|;\s*)([A-H])\)/g)].map((pick) => pick[1]!);

      put(one, letters, otherAt === null ? '' : answer.slice(otherAt.index + otherAt[0].length));
    }

    return [...found.values()];
  }

  // "slug B", "slug: B, C", "slug comment: text" or "slug other: text", one per line or comma-separated on one line.
  const slugs = open.map((one) => one.question.slug).sort((a, b) => b.length - a.length);
  const escaped = slugs.map((slug) => slug.replace(/[-]/g, '\\-')).join('|');
  const named = new RegExp(`(?:^|[\\s,;(])(${escaped}):?\\s+(?:([Oo]ther|[Cc]omment):?\\s*([^\\n]*)|((?:[A-H]|[a-h](?=\\s*(?:$|[,.;!\\n])))(?:\\s*(?:,|and|&|\\+)\\s*(?:[A-H]|[a-h](?=\\s*(?:$|[,.;!\\n]))))*)(?![\\w-]))`, 'gm');

  for (const match of text.matchAll(named)) {
    const one = bySlug(match[1]!);

    if (one !== undefined) {
      put(one, match[4] === undefined ? [] : [...match[4].matchAll(/[a-h]/gi)].map((letter) => letter[0].toUpperCase()), match[2] === undefined ? '' : (match[3] ?? ''));
    }
  }

  if (found.size > 0) {
    return [...found.values()];
  }

  // A lone letter, "comment: …" or "other: …" answers the open card's current question, or the only open question.
  const target = (current === null ? undefined : open.find((one) => one.replyId === current.replyId && one.question.slug === current.slug)) ?? (open.length === 1 ? open[0] : undefined);
  const lone = loneLetter(text) ?? (/^[a-z]+$/i.test(text) ? (LETTER_WORDS[text.toLowerCase()] ?? null) : null);
  const otherOnly = /^(?:comment|other)\s*[:,-]\s*([\s\S]+)$/i.exec(text);

  if (target !== undefined && (lone !== null || otherOnly !== null)) {
    put(target, lone === null ? [] : [lone], otherOnly?.[1] ?? '');
    return [...found.values()];
  }

  // Legacy "1A, 2B" against the newest card's open questions only.
  const newest = open.at(-1)!.replyId;
  const card = open.filter((one) => one.replyId === newest);
  const legacy = answersIn(text, card.map((one) => one.question));

  for (const [index, choice] of legacy) {
    put(card[index]!, choice.letters, choice.other);
  }

  return [...found.values()];
}

// ---- The ledger: each question's state ----

/** How a question was left (design § 5.2); `skipped` and `superseded` only for cards asked before the cutover. */
export type QuestionState = 'open' | 'answered' | 'withdrawn' | 'replaced' | 'dismissed' | 'skipped' | 'superseded';

/** A conversation item as `questionLedger` reads it: a message with its text and stored answers, or a reply with the text a card is drawn from. */
export type LedgerItem =
  | { type: 'message'; id: string; text: string; withdrawn: boolean; delivery?: string | null; provisional?: boolean; at: number; answers?: StoredAnswer[] | null }
  | { type: 'reply'; id: string; kind: 'reply' | 'aside' | 'note'; opening: string; rewrittenBy: string | null; withdrawn: boolean; at: number };

/** One question of a card and how it stands. */
export interface LedgerQuestion {
  /** `reply:<reply ID>#<slug>`. */
  key: string;
  /** `reply:<reply ID>`. */
  card: string;
  replyId: string;
  question: Question;
  state: QuestionState;
  /** The message that answered or dismissed it, its picks, and whether that message is still being sent. */
  answer: { messageId: string; letters: string[]; other: string; via: StoredAnswer['via'] | 'legacy'; sending: boolean } | null;
  /** Why it was withdrawn, as the session wrote it, or what withdrew it. */
  reason: string | null;
  /** The question that replaced it, by key. */
  replacedBy: string | null;
}

/** A card: the reply that asks it, its questions in order, and whether it follows the rules from before the cutover. */
export interface LedgerCard {
  key: string;
  replyId: string;
  questions: LedgerQuestion[];
  legacy: boolean;
}

/**
 * A question whose reply retention deleted, kept with how it stood (`carriedQuestions`), so the ledger of the items after it starts from it:
 * `rewrittenBy` names the reply that rewrites its own, while that rewrite is not read yet.
 */
export type CarriedQuestion = LedgerQuestion & { rewrittenBy: string | null };

export interface QuestionLedger {
  cards: Map<string, LedgerCard>;
  questions: Map<string, LedgerQuestion>;
  /** The open questions' keys, in ask order. */
  open: string[];
  /** The questions each message answered or dismissed, by message ID, in the order it gave them. */
  answers: Map<string, LedgerQuestion[]>;
}

/**
 * What a conversation's oldest items leave for the items after them once retention deletes them (PRD R103): each question that is still open,
 * dismissed with no answer message telling the session yet (`untold`), or waiting for the rewrite of its reply, as `questionLedger` leaves it
 * over `carried` and these items. A dismissal made after one of these items applies after it, and one placed by its time, with no item or one
 * already deleted, applies before the first of them made after it, as over the whole conversation; one made after an item still kept
 * (`later`), or after all of these, is left for the items after. Cards asked before the cutover are not carried.
 */
export function carriedQuestions(
  items: readonly LedgerItem[],
  options: {
    since?: number;
    dismissed?: ReadonlyArray<{ key: string; at: number; after: string | null }>;
    carried?: readonly CarriedQuestion[];
    untold?: ReadonlySet<string>;
    later?: (id: string) => boolean;
  } = {},
): CarriedQuestion[] {
  const ids = new Set(items.map((item) => item.id));
  const dismissed = (options.dismissed ?? []).filter((one) => (one.after !== null && ids.has(one.after)) || one.after === null || options.later?.(one.after) !== true);
  const ledger = questionLedger(items, { ...(options.since === undefined ? {} : { since: options.since }), dismissed, carried: options.carried ?? [], continues: true });
  // A rewrite still to come, by the reply it rewrites.
  const rewrites = new Map<string, string>();

  for (const was of options.carried ?? []) {
    if (was.rewrittenBy !== null && !ids.has(was.rewrittenBy)) {
      rewrites.set(was.replyId, was.rewrittenBy);
    }
  }

  for (const item of items) {
    if (item.type === 'reply' && item.rewrittenBy !== null && !ids.has(item.rewrittenBy)) {
      rewrites.set(item.id, item.rewrittenBy);
    }
  }

  return [...ledger.cards.values()]
    .filter((card) => !card.legacy)
    .flatMap((card) => card.questions)
    .map((one) => ({ ...one, rewrittenBy: rewrites.get(one.replyId) ?? null }))
    .filter((one) => one.state === 'open' || (one.state === 'dismissed' && options.untold?.has(one.key) === true) || one.rewrittenBy !== null);
}

/** The key of a reply's question. */
export const questionKey = (replyId: string, slug: string): string => `reply:${replyId}#${slug}`;

/** Whether a message counts for questions: not withdrawn, and not one that was never sent or that the transcript does not show, whose questions are answered again on their card. */
function counts(item: Extract<LedgerItem, { type: 'message' }>): boolean {
  return !item.withdrawn && item.delivery !== 'not-sent' && item.delivery !== 'refused' && item.delivery !== 'unconfirmed';
}

/**
 * Each question of a conversation and its state (design § 5.2), from its items in conversation order. A reply asks its questions open; a later
 * reply's `[withdraw: …]` withdraws them, its question with the same slug replaces an open one, and a `[rewrite]` reply carries over the
 * questions of the reply it rewrites that it asks again, as they stood, and withdraws the rest. A message answers questions by the links stored
 * on it, or, for one stored without them, by its text against the questions open at that point (`resolveAnswers`). A message that answers
 * nothing changes nothing. `dismissed` holds the keys the operator dismissed. Replies before `since`, the cutover, keep the rules from before
 * it: the first message after a card answers or skips it, and a later reply supersedes it (`cardLinks`).
 */
export function questionLedger(
  items: readonly LedgerItem[],
  options: { since?: number; dismissed?: Iterable<string | { key: string; at: number; after?: string | null }>; carried?: readonly CarriedQuestion[]; continues?: boolean } = {},
): QuestionLedger {
  const since = options.since ?? Number.NEGATIVE_INFINITY;
  const cards = new Map<string, LedgerCard>();
  const questions = new Map<string, LedgerQuestion>();
  const answers = new Map<string, LedgerQuestion[]>();
  const open: LedgerQuestion[] = [];
  const close = (one: LedgerQuestion): void => {
    const at = open.indexOf(one);

    if (at !== -1) {
      open.splice(at, 1);
    }
  };
  const answer = (one: LedgerQuestion, message: Extract<LedgerItem, { type: 'message' }>, given: ResolvedAnswer, via: StoredAnswer['via'] | 'legacy'): void => {
    one.state = given.dismissed === true ? 'dismissed' : 'answered';
    one.answer = { messageId: message.id, letters: given.letters, other: given.other, via, sending: message.delivery === 'open' };
    close(one);
    answers.set(message.id, [...(answers.get(message.id) ?? []), one]);
  };
  // The operator's dismissals, each applied right after the item that was newest when it was made, or else by its time, so a later reply cannot
  // turn one into another state; a dismissal with neither applies at the end.
  const dismissals = [...(options.dismissed ?? [])].map((one) => (typeof one === 'string' ? { key: one, at: Number.POSITIVE_INFINITY, after: null } : { after: null, ...one })).sort((a, b) => a.at - b.at);
  const placed = new Set(items.map((item) => item.id));
  const dismissAfter = (id: string): void => {
    for (const dismissal of dismissals.filter((one) => one.after === id)) {
      const one = questions.get(dismissal.key);

      dismissals.splice(dismissals.indexOf(dismissal), 1);

      if (one !== undefined && one.state === 'open') {
        one.state = 'dismissed';
        close(one);
      }
    }
  };
  const dismissedKeys = new Set(dismissals.map((one) => one.key));
  const dismissUpTo = (at: number): void => {
    for (const dismissal of dismissals.filter((one) => ((one.after === null || !placed.has(one.after)) && one.at < at) || at === Number.POSITIVE_INFINITY)) {
      const one = questions.get(dismissal.key);

      // One whose question is not asked yet, as when it was made as the reply was read, waits for it.
      if (one === undefined && at !== Number.POSITIVE_INFINITY) {
        continue;
      }

      dismissals.splice(dismissals.indexOf(dismissal), 1);

      if (one !== undefined && one.state === 'open') {
        one.state = 'dismissed';
        close(one);
      }
    }
  };
  // The questions of a reply a later rewrite replaced, by the rewrite's ID.
  const rewritten = new Map<string, LedgerQuestion[]>();
  const legacyItems: LinkItem[] = [];

  // Carried questions come before every item, as they stood when their replies were deleted.
  for (const { rewrittenBy, ...was } of options.carried ?? []) {
    const one: LedgerQuestion = { ...was, answer: was.answer === null ? null : { ...was.answer } };
    const card = cards.get(one.card) ?? { key: one.card, replyId: one.replyId, questions: [], legacy: false };

    card.questions.push(one);
    cards.set(card.key, card);
    questions.set(one.key, one);

    if (one.state === 'open') {
      open.push(one);
    }

    if (rewrittenBy !== null) {
      rewritten.set(rewrittenBy, [...(rewritten.get(rewrittenBy) ?? []), one]);
    }
  }

  let previous: string | null = null;

  for (const item of items) {
    if (previous !== null) {
      dismissAfter(previous);
    }

    previous = item.id;
    dismissUpTo(item.at);

    if (item.type === 'message') {
      legacyItems.push(item);

      if (!counts(item) || open.length === 0) {
        continue;
      }

      if (item.answers != null) {
        for (const given of item.answers) {
          const one = questions.get(questionKey(given.replyId, given.slug));

          // A stored link wins over the state the text would give; a question already answered keeps its first answer.
          if (one !== undefined && (one.state === 'open' || one.state === 'replaced' || one.state === 'withdrawn')) {
            answer(one, item, given, given.via);
          }
        }
      } else {
        const resolved = resolveAnswers(item.text, open.map((one) => ({ replyId: one.replyId, question: one.question })));

        for (const given of resolved) {
          answer(questions.get(questionKey(given.replyId, given.slug))!, item, given, 'typed');
        }
      }

      continue;
    }

    legacyItems.push(item);

    if (item.kind !== 'reply' || item.withdrawn || item.at < since) {
      continue;
    }

    for (const withdrawal of withdrawals(item.opening)) {
      for (const one of [...open]) {
        if (withdrawal.slugs === 'all' || withdrawal.slugs.includes(one.question.slug)) {
          one.state = 'withdrawn';
          one.reason = withdrawal.reason;
          close(one);
        }
      }
    }

    const asked = parseQuestions(item.opening);
    const card: LedgerCard = { key: `reply:${item.id}`, replyId: item.id, questions: [], legacy: false };
    const carried = rewritten.get(item.id) ?? [];

    rewritten.delete(item.id);

    for (const question of asked) {
      const key = questionKey(item.id, question.slug);
      const one: LedgerQuestion = { key, card: card.key, replyId: item.id, question, state: 'open', answer: null, reason: null, replacedBy: null };
      const earlier = carried.find((was) => was.question.slug === question.slug);

      card.questions.push(one);
      questions.set(key, one);

      // A rewrite keeps the state the question had in the reply it rewrote.
      if (earlier !== undefined && earlier.state !== 'open' && earlier.state !== 'replaced') {
        one.state = earlier.state;
        one.answer = earlier.answer;
        one.reason = earlier.reason;
        continue;
      }

      for (const was of open.filter((other) => other.question.slug === question.slug)) {
        was.state = 'replaced';
        was.replacedBy = key;
        close(was);
      }

      open.push(one);
    }

    for (const was of carried) {
      if (was.state === 'open') {
        was.state = 'withdrawn';
        was.reason = 'The reply that asked it was rewritten.';
        close(was);
      }
    }

    if (card.questions.length > 0) {
      cards.set(card.key, card);
    }

    if (item.rewrittenBy !== null) {
      rewritten.set(item.rewrittenBy, card.questions);
    }
  }

  if (previous !== null) {
    dismissAfter(previous);
  }

  // More items follow these (`continues`): a dismissal still waiting is theirs to place.
  if (options.continues !== true) {
    dismissUpTo(Number.POSITIVE_INFINITY);
  }

  // Replies before the cutover: their cards as `cardLinks` leaves them, each question taking its card's state.
  if (since !== Number.NEGATIVE_INFINITY) {
    // Every item takes part, since a later reply supersedes an old card; only the cards asked before the cutover are taken from it.
    const legacy = cardLinks(legacyItems);
    const askedAt = new Map(items.map((item) => [item.id, item.at]));

    for (const [key, settled] of legacy.cards) {
      const replyId = key.slice('reply:'.length);

      if ((askedAt.get(replyId) ?? since) >= since) {
        continue;
      }
      const choices = settled.outcome === 'answered' ? answersIn(settled.message!.text, settled.questions) : new Map<number, QuestionChoice>();
      const card: LedgerCard = {
        key,
        replyId,
        legacy: true,
        questions: settled.questions.map((question, index) => {
          const choice = choices.get(index);

          return {
            key: questionKey(replyId, question.slug),
            card: key,
            replyId,
            question,
            state: settled.outcome ?? 'open',
            answer: settled.outcome === 'answered' ? { messageId: settled.message!.id, letters: choice?.letters ?? [], other: choice?.other ?? '', via: 'legacy' as const, sending: false } : null,
            reason: null,
            replacedBy: null,
          };
        }),
      };

      cards.set(key, card);

      for (const one of card.questions) {
        questions.set(one.key, one);

        if (one.state === 'answered' && choices.size > 0 && one.answer !== null && (one.answer.letters.length > 0 || one.answer.other !== '')) {
          answers.set(one.answer.messageId, [...(answers.get(one.answer.messageId) ?? []), one]);
        }
      }

      if (key === legacy.open && !card.questions.some((one) => dismissedKeys.has(one.key))) {
        open.unshift(...card.questions);
      } else if (key === legacy.open) {
        for (const one of card.questions) {
          one.state = 'dismissed';
        }
      }
    }
  }

  // Cards in conversation order.
  const order = new Map(items.map((item, index) => [item.id, index]));
  const sorted = new Map([...cards].sort(([, a], [, b]) => (order.get(a.replyId) ?? 0) - (order.get(b.replyId) ?? 0)));
  const openSorted = open.sort((a, b) => (order.get(a.replyId) ?? 0) - (order.get(b.replyId) ?? 0));

  return { cards: sorted, questions, open: openSorted.map((one) => one.key), answers };
}

// ---- The card's draft: where the operator is in a card, kept by the hub ----

/** What the operator picked for a question so far: the letters, and the comment, null or empty for none. */
export interface CardPick {
  letters: string[];
  /** The comment, beside the letters or alone; named `other` in drafts, `send` bodies and stored answers since it began as an Other answer. */
  other: string | null;
}

/** A card's draft (design § 5.2): the question it shows, by slug, and the picks so far by slug. */
export interface CardDraft {
  step: string | null;
  picks: Record<string, CardPick>;
}

/** Whether a pick answers its question: a letter, a comment, or both. */
export const picked = (pick: CardPick | undefined): boolean => pick !== undefined && (pick.letters.length > 0 || (pick.other ?? '').trim() !== '');

/** The questions a card's stepper shows: its open questions, the first `BATCH` of them. */
export function cardSteps(card: LedgerCard): LedgerQuestion[] {
  return card.questions.filter((one) => one.state === 'open').slice(0, BATCH);
}

/** How many open questions wait after the stepper's batch. */
export function cardLater(card: LedgerCard): number {
  return Math.max(0, card.questions.filter((one) => one.state === 'open').length - BATCH);
}

/** The question the card shows: the draft's step while it is open, else the first open question with no pick, else the first. */
export function currentStep(card: LedgerCard, draft: CardDraft | undefined): LedgerQuestion | null {
  const steps = cardSteps(card);

  return steps.find((one) => one.question.slug === draft?.step) ?? steps.find((one) => !picked(draft?.picks[one.question.slug])) ?? steps[0] ?? null;
}

/**
 * A draft after a letter is picked, keeping the comment: a multi-choice question toggles the letter; a single-choice question takes it, or
 * drops it when it was already picked and `toggle` is on, as a click on the picked option does, so a comment can stand alone.
 */
export function pickLetter(card: LedgerCard, draft: CardDraft | undefined, slug: string, letter: string, toggle = true): CardDraft {
  const one = cardSteps(card).find((step) => step.question.slug === slug);
  const base: CardDraft = { step: slug, picks: { ...(draft?.picks ?? {}) } };

  if (one === undefined || !one.question.options.some((option) => option.letter === letter)) {
    return draft ?? base;
  }

  const pick = base.picks[slug] ?? { letters: [], other: null };
  const had = pick.letters.includes(letter);

  base.picks[slug] = {
    ...pick,
    letters: one.question.multi ? (had ? pick.letters.filter((one) => one !== letter) : [...pick.letters, letter].sort()) : had && toggle ? [] : [letter],
  };

  return base;
}

/** A draft with a question's comment set, keeping its letters. */
export function setComment(card: LedgerCard, draft: CardDraft | undefined, slug: string, text: string): CardDraft {
  const pick = draft?.picks[slug] ?? { letters: [], other: null };

  return { step: slug, picks: { ...(draft?.picks ?? {}), [slug]: { letters: pick.letters, other: text } } };
}

/** A draft moved to the step before or after the current one, or to a step by slug; unchanged at either end. */
export function moveStep(card: LedgerCard, draft: CardDraft | undefined, to: 'back' | 'next' | string): CardDraft {
  const steps = cardSteps(card);
  const at = Math.max(0, steps.indexOf(currentStep(card, draft)!));
  const target = to === 'back' ? steps[Math.max(0, at - 1)] : to === 'next' ? steps[Math.min(steps.length - 1, at + 1)] : steps.find((one) => one.question.slug === to);

  return { step: target?.question.slug ?? draft?.step ?? null, picks: { ...(draft?.picks ?? {}) } };
}

/** The questions the card's Send answers: the stepper's questions with a pick, in order. */
export function draftAnswers(card: LedgerCard, draft: CardDraft | undefined): Array<{ one: LedgerQuestion; pick: CardPick }> {
  return cardSteps(card).flatMap((one) => {
    const pick = draft?.picks[one.question.slug];

    return picked(pick) ? [{ one, pick: pick! }] : [];
  });
}

/** Send's label: "Send answer" for one question, "Send 3 answers" when all are answered, "Send 2 of 3" when some are left open. */
export function sendLabel(answered: number, total: number): string {
  return total <= 1 ? 'Send answer' : answered >= total ? `Send ${total} answers` : `Send ${answered} of ${total}`;
}

// ---- Voice ----

/** The words a spoken number reads as. */
const SPOKEN_COUNT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

/**
 * A question read aloud (design § 7): its place, topic, text and context, "Select all that apply." for a multi-choice question that does not say
 * so, each option with its letter, label, a recommendation and its description, and how to comment. Plain text, without the slug or Markdown.
 */
export function questionSpeech(question: Question, step: number, total: number): string {
  const sentence = (text: string): string => {
    const clean = plain(text).replace(/\s+/g, ' ').trim();

    return clean === '' ? '' : /[.?!:]$/.test(clean) ? clean : `${clean}.`;
  };
  const parts = [
    total > 1 ? `Question ${step} of ${total}.` : '',
    question.topic === null ? '' : sentence(question.topic.replace(/[?:.]$/, '')),
    sentence(question.text),
    sentence(question.context),
    question.multi && withoutMultiAsk(question) === question.text ? 'Select all that apply.' : '',
    ...question.options.map((option) => {
      const label = plain(option.label);
      const description = plain(option.description);

      return `${option.letter}: ${label}${option.recommended ? ', recommended' : ''}${description === '' ? '.' : `: ${sentence(description)}`}`;
    }),
    'Or say Comment and your words.',
  ];

  return parts.filter((part) => part !== '').join(' ');
}

/** What an utterance does to the open card (design § 7), or null when it is ordinary dictation. */
export type CardUtterance = { type: 'pick'; letter: string } | { type: 'pick-index'; index: number } | { type: 'recommended' } | { type: 'comment'; text: string } | { type: 'back' } | { type: 'next' } | { type: 'repeat' } | { type: 'send' };

const ORDINALS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, '1st': 0, '2nd': 1, '3rd': 2, '4th': 3 };

/**
 * The card grammar for a whole utterance (design § 7): a letter, with the recogniser's homophones ("ay", "bee", "see", "dee"), "option B",
 * "B please", "the first one", "the recommended one"; "comment, …", or the older "other, …", with its text; "back", "next" or "skip", "repeat", "send". Null for anything else.
 */
export function cardUtterance(utterance: string): CardUtterance | null {
  const text = utterance
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const comment = /^(?:comment|other)\b[\s,:.-]*(.*)$/i.exec(utterance.trim().replace(/\s+/g, ' '));

  if (comment !== null) {
    return { type: 'comment', text: comment[1]!.replace(/[.!?]+$/, '').trim() };
  }

  const words = text.replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();

  if (/^(?:go )?back$/.test(words)) {
    return { type: 'back' };
  }

  if (/^(?:next|skip|skip it|next question)$/.test(words)) {
    return { type: 'next' };
  }

  if (/^(?:repeat|repeat that|say (?:it|that) again|again)$/.test(words)) {
    return { type: 'repeat' };
  }

  if (/^(?:send|send (?:it|them|the answers?|answers?))$/.test(words)) {
    return { type: 'send' };
  }

  if (/^(?:the )?recommended(?: one| option)?(?: please)?$/.test(words)) {
    return { type: 'recommended' };
  }

  const ordinal = /^(?:the )?(first|second|third|fourth|1st|2nd|3rd|4th)(?: one| option)?(?: please)?$/.exec(words);

  if (ordinal !== null) {
    return { type: 'pick-index', index: ORDINALS[ordinal[1]!]! };
  }

  const letter = /^(?:option |letter |answer )?([a-z]+)(?: please)?$/.exec(words);
  const picked = letter === null ? undefined : LETTER_WORDS[letter[1]!];

  return picked === undefined ? null : { type: 'pick', letter: picked };
}
