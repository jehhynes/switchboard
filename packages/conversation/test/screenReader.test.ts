import { describe, expect, it } from 'vitest';
import { CONFIRM_MS, ScreenReader, isReplyCell, screenBlocks, unwrap } from '../src/screenReader.js';
import type { Cell } from '../src/screenReader.js';

const all = (): boolean => true;

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
    expect(screenBlocks(['● Done. [asi', '', '> '], all)).toEqual([null]);
    expect(screenBlocks(['● Answer', '', '> '], () => false)).toEqual([]);
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

  it('after a resize takes the screen as read, and publishes no growth of the block it was drawing', () => {
    const now = { t: 0 };
    const { screen, pushed } = reader(now);

    screen.read(['● Streaming', '', '> '], all);
    screen.skip(['● Old reply', '', '● Streaming', '', '> '], all);
    screen.read(['● Old reply', '', '● Streaming more', '', '> '], all);
    expect(pushed.map((push) => push.text)).toEqual(['Streaming']);
  });
});
