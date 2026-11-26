import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { logLine, plainError, RepeatedLog, rotateLog, seconds } from '../src/log.js';

describe('log lines', () => {
  it('writes the UTC time, the level padded to five characters and the text, keeping a stack\'s later lines', () => {
    const at = new Date('2026-11-26T01:04:18.123Z');
    expect(logLine(at, 'info', 'hub: started')).toBe('2026-11-26T01:04:18.123Z info  hub: started\n');
    expect(logLine(at, 'error', 'hub: unexpected error\n    at main.js:1')).toBe('2026-11-26T01:04:18.123Z error hub: unexpected error\n    at main.js:1\n');
    expect(logLine(at, 'debug', 'x')).toMatch(/Z debug x\n$/);
    expect(logLine(at, 'warn', 'x')).toMatch(/Z warn  x\n$/);
  });
});

describe('repeated warnings', () => {
  it('logs the first in full, counts repeats, says how many at most once an hour, and logs a recovery only after a warning', () => {
    const lines: Array<[string, string | undefined]> = [];
    let now = Date.parse('2026-11-26T01:00:00Z');
    const repeated = new RepeatedLog((line, level) => lines.push([line, level]), () => now);

    repeated.recovered('roster', 'readable again');
    expect(lines).toEqual([]);
    repeated.warn('roster', 'could not list');
    for (let i = 0; i < 14; i++) {
      now += 60_000;
      repeated.warn('roster', 'could not list');
    }
    expect(lines).toEqual([['could not list', 'warn']]);
    now = Date.parse('2026-11-26T02:00:00Z');
    repeated.warn('roster', 'could not list');
    expect(lines.at(-1)).toEqual(['could not list (15 times since 01:00 UTC)', 'warn']);
    // Another key is its own warning.
    repeated.warn('other', 'other failed', 'error');
    expect(lines.at(-1)).toEqual(['other failed', 'error']);
    repeated.recovered('roster', 'readable again');
    expect(lines.at(-1)).toEqual(['readable again', 'info']);
    repeated.recovered('roster', 'readable again');
    expect(lines.filter(([line]) => line === 'readable again')).toHaveLength(1);
    // After a recovery the next failure is logged in full again.
    repeated.warn('roster', 'could not list');
    expect(lines.at(-1)).toEqual(['could not list', 'warn']);
  });

  it('writes durations in seconds and errors without their Error prefix', () => {
    expect(seconds(896)).toBe('0.9 s');
    expect(seconds(-5)).toBe('0.0 s');
    expect(plainError(new Error('database is not open'))).toBe('database is not open');
    expect(plainError('text')).toBe('text');
  });
});

describe('log rotation (architecture.md § Hub log)', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

  it('keeps a missing or small log, and renames one at the limit to .1, replacing the previous one', () => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-rotate-'));
    const path = join(dir, 'hub.log');
    expect(rotateLog(path, 10)).toBe('kept');
    writeFileSync(path, '123456789');
    expect(rotateLog(path, 10)).toBe('kept');
    writeFileSync(`${path}.1`, 'older');
    appendFileSync(path, '0');
    expect(rotateLog(path, 10)).toBe('rotated');
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('1234567890');
  });

  it('renames a log another process holds open for appending, which goes on writing to the renamed file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-rotate-'));
    const path = join(dir, 'hub.log');
    writeFileSync(path, 'x'.repeat(20));
    // The hub's own output: a detached child appending to the file through its inherited stdout, as hub.js start runs it.
    const fd = openSync(path, 'a');
    const child = spawn(process.execPath, ['-e', "process.stdin.once('data', () => { process.stdout.write('after\\n'); process.exit(0); })"], { stdio: ['pipe', fd, fd] });
    closeSync(fd);
    try {
      expect(rotateLog(path, 10)).toBe('rotated');
      const exited = new Promise((done) => child.once('exit', done));
      child.stdin!.write('go');
      await exited;
      expect(readFileSync(`${path}.1`, 'utf8')).toBe(`${'x'.repeat(20)}after\n`);
      expect(existsSync(path)).toBe(false);
    } finally {
      child.kill();
    }
  });

  it('appends a warning and keeps the log when the rename fails', () => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-rotate-'));
    const path = join(dir, 'hub.log');
    writeFileSync(path, 'x'.repeat(20));
    // A folder in the way of hub.log.1 makes the rename fail on every platform.
    mkdirSync(`${path}.1`);
    writeFileSync(join(`${path}.1`, 'keep'), '');
    expect(rotateLog(path, 10, new Date('2026-11-26T01:00:00Z'))).toBe('failed');
    expect(readFileSync(path, 'utf8')).toMatch(/^x{20}2026-11-26T01:00:00\.000Z warn  hub: hub\.log is over 0 MB but could not be renamed to hub\.log\.1: .+; trying again at the next start\n$/);
  });
});
