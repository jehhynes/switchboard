import { describe, expect, it } from 'vitest';
import { weeklyVolume } from '../src/volume.js';
import { Harness, issue } from './flowHarness.js';

const at = (date: string) => Date.parse(date);
const monday = at('2026-10-05T04:00:00Z');
function poll(h: Harness, rows: { key: string; mine?: boolean; pool?: boolean }[]) {
  return h.act({ type: 'poll', source: 'zoho', tickets: rows.map((r) => ({ ...issue(r.key, r.mine ?? false), inQueue: true, pool: r.pool ?? false, assigneeId: r.mine ? 'me' : 'other' })) });
}
const counts = (h: Harness, week = '2026-10-05') => weeklyVolume(h.store.volumeData(), h.now, 'zoho').weeks.find((w) => w.week === week)!;

describe('observed Support volume', () => {
  it('baselines existing assigned tickets whose assignment predates change recording', () => {
    const h = new Harness();
    h.store.insertTicket({ source: 'zoho', sourceKey: '1', ref: '#1', sourceId: null, title: 'Old', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
    h.now = monday;
    poll(h, [{ key: '1', mine: true }]);
    expect(counts(h).counts).toMatchObject({ seen: 1, assigned: 1, mine: 1, entered: 0 });
    h.store.close();
  });
  it('does not count a pre-log assignment that ends at the baseline poll', () => {
    const h = new Harness();
    h.store.insertTicket({ source: 'zoho', sourceKey: '1', ref: '#1', sourceId: null, title: 'Old', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
    h.now = monday;
    poll(h, [{ key: '1' }]);
    expect(counts(h).counts).toMatchObject({ seen: 1, assigned: 0, mine: 0, entered: 0 });
    h.store.close();
  });
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
    expect(counts(h).counts).toEqual({ seen: 1, entered: 0, left: 0, open: 1, assigned: 0, worked: 0, mine: 0 });
    h.now += 300000;
    poll(h, []);
    expect(h.store.ticket(1)?.inQueue).toBe(false);
    expect(counts(h).counts).toMatchObject({ seen: 1, left: 1, open: 0 });
    h.now += 300000;
    poll(h, [{ key: '1' }, { key: '2' }]);
    expect(counts(h).counts).toMatchObject({ seen: 2, entered: 2, left: 1, open: 2 });
    expect(counts(h).details.entered.map((d) => d.ref)).toEqual(['#1', '#2']);
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
    expect(counts(h).counts).toMatchObject({ assigned: 1, worked: 1, left: 0, mine: 0, open: 1 });
    expect(h.store.ticketHistory(1)?.events.some((e) => e.type === 'volume-worked')).toBe(true);
    h.store.close();
  });

  it('preserves queue state on failure and marks gaps and untracked weeks', () => {
    const h = new Harness();
    h.now = monday;
    poll(h, [{ key: '1' }]);
    h.now += 3600000;
    h.act({ type: 'poll-failed', source: 'zoho', error: 'offline' });
    expect(h.store.ticket(1)?.inQueue).toBe(true);
    expect(counts(h).coverage).toBe('partial');
    expect(counts(h, '2026-09-28').coverage).toBe('unavailable');
    poll(h, []);
    expect(h.store.volumeData().gaps).toEqual([{ source: 'zoho', from: monday, to: h.now }]);
    h.store.keepSourceStates([]);
    expect(h.store.volumeData().sources[0]?.startedAt).toBe(monday);
    expect(h.store.enabledSources().has('zoho')).toBe(false);
    h.store.close();
  });

  it('carries observed state across weeks, deduplicates work, and uses DST calendar boundaries', () => {
    const h = new Harness();
    h.now = at('2026-10-26T04:00:00Z');
    poll(h, [{ key: '1', mine: true }]);
    h.store.volumeWorked(1, 'one', h.now + 1);
    h.store.volumeWorked(1, 'two', h.now + 2);
    h.now = at('2026-11-02T06:00:00Z');
    const report = weeklyVolume(h.store.volumeData(), h.now, 'zoho');
    expect(report.weeks[1]!.to - report.weeks[1]!.from).toBe(169 * 3600000);
    expect(report.weeks[1]!.counts).toMatchObject({ seen: 1, entered: 0, open: 1, assigned: 1, worked: 1, mine: 1 });
    expect(report.weeks[0]!.counts).toMatchObject({ seen: 1, entered: 0, worked: 0 });
    expect(report.weeks[0]!.coverage).toBe('partial');
    expect(weeklyVolume(h.store.volumeData(), h.now, 'forum').weeks[0]!.coverage).toBe('unavailable');
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
    expect(counts(h).counts).toMatchObject({ seen: 1, worked: 1 });
    h.store.close();
  });
});
