import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenHold } from '../src/screenHold.js';
import type { Via } from '../src/screenHold.js';

function hold(wait = 20) {
  const published: Array<{ text: string; via: Via; replaces: string | undefined }> = [];
  let next = 0;
  const screen = new ScreenHold(
    (text, _at, _aside, via, replaces) => {
      published.push({ text, via, replaces });
      return replaces ?? `r${++next}`;
    },
    { wait },
  );

  return { screen, published };
}

describe('ScreenHold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes a held copy when its time is up, once, with the text it grew to', () => {
    const { screen, published } = hold();
    const handle = screen.screen('Part', false, undefined);

    expect(screen.screen('Part and more', false, handle)).toBe(handle);
    vi.advanceTimersByTime(19);
    expect(published).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(published).toEqual([{ text: 'Part and more', via: 'screen', replaces: undefined }]);
    vi.advanceTimersByTime(100);
    expect(published).toHaveLength(1);
  });

  it('updates a published copy that grows, and replaces it with the transcript copy', () => {
    const { screen, published } = hold();
    const handle = screen.screen('One', false, undefined);

    vi.advanceTimersByTime(20);

    const grown = screen.screen('One two', false, handle);

    expect(screen.transcript(grown, 'One two.', 5, false)).toBe('r1');
    expect(published).toEqual([
      { text: 'One', via: 'screen', replaces: undefined },
      { text: 'One two', via: 'screen', replaces: 'r1' },
      { text: 'One two.', via: 'transcript', replaces: 'r1' },
    ]);
  });

  it('publishes a transcript copy with no screen copy as a new reply', () => {
    const { screen, published } = hold();

    expect(screen.transcript(undefined, 'Only from the transcript.', 5, false)).toBe('r1');
    expect(published).toEqual([{ text: 'Only from the transcript.', via: 'transcript', replaces: undefined }]);
  });

  it('withdraws a held copy without publishing it, and names the reply of a published one', () => {
    const { screen, published } = hold();
    const held = screen.screen('Not a reply', false, undefined);

    expect(screen.withdraw(held)).toBeNull();
    vi.advanceTimersByTime(100);
    expect(published).toEqual([]);

    const shown = screen.screen('Shown', false, undefined);

    vi.advanceTimersByTime(20);
    expect(screen.withdraw(shown)).toBe('r1');
    expect(screen.withdraw(shown)).toBeNull();
  });
});
