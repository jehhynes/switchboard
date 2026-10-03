/** Share of the limit given to the start of the text; the rest keeps the end, where requests often are. */
const HEAD_SHARE = 0.6;

/** How far to look for a space when cutting at a word boundary. */
const WORD_BOUNDARY_DISTANCE = 40;

function previousBoundary(text: string, at: number): number {
  const space = text.lastIndexOf(' ', at);

  return space > at - WORD_BOUNDARY_DISTANCE && space > 0 ? space : at;
}

function nextBoundary(text: string, at: number): number {
  const space = text.indexOf(' ', at);

  return space !== -1 && space < at + WORD_BOUNDARY_DISTANCE ? space + 1 : at;
}

/** Keeps both ends of text within `limit` characters, cut at word boundaries, with a marker naming what was left out (GC clip). */
export function clip(text: string | null, limit: number): string {
  const trimmed = (text ?? '').trim();

  if (trimmed.length <= limit) {
    return trimmed;
  }

  const head = trimmed.slice(0, previousBoundary(trimmed, Math.ceil(limit * HEAD_SHARE))).trimEnd();
  const tail = trimmed.slice(nextBoundary(trimmed, trimmed.length - (limit - head.length))).trimStart();

  return `${head}\n[…${trimmed.length - head.length - tail.length} characters omitted…]\n${tail}`;
}
