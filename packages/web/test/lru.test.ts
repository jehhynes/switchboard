import { describe, expect, it } from 'vitest';
import { textCache } from '../src/lru.js';

describe('textCache', () => {
  it('TextCache_PastItsEntries_DropsTheLeastRecentlyUsed', () => {
    const cache = textCache<number>(2, 1000, 100);

    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect([cache.get('a'), cache.get('c'), cache.size]).toEqual([1, 3, 2]);
  });

  it('TextCache_PastItsCharacters_DropsTheOldestUntilItFits', () => {
    const cache = textCache<number>(10, 10, 10);

    cache.set('aaaa', 1);
    cache.set('bbbb', 2);
    cache.set('cccccc', 3);

    // 14 characters: the oldest goes, and the 10 left fit.
    expect(cache.get('aaaa')).toBeUndefined();
    expect([cache.get('bbbb'), cache.get('cccccc'), cache.chars]).toEqual([2, 3, 10]);
  });

  it('TextCache_KeyLongerThanTheLongest_IsNeverKept', () => {
    const cache = textCache<number>(10, 1000, 4);

    cache.set('short', 1);
    cache.set('tiny', 2);

    expect(cache.get('short')).toBeUndefined();
    expect([cache.get('tiny'), cache.size, cache.chars]).toEqual([2, 1, 4]);
  });

  it('TextCache_KeySetAgain_CountsItsCharactersOnce', () => {
    const cache = textCache<number>(10, 1000, 100);

    cache.set('same', 1);
    cache.set('same', 2);

    expect([cache.get('same'), cache.size, cache.chars]).toEqual([2, 1, 4]);
  });
});