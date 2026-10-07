import type { Snapshot, WorkItemView } from '@switchboard/hub';
import { groupOf, markOf, openAction } from './webview/render.js';
import type { Mark } from './webview/render.js';

function needsYou(item: WorkItemView): boolean {
  return groupOf(item) === 'needs' && !item.ticket.snoozed;
}

/**
 * The work items in Needs you in `next` that were not in `previous` (PRD R65). None for a connection's first snapshot (`previous`
 * null), so a reconnect does not toast what already needed the operator. A snoozed item counts only once it wakes.
 */
export function newlyNeeding(previous: Snapshot | null, next: Snapshot): WorkItemView[] {
  if (previous === null) {
    return [];
  }

  const before = new Set(previous.workItems.filter(needsYou).map((item) => item.id));

  return next.workItems.filter((item) => needsYou(item) && !before.has(item.id));
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

/** The toast text, such as `Switchboard: Fix the inbox badge — Approve the publish`, and whether it offers Open. */
export function toastOf(item: WorkItemView): { message: string; open: boolean } {
  // A Needs you item always has a mark; only Unstarted rows show the priority dot instead.
  const mark = markOf(item) as Mark;

  return { message: `Switchboard: ${item.ticket.title} — ${mark.title}`, open: openAction(item) !== null };
}
