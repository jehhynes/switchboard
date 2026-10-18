import { describe, expect, it } from 'vitest';
import { Store } from '@switchboard/core';
import { volumeReply } from '../src/volume.js';

describe('volume endpoint', () => {
  it('rejects invalid filters and bounds detail requests to the visible weeks', () => {
    const store = Store.open(':memory:');
    for (const body of [null, [], { source: 'github' }, { source: ['zoho'] }, { offset: -1 }, { metric: 'seen' }, { metric: 'other', week: '2026-10-05' }, { metric: 'seen', week: '2020-01-01' }]) {
      expect(volumeReply(store, Date.parse('2026-10-18T12:00:00Z'), body).status).toBe(400);
    }
    const result = volumeReply(store, Date.parse('2026-10-18T12:00:00Z'), {});
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ timezone: 'America/New_York', weeks: expect.arrayContaining([expect.objectContaining({ coverage: 'unavailable' })]) });
    expect(JSON.stringify(result.body)).not.toContain('details');
    expect(volumeReply(store, Date.parse('2026-10-18T12:00:00Z'), { metric: 'seen', week: '2026-10-12' }).body).toEqual({ total: 0, rows: [] });
    store.close();
  });
});
