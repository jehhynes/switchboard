/** A side bar's minimum width, and the pixels each of VS Code's resize commands moves (mechanics M61). */
export const MIN_WIDTH = 170;
export const STEP = 60;

/** An editor group's minimum width: a narrower editor area still reports this, so a width at it may not be the real one. */
const GROUP_MIN = 220;
/** How far two readings of a width may differ and count as the same. */
const CLOSE = 8;
/** The window's width in CSS pixels may move this much between polls and count as unchanged. */
const STILL = 2;
/** How often the side bars are read; the pane reports its size this often too. */
export const POLL_MS = 250;
/** Polls a new window width must hold before the side bars are set: half a second. */
const RESIZED = 2;
/** Polls a dragged width must hold before it is kept, a second, so a drag in progress is not. */
const DRAGGED = 4;
/** Polls to wait after setting the side bars, a second, while the pane reports their new widths. */
const COOLDOWN = 4;
/** A remainder narrower than this is no secondary side bar. */
const HIDDEN = 100;
/** A side bar that changed this much between two polls was shown, hidden or joined by a panel beside the editor, not dragged. */
const JUMP = 150;

const HIDE_PRIMARY = 'workbench.action.closeSidebar';
const SHOW_PRIMARY = 'workbench.action.toggleSidebarVisibility';
const FOCUS_PRIMARY = 'workbench.action.focusSideBar';
const FOCUS_SECONDARY = 'workbench.action.focusAuxiliaryBar';
/** Resize the focused part, which does nothing while a webview has the focus. */
const GROW_FOCUSED = 'workbench.action.increaseViewSize';
const SHRINK_FOCUSED = 'workbench.action.decreaseViewSize';
/** Resize the editor area whatever has the focus: the primary side bar takes or gives the pixels, or the secondary while the primary is hidden. */
const GROW_EDITOR = 'workbench.action.increaseViewWidth';
const SHRINK_EDITOR = 'workbench.action.decreaseViewWidth';
/** Lays out a single group in a row, so the layout gives its width; unlike `toggleEditorGroupLayout`, it leaves the focus where it is (mechanics M61). */
const SET_LAYOUT = 'vscode.setEditorLayout';
const ROW = { orientation: 0, groups: [{}] };

export const SIDES = ['primary', 'secondary'] as const;

export type Side = (typeof SIDES)[number];

/** What `vscode.getEditorLayout` returns: `size` is a width under a horizontal parent (orientation 0) and a height under a vertical one. */
export interface EditorLayout {
  orientation: number;
  groups: LayoutGroup[];
}

export interface LayoutGroup {
  size?: number;
  groups?: LayoutGroup[];
}

/** What the visible Switchboard pane reports (PRD R92): its own width, the primary side bar's, and the window's `outerWidth`, which zoom leaves unscaled. */
export interface PaneSize {
  inner: number;
  outer: number;
  dpr: number;
}

/** A width the operator dragged a side bar to, in a window with `room` pixels for the side bars and the editor, at time `at`. */
export interface Point {
  room: number;
  width: number;
  at: number;
}

/** The kept widths (PRD R91): each side bar's points, by room. */
export interface Kept {
  points: Partial<Record<Side, Point[]>>;
}

/** Points nearer than this in room replace each other. */
const BAND = 200;
/** The most points a side bar keeps; the oldest goes. */
const MOST_POINTS = 6;

/**
 * The points with `point` added (PRD R91): a point in its band goes, and so does one it contradicts, a narrower room with a wider side bar or
 * a wider room with a narrower one, so a wider window never wants a narrower side bar; at most six, the oldest dropped. By room.
 */
export function withPoint(points: Point[], point: Point): Point[] {
  const kept = points.filter(
    (other) => Math.abs(other.room - point.room) >= BAND && !(other.room < point.room && other.width > point.width) && !(other.room > point.room && other.width < point.width),
  );

  return [...kept, point]
    .sort((a, b) => b.at - a.at)
    .slice(0, MOST_POINTS)
    .sort((a, b) => a.room - b.room);
}

/**
 * The width a side bar wants in `room` from its points (PRD R91): between two points, the straight line through them; outside them, the
 * nearest point's width times the square root of the rooms' ratio, which grows slower than the window does; at least the minimum. With it,
 * how it was found, for the log. Null without points.
 */
export function wantedWidth(points: Point[], room: number): { width: number; from: string } | null {
  if (points.length === 0) {
    return null;
  }

  const sorted = [...points].sort((a, b) => a.room - b.room);
  const at = (point: Point) => `${point.width} at ${Math.round(point.room)}`;
  const outside = (point: Point) => ({ width: point.width * Math.sqrt(room / point.room), from: `√ from ${at(point)}` });
  const above = sorted.findIndex((point) => point.room >= room);
  const found = above === -1 ? outside(sorted.at(-1)!) : above === 0 ? outside(sorted[0]!) : (() => {
    const low = sorted[above - 1]!;
    const high = sorted[above]!;

    return { width: low.width + ((high.width - low.width) * (room - low.room)) / (high.room - low.room), from: `between ${at(low)} and ${at(high)}` };
  })();

  return { width: Math.max(MIN_WIDTH, Math.round(found.width)), from: found.from };
}

export interface SideBarIo {
  layout(): PromiseLike<EditorLayout>;
  run(command: string, ...args: unknown[]): PromiseLike<unknown>;
  /** The visible pane's latest report, or null while no pane is visible. */
  pane(): PaneSize | null;
  load(): Kept;
  save(side: Side, points: Point[]): PromiseLike<void>;
  now(): number;
  /** CSS pixels per `outer` pixel before a resize measures it: 1 at zoom level 0. */
  zoomScale(): number;
  /**
   * The CSS pixels of the window that are neither a side bar nor the editor at `scale`: the window's frame, the activity bar and the sashes
   * (mechanics M61).
   */
  offset(scale: number): number;
  /** Whether the editor may keep its width when a side bar is hidden, as in a centered layout of fixed width, so nothing can be measured. */
  fixedWidth(): boolean;
  /** Waits, so the pane's report can catch up with a command. */
  sleep(ms: number): Promise<void>;
  /** Records what was kept or set, and why reading stopped, for the operator to follow. */
  log(message: string): void;
  /** The window width, in CSS pixels, under which nothing is read, kept or set. */
  minWindow(): number;
}

/** What a poll did: kept a dragged width, set the side bars, or nothing. */
export type Outcome = 'learned' | 'restored' | 'idle';

interface Columns {
  width: number;
  /** At the minimum, where the real width may be less. */
  least: boolean;
  groups: number;
  /** Every group's size, to tell a resized group from an unchanged layout. */
  sizes: string;
}

/** Each side bar's width, null for a hidden one. */
export type Widths = Record<Side, number | null>;

/** One reading: the pane's `outer`, the window's room for the side bars and the editor, the editor, and the side bars. */
interface Reading {
  dpr: number;
  outer: number;
  room: number;
  editor: Columns;
  widths: Widths;
}

/** The editor area's width, or null for a layout that does not hold it: groups stacked in rows only. */
export function editorWidth(layout: EditorLayout): number | null {
  return columns(layout)?.width ?? null;
}

function columns(layout: EditorLayout): Columns | null {
  // A row split into columns holds the width.
  const groups = layout.orientation === 0 ? layout.groups : layout.groups.find((group) => group.groups !== undefined && group.groups.length > 0)?.groups;
  const width = groups?.reduce((total, group) => total + (group.size ?? Number.NaN), 0);

  return groups === undefined || width === undefined || !(width > 0) ? null : { width, least: width <= GROUP_MIN * groups.length, groups: groups.length, sizes: JSON.stringify(layout.groups) };
}

/** A single group, which reports its height until its orientation is flipped. */
function unflipped(layout: EditorLayout): boolean {
  return layout.orientation === 1 && layout.groups.length === 1 && layout.groups[0]!.groups === undefined;
}

/** The steps of 60 pixels that bring `width` nearest `wanted` without passing a side bar's minimum: positive to widen. None within half a step. */
export function stepsBetween(width: number, wanted: number): number {
  // `|| 0` turns -0 into 0.
  return Math.max(Math.round((wanted - width) / STEP), -Math.max(0, Math.floor((width - MIN_WIDTH) / STEP))) || 0;
}

/** What each visible side bar wants in `room` (PRD R91), null for a hidden one and one without points. */
export function wantedWidths(kept: Kept, widths: Widths, room: number): Record<Side, { width: number; from: string } | null> {
  const wanted = (side: Side) => (widths[side] === null ? null : wantedWidth(kept.points[side] ?? [], room));

  return { primary: wanted('primary'), secondary: wanted('secondary') };
}

/**
 * Keeps the width the operator drags each side bar to and sets it again after the window's width changed (PRD R91). The visible Switchboard
 * pane, in the primary side bar, reports that side bar's width and the window's; `vscode.getEditorLayout` gives the editor's, and the secondary
 * holds the rest, less the window's frame, activity bar and sashes. A change of the window's width is a resize, after which the
 * side bars are set; a side bar that changed in a window that did not was dragged, and its width is kept. Nothing is read while no pane is visible.
 */
export class SideBars {
  /** The last reading. */
  private last: Reading | null = null;
  /** The widths last kept or set, which a drag moves away from, and the room then; null until the side bars hold still after a change. */
  private base: { widths: Widths; room: number } | null = null;
  /** Polls the reading has held; whether the window's width changed since the side bars were last set, and the held reading before it did. */
  private held = 0;
  private resized = true;
  private before: Reading | null = null;
  /** Whether a side bar jumped since the base, as one shown or hidden, or a panel beside the editor, does. */
  private jumped = false;
  /**
   * The secondary's reading after it jumped wider while it stayed visible, as a panel opened beside the editor makes it read, so it is not set
   * until it reads that much narrower again; null without a jump.
   */
  private panel: number | null = null;
  /** Polls to wait after setting the side bars, the pane's `outer` then, and the primary's width and steps, to check that the pane is in it. */
  private cooldown = 0;
  private restored: { outer: number; primary: number; steps: number } | null = null;
  /** The pane is not in the primary side bar, so nothing is read until it is hidden and shown again. */
  private elsewhere = false;
  /** CSS pixels per `outer` pixel, by pixel ratio, as resizes measured them in this window. */
  private readonly scales = new Map<number, number>();
  private busy = false;
  /** What had the focus before a side bar was hidden: the editor, the primary side bar's own view, or neither, as with a webview; `unknown` when it could not be tested. */
  private focus: 'editor' | 'primary' | 'secondary' | 'other' | 'unknown' = 'unknown';

  constructor(private readonly io: SideBarIo) {}

  /** Call four times a second. */
  poll(): Promise<Outcome> {
    return this.once(async () => {
      const pane = this.io.pane();

      // Nothing tells a drag from a squeeze while no pane is visible, so the side bars are set when one is again.
      if (pane === null) {
        this.last = null;
        this.held = 0;
        this.resized = true;
        this.base = null;
        this.elsewhere = false;
        return 'idle';
      }

      if (this.elsewhere || this.io.fixedWidth()) {
        return 'idle';
      }

      // A narrow window is left alone: nothing is read, kept or set until it is wider again, and then the side bars are set.
      if (pane.outer * (this.scales.get(pane.dpr) ?? this.io.zoomScale()) < this.io.minWindow()) {
        if (this.last !== null || this.base !== null) {
          this.io.log(`Paused: the window is narrower than ${this.io.minWindow()} pixels.`);
        }

        this.last = null;
        this.held = 0;
        this.resized = true;
        this.base = null;
        this.cooldown = 0;
        this.restored = null;
        return 'idle';
      }

      if (this.cooldown > 0) {
        this.cooldown--;
        // A resize while the pane catches up is set after it, and leaves the pane's width nothing to tell.
        if (this.restored !== null && pane.outer !== this.restored.outer) {
          this.resized = true;
          this.restored = null;
        }

        return 'idle';
      }

      let layout = await this.io.layout();

      if (unflipped(layout)) {
        await this.io.run(SET_LAYOUT, ROW);
        layout = await this.io.layout();
      }

      const editor = columns(layout);

      if (editor === null) {
        return 'idle';
      }

      return this.look(this.read(pane, editor));
    });
  }

  /** The side bars' widths now, from the pane and the editor, at the scale measured for the pane's pixel ratio. */
  private read(pane: PaneSize, editor: Columns): Reading {
    const scale = this.scales.get(pane.dpr) ?? this.io.zoomScale();
    const room = pane.outer * scale - this.io.offset(scale);
    const rest = room - pane.inner - editor.width;

    return { dpr: pane.dpr, outer: pane.outer, room, editor, widths: { primary: pane.inner, secondary: rest < HIDDEN ? null : Math.round(rest) } };
  }

  private async look(reading: Reading): Promise<Outcome> {
    const last = this.last;

    if (this.panel !== null && (reading.widths.secondary === null || reading.widths.secondary <= this.panel - JUMP)) {
      this.panel = null;
      this.io.log('The secondary jumped back: it is set again.');
    }


    this.last = reading;

    if (last === null) {
      this.held = 0;
      this.checkRestored(reading);
      return 'idle';
    }

    if (reading.outer !== last.outer) {
      // The reading before the first change of a resize, held, is where its scale is measured from.
      if (!this.resized && this.held >= 1) {
        this.before = last;
      }

      this.resized = true;
      this.held = 0;
      return 'idle';
    }

    this.jumped ||= SIDES.some((side) => Math.abs((reading.widths[side] ?? 0) - (last.widths[side] ?? 0)) >= JUMP);

    const grew = reading.widths.secondary !== null && last.widths.secondary !== null ? reading.widths.secondary - last.widths.secondary : 0;

    if (this.panel === null && grew >= JUMP) {
      this.panel = reading.widths.secondary;
      this.io.log(`The secondary jumped ${grew} pixels wider: not set until it jumps back, as a panel beside the editor makes it read wider.`);
    }


    const same = SIDES.every((side) => near(reading.widths[side], last.widths[side], 1)) && Math.abs(reading.editor.width - last.editor.width) <= 1;

    this.held = same ? this.held + 1 : 0;

    // A pane wider than the room the editor leaves is not in the primary side bar, as one moved to the panel. The readings held, so the
    // pane's report and the layout agree, and an editor at its minimum may report more than it has.
    if (this.held >= 1 && this.scales.has(reading.dpr) && !reading.editor.least && (reading.widths.primary ?? 0) + reading.editor.width > reading.room + CLOSE) {
      this.elsewhere = true;
      this.io.log('Stopped until the pane is hidden and shown again: the pane is wider than the room the editor leaves, so it is not in the primary side bar.');
      return 'idle';
    }

    if (this.resized) {
      if (this.held < RESIZED) {
        return 'idle';
      }

      this.resized = false;

      // A scale measured by this resize gives the side bars' widths now.
      if (this.learnScale(reading)) {
        const pane = this.io.pane();

        if (pane !== null) {
          return this.restore(this.read(pane, reading.editor));
        }
      }

      return this.restore(reading);
    }

    if (this.base === null) {
      if (this.held < 1) {
        return 'idle';
      }

      this.base = { widths: reading.widths, room: reading.room };
      this.jumped = false;
      return (await this.seed(reading)) ? 'learned' : 'idle';
    }

    return this.held < DRAGGED ? 'idle' : this.dragged(reading);
  }

  /** After a restore that stepped the primary, a pane whose width did not follow is not in the primary side bar. */
  private checkRestored(reading: Reading): void {
    const restored = this.restored;

    this.restored = null;

    // Only a restore that stepped the primary alone, in a window that held its width since, tells where the pane is.
    if (restored !== null && restored.steps !== 0 && reading.outer === restored.outer && reading.widths.primary !== null && Math.abs(reading.widths.primary - restored.primary) < STEP / 2) {
      this.elsewhere = true;
      this.io.log('Stopped until the pane is hidden and shown again: the pane did not follow the primary side bar\'s steps, so it is not in it.');
    }
  }

  /**
   * A resize the editor took whole, above its minimum with the primary unchanged, measures the scale: the editor's change over the pane's.
   * Both readings held, so the pane's report and the layout agree.
   */
  private learnScale(reading: Reading): boolean {
    const before = this.before;

    this.before = null;

    if (before === null || before.dpr !== reading.dpr || Math.abs(reading.outer - before.outer) < 50 || reading.editor.least || before.editor.least || reading.editor.groups !== before.editor.groups || reading.widths.primary !== before.widths.primary) {
      return false;
    }

    // A zoom level's scale is 1.2 to a whole or half power; one far from any, as a panel beside the editor that resized with the window makes,
    // is not a scale.
    const measured = (reading.editor.width - before.editor.width) / (reading.outer - before.outer);
    const level = Math.round(Math.log(measured) / Math.log(1.2) * 2) / 2;
    const scale = 1.2 ** level;

    if (Math.abs(measured - scale) > 0.01 * scale || Math.abs(level) > 9 || scale === this.scales.get(reading.dpr)) {
      return false;
    }

    // A ratio seen again after another may come from another zoom and display scale, so only the latest is kept.
    this.scales.clear();
    this.scales.set(reading.dpr, scale);
    this.io.log(`Measured ${scale.toFixed(3)} CSS pixels per window pixel at pixel ratio ${reading.dpr}.`);
    return true;
  }

  /** Keeps a point for each visible side bar that has none; resolves to whether it kept one. */
  private async seed(reading: Reading): Promise<boolean> {
    let kept = false;

    for (const side of SIDES) {
      if (reading.widths[side] !== null && (this.io.load().points[side] ?? []).length === 0) {
        await this.keep(side, reading.widths[side], reading, 'it had no width kept');
        kept = true;
      }
    }

    return kept;
  }

  /** Keeps a side bar's width as a point at the room now. */
  private async keep(side: Side, width: number, reading: Reading, why: string): Promise<void> {
    const room = Math.round(reading.room);
    const before = this.io.load().points[side] ?? [];
    const points = withPoint(before, { room, width, at: this.io.now() });
    const gone = before.filter((point) => !points.includes(point));
    const list = (some: Point[]) => some.map((point) => `${point.width} at ${point.room}`).join(', ');
    const replaced = gone.filter((point) => Math.abs(point.room - room) < BAND);
    const dropped = gone.filter((point) => !replaced.includes(point));

    await this.io.save(side, points);
    this.io.log(
      `Kept ${side} ${width} at a window room of ${room}: ${why}${replaced.length === 0 ? '' : `; replaced ${list(replaced)}`}${dropped.length === 0 ? '' : `; dropped ${list(dropped)}`}. Points: ${list(points)}.`,
    );
  }

  /**
   * The side bars held still in a window that did not change: a side bar that moved from its width was dragged, unless it was pushed or
   * shown, or a side bar jumped, as a panel opened beside the editor does.
   */
  private async dragged(reading: Reading): Promise<Outcome> {
    const base = this.base!.widths;
    let learned = false;

    if (this.jumped) {
      this.jumped = false;
      this.base = { widths: reading.widths, room: reading.room };
      return (await this.seed(reading)) ? 'learned' : 'idle';
    }

    for (const side of SIDES) {
      const width = reading.widths[side];
      const before = base[side];

      // A side bar shown again comes back at its own width; one that narrowed with the editor at its minimum was pushed by the other.
      if (width !== null && before !== null && Math.abs(width - before) > CLOSE && (width > before || !reading.editor.least)) {
        await this.keep(side, width, reading, `dragged from ${before}`);
        learned = true;
      } else if (width !== null && before === null && (this.io.load().points[side] ?? []).length === 0) {
        await this.keep(side, width, reading, 'shown with no width kept');
        learned = true;
      }
    }

    this.base = { widths: reading.widths, room: reading.room };

    return learned ? 'learned' : 'idle';
  }

  /**
   * Sets each visible side bar more than half a step from the width its points want, in steps of 60 pixels of the editor's width: the primary takes
   * or gives them, and the secondary while the primary is hidden for a moment. A side bar is widened only while the editor is above its
   * minimum. With several editor groups, which a step resizes one of, nothing is set.
   */
  private async restore(reading: Reading): Promise<Outcome> {
    const widen = !reading.editor.least;
    const wanted = wantedWidths(this.io.load(), reading.widths, reading.room);
    const steps = (side: Side): number => {
      const count = wanted[side] === null || reading.widths[side] === null ? 0 : stepsBetween(reading.widths[side], wanted[side].width);

      return count < 0 || widen ? count : 0;
    };
    const secondary = reading.editor.groups > 1 || this.panel !== null ? 0 : steps('secondary');
    const primary = reading.editor.groups > 1 ? 0 : steps('primary');

    this.base = null;

    const plan = SIDES.filter((side) => reading.widths[side] !== null)
      .map((side) => {
        const count = side === 'primary' ? primary : secondary;

        const want = wanted[side];

        return `${side} ${reading.widths[side]}${count === 0 ? '' : ` → ${reading.widths[side]! + count * STEP}`} (wanted ${want === null ? 'none' : `${want.width}, ${want.from}`})`;
      })
      .join(', ');

    if (secondary === 0 && primary === 0) {
      this.io.log(`Resized to a window room of ${Math.round(reading.room)}: nothing to set; ${plan}.`);
      return 'idle';
    }

    this.io.log(`Resized to a window room of ${Math.round(reading.room)}: setting ${plan}.`);

    // The primary first, so a primary squeezed to its minimum is above it when the focus is tested.
    await this.step(primary);

    const stepped = columns(await this.io.layout());

    if (secondary !== 0) {
      const shown = { ...reading, editor: stepped ?? reading.editor, widths: { ...reading.widths, primary: (reading.widths.primary ?? 0) + primary * STEP } };

      // The pane's report catches up with the primary's steps, so the focus test reads the primary's growth from its width now.
      for (let wait = 0; primary !== 0 && wait < 6 && Math.abs((this.io.pane()?.inner ?? 0) - (shown.widths.primary ?? 0)) > CLOSE; wait++) {
        await this.io.sleep(50);
      }

      await this.noteFocus(shown);
      await this.io.run(HIDE_PRIMARY);

      try {
        await this.step(secondary);
      } finally {
        await this.io.run(SHOW_PRIMARY);
        await this.returnFocus(reading.widths);
      }
    }

    this.cooldown = COOLDOWN;
    this.restored = { outer: reading.outer, primary: reading.widths.primary ?? 0, steps: secondary === 0 ? primary : 0 };
    this.last = null;

    return 'restored';
  }

  private async step(count: number): Promise<void> {
    for (let done = 0; done < Math.abs(count); done++) {
      // A narrower editor is a wider side bar.
      await this.io.run(count > 0 ? SHRINK_EDITOR : GROW_EDITOR);
    }
  }

  /** Runs one call at a time; a call during another does nothing. */
  private async once(work: () => Promise<Outcome>): Promise<Outcome> {
    if (this.busy) {
      return 'idle';
    }

    this.busy = true;

    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Notes what has the focus before a side bar is hidden, by growing the focused part one step and undoing it: the editor's width follows
   * with the focus in the editor, goes the other way with it in a side bar's own view, and holds with it in a webview or elsewhere; the
   * pane's width tells the primary from the secondary. A growth only the editor's minimum, or the primary's for an editor's growth, can cut
   * short, so with either near nothing is tested.
   */
  private async noteFocus(reading: Reading): Promise<void> {
    const before = reading.editor;
    if (before.groups > 1 || before.width < GROUP_MIN + STEP + CLOSE || (reading.widths.primary !== null && reading.widths.primary < MIN_WIDTH + STEP + CLOSE)) {
      this.focus = 'unknown';
      return;
    }

    const primary = this.io.pane()?.inner ?? null;

    await this.io.run(GROW_FOCUSED);

    const after = columns(await this.io.layout());

    // Undone even when no width moved, because a focused panel below the editor grows in height.
    if (after === null || after.sizes === before.sizes) {
      await this.io.run(SHRINK_FOCUSED);
      this.focus = 'other';
      return;
    }

    let grewPrimary = false;

    // A side bar's view grew: the pane's width says whether it was the primary.
    for (let wait = 0; after.width < before.width && primary !== null && wait < 6 && !grewPrimary; wait++) {
      grewPrimary = (this.io.pane()?.inner ?? primary) > primary + STEP / 2;

      if (!grewPrimary) {
        await this.io.sleep(50);
      }
    }

    await this.io.run(SHRINK_FOCUSED);
    this.focus = after.width > before.width ? 'editor' : grewPrimary ? 'primary' : 'secondary';
  }

  /** Hiding a side bar left the focus in the editor: puts it back in a side bar that had it, the secondary's for a webview's. */
  private async returnFocus(widths: Widths): Promise<void> {
    const focus = this.focus;

    this.focus = 'unknown';

    if (focus === 'primary' && widths.primary !== null) {
      await this.io.run(FOCUS_PRIMARY);
    } else if ((focus === 'other' || focus === 'secondary') && widths.secondary !== null) {
      await this.io.run(FOCUS_SECONDARY);
    }
  }
}

function near(a: number | null, b: number | null, within: number): boolean {
  return a === null || b === null ? a === b : Math.abs(a - b) <= within;
}
