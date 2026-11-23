/**
 * The dock's search of work done before its Done list (PRD R63): the dock filters the rows it has, and asks the hub only when the operator widens
 * the searched range past them.
 */
import type { Link, Store, Ticket, WorkItem } from '@switchboard/core';
import { dockRow, searchText } from './dock.js';
import type { DockRow } from './dock.js';
import { doneSince } from './rows.js';
import { workItemViews } from './snapshot.js';
import type { Snapshot, SnapshotInputs, WorkItemView } from './snapshot.js';

/** The most rows one search answers; the dock says there are more. */
export const SEARCH_LIMIT = 100;

export interface DockSearch {
  /** The matching Done rows, newest first, each in a band named by its month, such as `October 2026`. */
  rows: DockRow[];
  /** Whether more rows matched than `SEARCH_LIMIT`. */
  more: boolean;
}

/** The words of a search, in lower case; a row matches when its search text holds every one. */
export function searchWords(text: string): string[] {
  return text.toLocaleLowerCase().split(/\s+/).filter((word) => word !== '');
}

/** An older Done row's band: its month, such as `October 2026`. */
export function monthBand(doneAt: number): string {
  return new Date(doneAt).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Searches Done rows from a time up to the start of the snapshot's Done list. The search texts of a range are read once per snapshot, because
 * each change to the store builds a new one, so the searches as the operator types filter them in memory; only matches get a whole view.
 */
export class DoneSearch {
  #texts: { snapshot: Snapshot; since: number; until: number; entries: Array<{ id: number; text: string }> } | null = null;

  search(store: Store, snapshot: Snapshot, inputs: SnapshotInputs, text: string, since: number, windows: string): DockSearch {
    const words = searchWords(text);
    const until = doneSince(inputs.now);

    if (words.length === 0 || since >= until) {
      return { rows: [], more: false };
    }

    const matched: number[] = [];

    for (const entry of this.#entries(store, snapshot, since, until)) {
      if (words.every((word) => entry.text.includes(word))) {
        matched.push(entry.id);

        if (matched.length > SEARCH_LIMIT) {
          break;
        }
      }
    }

    const { view } = workItemViews(store, inputs);
    const items = matched.slice(0, SEARCH_LIMIT).flatMap((id) => store.workItem(id) ?? []);

    return {
      rows: items.map((item: WorkItem) => dockRow(snapshot, view(item), 'done', inputs.now, windows, null, monthBand(item.doneAt ?? item.createdAt))),
      more: matched.length > SEARCH_LIMIT,
    };
  }

  #entries(store: Store, snapshot: Snapshot, since: number, until: number): Array<{ id: number; text: string }> {
    const kept = this.#texts;

    if (kept !== null && kept.snapshot === snapshot && kept.since === since && kept.until === until) {
      return kept.entries;
    }

    const entries = store.doneSearchEntries(since, until).map((entry) => {
      const shown = {
        status: 'done' as const,
        playbook: entry.playbook,
        parentId: entry.parentId,
        taskPrompt: entry.prompted ? '' : null,
        interactive: entry.interactive,
        moved: entry.ticket.adhocKey !== null && entry.first,
        ticket: entry.ticket as Ticket,
        links: entry.links.map((target) => ({ target }) as Link),
        worktree: entry.branch === null ? null : ({ branch: entry.branch } as WorkItemView['worktree']),
      };

      return { id: entry.id, text: searchText(shown, 'done', snapshot).toLocaleLowerCase() };
    });

    this.#texts = { snapshot, since, until, entries };

    return entries;
  }
}
