import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { heldSlots, queueWaits } from '../src/queue.js';
import { Harness, issue, settings } from './flowHarness.js';

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions.map((action) => action.type)).toEqual([type]);

  return actions[0] as Extract<FlowAction, { type: T }>;
}

const waitsOf = (h: Harness, id: number) => queueWaits(h.store, h.item(id), h.settings.sessions.concurrency);

describe('queueWaits', () => {
  it('names the full slots of a queued work item, and starts it when a slot frees', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'));
    const first = h.started(only(h.triaged(triages[0], 'support:defect'), 'start-session'));
    h.triaged(triages[1], 'support:defect');

    expect(heldSlots(h.store)).toBe(1);
    expect(waitsOf(h, 2)).toEqual([{ kind: 'slot', used: 1, limit: 1 }]);

    h.report(first, { kind: 'done' });
    expect(h.status(2)).toBe('running');
    expect(heldSlots(h.store)).toBe(1);
  });

  /** Reports approval from a started dev:question session that the operator then keeps open in a VS Code tab in `state`. */
  function approvalKeptOpen(state: 'idle' | 'waiting'): { h: Harness; first: string } {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const first = h.started(h.act({ type: 'start', workItemId: 1 })[0], 'a9d3f95b');
    h.report(first, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: null });
    h.act({ type: 'roster', sessions: [{ sessionId: first, state, detail: null, interactive: true }], checked: [first] });

    return { h, first };
  }

  it('starts an approved work item while its own earlier session stays open idle, and counts one slot for the work item', () => {
    const { h, first } = approvalKeptOpen('idle');

    const next = only(h.act({ type: 'approve', workItemId: 1 }), 'start-session');
    expect(next).toMatchObject({ workItemId: 1, prompt: expect.stringContaining('/publish') });
    h.started(next, 'b7e2c4d1');

    expect(h.store.session(first)?.state).toBe('idle');
    expect(h.status(1)).toBe('running');
    expect(heldSlots(h.store)).toBe(1);
  });

  it('settles the approved work item by its latest session while the earlier one stays open idle', () => {
    const { h, first } = approvalKeptOpen('idle');
    const second = h.started(h.act({ type: 'approve', workItemId: 1 })[0], 'b7e2c4d1');
    const open = { sessionId: first, state: 'idle' as const, detail: null, interactive: true };

    h.act({ type: 'roster', sessions: [open], checked: [first, second] });
    expect(h.item(1)).toMatchObject({ status: 'blocked', unassignedAt: null });

    // Unassignment ends the work item now, without waiting for the earlier session to close.
    h.poll();
    expect(h.item(1)).toMatchObject({ status: 'done', doneReason: 'unassigned' });
  });

  it('offers Triage again after the approved session fails to start, while the earlier one stays open idle', () => {
    const { h } = approvalKeptOpen('idle');
    const start = only(h.act({ type: 'approve', workItemId: 1 }), 'start-session');

    h.act({ type: 'session-start-failed', sessionId: start.sessionId, message: 'x' });
    expect(h.status(1)).toBe('failed');
    expect(h.send({ type: 'retriage', workItemId: 1 }).refused).toBeNull();
    expect(h.status(1)).toBe('triaging');
  });

  it('holds an approved work item while its own earlier session waits on a question, and starts it when the turn ends', () => {
    const { h, first } = approvalKeptOpen('waiting');

    expect(h.act({ type: 'approve', workItemId: 1 })).toEqual([]);
    expect(h.status(1)).toBe('queued');
    expect(waitsOf(h, 1)).toEqual([{ kind: 'session', sessionId: first, shortId: 'a9d3f95b', ownItem: true, playbook: null }]);

    const next = only(h.act({ type: 'marker', sessionId: first, state: 'idle', detail: null }), 'start-session');
    expect(next).toMatchObject({ workItemId: 1, prompt: expect.stringContaining('/publish') });
  });

  it('names the playbook of another work item whose session on the same ticket is open', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const first = h.started(only(h.triaged(triage, 'support:defect'), 'start-session'));
    h.report(first, { kind: 'done' });
    expect(h.status(1)).toBe('done');

    h.poll(issue('1', false));
    const [again] = h.poll(issue('1'));
    expect(h.triaged(again, 'support:defect')).toEqual([]);

    expect(h.status(2)).toBe('queued');
    expect(waitsOf(h, 2)).toEqual([{ kind: 'session', sessionId: first, shortId: 'abc12345', ownItem: false, playbook: 'support:defect' }]);
  });

  it('names a snooze, together with full slots', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'));
    h.started(only(h.triaged(triages[0], 'support:defect'), 'start-session'));
    h.triaged(triages[1], 'support:defect');
    h.act({ type: 'snooze', ticketId: 2, until: null });

    expect(waitsOf(h, 2)).toEqual([{ kind: 'slot', used: 1, limit: 1 }, { kind: 'snoozed' }]);
  });
});
