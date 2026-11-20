/**
 * The tags a reply can carry (architecture.md § Conversation), from claude-collab's `screen-reader.js`, `rewrite.js`, `status.js` and `tts.js`. The screen
 * draws inline code without its backticks, so the screen reader puts them back (`lineText`), and a quoted tag such as "the `[rewrite]` rule"
 * is never the tag.
 */

/**
 * An aside: text Claude wrote only because the harness demanded visible output, shown dimmed. Tagged `[aside]` at the very start of the reply,
 * after any rewrite tag; returns the text without the tag.
 */
export function stripAside(raw: string): { aside: boolean; text: string } {
  const trimmed = raw.trimStart();
  const head = /^(?:\[rewrite\]\s*)?/i.exec(trimmed)![0];
  const lead = /^\[aside\][ \t]*/i.exec(trimmed.slice(head.length));

  return lead === null ? { aside: false, text: raw.trim() } : { aside: true, text: (head + trimmed.slice(head.length + lead[0].length)).trim() };
}

const REWRITE = /^\s*\[rewrite\](?=\s|$)/i;

/** A line that is only the rewrite tag, kept apart when the screen's wrapped lines are joined. */
export const isRewriteLine = (line: string): boolean => /^ {0,3}\[rewrite\][ \t]*$/i.test(line);

/** Whether the text opens with the rewrite tag, and the text without it. */
export function splitRewrite(text: string): { rewrite: boolean; text: string } {
  const match = REWRITE.exec(text);

  return match === null ? { rewrite: false, text } : { rewrite: true, text: text.slice(match[0].length).trim() };
}

/** The `[status]` line: up to three spaces in, since four or more make an indented code block. */
const STATUS_LINE = /^ {0,3}\[status\][ \t]*$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A line that is only the status tag, kept apart when the screen's wrapped lines are joined. */
export const isStatusLine = (line: string): boolean => STATUS_LINE.test(line);

/**
 * Splits a reply's text at its first `[status]` line outside fenced code, from claude-collab's `status.js`: the text before it is the reply, the
 * text after it, to the end, the status, or null when it is empty. A tag quoted inline or in a code block is text.
 */
export function splitStatus(text: string): { reply: string; status: string | null } {
  const lines = text.split('\n');
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const open = FENCE.exec(line);

    if (open !== null) {
      if (fence === null) {
        fence = open[1]!;
      } else if (open[1]![0] === fence[0] && open[1]!.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
        fence = null;
      }

      continue;
    }

    if (fence === null && STATUS_LINE.test(line)) {
      return { reply: lines.slice(0, index).join('\n').trim(), status: lines.slice(index + 1).join('\n').trim() || null };
    }
  }

  return { reply: text, status: null };
}

/** A tone line: `[tone: …]` alone on the reply's first line, how the whole reply sounds when spoken (claude-collab `tts.js` `splitTone`). */
const TONE_LINE = /^\s*\[tone:([^[\]\n]*)\][ \t]*(?:\n|$)/i;
/** Only this much of a tone line counts. */
export const TONE_MAX = 120;

/** The tone line's text, quotes and backslashes removed and cut to `TONE_MAX`, or null with none; and the text without it. */
export function splitTone(text: string): { tone: string | null; text: string } {
  const match = TONE_LINE.exec(text);

  if (match === null) {
    return { tone: null, text };
  }

  const tone = match[1]!.replace(/["\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, TONE_MAX).trim();

  return { tone: tone === '' ? null : tone, text: text.slice(match[0].length) };
}

/** A `[speak]` or `[/speak]` marker. */
const SPEAK_MARK = /\[(\/?)speak\]/gi;

/** The ranges of fenced code blocks and inline code spans, where a marker is only text. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let fence: { start: number; mark: string } | null = null;
  let at = 0;

  for (const line of text.split('\n')) {
    const end = at + line.length;
    const open = FENCE.exec(line);

    if (fence !== null) {
      if (open !== null && open[1]![0] === fence.mark[0] && open[1]!.length >= fence.mark.length && /^ {0,3}[`~]+\s*$/.test(line)) {
        ranges.push([fence.start, end]);
        fence = null;
      }
    } else if (open !== null) {
      fence = { start: at, mark: open[1]! };
    } else {
      for (const span of line.matchAll(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) {
        ranges.push([at + span.index, at + span.index + span[0].length]);
      }
    }

    at = end + 1;
  }

  if (fence !== null) {
    ranges.push([fence.start, text.length]);
  }

  return ranges;
}

/**
 * The passage Claude marked to be read aloud, `[speak]`…`[/speak]` (voice-design decision 21), and the text with every marker removed, a
 * marker alone on its line with its line. Several passages are joined; a `[speak]` with no `[/speak]` after it marks nothing. A marker in
 * inline code or a fenced code block, such as "the `[speak]` rule", is text, and a text with no marker is returned as it is.
 */
export function splitSpeak(text: string): { speak: string | null; text: string } {
  const code = codeRanges(text);
  const marks = [...text.matchAll(SPEAK_MARK)].filter((mark) => !code.some(([start, end]) => mark.index >= start && mark.index < end));

  if (marks.length === 0) {
    return { speak: null, text };
  }

  const passages: string[] = [];
  let open: number | null = null;

  for (const mark of marks) {
    if (mark[1] === '') {
      open ??= mark.index + mark[0].length;
    } else if (open !== null) {
      passages.push(text.slice(open, mark.index).trim());
      open = null;
    }
  }

  // Removed from the end, so earlier positions hold; a marker alone on its line goes with its line break.
  let without = text;

  for (const mark of [...marks].reverse()) {
    const lineStart = without.lastIndexOf('\n', mark.index - 1) + 1;
    const lineEnd = without.indexOf('\n', mark.index + mark[0].length);
    const end = lineEnd === -1 ? without.length : lineEnd;
    const alone = without.slice(lineStart, mark.index).trim() === '' && without.slice(mark.index + mark[0].length, end).trim() === '';

    without = alone ? without.slice(0, lineStart) + without.slice(lineEnd === -1 ? end : end + 1) : without.slice(0, mark.index) + without.slice(mark.index + mark[0].length);
  }

  const speak = passages.filter((passage) => passage !== '').join(' ');

  return { speak: speak === '' ? null : speak, text: without.trim() };
}

/**
 * A passage as the voice reads it: its Markdown's marks dropped, a link's text kept, its lines joined; the words themselves are left as Claude
 * wrote them (voice-design decision 22).
 */
export function spokenText(passage: string): string {
  return passage
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__|\*|~~)/g, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A reply's parts: an aside or a reply, whether it rewrites the previous reply, its text without the tags, and the status it carries. */
export interface ParsedReply {
  kind: 'reply' | 'aside';
  rewrite: boolean;
  /** Empty for a reply that is only a status. */
  opening: string;
  status: string | null;
  /** The `[speak]` passage, whose markers `opening` leaves out; null with none. */
  speak: string | null;
  /** The tone line, which `opening` leaves out; null with none. */
  tone: string | null;
  /** The heard tags, which `opening` leaves out, in order (architecture.md § Dictation). */
  heard: HeardTag[];
}

/** A heard tag, `<!--heard:X=Y-->`: the recogniser heard X where the operator meant the term Y. */
export interface HeardTag {
  heard: string;
  meant: string;
}

/** A heard tag; each side at most 100 characters, as a term is short. */
const HEARD_TAG = /<!--\s*heard:\s*([^=\n]{1,100}?)\s*=\s*([^\n]{1,100}?)\s*-->/gi;

/**
 * The heard tags of a text (architecture.md § Dictation), and the text without them, a tag alone on its line with its line. A tag in inline code
 * or a fenced code block, as when a reply explains the rule, is text and counts for nothing.
 */
export function splitHeard(text: string): { heard: HeardTag[]; text: string } {
  const code = codeRanges(text);
  const tags = [...text.matchAll(HEARD_TAG)].filter((tag) => !code.some(([start, end]) => tag.index >= start && tag.index < end));

  if (tags.length === 0) {
    return { heard: [], text };
  }

  let without = text;

  for (const tag of [...tags].reverse()) {
    const lineStart = without.lastIndexOf('\n', tag.index - 1) + 1;
    const lineEnd = without.indexOf('\n', tag.index + tag[0].length);
    const end = lineEnd === -1 ? without.length : lineEnd;
    const alone = without.slice(lineStart, tag.index).trim() === '' && without.slice(tag.index + tag[0].length, end).trim() === '';

    without = alone ? without.slice(0, lineStart) + without.slice(lineEnd === -1 ? end : end + 1) : without.slice(0, tag.index).replace(/[ \t]+$/, '') + without.slice(tag.index + tag[0].length);
  }

  return { heard: tags.map((tag) => ({ heard: tag[1]!.trim(), meant: tag[2]!.trim() })).filter((tag) => tag.heard !== '' && tag.meant !== ''), text: without.trim() };
}

/** Splits a reply's text into its parts. Every session is read as if it carries the current conversation rules. */
export function parseReply(text: string): ParsedReply {
  const { reply, status } = splitStatus(text);
  const { aside, text: unaside } = stripAside(reply);
  // The tone line is the reply's first line, before or after a rewrite tag.
  const before = splitTone(unaside);
  const { rewrite, text: rewritten } = splitRewrite(before.text);
  const after = before.tone === null ? splitTone(rewritten) : { tone: null, text: rewritten };
  const { heard, text: unheard } = splitHeard(after.text);
  const { speak, text: body } = splitSpeak(unheard);

  return { kind: aside ? 'aside' : 'reply', rewrite: rewrite && !aside, opening: body.trim(), status, speak, tone: before.tone ?? after.tone, heard };
}

/**
 * The tags Switchboard puts before a message it types (architecture.md § Voice, § Dictation): its reply will be heard and read expressively, it
 * was dictated, and it is a part of a message still being spoken.
 */
const MESSAGE_TAGS = /^\s*(?:\[(?:spoken|expressive|voice|partial)\][ \t]*)+/i;

/** A message's text without the tags Switchboard typed before it. */
export function stripMessageTags(text: string): string {
  return text.replace(MESSAGE_TAGS, '').trim();
}

/**
 * The tags Switchboard types before a message: `[spoken]` when its reply will be heard, with `[expressive]` while `voice.expressive` is on, then
 * `[voice]` for a dictated message and `[voice] [partial]` for a part of one still being spoken (architecture.md § Dictation).
 */
export function messageTags(spoken: boolean, expressive: boolean, dictated: 'voice' | 'partial' | null = null): string {
  const reply = spoken ? (expressive ? '[spoken] [expressive] ' : '[spoken] ') : '';

  return reply + (dictated === 'voice' ? '[voice] ' : dictated === 'partial' ? '[voice] [partial] ' : '');
}

/**
 * Letters and digits only, by which a screen copy and a transcript copy of one reply compare: the screen shows Markdown rendered, with no
 * backticks or asterisks and links as their text, the transcript raw.
 */
export const squash = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** A reply with no letters or digits, such as "👍", is keyed by its text without comments, spaces or ASCII punctuation instead. */
const bareOf = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, '').replace(/[\s!-/:-@[-`{-~]+/g, '');

/** The key a reply's copies share; the rewrite tag does not count, so "[rewrite] 👍" and "[rewrite] 👎" differ. */
export function keyOf(text: string): string {
  const body = splitRewrite(text).text;

  return squash(body) || bareOf(body);
}

const TAG_WORDS = ['aside', 'rewrite', 'status', 'speak', '/speak', 'tone'];

/**
 * Whether the text's last line ends in a tag or an HTML comment still being drawn, such as "Done. <!--as" or "[asi": read now, it would be
 * published and then again under another key once the tag is complete.
 */
export function endsInOpenTag(text: string): boolean {
  const last = text.trimEnd().split('\n').at(-1) ?? '';
  const open = /(?:^|\s)\[([a-z]*)$/i.exec(last) ?? /\[(\/[a-z]*)$/i.exec(last);

  if (open !== null && TAG_WORDS.some((word) => word.startsWith(open[1]!.toLowerCase()))) {
    return true;
  }

  const comment = last.lastIndexOf('<!--');

  return (comment !== -1 && !last.includes('-->', comment + 4)) || /<!?-?$/.test(last);
}
