import { watchBoard } from './board.js';

watchBoard(document, async () => {
  const urls = await chrome.runtime.sendMessage({ type: 'snoozed' }).catch(() => null);

  return Array.isArray(urls) ? (urls as string[]) : null;
});
