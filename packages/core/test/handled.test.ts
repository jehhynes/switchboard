import { describe, expect, it } from 'vitest';
import { Harness, issue, MINUTE } from './flowHarness.js';

function setup() {
  const h = new Harness();
  const action = h.act({ type: 'adhoc', prompt: 'Publish the prepared fix', repoRoot: 'D:/repo', start: true })[0];
  const sessionId = h.started(action);
  const event = { type: 'handled' as const, sessionId, source: 'github', sourceKey: '7', ref: '#7', repo: '', title: 'Fix', url: 'https://github.com/acme/widgets/issues/7', key: 'issue:assignment-1', release: false, assigned: true };
  return { h, event };
}

describe('handled assignments', () => {
  it('registers before publication, survives status changes and starts normal work on a between-poll reassignment', () => {
    const { h, event } = setup();
    expect(h.send(event).refused).toBeNull();
    const ticket = h.store.findTicket('github', '7')!;
    expect(h.poll()).toEqual([]);
    expect(h.poll(issue('7'))).toEqual([]);
    expect(h.store.workItemsForTicket(ticket.id)).toEqual([]);
    expect(h.poll(issue('7', false))).toEqual([]);
    expect(h.store.ticket(ticket.id)?.handledAssignmentKey).toBe(event.key);
    h.poll(issue('7'));
    const returned = h.act({ type: 'poll', source: 'github', tickets: [issue('7')], assignments: [{ ticketId: ticket.id, expectedKey: event.key, key: 'issue:assignment-2' }] });
    expect(returned.map((action) => action.type)).toEqual(['triage']);
    expect(h.store.ticket(ticket.id)?.handledAssignmentKey).toBeNull();
    expect(h.store.assignmentEnded(ticket.id, event.key)).toBe(true);
    expect(h.send(event).refused).toContain('already released');
    expect(h.send({ ...event, key: 'issue:assignment-2' }).refused).toContain('earlier assignment');
  });

  it('clears on actual unassignment while the reporting work is open', () => {
    const { h, event } = setup();
    h.act(event);
    const ticket = h.store.findTicket('github', '7')!;
    h.act({ type: 'poll', source: 'github', tickets: [], assignments: [{ ticketId: ticket.id, expectedKey: event.key, key: null }] });
    expect(h.store.ticket(ticket.id)?.handledAssignmentKey).toBeNull();
    expect(h.poll(issue('7')).map((action) => action.type)).toEqual(['triage']);
  });

  it('ends when the reporting work item is done and triages the assigned ticket with the registration as earlier work', () => {
    const { h, event } = setup();
    h.act(event);
    h.poll(issue('7'));
    const ticket = h.store.findTicket('github', '7')!;
    const registeredAt = h.now;
    h.now += 30 * MINUTE;
    const actions = h.act({ type: 'mark-done', workItemId: h.store.session(event.sessionId)!.workItemId });
    expect(actions).toEqual([expect.objectContaining({ type: 'triage', handled: { at: registeredAt, playbook: null } })]);
    expect(h.store.ticket(ticket.id)?.handledAssignmentKey).toBeNull();
    expect(h.store.assignmentEnded(ticket.id, event.key)).toBe(true);
    expect(h.store.ticketHistory(ticket.id)!.events.at(-1)?.detail?.['handledEnded']).toEqual([ticket.id]);
    expect(h.send(event).refused).toContain('open work item');
  });

  it('ends without work for an unassigned ticket, which gets work when assigned', () => {
    const { h, event } = setup();
    h.act(event);
    const ticket = h.store.findTicket('github', '7')!;
    expect(h.act({ type: 'mark-done', workItemId: h.store.session(event.sessionId)!.workItemId })).toEqual([]);
    expect(h.store.ticket(ticket.id)?.handledAssignmentKey).toBeNull();
    expect(h.store.workItemsForTicket(ticket.id)).toEqual([]);
    expect(h.poll(issue('7')).map((action) => action.type)).toEqual(['triage']);
  });

  it('ends when the reporting work item is deleted, keeping its playbook as earlier work and the target audit', () => {
    const { h, event } = setup();
    const reporter = h.store.session(event.sessionId)!.workItemId;
    h.store.updateWorkItem(reporter, { playbook: 'support:defect' });
    const registeredAt = h.now;
    h.act(event);
    h.poll(issue('7'));
    const ticket = h.store.findTicket('github', '7')!;
    h.now += 30 * MINUTE;
    const actions = h.act({ type: 'delete', workItemId: reporter });
    expect(h.store.workItem(reporter)).toBeNull();
    expect(actions.filter((action) => action.type === 'triage')).toEqual([expect.objectContaining({ handled: { at: registeredAt, playbook: 'support:defect' } })]);
    expect(h.store.ticket(ticket.id)?.handledAssignmentKey).toBeNull();
    const history = h.store.ticketHistory(ticket.id)!;
    expect(history.events.some((entry) => entry.type === 'handled' && entry.detail?.['reportedBySessionId'] === event.sessionId)).toBe(true);
  });

  it('ends on the next event for a reporter deleted without a flow event', () => {
    const { h, event } = setup();
    h.act(event);
    h.poll(issue('7'));
    const ticket = h.store.findTicket('github', '7')!;
    h.store.deleteWorkItem(h.store.session(event.sessionId)!.workItemId);
    expect(h.store.ticket(ticket.id)?.handledAssignmentKey).toBe(event.key);
    expect(h.act({ type: 'tick' }).map((action) => action.type)).toEqual(['triage']);
    expect(h.store.ticket(ticket.id)?.handledAssignmentKey).toBeNull();
  });

  it('keeps the assignment handled while the reporting work item is open', () => {
    const { h, event } = setup();
    h.act(event);
    h.poll(issue('7'));
    h.act({ type: 'tick' });
    expect(h.store.findTicket('github', '7')?.handledAssignmentKey).toBe(event.key);
  });

  it('releases only the named key and retries do not restore a released registration', () => {
    const { h, event } = setup();
    h.act(event);
    h.act(event);
    h.poll(issue('7'));
    expect(h.send({ ...event, release: true, key: 'wrong' }).refused).toContain('changed');
    const result = h.send({ ...event, release: true });
    expect(result.refused).toBeNull();
    expect(result.actions.map((action) => action.type)).toEqual(['triage']);
    expect(h.send({ ...event, release: true }).refused).toBeNull();
    expect(h.send(event).refused).toContain('already released');
  });

  it('removes unstarted duplicate work and ignores its late triage result', () => {
    const { h, event } = setup();
    const action = h.poll(issue('7'))[0];
    expect(action?.type).toBe('triage');
    h.act(event);
    expect(h.triaged(action, 'dev:develop')).toEqual([]);
    expect(h.store.workItemsForTicket(h.store.findTicket('github', '7')!.id)).toEqual([]);
  });

  it('refuses registration once a duplicate session start has been emitted', () => {
    const { h, event } = setup();
    const triage = h.poll(issue('7'))[0];
    const starts = h.triaged(triage, 'dev:develop');
    expect(starts[0]?.type).toBe('start-session');
    expect(h.send(event).refused).toContain('already has started work');
    expect(h.store.findTicket('github', '7')?.handledAssignmentKey).toBeNull();
  });

  it('refuses adoption and direct deletion of a handled target', () => {
    const { h, event } = setup();
    h.act(event);
    const ticket = h.store.findTicket('github', '7')!;
    expect(h.send({ type: 'ticket', sessionId: event.sessionId, source: 'github', sourceKey: '7', ref: '#7', repo: '', title: 'Fix', url: ticket.url, playbook: null }).refused).toContain('already has');
    expect(() => h.store.deleteBareTicket(ticket.id)).toThrow('handled assignment');
  });

  it('rejects unknown, finished and own-ticket registrations', () => {
    const { h, event } = setup();
    expect(h.send({ ...event, sessionId: 'missing' }).refused).toContain('Unknown session');
    const origin = h.store.workItem(h.store.session(event.sessionId)!.workItemId)!;
    const ticket = h.store.ticket(origin.ticketId)!;
    expect(h.send({ ...event, source: ticket.source, sourceKey: ticket.sourceKey }).refused).toContain('already works');
    h.act({ type: 'mark-done', workItemId: origin.id });
    expect(h.send(event).refused).toContain('open work item');
  });

  it('retains separate clearing reasons when one poll sees unassignment and reassignment', () => {
    const { h, event } = setup();
    h.act(event);
    h.act({ ...event, sourceKey: '8', ref: '#8', repo: '', url: event.url.replace('/7', '/8') });
    const first = h.store.findTicket('github', '7')!;
    const second = h.store.findTicket('github', '8')!;
    h.act({ type: 'poll', source: 'github', tickets: [], assignments: [
      { ticketId: first.id, expectedKey: event.key, key: null },
      { ticketId: second.id, expectedKey: event.key, key: 'next' },
    ] });
    expect(h.store.ticketHistory(first.id)!.events.at(-1)?.detail?.['assignmentChanges']).toEqual([
      { ticketId: first.id, reason: 'unassigned' }, { ticketId: second.id, reason: 'reassigned' },
    ]);
  });
});
