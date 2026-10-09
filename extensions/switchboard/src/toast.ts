import type { Snapshot, WorkItemView } from '@switchboard/hub';
import { windowOf } from '@switchboard/hub';
import { MARK_TITLES, markOf, needsYou } from '@switchboard/core/group';
import type { Mark } from '@switchboard/core/group';

/**
 * The work items on the operator's turn in `next` that were not in `previous` (PRD R65). None for a connection's first snapshot (`previous`
 * null), so a reconnect does not toast what already needed the operator. A snoozed item counts only once it wakes. An item that
 * held an approval while its session ran again does not count, because the operator was working in that session.
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

/** Tracks one window's hub connection: each snapshot returns the items to toast (PRD R65). */
export class NeedsYouTracker {
  private previous: Snapshot | null = null;

  /** A new connection: its first snapshot sets what already needs the operator and returns nothing. */
  connected(): void {
    this.previous = null;
  }

  update(snapshot: Snapshot): WorkItemView[] {
    const items = newlyNeeding(this.previous, snapshot);

    this.previous = snapshot;
    return items;
  }
}

/** The toast text, such as `Switchboard: Fix the inbox badge — Approve to send`, and whether it offers Open. */
export function toastOf(item: WorkItemView): { message: string; open: boolean } {
  // A work item on the operator's turn always has a mark; only Unstarted rows can have none.
  const mark = markOf(item) as Mark;

  // Open runs the row's click: its item window, or its ticket for a row with none (PRD R71).
  return { message: `Switchboard: ${item.ticket.title} — ${MARK_TITLES[mark]}`, open: windowOf(item, '') !== null || item.ticket.url !== '' };
}
