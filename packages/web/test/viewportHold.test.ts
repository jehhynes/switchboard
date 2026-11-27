import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdViewport, NUDGE_GAP_MS, SETTLE_MS, typing } from '../src/viewportHold.js';

/** A window whose scroll and visual viewport the test moves as iOS does around the keyboard (mechanics.md M155, M177). */
const phone = () => {
  const viewport = Object.assign(new EventTarget(), { height: 762, offsetTop: 0, scale: 1 });
  const doc = Object.assign(new EventTarget(), { activeElement: document.body as Element | null, scrollingElement: { scrollTop: 0 }, body: { scrollTop: 0 } });
  const win = Object.assign(new EventTarget(), {
    document: doc,
    visualViewport: viewport,
    innerHeight: 762,
    scrollY: 0,
    scrollTo: vi.fn((_x: number, y: number) => {
      win.scrollY = y;
      doc.scrollingElement.scrollTop = y;
      viewport.offsetTop = y;
    }),
    requestAnimationFrame: (run: () => void) => setTimeout(run, 16) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  const shift = (y: number): void => {
    win.scrollY = y;
    doc.scrollingElement.scrollTop = y;
    viewport.offsetTop = y;
  };
  const stop = holdViewport(win as unknown as Window);

  vi.advanceTimersByTime(SETTLE_MS);
  win.scrollTo.mockClear();
  return { win, doc, viewport, shift, stop };
};

const field = (html: string): Element => {
  const host = document.createElement('div');

  host.innerHTML = html;
  return host.firstElementChild!;
};

describe('holding the page at the top', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scrolls a page iOS left scrolled back to the top once the composer loses the focus', () => {
    const { win, doc, shift } = phone();

    doc.activeElement = field('<textarea></textarea>');
    shift(405);
    win.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo).not.toHaveBeenCalled();
    doc.activeElement = document.body;
    doc.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(16);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(win.scrollY).toBe(0);
  });

  it('puts the page back when iOS shifts it later with no field focused, on each event that can follow', () => {
    const { win, doc, viewport, shift } = phone();

    for (const [target, kind] of [[viewport, 'resize'], [viewport, 'scroll'], [win, 'scroll'], [win, 'pageshow'], [win, 'orientationchange'], [doc, 'visibilitychange'], [doc, 'focusout']] as const) {
      shift(48);
      target.dispatchEvent(new Event(kind));
      vi.advanceTimersByTime(SETTLE_MS);
      expect(win.scrollY, kind).toBe(0);
    }
  });

  it('looks again after the keyboard has had time to close', () => {
    const { win, doc, shift } = phone();

    doc.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(16);
    expect(win.scrollTo).not.toHaveBeenCalled();
    shift(48);
    vi.advanceTimersByTime(SETTLE_MS - 16);
    expect(win.scrollY).toBe(0);
  });

  it('scrolls a pixel and back when only the visual viewport is panned', () => {
    const { win, viewport } = phone();

    viewport.offsetTop = 24;
    viewport.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(16);
    expect(win.scrollTo.mock.calls).toEqual([[0, 1], [0, 0]]);
  });

  it('nudges a viewport the nudge does not move at most once a second, though each nudge fires scroll events', () => {
    const { win, viewport } = phone();

    win.scrollTo.mockImplementation((_x: number, y: number) => {
      win.scrollY = y;
      viewport.dispatchEvent(new Event('scroll'));
    });
    viewport.offsetTop = 24;
    viewport.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(NUDGE_GAP_MS - 1);
    expect(win.scrollTo.mock.calls).toEqual([[0, 1], [0, 0]]);
    viewport.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo).toHaveBeenCalledTimes(4);
  });

  it('clears a scrolled body as well as the document', () => {
    const { win, doc } = phone();

    doc.body.scrollTop = 30;
    win.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(16);
    expect(doc.body.scrollTop).toBe(0);
  });

  it('leaves a page in line, a field taking the keyboard and a zoomed page alone', () => {
    const { win, doc, viewport, shift } = phone();

    win.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SETTLE_MS);

    for (const html of ['<input type="text">', '<input type="search">', '<input>', '<textarea></textarea>', '<select></select>']) {
      doc.activeElement = field(html);
      shift(200);
      win.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(SETTLE_MS);
    }

    doc.activeElement = document.body;
    viewport.scale = 2;
    shift(200);
    viewport.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('stops listening, and drops a pending look, when stopped', () => {
    const { win, shift, stop } = phone();

    shift(48);
    win.dispatchEvent(new Event('scroll'));
    stop();
    vi.advanceTimersByTime(SETTLE_MS);
    win.dispatchEvent(new Event('pageshow'));
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo).not.toHaveBeenCalled();
  });
});

describe('typing', () => {
  it('counts the fields that show the keyboard and not buttons, boxes or the page', () => {
    const editable = field('<div contenteditable="true"></div>');

    document.body.append(editable);
    const at = (node: Element | null): boolean => typing({ activeElement: node } as unknown as Document);

    expect(['<input>', '<input type="email">', '<textarea></textarea>', '<select></select>'].map((html) => at(field(html)))).toEqual([true, true, true, true]);
    expect(['<input type="checkbox">', '<input type="range">', '<button></button>', '<div></div>'].map((html) => at(field(html)))).toEqual([false, false, false, false]);
    expect(at(editable)).toBe(true);
    expect(at(null)).toBe(false);
    expect(at(document.body)).toBe(false);
    editable.remove();
  });
});
