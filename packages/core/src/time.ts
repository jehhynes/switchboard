/**
 * The two ways Switchboard writes a time (prd.md § Design rules): how long ago, and when. Imports nothing, for browser bundles.
 */

const CLOCK = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DATED = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const DATED_YEAR = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** How long ago, in the largest whole unit: "just now", "4 min ago", "2 h ago", "3 d ago". */
export function timeAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);

  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
}

/**
 * When, in local time: "8:44 AM" on `now`'s day, "Tue, Nov 24, 8:44 AM" on another day of its year, and "Tue, Nov 24, 2025, 8:44 AM" in
 * another year. `time` gives the time alone, under a heading that names the day; `dated` always gives the day.
 */
export function timeAt(at: number, now: number, form: 'auto' | 'time' | 'dated' = 'auto'): string {
  const date = new Date(at);
  const today = new Date(now);

  if (form === 'time' || (form === 'auto' && date.toDateString() === today.toDateString())) {
    return CLOCK.format(at);
  }

  return (date.getFullYear() === today.getFullYear() ? DATED : DATED_YEAR).format(at);
}
