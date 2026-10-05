import { describe, expect, it } from 'vitest';
import type { FlowAction, PolledTicket } from '../src/flow.js';
import { Harness, issue } from './flowHarness.js';

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions).toHaveLength(1);
  expect(actions[0]?.type).toBe(type);
  return actions[0] as Extract<FlowAction, { type: T }>;
}

function running(h: Harness): { item: number; session: string } {
  const [triage] = h.poll(issue('1'));
  h.triaged(triage, 'dev:question');
  const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);

  return { item: 1, session };
}

describe('approval reports (PRD R23, R31)', () => {
  it('waits for approval with the prompt and summary, and Approve runs that prompt in a new task session', () => {
    const h = new Harness();
    const { item, session } = running(h);

    h.report(session, { kind: 'approval', prompt: '/review-pr pr:123 publish', summary: 'Review ready to post.' });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalPrompt: '/review-pr pr:123 publish', approvalSummary: 'Review ready to post.' });

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item).status).toBe('awaiting-approval');
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });

    const start = only(h.act({ type: 'approve', workItemId: item }), 'start-session');
    expect(start).toMatchObject({ kind: 'task', sessionId: 's2' });
    expect(start.prompt.startsWith('/review-pr pr:123 publish\n\nSwitchboard session s2 tracks this work.')).toBe(true);
    expect(h.item(item)).toMatchObject({ status: 'running', approvalPrompt: '/review-pr pr:123 publish' });

    h.act({ type: 'session-start-failed', sessionId: 's2', message: 'exit 1' });
    const retry = only(h.act({ type: 'retry', workItemId: item }), 'start-session');
    expect(retry.prompt.startsWith('/review-pr pr:123 publish\n\n')).toBe(true);
  });

  it('drops the pending approval when the work item is triaged again', () => {
    const h = new Harness();
    const { item, session } = running(h);

    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.' });
    h.act({ type: 'roster', sessions: [] });
    h.act({ type: 'retriage', workItemId: item });
    expect(h.item(item)).toMatchObject({ status: 'triaging', approvalPrompt: null, approvalSummary: null });
  });
});

describe('Icebox (PRD R49)', () => {
  const pool = (key: string): PolledTicket => ({ sourceKey: key, ref: `#${key}`, sourceId: key, title: key, url: '', assigned: false, pool: true, sortAt: 1, enteredAt: null });

  it('holds an iceboxed pool ticket from triage until restored', () => {
    const h = new Harness();
    expect(h.send({ type: 'icebox', ticketId: 1 }).refused).toBe('Unknown ticket 1.');
    expect(h.act({ type: 'poll', source: 'zoho', tickets: [pool('500')] })).toHaveLength(1);

    const h2 = new Harness();
    h2.store.insertTicket({ source: 'zoho', sourceKey: '501', ref: '#501', sourceId: '501', title: 't', url: '', assigned: false, pool: true, iceboxed: true, sortAt: 1, scopeAt: null, lastPolledAt: null, repoRoot: '' });

    expect(h2.act({ type: 'tick' })).toEqual([]);
    expect(only(h2.act({ type: 'restore', ticketId: 1 }), 'triage').ticket.sourceKey).toBe('501');
  });

  it('holds an iceboxed work item from triage and start until restored', () => {
    const h = new Harness();
    h.store.insertTicket({ source: 'github', sourceKey: '1', ref: '#1', sourceId: null, title: 'Issue 1', url: 'u', assigned: false, pool: false, iceboxed: true, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });

    expect(h.poll(issue('1'))).toEqual([]);
    expect(h.item(1).status).toBe('triaging');

    const triage = only(h.act({ type: 'restore', ticketId: 1 }), 'triage');
    h.triaged(triage, 'support:defect');
    expect(h.item(1).status).toBe('running');

    h.act({ type: 'icebox', ticketId: 1 });
    expect(h.store.ticket(1)?.iceboxed).toBe(true);
  });

  it('queues the task after setup when the ticket was iceboxed meanwhile', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('15619'));
    const setup = h.started(only(h.triaged(triage, 'dev:develop'), 'start-session'));

    h.act({ type: 'icebox', ticketId: 1 });
    h.report(setup, { kind: 'worktree', path: 'D:/wt/1', branch: null });
    expect(h.act({ type: 'roster', sessions: [] })).toEqual([]);
    expect(h.item(1).status).toBe('queued');
    expect(only(h.act({ type: 'restore', ticketId: 1 }), 'start-session').kind).toBe('task');
  });

  it('keeps the work items of an iceboxed ticket listed however long ago they were done', () => {
    const h = new Harness();
    h.poll(issue('1'), issue('2'));
    h.act({ type: 'mark-done', workItemId: 1 });
    h.act({ type: 'mark-done', workItemId: 2 });
    h.act({ type: 'icebox', ticketId: 1 });

    expect(h.store.workItems(h.now + 1).map((item) => item.id)).toEqual([1]);
  });

  it('does not start a queued work item of an iceboxed ticket', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    h.act({ type: 'icebox', ticketId: 1 });

    expect(h.act({ type: 'start', workItemId: 1 })).toEqual([]);
    expect(h.item(1).status).toBe('queued');
    expect(only(h.act({ type: 'restore', ticketId: 1 }), 'start-session').workItemId).toBe(1);
  });
});
