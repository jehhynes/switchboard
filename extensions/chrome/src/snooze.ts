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

const BELL = 'switchboard-snooze-bell';
const MENU = 'switchboard-snooze-menu';
// The codicon bell-slash (CC BY 4.0), as the panel's Snooze control shows it.
const BELL_SLASH =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5.23901 3.118L4.53201 2.411C5.43201 1.541 6.65201 1 7.99901 1C10.756 1 12.999 3.243 12.999 6V9.901L13.65 11.529L11.999 9.878V5.999C11.999 3.793 10.205 1.999 7.99901 1.999C6.92701 1.999 5.95701 2.428 5.23801 3.117L5.23901 3.118ZM14.854 14.854C14.756 14.952 14.628 15 14.5 15C14.372 15 14.244 14.951 14.146 14.854L12.292 13H9.99901C9.99901 14.108 9.10701 15 7.99901 15C6.89101 15 5.99901 14.108 5.99901 13H2.49901C2.33301 13 2.17801 12.918 2.08501 12.78C1.99201 12.643 1.97301 12.468 2.03501 12.314L2.99901 9.901V6C2.99901 5.325 3.14601 4.688 3.39501 4.103L1.14601 1.854C0.951006 1.659 0.951006 1.342 1.14601 1.147C1.34101 0.952 1.65801 0.952 1.85301 1.147L14.853 14.147C15.048 14.342 15.048 14.659 14.853 14.854H14.854ZM9.00001 13H7.00001C7.00001 13.556 7.44401 14 8.00001 14C8.55601 14 9.00001 13.556 9.00001 13ZM11.293 12L4.16301 4.87C4.05701 5.228 4.00001 5.607 4.00001 6V9.998C4.00001 10.062 3.98801 10.125 3.96401 10.184L3.23801 12.001H11.293V12Z"/></svg>';

/** The issue URL of a board card's title link, or null for a card that is not a GitHub issue or has not rendered. */
function cardIssue(card: Element): string | null {
  const href = card.querySelector('h3[id^="board-card-title-"]')?.closest('a')?.href;

  return href !== undefined && issueKey(href) !== null ? href : null;
}

export interface SnoozeControls {
  stop(): void;
}

/**
 * Shows a bell-slash button over a hovered board card of a GitHub issue that `known` accepts; it opens a menu of the R49 snooze choices and
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
  const bell = doc.createElement('button');
  let card: { element: Element; url: string } | null = null;
  let menu: HTMLElement | null = null;

  bell.type = 'button';
  bell.className = BELL;
  bell.title = 'Snooze in Switchboard';
  bell.setAttribute('aria-label', 'Snooze in Switchboard');
  bell.innerHTML = BELL_SLASH;
  bell.hidden = true;

  const closeMenu = (): void => {
    menu?.remove();
    menu = null;
  };

  const hide = (): void => {
    closeMenu();
    bell.hidden = true;
    card = null;
  };

  const openMenu = (): void => {
    if (card === null) {
      return;
    }

    const { url } = card;
    const list = doc.createElement('div');
    const status = doc.createElement('div');
    const rect = bell.getBoundingClientRect();

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

    // Below the bell, or above it when the viewport has no room below, as for a card near the bottom.
    const height = list.offsetHeight;
    const viewport = doc.defaultView?.innerHeight ?? Infinity;
    const top = rect.bottom + 4 + height <= viewport ? rect.bottom + 4 : rect.top - 4 - height;

    list.style.top = `${Math.max(8, top)}px`;
  };

  bell.addEventListener('click', () => (menu === null ? openMenu() : closeMenu()));

  const onOver = (event: Event): void => {
    const target = event.target as Element | null;

    // GitHub replacing the body removes an open menu with it.
    if (menu !== null && !menu.isConnected) {
      hide();
    }

    if (menu !== null || target === null || bell.contains(target)) {
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
      bell.style.top = `${rect.bottom - 30}px`;
      bell.style.left = `${rect.right - 30}px`;
      bell.hidden = false;

      // Appended on first use, and again after GitHub replaces the body on navigation.
      if (!bell.isConnected) {
        doc.body.append(bell);
      }
    }
  };
  const onDown = (event: Event): void => {
    const target = event.target as Node | null;

    if (menu !== null && target !== null && !menu.contains(target) && !bell.contains(target)) {
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
      bell.remove();
      doc.removeEventListener('mouseover', onOver);
      doc.removeEventListener('mousedown', onDown, true);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('scroll', hide, true);
    },
  };
}
