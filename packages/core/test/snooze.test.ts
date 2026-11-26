import { describe, expect, it } from 'vitest';
import { daysFrom, nextMonday, snoozeChoices, wakeText } from '../src/snooze.js';

// Local times, because a snooze wakes at 6am where the operator is.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const six = (day: number) => at(day, 6).getTime();

describe('snoozeChoices (PRD R49)', () => {
  // Monday 5 October 2026, 9:54.
  const monday = at(5, 9, 54);

  it('offers days at 6am, Next week on a Monday, 14 and 28 days, and Never', () => {
    expect(snoozeChoices(monday).map((choice) => [choice.label, choice.description, choice.until])).toEqual([
      ['Tomorrow', 'Tue, Oct 6, 6:00 AM', six(6)],
      ['In 2 days', 'Wed, Oct 7, 6:00 AM', six(7)],
      ['In 3 days', 'Thu, Oct 8, 6:00 AM', six(8)],
      ['Next week', 'Mon, Oct 12, 6:00 AM', six(12)],
      ['In 2 weeks', 'Mon, Oct 19, 6:00 AM', six(19)],
      ['In 4 weeks', 'Mon, Nov 2, 6:00 AM', new Date(2026, 10, 2, 6).getTime()],
      ['Never', 'Until you unsnooze it', null],
    ]);
  });

  it('counts In 2 weeks and In 4 weeks as 14 and 28 days, whichever weekday it is', () => {
    // Saturday 10 October 2026.
    const until = (label: string) => snoozeChoices(at(10, 12)).find((choice) => choice.label === label)?.until;

    expect(until('In 2 weeks')).toBe(six(24));
    expect(until('In 4 weeks')).toBe(new Date(2026, 10, 7, 6).getTime());
  });

  it('leaves out a choice that wakes when an earlier one does', () => {
    const labels = (now: Date) => snoozeChoices(now).map((choice) => [choice.label, choice.description]);

    // Saturday: In 2 days is Monday.
    expect(labels(at(10, 12))).toEqual([
      ['Tomorrow', 'Sun, Oct 11, 6:00 AM'],
      ['In 2 days', 'Mon, Oct 12, 6:00 AM'],
      ['In 3 days', 'Tue, Oct 13, 6:00 AM'],
      ['In 2 weeks', 'Sat, Oct 24, 6:00 AM'],
      ['In 4 weeks', 'Sat, Nov 7, 6:00 AM'],
      ['Never', 'Until you unsnooze it'],
    ]);
    // Sunday: Tomorrow is Monday; Friday: In 3 days is.
    expect(labels(at(11, 12)).map(([label]) => label)).toEqual(['Tomorrow', 'In 2 days', 'In 3 days', 'In 2 weeks', 'In 4 weeks', 'Never']);
    expect(labels(at(9, 12)).map(([label]) => label)).toEqual(['Tomorrow', 'In 2 days', 'In 3 days', 'In 2 weeks', 'In 4 weeks', 'Never']);
    // Before 6am on Monday the day is still Sunday's.
    expect(labels(at(12, 1)).map(([label]) => label)).toEqual(['Tomorrow', 'In 2 days', 'In 3 days', 'In 2 weeks', 'In 4 weeks', 'Never']);
  });

  it('counts the day from 6am, so before 6am "Tomorrow" is 6am that same morning', () => {
    expect(daysFrom(at(6, 2, 30), 1)).toEqual(at(6, 6));
    expect(daysFrom(at(6, 5, 59), 1)).toEqual(at(6, 6));
    expect(daysFrom(at(6, 6), 1)).toEqual(at(7, 6));
    expect(daysFrom(at(6, 23, 59), 1)).toEqual(at(7, 6));
  });

  it('takes Next week as the first Monday after the current day, whichever weekday it is', () => {
    expect(nextMonday(at(5, 9))).toEqual(at(12, 6));
    // Sunday evening: tomorrow is Monday.
    expect(nextMonday(at(11, 20))).toEqual(at(12, 6));
    // Monday 1am still belongs to Sunday, so Next week is 6am that morning.
    expect(nextMonday(at(12, 1))).toEqual(at(12, 6));
    // Saturday.
    expect(nextMonday(at(10, 12))).toEqual(at(12, 6));  });

  it('shows the wake time with its weekday, date and 12-hour time', () => {
    expect(wakeText(at(12, 6).getTime())).toBe('Mon, Oct 12, 6:00 AM');
    expect(wakeText(at(12, 18, 5).getTime())).toBe('Mon, Oct 12, 6:05 PM');
  });
});
