/**
 * The page never scrolls as a whole (page.css), but iOS scrolls or pans it to keep a focused text field above the keyboard, and sometimes leaves
 * it there after the field loses the focus: the header is drawn off the top, an empty band shows under the composer, and taps land off what
 * is drawn (mechanics.md M155, M177). Whenever no text field has the focus, the page is put back at the top.
 */

/** How long after an event iOS can still be moving the viewport, closing the keyboard or restoring the page: a second look after it. */
export const SETTLE_MS = 350;
/** The least time between two nudges, so a viewport the nudge does not move is not nudged again by the nudge's own scroll events. */
export const NUDGE_GAP_MS = 1000;

/** Whether the focused element is one that shows the on-screen keyboard, while which iOS is meant to move the page. */
export function typing(doc: Document): boolean {
  const node = doc.activeElement;

  if (node === null || typeof (node as HTMLElement).matches !== 'function') {
    return false;
  }

  if ((node as HTMLElement).isContentEditable === true || node.matches('[contenteditable]:not([contenteditable="false"])') || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') {
    return true;
  }

  return node.tagName === 'INPUT' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes((node as HTMLInputElement).type);
}

/** Keeps the page at the top of the screen while no text field has the focus; returns a stop. */
export function holdViewport(win: Window): () => void {
  const doc = win.document;
  const view = win.visualViewport;
  let nudged = -Infinity;
  const align = (): void => {
    // A zoomed page is meant to pan.
    if (typing(doc) || (view != null && view.scale > 1.01)) {
      return;
    }

    const scrolled = win.scrollY !== 0 || (doc.scrollingElement?.scrollTop ?? 0) !== 0 || doc.body.scrollTop !== 0;

    if (scrolled) {
      win.scrollTo(0, 0);
      doc.body.scrollTop = 0;
    }

    // WebKit bug 297779: a visual viewport left panned with no scroll to undo lines up again after a scroll of a pixel and back.
    if (view != null && Math.abs(view.offsetTop) >= 1 && Date.now() - nudged >= NUDGE_GAP_MS) {
      nudged = Date.now();
      win.scrollTo(0, 1);
      win.scrollTo(0, 0);
    }
  };
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = (): void => {
    if (frame === undefined) {
      frame = win.requestAnimationFrame(() => {
        frame = undefined;
        align();
      });
    }

    clearTimeout(timer);
    timer = setTimeout(align, SETTLE_MS);
  };
  const stopping = new AbortController();
  const signal = stopping.signal;

  view?.addEventListener('resize', soon, { signal });
  view?.addEventListener('scroll', soon, { signal });
  win.addEventListener('scroll', soon, { passive: true, signal });
  win.addEventListener('pageshow', soon, { signal });
  win.addEventListener('orientationchange', soon, { signal });
  doc.addEventListener('focusout', soon, { signal });
  doc.addEventListener('visibilitychange', soon, { signal });
  soon();
  return () => {
    stopping.abort();
    clearTimeout(timer);

    if (frame !== undefined) {
      win.cancelAnimationFrame(frame);
    }
  };
}
