import { readSnoozed } from './hub.js';
import { readCards } from './pills.js';

// Content scripts on github.com cannot read a loopback address, so the service worker reads the hub for them.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { type?: unknown } | null)?.type !== 'snoozed') {
    return false;
  }

  void readSnoozed((url) => fetch(url, { cache: 'no-store' })).then(sendResponse);

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as { type?: unknown } | null)?.type !== 'cards') {
    return false;
  }

  void readCards((url) => fetch(url, { cache: 'no-store' })).then(sendResponse);

  return true;
});
