import { VOLUME_METRICS, weeklyVolume } from '@switchboard/core';
import type { Store, VolumeMetric } from '@switchboard/core';
import type { Reply } from './server.js';

export function volumeReply(store: Store, now: number, body: unknown): Reply {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: { error: 'Expected a volume query.' } };
  const query = body as Record<string, unknown>;
  const source = query['source'] ?? 'all';
  const offset = query['offset'] ?? 0;
  if (typeof source !== 'string' || !['all', 'zoho', 'forum'].includes(source) || !Number.isSafeInteger(offset) || (offset as number) < 0 ||
      (query['metric'] !== undefined && (!VOLUME_METRICS.includes(query['metric'] as VolumeMetric) || typeof query['week'] !== 'string'))) {
    return { status: 400, body: { error: 'Expected source all, zoho or forum, and an optional week, metric and nonnegative offset.' } };
  }
  const result = weeklyVolume(store.volumeData(), now, source as 'all' | 'zoho' | 'forum');
  if (query['metric'] !== undefined) {
    const week = result.weeks.find((w) => w.week === query['week']);
    if (!week) return { status: 400, body: { error: 'The week is outside the last 12 weeks.' } };
    const rows = week.details[query['metric'] as VolumeMetric];
    return { status: 200, body: { total: rows.length, rows: rows.slice(offset as number, (offset as number) + 100) } };
  }
  return { status: 200, body: { ...result, weeks: result.weeks.map(({ details: _details, ...week }) => week) } };
}
