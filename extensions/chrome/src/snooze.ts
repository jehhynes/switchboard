import type { Card } from '@switchboard/core/group';
import { snoozeChoices } from '@switchboard/core/snooze';
import { issueKey } from './board.js';
import { BROWSER_PORT } from './hub.js';

export const SNOOZE_URL = `http://127.0.0.1:${BROWSER_PORT}/snooze`;

/** The hub's answer to a snooze: done, or the reason it was not. */
export type SnoozeAnswer = { done: true } | { error: string };

/**
 * Posts a snooze to the hub (PRD R66). The JSON content type is what the hub requires, because a web page cannot send it
 * without a CORS preflight; the service worker's host permission skips the preflight and its Origin is the extension's.
 */
export async function postSnooze(fetchUrl: (url: string, init: RequestInit) => Promise<Response>, url: string, until: number | null): Promise<SnoozeAnswer> {
  let response: Response;

  try {
    response = await fetchUrl(SNOOZE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, until }), cache: 'no-store' });
  } catch {
    return { error: 'Switchboard is not running.' };
  }

  if (response.ok) {
    return { done: true };
  }

  const body: unknown = await response.json().catch(() => null);
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;

  return { error: typeof error === 'string' && error !== '' ? error : `Switchboard answered ${response.status}.` };
}

/** A snooze message from the content script, or null for any other message. */
export function snoozeMessage(message: unknown): { url: string; until: number | null } | null {
  const { type, url, until } = (typeof message === 'object' && message !== null ? message : {}) as { type?: unknown; url?: unknown; until?: unknown };

  return type === 'snooze' && typeof url === 'string' && (until === null || (typeof until === 'number' && Number.isFinite(until))) ? { url, until } : null;
}

/**
 * The issue keys of the cards a snooze can apply to: those the panel lists outside Done, because the hub snoozes only an
 * assigned or pool ticket. None when the hub does not answer or is older than `GET /cards`.
 */
export function snoozableKeys(cards: readonly Card[] | null): Set<string> {
  return new Set((cards ?? []).flatMap((card) => (card.group === 'done' ? [] : (issueKey(card.url) ?? []))));
}

const BUTTON = 'switchboard-snooze-button';
const MENU = 'switchboard-snooze-menu';
// The codicon clockface (CC BY 4.0), as the panel's Snooze control shows it.
const CLOCKFACE =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8C14 11.3137 11.3137 14 8 14C4.68629 14 2 11.3137 2 8ZM8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1ZM8 4.5C8 4.22386 7.77614 4 7.5 4C7.22386 4 7 4.22386 7 4.5V8.5C7 8.77614 7.22386 9 7.5 9H10.5C10.7761 9 11 8.77614 11 8.5C11 8.22386 10.7761 8 10.5 8H8V4.5Z"/></svg>';

/** The issue URL of a board card's title link, or null for a card that is not a GitHub issue or has not rendered. */
function cardIssue(card: Element): string | null {
  const href = card.querySelector('h3[id^="board-card-title-"]')?.closest('a')?.href;

  return href !== undefined && issueKey(href) !== null ? href : null;
}

export interface SnoozeControls {
  stop(): void;
}

/**
 * Shows a clock button over a hovered board card of a GitHub issue that `known` accepts; it opens a menu of the R49 snooze choices and
 * sends the chosen one. The button and menu live in `body`, outside GitHub's cards, so GitHub's renders and card clicks
 * do not reach them. `onSnoozed` runs after the hub accepts a snooze, so the board can read the snoozed tickets again.
 */
export function watchSnoozeControls(
  doc: Document,
  send: (url: string, until: number | null) => Promise<SnoozeAnswer>,
  onSnoozed: () => void,
  now: () => Date = () => new Date(),
  known: (url: string) => boolean = () => true,
): SnoozeControls {
  const snoozeButton = doc.createElement('button');
  let card: { element: Element; url: string } | null = null;
  let menu: HTMLElement | null = null;

  snoozeButton.type = 'button';
  snoozeButton.className = BUTTON;
  snoozeButton.title = 'Snooze in Switchboard';
  snoozeButton.setAttribute('aria-label', 'Snooze in Switchboard');
  snoozeButton.innerHTML = CLOCKFACE;
  snoozeButton.hidden = true;

  const closeMenu = (): void => {
    menu?.remove();
    menu = null;
  };

  const hide = (): void => {
    closeMenu();
    snoozeButton.hidden = true;
    card = null;
  };

  const openMenu = (): void => {
    if (card === null) {
      return;
    }

    const { url } = card;
    const list = doc.createElement('div');
    const status = doc.createElement('div');
    const rect = snoozeButton.getBoundingClientRect();

    list.className = MENU;
    list.setAttribute('role', 'menu');
    list.style.left = `${Math.max(8, rect.right - 220)}px`;

    const heading = doc.createElement('div');

    heading.className = `${MENU}-heading`;
    heading.textContent = 'Snooze until';
    list.append(heading);

    for (const choice of snoozeChoices(now())) {
      const item = doc.createElement('button');
      const label = doc.createElement('span');
      const description = doc.createElement('span');

      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      label.textContent = choice.label;
      description.className = `${MENU}-description`;
      description.textContent = choice.description;
      item.append(label, description);
      item.addEventListener('click', () => {
        for (const button of list.querySelectorAll('button')) {
          button.disabled = true;
        }

        status.textContent = '';
        void send(url, choice.until).then((answer) => {
          if ('done' in answer) {
            hide();
            onSnoozed();

            return;
          }

          for (const button of list.querySelectorAll('button')) {
            button.disabled = false;
          }

          status.textContent = answer.error;
        });
      });
      list.append(item);
    }

    status.className = `${MENU}-status`;
    status.setAttribute('role', 'status');
    list.append(status);
    doc.body.append(list);
    menu = list;

    // Below the snoozeButton, or above it when the viewport has no room below, as for a card near the bottom.
    const height = list.offsetHeight;
    const viewport = doc.defaultView?.innerHeight ?? Infinity;
    const top = rect.bottom + 4 + height <= viewport ? rect.bottom + 4 : rect.top - 4 - height;

    list.style.top = `${Math.max(8, top)}px`;
  };

  snoozeButton.addEventListener('click', () => (menu === null ? openMenu() : closeMenu()));

  const onOver = (event: Event): void => {
    const target = event.target as Element | null;

    // GitHub replacing the body removes an open menu with it.
    if (menu !== null && !menu.isConnected) {
      hide();
    }

    if (menu !== null || target === null || snoozeButton.contains(target)) {
      return;
    }

    const element = target.closest('[data-board-card-id]');
    const url = element === null ? null : cardIssue(element);

    if (element === null || url === null || !known(url)) {
      hide();

      return;
    }

    if (card?.element !== element) {
      const rect = element.getBoundingClientRect();

      card = { element, url };
      snoozeButton.style.top = `${rect.bottom - 30}px`;
      snoozeButton.style.left = `${rect.right - 30}px`;
      snoozeButton.hidden = false;

      // Appended on first use, and again after GitHub replaces the body on navigation.
      if (!snoozeButton.isConnected) {
        doc.body.append(snoozeButton);
      }
    }
  };
  const onDown = (event: Event): void => {
    const target = event.target as Node | null;

    if (menu !== null && target !== null && !menu.contains(target) && !snoozeButton.contains(target)) {
      hide();
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && menu !== null) {
      hide();
    }
  };

  doc.addEventListener('mouseover', onOver);
  doc.addEventListener('mousedown', onDown, true);
  doc.addEventListener('keydown', onKey);
  // A card moves when its column scrolls, so the fixed-position button would point at another card.
  doc.addEventListener('scroll', hide, true);

  return {
    stop: () => {
      hide();
      snoozeButton.remove();
      doc.removeEventListener('mouseover', onOver);
      doc.removeEventListener('mousedown', onDown, true);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('scroll', hide, true);
    },
  };
}
