/**
 * Overlay scrollbars, as the dock's (architecture.md § Web page): the page's vertical scroll areas (`OVERLAY_SCROLL`) hide their native bar,
 * and one thin thumb, fixed over the right edge of the area being scrolled or hovered, shows its place, taking no width; it fades out
 * `SCROLLBAR_HIDE_MS` after the last scroll unless the pointer stays over the area or the thumb. Scrolling stays the browser's own; the thumb
 * can be dragged.
 */
export const OVERLAY_SCROLL = '#list, .scroll, .artifact-doc, .menu, .composer-menu, .sheet, .composer textarea';
export const SCROLLBAR_HIDE_MS = 800;
const MIN_THUMB = 24;

/** The thumb's top and height within an area's visible height, or null when the area does not scroll. */
export function thumbGeometry(scrollTop: number, scrollHeight: number, clientHeight: number): { top: number; height: number } | null {
  if (scrollHeight <= clientHeight + 1 || clientHeight <= 0) {
    return null;
  }

  const height = Math.max(MIN_THUMB, (clientHeight * clientHeight) / scrollHeight);
  const top = (Math.min(Math.max(scrollTop, 0), scrollHeight - clientHeight) / (scrollHeight - clientHeight)) * (clientHeight - height);

  return { top, height };
}

/** Starts the overlay scrollbars for the page under `root`; the returned function stops them. */
export function overlayScrollbars(root: HTMLElement): () => void {
  const thumb = document.createElement('div');

  thumb.className = 'scroll-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  root.append(thumb);

  /** The area the thumb shows, the pointer's area, and the fade's timer. */
  let area: HTMLElement | null = null;
  let hovered: HTMLElement | null = null;
  let dragging = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const areaOf = (target: EventTarget | null): HTMLElement | null => (target instanceof Element ? target.closest<HTMLElement>(OVERLAY_SCROLL) : null);
  const place = (): boolean => {
    const geometry = area === null || !area.isConnected ? null : thumbGeometry(area.scrollTop, area.scrollHeight, area.clientHeight);

    if (area === null || geometry === null) {
      thumb.classList.remove('shown');
      return false;
    }

    const box = area.getBoundingClientRect();

    thumb.style.top = `${box.top + area.clientTop + geometry.top}px`;
    thumb.style.left = `${box.right - area.clientLeft - 8}px`;
    thumb.style.height = `${geometry.height}px`;
    return true;
  };
  /** Fades the thumb out after a while, unless the pointer is then over its area or the thumb, or drags it. */
  const fade = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!dragging && hovered !== area && !thumb.matches(':hover')) {
        thumb.classList.remove('shown');
      }
    }, SCROLLBAR_HIDE_MS);
  };
  const show = (next: HTMLElement): void => {
    area = next;

    if (place()) {
      thumb.classList.add('shown');
    }

    fade();
  };
  const onScroll = (event: Event): void => {
    const scrolled = event.target instanceof HTMLElement && event.target.matches(OVERLAY_SCROLL) ? event.target : null;

    if (scrolled !== null) {
      show(scrolled);
    }
  };
  const onOver = (event: PointerEvent): void => {
    if (event.target === thumb) {
      clearTimeout(timer);
      return;
    }

    const next = areaOf(event.target);

    if (next !== hovered) {
      hovered = next;

      if (next !== null) {
        show(next);
      } else {
        fade();
      }
    }
  };
  const onDown = (event: PointerEvent): void => {
    const target = area;

    if (event.button !== 0 || target === null) {
      return;
    }

    event.preventDefault();
    dragging = true;
    thumb.classList.add('dragging');
    thumb.setPointerCapture?.(event.pointerId);

    const startY = event.clientY;
    const startTop = target.scrollTop;
    const geometry = thumbGeometry(target.scrollTop, target.scrollHeight, target.clientHeight);
    const ratio = geometry === null ? 0 : (target.scrollHeight - target.clientHeight) / Math.max(1, target.clientHeight - geometry.height);
    const move = (next: PointerEvent): void => {
      target.scrollTop = startTop + (next.clientY - startY) * ratio;
    };
    const end = (): void => {
      dragging = false;
      thumb.classList.remove('dragging');
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointerup', end);
      thumb.removeEventListener('pointercancel', end);
      show(target);
    };

    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', end);
    thumb.addEventListener('pointercancel', end);
  };

  /** The pointer left the page, where no `pointerover` follows: nothing is hovered, so the thumb fades. */
  const onLeave = (): void => {
    hovered = null;
    fade();
  };

  document.addEventListener('scroll', onScroll, true);
  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerleave', onLeave);
  thumb.addEventListener('pointerdown', onDown);

  return () => {
    clearTimeout(timer);
    document.removeEventListener('scroll', onScroll, true);
    root.removeEventListener('pointerover', onOver);
    root.removeEventListener('pointerleave', onLeave);
    thumb.remove();
  };
}
