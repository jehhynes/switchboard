import { readSnoozed } from './hub.js';
import { readCards } from './pills.js';
import { postSnooze, postUnsnooze, snoozeMessage, unsnoozeMessage } from './snooze.js';

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

// The hub accepts a snooze only from an extension Origin, which the service worker's fetch sends (mechanics M23).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const snooze = snoozeMessage(message);

  if (snooze === null) {
    return false;
  }

  void postSnooze((url, init) => fetch(url, init), snooze.url, snooze.until).then(sendResponse);

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const unsnooze = unsnoozeMessage(message);

  if (unsnooze === null) {
    return false;
  }

  void postUnsnooze((url, init) => fetch(url, init), unsnooze.url).then(sendResponse);

  return true;
});
