import { describe, expect, it } from 'vitest';
import { failureOf } from '../src/exec.js';

describe('failureOf', () => {
  it('prefers stderr, then stdout, then the exit code', () => {
    const base = { code: 1, stdout: '', stderr: '', missing: false, timedOut: false };

    expect(failureOf('claude', { ...base, stderr: ' err ' }, 1000)).toBe('err');
    expect(failureOf('claude', { ...base, stdout: 'out' }, 1000)).toBe('out');
    expect(failureOf('claude', base, 1000)).toBe('claude exited with code 1.');
  });
});
