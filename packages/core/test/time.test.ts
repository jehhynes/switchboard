import { describe, expect, it } from 'vitest';
import { timeAgo, timeAt } from '../src/time.js';

describe('time formats (prd.md § Design rules)', () => {
  const now = new Date(2026, 10, 27, 15, 30).getTime();

  it('says how long ago in the largest whole unit', () => {
    expect([20_000, 4 * 60_000, 59 * 60_000, 2 * 3_600_000, 23 * 3_600_000, 25 * 3_600_000, 72 * 3_600_000].map((ago) => timeAgo(now - ago, now))).toEqual(['just now', '4 min ago', '59 min ago', '2 h ago', '23 h ago', '1 d ago', '3 d ago']);
  });

  it("gives the time alone on now's day, the day too on another, and the year in another year", () => {
    expect(timeAt(new Date(2026, 10, 27, 8, 44).getTime(), now)).toBe('8:44 AM');
    expect(timeAt(new Date(2026, 10, 24, 20, 5).getTime(), now)).toBe('Tue, Nov 24, 8:05 PM');
    expect(timeAt(new Date(2025, 10, 24, 8, 44).getTime(), now)).toBe('Mon, Nov 24, 2025, 8:44 AM');
  });

  it('gives the time alone under a day heading, and the day always when asked', () => {
    expect(timeAt(new Date(2026, 10, 24, 8, 44).getTime(), now, 'time')).toBe('8:44 AM');
    expect(timeAt(new Date(2026, 10, 27, 8, 44).getTime(), now, 'dated')).toBe('Fri, Nov 27, 8:44 AM');
  });
});
