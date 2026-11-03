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

  it('runs the approved prompt again on Retry after the approved session fails to start, while the earlier one stays open idle', () => {
    const { h } = approvalKeptOpen('idle');
    const start = only(h.act({ type: 'approve', workItemId: 1 }), 'start-session');

    h.act({ type: 'session-start-failed', sessionId: start.sessionId, message: 'x' });
    expect(h.status(1)).toBe('failed');
    const again = only(h.act({ type: 'retry', workItemId: 1 }), 'start-session');
    expect(again).toMatchObject({ workItemId: 1, prompt: expect.stringContaining('/publish') });
    expect(again.sessionId).not.toBe(start.sessionId);
    expect(h.status(1)).toBe('running');
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

  it('holds an automatic start while the ticket has open blockers, and starts it on the poll that sees none (PRD R90)', () => {
    const h = new Harness();
    const blocker = { url: 'https://github.com/acme/widgets/issues/12', ref: '#12', title: 'Issue 12' };
    const [triage] = h.poll({ ...issue('1'), blockers: [blocker] });

    expect(h.triaged(triage, 'support:defect')).toEqual([]);
    expect(h.status(1)).toBe('queued');
    expect(waitsOf(h, 1)).toEqual([{ kind: 'blockers', blockers: [blocker] }]);

    // A poll that lists it again, or does not read blockers, as GitHub's read of an issue missing from the search, starts nothing.
    expect(h.poll({ ...issue('1'), blockers: [blocker] })).toEqual([]);
    expect(h.poll(issue('1'))).toEqual([]);
    expect(h.store.ticket(1)!.blockers).toEqual([blocker]);

    only(h.poll({ ...issue('1'), blockers: [] }), 'start-session');
    expect(h.store.ticket(1)!.blockers).toEqual([]);
  });

  it('holds Start with guidance, Approve and Retry of a ticket with an open blocker, with free slots, and runs each once it closes', () => {
    const blocker = { url: 'https://github.com/acme/widgets/issues/12', ref: '#12', title: 'Issue 12' };
    const blocked = { ...issue('1'), blockers: [blocker] };

    // Start with guidance: the task session gets the guidance once the blocker closes.
    const guided = new Harness();
    guided.triaged(guided.poll(blocked)[0], 'dev:question');
    expect(guided.act({ type: 'start', workItemId: 1, guidance: 'Read c2 first.' })).toEqual([]);
    expect(waitsOf(guided, 1)).toEqual([{ kind: 'blockers', blockers: [blocker] }]);
    expect(only(guided.poll({ ...issue('1'), blockers: [] }), 'start-session').prompt).toMatch(/Read c2 first\.$/);

    // Approve: the approved prompt runs once the blocker closes.
    const approved = new Harness();
    approved.triaged(approved.poll(issue('1'))[0], 'dev:question');
    const first = approved.started(approved.act({ type: 'start', workItemId: 1 })[0]);
    approved.report(first, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: null });
    approved.poll(blocked);
    approved.act({ type: 'roster', sessions: [] });
    expect(approved.act({ type: 'approve', workItemId: 1 })).toEqual([]);
    expect(approved.status(1)).toBe('queued');
    expect(only(approved.poll({ ...issue('1'), blockers: [] }), 'start-session').prompt).toContain('/publish');

    // Retry of a failed start.
    const retried = new Harness();
    retried.triaged(retried.poll(issue('1'))[0], 'dev:question');
    const start = only(retried.act({ type: 'start', workItemId: 1 }), 'start-session');
    retried.act({ type: 'session-start-failed', sessionId: start.sessionId, message: 'spawn failed' });
    expect(retried.status(1)).toBe('failed');
    retried.poll(blocked);
    expect(retried.act({ type: 'retry', workItemId: 1 })).toEqual([]);
    expect(retried.status(1)).toBe('queued');
    only(retried.poll({ ...issue('1'), blockers: [] }), 'start-session');
  });

  it("queues the operator's Start of a ticket with an open blocker, beside full slots", () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const blocker = { url: 'https://github.com/acme/docs/issues/7', ref: 'acme/docs#7', title: 'Docs 7' };
    const triages = h.poll(issue('1'), { ...issue('2'), blockers: [blocker] });
    h.started(only(h.triaged(triages[0], 'support:defect'), 'start-session'));
    h.triaged(triages[1], 'dev:question');

    expect(h.act({ type: 'start', workItemId: 2 })).toEqual([]);
    expect(h.status(2)).toBe('queued');
    expect(waitsOf(h, 2)).toEqual([{ kind: 'slot', used: 1, limit: 1 }, { kind: 'blockers', blockers: [blocker] }]);
  });
});
