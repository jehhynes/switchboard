import { urlKey } from '@switchboard/core/group';
import type { PoolView, Snapshot, WorkItemView } from '@switchboard/hub';
import { GROUP_TITLES, linkKind, linkNumber, panelGroups, playbookText, rowKeyOf, ticketKey } from '@switchboard/hub/rows';
import type { RowGroup } from '@switchboard/hub/rows';

/** A panel row by its work item, or by its pool ticket. */
export type RowTarget = { workItemId: number } | { ticketId: number };

export interface SearchEntry {
  /** The ticket's title. */
  label: string;
  /** The key, linked pull requests and issues, playbook and group, such as `gh 18941 · PR #19002 · dev:develop · Needs you`. */
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

/** The row's linked GitHub pull requests and issues as `PR #<n>` and `gh <n>`, as the row's badges show them (PRD R52). */
function linkedKeys(entry: WorkItemView | PoolView): string[] {
  const keys = entry.links.flatMap((link) => {
    const kind = linkKind(link.target);
    const number = linkNumber(link.target);

    return kind === 'url' || number === null ? [] : [kind === 'pr' ? `PR #${number}` : `gh ${number}`];
  });

  // A link to the ticket itself repeats its key.
  return [...new Set(keys)].filter((key) => key !== ticketKey(entry.ticket));
}

/** A quick pick entry for every row the panel shows, in panel order (PRD R63). */
export function searchEntries(snapshot: Snapshot): SearchEntry[] {
  return rows(snapshot).map(({ group, entry }) => {
    const branch = 'status' in entry ? entry.worktree?.branch : undefined;
    const description = [ticketKey(entry.ticket), ...linkedKeys(entry), playbookText(entry, snapshot.namespaces), GROUP_TITLES[group]].filter((part) => part !== '').join(' · ');

    return { label: entry.ticket.title, description, ...(branch ? { detail: branch } : {}), target: targetOf(entry) };
  });
}

/**
 * The row Open in Switchboard reveals for a URL (PRD R69): the first row in panel order whose ticket has the URL, else the first
 * row whose ticket has a link to it, such as its pull request (PRD R52). URLs compare by `urlKey`. Null when no row the panel shows has it.
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
