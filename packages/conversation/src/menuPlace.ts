/**
 * Where a menu opens (architecture.md § Conversation view, Menus), for the web page: under the element that holds it, their left
 * edges lined up, so it extends right and down as a desktop menu does; lined up with that element's right edge instead only when it would pass
 * the viewport's right edge and has more room that way, and above it only when it would pass the bottom and has more room above. Imports
 * nothing, for browser bundles.
 */

/** The least room a menu leaves to the viewport's edge, and its narrowest and widest unless it sets its own. */
const MARGIN = 8;
const MIN_WIDTH = 160;
export const MENU_MAX_WIDTH = 360;

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface MenuPlace {
  /** Lined up with the anchor's right edge, extending left (`flip-x`). */
  flipX: boolean;
  /** Above the anchor, extending up (`flip-y`). */
  flipY: boolean;
  /** The widest it may be on the side it extends to. */
  maxWidth: number;
  /** The tallest it may be on the side it extends to, so a menu that fits on neither side scrolls rather than pass the viewport. */
  maxHeight: number;
}

/**
 * Where a menu opens from `anchor` in a viewport of `view`, given `menu` as drawn in its default place: its offset from the anchor's left edge
 * and from its bottom (the gap, or a menu's own inset) is kept on the side it flips to. `widest` is the most it may take, as its CSS allows.
 */
export function menuPlace(anchor: Box, menu: Box & { width: number; height: number }, view: { width: number; height: number }, widest = MENU_MAX_WIDTH): MenuPlace {
  const inset = menu.left - anchor.left;
  const gap = menu.top - anchor.bottom;
  const right = view.width - menu.left - MARGIN;
  const left = anchor.right - inset - MARGIN;
  const below = view.height - menu.top - MARGIN;
  const above = anchor.top - gap - MARGIN;
  const flipX = menu.width > right && left > right;
  const flipY = menu.height > below && above > below;

  return {
    flipX,
    flipY,
    maxWidth: Math.max(MIN_WIDTH, Math.min(widest, Math.floor(flipX ? left : right))),
    // All the room on its side, so no row is hidden while there is room to show it; no least height: in a view too short for a few rows, the
    // menu scrolls within the room rather than pass the edge.
    maxHeight: Math.max(0, Math.floor(flipY ? above : below)),
  };
}

/** What `placeMenus` reads and sets on a menu: the DOM element's own members, named here so this module needs no DOM types. */
export interface MenuElement {
  parentElement: { getBoundingClientRect(): Box } | null;
  getBoundingClientRect(): Box & { width: number; height: number };
  classList: { remove(...names: string[]): void; toggle(name: string, on: boolean): boolean };
  style: { maxWidth: string; maxHeight: string };
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Marks a menu that scrolls with `more-above` and `more-below` while it has rows past its top or bottom edge, which menu.css draws as a fade
 * with a chevron on that edge, so a cut-off menu shows that it scrolls. Run after placing it and on its own scroll.
 */
export function markScroll(menu: Pick<MenuElement, 'classList' | 'scrollTop' | 'scrollHeight' | 'clientHeight'>): void {
  menu.classList.toggle('more-above', menu.scrollTop > 1);
  menu.classList.toggle('more-below', menu.scrollHeight - menu.clientHeight - menu.scrollTop > 1);
}

/**
 * Places each open `.menu` under `root` (`menuPlace`), measured from its default place under its parent, the element it opens from, and marks
 * the edges it has rows past (`markScroll`); nothing before the viewport has a size, as in a test's DOM. Run after each draw, a resize and a scroll, which moves a menu's anchor. `widest` reads a
 * menu's own widest, as its CSS `max-width` sets it, once its size from the last draw is cleared.
 */
export function placeMenus(root: { querySelectorAll(selector: string): Iterable<MenuElement> }, view: { width: number; height: number }, widest: (menu: MenuElement) => number = () => MENU_MAX_WIDTH): void {
  if (view.width === 0 || view.height === 0) {
    return;
  }

  for (const menu of root.querySelectorAll('.menu')) {
    // Measuring it unsized can clamp its scroll to a shorter range, so where it was scrolled to is put back once it is sized again.
    const scrolled = menu.scrollTop;

    menu.classList.remove('flip-x', 'flip-y');
    menu.style.maxWidth = '';
    menu.style.maxHeight = '';

    const anchor = (menu.parentElement ?? menu).getBoundingClientRect();
    const place = menuPlace(anchor, menu.getBoundingClientRect(), view, widest(menu));

    menu.classList.toggle('flip-x', place.flipX);
    menu.classList.toggle('flip-y', place.flipY);
    menu.style.maxWidth = `${place.maxWidth}px`;
    menu.style.maxHeight = `${place.maxHeight}px`;
    menu.scrollTop = scrolled;
    markScroll(menu);
  }
}
