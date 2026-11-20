import { describe, expect, it } from 'vitest';
import { FOCUS_DEBOUNCE_MS, Router } from '../src/routing.js';
import { Clock } from './fakes.js';

function setup(awayMinutes = 2) {
  const clock = new Clock();
  const changes: string[] = [];
  const router = new Router({ changed: (gen, sessionId, reason) => changes.push(`${gen} ${sessionId ?? 'none'} ${reason}`), awayMs: () => awayMinutes * 60_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const targets = [
    { sessionId: 'a', workItemId: 1 },
    { sessionId: 'b', workItemId: 2 },
  ];

  return { clock, changes, router, targets };
}

describe('Router', () => {
  it('follows the focused window after the debounce, and on a move stops at once and follows after it', () => {
    const { clock, changes, router, targets } = setup();

    router.update(targets, { sessionId: 'a', via: 'window' });
    clock.advance(FOCUS_DEBOUNCE_MS - 1);
    expect(changes).toEqual([]);
    clock.advance(1);
    expect(changes).toEqual(['1 a focus']);

    router.update(targets, { sessionId: 'b', via: 'window' });
    expect(changes).toEqual(['1 a focus', '2 none focus']);
    clock.advance(FOCUS_DEBOUNCE_MS);
    expect(changes).toEqual(['1 a focus', '2 none focus', '3 b focus']);
    expect(router.target).toBe('b');
    expect(router.gen).toBe(3);

    // A move and back within the debounce lands where the focus rests, under a new generation.
    router.update(targets, { sessionId: 'a', via: 'window' });
    router.update(targets, { sessionId: 'b', via: 'window' });
    clock.advance(FOCUS_DEBOUNCE_MS);
    expect(changes.slice(3)).toEqual(['4 none focus', '5 b focus']);
  });

  it('keeps the target while the focus is outside every scoped window, until the away timeout drops it', () => {
    const { clock, changes, router, targets } = setup(2);

    router.update(targets, { sessionId: 'a', via: 'window' });
    clock.advance(FOCUS_DEBOUNCE_MS);
    router.update(targets, null);
    clock.advance(2 * 60_000 - 1);
    expect(router.target).toBe('a');

    // Focus back on its window cancels the count, and a new away starts it again.
    router.update(targets, { sessionId: 'a', via: 'window' });
    router.update(targets, null);
    clock.advance(2 * 60_000 - 1);
    expect(router.target).toBe('a');
    clock.advance(1);
    expect(changes).toEqual(['1 a focus', '2 none gone']);
    expect(router.target).toBeNull();
  });

  it('moves at once on Talk here, refuses a session that cannot be a target, and times out from the dock with no window focused', () => {
    const { clock, changes, router, targets } = setup(1);

    router.update(targets, { sessionId: 'a', via: 'window' });
    expect(router.talkHere('b')).toBe(true);
    clock.advance(FOCUS_DEBOUNCE_MS);
    // The debounce of the focus on a did not undo Talk here.
    expect(changes).toEqual(['1 b talk-here']);
    expect(router.talkHere('c')).toBe(false);
    // Another window connecting, with the focus still where it was, does not undo Talk here.
    router.update([...targets, { sessionId: 'c', workItemId: 3 }], { sessionId: 'a', via: 'window' });
    clock.advance(FOCUS_DEBOUNCE_MS);
    expect(router.target).toBe('b');
    router.update(targets, { sessionId: 'a', via: 'window' });
    expect(router.talkHere('b')).toBe(true);
    expect(changes).toHaveLength(1);

    router.update(targets, null);
    expect(router.talkHere('a')).toBe(true);
    clock.advance(60_000);
    expect(changes).toEqual(['1 b talk-here', '2 a talk-here', '3 none gone']);
  });

  it('drops a target that is no longer eligible, and takes a focused session once it becomes one', () => {
    const { clock, changes, router, targets } = setup();

    router.update(targets, { sessionId: 'a', via: 'window' });
    clock.advance(FOCUS_DEBOUNCE_MS);
    router.update([targets[1]!], { sessionId: 'a', via: 'window' });
    expect(changes).toEqual(['1 a focus', '2 none gone']);
    clock.advance(FOCUS_DEBOUNCE_MS);
    expect(router.target).toBeNull();

    // Its session became full again.
    router.update(targets, { sessionId: 'a', via: 'window' });
    clock.advance(FOCUS_DEBOUNCE_MS);
    expect(changes).toEqual(['1 a focus', '2 none gone', '3 a focus']);
    router.close();
  });
});
