import type { Card } from '@switchboard/core/group';
import { urlKey } from '@switchboard/core/group';
import { REFRESH_MS } from './board.js';
import { PILL } from './pills.js';

const LINK = 'switchboard-open';

/** The VS Code URI whose handler reveals the ticket's row in the Switchboard panel and runs its click action (PRD R69). */
export function openUri(ticketUrl: string): string {
  return `vscode://switchboard.switchboard/open?url=${encodeURIComponent(ticketUrl)}`;
}

/**
 * The card for a GitHub issue or pull request page: the ticket with the page's URL, else a ticket with a link to it, such as its
 * pull request (PRD R52). Null for any other page, or a page no card has.
 */
export function cardForPage(cards: readonly Card[], pageUrl: string): Card | null {
  const key = urlKey(pageUrl);

  if (!key.startsWith('github.com/')) {
    return null;
  }

  return cards.find((card) => urlKey(card.url) === key) ?? cards.find((card) => (card.links ?? []).some((link) => urlKey(link) === key)) ?? null;
}

/**
 * Keeps an **Open in Switchboard** link after the title of an issue or pull request page whose ticket the hub knows, and no link
 * otherwise. A link that is already right is left alone, so a pass that changes nothing makes no mutation.
 */
export function applyPageLink(doc: Document, card: Card | null): void {
  // The page title; a pull request's sticky header comes later in the page and has no `data-component`.
  const area = doc.querySelector('h1[data-component="PH_Title"]')?.parentElement ?? null;
  const existing = doc.querySelector<HTMLAnchorElement>(`a.${LINK}`);

  if (card === null || area === null) {
    existing?.remove();
    return;
  }

  const href = openUri(card.url);

  if (existing?.parentElement === area && existing.getAttribute('href') === href) {
    return;
  }

  existing?.remove();

  const link = doc.createElement('a');

  link.className = LINK;
  link.href = href;
  link.title = 'Show this work item in the Switchboard panel in VS Code';
  link.textContent = 'Open in Switchboard';
  area.append(link);
}

/**
 * Opens a board card's ticket in Switchboard when its pill is clicked or has focus when Enter is pressed, before GitHub's own
 * handlers open the card's side panel. The URL is the card's title link, the issue the pill was matched by.
 */
export function openFromPill(event: Event, open: (uri: string) => void): void {
  if (event instanceof KeyboardEvent && event.key !== 'Enter') {
    return;
  }

  const pill = event.target instanceof Element ? event.target.closest(`.${PILL}`) : null;
  const href = pill?.closest('[data-board-card-id]')?.querySelector('h3[id^="board-card-title-"]')?.closest('a')?.href;

  if (href === undefined) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  open(openUri(href));
}

/**
 * Open in Switchboard on GitHub (PRD R69): a link on issue and pull request pages the hub has a card for, and a click on a board
 * card's pill. Reads the cards only on such a page, when it changes, every `REFRESH_MS` and when the tab becomes visible. A failed
 * read removes the link.
 */
export function watchOpen(
  doc: Document,
  read: () => Promise<Card[] | null>,
  open: (uri: string) => void,
  { now = Date.now, href = () => doc.location.href }: { now?: () => number; href?: () => string } = {},
): { stop(): void } {
  let cards: Card[] = [];
  let readFor: string | null = null;
  let readAt = -Infinity;
  let reads = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const apply = (): void => applyPageLink(doc, cardForPage(cards, href()));

  const update = (): void => {
    const page = urlKey(href());

    if (!page.startsWith('github.com/')) {
      apply();
      return;
    }

    if (page !== readFor || now() - readAt >= REFRESH_MS) {
      readFor = page;
      readAt = now();

      const current = ++reads;

      void read().then((result) => {
        // A read that a later one overtook would restore what the later one removed.
        if (current === reads) {
          cards = result ?? [];
          apply();
        }
      });
    }

    apply();
  };

  const onPill = (event: Event): void => openFromPill(event, open);
  const observer = new MutationObserver(() => {
    pending ??= setTimeout(() => {
      pending = undefined;
      update();
    }, 50);
  });
  const onVisible = (): void => {
    if (doc.visibilityState === 'visible') {
      readAt = -Infinity;
      update();
    }
  };
  const timer = setInterval(update, REFRESH_MS);

  // Capture on the document runs before GitHub's handlers, which React attaches lower down.
  doc.addEventListener('click', onPill, true);
  doc.addEventListener('keydown', onPill, true);
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener('visibilitychange', onVisible);
  update();

  return {
    stop: () => {
      observer.disconnect();
      clearInterval(timer);
      clearTimeout(pending);
      doc.removeEventListener('click', onPill, true);
      doc.removeEventListener('keydown', onPill, true);
      doc.removeEventListener('visibilitychange', onVisible);
    },
  };
}
