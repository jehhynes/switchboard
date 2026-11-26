import { describe, expect, it } from 'vitest';
import { logLine, plainError, RepeatedLog, seconds } from '../src/log.js';

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
