import { describe, expect, it } from 'vitest';
import { Harness, HOUR, issue, T0 } from './flowHarness.js';

describe('Comments (PRD R87)', () => {
  it('adds a trimmed comment to an open or done work item and logs its text, oldest first', () => {
    const h = new Harness();
    h.poll(issue('1'));

    expect(h.send({ type: 'comment', workItemId: 1, text: '  Waiting on Dana.\nAsk again Monday.\n' }).refused).toBeNull();
    h.act({ type: 'mark-done', workItemId: 1 });
    h.now = T0 + HOUR;
    expect(h.send({ type: 'comment', workItemId: 1, text: 'Shipped.' }).refused).toBeNull();

    expect(h.store.commentsFor(1)).toEqual([
      { id: 1, workItemId: 1, at: T0, text: 'Waiting on Dana.\nAsk again Monday.' },
      { id: 2, workItemId: 1, at: T0 + HOUR, text: 'Shipped.' },
    ]);
    expect(h.store.ticketHistory(1)!.events.filter((event) => event.type === 'comment')).toMatchObject([
      { actor: 'operator', workItemId: 1, detail: { text: 'Waiting on Dana.\nAsk again Monday.' } },
      { actor: 'operator', workItemId: 1, detail: { text: 'Shipped.' } },
    ]);
  });

  it('refuses a blank comment or an unknown work item and stores nothing', () => {
    const h = new Harness();
    h.poll(issue('1'));

    expect(h.send({ type: 'comment', workItemId: 1, text: ' \n\t' }).refused).toBe('The comment is empty.');
    expect(h.send({ type: 'comment', workItemId: 9, text: 'Hello' }).refused).toBe('Unknown work item 9.');
    expect(h.store.commentsFor(1)).toEqual([]);
  });

  it('deletes the comments with their work item (PRD R76)', () => {
    const h = new Harness();
    h.poll(issue('1'));
    h.act({ type: 'comment', workItemId: 1, text: 'Note' });
    h.act({ type: 'delete', workItemId: 1 });

    expect(h.store.commentsFor(1)).toEqual([]);
  });
});

describe('Snooze comment (PRD R49)', () => {
  it('keeps the trimmed comment while snoozed, logs it with the snooze, and replaces it with a later snooze', () => {
    const h = new Harness();
    h.poll(issue('1'));

    h.act({ type: 'snooze', ticketId: 1, until: T0 + 2 * HOUR, comment: '  Waiting for the release.  ' });
    expect(h.store.ticket(1)).toMatchObject({ snoozed: true, snoozedUntil: T0 + 2 * HOUR, snoozeComment: 'Waiting for the release.' });
    expect(h.store.ticketHistory(1)!.events.at(-1)).toMatchObject({ type: 'snooze', detail: { until: T0 + 2 * HOUR, comment: 'Waiting for the release.' } });

    h.act({ type: 'snooze', ticketId: 1, until: T0 + HOUR, comment: ' ' });
    expect(h.store.ticket(1)).toMatchObject({ snoozedUntil: T0 + HOUR, snoozeComment: null });
    expect(h.store.ticketHistory(1)!.events.at(-1)).toMatchObject({ type: 'snooze', detail: { until: T0 + HOUR } });
    expect(h.store.ticketHistory(1)!.events.at(-1)!.detail).not.toHaveProperty('comment');
  });

  it('clears the comment when the snooze ends by Restore, by its wake time or by the ticket leaving scope', () => {
    const h = new Harness();
    h.poll(issue('1'), issue('2'), issue('3'));
    for (const ticketId of [1, 2, 3]) {
      h.act({ type: 'snooze', ticketId, until: ticketId === 2 ? T0 + HOUR : null, comment: 'Later' });
    }

    h.act({ type: 'restore', ticketId: 1 });
    h.now = T0 + HOUR;
    h.poll(issue('1'), issue('2'));

    for (const ticketId of [1, 2, 3]) {
      expect(h.store.ticket(ticketId)).toMatchObject({ snoozed: false, snoozeComment: null });
    }
  });

  it('leaves the ticket and its comment as they were when the wake time has passed', () => {
    const h = new Harness();
    h.poll(issue('1'));
    h.act({ type: 'snooze', ticketId: 1, until: null, comment: 'First' });

    expect(h.send({ type: 'snooze', ticketId: 1, until: T0, comment: 'Second' }).refused).toBe('The snooze time has passed.');
    expect(h.store.ticket(1)).toMatchObject({ snoozed: true, snoozedUntil: null, snoozeComment: 'First' });
  });
});
