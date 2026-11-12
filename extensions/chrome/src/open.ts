import { itemHref } from './board.js';
import { PILL } from './pills.js';

/** The VS Code URI whose handler runs the click of the ticket's row, bringing its item window forward (PRD R69). */
export function openUri(ticketUrl: string): string {
  return `vscode://switchboard.switchboard/open?url=${encodeURIComponent(ticketUrl)}`;
}

/**
 * Opens a board card's or table row's ticket in Switchboard when its pill is clicked or has focus when Enter is pressed,
 * before GitHub's own handlers open the item's side panel. The URL is the item's title link, the issue the pill was matched by.
 */
export function openFromPill(event: Event, open: (uri: string) => void): void {
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
  open(openUri(href));
}

/** Opens a board card's ticket in Switchboard from its pill (PRD R69). */
export function watchPillClicks(doc: Document, open: (uri: string) => void): { stop(): void } {
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
