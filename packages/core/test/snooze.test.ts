import { describe, expect, it } from 'vitest';
import { daysFrom, mondaysFrom, snoozeChoices, wakeText } from '../src/snooze.js';

// Local times, because a snooze wakes at 6am where the operator is.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const six = (day: number) => at(day, 6).getTime();

describe('snoozeChoices (PRD R49)', () => {
  // Monday 5 October 2026, 9:54.
  const monday = at(5, 9, 54);

  it('offers days at 6am, weeks on a Monday at 6am, and Indefinitely', () => {
    expect(snoozeChoices(monday).map((choice) => [choice.label, choice.description, choice.until])).toEqual([
      ['Tomorrow', 'Tue, Oct 6, 6:00 AM', six(6)],
      ['In 2 days', 'Wed, Oct 7, 6:00 AM', six(7)],
      ['In 3 days', 'Thu, Oct 8, 6:00 AM', six(8)],
      ['Next week', 'Mon, Oct 12, 6:00 AM', six(12)],
      ['In 2 weeks', 'Mon, Oct 19, 6:00 AM', six(19)],
      ['In 4 weeks', 'Mon, Nov 2, 6:00 AM', new Date(2026, 10, 2, 6).getTime()],
      ['Indefinitely', '', null],
    ]);
  });

  it('counts the day from 6am, so before 6am "Tomorrow" is 6am that same morning', () => {
    expect(daysFrom(at(6, 2, 30), 1)).toEqual(at(6, 6));
    expect(daysFrom(at(6, 5, 59), 1)).toEqual(at(6, 6));
    expect(daysFrom(at(6, 6), 1)).toEqual(at(7, 6));
    expect(daysFrom(at(6, 23, 59), 1)).toEqual(at(7, 6));
  });

  it('takes Next week as the first Monday after the current day, whichever weekday it is', () => {
    expect(mondaysFrom(at(5, 9), 1)).toEqual(at(12, 6));
    // Sunday evening: tomorrow is Monday.
    expect(mondaysFrom(at(11, 20), 1)).toEqual(at(12, 6));
    // Monday 1am still belongs to Sunday, so Next week is 6am that morning.
    expect(mondaysFrom(at(12, 1), 1)).toEqual(at(12, 6));
    // Saturday.
    expect(mondaysFrom(at(10, 12), 1)).toEqual(at(12, 6));
    expect(mondaysFrom(at(10, 12), 2)).toEqual(at(19, 6));
  });

  it('shows the wake time with its weekday, date and 12-hour time', () => {
    expect(wakeText(at(12, 6).getTime())).toBe('Mon, Oct 12, 6:00 AM');
    expect(wakeText(at(12, 18, 5).getTime())).toBe('Mon, Oct 12, 6:05 PM');
  });
});
