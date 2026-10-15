import { WEEKDAYS } from './settings.js';
import type { ScheduleSettings } from './settings.js';

/** The source of a schedule's ticket, whose key is the schedule's name (PRD R82). */
export const SCHEDULE_SOURCE = 'schedule';

/** When the schedule runs, in words, such as `every week on fri at 12:00` or `by hand`; History shows its changes (PRD R82). */
export function scheduleText(schedule: Pick<ScheduleSettings, 'every' | 'day' | 'at'>): string {
  const { every, day, at } = schedule;

  if (every === null || at === null) {
    return 'by hand';
  }

  const time = `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;

  return every === 'day' ? `every day at ${time}` : `every ${every} on ${every === 'month' ? `day ${day}` : day} at ${time}`;
}

/** The day of the month, or the month's last day when it is shorter, at `minutes` after local midnight. */
function monthDue(year: number, month: number, day: number, minutes: number): Date {
  const last = new Date(year, month + 1, 0).getDate();

  return new Date(year, month, Math.min(day, last), 0, minutes);
}

/** The latest time at or before `now` the schedule came due, in local time; null for one that runs only by hand (PRD R82). */
export function latestDue(schedule: Pick<ScheduleSettings, 'every' | 'day' | 'at'>, now: number): number | null {
  const { every, day, at } = schedule;

  if (every === null || at === null) {
    return null;
  }

  const today = new Date(now);
  const [year, month, date] = [today.getFullYear(), today.getMonth(), today.getDate()];
  let due: Date;

  switch (every) {
    case 'day':
      due = new Date(year, month, date, 0, at);
      return (due.getTime() > now ? new Date(year, month, date - 1, 0, at) : due).getTime();
    case 'week': {
      const back = (today.getDay() - WEEKDAYS.indexOf(day as (typeof WEEKDAYS)[number]) + 7) % 7;

      due = new Date(year, month, date - back, 0, at);
      return (due.getTime() > now ? new Date(year, month, date - back - 7, 0, at) : due).getTime();
    }
    case 'month':
      due = monthDue(year, month, day as number, at);
      return (due.getTime() > now ? monthDue(year, month - 1, day as number, at) : due).getTime();
  }
}
