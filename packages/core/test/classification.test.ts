import { describe, expect, it } from 'vitest';
import { Harness, issue, settings } from './flowHarness.js';
import type { FlowAction } from '../src/flow.js';
import { weeklyVolume } from '../src/volume.js';

const ticket = (key: string, state = 'other') => ({ ...issue(key, state === 'mine'), inQueue: true, pool: state === 'pool', assigneeId: state });
const poll = (h: Harness, ...rows: ReturnType<typeof ticket>[]) => h.act({ type: 'poll', source: 'zoho', tickets: rows });
function succeed(h: Harness, action: FlowAction | undefined) {
  if (action?.type !== 'triage') throw new Error('Expected triage');
  return h.act({ type: 'triage-succeeded', triageId: action.triageId, context: 'ctx', playbook: 'support:defect', immediacy: 'BLOCKING', severity: 'HIGH', model: null });
}

describe('retained Support classification', () => {
  it('classifies other engineers without work, reuses success and exposes it in volume details', () => {
    const h = new Harness();
    const actions = poll(h, ticket('1'));
    expect(actions).toMatchObject([{ type: 'triage', workItemId: null, rates: true }]);
    expect(succeed(h, actions[0])).toEqual([]);
    expect(h.store.workItemsForTicket(1)).toEqual([]);
    expect(poll(h, ticket('1'))).toEqual([]);
    const report = weeklyVolume(h.store.volumeData(), h.now, 'zoho');
    expect(report.weeks[0]?.details.seen[0]?.classification).toEqual({ ticketId: 1, playbook: 'support:defect', immediacy: 'BLOCKING', severity: 'HIGH', at: h.now });
    poll(h);
    expect(h.store.volumeData().classifications).toHaveLength(1);
    h.store.close();
  });

  it('prioritizes work items and pool tickets within the shared concurrency limit', () => {
    const h = new Harness({ settings: settings({ triage: { concurrency: 1 } }) });
    const first = poll(h, ticket('1'), ticket('2', 'pool'), ticket('3', 'mine'));
    expect(first).toMatchObject([{ type: 'triage', ticket: { sourceKey: '3' } }]);
    const second = succeed(h, first[0]).filter((a) => a.type === 'triage');
    expect(second).toMatchObject([{ ticket: { sourceKey: '2' }, workItemId: null }]);
    const third = succeed(h, second[0]);
    expect(third).toMatchObject([{ ticket: { sourceKey: '1' }, workItemId: null }]);
    expect(h.store.runningTriages()).toHaveLength(1);
    h.store.close();
  });

  it('keeps failures without retrying and restarts cancelled attempts', () => {
    const h = new Harness();
    const [first] = poll(h, ticket('1'));
    if (first?.type !== 'triage') throw new Error('Expected triage');
    const [again] = h.act({ type: 'triage-cancelled', triageId: first.triageId });
    if (again?.type !== 'triage') throw new Error('Expected triage');
    h.act({ type: 'triage-failed', triageId: again.triageId, error: 'Unavailable', context: null });
    expect(poll(h, ticket('1'))).toEqual([]);
    expect(h.store.poolTriages(1)).toMatchObject([{ error: 'Unavailable' }]);
    expect(h.store.volumeData().classifications).toEqual([]);
    expect(weeklyVolume(h.store.volumeData(), h.now, 'zoho').weeks[0]?.details.seen[0]?.classification).toBeNull();
    expect(h.store.workItemsForTicket(1)).toEqual([]);
    h.store.close();
  });

  it('finishes classification after departure without starting work, and covers tickets that left while waiting', () => {
    const h = new Harness({ settings: settings({ triage: { concurrency: 1 } }) });
    const first = poll(h, ticket('1'), ticket('2'));
    poll(h);
    const second = succeed(h, first[0]);
    expect(second).toMatchObject([{ type: 'triage', ticket: { sourceKey: '2' }, workItemId: null }]);
    expect(succeed(h, second[0])).toEqual([]);
    expect(h.store.volumeData().classifications).toHaveLength(2);
    expect(h.store.workItemsForTicket(1)).toEqual([]);
    expect(h.store.workItemsForTicket(2)).toEqual([]);
    h.store.close();
  });

  it('retains local classifications after work-item deletion and does not reclassify for reporting', () => {
    const h = new Harness();
    succeed(h, poll(h, ticket('1', 'mine'))[0]);
    h.store.deleteWorkItem(1);
    expect(poll(h, ticket('1'))).toEqual([]);
    expect(h.store.volumeData().classifications).toMatchObject([{ playbook: 'support:defect' }]);
    h.store.close();
  });

  it('classifies Forum and does not classify a removed source', () => {
    const config = settings();
    config.sources['forum'] = config.sources['zoho']!;
    const h = new Harness({ settings: config });
    expect(h.act({ type: 'poll', source: 'forum', tickets: [ticket('1')] })).toMatchObject([{ type: 'triage', workItemId: null }]);
    delete config.sources['zoho'];
    expect(poll(h, ticket('2'))).toEqual([]);
    h.store.close();
  });

  it('keeps an in-flight pool triage counted when another engineer takes the ticket', () => {
    const h = new Harness({ settings: settings({ triage: { concurrency: 1 } }) });
    const first = poll(h, ticket('1', 'pool'));
    expect(poll(h, ticket('1'), ticket('2'))).toEqual([]);
    expect(h.store.runningTriages()).toHaveLength(1);
    const next = succeed(h, first[0]);
    expect(next).toMatchObject([{ type: 'triage', ticket: { sourceKey: '2' } }]);
    expect(h.store.workItemsForTicket(1)).toEqual([]);
    h.store.close();
  });

  it('waits for ticket-only classification before triaging a new local assignment', () => {
    const h = new Harness();
    const first = poll(h, ticket('1'));
    expect(poll(h, ticket('1', 'mine'))).toEqual([]);
    expect(h.store.runningTriages()).toHaveLength(1);
    expect(h.store.workItemsForTicket(1)).toMatchObject([{ status: 'triaging' }]);
    const local = succeed(h, first[0]);
    expect(local).toMatchObject([{ type: 'triage', workItemId: 1 }]);
    // The local assignment needs fresh context and the existing local approval/start rules.
    expect(h.store.runningTriages()).toHaveLength(1);
    h.store.close();
  });

  it('pauses retained classification while its source is disabled and resumes on enable', () => {
    const h = new Harness({ settings: settings({ triage: { concurrency: 1 } }) });
    const first = poll(h, ticket('1'), ticket('2'));
    h.store.setSourceEnabled('zoho', false);
    expect(succeed(h, first[0])).toEqual([]);
    expect(h.store.poolTriages(2)).toEqual([]);
    h.store.setSourceEnabled('zoho', true);
    expect(h.act({ type: 'tick' })).toMatchObject([{ type: 'triage', ticket: { sourceKey: '2' } }]);
    h.store.close();
  });
});
