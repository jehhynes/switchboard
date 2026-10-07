/** A snooze the operator can pick: the wake time, or null to snooze until restored (PRD R49). */
export interface SnoozeChoice {
  label: string;
  /** The wake time as the picker shows it; empty for an indefinite snooze. */
  description: string;
  until: number | null;
}

/** The hour a day starts at: a snooze wakes at 6am local time, so "Tomorrow" at 2am means 6am the same morning. */
export const DAY_START_HOUR = 6;

/** The day `now` belongs to, as its 6am start in local time. */
function dayStart(now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAY_START_HOUR);

  if (start > now) {
    start.setDate(start.getDate() - 1);
  }

  return start;
}

/** 6am `days` days after the current day. */
export function daysFrom(now: Date, days: number): Date {
  const start = dayStart(now);

  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + days, DAY_START_HOUR);
}

/** 6am on the first Monday after the current day, plus `weeks - 1` weeks. */
export function mondaysFrom(now: Date, weeks: number): Date {
  const start = dayStart(now);
  const untilMonday = ((8 - start.getDay()) % 7) || 7;

  return daysFrom(now, untilMonday + 7 * (weeks - 1));
}

/** The wake time as the picker and the panel show it, such as `Mon, Oct 12, 6:00 AM`. */
export function wakeText(time: number): string {
  return new Date(time).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The snooze picker's choices: days wake at 6am that many days on, weeks on a Monday at 6am, and Indefinitely never (PRD R49). */
export function snoozeChoices(now: Date): SnoozeChoice[] {
  const timed = (label: string, date: Date): SnoozeChoice => ({ label, description: wakeText(date.getTime()), until: date.getTime() });

  return [
    timed('Tomorrow', daysFrom(now, 1)),
    timed('In 2 days', daysFrom(now, 2)),
    timed('In 3 days', daysFrom(now, 3)),
    timed('Next week', mondaysFrom(now, 1)),
    timed('In 2 weeks', mondaysFrom(now, 2)),
    timed('In 4 weeks', mondaysFrom(now, 4)),
    { label: 'Indefinitely', description: '', until: null },
  ];
}
