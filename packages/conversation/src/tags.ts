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

/** The rules version that first explained each tag (`CONVERSATION_RULES_VERSION`); a session is read only for the tags its rules told it about. */
export const ASIDE_REWRITE_SINCE = 1;
export const STATUS_SINCE = 3;

/** A reply's parts: an aside or a reply, whether it rewrites the previous reply, its text without the tags, and the status it carries. */
export interface ParsedReply {
  kind: 'reply' | 'aside';
  rewrite: boolean;
  /** Empty for a reply that is only a status. */
  opening: string;
  status: string | null;
}

/**
 * Splits a reply's text into its parts, reading only the tags the session's rules version (`rules`) explained, since a session was never told to
 * write the others; a session with rules older than `ASIDE_REWRITE_SINCE`, or none, gets its replies whole.
 */
export function parseReply(text: string, rules: number | null): ParsedReply {
  if (rules === null || rules < ASIDE_REWRITE_SINCE) {
    return { kind: 'reply', rewrite: false, opening: text.trim(), status: null };
  }

  const { reply, status } = rules >= STATUS_SINCE ? splitStatus(text) : { reply: text, status: null };
  const { aside, text: unaside } = stripAside(reply);
  const { rewrite, text: body } = splitRewrite(unaside);

  return { kind: aside ? 'aside' : 'reply', rewrite: rewrite && !aside, opening: body.trim(), status };
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

const TAG_WORDS = ['aside', 'rewrite', 'status'];

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
