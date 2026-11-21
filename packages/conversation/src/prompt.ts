import { createHash } from 'node:crypto';
import headless from '@xterm/headless';

/**
 * A prompt Claude Code shows in its terminal and waits on, as the web page shows it (architecture.md § Web page): a permission prompt or an
 * AskUserQuestion form, read from the visible screen in the classic renderer (mechanics M102).
 */
export interface ScreenPrompt {
  /** A hash of the prompt's lines, which a key names, so a key goes only to the prompt the operator saw. */
  id: string;
  /** The prompt as the terminal draws it, from below the rule above it to the screen's last line, trailing blank lines left out. */
  lines: string[];
  /** Its numbered options, each answered by its digit; "Type something", which needs typing, is left out. */
  options: Array<{ key: string; label: string; selected: boolean }>;
  /** A question form's tab strip ("← ☐ Color ✔ Submit →") is shown, so → moves to the next question or to Submit. */
  next: boolean;
}

/** A key the page may send to a prompt: an option's digit, Escape, or → on a question form. */
export type PromptKey = `${number}` | 'escape' | 'next';

const RULE = /^\s*[─━]{10,}/;
const OPTION = /^\s*(❯\s*)?(\d)\.\s+(.*?)\s*$/;
const TABS = /^\s*←.*→\s*$/;

/** Reads the prompt on the visible screen's rows, or null when none is shown: no numbered option 1, or none with the cursor and no "Esc to cancel" or "Enter to …" line. */
export function readPrompt(rows: readonly string[]): ScreenPrompt | null {
  const lines = [...rows];

  while (lines.length > 0 && lines.at(-1)!.trim() === '') {
    lines.pop();
  }

  let first = -1;

  for (let index = lines.length - 1; index >= 0 && first === -1; index--) {
    first = OPTION.exec(lines[index]!)?.[2] === '1' ? index : -1;
  }

  // A menu has the cursor on one of its options, or says how to answer it, as the input guard reads a menu (screenState.menu).
  if (first === -1 || !lines.slice(first).some((line) => /^\s*❯\s*\d\.\s/.test(line) || /Esc to (cancel|exit|go back)|Enter to (confirm|select)/i.test(line))) {
    return null;
  }

  let start = first;

  while (start > 0 && !RULE.test(lines[start - 1]!)) {
    start--;
  }

  const shown = lines.slice(start).map((line) => line.trimEnd());
  const options: ScreenPrompt['options'] = [];
  let expected = 1;

  for (const line of lines.slice(first)) {
    const match = OPTION.exec(line);

    if (match === null || Number(match[2]) !== expected) {
      continue;
    }

    expected++;

    if (!/^(\[.\]\s*)?Type something\.?$/i.test(match[3]!)) {
      options.push({ key: match[2]!, label: match[3]!, selected: match[1] !== undefined });
    }
  }

  return { id: createHash('sha256').update(shown.join('\n')).digest('hex').slice(0, 16), lines: shown, options, next: shown.some((line) => TABS.test(line)) };
}

/** The visible screen's rows of a holder snapshot, as plain text. */
export async function screenRows(snapshot: { data: string; cols: number; rows: number }): Promise<string[]> {
  const term = new headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: snapshot.rows, allowProposedApi: true });

  try {
    await new Promise<void>((resolve) => term.write(snapshot.data, resolve));

    const buffer = term.buffer.active;
    const rows: string[] = [];

    for (let row = buffer.baseY; row < buffer.baseY + snapshot.rows; row++) {
      rows.push((buffer.getLine(row) as unknown as { translateToString(trim: boolean): string } | undefined)?.translateToString(true) ?? '');
    }

    return rows;
  } finally {
    term.dispose();
  }
}

/** The bytes a prompt key writes: the digit, Escape, or the right arrow. */
export function promptKeyData(key: PromptKey): string {
  return key === 'escape' ? '\u001b' : key === 'next' ? '\u001b[C' : key;
}
