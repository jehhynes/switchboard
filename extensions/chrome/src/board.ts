/** How often an open board reads the snoozed tickets again. */
export const REFRESH_MS = 60_000;

const SNOOZED = 'data-switchboard-snoozed';
const SHOWN = 'data-switchboard-shown';
const LIST = 'data-switchboard-rows';
const HOLDER = 'data-switchboard-toggle';
const HIDDEN_ROWS = '--switchboard-hidden-rows';
const TOGGLE = 'switchboard-snoozed-toggle';

/** Elements that show a project, as a board's columns or a table's rows; the content script acts only while one is on the page. */
export const PROJECT = '[data-board-column], #project-items-region';

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

/** The project view a URL shows: its path and query without the side panel's parameters (`pane`, `itemId`, `issue`), which select an item in the same view. */
export function viewKey(location: { pathname: string; search: string }): string {
  const query = new URLSearchParams(location.search);

  query.delete('pane');
  query.delete('itemId');
  query.delete('issue');

  return `${location.pathname}?${query.toString()}`;
}

/** Sets or removes an attribute only when that changes it, so a re-render pass makes no mutation. */
function mark(element: Element, name: string, on: boolean): void {
  if (on !== element.hasAttribute(name)) {
    element.toggleAttribute(name, on);
  }
}

/** The issue URL of the board card or table row that holds `element`: its title link, because a card's fields can link other issues. */
export function itemHref(element: Element): string | undefined {
  const card = element.closest('[data-board-card-id]');

  if (card !== null) {
    return card.querySelector<HTMLAnchorElement>('h3[id^="board-card-title-"]')?.closest('a')?.href;
  }

  return element.closest('[role="row"]')?.querySelector<HTMLAnchorElement>(':scope > [role="rowheader"] a[href]')?.href;
}

/** The rows of a project table, each with its title cell. */
export function tableRows(root: ParentNode): { row: Element; title: Element }[] {
  return [...root.querySelectorAll('#project-items-region [role="rowheader"]')].flatMap((title) => {
    const row = title.closest('[role="row"]');

    return row === null ? [] : [{ row, title }];
  });
}

/**
 * Keeps one "Show N snoozed cards" button last in `list`, or none when `count` is 0. The button stays last because GitHub
 * appends the cards it loads.
 */
function setToggle(list: Element, name: string, count: number, noun: string, shown: ReadonlySet<string>, onToggle: (name: string) => void): void {
  let toggle = [...list.children].find((child) => child.classList.contains(TOGGLE));

  if (count === 0) {
    toggle?.remove();
    return;
  }

  if (toggle === undefined) {
    const button = list.ownerDocument.createElement('button');

    button.type = 'button';
    button.className = TOGGLE;
    // The group is read on click, because GitHub keeps a group's list when the group is renamed.
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onToggle(button.dataset['switchboardGroup'] ?? '');
    });
    // A table's header row sorts, collapses or drags on GitHub's own pointer handlers.
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    toggle = button;
  }

  if ((toggle as HTMLElement).dataset['switchboardGroup'] !== name) {
    (toggle as HTMLElement).dataset['switchboardGroup'] = name;
  }

  if (list.lastElementChild !== toggle) {
    list.append(toggle);
  }

  const text = `${shown.has(name) ? 'Hide' : 'Show'} ${count} snoozed ${noun}${count === 1 ? '' : 's'}`;

  if (toggle.textContent !== text) {
    toggle.textContent = text;
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
      const href = itemHref(card);

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
    setToggle(column.querySelector('[data-dnd-drop-type="card"]') ?? column, name, count, 'card', shown, onToggle);
  }
}

/**
 * Marks the rows of snoozed issues in a project table, which content.css hides unless their group is in `shown`, and keeps a
 * "Show N snoozed rows" button in each group's header row, after its count, or in the Title column's header when the table is
 * not grouped (named ''). GitHub places its add-item bar by its own count of rows, so a button after the last row would sit
 * under it once the rows show. GitHub renders only the rows near the view, so `seen` keeps each issue's group from when its
 * row was last rendered, and N counts the snoozed issues seen in the group. The caller clears `seen` when the view changes.
 */
export function applySnoozedRows(
  root: ParentNode,
  snoozed: ReadonlySet<string>,
  shown: ReadonlySet<string>,
  onToggle: (group: string) => void,
  seen: Map<string, string>,
): void {
  const grid = root.querySelector('#project-items-region');

  if (grid === null) {
    return;
  }

  // Each group's list starts with its header row, whose first text is the group's name, before its chunks of five rows.
  const lists = new Map<Element, { name: string; holder: Element | null }>();

  for (const cell of grid.querySelectorAll('[role="rowgroup"] [role="row"] > [role="cell"]')) {
    const text = cell.querySelector('[data-component="Text"]');
    const list = cell.parentElement?.parentElement;

    if (text !== null && list != null) {
      lists.set(list, { name: text.textContent ?? '', holder: text.parentElement });
    }
  }

  let hidden = 0;

  for (const { row, title } of tableRows(grid)) {
    const list = row.parentElement?.parentElement;
    const href = title.querySelector<HTMLAnchorElement>('a[href]')?.href;
    const key = href === undefined ? null : issueKey(href);

    if (list == null) {
      continue;
    }

    // An ungrouped table's rows sit in its body, and its button in the Title column's header.
    if (!lists.has(list)) {
      lists.set(list, { name: '', holder: grid.querySelector('[role="columnheader"] span')?.parentElement ?? null });
    }

    const { name } = lists.get(list)!;

    if (key !== null) {
      seen.set(key, name);
    }

    const isSnoozed = key !== null && snoozed.has(key);

    mark(row, SNOOZED, isSnoozed);
    hidden += isSnoozed && !shown.has(name) ? 1 : 0;
  }

  // GitHub places a short table's add-item bar by its own count of rows; content.css moves it up past the hidden ones.
  if ((grid as HTMLElement).style.getPropertyValue(HIDDEN_ROWS) !== String(hidden)) {
    (grid as HTMLElement).style.setProperty(HIDDEN_ROWS, String(hidden));
  }

  const holders = new Set([...lists.values()].map(({ holder }) => holder));

  for (const toggle of grid.querySelectorAll(`[${HOLDER}] > .${TOGGLE}`)) {
    if (!holders.has(toggle.parentElement)) {
      toggle.remove();
    }
  }

  for (const [list, { name, holder }] of lists) {
    const count = [...seen].filter(([key, group]) => group === name && snoozed.has(key)).length;

    mark(list, LIST, true);
    mark(list, SHOWN, shown.has(name));

    if (holder !== null) {
      mark(holder, HOLDER, true);
      setToggle(holder, name, count, 'row', shown, onToggle);
    }
  }
}

export interface BoardWatch {
  /** Applies the snoozed set now, reading it first when it is older than `REFRESH_MS`. */
  update(): void;
  /** Reads the snoozed set now and applies it, as after a snooze from the page. */
  refresh(): void;
  stop(): void;
}

/**
 * Keeps a GitHub project's snoozed cards and table rows hidden while GitHub renders it. Reads the snoozed tickets only
 * while a board or table is on the page, because the content script runs on every GitHub page. A failed read shows every card.
 */
export function watchBoard(doc: Document, read: () => Promise<string[] | null>, now: () => number = Date.now): BoardWatch {
  const shown = new Set<string>();
  const keys = new Map<string, string | null>();
  const seen = new Map<string, string>();
  let view = '';
  let snoozed = new Set<string>();
  let readAt = -Infinity;
  let reads = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const apply = (): void => {
    // Another view or project lists other issues, or the same ones in other groups.
    const current = viewKey(doc.location);

    if (current !== view) {
      view = current;
      seen.clear();
    }

    applySnoozed(doc, snoozed, shown, toggle, keys);
    applySnoozedRows(doc, snoozed, shown, toggle, seen);
  };

  function toggle(group: string): void {
    if (!shown.delete(group)) {
      shown.add(group);
    }

    apply();
  }

  const update = (): void => {
    if (doc.querySelector(PROJECT) === null) {
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
  const refresh = (): void => {
    readAt = -Infinity;
    update();
  };
  const onVisible = (): void => {
    if (doc.visibilityState === 'visible') {
      refresh();
    }
  };
  const timer = setInterval(update, REFRESH_MS);

  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener('visibilitychange', onVisible);
  update();

  return {
    update,
    refresh,
    stop: () => {
      observer.disconnect();
      clearInterval(timer);
      clearTimeout(pending);
      doc.removeEventListener('visibilitychange', onVisible);
    },
  };
}
