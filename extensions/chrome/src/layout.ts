/** The two page settings the buttons switch: the right sidebar hidden, and the content at the window's full width. */
export type LayoutSetting = 'sidebar' | 'wide';

export type Layout = Record<LayoutSetting, boolean>;

/**
 * Each setting's key in github.com's localStorage, which every repository's pages share. localStorage rather than chrome.storage,
 * because the Firefox build has no `storage` permission and a script at document_start must read it before GitHub paints.
 */
export const LAYOUT_KEYS: Record<LayoutSetting, string> = { sidebar: 'switchboard-sidebar-hidden', wide: 'switchboard-full-width' };

/** The attribute on `<html>` that content.css reads for each setting. */
export const LAYOUT_ATTRIBUTES: Record<LayoutSetting, string> = { sidebar: 'data-switchboard-sidebar-hidden', wide: 'data-switchboard-full-width' };

/** An issue, or any tab of a pull request, such as `/pull/1/files`. */
const CONVERSATION = /^\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+(?:\/|$)/;

/** The sidebar of an issue, and of a pull request's Overview tab; GitHub's other pull request tabs have none. */
const SIDEBAR = '[data-testid="issue-viewer-metadata-container"], [data-testid="sticky-sidebar"]';

export const LAYOUT_BUTTONS = 'switchboard-layout-buttons';

/** Each button's codicon (as `MARK_GLYPHS`) and tooltip, by whether its setting is on. */
const BUTTONS: Record<LayoutSetting, { name: string; on: { glyph: string; title: string }; off: { glyph: string; title: string } }> = {
  sidebar: {
    name: 'Hide sidebar',
    on: { glyph: '\u{ec00}', title: 'Show the sidebar (Switchboard)' }, // layout-sidebar-right-off
    off: { glyph: '\u{ebf4}', title: 'Hide the sidebar (Switchboard)' }, // layout-sidebar-right
  },
  wide: {
    name: 'Full width',
    on: { glyph: '\u{eb4d}', title: 'Limit the width (Switchboard)' }, // screen-normal
    off: { glyph: '\u{eb4c}', title: 'Use the full width (Switchboard)' }, // screen-full
  },
};

export function isConversationPage(path: string): boolean {
  return CONVERSATION.test(path);
}

const NO_STORAGE: Pick<Storage, 'getItem' | 'setItem'> = { getItem: () => null, setItem: () => {} };

/** The page's localStorage, or one that keeps nothing when the browser blocks it, as reading `localStorage` itself then throws. */
export function pageStorage(win: Pick<Window, 'localStorage'>): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    return win.localStorage;
  } catch {
    return NO_STORAGE;
  }
}

/** The saved settings; off for a setting never saved, or when the page's storage cannot be read. */
export function readLayout(storage: Pick<Storage, 'getItem'>): Layout {
  const read = (setting: LayoutSetting): boolean => {
    try {
      return storage.getItem(LAYOUT_KEYS[setting]) === 'true';
    } catch {
      return false;
    }
  };

  return { sidebar: read('sidebar'), wide: read('wide') };
}

/** Sets each attribute that is on, on an issue or pull request page only, and removes the rest; an unchanged attribute is left alone. */
export function applyLayout(doc: Document, path: string, layout: Layout): void {
  const conversation = isConversationPage(path);

  for (const setting of ['sidebar', 'wide'] as const) {
    const name = LAYOUT_ATTRIBUTES[setting];
    const on = conversation && layout[setting];

    if (on !== doc.documentElement.hasAttribute(name)) {
      doc.documentElement.toggleAttribute(name, on);
    }
  }
}

function setAttribute(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function button(doc: Document, setting: LayoutSetting): HTMLButtonElement {
  const element = doc.createElement('button');
  const glyph = doc.createElement('span');

  element.type = 'button';
  element.className = 'switchboard-layout-button';
  element.dataset['switchboardLayout'] = setting;
  element.setAttribute('aria-label', BUTTONS[setting].name);
  glyph.className = 'switchboard-layout-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  element.append(glyph);

  return element;
}

/** Shows each button's state: pressed, with its glyph and tooltip. The sidebar button shows only on a page with a sidebar. */
function syncButtons(group: Element, layout: Layout, hasSidebar: boolean): void {
  for (const element of group.querySelectorAll<HTMLButtonElement>('[data-switchboard-layout]')) {
    const setting = element.dataset['switchboardLayout'] as LayoutSetting;
    const state = layout[setting] ? BUTTONS[setting].on : BUTTONS[setting].off;
    const glyph = element.firstElementChild!;

    setAttribute(element, 'aria-pressed', String(layout[setting]));
    setAttribute(element, 'title', state.title);

    if (glyph.textContent !== state.glyph) {
      glyph.textContent = state.glyph;
    }

    if (element.hidden !== (setting === 'sidebar' && !hasSidebar)) {
      element.hidden = !element.hidden;
    }
  }
}

/**
 * Where the buttons go: the right end of a pull request's tab row, or the right end of an issue header's bottom row. Both sit above the
 * sidebar; content.css pins the buttons there.
 */
function buttonsHost(doc: Document): Element | null {
  const tabs = [...doc.querySelectorAll('[class*="prc-PageHeader-Navigation-"]')].find((element) => element.querySelector('nav') !== null);

  return tabs ?? doc.querySelector('[data-testid="issue-header"]');
}

/**
 * Puts the buttons in line with a pull request's tabs, or an issue's header, on an issue or pull request page, and removes them from any
 * other page. A group already in place is only brought up to date, so a pass that changes nothing makes no mutation.
 */
export function placeButtons(doc: Document, path: string, layout: Layout): void {
  const existing = doc.querySelector(`.${LAYOUT_BUTTONS}`);
  const host = isConversationPage(path) ? buttonsHost(doc) : null;

  if (host === null) {
    existing?.remove();
    return;
  }

  let group = existing;

  if (group === null || group.parentElement !== host) {
    existing?.remove();
    group = doc.createElement('span');
    group.className = LAYOUT_BUTTONS;
    group.append(button(doc, 'sidebar'), button(doc, 'wide'));
    host.append(group);
  }

  syncButtons(group, layout, doc.querySelector(SIDEBAR) !== null);
}

/**
 * Keeps the layout and its buttons on GitHub's issue and pull request pages while GitHub renders them and moves between pages
 * without a reload. A click switches a setting for every repository and saves it; a change saved in another tab applies here too.
 */
export function watchLayout(
  doc: Document,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  path: () => string = () => doc.location.pathname,
): { stop(): void } {
  let pending: ReturnType<typeof setTimeout> | undefined;

  const update = (): void => {
    const layout = readLayout(storage);

    applyLayout(doc, path(), layout);
    placeButtons(doc, path(), layout);
  };

  const onClick = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(`.${LAYOUT_BUTTONS} [data-switchboard-layout]`) : null;

    if (target === null) {
      return;
    }

    const setting = target.dataset['switchboardLayout'] as LayoutSetting;

    try {
      storage.setItem(LAYOUT_KEYS[setting], String(!readLayout(storage)[setting]));
    } catch {
      // A page whose storage is full or blocked keeps the setting as it was.
    }

    update();
  };

  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || Object.values(LAYOUT_KEYS).includes(event.key)) {
      update();
    }
  };

  const observer = new MutationObserver(() => {
    pending ??= setTimeout(() => {
      pending = undefined;
      update();
    }, 50);
  });

  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener('click', onClick);
  doc.defaultView?.addEventListener('storage', onStorage);
  update();

  return {
    stop: () => {
      observer.disconnect();
      clearTimeout(pending);
      doc.removeEventListener('click', onClick);
      doc.defaultView?.removeEventListener('storage', onStorage);
    },
  };
}
