/**
 * A reply's body as the VS Code Conversation view and the web page draw it: its primary response (its spoken passage when Speak replies is on),
 * then its details, both as plain text at the size of the operator's messages, whether or not it was spoken (architecture.md § Conversation
 * view, Speech). Imports only the tag reader, which imports nothing, for browser bundles.
 */
import { speechPart, spokenText } from './tags.js';

/** One run of a reply's text: a passage read aloud, or text around it. */
export interface SpokenPart {
  spoken: boolean;
  text: string;
  /** Where a passage starts in `speak`, so the part heard before an interruption can be found in it; 0 for other text. */
  at: number;
}

/**
 * A reply's text cut round its primary response, or an older reply's `[speak]` passages, in order. `speak` is the passages joined with spaces, as the reader stores it
 * (`splitSpeak`) without where they were, so each passage is the longest run of its words found in `opening` after the passage before it,
 * at its first place, as a passage is usually the reply's opening. Text that repeats a passage word for word can take its place. Null when a
 * passage is not found, so the reply shows as written.
 */
export function spokenParts(opening: string, speak: string): SpokenPart[] | null {
  const parts: SpokenPart[] = [];
  let cursor = 0;
  let from = 0;

  while (from < speak.length) {
    // Every end at a space or at the end, longest first: one passage is found whole on the first try. A short run could match words of the
    // text before the passage, so the longest run found is taken, at its first place after the passage before it.
    const ends = [speak.length];

    for (let space = speak.lastIndexOf(' ', speak.length - 1); space > from; space = speak.lastIndexOf(' ', space - 1)) {
      ends.push(space);
    }

    const found = ends.map((end) => ({ end, index: opening.indexOf(speak.slice(from, end), cursor) })).find(({ index }) => index !== -1);

    if (found === undefined) {
      return null;
    }

    const before = opening.slice(cursor, found.index);

    if (before.trim() !== '') {
      parts.push({ spoken: false, text: before, at: 0 });
    }

    parts.push({ spoken: true, text: speak.slice(from, found.end), at: from });
    cursor = found.index + found.end - from;
    from = found.end + 1;
  }

  const after = opening.slice(cursor);

  if (after.trim() !== '') {
    parts.push({ spoken: false, text: after, at: 0 });
  }

  return parts;
}

/** Whether a reply has text besides its passages, which focused mode folds behind Show more. */
export function hasUnspokenText(opening: string, speak: string): boolean {
  const parts = spokenParts(opening, speak);

  return parts === null ? speak.trim() !== opening.trim() : parts.some((part) => !part.spoken);
}

/** How a front end draws a reply's primary response and details. */
export interface ReplyRender {
  /** Text as Markdown; `last` for the text that ends the reply, where a question card's questions are. */
  markdown(text: string, last: boolean): string;
  escape(text: string): string;
}

/**
 * Where in a passage's Markdown the voice had got to after `heard` characters of its spoken text (`spokenText`, which the voice reads and
 * counts in): the spoken characters are matched in order against the Markdown, skipping its marks and link targets, a run of white space
 * standing for one space.
 */
function heardEnd(passage: string, heard: number): number {
  const spoken = spokenText(passage);
  let matched = 0;

  for (let index = 0; index < passage.length && matched < heard; index++) {
    const space = /\s/.test(passage[index]!);

    if (space ? spoken[matched] === ' ' : passage[index] === spoken[matched]) {
      matched++;

      while (space && index + 1 < passage.length && /\s/.test(passage[index + 1]!)) {
        index++;
      }
    }

    if (matched >= heard) {
      return index + 1;
    }
  }

  return heard <= 0 ? 0 : passage.length;
}

/**
 * One passage of the primary response, `last` when it ends the reply; after the operator spoke over it (`heard`, characters of its spoken text,
 * not null), the part of what the voice reads (`speechPart`) not heard is dimmed, as plain text, and the rest, never read, stays Markdown.
 */
export function primaryResponse(passage: string, heard: number | null, render: ReplyRender, last = false): string {
  const speech = speechPart(passage);
  const cut = heard === null || heard >= spokenText(speech).length ? null : heardEnd(speech, Math.max(heard, 0));

  if (cut === null) {
    return `<div class="reply-primary">${render.markdown(passage, last)}</div>`;
  }

  const rest = passage.slice(passage.indexOf(speech) + speech.length);

  return `<div class="reply-primary"><p class="passage">${render.escape(speech.slice(0, cut))}<span class="unheard">${render.escape(speech.slice(cut))}</span></p>${rest.trim() === '' ? '' : render.markdown(rest, last)}</div>`;
}

/**
 * A reply's body with each passage of its primary response drawn once: only the primary response while folded (focused mode), else the whole
 * reply with each passage in its place and the rest as details. `said` is how many characters of `speak`'s spoken text were heard before an
 * interruption, else null. A reply whose passage is not found in its text shows it whole, so no text shows twice.
 */
export function replyBody(opening: string, speak: string, said: number | null, folded: boolean, render: ReplyRender): string {
  if (folded) {
    return primaryResponse(speak, said, render);
  }

  const parts = spokenParts(opening, speak);

  if (parts === null) {
    return render.markdown(opening, true);
  }

  // The voice reads the passages as one text, joined with a space, so each passage starts one character after the spoken text before it.
  const spokenAt = (at: number): number => (at === 0 ? 0 : spokenText(speak.slice(0, at)).length + 1);

  return parts
    .map((part, index) =>
      part.spoken ? primaryResponse(part.text, said === null ? null : said - spokenAt(part.at), render, index === parts.length - 1) : `<div class="reply-details">${render.markdown(part.text, index === parts.length - 1)}</div>`,
    )
    .join('');
}
