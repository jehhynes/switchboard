import type { Card } from '@switchboard/core/group';
import { issueKey, watchBoard } from './board.js';
import { watchCardMenus } from './menu.js';
import { openUri, pageOpenUrl, watchPillClicks } from './open.js';
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

// The web page's origin when this copy came from another computer's hub (PRD R121), which has no VS Code here to open.
let origin: string | null = null;

void chrome.runtime.sendMessage({ type: 'hub' }).then(
  (hub) => {
    const named = (hub as { origin?: unknown } | null)?.origin;

    origin = typeof named === 'string' ? named : null;
  },
  () => undefined,
);

// A vscode:// navigation leaves the page as it is; Chrome asks before opening VS Code (mechanics M22). On another device the web page opens in a
// new tab instead, in the click that asked for it.
const open = (ticketUrl: string): void => {
  if (origin === null) {
    location.assign(openUri(ticketUrl));
  } else {
    window.open(pageOpenUrl(origin, cards.get(issueKey(ticketUrl) ?? '')), '_blank', 'noopener');
  }
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
