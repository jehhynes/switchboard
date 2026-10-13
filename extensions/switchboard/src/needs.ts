import type { Snapshot } from '@switchboard/hub';
import { needsYou } from '@switchboard/core/group';

/** Unsnoozed work items on the operator's turn: Blocked on you, and Ready for review rows on their turn (PRD R27, R49, R64). */
export function needsCount(snapshot: Snapshot): number {
  return snapshot.workItems.filter(needsYou).length;
}

/** The status bar item's text and tooltip: the count of work items on the operator's turn, or none at 0 (PRD R64). */
export function needsStatus(snapshot: Snapshot | null): { text: string; tooltip: string } {
  const count = snapshot === null ? 0 : needsCount(snapshot);
  const needs = count === 0 ? 'Nothing needs you' : `${count} ${count === 1 ? 'needs' : 'need'} you`;

  return { text: count === 0 ? '$(switchboard-logo)' : `$(switchboard-logo) ${count}`, tooltip: `Switchboard: ${needs}. Click to show the dock.` };
}
