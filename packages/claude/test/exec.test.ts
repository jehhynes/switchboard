import { describe, expect, it } from 'vitest';
import { failureOf } from '../src/exec.js';

describe('failureOf', () => {
  it('prefers stderr, then stdout, then the exit code', () => {
    const base = { code: 1, stdout: '', stderr: '', missing: false, timedOut: false };

    expect(failureOf('claude', { ...base, stderr: ' err ' }, 1000)).toBe('err');
    expect(failureOf('claude', { ...base, stdout: 'out' }, 1000)).toBe('out');
    expect(failureOf('claude', base, 1000)).toBe('claude exited with code 1.');
  });

  it('names a missing executable with the message given for one that is not Claude Code', () => {
    const missing = { code: null, stdout: '', stderr: '', missing: true, timedOut: false };

    expect(failureOf('/usr/bin/node', missing, 1000, { notFound: '/usr/bin/node was not found.' })).toBe('/usr/bin/node was not found.');
    expect(failureOf('claude', missing, 1000)).toBe('Claude Code was not found at claude. Install it or set sessions.claudePath.');
  });
});
