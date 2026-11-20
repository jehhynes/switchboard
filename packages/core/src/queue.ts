import { activeSession, holdsSlot } from './group.js';
import { providerLimitUntil } from './limit.js';
import type { QueueWait, SessionState, WorkItem } from './model.js';
import type { Provider } from './settings.js';
import type { Store } from './store.js';

/** States of a session whose turn is in progress; an idle or failed session waits for the operator and holds nothing back (PRD R17). */
const TURN_IN_PROGRESS: readonly SessionState[] = ['starting', 'running', 'waiting'];

/** Live sessions that hold a slot: each work item's active session, while the work item runs, not waiting on a question, and not snoozed (PRD R38). */
export function heldSlots(store: Store): number {
  return store.activeSessions().filter((session) => {
    const item = store.workItem(session.workItemId)!;
    const sessions = store.sessionsFor(item.id);

    const ticket = store.ticket(item.ticketId)!;

    // A hosted conversation stays open between turns, so it holds a slot only while its session is in a turn (architecture.md § Hosted conversations).
    return activeSession({ sessions })?.id === session.id && !ticket.snoozed && holdsSlot({ status: item.status, sessions }) && (ticket.hostWindow == null || TURN_IN_PROGRESS.includes(session.state));
  }).length;
}

/**
 * Everything that keeps a queued work item from starting; the scheduler starts it only when the list is empty (PRD R17, R38, R49, R90). With
 * `provider`, the provider its next session starts in, a usage limit of that provider holds it until the reset (architecture.md § Rate limits).
 */
export function queueWaits(store: Store, item: WorkItem, limit: number, used = heldSlots(store), provider: Provider | null = null, now = 0): QueueWait[] {
  const waits: QueueWait[] = [];

  if (used >= limit) {
    waits.push({ kind: 'slot', used, limit });
  }

  for (const session of store.activeSessionsForTicket(item.ticketId).filter((entry) => TURN_IN_PROGRESS.includes(entry.state))) {
    const ownItem = session.workItemId === item.id;

    waits.push({ kind: 'session', sessionId: session.id, shortId: session.shortId, ownItem, playbook: ownItem ? null : store.workItem(session.workItemId)!.playbook });
  }

  const ticket = store.ticket(item.ticketId)!;

  if (ticket.snoozed) {
    waits.push({ kind: 'snoozed' });
  }

  if (ticket.blockers?.length) {
    waits.push({ kind: 'blockers', blockers: ticket.blockers });
  }

  const until = provider === null ? null : providerLimitUntil(store.activeSessions(), provider, now);

  if (until !== null) {
    waits.push({ kind: 'limit', provider: provider!, until });
  }

  return waits;
}
