/**
 * iOS 26 can leave the page's visual viewport moved after the keyboard closes (WebKit bug 297779): the top bars, which are sticky, still draw at
 * the top while a tap there lands on the page below them, as on the list's or the conversation's first row. Once the keyboard has closed, a
 * page left out of line is scrolled a pixel and back, which makes WebKit line the viewport up with the page again.
 */

/** How much shorter than the window the visual viewport is while the keyboard shows. */
export const KEYBOARD_PX = 120;
/** How long after the viewport's last change the keyboard has finished closing. */
export const SETTLE_MS = 300;

/** Realigns the page each time the keyboard closes, the viewport moves, a field loses the focus or the page is shown again; returns a stop. */
export function realignAfterKeyboard(win: Window): () => void {
  const viewport = win.visualViewport;

  if (viewport == null) {
    return () => {};
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const realign = (): void => {
    timer = undefined;

    // The keyboard still shows, or the operator has zoomed in, where the viewport is meant to move.
    if (viewport.height < win.innerHeight - KEYBOARD_PX || viewport.scale > 1.01) {
      return;
    }

    if (viewport.offsetTop === 0 && win.scrollY === 0) {
      return;
    }

    win.scrollTo(0, win.scrollY + 1);
    win.scrollTo(0, 0);
  };
  const soon = (): void => {
    clearTimeout(timer);
    timer = setTimeout(realign, SETTLE_MS);
  };
  const stopping = new AbortController();

  viewport.addEventListener('resize', soon, { signal: stopping.signal });
  viewport.addEventListener('scroll', soon, { signal: stopping.signal });
  win.document.addEventListener('focusout', soon, { signal: stopping.signal });
  win.addEventListener('pageshow', soon, { signal: stopping.signal });
  return () => {
    clearTimeout(timer);
    stopping.abort();
  };
}
