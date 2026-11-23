import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIRM_MS, ScreenReader, isReplyCell, screenBlocks, unwrap } from '../src/screenReader.js';
import type { Cell } from '../src/screenReader.js';
import { parseReply } from '../src/tags.js';

const all = (): boolean => true;
/** A screen recorded from Claude Code's Focus view; each "●" at a line's start counts as a reply's. */
const recorded = (name: string): { lines: string[]; bullet: (index: number) => boolean } => {
  const lines = readFileSync(join(import.meta.dirname, 'fixtures', 'screens', `${name}.txt`), 'utf8').split('\n');

  return { lines, bullet: (index) => lines[index]!.startsWith('● ') };
};

function reader(now: { t: number }) {
  const pushed: Array<{ text: string; aside: boolean; replaces: number | undefined; id: number }> = [];
  let next = 1;
  const screen = new ScreenReader((text, aside, replaces) => {
    pushed.push({ text, aside, replaces, id: next });
    return next++;
  }, () => now.t);

  return { screen, pushed };
}

const cell = (fg: { rgb?: number; palette?: number }, dim = false): Cell => ({
  isDim: () => dim,
  getFgColor: () => fg.rgb ?? fg.palette ?? 0,
  isFgPalette: () => fg.palette !== undefined,
  isFgRGB: () => fg.rgb !== undefined,
  getChars: () => '●',
  getWidth: () => 1,
});

describe('screen blocks', () => {
  it('reads a reply block once something is drawn after it, joining wrapped lines and keeping list items and tags apart', () => {
    const lines = ['● [rewrite]', '  The fix is in, and the', '  tests pass.', '  - one', '  - two', '', '> '];

    expect(screenBlocks(lines, all)).toEqual(['[rewrite]\nThe fix is in, and the tests pass.\n- one\n- two']);
    // Still being drawn: nothing follows it.
    expect(screenBlocks(lines.slice(0, 5), all)).toEqual([]);
  });

  it('skips tool calls, their output, menus of numbered options, and a tag still being drawn', () => {
    expect(screenBlocks(['● Bash(echo hi)', '  ⎿  hi', '', '> '], all)).toEqual([]);
    expect(screenBlocks(['● How is Claude doing this session? (optional)', '  1: Bad    2: Fine   3: Good   0: Dismiss', '', '> '], all)).toEqual([]);
    // An artifact tag keeps a line of its own, its wrapped rest joined to it, so the view never shows it; one still being drawn waits.
    expect(screenBlocks(['● Report ready.', '  [artifact: D:/git/research/topic/2026-11-23/report/', '  summary.md]', '  Next.', '', '> '], all)).toEqual(['Report ready.\n[artifact: D:/git/research/topic/2026-11-23/report/ summary.md]\nNext.']);
    expect(parseReply(screenBlocks(['● Report ready.', '  [artifact: D:/r/summary.md]', '  Next.', '', '> '], all)[0]!)).toMatchObject({ opening: 'Report ready.\nNext.', speak: 'Report ready.\nNext.' });
    expect(screenBlocks(['● Report ready.', '  [artifact: D:/git/research/rep', '', '> '], all)).toEqual([null]);
    expect(screenBlocks(['● Done. [asi', '', '> '], all)).toEqual([null]);
    expect(screenBlocks(['● Answer', '', '> '], () => false)).toEqual([]);
  });

  it('ends a reply at the Focus view row of a running tool call, whose bullet blinks blank (Claude Code 2.1.330)', () => {
    const { lines, bullet } = recorded('focus-working');

    expect(screenBlocks(lines, bullet)).toEqual(["I'll run the PowerShell command that sleeps 10 seconds and prints the date."]);

    // The row with its bullet drawn is no reply either, whatever its colour.
    const drawn = lines.map((line) => (line === '  Working… (ctrl+o to expand)' ? '● Working… (ctrl+o to expand)' : line));

    expect(screenBlocks(drawn, all)).toEqual(["I'll run the PowerShell command that sleeps 10 seconds and prints the date."]);
  });

  it('keeps a reply that names the shortcut in a sentence of its own', () => {
    for (const line of ['Use (ctrl+o to expand)', 'Press it (ctrl+o to expand).', 'To see a long result in full, press the key Claude Code names (ctrl+o to expand)', 'Note: it folds (ctrl+o to expand)']) {
      expect(screenBlocks(['● Here is how.', '', `  ${line}`, '', '> '], all)).toEqual([`Here is how.\n\n${line}`]);
      expect(screenBlocks([`● ${line}`, '', '> '], all)).toEqual([line]);
    }

    // Within a paragraph, not after a blank line, a short line ending in the shortcut is the reply's.
    expect(screenBlocks(['● Folded rows end in', '  Ran 2 tools (ctrl+o to expand)', '', '> '], all)).toEqual(['Folded rows end in Ran 2 tools (ctrl+o to expand)']);
  });

  it('reads a reply shown as a thinking summary without its "· summary" or the running tool call row after it', () => {
    const { lines, bullet } = recorded('focus-summary');

    expect(screenBlocks(lines, bullet)).toEqual([
      'The Status tab fix will stop showing question cards, since only numbered items with lettered options become cards and items three and four lacked options. The landscape fix is merged, so rotated phones keep the phone layout.',
    ]);
  });

  it("keeps a code fence's lines as they are and joins none into it", () => {
    expect(unwrap(['Run:', '```', 'npm test', '  --watch', '```', 'then check.'])).toBe('Run:\n```\nnpm test\n  --watch\n```\nthen check.');
    // A status tag's line stands alone, so the status still splits off.
    expect(unwrap(['Done. And', 'more', '[status]', 'next line', 'joined'])).toBe('Done. And more\n[status]\nnext line joined');
  });

  it("tells a reply's bullet from a tool call's by its colour", () => {
    expect(isReplyCell(cell({ rgb: 0xffffff }))).toBe(true);
    expect(isReplyCell(cell({ rgb: 0x4eba65 }))).toBe(false);
    expect(isReplyCell(cell({ rgb: 0xff6b80 }))).toBe(false);
    expect(isReplyCell(cell({ rgb: 0x999999 }))).toBe(false);
    expect(isReplyCell(cell({ rgb: 0x5769f7 }))).toBe(false);
    expect(isReplyCell(cell({ palette: 2 }))).toBe(false);
    expect(isReplyCell(cell({ palette: 7 }))).toBe(true);
    expect(isReplyCell(cell({ rgb: 0xffffff }, true))).toBe(false);
  });
});

describe('ScreenReader', () => {
  it('publishes a reply once, grows it in place while it streams, and does not publish a redraw of it', () => {
    const now = { t: 1000 };
    const { screen, pushed } = reader(now);

    screen.read(['● First part', '', '> '], all);
    now.t += 100;
    screen.read(['● First part and the rest', '', '> '], all);
    screen.read(['● First part and the rest', '', '> '], all);

    expect(pushed).toEqual([
      { text: 'First part', aside: false, replaces: undefined, id: 1 },
      { text: 'First part and the rest', aside: false, replaces: 1, id: 2 },
    ]);
  });

  it('publishes nothing whose transcript copy already came', () => {
    const { screen, pushed } = reader({ t: 0 });

    screen.sent.add('Alreadysent');
    screen.read(['● Already sent.', '', '> '], all);
    expect(pushed).toEqual([]);
  });

  it('withdraws a copy that gets no transcript copy once Claude is idle, and keeps it while Claude works', () => {
    const now = { t: 0 };
    const { screen } = reader(now);

    screen.read(['● Maybe a reply', '', '> '], all);
    now.t = CONFIRM_MS + 1;
    expect(screen.unconfirmed(0, true)).toEqual([]);
    now.t += CONFIRM_MS + 1;
    expect(screen.unconfirmed(0, false)).toEqual([1]);
    expect(screen.take('Maybeareply')).toBeUndefined();
  });

  it('withdraws a copy once a later assistant line reaches the transcript without it', () => {
    const { screen } = reader({ t: 0 });

    screen.read(['● Not a reply', '', '> '], all);
    expect(screen.unconfirmed(2_000, true)).toEqual([1]);
  });

  it('adopts a copy an earlier process left waiting, so it is withdrawn when no transcript copy comes', () => {
    const now = { t: 0 };
    const { screen, pushed } = reader(now);

    screen.adopt('Leftover', 41, false);
    screen.read(['● Leftover', '', '> '], all);
    expect(pushed).toEqual([]);
    now.t = CONFIRM_MS + 1;
    expect(screen.unconfirmed(0, false)).toEqual([41]);
  });

  it('takes no reply as the growth of an adopted copy with an empty key', () => {
    const { screen, pushed } = reader({ t: 0 });

    screen.adopt('', 41, true);
    screen.read(['● Another reply', '', '> '], all);
    expect(pushed).toEqual([{ text: 'Another reply', aside: false, replaces: undefined, id: 1 }]);
  });

  it('after a resize takes the screen as read, and publishes no growth of the block it was drawing', () => {
    const now = { t: 0 };
    const { screen, pushed } = reader(now);

    screen.read(['● Streaming', '', '> '], all);
    screen.skip(['● Old reply', '', '● Streaming', '', '> '], all);
    screen.read(['● Old reply', '', '● Streaming more', '', '> '], all);
    expect(pushed.map((push) => push.text)).toEqual(['Streaming']);
  });
});
