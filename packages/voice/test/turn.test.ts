import { describe, expect, it } from 'vitest';
import { normalizeTurnText, pauseWait, TEXT_QUIET_MS, TURN_SESSION_OPTIONS, textWait, turnPrompt } from '../src/turn.js';

describe('turn detection', () => {
  it('runs the turn model with threads that do not spin waiting for work after a run', () => {
    expect(TURN_SESSION_OPTIONS).toEqual({ intraOpNumThreads: 4, interOpNumThreads: 1, extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } });
  });

  it('waits the pause, twice after a dangling word', () => {
    expect(pauseWait('fix the login flow', 3000)).toBe(3000);
    expect(pauseWait('fix it and', 3000)).toBe(6000);
    expect(pauseWait('instead,', 3000)).toBe(6000);
  });

  it('shortens the wait on a log scale with the model\'s score, and not at all for a dangling word or a low score', () => {
    expect(textWait('fix it and', 0.9, 0.011, 3000)).toBe(0);
    expect(textWait('Fix it.', 0.001, 0.011, 3000)).toBe(TEXT_QUIET_MS);
    expect(textWait('fix it', 0.005, 0.011, 3000)).toBe(0);
    expect(textWait('fix it', 0.011, 0.011, 3000)).toBe(3000);
    expect(textWait('fix it', 0.6, 0.011, 3000)).toBe(TEXT_QUIET_MS);
    expect(textWait('fix it', 0.17, 0.011, 3000)).toBeCloseTo(1200, -2);
    expect(textWait('fix it', 0.025, 0.011, 3000)).toBeCloseTo(2460, -1);
  });

  it('writes the model\'s prompt from the last six turns, normalised, joined by speaker and open at the end', () => {
    expect(normalizeTurnText("Don't   STOP, re-run it!")).toBe("don't stop re-run it");
    expect(
      turnPrompt([
        { role: 'assistant', content: 'Which port?' },
        { role: 'user', content: '...' },
        { role: 'user', content: 'Use 8799,' },
        { role: 'user', content: 'please' },
      ]),
    ).toBe('<|im_start|>assistant\nwhich port<|im_end|>\n<|im_start|>user\nuse 8799 please');
  });
});
