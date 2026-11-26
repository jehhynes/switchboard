import { describe, expect, it } from 'vitest';
import { logLine } from '../src/log.js';

describe('log lines', () => {
  it('writes the UTC time, the level padded to five characters and the text, keeping a stack\'s later lines', () => {
    const at = new Date('2026-11-26T01:04:18.123Z');
    expect(logLine(at, 'info', 'hub: started')).toBe('2026-11-26T01:04:18.123Z info  hub: started\n');
    expect(logLine(at, 'error', 'hub: unexpected error\n    at main.js:1')).toBe('2026-11-26T01:04:18.123Z error hub: unexpected error\n    at main.js:1\n');
    expect(logLine(at, 'debug', 'x')).toMatch(/Z debug x\n$/);
    expect(logLine(at, 'warn', 'x')).toMatch(/Z warn  x\n$/);
  });
});
