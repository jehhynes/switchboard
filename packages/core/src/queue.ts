import { activeSession, groupOf } from './group.js';
import type { QueueWait, SessionState, WorkItem } from './model.js';
import type { Store } from './store.js';

/** States of a session whose turn is in progress; an idle or failed session waits for the operator and holds nothing back (PRD R17). */
const TURN_IN_PROGRESS: readonly SessionState[] = ['starting', 'running', 'waiting'];

/** Live sessions that hold a slot: each work item's active session, while its row is in Working and its ticket is not snoozed (PRD R38). */
export function heldSlots(store: Store): number {
  return store.activeSessions().filter((session) => {
    const item = store.workItem(session.workItemId)!;
    const sessions = store.sessionsFor(item.id);

    return activeSession({ sessions })?.id === session.id && !store.ticket(item.ticketId)!.snoozed && groupOf({ status: item.status, sessions }) === 'working';
  }).length;
}

/** Everything that keeps a queued work item from starting; the scheduler starts it only when the list is empty (PRD R17, R38, R49). */
export function queueWaits(store: Store, item: WorkItem, limit: number, used = heldSlots(store)): QueueWait[] {
  const waits: QueueWait[] = [];

  if (used >= limit) {
    waits.push({ kind: 'slot', used, limit });
  }

  for (const session of store.activeSessionsForTicket(item.ticketId).filter((entry) => TURN_IN_PROGRESS.includes(entry.state))) {
    const ownItem = session.workItemId === item.id;

    waits.push({ kind: 'session', sessionId: session.id, shortId: session.shortId, ownItem, playbook: ownItem ? null : store.workItem(session.workItemId)!.playbook });
  }

  if (store.ticket(item.ticketId)!.snoozed) {
    waits.push({ kind: 'snoozed' });
  }

  return waits;
}
