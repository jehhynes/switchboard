import { describe, expect, it } from 'vitest';
import { Harness, issue } from './flowHarness.js';

const at = (date: string) => Date.parse(date);
const monday = at('2026-10-05T04:00:00Z');
function poll(h: Harness, rows: { key: string; mine?: boolean; pool?: boolean }[]) {
  return h.act({ type: 'poll', source: 'zoho', tickets: rows.map((r) => ({ ...issue(r.key, r.mine ?? false), inQueue: true, pool: r.pool ?? false, assigneeId: r.mine ? 'me' : 'other' })) });
}

describe('recorded Support volume evidence', () => {
  it('retains other engineers without work, baselines the first poll, and records only changes', () => {
    const h = new Harness();
    h.now = monday;
    expect(poll(h, [{ key: '1' }])).toMatchObject([{ type: 'triage', workItemId: null }]);
    expect(h.store.workItemsForTicket(1)).toEqual([]);
    expect(h.store.poolTriages(1)).toHaveLength(1);
    expect(h.store.ticket(1)).toMatchObject({ inQueue: true, assigned: false, pool: false, assigneeId: 'other' });
    const revision = h.store.historyRevision(1);
    h.now += 300000;
    poll(h, [{ key: '1' }]);
    expect(h.store.historyRevision(1)).toBe(revision);
    h.now += 300000;
    poll(h, []);
    expect(h.store.ticket(1)?.inQueue).toBe(false);
    const left = h.now;
    h.now += 300000;
    poll(h, [{ key: '1' }, { key: '2' }]);
    expect([h.store.ticket(1)?.inQueue, h.store.ticket(2)?.inQueue]).toEqual([true, true]);
    expect(h.store.volumeData().changes.filter((c) => c.ticketId === 1 && c.fields['inQueue']).map((c) => [c.at, c.fields['inQueue']])).toEqual([[monday, [null, true]], [left, [true, false]], [h.now, [false, true]]]);
    h.store.close();
  });

  it('keeps assignment evidence after sessionless deletion and does not treat transfers as queue exits', () => {
    const h = new Harness();
    h.now = monday;
    const actions = poll(h, [{ key: '1', mine: true }]);
    h.triaged(actions[0], 'support:defect');
    // Explicit deletion exercises the same store cleanup even if triage started a session.
    h.act({ type: 'session-started', sessionId: 's1', nativeSessionId: 'native', shortId: 'short' });
    h.act({ type: 'delete', workItemId: 1 });
    h.now += 300000;
    poll(h, [{ key: '1' }]);
    expect(h.store.workItemsForTicket(1)).toEqual([]);
    expect(h.store.ticket(1)).toMatchObject({ inQueue: true, assigned: false });
    expect(h.store.volumeData().changes.some((c) => c.ticketId === 1 && c.fields['inQueue']?.[1] === false)).toBe(false);
    expect(h.store.volumeData().changes.some((c) => c.ticketId === 1 && c.fields['assigned']?.[0] === true && c.fields['assigned'][1] === false)).toBe(true);
    expect(h.store.volumeData().worked).toEqual([{ ticketId: 1, at: monday }]);
    expect(h.store.ticketHistory(1)?.events.some((e) => e.type === 'volume-worked')).toBe(true);
    h.store.close();
  });

  it("preserves queue state on failure, records gaps and keeps a removed source's tracking", () => {
    const h = new Harness();
    h.now = monday;
    poll(h, [{ key: '1' }]);
    h.now += 3600000;
    h.act({ type: 'poll-failed', source: 'zoho', error: 'offline' });
    expect(h.store.ticket(1)?.inQueue).toBe(true);
    poll(h, []);
    expect(h.store.volumeData().gaps).toEqual([{ source: 'zoho', from: monday, to: h.now }]);
    h.store.keepSourceStates([]);
    expect(h.store.volumeData().sources[0]?.startedAt).toBe(monday);
    expect(h.store.enabledSources().has('zoho')).toBe(false);
    h.store.close();
  });

  it('transfers ticket evidence during identity consolidation', () => {
    const h = new Harness();
    h.now = monday;
    const actions = poll(h, [{ key: '1' }, { key: '2' }]);
    h.triaged(actions[0], 'support:defect');
    for (const triage of h.store.poolTriages(1)) h.store.deleteTriage(triage.id);
    h.store.volumeWorked(1, 'old', h.now);
    h.store.transferVolume(1, 2);
    h.store.deleteBareTicket(1);
    expect(h.store.volumeData().worked).toEqual([{ ticketId: 2, at: monday }]);
    expect(h.store.volumeData().classifications).toMatchObject([{ ticketId: 2, playbook: 'support:defect' }]);
    h.store.close();
  });
});
