// Which columns the web page shows at its width (architecture.md § Web page), from what each column needs rather than fixed widths.

/** Under this width the list and the conversation are separate views, whatever the device (page.css). */
export const TABLET_MIN = 768;
/**
 * A device whose screen's short side is under this many CSS pixels is a phone, in landscape too: phones' short sides are 320 to 440 px, and the
 * smallest tablet's, the iPad mini's, is 744 px.
 */
export const PHONE_SHORT_MAX = 500;
/** The conversation's pane at its least comfortable width: about 600 px of header, timeline and composer inside its 20 px padding each side. */
export const CHAT_FIT = 640;
/** The least width the conversation's sash sets: header, timeline and composer still work at about 360 px inside the padding. */
export const CHAT_MIN = 400;
/** The History, Artifacts and Console column's least width, page.css's `min-width` for it. */
export const DETAIL_MIN = 360;
/** How much wider than it needs the page must grow before a column that left comes back, so a width near a boundary does not flap. */
export const LAYOUT_SLACK = 40;

/** Which columns show beside an open conversation: the list as a column rather than a drawer, and History and Artifacts as a column rather than tabs. */
export interface Layout {
  list: boolean;
  wide: boolean;
}

/**
 * The list's width as page.css draws it: the width kept on its sash, or `clamp(260px, 30vw, 340px)`, at least 200 px and at most half the page
 * and what leaves the conversation `CHAT_MIN`, the least winning as CSS's `min-width` does over `max-width`.
 */
export function sideWidth(kept: number | null, width: number): number {
  const wanted = kept ?? Math.min(340, Math.max(260, width * 0.3));

  return Math.max(200, Math.min(wanted, width / 2, width - CHAT_MIN));
}

/**
 * The conversation's width the columns are fitted to: the width set on its sash, between `CHAT_MIN` and `CHAT_FIT`, or `CHAT_FIT` with none set,
 * so a conversation narrowed on its sash leaves room for the list and the column, and one widened past `CHAT_FIT` still gives way to them.
 */
export function chatNeed(kept: number | null): number {
  return Math.max(CHAT_MIN, Math.min(kept ?? CHAT_FIT, CHAT_FIT));
}

/**
 * Whether the page draws the phone's layout, with the list and the conversation as separate views: under `TABLET_MIN` wide, or on a device
 * whose screen's short side (`screenShort`, 0 where unknown) is a phone's, so a phone on its side keeps it. A desktop window gets it by its
 * width alone, since its screen is never that small.
 */
export function phoneLayout(width: number, screenShort: number): boolean {
  return width < TABLET_MIN || (screenShort > 0 && screenShort < PHONE_SHORT_MAX);
}

/** `phoneLayout` for this window and its screen. */
export function isPhone(): boolean {
  const short = typeof screen === 'object' && screen !== null ? Math.min(screen.width, screen.height) : 0;

  return phoneLayout(window.innerWidth, Number.isFinite(short) ? short : 0);
}

/**
 * The columns at `width`: the list whenever it is pinned, whatever the width, and a drawer otherwise; the column only while the conversation at
 * `chat` (`chatNeed`) and it, at `DETAIL_MIN`, fit beside whatever the pinned list takes. A column shown at `before` stays until it no longer
 * fits; one hidden comes back only `LAYOUT_SLACK` past its need. The phone's layout (`phone`) shows neither.
 */
export function fitLayout(width: number, list: number, before: Layout | null, chat = CHAT_FIT, pinned = true, phone = phoneLayout(width, 0)): Layout {
  if (phone) {
    return { list: false, wide: false };
  }

  const need = (pinned ? list : 0) + chat + DETAIL_MIN;

  return { list: pinned, wide: width >= need + (before === null || before.wide ? 0 : LAYOUT_SLACK) };
}

/**
 * The most the list's sash may set while the list is pinned at `width`: what leaves the conversation its least width beside it, and, while
 * the History and Artifacts column shows (`wide`), the conversation at `chat` and the column at `DETAIL_MIN`, so a drag never folds the column.
 */
export function sideLimit(width: number, wide: boolean, chat = CHAT_FIT): number {
  return width - (wide ? chat + DETAIL_MIN : CHAT_MIN);
}
