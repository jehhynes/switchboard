import { snoozeChoices } from '@switchboard/core/snooze';
import { LOCAL_ROUTES } from './hub.js';
import type { HubRoutes } from './hub.js';

/** The hub's answer to a snooze or unsnooze: done, or the reason it was not. */
export type SnoozeAnswer = { done: true } | { error: string };

type FetchUrl = (url: string, init: RequestInit) => Promise<Response>;

/** Posts a snooze to the hub (PRD R66). */
export function postSnooze(fetchUrl: FetchUrl, url: string, until: number | null, routes: HubRoutes = LOCAL_ROUTES): Promise<SnoozeAnswer> {
  return postHub(fetchUrl, routes.snooze, { url, until });
}

/** Posts an unsnooze to the hub, which ends the ticket's snooze (PRD R66). */
export function postUnsnooze(fetchUrl: FetchUrl, url: string, routes: HubRoutes = LOCAL_ROUTES): Promise<SnoozeAnswer> {
  return postHub(fetchUrl, routes.unsnooze, { url });
}

/**
 * The JSON content type is what the hub requires, because a web page cannot send it without a CORS preflight; the service
 * worker's host permission skips the preflight and its Origin is the extension's.
 */
async function postHub(fetchUrl: FetchUrl, endpoint: string, body: unknown): Promise<SnoozeAnswer> {
  let response: Response;

  try {
    response = await fetchUrl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  } catch {
    return { error: 'Switchboard is not running.' };
  }

  if (response.ok) {
    return { done: true };
  }

  const reply: unknown = await response.json().catch(() => null);
  const error = typeof reply === 'object' && reply !== null ? (reply as { error?: unknown }).error : undefined;

  return { error: typeof error === 'string' && error !== '' ? error : `Switchboard answered ${response.status}.` };
}

/** A snooze message from the content script, or null for any other message. */
export function snoozeMessage(message: unknown): { url: string; until: number | null } | null {
  const { type, url, until } = (typeof message === 'object' && message !== null ? message : {}) as { type?: unknown; url?: unknown; until?: unknown };

  return type === 'snooze' && typeof url === 'string' && (until === null || (typeof until === 'number' && Number.isFinite(until))) ? { url, until } : null;
}

/** An unsnooze message from the content script, or null for any other message. */
export function unsnoozeMessage(message: unknown): { url: string } | null {
  const { type, url } = (typeof message === 'object' && message !== null ? message : {}) as { type?: unknown; url?: unknown };

  return type === 'unsnooze' && typeof url === 'string' ? { url } : null;
}

const MENU = 'switchboard-snooze-menu';

/** The hub requests the snooze menus send, through the service worker. */
export interface SnoozeHub {
  snooze(url: string, until: number | null): Promise<SnoozeAnswer>;
  unsnooze(url: string): Promise<SnoozeAnswer>;
}

export interface SnoozeMenus {
  /** Opens the R49 snooze choices under `anchor` and snoozes the ticket with the chosen one. */
  choose(url: string, anchor: Element): void;
  /** Ends the ticket's snooze; a refusal shows the hub's error under `anchor`. */
  unsnooze(url: string, anchor: Element): void;
  stop(): void;
}

/**
 * The snooze popups that the card menu's Switchboard items open (PRD R66). A popup lives in `body`, outside GitHub's cards, so
 * GitHub's renders and card clicks do not reach it. `onChanged` runs after the hub accepts a snooze or unsnooze.
 */
export function snoozeMenus(doc: Document, hub: SnoozeHub, onChanged: () => void, now: () => Date = () => new Date()): SnoozeMenus {
  let menu: HTMLElement | null = null;

  const close = (): void => {
    menu?.remove();
    menu = null;
  };

  /** Opens a popup below the anchor, or above it when the viewport has no room below, as for a card near the bottom. */
  const show = (list: HTMLElement, anchor: Element): void => {
    const rect = anchor.getBoundingClientRect();

    close();
    list.className = MENU;
    list.setAttribute('role', 'menu');
    list.style.left = `${Math.max(8, rect.right - 220)}px`;
    doc.body.append(list);
    menu = list;

    const height = list.offsetHeight;
    const viewport = doc.defaultView?.innerHeight ?? Infinity;
    const top = rect.bottom + 4 + height <= viewport ? rect.bottom + 4 : rect.top - 4 - height;

    list.style.top = `${Math.max(8, top)}px`;
  };

  const statusLine = (text = ''): HTMLElement => {
    const status = doc.createElement('div');

    status.className = `${MENU}-status`;
    status.setAttribute('role', 'status');
    status.textContent = text;

    return status;
  };

  const choose = (url: string, anchor: Element): void => {
    const list = doc.createElement('div');
    const status = statusLine();
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
        void hub.snooze(url, choice.until).then((answer) => {
          if ('done' in answer) {
            if (menu === list) {
              close();
            }

            onChanged();

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

    list.append(status);
    show(list, anchor);
    // After GitHub's closing menu returns focus to its button.
    setTimeout(() => {
      if (menu === list) {
        list.querySelector('button')?.focus();
      }
    }, 0);
  };

  const unsnooze = (url: string, anchor: Element): void => {
    void hub.unsnooze(url).then((answer) => {
      if ('done' in answer) {
        onChanged();

        return;
      }

      const list = doc.createElement('div');

      list.append(statusLine(answer.error));
      show(list, anchor);
    });
  };

  const onDown = (event: Event): void => {
    const target = event.target as Node | null;

    if (menu !== null && target !== null && !menu.contains(target)) {
      close();
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && menu !== null) {
      close();
    }
  };
  // A card moves when its column scrolls, so the fixed-position popup would point at another card.
  const onScroll = (event: Event): void => {
    if (menu !== null && !(event.target instanceof Node && menu.contains(event.target))) {
      close();
    }
  };

  doc.addEventListener('mousedown', onDown, true);
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('scroll', onScroll, true);

  return {
    choose,
    unsnooze,
    stop: () => {
      close();
      doc.removeEventListener('mousedown', onDown, true);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('scroll', onScroll, true);
    },
  };
}
