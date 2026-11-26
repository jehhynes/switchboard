// A generated transcript over V8's string limit (mechanics M165); an integration test, since it writes 560 MB to disk.
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { READ_LINES_BYTES, readLines } from '../src/transcript.js';

it('ReadLines_TranscriptOver512MB_ReadInBoundedCallsToItsEnd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-big-'));
  const path = join(dir, 't.jsonl');

  try {
    const fd = openSync(path, 'w');
    const line = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(1000) } }) + '\n';
    const chunk = line.repeat(Math.floor((1 << 20) / line.length));
    const perChunk = Math.floor((1 << 20) / line.length);
    const chunks = 560;

    for (let n = 0; n < chunks; n++) writeSync(fd, chunk);
    writeSync(fd, JSON.stringify({ type: 'ai-title', aiTitle: 'Last' }) + '\n');
    closeSync(fd);

    let offset = 0;
    let count = 0;
    let last = '';

    for (;;) {
      const read = readLines(path, offset)!;
      expect(read.offset - offset).toBeLessThanOrEqual(READ_LINES_BYTES);
      if (read.offset === offset) break;
      count += read.lines.length;
      last = read.lines.at(-1) ?? last;
      offset = read.offset;
    }

    expect(count).toBe(chunks * perChunk + 1);
    expect(JSON.parse(last)).toEqual({ type: 'ai-title', aiTitle: 'Last' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
