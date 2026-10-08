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

  it('holds an approved work item while its own earlier session is open, and starts it when that session ends', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const first = h.started(h.act({ type: 'start', workItemId: 1 })[0], 'a9d3f95b');
    h.report(first, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: null });
    // The operator resumed the session in a VS Code tab, so it stays live after its turn.
    h.act({ type: 'roster', sessions: [{ sessionId: first, state: 'idle', detail: null, interactive: true }], checked: [first] });

    expect(h.act({ type: 'approve', workItemId: 1 })).toEqual([]);
    expect(h.status(1)).toBe('queued');
    expect(waitsOf(h, 1)).toEqual([{ kind: 'session', sessionId: first, shortId: 'a9d3f95b', ownItem: true, playbook: null }]);

    const next = only(h.act({ type: 'roster', sessions: [], checked: [first] }), 'start-session');
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
