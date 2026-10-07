/** How often an open board reads the snoozed tickets again. */
export const REFRESH_MS = 60_000;

const SNOOZED = 'data-switchboard-snoozed';
const SHOWN = 'data-switchboard-shown';
const TOGGLE = 'switchboard-snoozed-toggle';

/** `owner/repo#number` in lower case for a GitHub issue URL, or null for any other URL. */
export function issueKey(url: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const match = parsed.hostname === 'github.com' ? /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(parsed.pathname) : null;

  return match === null ? null : `${match[1]}/${match[2]}#${match[3]}`.toLowerCase();
}

/** Sets or removes an attribute only when that changes it, so a re-render pass makes no mutation. */
function mark(element: Element, name: string, on: boolean): void {
  if (on !== element.hasAttribute(name)) {
    element.toggleAttribute(name, on);
  }
}

/**
 * Marks the cards of snoozed issues, which content.css hides unless their column is in `shown`, and keeps a
 * "Show N snoozed cards" button at the bottom of each column that has any. Cards GitHub has not loaded are not counted.
 * GitHub empties a card it scrolls out of view, including a hidden one, so `keys` keeps each card's issue by card id.
 */
export function applySnoozed(
  root: ParentNode,
  snoozed: ReadonlySet<string>,
  shown: ReadonlySet<string>,
  onToggle: (column: string) => void,
  keys = new Map<string, string | null>(),
): void {
  for (const column of root.querySelectorAll<HTMLElement>('[data-board-column]')) {
    const name = column.dataset['boardColumn'] ?? '';
    let count = 0;

    for (const card of column.querySelectorAll<HTMLElement>('[data-board-card-id]')) {
      const id = card.dataset['boardCardId'] ?? '';
      // The title link, because a card's fields can link other issues.
      const href = card.querySelector('h3[id^="board-card-title-"]')?.closest('a')?.href;

      if (href !== undefined) {
        keys.set(id, issueKey(href));
      }

      const key = keys.get(id);
      const hidden = key != null && snoozed.has(key);

      mark(card, SNOOZED, hidden);
      count += hidden ? 1 : 0;
    }

    mark(column, SHOWN, shown.has(name));

    // Inside the scrolling card list, so the link follows the last card rather than staying at the column's bottom.
    const list = column.querySelector('[data-dnd-drop-type="card"]') ?? column;
    let toggle = [...list.children].find((child) => child.classList.contains(TOGGLE));

    if (count === 0) {
      toggle?.remove();
      continue;
    }

    if (toggle === undefined) {
      const button = column.ownerDocument.createElement('button');

      button.type = 'button';
      button.className = TOGGLE;
      button.addEventListener('click', () => onToggle(name));
      list.append(button);
      toggle = button;
    }

    const text = `${shown.has(name) ? 'Hide' : 'Show'} ${count} snoozed card${count === 1 ? '' : 's'}`;

    if (toggle.textContent !== text) {
      toggle.textContent = text;
    }
  }
}

export interface BoardWatch {
  /** Applies the snoozed set now, reading it first when it is older than `REFRESH_MS`. */
  update(): void;
  stop(): void;
}

/**
 * Keeps a GitHub project board's snoozed cards hidden while GitHub renders it. Reads the snoozed tickets only while a
 * board is on the page, because the content script runs on every GitHub page. A failed read shows every card.
 */
export function watchBoard(doc: Document, read: () => Promise<string[] | null>, now: () => number = Date.now): BoardWatch {
  const shown = new Set<string>();
  const keys = new Map<string, string | null>();
  let snoozed = new Set<string>();
  let readAt = -Infinity;
  let reads = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const apply = (): void => applySnoozed(doc, snoozed, shown, toggle, keys);

  function toggle(column: string): void {
    if (!shown.delete(column)) {
      shown.add(column);
    }

    apply();
  }

  const update = (): void => {
    if (doc.querySelector('[data-board-column]') === null) {
      return;
    }

    if (now() - readAt >= REFRESH_MS) {
      readAt = now();

      const current = ++reads;

      void read().then((urls) => {
        // A read that a later one overtook would restore what the later one removed.
        if (current === reads) {
          snoozed = new Set((urls ?? []).flatMap((url) => issueKey(url) ?? []));
          apply();
        }
      });
    }

    apply();
  };

  // Attribute changes, including this script's own, are not observed, so applying never re-triggers the observer.
  const observer = new MutationObserver(() => {
    pending ??= setTimeout(() => {
      pending = undefined;
      update();
    }, 50);
  });
  const onVisible = (): void => {
    if (doc.visibilityState === 'visible') {
      readAt = -Infinity;
      update();
    }
  };
  const timer = setInterval(update, REFRESH_MS);

  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener('visibilitychange', onVisible);
  update();

  return {
    update,
    stop: () => {
      observer.disconnect();
      clearInterval(timer);
      clearTimeout(pending);
      doc.removeEventListener('visibilitychange', onVisible);
    },
  };
}
