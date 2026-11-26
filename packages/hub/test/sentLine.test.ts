import { describe, expect, it } from 'vitest';
import type { InputSteps } from '@switchboard/conversation';
import { SLOW_SEND_MS, sentLine } from '../src/conversation.js';

const steps = (over: Partial<InputSteps> = {}): InputSteps => ({ queuedAt: 0, startedAt: 0, readyAt: 10, waited: null, reads: 3, readMs: 20, pastedAt: 20, echoAt: 40, missed: null, enterAt: 50, enters: 1, confirmedAt: 700, ...over }) as InputSteps;

describe("a sent message's hub log line (operator decision 2026-11-25)", () => {
  it('is a short debug line when the message went quickly and every step was seen', () => {
    expect(sentLine(steps(), 900)).toEqual({ line: 'message sent in 0.9 s', level: 'debug' });
  });

  it('warns when it took over SLOW_SEND_MS, saying how long Claude Code took to record it or that it has not', () => {
    expect(sentLine(steps({ confirmedAt: 3_650 }), 4_200)).toEqual({ line: 'message sent, but slowly (4.2 s; Claude Code took 3.6 s to record it)', level: 'warn' });
    expect(sentLine(steps({ confirmedAt: null }), SLOW_SEND_MS + 1)).toEqual({ line: "message sent, but slowly (3.0 s; Claude Code's transcript has not shown it yet)", level: 'warn' });
    expect(sentLine(steps(), SLOW_SEND_MS).level).toBe('debug');
  });

  it('warns when its text was not seen in the input box', () => {
    expect(sentLine(steps({ echoAt: null }), 900)).toEqual({ line: 'message sent, but its text was not seen in the input box', level: 'warn' });
  });
});
