import { groupOf, triageLabel } from '@switchboard/core';
import type { Card } from '@switchboard/core';
import type { Snapshot } from './runtime.js';

/**
 * One card per ticket URL of a polled source, for the Chrome extension (PRD R67). A ticket shows as its pool entry,
 * otherwise its open work item, otherwise its latest one, as in Snoozed (PRD R49). Links are the ticket's (PRD R52).
 */
export function cardsOf(snapshot: Snapshot): Card[] {
  const polled = new Set(snapshot.sources);
  const cards = new Map<string, { card: Card; open: boolean; id: number }>();

  for (const item of snapshot.workItems) {
    const { ticket } = item;

    if (ticket.url === '' || !polled.has(ticket.source)) {
      continue;
    }

    const open = item.status !== 'done';
    const shown = cards.get(ticket.url);

    if (shown === undefined || (!shown.open && (open || item.id > shown.id))) {
      const playbook = item.status === 'triaging' ? triageLabel(ticket.source, snapshot.namespaces) : item.playbook;

      const links = item.links.map((link) => link.target);

      cards.set(ticket.url, { card: { url: ticket.url, playbook, group: groupOf(item), snoozed: ticket.snoozed, links }, open, id: item.id });
    }
  }

  // The snapshot's pool holds only tickets whose work items are all done, of polled sources.
  for (const { ticket, triage, links } of snapshot.pool) {
    if (ticket.url !== '') {
      const triaging = triage !== null && triage.endedAt === null;
      const playbook = triaging ? triageLabel(ticket.source, snapshot.namespaces) : (triage?.playbook ?? null);

      cards.set(ticket.url, { card: { url: ticket.url, playbook, group: 'unstarted', snoozed: ticket.snoozed, links: links.map((link) => link.target) }, open: true, id: 0 });
    }
  }

  return [...cards.values()].map(({ card }) => card);
}
