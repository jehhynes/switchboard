import type { Ticket, Immediacy, Severity } from './model.js';

export interface TicketClassification {
  ticketId: number;
  playbook: string;
  immediacy: Immediacy | null;
  severity: Severity | null;
  at: number;
}

export interface VolumeSource {
  source: string;
  startedAt: number;
  lastAt: number;
  interval: number;
  timezone: string;
}

export interface VolumeData {
  classifications?: TicketClassification[];
  sources: VolumeSource[];
  tickets: Ticket[];
  changes: { ticketId: number; at: number; fields: Record<string, [unknown, unknown]> }[];
  worked: { ticketId: number; at: number }[];
  gaps: { source: string; from: number; to: number }[];
}

export const VOLUME_METRICS = ['seen', 'entered', 'left', 'open', 'assigned', 'worked', 'mine'] as const;
export type VolumeMetric = typeof VOLUME_METRICS[number];
export interface VolumeDetail { id: number; source: string; ref: string; title: string; url: string; at: number; classification: TicketClassification | null }
export interface VolumeWeek {
  week: string;
  from: number;
  to: number;
  coverage: 'unavailable' | 'partial' | 'observed';
  counts: Record<VolumeMetric, number>;
  details: Record<VolumeMetric, VolumeDetail[]>;
}

function calendar(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (name: string) => Number(parts.find((p) => p.type === name)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'));
}

/** Convert a local calendar midnight to UTC without assuming a fixed DST offset. */
function midnight(day: number, timezone: string): number {
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let at = day;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = format.formatToParts(at);
    const get = (name: string) => Number(parts.find((p) => p.type === name)!.value);
    at += day - Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  }
  return at;
}

export function weeklyVolume(data: VolumeData, now: number, source: 'all' | 'zoho' | 'forum' = 'all'): { timezone: string; sources: VolumeSource[]; weeks: VolumeWeek[] } {
  const sources = data.sources.filter((s) => source === 'all' || s.source === source);
  const timezone = sources[0]?.timezone ?? 'America/New_York';
  const day = calendar(now, timezone);
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * 86400000;
  const tickets = data.tickets.filter((t) => sources.some((s) => s.source === t.source));
  const classifications = new Map(data.classifications?.map((c) => [c.ticketId, c]));
  const changes = new Map<number, VolumeData['changes']>();
  const worked = new Map<number, number[]>();
  for (const work of data.worked) {
    const times = worked.get(work.ticketId) ?? [];
    times.push(work.at);
    worked.set(work.ticketId, times);
  }
  for (const change of data.changes) {
    const list = changes.get(change.ticketId) ?? [];
    list.push(change);
    changes.set(change.ticketId, list);
  }
  const weeks: VolumeWeek[] = [];
  for (let ago = 0; ago < 12; ago++) {
    const local = monday - ago * 7 * 86400000;
    const from = midnight(local, timezone);
    const to = midnight(local + 7 * 86400000, timezone);
    const end = Math.min(to, now + 1);
    const details = Object.fromEntries(VOLUME_METRICS.map((m) => [m, []])) as unknown as VolumeWeek['details'];
    const available = sources.some((s) => s.startedAt < end);
    const gaps = [...data.gaps, ...sources.filter((s) => now - s.lastAt > 3 * s.interval).map((s) => ({ source: s.source, from: s.lastAt, to: now + 1 }))];
    const partial = now < to || (source === 'all' && sources.length < 2) || sources.some((s) => s.startedAt > from) || gaps.some((g) => sources.some((s) => s.source === g.source) && g.from < end && g.to > from);
    for (const ticket of tickets) {
      const tracking = sources.find((s) => s.source === ticket.source)!;
      if (tracking.startedAt >= end) continue;
      const add = (metric: VolumeMetric, at: number) => {
        if (!details[metric].some((d) => d.id === ticket.id)) details[metric].push({ id: ticket.id, source: ticket.source, ref: ticket.ref, title: ticket.title, url: ticket.url, at, classification: classifications.get(ticket.id) ?? null });
      };
      const history = changes.get(ticket.id) ?? [];
      let queue = false;
      // Older databases can have an assigned ticket but no pre-migration change row for its assignment.
      const firstAssignment = history.find((change) => change.fields['assigned']);
      let assigned = firstAssignment ? firstAssignment.fields['assigned']![0] === true : ticket.assigned;
      let previous = tracking.startedAt;
      const span = (until: number) => {
        if (queue && previous < end && until > from && until > previous) {
          add('seen', Math.max(previous, from));
          if (assigned) add('assigned', Math.max(previous, from));
        }
      };
      for (const change of history) {
        if (change.at >= end) break;
        if (change.at >= tracking.startedAt) span(change.at);
        const wasQueued = queue;
        if (change.fields['inQueue']) queue = change.fields['inQueue'][1] === true;
        if (change.fields['assigned']) assigned = change.fields['assigned'][1] === true;
        if (change.at >= Math.max(from, tracking.startedAt)) {
          if (queue) {
            add('seen', change.at);
            if (assigned) add('assigned', change.at);
          }
          if (queue && !wasQueued && change.at !== tracking.startedAt) add('entered', change.at);
          if (!queue && wasQueued) add('left', change.at);
        }
        previous = Math.max(tracking.startedAt, change.at);
      }
      span(end);
      if (queue) {
        add('open', end - 1);
        if (assigned) add('mine', end - 1);
      }
      for (const at of worked.get(ticket.id) ?? []) {
        if (at >= Math.max(from, tracking.startedAt) && at < end) add('worked', at);
      }
    }
    weeks.push({ week: new Date(local).toISOString().slice(0, 10), from, to, coverage: !available ? 'unavailable' : partial ? 'partial' : 'observed', counts: Object.fromEntries(VOLUME_METRICS.map((m) => [m, details[m].length])) as VolumeWeek['counts'], details });
  }
  return { timezone, sources, weeks };
}
