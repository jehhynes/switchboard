import type { Card } from '@switchboard/core/group';
import { issueKey, watchBoard } from './board.js';
import { watchCardMenus } from './menu.js';
import { pageOpenUrl, watchPillClicks } from './open.js';
import { cardsByIssue, watchPills } from './pills.js';
import { snoozeMenus } from './snooze.js';
import type { SnoozeAnswer } from './snooze.js';

const board = watchBoard(document, async () => {
  const urls = await chrome.runtime.sendMessage({ type: 'snoozed' }).catch(() => null);

  return Array.isArray(urls) ? (urls as string[]) : null;
});

// The card menu's items follow the pills' latest accepted read, so they need no read of their own.
let cards = new Map<string, Card>();

const pills = watchPills(
  document,
  async () => {
    const result = await chrome.runtime.sendMessage({ type: 'cards' }).catch(() => null);

    return Array.isArray(result) ? (result as Card[]) : null;
  },
  Date.now,
  (result) => (cards = cardsByIssue(result ?? [])),
);

const ask = async (message: object): Promise<SnoozeAnswer> => {
  const answer = await chrome.runtime.sendMessage(message).catch(() => null);

  return typeof answer === 'object' && answer !== null ? (answer as SnoozeAnswer) : { error: 'The Switchboard extension did not answer.' };
};

// The web page's origin: this computer's, or the one whose hub gave this copy (PRD R121). Read ahead, so a click opens its tab while it still
// counts as the operator's.
let page: string | null = null;
const PAGE_READ_MS = 30_000;
const readPage = (): void => {
  void chrome.runtime.sendMessage({ type: 'hub' }).then(
    (hub) => {
      const named = (hub as { page?: unknown } | null)?.page;

      page = typeof named === 'string' ? named : null;
    },
    () => {
      page = null;
    },
  );
};

// The page's port can change with its setting, so the origin is read again now and then, and after each click.
readPage();
setInterval(readPage, PAGE_READ_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') readPage();
});

// The web page opens at the ticket's work item in a new tab, in the click that asked for it; before the hub has named the page, the click reads it
// again and says so.
const open = (ticketUrl: string): void => {
  if (page === null) {
    readPage();
    window.alert('Switchboard is not answering. Start it, then try again.');
    return;
  }

  window.open(pageOpenUrl(page, cards.get(issueKey(ticketUrl) ?? '')), '_blank', 'noopener');
  readPage();
};

watchCardMenus(
  document,
  (url) => cards.get(issueKey(url) ?? ''),
  snoozeMenus(
    document,
    { snooze: (url, until) => ask({ type: 'snooze', url, until }), unsnooze: (url) => ask({ type: 'unsnooze', url }) },
    () => {
      board.refresh();
      pills.refresh();
    },
  ),
  open,
);

watchPillClicks(document, open);
