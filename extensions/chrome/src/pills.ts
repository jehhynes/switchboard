import type { Card, Group } from '@switchboard/core/group';
import { REFRESH_MS, issueKey } from './board.js';
import { BROWSER_PORT } from './hub.js';

export const CARDS_URL = `http://127.0.0.1:${BROWSER_PORT}/cards`;

export const PILL = 'switchboard-pill';
const GROUPS: Record<Group, string> = { needs: 'Needs you', working: 'Working', unstarted: 'Unstarted', done: 'Done' };

function isCard(value: unknown): value is Card {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const card = value as Record<string, unknown>;

  return typeof card['url'] === 'string' && (card['playbook'] === null || typeof card['playbook'] === 'string') && typeof card['group'] === 'string' && Object.hasOwn(GROUPS, card['group']) && typeof card['snoozed'] === 'boolean';
}

/** The hub's cards, or null when the hub does not answer or answers with something else, such as a hub older than PRD R67. */
export async function readCards(fetchUrl: (url: string) => Promise<Response>): Promise<Card[] | null> {
  try {
    const response = await fetchUrl(CARDS_URL);

    if (!response.ok) {
      return null;
    }

    const body: unknown = await response.json();
    const cards = typeof body === 'object' && body !== null ? (body as { cards?: unknown }).cards : undefined;

    return Array.isArray(cards) && cards.every(isCard) ? cards : null;
  } catch {
    return null;
  }
}

/** Cards by `owner/repo#number`, leaving out URLs that are not GitHub issues. */
export function cardsByIssue(cards: readonly Card[]): Map<string, Card> {
  return new Map(cards.flatMap((card) => {
    const key = issueKey(card.url);

    return key === null ? [] : [[key, card] as const];
  }));
}

function pill(doc: Document, card: Card): HTMLElement {
  const element = doc.createElement('span');
  const label = card.playbook ?? GROUPS[card.group];
  const colon = label.indexOf(':');
  const namespace = doc.createElement('span');

  element.className = PILL;
  // A link to the ticket's row in VS Code, which open.ts follows on a click or Enter (PRD R69).
  element.tabIndex = 0;
  element.setAttribute('role', 'link');
  element.dataset['switchboardGroup'] = card.snoozed ? 'snoozed' : card.group;
  element.title = `Switchboard: ${card.snoozed ? 'Snoozed' : GROUPS[card.group]}. Click to open in VS Code.`;
  namespace.className = 'switchboard-namespace';
  namespace.textContent = label.slice(0, colon + 1);
  element.append(namespace, label.slice(colon + 1));

  return element;
}

/**
 * Puts a pill after the issue reference in each loaded card's header, naming the playbook Switchboard chose and coloured
 * by the panel group (PRD R67). A pill that matches its card is left alone, so a pass that changes nothing makes no mutation.
 */
export function applyPills(root: ParentNode, cards: ReadonlyMap<string, Card>): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-board-column] [data-board-card-id]')) {
    // The title link, because a card's fields can link other issues.
    const href = element.querySelector('h3[id^="board-card-title-"]')?.closest('a')?.href;
    const header = element.querySelector('[id^="board-card-header-title-"]');
    const existing = element.querySelector(`.${PILL}`);
    const key = href === undefined ? null : issueKey(href);
    const card = key === null ? undefined : cards.get(key);

    if (card === undefined || header === null) {
      existing?.remove();
      continue;
    }

    const wanted = pill(element.ownerDocument, card);

    if (existing === null || !existing.isEqualNode(wanted) || existing.previousElementSibling !== header) {
      existing?.remove();
      header.after(wanted);
    }
  }
}

/**
 * Keeps the pills on a GitHub project board's cards while GitHub renders it. Reads the cards only while a board is on the
 * page, when one appears, every `REFRESH_MS`, when the tab becomes visible and on `refresh`. A failed read removes every pill.
 */
export function watchPills(
  doc: Document,
  read: () => Promise<Card[] | null>,
  now: () => number = Date.now,
  onCards: (cards: Card[] | null) => void = () => {},
): { refresh(): void; stop(): void } {
  let cards = new Map<string, Card>();
  let readAt = -Infinity;
  let reads = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const update = (): void => {
    if (doc.querySelector('[data-board-column]') === null) {
      return;
    }

    if (now() - readAt >= REFRESH_MS) {
      readAt = now();

      const current = ++reads;

      void read().then((result) => {
        // A read that a later one overtook would restore what the later one removed.
        if (current === reads) {
          cards = cardsByIssue(result ?? []);
          applyPills(doc, cards);
          onCards(result);
        }
      });
    }

    applyPills(doc, cards);
  };

  const observer = new MutationObserver(() => {
    pending ??= setTimeout(() => {
      pending = undefined;
      update();
    }, 50);
  });
  const refresh = (): void => {
    readAt = -Infinity;
    update();
  };
  const onVisible = (): void => {
    if (doc.visibilityState === 'visible') {
      refresh();
    }
  };
  const timer = setInterval(update, REFRESH_MS);

  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener('visibilitychange', onVisible);
  update();

  return {
    refresh,
    stop: () => {
      observer.disconnect();
      clearInterval(timer);
      clearTimeout(pending);
      doc.removeEventListener('visibilitychange', onVisible);
    },
  };
}
