import { describe, expect, it } from 'vitest';
import { markScroll, menuPlace, placeMenus } from '../src/menuPlace.js';
import type { Box, MenuElement } from '../src/menuPlace.js';

const VIEW = { width: 800, height: 600 };
const box = (left: number, top: number, width: number, height: number): Box & { width: number; height: number } => ({ left, top, right: left + width, bottom: top + height, width, height });
/** A menu in its default place: under the anchor, 2 px down, left edges lined up, or `inset` px in from the anchor's left edge. */
const under = (anchor: Box, width: number, height: number, inset = 0, gap = 2) => box(anchor.left + inset, anchor.bottom + gap, width, height);

describe('where a menu opens', () => {
  it('opens under its button, left edges lined up, with all the room to the right and below as its largest', () => {
    const left = box(100, 10, 30, 20);
    const middle = box(500, 10, 30, 20);

    expect(menuPlace(left, under(left, 200, 300), VIEW)).toEqual({ flipX: false, flipY: false, maxWidth: 360, maxHeight: 560 });
    expect(menuPlace(middle, under(middle, 200, 300), VIEW)).toEqual({ flipX: false, flipY: false, maxWidth: 292, maxHeight: 560 });
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
    expect(menuPlace(low, under(low, 250, 200, 8, -4), { width: 310, height: 600 })).toEqual({ flipX: true, flipY: true, maxWidth: 284, maxHeight: 496 });
  });

  it('opens above only when it would pass the bottom and has more room above, as tall as the room on its side and never taller', () => {
    const low = box(100, 500, 30, 20);
    const middle = box(100, 300, 30, 20);
    const high = box(100, 100, 30, 20);

    expect(menuPlace(low, under(low, 200, 200), VIEW)).toMatchObject({ flipY: true, maxHeight: 490 });
    expect(menuPlace(middle, under(middle, 200, 200), VIEW)).toMatchObject({ flipY: false, maxHeight: 270 });
    // No cap of its own: a long menu takes the whole 470 px below, not a share of the view's height.
    expect(menuPlace(high, under(high, 200, 500), VIEW)).toMatchObject({ flipY: false, maxHeight: 470 });
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
  scrollTop = 0;
  readonly classList = {
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name), on),
  };
  measured: string | null = null;

  constructor(
    readonly parentElement: { getBoundingClientRect(): Box },
    private readonly size: { width: number; height: number },
  ) {}

  get scrollHeight(): number {
    return this.size.height;
  }

  /** Its rows' height, or less where its `max-height` cuts it. */
  get clientHeight(): number {
    return this.style.maxHeight === '' ? this.size.height : Math.min(this.size.height, parseFloat(this.style.maxHeight));
  }

  getBoundingClientRect(): Box & { width: number; height: number } {
    // Measured from its default place: no flip and no size of its own left from the last draw.
    this.measured = [...this.classes].join(' ') + (this.style.maxWidth === '' && this.style.maxHeight === '' ? '' : ' sized');
    // Unsized, it is as tall as its rows, so a browser clamps its scroll to nothing.
    this.scrollTop = 0;
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
    expect(right.style).toEqual({ maxWidth: '360px', maxHeight: '560px' });
    expect([...left.classes]).toEqual(['menu']);
    expect(left.style.maxWidth).toBe('360px');
  });

  it("takes a menu's own widest in place of the default, still within the room", () => {
    const wide = new FakeMenu({ getBoundingClientRect: () => box(10, 10, 30, 20) }, { width: 450, height: 100 });
    const cramped = new FakeMenu({ getBoundingClientRect: () => box(500, 10, 30, 20) }, { width: 450, height: 100 });

    placeMenus({ querySelectorAll: () => [wide, cramped] }, VIEW, () => 480);
    expect(wide.style.maxWidth).toBe('480px');
    // 800 - 500 - 8 px to the right, 530 - 8 to the left: it flips and takes 480.
    expect(cramped.style.maxWidth).toBe('480px');
    expect([...cramped.classes]).toContain('flip-x');
    expect(menuPlace(box(500, 10, 30, 20), under(box(500, 10, 30, 20), 200, 100), VIEW, 480)).toMatchObject({ flipX: false, maxWidth: 292 });
  });

  it('leaves the menus alone before the viewport has a size', () => {
    const menu = new FakeMenu({ getBoundingClientRect: () => box(760, 10, 30, 20) }, { width: 200, height: 100 });

    placeMenus({ querySelectorAll: () => [menu] }, { width: 0, height: 0 });
    expect(menu.measured).toBeNull();
    expect(menu.style).toEqual({ maxWidth: '200px', maxHeight: '100px' });
  });

  it('marks a menu taller than its room as scrolling, and keeps where it was scrolled to', () => {
    // 900 px of rows under a button at the top of a 600 px view: 560 px of room.
    const long = new FakeMenu({ getBoundingClientRect: () => box(10, 10, 30, 20) }, { width: 200, height: 900 });
    const fits = new FakeMenu({ getBoundingClientRect: () => box(300, 10, 30, 20) }, { width: 200, height: 300 });

    placeMenus({ querySelectorAll: () => [long, fits] }, VIEW);
    expect(long.style.maxHeight).toBe('560px');
    expect([...long.classes]).toEqual(['menu', 'more-below']);
    expect([...fits.classes]).toEqual(['menu']);

    // Scrolled part way, a redraw measures it unsized, which clamps its scroll, and puts the scroll back.
    long.scrollTop = 200;
    placeMenus({ querySelectorAll: () => [long, fits] }, VIEW);
    expect(long.scrollTop).toBe(200);
    expect([...long.classes].sort()).toEqual(['menu', 'more-above', 'more-below']);
  });
});

describe('marking where a menu scrolls', () => {
  const menu = (scrollTop: number, scrollHeight: number, clientHeight: number) => {
    const classes = new Set<string>();

    return { classes, scrollTop, scrollHeight, clientHeight, classList: { remove: () => undefined, toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name), on) } };
  };

  it('marks each edge with rows past it, and neither on a menu that fits', () => {
    const top = menu(0, 500, 300);
    const middle = menu(100, 500, 300);
    const end = menu(200, 500, 300);
    const fits = menu(0, 300, 300);

    [top, middle, end, fits].forEach(markScroll);
    expect([...top.classes]).toEqual(['more-below']);
    expect([...middle.classes]).toEqual(['more-above', 'more-below']);
    expect([...end.classes]).toEqual(['more-above']);
    expect([...fits.classes]).toEqual([]);
  });

  it('takes a scroll a pixel short of an edge, as a zoomed page rounds it, for that edge', () => {
    const end = menu(199.5, 500, 300);

    markScroll(end);
    expect([...end.classes]).toEqual(['more-above']);
  });
});
