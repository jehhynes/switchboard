import { describe, expect, it } from 'vitest';
import { failureOf } from '../src/exec.js';

describe('failureOf', () => {
  it('prefers stderr, then stdout, then the exit code', () => {
    const base = { code: 1, stdout: '', stderr: '', missing: false, timedOut: false };

    expect(failureOf('claude', { ...base, stderr: ' err ' }, 1000)).toBe('err');
    expect(failureOf('claude', { ...base, stdout: 'out' }, 1000)).toBe('out');
    expect(failureOf('claude', base, 1000)).toBe('claude exited with code 1.');
  });

  it('shows the result text of JSON output, as a usage-limit failure gives, instead of the JSON', () => {
    const base = { code: 1, stderr: '', missing: false, timedOut: false };
    const limit = { type: 'result', subtype: 'success', is_error: true, api_error: 'usage_limit_reached', result: "You've hit your session limit · resets 11pm (America/New_York)" };

    expect(failureOf('claude', { ...base, stdout: JSON.stringify(limit) }, 1000)).toBe(limit.result);
    expect(failureOf('claude', { ...base, stdout: JSON.stringify([{ type: 'system', subtype: 'init' }, limit]) }, 1000)).toBe(limit.result);
    expect(failureOf('claude', { ...base, stdout: JSON.stringify({ type: 'result', result: '' }) }, 1000)).toBe('{"type":"result","result":""}');
    expect(failureOf('claude', { ...base, stdout: '[1, null]' }, 1000)).toBe('[1, null]');
    expect(failureOf('claude', { ...base, stderr: 'err', stdout: JSON.stringify(limit) }, 1000)).toBe('err');
  });

  it.each([
    ['a whitespace result', '{"type":"result","result":"  "}'],
    ['a non-string result', '{"type":"result","result":3}'],
    ['no result', '{"type":"result"}'],
    ['a result on another message type', '{"type":"assistant","result":"text"}'],
  ])('keeps the raw output for JSON with %s', (_case, stdout) => {
    expect(failureOf('claude', { code: 1, stdout, stderr: '', missing: false, timedOut: false }, 1000)).toBe(stdout);
  });

  it('names a missing executable with the message given for one that is not Claude Code', () => {
    const missing = { code: null, stdout: '', stderr: '', missing: true, timedOut: false };

    expect(failureOf('/usr/bin/node', missing, 1000, { notFound: '/usr/bin/node was not found.' })).toBe('/usr/bin/node was not found.');
    expect(failureOf('claude', missing, 1000)).toBe('Claude Code was not found at claude. Install it or set sessions.claudePath.');
  });
});
