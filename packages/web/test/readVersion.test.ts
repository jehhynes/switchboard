import { describe, expect, it, vi } from 'vitest';
import { readVersion } from '../src/readVersion.js';

describe('readVersion', () => {
  it('ReadVersion_TwoReadsInOneMillisecond_AreDistinct', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    const first = readVersion();
    const second = readVersion();

    expect(first).not.toBe(second);
    // Never a file view's ETag, which the hub quotes.
    expect(first).toMatch(/^read \d+$/);
    vi.restoreAllMocks();
  });
});
