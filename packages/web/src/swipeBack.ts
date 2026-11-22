// Swipe right to go back on a phone (architecture.md § Web page): a touch that pans right over the conversation drags it off to the right with
// the work items' list showing under it, as iOS's own navigation does, and on release either goes back, as the Back button does, or snaps back.
// iOS can draw its own history gesture from the edge, so the page leaves that touch to the browser when it has earlier history.

/** A touch that starts this close to the screen's left edge, in CSS pixels, may belong to iOS's history gesture. */
export const EDGE_PX = 24;
/** How far a touch moves before its direction is read, so a tap or a still finger never starts a swipe. */
export const SLOP_PX = 10;
/** Away from the edge, a pan is a swipe only while it moves right at least this many times as far as up or down. */
export const PAN_RATIO = 1.5;
/** A release past this share of the width goes back, unless the finger was flicking left. */
export const COMPLETE_SHARE = 1 / 3;
/** A release moving right at least this fast, in pixels per millisecond, goes back wherever it is; one moving left as fast snaps back. */
export const FLING_SPEED = 0.5;
/** The finger's speed at release is read over its last this many milliseconds. */
export const SPEED_WINDOW_MS = 100;
/** How far the list sits to the left under the conversation at the swipe's start, as a share of the width, and how dark it starts. */
export const LIST_SHIFT = 0.3;
export const LIST_SHADE = 0.2;

/** Never a swipe: a touch in a text field, a menu, a sheet, a sash or a frame, where the touch belongs to the control. */
const CONTROLS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .sash, .menu, [role="menu"], [role="listbox"], .sheet-backdrop, iframe, video, audio';
/** A swipe only from the edge: a touch in a pane that pans sideways itself, as code, a table, a diff or the console does. */
const SIDEWAYS = '.diff-host, .console';

/** How a touch can start a swipe: from the edge, as a pan anywhere else, or not at all. */
export type SwipeStart = 'edge' | 'pan' | null;

/** Whether iOS may show its own history preview for a left-edge swipe. */
export function browserBackPreview(userAgent: string, platform: string, touchPoints: number, historyLength: number): boolean {
  // The page cannot inspect the back-stack position; more than one entry means WebKit may have a preview to show.
  return historyLength > 1 && (/iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && touchPoints > 1));
}

/**
 * How a touch at `x` on the elements of `path` (innermost first, as `composedPath` gives them) can start a swipe: never in a control or from an
 * edge handled by the browser; otherwise from the edge, or away from it only outside a pane that scrolls sideways and while no text is
 * selected, so a pan there scrolls it and a drag selects. Elements outside `host` are not looked at.
 */
export function swipeStart(x: number, path: readonly EventTarget[], host: Element, selecting = false, nativeEdgeBack = false): SwipeStart {
  const edge = x <= EDGE_PX;

  if (edge && nativeEdgeBack) {
    return null;
  }

  let sideways = false;

  for (const target of path) {
    if (target === host) {
      break;
    }

    if (!(target instanceof Element)) {
      continue;
    }

    if (target.matches(CONTROLS)) {
      return null;
    }

    sideways ||= target.matches(SIDEWAYS) || scrollsSideways(target);
  }

  return edge ? 'edge' : sideways || selecting ? null : 'pan';
}

/** Whether an element scrolls sideways: wider inside than its box, with `overflow-x` that scrolls. */
function scrollsSideways(element: Element): boolean {
  if (element.scrollWidth <= element.clientWidth + 1) {
    return false;
  }

  const overflow = getComputedStyle(element).overflowX;

  return overflow === 'auto' || overflow === 'scroll';
}

/** What a move does to a touch being followed: still deciding, dragging the conversation, or never a swipe. */
export type SwipeMove = 'pending' | 'drag' | 'cancel';

/**
 * One touch followed from its start: it decides once, past `SLOP_PX`, whether it is a swipe (right, and horizontal enough for how it started)
 * or not, and as a swipe gives the conversation's offset and whether a release goes back.
 */
export class SwipeTracker {
  #state: SwipeMove = 'pending';
  #samples: { x: number; t: number }[] = [];

  constructor(
    readonly start: 'edge' | 'pan',
    readonly x0: number,
    readonly y0: number,
    t: number,
  ) {
    this.#samples.push({ x: x0, t });
  }

  get state(): SwipeMove {
    return this.#state;
  }

  /** How far right the conversation is dragged, never left of where it started. */
  get offset(): number {
    return this.#state === 'drag' ? Math.max(0, this.#samples.at(-1)!.x - this.x0) : 0;
  }

  move(x: number, y: number, t: number): SwipeMove {
    if (this.#state === 'cancel') {
      return 'cancel';
    }

    if (this.#state === 'pending') {
      const dx = x - this.x0;
      const dy = Math.abs(y - this.y0);

      if (Math.max(Math.abs(dx), dy) < SLOP_PX) {
        return 'pending';
      }

      // From the edge a pan more right than up or down is a swipe, as iOS's; elsewhere it must be clearly horizontal, so scrolling wins.
      const right = dx >= SLOP_PX && dx > dy * (this.start === 'edge' ? 1 : PAN_RATIO);

      this.#state = right ? 'drag' : 'cancel';

      if (!right) {
        return 'cancel';
      }
    }

    this.#samples.push({ x, t });

    while (this.#samples.length > 2 && t - this.#samples[0]!.t > SPEED_WINDOW_MS) {
      this.#samples.shift();
    }

    return 'drag';
  }

  /** The finger's speed to the right at `t`, in pixels per millisecond, over its last `SPEED_WINDOW_MS`; 0 once it has rested that long. */
  speed(t: number): number {
    const last = this.#samples.at(-1)!;
    const first = this.#samples.find((sample) => last.t - sample.t <= SPEED_WINDOW_MS) ?? last;

    return t - last.t > SPEED_WINDOW_MS || last.t === first.t ? 0 : (last.x - first.x) / (last.t - first.t);
  }

  /** Whether a release at `t` goes back on a page `width` wide: a flick right, or past a third of the width unless flicking left. */
  completes(t: number, width: number): boolean {
    if (this.#state !== 'drag') {
      return false;
    }

    const speed = this.speed(t);

    return speed >= FLING_SPEED || (this.offset >= width * COMPLETE_SHARE && speed > -FLING_SPEED);
  }
}

export interface SwipeBackOptions {
  /** The page's root, which holds `.swiping` while a swipe shows the list. */
  root: HTMLElement;
  /** The conversation, which takes the touches and moves. */
  host: HTMLElement;
  /** The list, shown under the conversation while it moves. */
  under: HTMLElement;
  /** Whether a touch starting now may swipe: a phone's conversation with nothing over it. */
  enabled(): boolean;
  /** Goes back to the list, as the Back button does. */
  back(): void;
  /** Whether the operator asked for less motion: the list does not slide and a release lands at once. */
  reducedMotion(): boolean;
  /** Whether the browser handles a back swipe from the left edge itself. */
  nativeEdgeBack?(): boolean;
  now?(): number;
  frame?(callback: () => void): void;
}

/** How long a release takes to land, in milliseconds, at the least and the most. */
const SETTLE_MIN_MS = 120;
const SETTLE_MAX_MS = 300;

/** Follows touches on the conversation and drags it back to the list (`SwipeTracker`); returns a function that stops listening. */
export function swipeBack(options: SwipeBackOptions): () => void {
  const { root, host, under } = options;
  const now = options.now ?? (() => performance.now());
  const frame = options.frame ?? ((callback: () => void) => requestAnimationFrame(callback));
  const listening = new AbortController();
  let tracker: SwipeTracker | null = null;
  let shade: HTMLElement | null = null;
  let width = 0;
  let drawing = false;
  let settling: ReturnType<typeof setTimeout> | null = null;

  const paint = (offset: number, ease: number): void => {
    const share = width === 0 ? 1 : Math.min(1, offset / width);
    const transition = ease > 0 ? `transform ${ease}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : '';

    host.style.transition = transition;
    under.style.transition = transition;
    host.style.transform = `translate3d(${offset}px, 0, 0)`;
    under.style.transform = options.reducedMotion() ? '' : `translate3d(${-LIST_SHIFT * width * (1 - share)}px, 0, 0)`;
    shade!.style.transition = ease > 0 ? `opacity ${ease}ms linear` : '';
    shade!.style.opacity = String(LIST_SHADE * (1 - share));
  };
  const begin = (): void => {
    width = host.getBoundingClientRect().width || window.innerWidth;
    shade?.remove();
    shade = document.createElement('div');
    shade.className = 'swipe-shade';
    shade.setAttribute('aria-hidden', 'true');
    root.append(shade);
    root.classList.add('swiping');
    // The list shows where Back leaves it: on the selected row, as its focus scrolls it into view.
    const row = under.querySelector<HTMLElement>('.row.selected');
    const list = row?.closest<HTMLElement>('#list');

    if (row != null && list != null) {
      const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
      const bottom = top + row.getBoundingClientRect().height;

      if (top < 0 || bottom > list.clientHeight) {
        list.scrollTop += top < 0 ? top : bottom - list.clientHeight;
      }
    }

    paint(0, 0);
  };
  const finish = (complete: boolean): void => {
    if (settling !== null) {
      clearTimeout(settling);
      settling = null;
    }

    // Back draws the list first, so the conversation never shows again in between.
    if (complete) {
      options.back();
    }

    for (const element of [host, under]) {
      element.style.transition = '';
      element.style.transform = '';
    }

    shade?.remove();
    shade = null;
    root.classList.remove('swiping');
  };
  const settle = (complete: boolean, speed: number): void => {
    const offset = tracker?.offset ?? 0;

    tracker = null;

    if (options.reducedMotion()) {
      finish(complete);
      return;
    }

    const distance = complete ? width - offset : offset;
    const ms = Math.round(Math.min(SETTLE_MAX_MS, Math.max(SETTLE_MIN_MS, distance / Math.max(Math.abs(speed), 1))));

    paint(complete ? width : 0, ms);
    settling = setTimeout(() => finish(complete), ms + 20);
  };
  const drop = (): void => {
    if (tracker?.state === 'drag') {
      settle(false, 0);
    }

    tracker = null;
    touching?.abort();
    touching = null;
  };
  /** The listeners on the touched element for this touch, which keep the swipe going when a redraw takes that element out of the conversation. */
  let touching: AbortController | null = null;
  /** The last event handled, which reaches both the touched element and the conversation while the element is still in it. */
  let handled: Event | null = null;
  const move = (event: TouchEvent): void => {
    if (tracker === null || event === handled) {
      return;
    }

    handled = event;

    if (event.touches.length !== 1) {
      drop();
      return;
    }

    const touch = event.touches[0]!;
    const was = tracker.state;
    const state = tracker.move(touch.clientX, touch.clientY, now());

    // A move the browser no longer lets the page cancel means it is already scrolling: the touch is the scroll's.
    if (state === 'cancel' || (state === 'drag' && was !== 'drag' && !event.cancelable)) {
      tracker = null;
      return;
    }

    if (state !== 'drag') {
      return;
    }

    if (event.cancelable) {
      event.preventDefault();
    }

    if (was !== 'drag') {
      begin();
    }

    if (!drawing) {
      drawing = true;
      frame(() => {
        drawing = false;

        if (tracker?.state === 'drag') {
          paint(tracker.offset, 0);
        }
      });
    }
  };
  const end = (event: Event): void => {
    if (event === handled) {
      return;
    }

    handled = event;
    touching?.abort();
    touching = null;

    if (tracker?.state !== 'drag') {
      tracker = null;
      return;
    }

    const t = now();

    settle(tracker.completes(t, width), tracker.speed(t));
  };
  const cancel = (event: Event): void => {
    if (event !== handled) {
      handled = event;
      drop();
    }
  };

  host.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1) {
        drop();
        return;
      }

      if (settling !== null || !options.enabled()) {
        return;
      }

      const touch = event.touches[0]!;
      const selection = document.getSelection();
      const start = swipeStart(touch.clientX, event.composedPath(), host, selection !== null && !selection.isCollapsed, options.nativeEdgeBack?.());

      tracker = start === null ? null : new SwipeTracker(start, touch.clientX, touch.clientY, now());
      touching?.abort();
      touching = null;

      if (tracker !== null && event.target instanceof Node && event.target !== host) {
        // Touch events go to the element first touched even once it has left the page.
        touching = new AbortController();
        event.target.addEventListener('touchmove', move as EventListener, { passive: false, signal: touching.signal });
        event.target.addEventListener('touchend', end, { signal: touching.signal });
        event.target.addEventListener('touchcancel', cancel, { signal: touching.signal });
      }
    },
    { passive: true, signal: listening.signal },
  );
  // Not passive: once a touch is a swipe its moves stop the page from scrolling under it.
  host.addEventListener('touchmove', move, { passive: false, signal: listening.signal });
  host.addEventListener('touchend', end, { signal: listening.signal });
  host.addEventListener('touchcancel', cancel, { signal: listening.signal });

  return () => {
    listening.abort();
    touching?.abort();
    touching = null;

    if (tracker?.state === 'drag' || settling !== null) {
      finish(false);
    }

    tracker = null;
  };
}
