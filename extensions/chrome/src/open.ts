import type { Card } from '@switchboard/core/group';
import { itemHref } from './board.js';
import { PILL } from './pills.js';

/**
 * The web page's address for a ticket's card (PRD R69, R121): its work item's conversation, or the page for a pool ticket or a card the hub has
 * not sent.
 */
export function pageOpenUrl(origin: string, card: Pick<Card, 'workItemId'> | undefined): string {
  const id = card?.workItemId;

  return typeof id === 'number' ? `${origin}/page/#w=${id}` : `${origin}/page/`;
}

/**
 * Opens a board card's or table row's ticket in Switchboard when its pill is clicked or has focus when Enter is pressed,
 * before GitHub's own handlers open the item's side panel. The URL is the item's title link, the issue the pill was matched by.
 */
export function openFromPill(event: Event, open: (ticketUrl: string) => void): void {
  if (event instanceof KeyboardEvent && event.key !== 'Enter') {
    return;
  }

  const pill = event.target instanceof Element ? event.target.closest(`.${PILL}`) : null;
  const href = pill === null || pill === undefined ? undefined : itemHref(pill);

  if (href === undefined) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  open(href);
}

/** Opens a board card's ticket in Switchboard from its pill (PRD R69). */
export function watchPillClicks(doc: Document, open: (ticketUrl: string) => void): { stop(): void } {
  const onPill = (event: Event): void => openFromPill(event, open);

  // Capture on the document runs before GitHub's handlers, which React attaches lower down.
  doc.addEventListener('click', onPill, true);
  doc.addEventListener('keydown', onPill, true);

  return {
    stop: () => {
      doc.removeEventListener('click', onPill, true);
      doc.removeEventListener('keydown', onPill, true);
    },
  };
}
