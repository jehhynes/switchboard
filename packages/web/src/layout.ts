// Which columns the web page shows at its width (architecture.md § Web page), from what each column needs rather than fixed widths.

/** Under this width the list and the conversation are separate views (page.css). */
export const TABLET_MIN = 768;
/** The conversation's pane at its least comfortable width: about 600 px of header, timeline and composer inside its 20 px padding each side. */
export const CHAT_FIT = 640;
/** The Status, Artifacts and Console column's least width, page.css's `min-width` for it. */
export const DETAIL_MIN = 360;
/** How much wider than it needs the page must grow before a column that left comes back, so a width near a boundary does not flap. */
export const LAYOUT_SLACK = 40;

/** Which columns show beside an open conversation: the list as a column rather than a drawer, and Status and Artifacts as a column rather than tabs. */
export interface Layout {
  list: boolean;
  wide: boolean;
}

/**
 * The list's width as page.css draws it: the width kept on its sash, or `clamp(260px, 30vw, 340px)`, at least 200 px and at most half the page,
 * the least winning as CSS's `min-width` does over `max-width`.
 */
export function sideWidth(kept: number | null, width: number): number {
  const wanted = kept ?? Math.min(340, Math.max(260, width * 0.3));

  return Math.max(200, Math.min(wanted, width / 2));
}

/**
 * The columns that fit `width`: the list only while it, the conversation at `CHAT_FIT` and the column at `DETAIL_MIN` all fit, and the column
 * only while the conversation and it fit beside whatever the list takes. A column shown at `before` stays until it no longer fits; one hidden
 * comes back only `LAYOUT_SLACK` past its need. A phone's width shows neither.
 */
export function fitLayout(width: number, list: number, before: Layout | null): Layout {
  if (width < TABLET_MIN) {
    return { list: false, wide: false };
  }

  const fits = (need: number, was: boolean | undefined): boolean => width >= need + (before === null || was === true ? 0 : LAYOUT_SLACK);
  const showList = fits(list + CHAT_FIT + DETAIL_MIN, before?.list);

  return { list: showList, wide: fits((showList ? list : 0) + CHAT_FIT + DETAIL_MIN, before?.wide) };
}
