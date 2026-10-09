import { urlKey } from '@switchboard/core/group';
import type { PoolView, Snapshot, WorkItemView } from '@switchboard/hub';
import { listGroups, rowKeyOf } from '@switchboard/hub/rows';
import type { RowGroup } from '@switchboard/hub/rows';

/** A row by its work item, or by its pool ticket. */
export type RowTarget = { workItemId: number } | { ticketId: number };

function targetOf(entry: WorkItemView | PoolView): RowTarget {
  return 'status' in entry ? { workItemId: entry.id } : { ticketId: entry.ticket.id };
}

function rows(snapshot: Snapshot): { group: RowGroup; entry: WorkItemView | PoolView }[] {
  return Object.entries(listGroups(snapshot)).flatMap(([group, entries]) => entries.map((entry) => ({ group: group as RowGroup, entry })));
}

/**
 * The row Open in Switchboard opens for a URL (PRD R69): the first row in list order whose ticket has the URL, else the first
 * row whose ticket has a link to it, such as its pull request (PRD R52). URLs compare by `urlKey`. Null when no row the dock shows has it.
 */
export function targetForUrl(snapshot: Snapshot, url: string): RowTarget | null {
  const key = urlKey(url);
  const shown = rows(snapshot).map(({ entry }) => entry);
  const found =
    shown.find((entry) => entry.ticket.url !== '' && urlKey(entry.ticket.url) === key) ??
    shown.find((entry) => entry.links.some((link) => urlKey(link.target) === key));

  return found === undefined ? null : targetOf(found);
}

/** The ticket URL of a `vscode://switchboard.switchboard/open?url=<url>` URI's path and decoded query, or null for another URI. */
export function openUrlOf(path: string, query: string): string | null {
  return path === '/open' && query.startsWith('url=') && query.length > 4 ? query.slice(4) : null;
}

/**
 * The key of the row that shows the target, or null when the dock shows none. A work item hidden in Snoozed, where a ticket
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
