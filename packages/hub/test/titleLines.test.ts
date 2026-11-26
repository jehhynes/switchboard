import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { titleLines } from '../src/claudeConversation.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-title-lines-'));
  path = join(dir, 'n.jsonl');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (entry: object): string => JSON.stringify(entry) + '\n';
const ai = (title: string) => line({ type: 'ai-title', aiTitle: title });
const custom = (title: string) => line({ type: 'custom-title', customTitle: title });
const filler = (bytes: number) => line({ type: 'assistant', text: 'x'.repeat(bytes) });
/** Reads with a 64-byte chunk, returning the lines and the offsets handed to `advance`. */
const read = (offset: number) => {
  const offsets: number[] = [];
  const lines = titleLines(path, offset, (next) => offsets.push(next), 64);

  return { lines, offset: offsets.at(-1) ?? offset };
};

describe('titleLines (architecture.md § Conversation, mechanics M165)', () => {
  it('TitleLines_TitlesAcrossChunks_ReturnsTitleLinesInOrderUpToTheLastWholeLine', () => {
    const whole = filler(10) + ai('First') + filler(30) + custom('Second') + ai('Third');
    writeFileSync(path, whole + '{"type":"ai-title","aiTitle":"Ha');

    expect(read(0)).toEqual({ lines: [ai('First'), custom('Second'), ai('Third')].map((text) => text.trimEnd()), offset: Buffer.byteLength(whole) });

    appendFileSync(path, 'lf"}\n');
    expect(read(Buffer.byteLength(whole)).lines).toEqual([JSON.stringify({ type: 'ai-title', aiTitle: 'Half' })]);
  });

  it('TitleLines_LineLongerThanChunk_PassedOverAndLaterTitleFound', () => {
    // The long line mentions ai-title in its text, but no line longer than a chunk is a title line.
    const long = line({ type: 'assistant', text: `about ai-title ${'y'.repeat(300)}` });
    writeFileSync(path, ai('Before') + long + ai('After'));

    expect(read(0)).toEqual({ lines: [ai('Before').trimEnd(), ai('After').trimEnd()], offset: Buffer.byteLength(ai('Before') + long + ai('After')) });
  });

  it('TitleLines_LongLineNotWrittenWhole_ReadAgainFromItsStart', () => {
    const start = ai('Before');
    writeFileSync(path, start + `{"type":"assistant","text":"${'z'.repeat(300)}`);

    const first = read(0);
    expect(first).toEqual({ lines: [start.trimEnd()], offset: Buffer.byteLength(start) });

    appendFileSync(path, '"}\n' + custom('After'));
    expect(read(first.offset).lines).toEqual([custom('After').trimEnd()]);
  });

  it('TitleLines_UnparseableTitleLine_OffsetPassesIt', () => {
    const text = '{"type":"ai-title", broken\n' + filler(100) + ai('Fine');
    writeFileSync(path, text);

    expect(read(0)).toEqual({ lines: ['{"type":"ai-title", broken', ai('Fine').trimEnd()], offset: Buffer.byteLength(text) });
  });

  it('TitleLines_FileShrank_ReadFromItsStart', () => {
    writeFileSync(path, custom('New'));

    expect(read(10_000)).toEqual({ lines: [custom('New').trimEnd()], offset: Buffer.byteLength(custom('New')) });
  });

  it('TitleLines_MissingFile_Throws', () => {
    expect(() => titleLines(join(dir, 'none.jsonl'), 0, () => {})).toThrow();
  });
});
