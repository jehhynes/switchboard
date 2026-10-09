import type { Snapshot } from '@switchboard/hub';
import { groupOf } from '@switchboard/core/group';

/** Work items in the dock's Needs you group: snoozed ones show under Snoozed instead (PRD R27, R49). */
export function needsCount(snapshot: Snapshot): number {
  return snapshot.workItems.filter((item) => !item.ticket.snoozed && groupOf(item) === 'needs').length;
}

/** The status bar item's text and tooltip: the Needs you count, or none at 0 (PRD R64). */
export function needsStatus(snapshot: Snapshot | null): { text: string; tooltip: string } {
  const count = snapshot === null ? 0 : needsCount(snapshot);
  const needs = count === 0 ? 'Nothing needs you' : `${count} ${count === 1 ? 'needs' : 'need'} you`;

  return { text: count === 0 ? '$(checklist)' : `$(checklist) ${count}`, tooltip: `Switchboard: ${needs}. Click to show the dock.` };
}
