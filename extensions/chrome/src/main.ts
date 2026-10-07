import type { Card } from '@switchboard/core/group';
import { issueKey, watchBoard } from './board.js';
import { watchOpen } from './open.js';
import { watchPills } from './pills.js';
import { snoozableKeys, watchSnoozeControls } from './snooze.js';
import type { SnoozeAnswer } from './snooze.js';

const board = watchBoard(document, async () => {
  const urls = await chrome.runtime.sendMessage({ type: 'snoozed' }).catch(() => null);

  return Array.isArray(urls) ? (urls as string[]) : null;
});

// The snooze button shows only on cards the pills' latest accepted read listed, so it needs no read of its own.
let snoozable = new Set<string>();

watchPills(
  document,
  async () => {
    const cards = await chrome.runtime.sendMessage({ type: 'cards' }).catch(() => null);

    return Array.isArray(cards) ? (cards as Card[]) : null;
  },
  Date.now,
  (cards) => (snoozable = snoozableKeys(cards)),
);

watchSnoozeControls(
  document,
  async (url, until) => {
    const answer = await chrome.runtime.sendMessage({ type: 'snooze', url, until }).catch(() => null);

    return typeof answer === 'object' && answer !== null ? (answer as SnoozeAnswer) : { error: 'The Switchboard extension did not answer.' };
  },
  () => board.refresh(),
  () => new Date(),
  (url) => snoozable.has(issueKey(url) ?? ''),
);

// A vscode:// navigation leaves the page as it is; Chrome asks before opening VS Code (mechanics M22).
watchOpen(
  document,
  async () => {
    const cards = await chrome.runtime.sendMessage({ type: 'cards' }).catch(() => null);

    return Array.isArray(cards) ? (cards as Card[]) : null;
  },
  (uri) => location.assign(uri),
);
