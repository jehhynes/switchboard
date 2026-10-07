import type { PoolView, Snapshot, WorkItemView } from '@switchboard/hub';
import { GROUP_TITLES, panelGroups, playbookText, rowKeyOf, ticketKey } from './webview/render.js';
import type { RowGroup } from './webview/render.js';

/** A panel row by its work item, or by its pool ticket. */
export type RowTarget = { workItemId: number } | { ticketId: number };

export interface SearchEntry {
  /** The ticket's title. */
  label: string;
  /** The key, playbook and group, such as `gh 18941 · dev:develop · Needs you`. */
  description: string;
  /** The worktree's branch, when there is one. */
  detail?: string;
  target: RowTarget;
}

function targetOf(entry: WorkItemView | PoolView): RowTarget {
  return 'status' in entry ? { workItemId: entry.id } : { ticketId: entry.ticket.id };
}

function rows(snapshot: Snapshot): { group: RowGroup; entry: WorkItemView | PoolView }[] {
  return Object.entries(panelGroups(snapshot)).flatMap(([group, entries]) => entries.map((entry) => ({ group: group as RowGroup, entry })));
}

/** A quick pick entry for every row the panel shows, in panel order (PRD R63). */
export function searchEntries(snapshot: Snapshot): SearchEntry[] {
  return rows(snapshot).map(({ group, entry }) => {
    const branch = 'status' in entry ? entry.worktree?.branch : undefined;
    const description = [ticketKey(entry.ticket), playbookText(entry, snapshot.namespaces), GROUP_TITLES[group]].filter((part) => part !== '').join(' · ');

    return { label: entry.ticket.title, description, ...(branch ? { detail: branch } : {}), target: targetOf(entry) };
  });
}

/**
 * The key of the row that shows the target, or null when the panel shows none. A work item hidden in Snoozed, where a ticket
 * shows as one row, finds that ticket's row (PRD R49).
 */
export function rowFor(snapshot: Snapshot, target: RowTarget): string | null {
  const shown = rows(snapshot).map(({ entry }) => entry);
  const direct = shown.find((entry) =>
    'workItemId' in target ? 'status' in entry && entry.id === target.workItemId : !('status' in entry) && entry.ticket.id === target.ticketId,
  );

  if (direct !== undefined) {
    return rowKeyOf(direct);
  }

  const item = 'workItemId' in target ? snapshot.workItems.find((candidate) => candidate.id === target.workItemId) : undefined;
  const standIn = item?.ticket.snoozed ? shown.find((entry) => entry.ticket.id === item.ticketId) : undefined;

  return standIn === undefined ? null : rowKeyOf(standIn);
}
