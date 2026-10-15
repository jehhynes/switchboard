import { describe, expect, it } from 'vitest';
import { adhocLabel } from '../src/group.js';
import { Harness, MINUTE, issue, settings } from './flowHarness.js';

/** A started dev:question task session for ticket 1, running in its background process. */
function running(h: Harness): string {
  const [triage] = h.poll(issue('1'));
  h.triaged(triage, 'dev:question');
  h.now += MINUTE;

  return h.started(h.act({ type: 'start', workItemId: 1 })[0]);
}

describe('delete (PRD R76)', () => {
  it('stops a background session, deletes the work item with its sessions and triages, and refuses the stopped session afterwards', () => {
    const h = new Harness();
    const session = running(h);

    expect(h.act({ type: 'delete', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12345', reason: 'operator' }]);

    expect(h.store.workItem(1)).toBeNull();
    expect(h.store.session(session)).toBeNull();
    expect(h.store.triagesFor(1)).toEqual([]);
    expect(h.send({ type: 'stop-succeeded', sessionId: session, reason: 'operator' }).refused).toBe(`Unknown session ${session}.`);
    expect(h.report(session, { kind: 'stage', stage: 'fixing tests' }).refused).toBe(`Unknown session ${session}.`);
    expect(h.send({ type: 'delete', workItemId: 1 }).refused).toBe('Unknown work item 1.');
  });

  it('creates no work item while the ticket stays assigned, and a new one when it is assigned again', () => {
    const h = new Harness();
    running(h);
    h.act({ type: 'delete', workItemId: 1 });

    h.poll(issue('1'));
    expect(h.store.workItemsForTicket(1)).toEqual([]);

    h.poll();
    h.poll(issue('1'));
    expect(h.store.workItemsForTicket(1)).toMatchObject([{ id: 2, status: 'triaging' }]);
  });

  it("does not stop a session the operator resumed, because it is theirs", () => {
    const h = new Harness();
    const session = running(h);
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'running', detail: null, interactive: true }] });

    expect(h.act({ type: 'delete', workItemId: 1 })).toEqual([]);
    expect(h.store.workItem(1)).toBeNull();
  });

  it('refuses while the session starts, because it has no short ID to stop yet', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    h.act({ type: 'start', workItemId: 1 });

    expect(h.send({ type: 'delete', workItemId: 1 }).refused).toBe('The session is starting. Delete the work item once it has started.');
    expect(h.status(1)).toBe('running');
  });

  it("ends the ticket's snooze when it has no other work item, and keeps it while another remains", () => {
    const h = new Harness();
    running(h);
    h.act({ type: 'snooze', ticketId: 1, until: null });

    h.act({ type: 'delete', workItemId: 1 });

    expect(h.store.ticket(1)).toMatchObject({ snoozed: false, snoozedUntil: null });

    const g = new Harness();
    running(g);
    g.act({ type: 'mark-done', workItemId: 1 });
    g.poll();
    g.poll(issue('1'));
    g.act({ type: 'snooze', ticketId: 1, until: null });

    g.act({ type: 'delete', workItemId: 1 });

    expect(g.store.workItemsForTicket(1).map((item) => item.id)).toEqual([2]);
    expect(g.store.ticket(1)?.snoozed).toBe(true);
  });

  it('deletes a done work item without any action', () => {
    const h = new Harness();
    const session = running(h);
    h.act({ type: 'stop', workItemId: 1 });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    h.act({ type: 'mark-done', workItemId: 1 });

    expect(h.act({ type: 'delete', workItemId: 1 })).toEqual([]);
    expect(h.store.workItem(1)).toBeNull();
  });

  it('frees the session slot, so a queued start runs', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 } }) });
    running(h);
    const [triage] = h.poll(issue('1'), issue('2'));
    h.triaged(triage, 'dev:question');
    h.act({ type: 'start', workItemId: 2 });
    expect(h.status(2)).toBe('queued');

    const actions = h.act({ type: 'delete', workItemId: 1 });

    expect(actions.map((action) => action.type)).toEqual(['stop-session', 'start-session']);
    expect(h.status(2)).toBe('running');
  });

  it('ignores the result of a triage that ran when its work item was deleted', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));

    h.act({ type: 'delete', workItemId: 1 });

    expect(h.triaged(triage, 'dev:develop')).toEqual([]);
    expect(h.store.workItemsForTicket(1)).toEqual([]);
  });

  it("keeps a task report's work item, without its deleted parent", () => {
    const h = new Harness();
    const session = running(h);
    h.report(session, { kind: 'task', prompt: 'Fix the flaky test', repo: null, title: null });
    expect(h.item(2).parentId).toBe(1);
    // A follow-up made before its ticket stored the origin.
    h.store.updateTicket(h.item(2).ticketId, { sourceId: null });

    h.act({ type: 'delete', workItemId: 1 });

    expect(h.item(2)).toMatchObject({ parentId: null, status: 'unstarted' });
    // The row keeps naming it a task (PRD R27).
    expect(adhocLabel({ parentId: null, prompted: true }, h.store.ticket(h.item(2).ticketId)!)).toBe('task');
  });

  it("removes the work item's activity and logs the delete on the ticket", () => {
    const h = new Harness();
    running(h);
    const before = h.store.ticketHistory(1)!.revision;

    h.act({ type: 'delete', workItemId: 1 });

    const after = h.store.ticketHistory(1)!;

    expect(after.revision).not.toBe(before);
    expect(after.workItems).toEqual([]);
    expect(after.events.map((event) => `${event.type}/${event.actor}`)).toEqual(['poll/source', 'delete/operator']);
    expect(after.events.at(-1)).toMatchObject({ workItemId: null, sessionId: null, detail: { workItemId: 1 }, refused: null, changes: [] });
  });

  it('logs a refused delete on the ticket with its reason', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    h.act({ type: 'start', workItemId: 1 });
    h.send({ type: 'delete', workItemId: 1 });

    expect(h.store.ticketHistory(1)!.events.at(-1)).toMatchObject({ type: 'delete', refused: 'The session is starting. Delete the work item once it has started.' });
  });
});
