import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogTail } from '../src/hubLog.js';

describe('LogTail', () => {
  let dir: string;
  let path: string;
  let written: string[];
  let tail: LogTail;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-log-'));
    path = join(dir, 'hub.log');
    written = [];
    tail = new LogTail(path, (text) => written.push(text), 20);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts with the end of a long file from its first whole line', () => {
    writeFileSync(path, 'first line is long\nsecond\nthird\n');

    tail.read();

    expect(written).toEqual(['second\nthird\n']);
  });

  it('keeps the first line of a tail that starts at a line start', () => {
    writeFileSync(path, `ab\n${'c'.repeat(19)}\n`);

    tail.read();

    expect(written).toEqual([`${'c'.repeat(19)}\n`]);
  });

  it('starts with the whole of a short file', () => {
    writeFileSync(path, 'a\nb\n');

    tail.read();

    expect(written).toEqual(['a\nb\n']);
  });

  it('writes only whole lines added since the last read', () => {
    writeFileSync(path, 'a\n');
    tail.read();
    appendFileSync(path, 'b\nhalf');
    tail.read();
    tail.read();
    appendFileSync(path, ' done\n');
    tail.read();

    expect(written).toEqual(['a\n', 'b\n', 'half done\n']);
  });

  it('waits for a line start when the tail holds none', () => {
    writeFileSync(path, 'x'.repeat(30));
    tail.read();
    appendFileSync(path, '\nnext\n');
    tail.read();

    expect(written).toEqual(['next\n']);
  });

  it('keeps a UTF-8 character split across writes whole', () => {
    const dash = Buffer.from('—');

    writeFileSync(path, Buffer.concat([Buffer.from('a'), dash.subarray(0, 1)]));
    tail.read();
    appendFileSync(path, Buffer.concat([dash.subarray(1), Buffer.from('b\n')]));
    tail.read();

    expect(written).toEqual(['a—b\n']);
  });

  it('writes nothing for a missing file and reads it once it exists', () => {
    tail.read();
    writeFileSync(path, 'a\n');
    tail.read();

    expect(written).toEqual(['a\n']);
  });

  it('reads a file that shrank from its start', () => {
    writeFileSync(path, 'old line\n');
    tail.read();
    writeFileSync(path, 'new\n');
    tail.read();

    expect(written).toEqual(['old line\n', '--- hub.log was replaced; reading it from the start ---\n', 'new\n']);
  });

  it('reads a file that shrank from its start when it is still longer than the whole lines read', () => {
    writeFileSync(path, `old line\n${'x'.repeat(100)}`);
    tail = new LogTail(path, (text) => written.push(text), 1000);
    tail.read();
    writeFileSync(path, 'replacement log\n');
    tail.read();

    expect(written).toEqual(['old line\n', '--- hub.log was replaced; reading it from the start ---\n', 'replacement log\n']);
  });
});
