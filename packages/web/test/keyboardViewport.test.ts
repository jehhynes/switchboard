import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYBOARD_PX, realignAfterKeyboard, SETTLE_MS } from '../src/keyboardViewport.js';

/** A window whose visual viewport the test moves as iOS does when the keyboard opens and closes. */
const phone = () => {
  const viewport = Object.assign(new EventTarget(), { height: 793, offsetTop: 0, scale: 1 });
  const win = Object.assign(new EventTarget(), { document: new EventTarget(), visualViewport: viewport, innerHeight: 793, scrollY: 0, scrollTo: vi.fn() });
  const move = (height: number, offsetTop: number): void => {
    viewport.height = height;
    viewport.offsetTop = offsetTop;
    viewport.dispatchEvent(new Event('resize'));
  };

  return { win, viewport, move, stop: realignAfterKeyboard(win as unknown as Window) };
};

describe('realigning the page after the keyboard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scrolls a pixel and back once the keyboard has closed on a page iOS left moved', () => {
    const { win, move } = phone();

    move(793 - 336, 300);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo).not.toHaveBeenCalled();
    move(793, 24);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(win.scrollTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.scrollTo.mock.calls).toEqual([[0, 1], [0, 0]]);
  });

  it('realigns after a field loses the focus and when the page is shown again', () => {
    const { win, viewport } = phone();

    viewport.offsetTop = 24;
    win.document.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo).toHaveBeenCalledTimes(2);
    win.dispatchEvent(new Event('pageshow'));
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo).toHaveBeenCalledTimes(4);
  });

  it('realigns a viewport that moves later with no resize, as a scroll after the keyboard closed can', () => {
    const { win, viewport } = phone();

    viewport.offsetTop = 24;
    viewport.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo.mock.calls).toEqual([[0, 1], [0, 0]]);
  });

  it('realigns a page whose layout viewport the keyboard scrolled', () => {
    const { win, move } = phone();

    win.scrollY = 40;
    move(793, 0);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo.mock.calls).toEqual([[0, 41], [0, 0]]);
  });

  it('leaves a page in line, the keyboard still showing and a zoomed page alone', () => {
    const { win, viewport, move } = phone();

    move(793, 0);
    vi.advanceTimersByTime(SETTLE_MS);
    move(793 - KEYBOARD_PX - 1, 24);
    vi.advanceTimersByTime(SETTLE_MS);
    win.document.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(SETTLE_MS);
    viewport.scale = 2;
    move(793, 24);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('stops listening, and drops a pending realign, when stopped', () => {
    const { win, move, stop } = phone();

    move(793, 24);
    stop();
    vi.advanceTimersByTime(SETTLE_MS);
    move(793, 24);
    win.document.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(SETTLE_MS);
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('does nothing where the browser has no visual viewport', () => {
    const win = Object.assign(new EventTarget(), { document: new EventTarget(), visualViewport: null, scrollTo: vi.fn() });

    realignAfterKeyboard(win as unknown as Window)();
    expect(win.scrollTo).not.toHaveBeenCalled();
  });
});
