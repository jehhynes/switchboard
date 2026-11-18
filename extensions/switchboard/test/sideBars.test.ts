import { describe, expect, it } from 'vitest';
import { editorWidth, SideBars, stepsBetween, wantedWidth, wantedWidths, withPoint } from '../src/sideBars.js';
import type { EditorLayout, Kept, PaneSize, Point, Side } from '../src/sideBars.js';

const W = 'workbench.action.';
const HIDE_PRIMARY = `${W}closeSidebar`;
const SHOW_PRIMARY = `${W}toggleSidebarVisibility`;
const HIDE_SECONDARY = `${W}closeAuxiliaryBar`;
const SHOW_SECONDARY = `${W}toggleAuxiliaryBar`;
const WIDER = `${W}decreaseViewWidth`;
const NARROWER = `${W}increaseViewWidth`;
const FOCUS_TEST = [`${W}increaseViewSize`, `${W}decreaseViewSize`];

/**
 * A VS Code window as the commands change it (mechanics M61): the editor takes the room the visible side bars leave and gives up width first
 * when the window shrinks; at each group's minimum of 220 the side bars narrow, the primary first, and a narrower editor still reports 220.
 * Hiding a side bar moves the focus to the editor. The pane is in the primary side bar and reports its width and the window's `outer`, which
 * is the room plus 62 pixels for the activity bar, sashes and frame, times `zoom`.
 */
class Workbench {
  room = 1700;
  primary = { width: 300, visible: true };
  secondary = { width: 400, visible: true };
  /** `webview` is a webview in the secondary side bar, which is not resized as the focused part; `secondary` is a tree view there. */
  focus: 'editor' | 'primary' | 'secondary' | 'webview' = 'webview';
  groups = 1;
  flipped = true;
  /** Whether the Explorer, which holds the pane, is the primary side bar's view. */
  explorer = true;
  /** `outer` pixels per CSS pixel. */
  zoom = 1;
  dpr = 1;
  /** A centered layout of fixed width: the editor keeps its width whatever is hidden. */
  fixed = false;
  /** A centered layout: the layout gives this part of the editor's width. */
  centered = 1;
  /** A panel beside the editor, this wide. */
  panel = 0;
  /** The pane is in the secondary side bar, so its width is the secondary's. */
  elsewhere = false;
  /** The pane's next report is the one before, as a report still on its way is. */
  lagging: PaneSize | null = null;
  ran: string[] = [];
  logged: string[] = [];
  kept: Kept = { points: {} };
  clock = 0;
  /** `switchboard.sideBarWidthsMinWindow`. */
  minWindow = 0;

  editor(): number {
    return this.room - this.panel - (this.primary.visible ? this.primary.width : 0) - (this.secondary.visible ? this.secondary.width : 0);
  }

  /** Narrows the side bars, the primary first, until the editor has its minimum. */
  private squeeze(): void {
    for (const bar of [this.primary, this.secondary]) {
      if (bar.visible && this.editor() < 220 * this.groups) {
        bar.width = Math.max(170, bar.width - (220 * this.groups - this.editor()));
      }
    }
  }

  resize(room: number): void {
    this.room = room;
    this.squeeze();
  }

  /** A drag of a side bar's sash, which the editor gives or takes. */
  drag(side: Side, by: number): void {
    const bar = this[side];

    bar.width = Math.max(170, bar.width + Math.min(by, this.editor() - 220 * this.groups));
  }

  /** Moves the editor's width by `by`, as far as its minimum and the side bars' allow: the primary gives or takes the pixels, then the secondary. */
  private editorBy(by: number): void {
    const bars = [this.primary, this.secondary].filter((bar) => bar.visible);
    let left = by < 0 ? -Math.min(-by, this.editor() - 220 * this.groups) : by;

    if (left < 0) {
      if (bars[0] !== undefined) {
        bars[0].width -= left;
      }

      return;
    }

    for (const bar of bars) {
      const taken = Math.min(left, bar.width - 170);

      bar.width -= taken;
      left -= taken;
    }
  }

  private hide(bar: { visible: boolean }): void {
    if (bar.visible) {
      bar.visible = false;
      this.focus = 'editor';
    }
  }

  private show(bar: { visible: boolean }): void {
    bar.visible = true;
    this.squeeze();
  }

  readonly io = {
    layout: async (): Promise<EditorLayout> => {
      if (this.groups === 1 && !this.flipped) {
        return { orientation: 1, groups: [{ size: 823 }] };
      }

      const width = this.fixed ? 900 : Math.max(220, this.editor() / this.groups) * this.centered;

      return { orientation: 0, groups: Array.from({ length: this.groups }, () => ({ size: width })) };
    },
    run: async (command: string, ...args: unknown[]): Promise<void> => {
      this.ran.push(command);

      if (command === 'vscode.setEditorLayout') {
        expect(args).toEqual([{ orientation: 0, groups: [{}] }]);
        this.flipped = true;
        return;
      }

      const by = command.includes('increase') ? 60 : -60;

      switch (command) {
        case SHOW_PRIMARY:
          if (this.primary.visible) this.hide(this.primary);
          else this.show(this.primary);
          break;
        case SHOW_SECONDARY:
          if (this.secondary.visible) this.hide(this.secondary);
          else this.show(this.secondary);
          break;
        case HIDE_PRIMARY:
          this.hide(this.primary);
          break;
        case HIDE_SECONDARY:
          this.hide(this.secondary);
          break;
        case `${W}focusSideBar`:
          this.show(this.primary);
          this.focus = 'primary';
          break;
        case `${W}focusAuxiliaryBar`:
          this.show(this.secondary);
          this.focus = 'webview';
          break;
        case NARROWER:
        case WIDER:
          this.editorBy(by);
          break;
        case `${W}increaseViewSize`:
        case `${W}decreaseViewSize`:
          if (this.focus === 'editor') this.editorBy(by);
          else if (this.focus === 'primary') this.drag('primary', by);
          else if (this.focus === 'secondary') this.drag('secondary', by);
          break;
        default:
          throw new Error(`Unexpected command ${command}`);
      }
    },
    pane: (): PaneSize | null => {
      const now = this.primary.visible && this.explorer ? { inner: this.elsewhere ? this.secondary.width : this.primary.width, outer: (this.room + 62) * this.zoom, dpr: this.dpr } : null;
      const shown = this.lagging ?? now;

      this.lagging = null;
      return shown;
    },
    load: () => this.kept,
    save: async (side: Side, points: Point[]) => {
      this.kept.points[side] = points;
    },
    now: () => ++this.clock,
    minWindow: () => this.minWindow,
    offset: () => 62,
    zoomScale: () => 1 / this.zoom,
    fixedWidth: () => this.fixed,
    sleep: async () => {},
    log: (message: string) => {
      this.logged.push(message);
    },
  };
}

/** Polls as the timer does until a poll does something, and says what and after how many polls. */
async function polls(bars: SideBars, most = 12): Promise<string> {
  for (let count = 1; count <= most; count++) {
    const outcome = await bars.poll();

    if (outcome !== 'idle') {
      return `${outcome} after ${count}`;
    }
  }

  return 'idle';
}

/** A window looked at once, with its widths kept as caps. */
async function settled(setup: (window: Workbench) => void = () => {}): Promise<{ window: Workbench; bars: SideBars }> {
  const window = new Workbench();

  setup(window);

  const bars = new SideBars(window.io);

  // The first look keeps the widths of side bars without caps.
  expect(await polls(bars)).toBe('learned after 4');
  window.ran = [];

  return { window, bars };
}

/** The widths the kept points want in the 1700-pixel room the tests start in. */
const caps = (window: Workbench) => Object.fromEntries(Object.entries(window.kept.points).map(([side, points]) => [side, wantedWidth(points!, 1700)!.width]));

const widths = (window: Workbench) => ({ primary: window.primary.visible ? window.primary.width : null, secondary: window.secondary.visible ? window.secondary.width : null });

describe('SideBars first look (PRD R91)', () => {
  it('reads both side bars without hiding anything, also in a focused window', async () => {
    const { window } = await settled();

    expect(window.logged).toEqual([
      'Resized to a window room of 1700: nothing to set; primary 300 (wanted none), secondary 400 (wanted none).',
      'Kept primary 300 at a window room of 1700: it had no width kept. Points: 300 at 1700.',
      'Kept secondary 400 at a window room of 1700: it had no width kept. Points: 400 at 1700.',
    ]);

    expect(caps(window)).toEqual({ primary: 300, secondary: 400 });
    expect(widths(window)).toEqual({ primary: 300, secondary: 400 });
    expect(window.secondary.visible).toBe(true);
  });

  it('reads a hidden secondary as hidden, and keeps its width once it is shown', async () => {
    const { window, bars } = await settled((window) => {
      window.secondary.visible = false;
    });

    expect(caps(window)).toEqual({ primary: 300 });
    window.secondary.visible = true;
    expect(await polls(bars)).toBe('learned after 5');
    expect(caps(window)).toEqual({ primary: 300, secondary: 400 });
  });

  it('lays out a single group in a row, which leaves the focus alone, so the layout gives its width', async () => {
    const window = new Workbench();
    const bars = new SideBars(window.io);

    window.flipped = false;
    expect(await bars.poll()).toBe('idle');
    expect(window.ran).toEqual(['vscode.setEditorLayout']);
    expect(window.focus).toBe('webview');
  });
});

describe('SideBars widths (PRD R91)', () => {
  it('keeps the widths of a first look as caps, running no command', async () => {
    const { window } = await settled();

    expect(caps(window)).toEqual({ primary: 300, secondary: 400 });
    expect(window.ran).toEqual([]);
  });

  it('keeps a drag of either side bar once it holds, running no command', async () => {
    const { window, bars } = await settled();

    window.drag('primary', 120);
    expect(await polls(bars)).toBe('learned after 5');
    window.drag('secondary', -100);
    expect(await polls(bars)).toBe('learned after 5');
    expect(caps(window)).toEqual({ primary: 420, secondary: 300 });
    expect(window.logged.slice(-2)).toEqual([
      'Kept primary 420 at a window room of 1700: dragged from 300; replaced 300 at 1700. Points: 420 at 1700.',
      'Kept secondary 300 at a window room of 1700: dragged from 400; replaced 400 at 1700. Points: 300 at 1700.',
    ]);
    expect(window.ran).toEqual([]);
  });

  it('does not keep a width that changes on every poll, as during a drag', async () => {
    const { window, bars } = await settled();

    for (let poll = 0; poll < 12; poll++) {
      window.drag('primary', 10);
      expect(await bars.poll()).toBe('idle');
    }

    expect(caps(window).primary).toBe(300);
  });

  it('sets both side bars back after a squeeze and the window grows again, keeping nothing', async () => {
    const { window, bars } = await settled();

    window.resize(600);
    expect(widths(window)).toEqual({ primary: 170, secondary: 210 });
    expect(await polls(bars)).toBe('idle');

    window.resize(1700);
    expect(await polls(bars)).toBe('restored after 3');
    // The primary first, so it is above its minimum when the focus is tested and the secondary set.
    expect(window.ran).toEqual([WIDER, WIDER, ...FOCUS_TEST, HIDE_PRIMARY, WIDER, WIDER, WIDER, SHOW_PRIMARY, `${W}focusAuxiliaryBar`]);
    expect(widths(window)).toEqual({ primary: 290, secondary: 390 });
    expect(window.focus).toBe('webview');
    expect(caps(window)).toEqual({ primary: 300, secondary: 400 });
    expect(window.logged.at(-1)).toBe('Resized to a window room of 1700: setting primary 170 → 290 (wanted 300, √ from 300 at 1700), secondary 210 → 390 (wanted 400, √ from 400 at 1700).');
  });

  it('follows the square root of the window from one point as the window shrinks and grows', async () => {
    const { window, bars } = await settled();

    // 300 and 400 at 1700 want 252 and 336 at 1200.
    window.resize(1200);
    expect(await polls(bars)).toBe('restored after 3');
    expect(widths(window)).toEqual({ primary: 240, secondary: 340 });

    // And 325 and 434 at 2000.
    window.resize(2000);
    expect(await polls(bars)).toMatch(/^restored/);
    expect(widths(window)).toEqual({ primary: 300, secondary: 460 });
    expect(caps(window)).toEqual({ primary: 300, secondary: 400 });
  });

  it('follows the line between two points dragged at different window widths', async () => {
    const { window, bars } = await settled();

    window.resize(1000);
    await polls(bars, 16);
    expect(await polls(bars, 8)).toBe('idle');
    window.drag('primary', 230 - window.primary.width);
    expect(await polls(bars)).toBe('learned after 5');

    // 230 at 1000 and 300 at 1700 want 265 at 1350.
    window.resize(1350);
    expect(await polls(bars, 16)).toMatch(/^restored|^idle/);
    expect(window.logged.some((line) => line.includes('between 230 at 1000 and 300 at 1700'))).toBe(true);
    expect(Math.abs(window.primary.width - 265)).toBeLessThanOrEqual(30);
  });

  it('reads nothing while the pane is hidden, and sets the side bars when it is visible again', async () => {
    const { window, bars } = await settled();

    window.explorer = false;
    window.resize(600);
    window.resize(1700);
    expect(await polls(bars)).toBe('idle');
    expect(window.ran).toEqual([]);

    window.explorer = true;
    expect(await polls(bars)).toBe('restored after 3');
    expect(widths(window)).toEqual({ primary: 290, secondary: 390 });
  });

  it('does nothing in a window narrower than the minimum, and sets the side bars once it is wider', async () => {
    const { window, bars } = await settled((window) => {
      window.minWindow = 1000;
    });

    // The window is the room and 62 pixels.
    window.resize(600);
    expect(await polls(bars)).toBe('idle');
    window.drag('primary', 0);
    window.resize(900);
    window.drag('secondary', 60);
    expect(await polls(bars, 16)).toBe('idle');
    expect(window.ran).toEqual([]);
    expect(caps(window)).toEqual({ primary: 300, secondary: 400 });
    expect(window.logged.at(-1)).toBe('Paused: the window is narrower than 1000 pixels.');

    window.resize(1700);
    expect(await polls(bars)).toBe('restored after 3');
    expect(widths(window)).toEqual({ primary: 290, secondary: 390 });
  });

  it('learns the scale from a resize the editor took, and reads the secondary at it', async () => {
    const { window, bars } = await settled((window) => {
      window.zoom = 1.2;
    });

    // Before the scale is known, the zoom scale stands in for it.
    expect((bars as unknown as { scales: Map<number, number> }).scales.get(1)).toBeUndefined();
    window.resize(1400);
    await polls(bars, 3);
    expect((bars as unknown as { scales: Map<number, number> }).scales.get(1)).toBeCloseTo(1 / 1.2);

    window.resize(600);
    window.resize(1700);
    expect(await polls(bars)).toMatch(/^restored/);
    expect(widths(window)).toEqual({ primary: 290, secondary: 390 });
  });

  it('leaves a hidden secondary hidden and sets the primary alone, hiding nothing', async () => {
    const { window, bars } = await settled();

    window.secondary.visible = false;
    await polls(bars, 6);
    window.resize(300);
    await polls(bars, 3);
    window.resize(1700);
    expect(await polls(bars)).toBe('restored after 3');
    expect(window.secondary.visible).toBe(false);
    expect(window.ran.every((command) => command === WIDER)).toBe(true);
  });

  it('widens the side bars after a squeeze when the window grows back to less than it was', async () => {
    const { window, bars } = await settled();

    window.resize(600);
    await bars.poll();
    window.resize(1650);
    expect(await polls(bars)).toBe('restored after 3');
    expect(widths(window)).toEqual({ primary: 290, secondary: 390 });
  });

  it('keeps drags of both side bars made one after the other', async () => {
    const { window, bars } = await settled();

    window.drag('primary', 100);
    await bars.poll();
    await bars.poll();
    window.drag('secondary', -80);
    expect(await polls(bars)).toBe('learned after 5');
    expect(caps(window)).toEqual({ primary: 400, secondary: 320 });
  });

  it('keeps a drag that the pane reports a poll after the layout', async () => {
    const { window, bars } = await settled();

    const before = window.io.pane();

    window.drag('primary', 120);
    window.lagging = before;
    await bars.poll();
    expect(await polls(bars)).toBe('learned after 5');
    expect(caps(window)).toEqual({ primary: 420, secondary: 400 });
  });

  it('keeps a drag to the minimum', async () => {
    const { window, bars } = await settled();

    window.drag('primary', -130);
    expect(await polls(bars)).toBe('learned after 5');
    expect(caps(window).primary).toBe(170);
    expect(await polls(bars)).toBe('idle');
    expect(window.ran).toEqual([]);
  });

  it('sets the side bars after a narrow window during the wait that follows a restore', async () => {
    const { window, bars } = await settled((window) => {
      window.minWindow = 1000;
    });

    window.resize(600);
    await polls(bars);
    window.resize(1700);
    expect(await polls(bars)).toBe('restored after 3');
    window.resize(600);
    await bars.poll();
    window.resize(1700);
    expect(await polls(bars)).toBe('restored after 3');
    expect(widths(window)).toEqual({ primary: 290, secondary: 390 });
  });

  it('sets nothing with several editor groups, whose sizes a step changes instead', async () => {
    const { window, bars } = await settled();

    window.groups = 2;
    await polls(bars, 6);
    window.resize(900);
    expect(await polls(bars)).toBe('idle');
    window.resize(1700);
    expect(await polls(bars)).toBe('idle');
    expect(window.ran).toEqual([]);
    expect(caps(window)).toEqual({ primary: 300, secondary: 400 });
  });

  it('does not take a squeeze during the wait after a restore for a pane outside the primary', async () => {
    const { window, bars } = await settled();

    window.resize(800);
    await polls(bars);
    window.resize(1700);
    expect(await polls(bars)).toMatch(/^restored/);
    window.resize(500);
    expect(await polls(bars, 16)).toBe('idle');
    window.resize(1700);
    expect(await polls(bars, 16)).toMatch(/^restored/);
    expect(widths(window).primary).toBeGreaterThan(250);
  });

  it('sets the side bars when the pane is shown again in a window narrower than before it was hidden', async () => {
    const { window, bars } = await settled();

    window.explorer = false;
    await bars.poll();
    window.resize(600);
    window.resize(1650);
    window.explorer = true;
    expect(await polls(bars)).toBe('restored after 3');
    expect(widths(window)).toEqual({ primary: 290, secondary: 390 });
  });

  it('sets the side bars at the scale a resize just measured', async () => {
    const { window, bars } = await settled((window) => {
      window.zoom = 1.2;
    });

    // The zoom scale stands in until the resize measures 1/1.2; a wrong one would misread the secondary.
    window.io.zoomScale = () => 1;
    (bars as unknown as { scales: Map<number, number> }).scales.set(1, 1);
    window.resize(1400);
    await polls(bars, 6);
    expect((bars as unknown as { scales: Map<number, number> }).scales.get(1)).toBeCloseTo(1 / 1.2);
    // 300 and 400 at 1700 want 272 and 363 at 1400: set at the measured scale, the secondary narrows a step.
    expect(widths(window)).toEqual({ primary: 300, secondary: 340 });
  });

  it("returns the focus to a tree view in the secondary side bar, leaving its width as it was", async () => {
    const { window, bars } = await settled();

    window.resize(600);
    await polls(bars);
    window.resize(1700);
    window.focus = 'secondary';
    expect(await polls(bars)).toBe('restored after 3');
    expect(window.ran).toContain(`${W}focusAuxiliaryBar`);
    expect(window.ran).not.toContain(`${W}focusSideBar`);
    expect(widths(window)).toEqual({ primary: 290, secondary: 390 });
  });

  it('stops when the pane is wider than the room the editor leaves, as in the panel', async () => {
    const { window, bars } = await settled();

    window.elsewhere = true;
    window.secondary.width = 1500;
    window.secondary.visible = false;
    expect(await polls(bars, 8)).toBe('idle');
    expect(caps(window)).toEqual({ primary: 300, secondary: 400 });
  });

  it('reads nothing in a centered layout of fixed width, where hiding a side bar does not widen the editor', async () => {
    const window = new Workbench();
    const bars = new SideBars(window.io);

    window.fixed = true;
    expect(await polls(bars)).toBe('idle');
    expect(window.ran).toEqual([]);
    expect(window.secondary.visible).toBe(true);
  });

  it('keeps nothing when a panel opens beside the editor, and does not set the secondary until the panel closes', async () => {
    const { window, bars } = await settled();

    window.panel = 300;
    expect(await polls(bars)).toBe('idle');
    expect(caps(window)).toEqual({ primary: 300, secondary: 400 });
    expect(window.logged.at(-1)).toMatch(/^The secondary jumped 300 pixels wider/);

    window.resize(2400);
    expect(await polls(bars)).toBe('restored after 3');
    expect(window.secondary.width).toBe(400);
    expect(window.ran.every((command) => command === WIDER)).toBe(true);

    window.panel = 0;
    expect(await polls(bars, 8)).toBe('idle');
    expect(window.logged).toContain('The secondary jumped back: it is set again.');
  });

  it('stops when the pane does not follow the primary, as when it was moved to the secondary side bar', async () => {
    const { window, bars } = await settled();

    window.resize(900);
    await polls(bars, 3);
    window.elsewhere = true;
    window.secondary.width = 200;
    window.resize(1700);
    expect(await polls(bars, 16)).toMatch(/^restored/);
    window.ran = [];
    window.resize(800);
    window.resize(1700);
    expect(await polls(bars, 16)).toBe('idle');
    expect(window.ran).toEqual([]);
  });

  it('measures the scale only from held readings, not a pane report still on its way', async () => {
    const { window, bars } = await settled();

    window.resize(1600);
    await bars.poll();
    window.lagging = window.io.pane();
    window.resize(1400);
    await polls(bars, 4);
    expect((bars as unknown as { scales: Map<number, number> }).scales.get(1)).toBeCloseTo(1);
  });

  it("puts the focus back in the primary side bar's view or leaves it in the editor, wherever it was", async () => {
    for (const [focus, back] of [['primary', `${W}focusSideBar`], ['editor', null]] as const) {
      const { window, bars } = await settled();

      window.resize(600);
      await polls(bars);
      window.resize(1700);
      window.focus = focus;
      expect(await polls(bars)).toBe('restored after 3');
      expect(window.focus).toBe(focus);
      expect(window.ran.includes(`${W}focusSideBar`)).toBe(back !== null);
      expect(window.ran).not.toContain(`${W}focusAuxiliaryBar`);
      // The test step was undone.
      expect(widths(window)).toEqual({ primary: 290, secondary: 390 });
    }
  });

  it('tests the focus only where a step cannot be cut short, and then leaves it where hiding put it', async () => {
    const { window, bars } = await settled();

    // A primary kept at 180 stays at its minimum of 170, too near it for the test step.
    window.kept.points.primary = [{ room: 1700, width: 180, at: 0 }];
    window.resize(600);
    await polls(bars);
    window.resize(1700);
    expect(await polls(bars)).toBe('restored after 3');
    expect(window.ran).toEqual([HIDE_PRIMARY, WIDER, WIDER, WIDER, SHOW_PRIMARY]);
  });



  it('runs one poll at a time', async () => {
    const { window, bars } = await settled();

    window.resize(600);
    await polls(bars);
    window.resize(1700);

    const outcomes = await Promise.all([bars.poll(), bars.poll(), bars.poll(), bars.poll()]);

    expect(outcomes.every((outcome) => outcome === 'idle')).toBe(true);
  });
});

describe('side bar arithmetic (PRD R91)', () => {
  it('counts the steps to a width without passing the minimum, none within half a step', () => {
    expect(stepsBetween(170, 400)).toBe(4);
    expect(stepsBetween(400, 380)).toBe(0);
    expect(stepsBetween(400, 100)).toBe(-3);
    expect(stepsBetween(170, 0)).toBe(0);
  });

  it('wants the line between two points, the square root outside them, at least the minimum, and nothing without points', () => {
    const points = [
      { room: 1300, width: 350, at: 1 },
      { room: 2400, width: 600, at: 2 },
    ];

    expect(wantedWidth(points, 1850)).toEqual({ width: 475, from: 'between 350 at 1300 and 600 at 2400' });
    expect(wantedWidth(points, 3200)).toEqual({ width: 693, from: '√ from 600 at 2400' });
    expect(wantedWidth(points, 650)).toEqual({ width: 247, from: '√ from 350 at 1300' });
    expect(wantedWidth([{ room: 2000, width: 180, at: 1 }], 1000)!.width).toBe(170);
    expect(wantedWidth([], 1700)).toBeNull();
    expect(wantedWidths({ points: { primary: points } }, { primary: 200, secondary: 300 }, 1300)).toEqual({ primary: { width: 350, from: '√ from 350 at 1300' }, secondary: null });
  });

  it('replaces a point in its band, drops points it contradicts and the oldest past six, and keeps them by room', () => {
    const point = (room: number, width: number, at: number) => ({ room, width, at });

    expect(withPoint([point(1300, 350, 1), point(2400, 600, 2)], point(1400, 380, 3))).toEqual([point(1400, 380, 3), point(2400, 600, 2)]);
    expect(withPoint([point(1300, 350, 1), point(2400, 600, 2)], point(1500, 650, 3))).toEqual([point(1300, 350, 1), point(1500, 650, 3)]);
    expect(withPoint([point(1300, 350, 1), point(2400, 600, 2)], point(2000, 300, 3))).toEqual([point(2000, 300, 3), point(2400, 600, 2)]);

    const many = [1200, 1500, 1800, 2100, 2400, 2700].map((room, index) => point(room, 300 + index * 20, index + 1));

    expect(withPoint(many, point(3000, 500, 7)).map((kept) => kept.room)).toEqual([1500, 1800, 2100, 2400, 2700, 3000]);
  });

  it('reads the editor width from columns, and none from rows only', () => {
    expect(editorWidth({ orientation: 0, groups: [{ size: 400 }, { size: 500 }] })).toBe(900);
    expect(editorWidth({ orientation: 1, groups: [{ size: 300 }, { groups: [{ size: 200 }, { size: 300 }] }] })).toBe(500);
    expect(editorWidth({ orientation: 1, groups: [{ size: 300 }, { size: 300 }] })).toBeNull();
  });
});
