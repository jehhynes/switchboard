/**
 * Replies read off the terminal (architecture.md § Conversation), from claude-collab's `screen-reader.js`: the transcript gets a reply only once
 * the whole model message is saved, while the screen shows it as soon as the text block is drawn. Claude Code's classic renderer draws a reply as
 * "● text" with two-space continuation lines; a block counts as finished once something is drawn after it.
 */
import { drawnKeysOf, endsInOpenTag, isArtifactLine, isDetailsLine, isRewriteLine, isStateLine, startsArtifactLine, keyOf, parseReply, splitRewrite, stripAside } from './tags.js';

/** The part of an xterm buffer cell the reader uses. */
export interface Cell {
  isDim(): number | boolean;
  getFgColor(): number;
  isFgPalette(): boolean;
  isFgRGB(): boolean;
  getChars(): string;
  getWidth(): number;
}

/** The part of an xterm buffer line the reader uses. */
export interface Line {
  readonly length: number;
  getCell(x: number): Cell | undefined;
}

/** A block still streaming grows between reads; one that extends the last block read after longer than this is a new block. */
const GROW_MS = 30_000;
/**
 * A reply's screen copy that gets no transcript copy is withdrawn: once an assistant line written more than `CONFIRM_SLACK_MS` after it reaches
 * the transcript without it, once Claude has sat idle for `CONFIRM_MS` since it was read, or after `CONFIRM_MAX_MS` while Claude works. Every
 * reply reaches the transcript; what does not was never one, such as a prompt of Claude Code's or a screen caught mid-redraw.
 */
export const CONFIRM_MS = 5_000;
export const CONFIRM_SLACK_MS = 1_000;
export const CONFIRM_MAX_MS = 20_000;
/** A new reply that opens with this many letters of a sent one and then goes elsewhere is that one caught mid-redraw. */
const REDRAWN_LETTERS = 80;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A table Claude Code drew as a box from `lines[start]`, its top edge (mechanics M175): each row's cells, read across the lines the row's
 * cells wrap onto, and the index of the bottom edge. Null when the lines are not such a box, as when a cell holds a "│" of its own.
 */
export function boxTable(lines: string[], start: number): { rows: string[][]; end: number } | null {
  const top = lines[start]!.trim();

  if (!/^┌─[─┬]*┐$/.test(top)) {
    return null;
  }

  const columns = top.split('┬').length;
  const rows: string[][] = [];
  let cells: string[] | null = null;

  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!.trim();

    if (/^├─[─┼]*┤$/.test(line) || /^└─[─┴]*┘$/.test(line)) {
      if (cells === null || line.split(/[┼┴]/).length !== columns) {
        return null;
      }

      rows.push(cells);
      cells = null;

      if (line.startsWith('└')) {
        return { rows, end: index };
      }

      continue;
    }

    const parts = line.split('│');

    if (parts.length !== columns + 2 || parts[0] !== '' || parts.at(-1) !== '') {
      return null;
    }

    const row: string[] = (cells ??= Array<string>(columns).fill(''));

    parts.slice(1, -1).forEach((part, column) => {
      const piece = part.trim();

      if (piece !== '') {
        row[column] = row[column] === '' ? piece : `${row[column]} ${piece}`;
      }
    });
  }

  return null;
}

/** A box table's rows, its column names first, as a Markdown table. */
const markdownTable = (rows: string[][]): string[] => {
  const line = (cells: string[]): string => `| ${cells.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`;

  return [line(rows[0]!), `|${' --- |'.repeat(rows[0]!.length)}`, ...rows.slice(1).map(line)];
};

/**
 * Joins lines the terminal wrapped, keeping paragraph breaks, list items, a rewrite tag's line of its own, and code fences with the lines inside
 * them as they are. A table drawn as a box becomes a Markdown table, so its cells read in the transcript copy's order.
 */
export function unwrap(lines: string[]): string {
  const out: string[] = [];
  // The last line out stands alone (a tag, a fence or code), so nothing joins it.
  let alone = false;
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const open = FENCE.exec(line);
    const table = fence === null && open === null ? boxTable(lines, index) : null;

    if (table !== null) {
      if (out.length > 0 && out.at(-1) !== '') {
        out.push('');
      }

      out.push(...markdownTable(table.rows));
      index = table.end;

      if (index + 1 < lines.length && lines[index + 1]!.trim() !== '') {
        out.push('');
      }

      alone = true;
      continue;
    }

    if (fence !== null || open !== null) {
      out.push(line.trimEnd());
      alone = true;

      if (fence === null) {
        fence = open![1]!;
      } else if (open !== null && open[1]![0] === fence[0] && open[1]!.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
        fence = null;
      }

      continue;
    }

    if (line.trim() === '') {
      out.push('');
      alone = false;
      continue;
    }

    const previous = out.at(-1);
    const tag = isRewriteLine(line) || isStateLine(line) || isDetailsLine(line);

    // An artifact tag or a list item starts a line of its own, and the screen's wrapped rest of it joins it. Claude Code numbers a nested list's
    // items with letters (mechanics M171).
    if (previous !== undefined && previous !== '' && !alone && !tag && !startsArtifactLine(line) && !/^\s*([-*•]|\d+\.)\s|^\s+([a-z]{1,2}|[ivxlcdm]{1,8})\.\s/.test(line)) {
      out[out.length - 1] = `${previous} ${line.trim()}`;
    } else {
      out.push(line.trimEnd());
    }

    alone = tag || isArtifactLine(out.at(-1)!);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Whether a "●" drawn in this cell is a reply's. A reply's is drawn in the text colour; a tool call's is green once done, red once failed, and
 * grey (blinking) while it runs. Claude Code's own prompts, such as its session-rating survey, use its blue "suggestion" colour.
 */
export function isReplyCell(cell: Cell | undefined): boolean {
  if (cell === undefined) {
    return true;
  }

  if (cell.isDim()) {
    return false;
  }

  const colour = cell.getFgColor();

  if (cell.isFgPalette()) {
    // Red, green, blue and mid grey.
    return ![1, 2, 4, 8, 9, 10, 12].includes(colour) && !(colour >= 242 && colour <= 247);
  }

  if (!cell.isFgRGB()) {
    return true;
  }

  const red = colour >> 16;
  const green = (colour >> 8) & 255;
  const blue = colour & 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);

  // Mid grey (#999999): a tool call still running.
  if (max - min <= 24 && max >= 0x80 && max <= 0xb0) {
    return false;
  }

  return !(green > red + 40 && green > blue + 40) && !(red > green + 60 && red > blue + 60) && !(blue > red + 40 && blue > green + 40);
}

/**
 * Inline code: Claude Code draws a code span in its theme's "permission" colour without its backticks (2.1.328). These are the colours of the
 * dark and light themes and their colour-blind versions; the ANSI themes use palette blue, which code blocks also use, so it counts only under one.
 */
const CODE_RGB = new Set([0xb1b9f9, 0x5769f7, 0x99ccff, 0x3366ff]);

export function isCodeCell(cell: Cell, ansiTheme = false): boolean {
  if (cell.isFgRGB()) {
    return CODE_RGB.has(cell.getFgColor());
  }

  return ansiTheme && cell.isFgPalette() && [4, 12].includes(cell.getFgColor());
}

/**
 * A buffer line as text, with backticks put back around its inline code, so the screen copy carries them as the transcript copy does and no tag
 * detector takes a quoted tag for a real one. A span with backticks of its own gets a longer run around it; one that would need three or more has
 * its own backticks dropped instead (keys count letters and digits only, so it still matches).
 */
export function lineText(line: Line, isCode: (cell: Cell) => boolean): string {
  let text = '';
  let code: string | null = null;

  const close = (): void => {
    let body = code!.trimEnd();
    let ticks = '`'.repeat(Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length)) + 1);

    if (ticks.length > 2) {
      body = body.replace(/`+/g, '');
      ticks = '`';
    }

    const pad = /^`|`$/.test(body) ? ' ' : '';

    text += (body === '' ? '' : ticks + pad + body + pad + ticks) + code!.slice(code!.trimEnd().length);
    code = null;
  };

  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);

    if (cell === undefined || cell.getWidth() === 0) {
      continue;
    }

    const char = cell.getChars() || ' ';

    if (isCode(cell) && (code !== null || char !== ' ')) {
      code = (code ?? '') + char;
      continue;
    }

    if (code !== null) {
      close();
    }

    text += char;
  }

  if (code !== null) {
    close();
  }

  return text.trimEnd();
}

/** A tool call's header, "Bash(echo hi)" or "github - search (MCP)(...)": with reduced motion on, a running one's bullet is drawn like a reply's. */
const TOOL_CALL = /^[A-Z][\w-]*\(|^[\w-]+ - .+ \(MCP\)\(/;
/**
 * Focus view's row of running tool calls (mechanics M120): drawn with a running tool call's blinking bullet, so with the bullet blank it reads as
 * a reply's next paragraph. Only the row as seen counts, so a reply that names the shortcut is never cut.
 */
const COLLAPSED_ROW = /^(● | {2})Working… \(ctrl\+o to expand\)$/;
/** A row of a menu's numbered options, "1: Bad    2: Fine": a prompt of Claude Code's, never a reply. */
const OPTION_ROW = /^\s*\d+: \S.*?\s{2,}\d+: \S/;

/**
 * The finished reply blocks on the screen, oldest first; null for a block whose last line is a tag or comment still being drawn. `isReplyBullet(i)`
 * says whether line i's "●" is a reply's.
 */
export function screenBlocks(lines: string[], isReplyBullet: (index: number) => boolean): Array<string | null> {
  const blocks: Array<string | null> = [];

  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]!.startsWith('● ') || !isReplyBullet(index) || TOOL_CALL.test(lines[index]!.slice(2)) || COLLAPSED_ROW.test(lines[index]!.trimEnd())) {
      continue;
    }

    const body = [lines[index]!.slice(2)];
    let next = index + 1;

    // A running tool call's bullet blinks: drawn blank, its header after a blank line would read as the reply's last paragraph.
    while (
      next < lines.length &&
      (lines[next] === '' ||
        (lines[next]!.startsWith('  ') && !lines[next]!.startsWith('  ⎿') && !(lines[next - 1] === '' && COLLAPSED_ROW.test(lines[next]!.trimEnd())) && !(lines[next - 1] === '' && TOOL_CALL.test(lines[next]!.slice(2)))))
    ) {
      body.push(lines[next++]!.slice(2));
    }

    // Still being drawn.
    if (next >= lines.length) {
      continue;
    }

    if (body.some((line) => OPTION_ROW.test(line))) {
      continue;
    }

    while (body.length > 0 && body.at(-1)!.trim() === '') {
      body.pop();
    }

    // A reply that came out as a thinking block shows with a trailing "· summary"; it is still the reply.
    const text = unwrap(body).replace(/\s*·\s*summary$/, '');

    blocks.push(endsInOpenTag(text) ? null : text);
  }

  return blocks;
}

/** Publishes a screen copy, or a grown copy in place of the one it grew from (`replaces`), and returns its handle. */
export type ScreenPush = (text: string, aside: boolean, replaces: number | undefined) => number;

/** Sends each screen block's reply once. */
export class ScreenReader {
  /** Keys already published, from the screen or the transcript. */
  readonly sent = new Set<string>();
  /**
   * Keys of transcript copies as the screen may draw them, with their links' targets or their tables as records. They count only as the same
   * reply or one cut off, never in the check for a redraw, whose shared opening letters a long link target could make two replies have.
   */
  readonly drawn = new Set<string>();
  /** Key to the handles of screen copies still waiting for their transcript copies, oldest first. */
  readonly ids = new Map<string, number[]>();
  /** Handle of a reply's screen copy to when it was read or last grew and when it was first read, until its transcript copy comes. */
  readonly pending = new Map<number, { at: number; first: number }>();
  /** Keys of adopted copies, which are keys of the reply's `opening` rather than of its raw text. */
  readonly adopted = new Set<string>();
  /** The newest block read. */
  #tail: { key: string; id: number | null; at: number; frozen?: boolean } | null = null;
  /** When `unconfirmed` last saw Claude working. */
  #busyAt = 0;

  constructor(
    private readonly push: ScreenPush,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A screen copy an earlier hub process published and left waiting, as a restart does: it waits again from now, so its transcript copy replaces
   * it in place or it is withdrawn as any other copy would be.
   */
  adopt(key: string, handle: number, newest: boolean): void {
    const now = this.now();

    this.sent.add(key);
    this.adopted.add(key);
    this.#wait(key, handle);
    this.pending.set(handle, { at: now, first: now });

    // The newest may still be streaming: a longer copy on the screen grows it in place. An empty key would take any block as its growth.
    if (newest && key !== '') {
      this.#tail = { key, id: handle, at: now };
    }
  }

  /** A transcript copy's text, so its screen copies drawn either way are not published again. */
  saw(text: string): void {
    this.sent.add(keyOf(text));

    for (const key of drawnKeysOf(text)) {
      this.drawn.add(key);
    }
  }

  /** The oldest screen copy waiting under the key, taken off the list. */
  take(key: string): number | undefined {
    const list = this.ids.get(key);
    const id = list?.shift();

    if (list !== undefined && list.length === 0) {
      this.ids.delete(key);
    }

    if (id !== undefined) {
      this.pending.delete(id);
    }

    return id;
  }

  /**
   * The screen copies that got no transcript copy in time, taken off the waiting lists, oldest first. `transcriptAt`: when the newest assistant
   * line in the transcript was written. Called every few hundred milliseconds, so idleness counts from the last call that saw Claude busy.
   */
  unconfirmed(transcriptAt: number, busy: boolean): number[] {
    if (this.pending.size === 0) {
      return [];
    }

    const now = this.now();
    const out: number[] = [];

    if (busy) {
      this.#busyAt = now;
    }

    for (const [id, { at, first }] of this.pending) {
      if (transcriptAt > at + CONFIRM_SLACK_MS || now - Math.max(at, this.#busyAt) > CONFIRM_MS || now - first > CONFIRM_MAX_MS) {
        out.push(id);
      }
    }

    for (const id of out) {
      this.pending.delete(id);

      for (const [key, list] of this.ids) {
        if (list.includes(id)) {
          this.#drop(key, id);
        }
      }
    }

    return out;
  }

  /** Every screen copy still waiting for its transcript copy, taken off the waiting lists. */
  drain(): number[] {
    const handles = [...new Set([...this.ids.values()].flat())];

    this.ids.clear();
    this.pending.clear();

    return handles;
  }

  #wait(key: string, id: number): number {
    this.ids.set(key, [...(this.ids.get(key) ?? []), id]);

    return id;
  }

  #drop(key: string, id: number): void {
    const list = this.ids.get(key)?.filter((other) => other !== id);

    if (list !== undefined && list.length > 0) {
      this.ids.set(key, list);
    } else {
      this.ids.delete(key);
    }
  }

  read(lines: string[], isReplyBullet: (index: number) => boolean): void {
    const blocks = screenBlocks(lines, isReplyBullet);
    const now = this.now();

    blocks.forEach((block, index) => {
      if (block === null) {
        return;
      }

      const { text, aside } = stripAside(block);

      // A rewrite tag with nothing after it yet is no reply.
      if (text === '' || splitRewrite(text).text === '') {
        return;
      }

      const key = keyOf(text);

      if (key === '') {
        return;
      }

      const last = index === blocks.length - 1;
      // Only the newest block can still be streaming: it is the last block read when it extends (or, mid-redraw, cuts off) that block's text and
      // that block is not also on screen in its own right.
      const same = last && this.#sameAsTail(key, blocks.slice(0, index), now);
      const previous = same ? this.#tail!.key : null;

      if (previous !== null) {
        if (key === previous || previous.startsWith(key)) {
          return;
        }

        // Growing across a resize: what is on screen may be garbled, so nothing is published; the transcript copy comes later.
        if (this.#tail!.frozen === true) {
          this.sent.add(key);
          this.#tail!.at = now;
          return;
        }

        // Grown: the copy is updated in place rather than another added beside the cut-off one.
        if (key.startsWith(previous)) {
          const was = this.#tail!.id;

          this.#tail!.key = key;
          this.#tail!.at = now;

          // Its transcript copy already replaced it.
          if (was === null || !this.ids.get(previous)?.includes(was)) {
            return;
          }

          this.#drop(previous, was);
          this.sent.add(key);

          const id = this.#wait(key, this.push(text, aside, was));
          const before = this.pending.get(was);

          this.#tail!.id = id;

          if (before !== undefined) {
            this.pending.delete(was);
            this.pending.set(id, { at: now, first: before.first });
          }

          return;
        }
      }

      if (same) {
        this.#tail!.key = key;
        this.#tail!.at = now;
      }

      // Sent already, adopted, or a copy of a sent one cut off or caught mid-redraw.
      if (
        this.sent.has(key) ||
        this.drawn.has(key) ||
        (this.adopted.size > 0 && this.adopted.has(keyOf(parseReply(text).opening))) ||
        (!same && key.length > 40 && [...this.sent, ...this.drawn].some((sent) => sent.length > key.length && sent.startsWith(key)))
      ) {
        return;
      }

      if (!same && key.length >= REDRAWN_LETTERS && [...this.sent].some((sent) => sent.startsWith(key.slice(0, REDRAWN_LETTERS)))) {
        return;
      }

      this.sent.add(key);

      const id = this.#wait(key, this.push(text, aside, undefined));

      this.pending.set(id, { at: now, first: now });

      if (same) {
        this.#tail!.id = id;
      } else if (last) {
        this.#tail = { key, id, at: now };
      }
    });
  }

  /**
   * Takes every finished block on the screen as read, publishing none: after a resize the terminal reflows its lines and Claude Code redraws over
   * them, leaving garbled copies of old replies. The newest block read stays the tail, frozen, so its growth is not published.
   */
  skip(lines: string[], isReplyBullet: (index: number) => boolean): void {
    for (const block of screenBlocks(lines, isReplyBullet)) {
      const text = block === null ? '' : stripAside(block).text;

      if (text !== '') {
        this.sent.add(keyOf(text));
      }
    }

    if (this.#tail !== null) {
      this.#tail.frozen = true;
      this.#tail.at = this.now();
    }
  }

  #sameAsTail(key: string, earlier: Array<string | null>, now: number): boolean {
    const tail = this.#tail;

    if (tail === null || now - tail.at > GROW_MS || !(key.startsWith(tail.key) || tail.key.startsWith(key))) {
      return false;
    }

    // Two blocks on screen, the second extending the first, are two blocks.
    return !earlier.some((block) => block !== null && keyOf(stripAside(block).text) === tail.key);
  }
}
