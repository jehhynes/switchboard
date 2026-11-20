import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { limitFromTranscript, readTranscriptLimit, resetFromText } from '../src/limit.js';

// 2026-11-20 12:34 PM in New York (UTC-5).
const NOW = Date.UTC(2026, 10, 20, 17, 34, 30);
const RESET = Date.UTC(2026, 10, 20, 18, 20);

// Scrubbed from Claude Code 2.1.329 transcripts of 2026-11-20 (mechanics M100).
const prompt = { type: 'user', message: { role: 'user', content: 'Review the PR.' }, origin: { kind: 'human' } };
const usage = {
  type: 'assistant',
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 1:20pm (America/New_York)" }] },
  apiError: 'usage_limit_reached',
  apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: RESET / 1000, rateLimitType: 'five_hour' } },
  quotaLimits: { status: 'rejected', resetsAt: RESET / 1000, rateLimitType: 'five_hour' },
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
};
const older = { type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your session limit · resets 1:20pm (America/New_York)" }] }, error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429 };
const weekly = { ...older, message: { content: [{ type: 'text', text: "You've hit your weekly limit · resets Nov 24, 4am (America/New_York)" }] } };
const throttle = {
  type: 'assistant',
  message: { content: [{ type: 'text', text: "API Error: Server is temporarily limiting requests (not your usage limit) · All credentials for model claude-opus-5-5 are cooling down (last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.) (reset after 14m43s)" }] },
  apiErrorIsTransient: true,
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  apiErrorType: 'rate_limit_error',
};
const wait = { type: 'system', subtype: 'informational', content: 'Usage limit reached · continuing automatically at 1:20pm · esc to cancel' };
const grace = { type: 'user', message: { role: 'user', content: "[Usage limit reached; a short grace allowance remains, then this turn is cut off without warning. …]" }, isMeta: true, usageLimitNote: 'wrap_up' };
const reply = { type: 'assistant', message: { content: [{ type: 'text', text: 'Your usage limit was reached, so the review is unfinished.' }] } };
const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } };
const reset = { type: 'system', subtype: 'informational', content: 'Usage limit reset · Continuing automatically' };
const continued = { type: 'user', message: { role: 'user', content: 'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.' }, isMeta: true, origin: { kind: 'auto-continuation' } };

describe('resetFromText (mechanics M100)', () => {
  it('reads a time today in the named zone, with or without minutes', () => {
    expect(resetFromText("You've hit your 5-hour limit · resets 1:20pm (America/New_York)", NOW)).toBe(RESET);
    expect(resetFromText("You've hit your session limit · resets 11pm (America/New_York)", NOW)).toBe(Date.UTC(2026, 10, 21, 4, 0));
  });

  it('reads a time earlier than now as tomorrow, but not one within the last minute', () => {
    expect(resetFromText('resets 11am (America/New_York)', NOW)).toBe(Date.UTC(2026, 10, 21, 16, 0));
    expect(resetFromText('resets 12:34pm (America/New_York)', NOW)).toBe(Date.UTC(2026, 10, 20, 17, 34));
  });

  it('reads a date, rolling a past one into next year', () => {
    expect(resetFromText("You've hit your weekly limit · resets Nov 24, 4am (America/New_York)", NOW)).toBe(Date.UTC(2026, 10, 24, 9, 0));
    expect(resetFromText('resets Jan 2, 4am (America/New_York)', NOW)).toBe(Date.UTC(2027, 0, 2, 9, 0));
  });

  it('follows the zone across a change of its offset', () => {
    // Summer time in New York ends on 2026-11-01; a reset in October is at UTC-4.
    expect(resetFromText('resets 1:20pm (America/New_York)', Date.UTC(2026, 9, 20, 16, 0))).toBe(Date.UTC(2026, 9, 20, 17, 20));
  });

  it("reads a gateway's relative reset, and nothing from text without a reset or with an unknown zone", () => {
    expect(resetFromText(throttle.message.content[0]!.text, NOW)).toBe(NOW + (14 * 60 + 43) * 1000);
    expect(resetFromText('API Error: Server is temporarily limiting requests (not your usage limit)', NOW)).toBeNull();
    expect(resetFromText('resets 1:20pm (Mars/Olympus)', NOW)).toBeNull();
  });
});

describe('limitFromTranscript (mechanics M100)', () => {
  it("reads a refused request's usage limit from its fields, and Claude Code's own wait after it", () => {
    expect(limitFromTranscript([prompt, usage], NOW)).toEqual({ kind: 'usage', window: 'five_hour', resetsAt: RESET, exact: true, cli: false, message: usage.message.content[0]!.text });
    expect(limitFromTranscript([prompt, usage, wait], NOW)).toMatchObject({ resetsAt: RESET, exact: true, cli: true });
  });

  it('reads an older line without fields from its text', () => {
    expect(limitFromTranscript([prompt, older], NOW)).toMatchObject({ kind: 'usage', window: null, resetsAt: RESET, exact: false });
    expect(limitFromTranscript([prompt, weekly], NOW)).toMatchObject({ kind: 'usage', resetsAt: Date.UTC(2026, 10, 24, 9, 0) });
  });

  it('reads a time in the text relative to when its line was written, so a later read gives the same reset', () => {
    const written = { ...older, timestamp: new Date(NOW).toISOString() };

    expect(limitFromTranscript([prompt, written], NOW + 3 * 3_600_000)).toMatchObject({ resetsAt: RESET });
    expect(limitFromTranscript([prompt, { ...throttle, timestamp: new Date(NOW).toISOString() }], NOW + 600_000)).toMatchObject({ resetsAt: NOW + 883_000 });
  });

  it('reads a throttle', () => {
    expect(limitFromTranscript([prompt, throttle], NOW)).toMatchObject({ kind: 'throttle', resetsAt: NOW + 883_000, exact: false, cli: false });
  });

  it("reads a turn that ended in the grace allowance, with the wait's time when Claude Code wrote one", () => {
    expect(limitFromTranscript([prompt, toolResult, grace, reply], NOW)).toEqual({ kind: 'usage', window: null, resetsAt: null, exact: false, cli: false, message: null });

    const at = new Date(NOW);
    at.setHours(13, 20, 0, 0);
    expect(limitFromTranscript([prompt, toolResult, grace, reply, wait], NOW)).toMatchObject({ resetsAt: at.getTime() < NOW - 60_000 ? at.getTime() + 86_400_000 : at.getTime(), cli: true });
  });

  it('reads only the current turn: none once Claude Code continued or a later prompt started', () => {
    expect(limitFromTranscript([prompt, usage, wait, reset, continued, reply], NOW)).toBeNull();
    expect(limitFromTranscript([prompt, usage, wait, prompt, reply], NOW)).toBeNull();
    expect(limitFromTranscript([prompt, reply], NOW)).toBeNull();
    expect(limitFromTranscript([], NOW)).toBeNull();
  });

  it("ignores a subagent's limit", () => {
    expect(limitFromTranscript([prompt, { ...usage, isSidechain: true }], NOW)).toBeNull();
  });
});

describe('readTranscriptLimit', () => {
  it('reads the end of the file, skipping a cut first line and bad lines, and gives null for a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'limit-'));
    const path = join(dir, 'session.jsonl');

    writeFileSync(path, [JSON.stringify({ type: 'user', message: { content: 'x'.repeat(600_000) } }), JSON.stringify(prompt), 'not json', JSON.stringify(usage), ''].join('\n'));
    expect(readTranscriptLimit(path, NOW)).toMatchObject({ resetsAt: RESET });
    expect(readTranscriptLimit(join(dir, 'missing.jsonl'), NOW)).toBeNull();
  });
});
