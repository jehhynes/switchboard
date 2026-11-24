import { MARK_TITLES, markOf, needsYou } from '@switchboard/core/group';
import type { Mark } from '@switchboard/core/group';
import { listGroups, rowKeyOf } from './rows.js';
import type { PoolView, Snapshot, WorkItemView } from './snapshot.js';

/**
 * The work items on the operator's turn in `next` that were not in `previous` (PRD R65). None for the first build (`previous` null), so a hub
 * restart does not announce what already needed the operator. A snoozed item counts only once it wakes. An item that held an approval while
 * its session ran again does not count, because the operator was working in that session.
 */
export function newlyNeeding(previous: Snapshot | null, next: Snapshot): WorkItemView[] {
  if (previous === null) {
    return [];
  }

  const before = new Map(previous.workItems.map((item) => [item.id, item]));

  return next.workItems.filter((item) => {
    const was = before.get(item.id);

    return needsYou(item) && (was === undefined || (!needsYou(was) && (was.ticket.snoozed || !was.approvalHeld)));
  });
}

/** Why a work item that started needing the operator needs them: its mark's tooltip, such as `Approve to send`. */
export function needsReason(item: WorkItemView): string {
  // A work item on the operator's turn always has a mark; only Unstarted rows can have none.
  return MARK_TITLES[markOf(item) as Mark];
}

/** The dock's message for a work item that started needing the operator, such as `Switchboard: Fix the inbox badge — Approve to send`. */
export function needsMessage(item: WorkItemView): string {
  return `Switchboard: ${item.ticket.title} — ${needsReason(item)}`;
}

/** A row by its work item, or by its pool ticket. */
export type RowTarget = { workItemId: number } | { ticketId: number };

function shownEntries(snapshot: Snapshot): Array<WorkItemView | PoolView> {
  return Object.values(listGroups(snapshot)).flat();
}

/** The key of the row that shows the target, or null; a work item hidden in Snoozed, where a ticket shows as one row, finds its ticket's row (PRD R49). */
export function rowFor(snapshot: Snapshot, target: RowTarget): string | null {
  const shown = shownEntries(snapshot);
  const direct = shown.find((entry) => ('workItemId' in target ? 'status' in entry && entry.id === target.workItemId : !('status' in entry) && entry.ticket.id === target.ticketId));

  if (direct !== undefined) {
    return rowKeyOf(direct);
  }

  const item = 'workItemId' in target ? snapshot.workItems.find((candidate) => candidate.id === target.workItemId) : undefined;
  const standIn = item?.ticket.snoozed === true ? shown.find((entry) => entry.ticket.id === item.ticketId) : undefined;

  return standIn === undefined ? null : rowKeyOf(standIn);
}

