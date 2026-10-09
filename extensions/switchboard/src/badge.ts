import type { Snapshot } from '@switchboard/hub';
import { groupOf } from '@switchboard/core/group';

/** Work items in the panel's Needs you group: snoozed ones show under Snoozed instead (PRD R27, R49). */
export function needsCount(snapshot: Snapshot): number {
  return snapshot.workItems.filter((item) => !item.ticket.snoozed && groupOf(item) === 'needs').length;
}

/** The activity bar badge for a snapshot, or undefined to clear it when nothing needs the operator (PRD R64). */
export function needsBadge(snapshot: Snapshot): { value: number; tooltip: string } | undefined {
  const count = needsCount(snapshot);

  return count === 0 ? undefined : { value: count, tooltip: `${count} ${count === 1 ? 'needs' : 'need'} you` };
}
