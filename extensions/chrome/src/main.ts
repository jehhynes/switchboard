import type { Card } from '@switchboard/core/group';
import { issueKey, watchBoard } from './board.js';
import { watchCardMenus } from './menu.js';
import { watchPillClicks } from './open.js';
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

// A vscode:// navigation leaves the page as it is; Chrome asks before opening VS Code (mechanics M22).
const open = (uri: string): void => location.assign(uri);

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
