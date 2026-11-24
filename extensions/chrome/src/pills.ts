import { MARK_GLYPHS, MARK_TITLES } from '@switchboard/core/group';
import type { Card, Group } from '@switchboard/core/group';
import { PROJECT, REFRESH_MS, issueKey, itemHref, tableRows } from './board.js';
import { LOCAL_ROUTES } from './hub.js';
import type { HubRoutes } from './hub.js';

export const PILL = 'switchboard-pill';
const GROUPS: Record<Group, string> = { blocked: 'Blocked on you', review: 'Ready for review', progress: 'In progress', unstarted: 'Unstarted', done: 'Done' };
const STRIPES: ReadonlySet<unknown> = new Set(['error', 'warning', 'turn']);

function isCard(value: unknown): value is Card {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const card = value as Record<string, unknown>;

  return typeof card['url'] === 'string' && (card['playbook'] === null || typeof card['playbook'] === 'string') && typeof card['group'] === 'string' && Object.hasOwn(GROUPS, card['group']) && typeof card['snoozed'] === 'boolean' && isMark(card['mark']) && (card['stripe'] == null || STRIPES.has(card['stripe'])) && (card['workItemId'] == null || Number.isSafeInteger(card['workItemId']));
}

// A hub older than the mark sends none.
function isMark(mark: unknown): boolean {
  return mark === undefined || mark === null || (typeof mark === 'string' && Object.hasOwn(MARK_TITLES, mark));
}

/** The hub's cards, or null when the hub does not answer or answers with something else, such as a hub older than PRD R67. */
export async function readCards(fetchUrl: (url: string) => Promise<Response>, routes: HubRoutes = LOCAL_ROUTES): Promise<Card[] | null> {
  try {
    const response = await fetchUrl(routes.cards);

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
  // A link to the ticket's work item in Switchboard, which open.ts follows on a click or Enter (PRD R69).
  element.tabIndex = 0;
  element.setAttribute('role', 'link');
  element.dataset['switchboardGroup'] = card.snoozed ? 'snoozed' : card.group;

  // The list row's stripe colour: error, warning or turn (PRD R27, R67).
  if (card.stripe != null) {
    element.dataset['switchboardTone'] = card.stripe;
  }

  const group = card.snoozed ? 'Snoozed' : GROUPS[card.group];
  const mark = card.mark == null ? null : MARK_TITLES[card.mark];

  element.title = `Switchboard: ${group}${mark === null ? '' : ` · ${mark}`}. Click to open in Switchboard.`;
  // Screen readers often skip the title, so the name says the group and the mark too.
  element.setAttribute('aria-label', [...new Set([label, group]), ...(mark === null ? [] : [mark]), 'open in Switchboard'].join(', '));
  namespace.className = 'switchboard-namespace';
  namespace.textContent = label.slice(0, colon + 1);

  if (card.mark != null) {
    const mark = doc.createElement('span');

    mark.className = 'switchboard-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.dataset['switchboardMark'] = card.mark;
    mark.textContent = MARK_GLYPHS[card.mark];
    element.append(mark);
  }

  element.append(namespace, label.slice(colon + 1));

  return element;
}

/** Gives `element` the attributes of `wanted`, changing only those that differ. */
function syncAttributes(element: Element, wanted: Element): void {
  for (const { name } of [...element.attributes]) {
    if (!wanted.hasAttribute(name)) {
      element.removeAttribute(name);
    }
  }

  for (const { name, value } of wanted.attributes) {
    if (element.getAttribute(name) !== value) {
      element.setAttribute(name, value);
    }
  }
}

/**
 * Makes `pill` match `wanted` in place: its mark, namespace and label are matched by kind and only what differs changes, so a
 * focused pill keeps its focus and a selection in an unchanged part stays.
 */
function update(pill: Element, wanted: Element): void {
  const kind = (node: Node): string => (node.nodeType === Node.TEXT_NODE ? '#text' : (node as Element).className);
  const old = [...pill.childNodes];
  const pairs = [...wanted.childNodes].map((node) => {
    const at = old.findIndex((child) => kind(child) === kind(node));

    return { node, match: at < 0 ? null : old.splice(at, 1)[0]! };
  });

  syncAttributes(pill, wanted);

  // Removed first, so the parts that stay are not moved past them, which would clear a selection in them.
  for (const child of old) {
    child.remove();
  }

  pairs.forEach(({ node, match }, index) => {
    if (match === null) {
      pill.insertBefore(node, pill.childNodes[index] ?? null);
      return;
    }

    if (match.nodeType === Node.TEXT_NODE) {
      if (match.nodeValue !== node.nodeValue) {
        match.nodeValue = node.nodeValue;
      }
    } else {
      syncAttributes(match as Element, node as Element);

      if (match.textContent !== node.textContent) {
        match.textContent = node.textContent;
      }
    }

    if (pill.childNodes[index] !== match) {
      pill.insertBefore(match, pill.childNodes[index] ?? null);
    }
  });
}

/**
 * Puts a pill after the issue reference in each loaded card's header and each table row's title, with the list row's mark and
 * the playbook Switchboard chose, coloured as the list row's stripe (PRD R67). A pill that matches its card is left alone, so a
 * pass that changes nothing makes no mutation, and one whose card changed is updated in place.
 */
export function applyPills(root: ParentNode, cards: ReadonlyMap<string, Card>): void {
  const items = [
    ...[...root.querySelectorAll('[data-board-column] [data-board-card-id]')].map((element) => ({
      element,
      header: element.querySelector('[id^="board-card-header-title-"]'),
    })),
    ...tableRows(root).map(({ row, title }) => {
      const link = title.querySelector('a[href]');
      // The issue number follows the title link.
      const next = link?.nextElementSibling;

      return { element: row, header: next == null || next.classList.contains(PILL) ? (link ?? null) : next };
    }),
  ];

  for (const { element, header } of items) {
    const href = itemHref(element);
    const existing = element.querySelector(`.${PILL}`);
    const key = href === undefined ? null : issueKey(href);
    const card = key === null ? undefined : cards.get(key);

    if (card === undefined || header === null) {
      existing?.remove();
      continue;
    }

    const wanted = pill(element.ownerDocument, card);

    if (existing !== null && existing.previousElementSibling === header) {
      if (!existing.isEqualNode(wanted)) {
        update(existing, wanted);
      }
    } else {
      existing?.remove();
      header.after(wanted);
    }
  }
}

/**
 * Keeps the pills on a GitHub project's cards and table rows while GitHub renders it. Reads the cards only while a board or
 * table is on the page, when one appears, every `REFRESH_MS`, when the tab becomes visible and on `refresh`. A failed read removes every pill.
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
    if (doc.querySelector(PROJECT) === null) {
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
