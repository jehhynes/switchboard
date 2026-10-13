import { describe, expect, it } from 'vitest';
import { groupOf } from '../src/group.js';
import { heldSlots } from '../src/queue.js';
import { HOUR, Harness, MINUTE, T0, issue, playbooks, settings } from './flowHarness.js';

// dev:question offers approval and done, so a held run can finish either way.
const QUESTION = { 'dev:question': { description: 'Answer a question', reports: ['approval', 'done'], template: 'Answer {{ticket.title}}.' } };

/** Polls, triages and starts issue `key` as work item `id` with dev:question, returning its session. */
function running(h: Harness, key: string, id: number): string {
  const [triage] = h.poll(...[...h.store.tickets('github').filter((ticket) => ticket.assigned).map((ticket) => issue(ticket.sourceKey)), issue(key)]);
  h.triaged(triage, 'dev:question');

  return h.started(h.act({ type: 'start', workItemId: id })[0]);
}

/** Work item `id` reports an approval at the harness's time, and its turn ends. */
function ready(h: Harness, key: string, id: number): string {
  const session = running(h, key, id);

  h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: null });
  h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
  h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });

  return session;
}

function groupOfItem(h: Harness, id: number) {
  return groupOf({ ...h.item(id), sessions: h.store.sessionsFor(id) });
}

function order(h: Harness): number[] {
  return h.store.readyWorkItems().map((item) => item.id);
}

describe('readyAt (PRD R27)', () => {
  it('is set by the first approval report and kept through Approve, a question, Open in Claude, a stop and a snooze', () => {
    const h = new Harness({ playbooks: playbooks(undefined, QUESTION), settings: settings({ sessions: { concurrency: 2 } }) });
    const session = running(h, '1', 1);

    expect(h.item(1).readyAt).toBeNull();
    h.now = T0 + HOUR;
    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: null });
    expect(h.item(1)).toMatchObject({ status: 'awaiting-approval', readyAt: T0 + HOUR });

    // Resumed with a question and opened in Claude, the run keeps its approval until the tab's turn ends, without moving readyAt.
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.now = T0 + 2 * HOUR;
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.item(1)).toMatchObject({ status: 'running', approvalHeld: true, readyAt: T0 + HOUR });
    expect(groupOfItem(h, 1)).toBe('review');
    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });
    expect(groupOfItem(h, 1)).toBe('blocked');
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'open' });
    expect(h.item(1)).toMatchObject({ status: 'running', approvalHeld: true, readyAt: T0 + HOUR });
    expect(groupOfItem(h, 1)).toBe('blocked');
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null, interactive: true }] });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(1)).toMatchObject({ status: 'awaiting-approval', readyAt: T0 + HOUR });

    h.act({ type: 'snooze', ticketId: 1, until: null });
    h.act({ type: 'restore', ticketId: 1 });
    expect(h.item(1).readyAt).toBe(T0 + HOUR);

    h.now = T0 + 3 * HOUR;
    const approved = h.started(h.act({ type: 'approve', workItemId: 1 })[0]);
    expect(h.item(1)).toMatchObject({ status: 'running', readyAt: T0 + HOUR });
    h.act({ type: 'stop', workItemId: 1 });
    h.act({ type: 'stop-succeeded', sessionId: approved, reason: 'operator' });
    expect(h.item(1)).toMatchObject({ status: 'blocked', readyAt: T0 + HOUR });
  });

  it('keeps an approved work item queued for a slot in Ready for review, holding no slot until it starts (PRD R38)', () => {
    const h = new Harness({ playbooks: playbooks(undefined, QUESTION), settings: settings({ sessions: { concurrency: 1 } }) });
    const first = ready(h, '1', 1);
    const other = running(h, '2', 2);

    expect(h.act({ type: 'approve', workItemId: 1 })).toEqual([]);
    expect(h.item(1).status).toBe('queued');
    expect(groupOfItem(h, 1)).toBe('review');
    expect(heldSlots(h.store)).toBe(1);

    h.act({ type: 'roster', sessions: [] });
    expect(h.item(2).status).toBe('blocked');
    expect(h.store.session(first)?.state).toBe('ended');
    expect(h.store.sessionsFor(1)).toHaveLength(2);
    expect(h.item(1).status).toBe('running');
    expect(h.store.session(other)?.state).toBe('ended');
  });

  it('starts empty on a new work item for a returned ticket (PRD R51)', () => {
    const h = new Harness({ playbooks: playbooks(undefined, QUESTION) });
    ready(h, '1', 1);
    h.act({ type: 'mark-done', workItemId: 1 });
    h.poll(issue('1', false));
    h.poll(issue('1'));

    expect(h.store.workItem(2)).toMatchObject({ ticketId: 1, readyAt: null, orderAt: null });
  });
});

describe('move (PRD R73)', () => {
  /** Four work items ready an hour apart, 1 first. */
  function four(): Harness {
    const h = new Harness({ playbooks: playbooks(undefined, QUESTION), settings: settings({ sessions: { concurrency: 4 } }) });

    for (const id of [1, 2, 3, 4]) {
      h.now = T0 + id * HOUR;
      ready(h, String(id), id);
    }

    h.now = T0 + 10 * HOUR;
    return h;
  }

  it('places a work item first, between two, or last, before now', () => {
    const h = four();

    h.act({ type: 'move', workItemId: 3, after: null });
    expect(order(h)).toEqual([3, 1, 2, 4]);
    expect(h.item(3).orderAt).toBe(T0 + HOUR - MINUTE);

    h.act({ type: 'move', workItemId: 4, after: 3 });
    expect(order(h)).toEqual([3, 4, 1, 2]);
    expect(h.item(4).orderAt).toBe(Math.floor((T0 + HOUR - MINUTE + T0 + HOUR) / 2));

    h.act({ type: 'move', workItemId: 1, after: 2 });
    expect(order(h)).toEqual([3, 4, 2, 1]);
    expect(h.item(1).orderAt).toBe(Math.floor((T0 + 2 * HOUR + T0 + 10 * HOUR) / 2));

    // A work item ready later comes last.
    h.now = T0 + 11 * HOUR;
    ready(h, '5', 5);
    expect(order(h)).toEqual([3, 4, 2, 1, 5]);
  });

  it('keeps the places of snoozed and blocked work items, which return where they were', () => {
    const h = four();

    h.act({ type: 'snooze', ticketId: 2, until: null });
    expect(h.send({ type: 'move', workItemId: 4, after: 2 }).refused).toBe('The work item is not in Ready for review.');
    h.act({ type: 'move', workItemId: 4, after: 1 });
    h.act({ type: 'restore', ticketId: 2 });
    expect(order(h)).toEqual([1, 4, 2, 3]);
  });

  it('respaces the whole order when no key fits between two work items, keeping every place', () => {
    const h = four();

    for (let moves = 0; moves < 40; moves++) {
      h.act({ type: 'move', workItemId: moves % 2 === 0 ? 3 : 4, after: 1 });
    }

    expect(order(h)).toEqual([1, 4, 3, 2]);
    expect(h.store.readyWorkItems().every((item) => (item.orderAt ?? item.readyAt!) < h.now)).toBe(true);
    const keys = h.store.readyWorkItems().map((item) => item.orderAt ?? item.readyAt!);
    expect(new Set(keys).size).toBe(4);
  });

  it('resets a moved work item to its place by readyAt', () => {
    const h = four();

    h.act({ type: 'move', workItemId: 4, after: null });
    h.act({ type: 'reset-position', workItemId: 4 });
    expect(h.item(4).orderAt).toBeNull();
    expect(order(h)).toEqual([1, 2, 3, 4]);
  });

  it('refuses a work item or a place outside Ready for review, and a move after itself', () => {
    const h = four();
    running(h, '9', 5);

    expect(h.send({ type: 'move', workItemId: 5, after: null }).refused).toBe('The work item is not in Ready for review.');
    expect(h.send({ type: 'move', workItemId: 1, after: 5 }).refused).toBe('The work item is not in Ready for review.');
    expect(h.send({ type: 'move', workItemId: 1, after: 1 }).refused).toBe('A work item cannot move after itself.');
    expect(h.send({ type: 'move', workItemId: 99, after: null }).refused).toBe('Unknown work item 99.');
    expect(h.send({ type: 'reset-position', workItemId: 5 }).refused).toBe('The work item is not in Ready for review.');
    expect(order(h)).toEqual([1, 2, 3, 4]);
  });
});
