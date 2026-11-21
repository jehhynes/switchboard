import { describe, expect, it } from 'vitest';
import { menuPlace, placeMenus } from '../src/menuPlace.js';
import type { Box, MenuElement } from '../src/menuPlace.js';

const VIEW = { width: 800, height: 600 };
const box = (left: number, top: number, width: number, height: number): Box & { width: number; height: number } => ({ left, top, right: left + width, bottom: top + height, width, height });
/** A menu in its default place: under the anchor, 2 px down, left edges lined up, or `inset` px in from the anchor's left edge. */
const under = (anchor: Box, width: number, height: number, inset = 0, gap = 2) => box(anchor.left + inset, anchor.bottom + gap, width, height);

describe('where a menu opens', () => {
  it('opens under its button, left edges lined up, with the room to the right and below as its largest', () => {
    const left = box(100, 10, 30, 20);
    const middle = box(500, 10, 30, 20);

    expect(menuPlace(left, under(left, 200, 300), VIEW)).toEqual({ flipX: false, flipY: false, maxWidth: 360, maxHeight: 360 });
    expect(menuPlace(middle, under(middle, 200, 300), VIEW)).toEqual({ flipX: false, flipY: false, maxWidth: 292, maxHeight: 360 });
  });

  it("lines up with the button's right edge only when it would pass the right edge and has more room to the left", () => {
    const edge = box(700, 10, 30, 20);
    const near = box(620, 10, 30, 20);
    const narrow = box(20, 10, 30, 20);

    expect(menuPlace(edge, under(edge, 200, 100), VIEW)).toMatchObject({ flipX: true, maxWidth: 360 });
    expect(menuPlace(near, under(near, 200, 100), VIEW)).toMatchObject({ flipX: true, maxWidth: 360 });
    // A button at the left of a narrow view keeps the left edge, narrowed, rather than open past the view's left edge.
    expect(menuPlace(narrow, under(narrow, 300, 100), { width: 200, height: 600 })).toMatchObject({ flipX: false, maxWidth: 172 });
  });

  it("keeps a menu's own inset from its anchor in the room it measures, on either side", () => {
    // A pool row's menu sits 8 px in from the row's edges and 4 px up into it.
    const row = box(0, 10, 300, 40);

    expect(menuPlace(row, under(row, 200, 100, 8, -4), { width: 300, height: 600 })).toMatchObject({ flipX: false, maxWidth: 284 });
    expect(menuPlace(row, under(row, 300, 100, 8, -4), { width: 300, height: 600 })).toMatchObject({ flipX: false, maxWidth: 284 });
    const low = box(100, 500, 200, 40);

    // Flipped, its right edge stays 8 px in from the row's: 300 - 8 - 8 px of room.
    expect(menuPlace(low, under(low, 250, 200, 8, -4), { width: 310, height: 600 })).toEqual({ flipX: true, flipY: true, maxWidth: 284, maxHeight: 360 });
  });

  it('opens above only when it would pass the bottom and has more room above, and never taller than the room on its side', () => {
    const low = box(100, 500, 30, 20);
    const middle = box(100, 300, 30, 20);
    const high = box(100, 100, 30, 20);

    expect(menuPlace(low, under(low, 200, 200), VIEW)).toMatchObject({ flipY: true, maxHeight: 360 });
    expect(menuPlace(middle, under(middle, 200, 200), VIEW)).toMatchObject({ flipY: false, maxHeight: 270 });
    expect(menuPlace(high, under(high, 200, 500), VIEW)).toMatchObject({ flipY: false, maxHeight: 360 });
    // Fits on neither side: it takes the larger, capped to it, so it scrolls inside the view rather than pass its top.
    expect(menuPlace(middle, under(middle, 200, 360), VIEW)).toMatchObject({ flipY: true, maxHeight: 290 });
    // In a view too short for it on either side, it is only as tall as the room, however little.
    const short = box(100, 70, 30, 20);

    expect(menuPlace(short, under(short, 200, 120), { width: 800, height: 160 })).toMatchObject({ flipY: false, maxHeight: 60 });
  });
});

class FakeMenu implements MenuElement {
  readonly classes = new Set<string>(['menu', 'flip-y']);
  readonly style = { maxWidth: '200px', maxHeight: '100px' };
  readonly classList = {
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name), on),
  };
  measured: string | null = null;

  constructor(
    readonly parentElement: { getBoundingClientRect(): Box },
    private readonly size: { width: number; height: number },
  ) {}

  getBoundingClientRect(): Box & { width: number; height: number } {
    // Measured from its default place: no flip and no size of its own left from the last draw.
    this.measured = [...this.classes].join(' ') + (this.style.maxWidth === '' && this.style.maxHeight === '' ? '' : ' sized');
    return under(this.parentElement.getBoundingClientRect(), this.size.width, this.size.height);
  }
}

describe('placing the open menus', () => {
  it('measures each menu from its default place, then sets its flips and its largest size', () => {
    const right = new FakeMenu({ getBoundingClientRect: () => box(760, 10, 30, 20) }, { width: 200, height: 100 });
    const left = new FakeMenu({ getBoundingClientRect: () => box(10, 10, 30, 20) }, { width: 200, height: 100 });

    placeMenus({ querySelectorAll: () => [right, left] }, VIEW);
    expect(right.measured).toBe('menu');
    expect([...right.classes]).toEqual(['menu', 'flip-x']);
    expect(right.style).toEqual({ maxWidth: '360px', maxHeight: '360px' });
    expect([...left.classes]).toEqual(['menu']);
    expect(left.style.maxWidth).toBe('360px');
  });

  it('leaves the menus alone before the viewport has a size', () => {
    const menu = new FakeMenu({ getBoundingClientRect: () => box(760, 10, 30, 20) }, { width: 200, height: 100 });

    placeMenus({ querySelectorAll: () => [menu] }, { width: 0, height: 0 });
    expect(menu.measured).toBeNull();
    expect(menu.style).toEqual({ maxWidth: '200px', maxHeight: '100px' });
  });
});
