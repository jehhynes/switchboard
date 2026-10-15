import { describe, expect, it } from 'vitest';
import { latestDue } from '../src/schedule.js';

// Local times, because a schedule runs at its time where the operator is.
const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month, day, hour, minute).getTime();
const NINE = 9 * 60;

describe('latestDue (PRD R82)', () => {
  it('is null for a schedule that runs only by hand', () => {
    expect(latestDue({ every: null, day: null, at: null }, at(9, 15, 12))).toBeNull();
  });

  it('is today at the time once it has passed, else yesterday', () => {
    const daily = { every: 'day' as const, day: null, at: NINE };

    expect(latestDue(daily, at(9, 15, 9))).toBe(at(9, 15, 9));
    expect(latestDue(daily, at(9, 15, 12))).toBe(at(9, 15, 9));
    expect(latestDue(daily, at(9, 15, 8, 59))).toBe(at(9, 14, 9));
    expect(latestDue(daily, at(9, 1, 8))).toBe(at(8, 30, 9));
  });

  it('is the latest weekday at the time, a week back when today is that day before the time', () => {
    // Thursday 15 October 2026.
    const friday = { every: 'week' as const, day: 'fri' as const, at: 12 * 60 };

    expect(latestDue(friday, at(9, 15, 12))).toBe(at(9, 9, 12));
    expect(latestDue(friday, at(9, 16, 11, 59))).toBe(at(9, 9, 12));
    expect(latestDue(friday, at(9, 16, 12))).toBe(at(9, 16, 12));
    expect(latestDue({ ...friday, day: 'sun' }, at(9, 18, 13))).toBe(at(9, 18, 12));
    expect(latestDue({ ...friday, day: 'thu' }, at(9, 15, 12, 1))).toBe(at(9, 15, 12));
  });

  it('is the day of this month once it has passed, else of last month', () => {
    const first = { every: 'month' as const, day: 1, at: NINE };

    expect(latestDue(first, at(9, 15, 12))).toBe(at(9, 1, 9));
    expect(latestDue(first, at(9, 1, 8))).toBe(at(8, 1, 9));
    expect(latestDue(first, at(0, 1, 8))).toBe(new Date(2025, 11, 1, 9).getTime());
  });

  it('runs a day the month lacks on its last day', () => {
    const last = { every: 'month' as const, day: 31, at: NINE };

    expect(latestDue(last, at(1, 28, 9))).toBe(at(1, 28, 9));
    expect(latestDue(last, at(1, 27, 12))).toBe(at(0, 31, 9));
    expect(latestDue(last, at(3, 15, 12))).toBe(at(2, 31, 9));
    expect(latestDue(last, at(4, 30, 12))).toBe(at(3, 30, 9));
  });
});
