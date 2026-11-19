/**
 * The tags a reply can carry (architecture.md § Conversation), from claude-collab's `screen-reader.js`, `rewrite.js` and `tts.js`. The screen
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

/** A reply's parts: an aside or a reply, whether it rewrites the previous reply, and its text without the tags. */
export interface ParsedReply {
  kind: 'reply' | 'aside';
  rewrite: boolean;
  opening: string;
}

/**
 * Splits a reply's text into its parts. A session whose prompt lacks the current rules gets its replies whole (`rules` false), since it was never
 * told to write the tags.
 */
export function parseReply(text: string, rules: boolean): ParsedReply {
  if (!rules) {
    return { kind: 'reply', rewrite: false, opening: text.trim() };
  }

  const { aside, text: unaside } = stripAside(text);
  const { rewrite, text: body } = splitRewrite(unaside);

  return { kind: aside ? 'aside' : 'reply', rewrite: rewrite && !aside, opening: body.trim() };
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

const TAG_WORDS = ['aside', 'rewrite'];

/**
 * Whether the text's last line ends in a tag or an HTML comment still being drawn, such as "Done. <!--as" or "[asi": read now, it would be
 * published and then again under another key once the tag is complete.
 */
export function endsInOpenTag(text: string): boolean {
  const last = text.trimEnd().split('\n').at(-1) ?? '';
  const open = /(?:^|\s)\[([a-z]*)$/i.exec(last);

  if (open !== null && TAG_WORDS.some((word) => word.startsWith(open[1]!.toLowerCase()))) {
    return true;
  }

  const comment = last.lastIndexOf('<!--');

  return (comment !== -1 && !last.includes('-->', comment + 4)) || /<!?-?$/.test(last);
}
