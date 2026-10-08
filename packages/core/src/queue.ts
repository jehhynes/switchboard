import { groupOf } from './group.js';
import type { QueueWait, WorkItem } from './model.js';
import type { Store } from './store.js';

/** Live sessions that hold a slot: those whose row is in Working and whose ticket is not snoozed (PRD R38). */
export function heldSlots(store: Store): number {
  return store.activeSessions().filter((session) => {
    const item = store.workItem(session.workItemId)!;

    return !store.ticket(item.ticketId)!.snoozed && groupOf({ status: item.status, sessions: store.sessionsFor(item.id) }) === 'working';
  }).length;
}

/** Everything that keeps a queued work item from starting; the scheduler starts it only when the list is empty (PRD R17, R38, R49). */
export function queueWaits(store: Store, item: WorkItem, limit: number, used = heldSlots(store)): QueueWait[] {
  const waits: QueueWait[] = [];

  if (used >= limit) {
    waits.push({ kind: 'slot', used, limit });
  }

  for (const session of store.activeSessionsForTicket(item.ticketId)) {
    const ownItem = session.workItemId === item.id;

    waits.push({ kind: 'session', sessionId: session.id, shortId: session.shortId, ownItem, playbook: ownItem ? null : store.workItem(session.workItemId)!.playbook });
  }

  if (store.ticket(item.ticketId)!.snoozed) {
    waits.push({ kind: 'snoozed' });
  }

  return waits;
}
