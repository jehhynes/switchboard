import headless from '@xterm/headless';
import { isCodeCell, isReplyCell, lineText } from './screenReader.js';
import type { Cell, Line } from './screenReader.js';

/** A screen as the reader takes it: every buffer line as text, scrollback included, which of them start with a reply's bullet, and the size. */
export interface ScreenRead {
  lines: string[];
  bullets: boolean[];
  cols: number;
  rows: number;
}

/** How many lines above the screen a snapshot asks for: a reply taller than this comes only from the transcript. */
export const SNAPSHOT_SCROLLBACK = 400;

/**
 * Replays a holder snapshot into a headless terminal of its size and reads it: lines with inline code in backticks, and each line's first cell
 * colour, which tells a reply's bullet from a tool call's. `ansiTheme` says whether Claude Code draws in one of its ANSI themes.
 */
export async function readSnapshot(snapshot: { data: string; cols: number; rows: number }, ansiTheme = false): Promise<ScreenRead> {
  const term = new headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: SNAPSHOT_SCROLLBACK + snapshot.rows, allowProposedApi: true });

  try {
    await new Promise<void>((resolve) => term.write(snapshot.data, resolve));

    const buffer = term.buffer.active;
    const lines: string[] = [];
    const bullets: boolean[] = [];
    const isCode = (cell: Cell): boolean => isCodeCell(cell, ansiTheme);

    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index) as unknown as Line | undefined;

      lines.push(line === undefined ? '' : lineText(line, isCode));
      bullets.push(isReplyCell(line?.getCell(0)));
    }

    return { lines, bullets, cols: snapshot.cols, rows: snapshot.rows };
  } finally {
    term.dispose();
  }
}
