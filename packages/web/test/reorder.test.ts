import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAG_START_PX, dropAt, HOLD_MS, HOLD_SLOP_PX, rowDrag } from '../src/reorder.js';
import type { DragView } from '../src/reorder.js';

// Three Ready for review rows 40 px tall from y 100, under a pinned heading at the top of the list, and an In progress row after them.
const ROWS = [
  { workItemId: 4, top: 100, height: 40 },
  { workItemId: 7, top: 140, height: 40 },
  { workItemId: 9, top: 180, height: 40 },
];

describe('dropAt (PRD R73)', () => {
  it("places the dragged row after the row above the pointer, first above the first row's middle, and last below the last's", () => {
    expect(dropAt(ROWS, 9, 110)).toEqual({ after: null, edge: 4, below: false });
    expect(dropAt(ROWS, 9, 125)).toEqual({ after: 4, edge: 7, below: false });
    expect(dropAt(ROWS, 4, 165)).toEqual({ after: 7, edge: 9, below: false });
    expect(dropAt(ROWS, 4, 205)).toEqual({ after: 9, edge: 9, below: true });
  });

  it("drops nothing at the dragged row's own place, outside the rows, or for a row that is not there", () => {
    // Either edge of row 7 is its own place.
    expect(dropAt(ROWS, 7, 125)).toBeNull();
    expect(dropAt(ROWS, 7, 175)).toBeNull();
    expect(dropAt(ROWS, 4, 99)).toBeNull();
    expect(dropAt(ROWS, 4, 221)).toBeNull();
    expect(dropAt(ROWS, 5, 205)).toBeNull();
    expect(dropAt([], 4, 120)).toBeNull();
  });
});

describe('dragging a Ready for review row (PRD R73)', () => {
  let list: HTMLElement;
  let views: Array<DragView | null>;
  let drops: Array<[number, number | null]>;
  let clicks: string[];
  let listening: AbortController;

  const rect = (top: number, height: number, left = 0, width = 300): DOMRect => ({ top, height, bottom: top + height, left, right: left + width, width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const at = (selector: string): HTMLElement => list.querySelector<HTMLElement>(selector)!;
  const pointer = (target: Element, type: string, x: number, y: number, patch: Partial<PointerEventInit> = {}): boolean =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...patch }));
  const touch = { pointerType: 'touch' };

  beforeEach(() => {
    views = [];
    drops = [];
    clicks = [];
    listening = new AbortController();
    list = document.createElement('div');
    list.id = 'list';
    list.innerHTML =
      '<section class="group" data-group="review"><button class="group-head"></button><ul class="rows">' +
      ROWS.map((row) => `<li><button class="row" data-action="select" data-work-item="${row.workItemId}"><span class="row-title">Item ${row.workItemId}</span></button></li>`).join('') +
      '</ul></section><section class="group" data-group="progress"><ul class="rows"><li><button class="row" data-action="select" data-work-item="2"></button></li></ul></section>';
    document.body.replaceChildren(list);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = Number((this as HTMLElement).dataset?.['workItem'] ?? NaN);
      const row = ROWS.find((one) => one.workItemId === id);

      return this === list ? rect(60, 400) : this.classList.contains('group-head') ? rect(60, 32) : row !== undefined ? rect(row.top, row.height) : id === 2 ? rect(240, 40) : rect(0, 0);
    });
    list.addEventListener('click', (event) => clicks.push((event.target as HTMLElement).closest<HTMLElement>('[data-work-item]')?.dataset['workItem'] ?? 'list'));
    rowDrag(list, { changed: (drag) => views.push(drag), drop: (id, after) => drops.push([id, after]), signal: listening.signal });
  });

  afterEach(() => {
    listening.abort();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('drags with the mouse once it moves past the start distance, shows the drop line, moves the row on release and runs no click', () => {
    const row = at('[data-work-item="9"]');

    pointer(row, 'pointerdown', 20, 200);
    pointer(list, 'pointermove', 20, 200 - DRAG_START_PX);
    expect(views).toEqual([]);
    pointer(list, 'pointermove', 20, 110);
    expect(views).toEqual([{ dragging: 9, drop: null }, { dragging: 9, drop: { after: null, edge: 4, below: false } }]);
    expect(list.classList.contains('reordering')).toBe(true);
    // Moving within the same drop draws nothing again.
    pointer(list, 'pointermove', 22, 112);
    expect(views).toHaveLength(2);
    pointer(list, 'pointermove', 20, 125);
    expect(views.at(-1)).toEqual({ dragging: 9, drop: { after: 4, edge: 7, below: false } });
    pointer(list, 'pointerup', 20, 125);
    row.click();
    expect(drops).toEqual([[9, 4]]);
    expect(views.at(-1)).toBeNull();
    expect(list.classList.contains('reordering')).toBe(false);
    expect(clicks).toEqual([]);

    // The next click is the row's again.
    row.click();
    expect(clicks).toEqual(['9']);
  });

  it("moves nothing on a release at the row's own place, beside the rows, over the pinned heading, or on another group's row", () => {
    const row = at('[data-work-item="4"]');
    const release = (x: number, y: number) => {
      pointer(row, 'pointerdown', 20, 120);
      pointer(list, 'pointermove', 20, 130);
      pointer(list, 'pointermove', x, y);
      pointer(list, 'pointerup', x, y);
    };

    release(20, 135);
    release(320, 205);
    release(20, 70);
    release(20, 250);
    expect(drops).toEqual([]);
    // A press on a row of another group starts no drag.
    pointer(at('[data-work-item="2"]'), 'pointerdown', 20, 250);
    pointer(list, 'pointermove', 20, 110);
    pointer(list, 'pointerup', 20, 110);
    expect(views.filter((view) => view?.dragging === 2)).toEqual([]);
    expect(drops).toEqual([]);
  });

  it('leaves a plain click alone, and a press released before it moves far enough', () => {
    const row = at('[data-work-item="7"]');

    pointer(row, 'pointerdown', 20, 160);
    pointer(list, 'pointermove', 20, 162);
    pointer(row, 'pointerup', 20, 162);
    row.click();
    expect(views).toEqual([]);
    expect(clicks).toEqual(['7']);
  });

  it('cancels the drag on Escape, before any other Escape handler, on a cancelled pointer and on a lost capture', () => {
    const row = at('[data-work-item="9"]');
    const otherEscape = vi.fn();

    document.addEventListener('keydown', otherEscape);

    for (const cancel of [
      () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
      () => pointer(list, 'pointercancel', 20, 110),
      () => pointer(list, 'lostpointercapture', 20, 110),
    ]) {
      pointer(row, 'pointerdown', 20, 200);
      pointer(list, 'pointermove', 20, 110);
      expect(views.at(-1)).toEqual({ dragging: 9, drop: { after: null, edge: 4, below: false } });
      cancel();
      expect(views.at(-1)).toBeNull();
      // The release that follows moves nothing.
      pointer(list, 'pointerup', 20, 110);
    }

    expect(drops).toEqual([]);
    expect(otherEscape).not.toHaveBeenCalled();
    document.removeEventListener('keydown', otherEscape);
    // Escape with no drag is the page's.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('starts a touch drag only after the finger holds still, keeps that finger from scrolling the list and opening the menu, and moves the row', () => {
    vi.useFakeTimers();

    const row = at('[data-work-item="4"]');

    pointer(row, 'pointerdown', 20, 120, touch);
    pointer(list, 'pointermove', 20 + HOLD_SLOP_PX - 2, 120, touch);
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(views).toEqual([]);

    const scroll = new TouchEvent('touchmove', { bubbles: true, cancelable: true });

    list.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);
    vi.advanceTimersByTime(1);
    expect(views).toEqual([{ dragging: 4, drop: null }]);

    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    row.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);

    const drag = new TouchEvent('touchmove', { bubbles: true, cancelable: true });

    list.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    pointer(list, 'pointermove', 20, 205, touch);
    pointer(list, 'pointerup', 20, 205, touch);
    expect(drops).toEqual([[4, 9]]);
  });

  it('leaves a touch that moves before the hold to the scroll, and one the browser cancels', () => {
    vi.useFakeTimers();

    const row = at('[data-work-item="4"]');

    pointer(row, 'pointerdown', 20, 120, touch);
    pointer(list, 'pointermove', 20, 120 + HOLD_SLOP_PX + 1, touch);
    vi.advanceTimersByTime(HOLD_MS);
    pointer(row, 'pointerdown', 20, 120, touch);
    pointer(list, 'pointercancel', 20, 120, touch);
    vi.advanceTimersByTime(HOLD_MS);
    expect(views).toEqual([]);

    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    row.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
  });

  it("keeps a touch drag when the row's implicit capture moves to the list, and lets a tap after a cancelled drag through", () => {
    vi.useFakeTimers();

    const row = at('[data-work-item="4"]');
    const title = row.querySelector('.row-title')!;

    pointer(title, 'pointerdown', 20, 120, touch);
    vi.advanceTimersByTime(HOLD_MS);
    // The touched element's implicit capture is lost as the list takes it, and that event bubbles to the list.
    pointer(title, 'lostpointercapture', 20, 120, touch);
    expect(views.at(-1)).toEqual({ dragging: 4, drop: null });
    pointer(list, 'pointermove', 20, 205, touch);
    pointer(list, 'pointerup', 20, 205, touch);
    expect(drops).toEqual([[4, 9]]);

    // A drag the browser cancels makes no click, so the next tap is the row's.
    pointer(title, 'pointerdown', 20, 120, touch);
    vi.advanceTimersByTime(HOLD_MS);
    pointer(list, 'pointercancel', 20, 120, touch);
    expect(views.at(-1)).toBeNull();
    row.click();
    expect(clicks).toEqual(['4']);
  });

  it('lets the click of a new press anywhere in the list through after a drag whose release made none', () => {
    const row = at('[data-work-item="9"]');
    const other = at('[data-work-item="2"]');
    const drag = () => {
      pointer(row, 'pointerdown', 20, 200);
      pointer(list, 'pointermove', 20, 110);
      pointer(list, 'pointerup', 20, 110);
    };

    // No click followed each release; the next press and release click, on a Ready for review row, another group's row or a heading.
    for (const target of [row, other, at('.group-head')]) {
      drag();
      pointer(target, 'pointerdown', 20, 200);
      pointer(target, 'pointerup', 20, 200);
      target.click();
    }

    expect(clicks).toEqual(['9', '2', 'list']);
  });

  it('drops the click of the release after Escape however late it comes, and only that one', () => {
    vi.useFakeTimers();

    const row = at('[data-work-item="9"]');

    pointer(row, 'pointerdown', 20, 200);
    pointer(list, 'pointermove', 20, 110);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(5_000);
    pointer(row, 'pointerup', 20, 200);
    row.click();
    expect(clicks).toEqual([]);
    pointer(row, 'pointerdown', 20, 200);
    pointer(row, 'pointerup', 20, 200);
    row.click();
    expect(clicks).toEqual(['9']);
    expect(drops).toEqual([]);
  });

  it('shows the drop again when the list scrolls under a still pointer, and stops listening once the page closes', () => {
    const row = at('[data-work-item="9"]');
    const spy = vi.mocked(Element.prototype.getBoundingClientRect);
    const moved = spy.getMockImplementation()!;

    pointer(row, 'pointerdown', 20, 200);
    pointer(list, 'pointermove', 20, 115);
    expect(views.at(-1)).toEqual({ dragging: 9, drop: { after: null, edge: 4, below: false } });
    // The rows scroll up by 30 px, so the pointer is now past row 4's middle.
    spy.mockImplementation(function (this: Element) {
      const box = moved.call(this);

      return this === list || this.classList.contains('group-head') ? box : rect(box.top - 30, box.height);
    });
    list.dispatchEvent(new Event('scroll'));
    expect(views.at(-1)).toEqual({ dragging: 9, drop: { after: 4, edge: 7, below: false } });
    pointer(list, 'pointerup', 20, 115);
    expect(drops).toEqual([[9, 4]]);
    listening.abort();
    pointer(row, 'pointerdown', 20, 200);
    pointer(list, 'pointermove', 20, 110);
    expect(views.at(-1)).toBeNull();
  });
});
