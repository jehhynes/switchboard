import type { Card } from '@switchboard/core/group';
import { watchBoard } from './board.js';
import { watchPills } from './pills.js';

watchBoard(document, async () => {
  const urls = await chrome.runtime.sendMessage({ type: 'snoozed' }).catch(() => null);

  return Array.isArray(urls) ? (urls as string[]) : null;
});

watchPills(document, async () => {
  const cards = await chrome.runtime.sendMessage({ type: 'cards' }).catch(() => null);

  return Array.isArray(cards) ? (cards as Card[]) : null;
});
