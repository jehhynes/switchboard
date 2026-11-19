import { describe, expect, it } from 'vitest';
import { readSnapshot } from '../src/screen.js';

const rgb = (hex: number): string => `\u001b[38;2;${hex >> 16};${(hex >> 8) & 255};${hex & 255}m`;
const RESET = '\u001b[0m';

describe('readSnapshot', () => {
  it("reads every line, scrollback included, with inline code in backticks and each bullet's colour", async () => {
    const data = [
      `${rgb(0x4eba65)}●${RESET} Bash(npm test)`,
      `${rgb(0xffffff)}●${RESET} The ${rgb(0xb1b9f9)}[rewrite]${RESET} rule is set.`,
      '',
      '> ',
    ].join('\r\n');
    const read = await readSnapshot({ data, cols: 60, rows: 3 });

    expect(read.lines.slice(0, 4)).toEqual(['● Bash(npm test)', '● The `[rewrite]` rule is set.', '', '>']);
    expect(read.bullets.slice(0, 2)).toEqual([false, true]);
    expect({ cols: read.cols, rows: read.rows }).toEqual({ cols: 60, rows: 3 });
  });

  it('reads palette blue as code only under an ANSI theme', async () => {
    const data = 'Run \u001b[34mnpm\u001b[0m now';

    expect((await readSnapshot({ data, cols: 40, rows: 2 })).lines[0]).toBe('Run npm now');
    expect((await readSnapshot({ data, cols: 40, rows: 2 }, true)).lines[0]).toBe('Run `npm` now');
  });
});
