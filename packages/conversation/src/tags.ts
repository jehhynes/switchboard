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

/** The `[state]` line, or `[status]`, which earlier sessions write: up to three spaces in, since four or more make an indented code block. */
const STATE_LINE = /^ {0,3}\[(?:state|status)\][ \t]*$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A line that is only the state tag, kept apart when the screen's wrapped lines are joined. */
export const isStateLine = (line: string): boolean => STATE_LINE.test(line);

/** A state a reply carries (architecture.md § States): its headline, for the list row, and its Markdown body, or null. */
export interface ReplyState {
  headline: string;
  body: string | null;
}

/** Markdown marks at the start of a headline line, which the row would show as text: a heading, a bullet or a quote. */
const HEADLINE_MARKS = /^(?:#{1,6}\s+|[-*+]\s+|>\s*)+/;

/** A state's text split into its first non-empty line, without leading Markdown marks or bold, and the rest, trimmed; null for empty text. */
export function stateParts(text: string): ReplyState | null {
  const trimmed = text.trim();

  if (trimmed === '') {
    return null;
  }

  const [first, ...rest] = trimmed.split('\n');
  // Bold is unwrapped too, so the row shows the words alone.
  const headline = first!.trim().replace(HEADLINE_MARKS, '').replace(/(\*\*|__)(.+?)\1/g, '$2').trim();

  return { headline: headline === '' ? first!.trim() : headline, body: rest.join('\n').trim() || null };
}

/**
 * Splits a reply's text at its first `[state]` or `[status]` line outside fenced code, from claude-collab's `status.js`: the text before it is
 * the reply, the text after it, to the end, the state, or null when it is empty. A tag quoted inline or in a code block is text.
 */
export function splitState(text: string): { reply: string; state: ReplyState | null } {
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

    if (fence === null && STATE_LINE.test(line)) {
      return { reply: lines.slice(0, index).join('\n').trim(), state: stateParts(lines.slice(index + 1).join('\n')) };
    }
  }

  return { reply: text, state: null };
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

/** A `[details]` line: up to three spaces in, since four or more make an indented code block. */
const DETAILS_LINE = /^ {0,3}\[details\][ \t]*$/i;

/** A line that is only the details tag, kept apart when the screen's wrapped lines are joined. */
export const isDetailsLine = (line: string): boolean => DETAILS_LINE.test(line);

/** A line that starts Markdown structure, where the voice stops reading a primary response (claude-collab `tts.js` `STRUCTURE`). */
const STRUCTURE = /^\s*(?:`{3,}|~{3,}|#{1,6}\s|[-*+•]\s|\d+[.)]\s|\||>|(?:[-*_][ \t]*){3,}$)/;
/** A line indented as code, which starts an indented code block at the start of a paragraph. */
const INDENTED = /^(?: {4,}|\t)\S/;

/**
 * A reply's primary response (architecture.md § Conversation), from claude-collab's `[details]` line: the text before its first `[details]`
 * line outside fenced code, with the rest its details. Only that line splits a reply: with none, the whole reply is primary. Null when nothing
 * comes before it. `text` is the reply without the `[details]` line.
 */
export function splitPrimary(text: string): { primary: string | null; text: string } {
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

    if (fence === null && DETAILS_LINE.test(line)) {
      const before = lines.slice(0, index).join('\n').trim();
      const after = lines.slice(index + 1).join('\n').trim();

      return { primary: before === '' ? null : before, text: [before, after].filter((part) => part !== '').join('\n\n') };
    }
  }

  // Only blank lines go from the start, so a first line indented as code stays indented.
  const trimmed = text.replace(/^(?:[ \t]*\n)+/, '').trimEnd();

  return { primary: trimmed.trim() === '' ? null : trimmed, text: trimmed };
}

/**
 * The part of a primary response the voice reads, as claude-collab's `tts.js` did: its text up to its first list, table, code block, heading,
 * quote or rule, since a reply with no `[details]` line is all primary however it is written. Empty when it opens with one.
 */
export function speechPart(primary: string): string {
  const lines = primary.split('\n');
  const end = lines.findIndex((line, index) => STRUCTURE.test(line) || (INDENTED.test(line) && (index === 0 || lines[index - 1]!.trim() === '')));

  return (end === -1 ? lines : lines.slice(0, end)).join('\n').trim();
}

/** A `[speak]` or `[/speak]` marker, which replies marked their spoken passage with before the `[details]` line; still read in older replies. */
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
 * The passage an older reply marked to be read aloud, `[speak]`…`[/speak]` (voice-design decision 21), and the text with every marker removed, a
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

/** A reply's parts: an aside or a reply, whether it rewrites the previous reply, its text without the tags, and the state it carries. */
export interface ParsedReply {
  kind: 'reply' | 'aside';
  rewrite: boolean;
  /** Empty for a reply that is only a state. */
  opening: string;
  state: ReplyState | null;
  /**
   * The primary response (`splitPrimary`), shown first and read aloud up to its first Markdown structure (`speechPart`) while Spoken replies is
   * on, which `opening` holds too, without the `[details]` line; an older reply's `[speak]` passage, whose markers `opening` leaves out. Null
   * for an aside or a reply with none.
   */
  speak: string | null;
  /** The tone line, which `opening` leaves out; null with none. */
  tone: string | null;
  /** The heard tags, which `opening` leaves out, in order (architecture.md § Dictation). */
  heard: HeardTag[];
  /** The artifact tags, which `opening` and `state` leave out, in order (architecture.md § Artifacts). */
  artifacts: ArtifactTag[];
}

/** An artifact tag's file (architecture.md § Artifacts): its path as written, absolute or relative to the session's folder, and the title and kind it gives, null for none. */
export interface ArtifactTag {
  path: string;
  title: string | null;
  kind: string | null;
}

/** An artifact tag: `[artifact: <path>]`, optionally with ` | title: <title>` and ` | kind: <kind>`, alone on its line, up to three spaces in. */
const ARTIFACT_LINE = /^ {0,3}\[artifact:[ \t]*([^\]\n]+?)[ \t]*\][ \t\r]*$/i;
/** An artifact tag still being drawn on the text's last line. */
const OPEN_ARTIFACT = /^ {0,3}\[artifact(?::[^\]\n]*)?$/i;

/** A line that is a whole artifact tag, kept apart when the screen's wrapped lines are joined. */
export const isArtifactLine = (line: string): boolean => ARTIFACT_LINE.test(line);
/** A line that starts an artifact tag, which the screen may wrap onto the lines after it. */
export const startsArtifactLine = (line: string): boolean => /^ {0,3}\[artifact:/i.test(line);

/** The parts of an artifact tag's text, or null for a tag that names no path. */
function artifactTag(inner: string): ArtifactTag | null {
  const [first = '', ...rest] = inner.split(/[ \t]+\|[ \t]+/);
  // A path may be wrapped in backticks, quotes or angle brackets, as Markdown writes one with spaces.
  const bare = first.trim();
  const wrapped = /^(`+)(.+)\1$/.exec(bare) ?? /^"(.+)"$/.exec(bare) ?? /^'(.+)'$/.exec(bare) ?? /^<(.+)>$/.exec(bare);
  const path = (wrapped === null ? bare : wrapped[wrapped.length - 1]!).trim();
  const fields: Record<string, string> = {};

  for (const part of rest) {
    const field = /^(title|kind):\s*(.*?)\s*$/i.exec(part);

    if (field !== null && field[2] !== '') {
      fields[field[1]!.toLowerCase()] = field[2]!;
    }
  }

  return path === '' || path.length > 4096 ? null : { path, title: fields['title'] ?? null, kind: fields['kind'] ?? null };
}

/** The lines that lie in a code span running across lines of one paragraph, such as one that quotes a tag on a line of its own. */
function spannedLines(lines: string[], fenced: boolean[]): Set<number> {
  const spanned = new Set<number>();
  let start = 0;

  for (let index = 0; index <= lines.length; index++) {
    if (index < lines.length && lines[index]!.trim() !== '' && !fenced[index]) {
      continue;
    }

    const block = lines.slice(start, index);
    const offsets: number[] = [];
    let at = 0;

    for (const line of block) {
      offsets.push(at);
      at += line.length + 1;
    }

    // An escaped backtick opens no code span.
    for (const span of block.join('\n').replace(/\\`/g, '\\x').matchAll(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) {
      if (span[0].includes('\n')) {
        const end = span.index + span[0].length;

        block.forEach((line, offset) => {
          if (offsets[offset]! < end && offsets[offset]! + line.length > span.index) {
            spanned.add(start + offset);
          }
        });
      }
    }

    start = index + 1;
  }

  return spanned;
}

/**
 * The artifact tags of a text (architecture.md § Artifacts), in order, and the text without their lines. Only a tag alone on its line outside
 * code counts, so a reply that quotes the tag inline or in a code block, as when it explains the rule, keeps it as text. The rest of the text is
 * kept as written, but for a blank line a removed tag would leave doubled.
 */
export function splitArtifacts(text: string): { artifacts: ArtifactTag[]; text: string } {
  if (!/\[artifact:/i.test(text)) {
    return { artifacts: [], text };
  }

  const lines = text.split('\n');
  const fenced: boolean[] = [];
  let fence: string | null = null;

  for (const line of lines) {
    const open = FENCE.exec(line);

    fenced.push(fence !== null || open !== null);

    if (open !== null) {
      if (fence === null) {
        fence = open[1]!;
      } else if (open[1]![0] === fence[0] && open[1]!.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
        fence = null;
      }
    }
  }

  const spanned = spannedLines(lines, fenced);
  const kept: string[] = [];
  const artifacts: ArtifactTag[] = [];
  let removed = false;

  lines.forEach((line, index) => {
    const tag = fenced[index] || spanned.has(index) ? null : ARTIFACT_LINE.exec(line);
    const parsed = tag === null ? null : artifactTag(tag[1]!);

    if (parsed !== null) {
      artifacts.push(parsed);
      removed = true;
    } else if (!(removed && line.trim() === '' && (kept.length === 0 || kept.at(-1)!.trim() === ''))) {
      kept.push(line);
      removed = false;
    }
  });

  return artifacts.length === 0 ? { artifacts, text } : { artifacts, text: kept.join('\n').trim() };
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
  const { artifacts, text: untagged } = splitArtifacts(text);
  const { reply, state } = splitState(untagged);
  const { aside, text: unaside } = stripAside(reply);
  // The tone line is the reply's first line, before or after a rewrite tag.
  const before = splitTone(unaside);
  const { rewrite, text: rewritten } = splitRewrite(before.text);
  const after = before.tone === null ? splitTone(rewritten) : { tone: null, text: rewritten };
  const { heard, text: unheard } = splitHeard(after.text);
  const marked = splitSpeak(unheard);
  // An older reply's [speak] passage stands; any other reply's primary response is what comes before its [details] line.
  const { primary, text: body } = marked.speak !== null ? { primary: marked.speak, text: marked.text } : splitPrimary(marked.text);

  return { kind: aside ? 'aside' : 'reply', rewrite: rewrite && !aside, opening: body.trim(), state, speak: aside ? null : primary, tone: before.tone ?? after.tone, heard, artifacts };
}

/**
 * The tags Switchboard puts before a message it types (architecture.md § Voice, § Dictation): its reply will be heard and read expressively, it
 * was dictated, and it is a part of a message still being spoken.
 */
const MESSAGE_TAGS = /^\s*(?:\[(?:spoken|expressive|voice|partial)\][ \t]*)+(?:\[(?:interrupted your reply (?:before its first words|after: "[^"]*"(?:; unspoken: "[^"]*")?)|heard all of your reply but: "[^"]*")\][ \t]*)?/i;

/** A message's text without the tags Switchboard typed before it, and the interruption note after them. */
export function stripMessageTags(text: string): string {
  return text.replace(MESSAGE_TAGS, '').trim();
}

/**
 * The tags Switchboard types before a message: `[spoken]` when its reply will be heard, with `[expressive]` while `voice.expressive` is on, then
 * `[voice]` for a dictated message and `[voice] [partial]` for a part of one still being spoken (architecture.md § Dictation).
 */
export function messageTags(spoken: boolean, expressive: boolean, dictated: 'voice' | 'partial' | null = null, note: string | null = null): string {
  const reply = spoken ? (expressive ? '[spoken] [expressive] ' : '[spoken] ') : '';

  return reply + (dictated === 'voice' ? '[voice] ' : dictated === 'partial' ? '[voice] [partial] ' : '') + (dictated !== null && note !== null ? `${note} ` : '');
}

const tail = (text: string, count: number): string => {
  const words = text.split(/\s+/).filter(Boolean);

  return (words.length > count ? '…' : '') + words.slice(-count).join(' ');
};
const head = (text: string, count: number): string => {
  const words = text.split(/\s+/).filter(Boolean);

  return words.slice(0, count).join(' ') + (words.length > count ? '…' : '');
};

/**
 * The note a dictated message that spoke over a reply is typed with, after its tags (claude-collab `barge.js` `interruptNote`): the last words
 * of the reply heard, or the part not heard when it is short, and the first words not heard. Null when the whole passage was heard.
 */
export function interruptNote(interrupted: { said: string; rest: string }): string | null {
  // Double quotes in the quoted words become single ones, so the note's own quotes end it and it can be read back off the message.
  const said = interrupted.said.trim().replaceAll('"', "'");
  const rest = interrupted.rest.trim().replaceAll('"', "'");
  const left = rest.split(/\s+/).filter(Boolean).length;

  if (said === '') {
    return '[interrupted your reply before its first words]';
  }

  if (left === 0) {
    return null;
  }

  if (left <= 12) {
    return `[heard all of your reply but: "${rest}"]`;
  }

  return `[interrupted your reply after: "${tail(said, 10)}"; unspoken: "${head(rest, 6)}"]`;
}

/**
 * An ordered list item's number at the start of its line. Claude Code numbers a list nested in another "a.", "b.", … and one nested deeper "i.",
 * "ii.", …, whatever the Markdown's numbers (mechanics M171), so no list number counts toward a key.
 */
const LIST_NUMBER = /^[ \t]*\d{1,9}[.)](?=[ \t])|^[ \t]+(?:[a-z]{1,2}|[ivxlcdm]{1,8})[.)](?=[ \t])/gm;

/**
 * Letters and digits only, by which a screen copy and a transcript copy of one reply compare: the screen shows Markdown rendered, with no
 * backticks or asterisks, links as their text and nested list numbers as letters, the transcript raw.
 */
export const squash = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(LIST_NUMBER, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // The screen draws a bare "www." link with the scheme its target gets.
    .replace(/\bhttps?:\/\/(?=www\.)/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

const LINK = /\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"([^"]*)")?\s*\)/g;

/**
 * Markdown links as Claude Code draws them in a terminal without hyperlinks (2.1.330): "text (target)", or the target alone when it is the text,
 * and a title after as ("title"). Code spans are left as they are, since the screen shows them as written.
 */
export function drawnLinks(text: string): string {
  const draw = (part: string): string =>
    part.replace(LINK, (_whole, label: string, href: string, title: string | undefined) => {
      const mail = /^mailto:/i.test(href);
      const target = mail ? href.replace(/^mailto:/i, '') : href;
      const shown = label === '' || label === target ? target : `${label} (${target})`;

      return title === undefined ? shown : `${shown} ("${title}")`;
    });
  let out = '';
  let from = 0;

  // A code span closes at the next run of as many backticks as opened it.
  for (const span of text.matchAll(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) {
    out += draw(text.slice(from, span.index)) + span[0];
    from = span.index + span[0].length;
  }

  return out + draw(text.slice(from));
}

/** A reply with no letters or digits, such as "👍", is keyed by its text without comments, spaces or ASCII punctuation instead. */
const bareOf = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, '').replace(/[\s!-/:-@[-`{-~]+/g, '');

/** The key a reply's copies share; the rewrite tag does not count, so "[rewrite] 👍" and "[rewrite] 👎" differ. */
export function keyOf(text: string): string {
  const body = splitRewrite(text).text;

  return squash(body) || bareOf(body);
}

/** The key a transcript copy's screen copy has when the terminal draws its links with their targets; null when that is its own key. */
export function drawnKeyOf(text: string): string | null {
  const key = keyOf(drawnLinks(text));

  return key === keyOf(text) ? null : key;
}

const TAG_WORDS = ['aside', 'rewrite', 'state', 'status', 'details', 'speak', '/speak', 'tone', 'artifact'];

/**
 * Whether the text's last line ends in a tag or an HTML comment still being drawn, such as "Done. <!--as" or "[asi": read now, it would be
 * published and then again under another key once the tag is complete.
 */
export function endsInOpenTag(text: string): boolean {
  const last = text.trimEnd().split('\n').at(-1) ?? '';
  const open = /(?:^|\s)\[([a-z]*)$/i.exec(last) ?? /\[(\/[a-z]*)$/i.exec(last);

  if ((open !== null && TAG_WORDS.some((word) => word.startsWith(open[1]!.toLowerCase()))) || OPEN_ARTIFACT.test(last)) {
    return true;
  }

  const comment = last.lastIndexOf('<!--');

  return (comment !== -1 && !last.includes('-->', comment + 4)) || /<!?-?$/.test(last);
}
