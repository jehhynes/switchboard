import { describe, expect, it } from 'vitest';
import { clip } from '../src/clip.js';

describe('clip', () => {
  it('trims short text and keeps it whole', () => {
    expect(clip('  short  ', 10)).toBe('short');
    expect(clip(null, 10)).toBe('');
  });

  it('keeps both ends at word boundaries and counts what it left out', () => {
    const text = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
    const clipped = clip(text, 60);

    expect(clipped).toBe('w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10\n[…333 characters omitted…]\nw94 w95 w96 w97 w98 w99');
  });
});
