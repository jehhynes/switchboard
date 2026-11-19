import { describe, expect, it } from 'vitest';
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

const tick = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('ScreenHold', () => {
  it('publishes a held copy when its time is up, once, with the text it grew to', async () => {
    const { screen, published } = hold();
    const handle = screen.screen('Part', false, undefined);

    expect(screen.screen('Part and more', false, handle)).toBe(handle);
    await tick(60);
    expect(published).toEqual([{ text: 'Part and more', via: 'screen', replaces: undefined }]);
  });

  it('updates a published copy that grows, and replaces it with the transcript copy', async () => {
    const { screen, published } = hold();
    const handle = screen.screen('One', false, undefined);

    await tick(60);

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

  it('withdraws a held copy without publishing it, and names the reply of a published one', async () => {
    const { screen, published } = hold();
    const held = screen.screen('Not a reply', false, undefined);

    expect(screen.withdraw(held)).toBeNull();
    await tick(60);
    expect(published).toEqual([]);

    const shown = screen.screen('Shown', false, undefined);

    await tick(60);
    expect(screen.withdraw(shown)).toBe('r1');
    expect(screen.withdraw(shown)).toBeNull();
  });
});
