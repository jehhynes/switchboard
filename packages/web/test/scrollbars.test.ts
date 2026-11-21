import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERLAY_SCROLL, overlayScrollbars, SCROLLBAR_HIDE_MS, thumbGeometry } from '../src/scrollbars.js';

describe('thumbGeometry', () => {
  it('sizes the thumb by the visible share and places it by the scroll position', () => {
    expect(thumbGeometry(0, 1_000, 250)).toEqual({ top: 0, height: 62.5 });
    expect(thumbGeometry(750, 1_000, 250)).toEqual({ top: 187.5, height: 62.5 });
    expect(thumbGeometry(375, 1_000, 250)).toEqual({ top: 93.75, height: 62.5 });
  });

  it('keeps a long area\'s thumb at least 24 px, and shows none for an area that does not scroll', () => {
    expect(thumbGeometry(0, 100_000, 200)!.height).toBe(24);
    expect(thumbGeometry(99_800, 100_000, 200)!.top).toBe(176);
    expect(thumbGeometry(0, 200, 200)).toBeNull();
    expect(thumbGeometry(0, 0, 0)).toBeNull();
  });
});

describe('overlayScrollbars', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it("hides the native bar of every area it overlays, the CSS's list being the script's", () => {
    const css = readFileSync(join(__dirname, '../src/page.css'), 'utf8');

    expect(css).toContain(`:is(${OVERLAY_SCROLL}) { scrollbar-width: none; }`);
  });

  it('shows the thumb over the area being scrolled and fades it out, but not while the pointer is over the area', () => {
    vi.useFakeTimers();

    const root = document.createElement('div');

    root.innerHTML = '<div id="list"></div><p class="plain"></p>';
    document.body.append(root);

    const list = root.querySelector<HTMLElement>('#list')!;

    Object.defineProperties(list, { scrollHeight: { value: 1_000 }, clientHeight: { value: 250 }, scrollTop: { value: 750, writable: true } });
    list.getBoundingClientRect = () => ({ top: 40, right: 300 }) as DOMRect;

    const stop = overlayScrollbars(root);
    const thumb = root.querySelector<HTMLElement>('.scroll-thumb')!;

    list.dispatchEvent(new Event('scroll'));
    expect(thumb.classList.contains('shown')).toBe(true);
    expect([thumb.style.top, thumb.style.left, thumb.style.height]).toEqual(['227.5px', '292px', '62.5px']);
    vi.advanceTimersByTime(SCROLLBAR_HIDE_MS);
    expect(thumb.classList.contains('shown')).toBe(false);

    // Hovering the area shows it and keeps it; leaving lets it fade.
    list.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_MS * 2);
    expect(thumb.classList.contains('shown')).toBe(true);
    root.querySelector('.plain')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_MS);
    expect(thumb.classList.contains('shown')).toBe(false);

    // Leaving the page with the pointer over the area lets it fade too.
    list.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_MS * 2);
    expect(thumb.classList.contains('shown')).toBe(true);
    root.dispatchEvent(new MouseEvent('pointerleave'));
    vi.advanceTimersByTime(SCROLLBAR_HIDE_MS);
    expect(thumb.classList.contains('shown')).toBe(false);

    // An element outside the overlaid areas gets no thumb.
    root.querySelector('.plain')!.dispatchEvent(new Event('scroll'));
    expect(thumb.classList.contains('shown')).toBe(false);
    stop();
    expect(root.querySelector('.scroll-thumb')).toBeNull();
    list.dispatchEvent(new Event('scroll'));
  });

  it('scrolls the area by dragging the thumb, in proportion', () => {
    const root = document.createElement('div');

    root.innerHTML = '<div class="scroll"></div>';
    document.body.append(root);

    const area = root.querySelector<HTMLElement>('.scroll')!;

    Object.defineProperties(area, { scrollHeight: { value: 1_000 }, clientHeight: { value: 250 }, scrollTop: { value: 0, writable: true } });
    area.getBoundingClientRect = () => ({ top: 0, right: 300 }) as DOMRect;

    const stop = overlayScrollbars(root);
    const thumb = root.querySelector<HTMLElement>('.scroll-thumb')!;

    area.dispatchEvent(new Event('scroll'));
    thumb.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientY: 10 }));
    // 750 px to scroll over 187.5 px of track: 4 px per pixel.
    thumb.dispatchEvent(new MouseEvent('pointermove', { clientY: 60 }));
    expect(area.scrollTop).toBe(200);
    thumb.dispatchEvent(new MouseEvent('pointerup', {}));
    thumb.dispatchEvent(new MouseEvent('pointermove', { clientY: 160 }));
    expect(area.scrollTop).toBe(200);
    stop();
  });
});
