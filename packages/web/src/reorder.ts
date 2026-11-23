// Reordering Ready for review on the page (PRD R73), as the dock does: a row dragged to a new place, with a drop line where it will land, moves
// there on release; Escape, a cancelled pointer or a lost capture ends the drag without a move. A mouse or pen drags once it moves a few pixels
// up or down; a finger first holds still on the row, so a touch that moves at once still scrolls the list.

/** How far a mouse or pen moves up or down from its press before the press becomes a drag, as the dock's `DragStart`. */
export const DRAG_START_PX = 4;
/** How long a finger holds still on a row before the touch becomes a drag. */
export const HOLD_MS = 500;
/** How far a finger may move during the hold; further, and the touch is the list's scroll. */
export const HOLD_SLOP_PX = 10;
/** How long after a drag ends the click its release makes is dropped, so a drag never runs the row's click. */
const CLICK_AFTER_DRAG_MS = 600;

/** A Ready for review row where it is drawn: its work item and its top and height, in the pointer's coordinates. */
export interface DropRow {
  workItemId: number;
  top: number;
  height: number;
}

/** Where a drop lands: the work item to place after, or null for the top, and the row whose top edge, or the last row's bottom edge, the line marks. */
export interface Drop {
  after: number | null;
  edge: number;
  below: boolean;
}

/** What the list draws during a drag: the dragged row and the drop line, null while the pointer is where a release moves nothing. */
export interface DragView {
  dragging: number;
  drop: Drop | null;
}

/**
 * The drop a release at `y` makes for the dragged work item among Ready for review's `rows`, in list order: past the middle of a row is below it.
 * Null above the first row or below the last, and at the dragged row's own place, as the dock's `DropAt`.
 */
export function dropAt(rows: readonly DropRow[], dragged: number, y: number): Drop | null {
  const from = rows.findIndex((row) => row.workItemId === dragged);
  const last = rows.at(-1);

  if (from < 0 || last === undefined || y < rows[0]!.top || y > last.top + last.height) {
    return null;
  }

  const to = rows.filter((row) => row.top + row.height / 2 < y).length;

  if (to === from || to === from + 1) {
    return null;
  }

  return to === rows.length ? { after: last.workItemId, edge: last.workItemId, below: true } : { after: to === 0 ? null : rows[to - 1]!.workItemId, edge: rows[to]!.workItemId, below: false };
}

export interface RowDragDeps {
  /** The drag started, its drop changed or it ended (null). */
  changed(drag: DragView | null): void;
  /** A release placed the dragged work item after `after`, or first when null. */
  drop(workItemId: number, after: number | null): void;
  signal: AbortSignal;
}

export interface RowDrag {
  /** Works out the drop again from where the pointer last was, after the list redrew or scrolled under a still pointer. */
  refresh(): void;
}

/** Ready for review's rows, each a work item's select button (list.tsx), in list order. */
const REVIEW_ROWS = 'section[data-group="review"] .row[data-work-item]';

/** Drags Ready for review's rows in `list`, the page's list, until `deps.signal` aborts. */
export function rowDrag(list: HTMLElement, deps: RowDragDeps): RowDrag {
  const listen = { signal: deps.signal };
  let press: { pointerId: number; workItemId: number; x: number; y: number; touch: boolean; hold: ReturnType<typeof setTimeout> | undefined } | null = null;
  let drag: DragView | null = null;
  let at = { x: 0, y: 0 };
  let draggedAt = -Infinity;
  /** The pointer of a drag Escape ended, whose release, still to come, makes a click to drop. */
  let escaped: number | null = null;

  /** The drop at the pointer: none outside the list's visible part, over a group's pinned heading, or beside the rows. */
  const dropHere = (): Drop | null => {
    if (drag === null) {
      return null;
    }

    const box = list.getBoundingClientRect();
    const overHeading = [...list.querySelectorAll('.group-head')].some((head) => {
      const rect = head.getBoundingClientRect();

      return at.y >= rect.top && at.y < rect.bottom;
    });
    const buttons = [...list.querySelectorAll<HTMLElement>(REVIEW_ROWS)];
    const rects = buttons.map((button) => button.getBoundingClientRect());
    const first = rects[0];

    if (first === undefined || overHeading || at.y < box.top || at.y > box.bottom || at.x < first.left || at.x > first.right) {
      return null;
    }

    return dropAt(
      buttons.map((button, index) => ({ workItemId: Number(button.dataset['workItem']), top: rects[index]!.top, height: rects[index]!.height })),
      drag.dragging,
      at.y,
    );
  };
  const show = (): void => {
    if (drag === null) {
      return;
    }

    const drop = dropHere();

    if (drop?.after !== drag.drop?.after || drop?.edge !== drag.drop?.edge || drop?.below !== drag.drop?.below) {
      drag = { dragging: drag.dragging, drop };
      deps.changed(drag);
    }
  };
  const begin = (): void => {
    if (press === null) {
      return;
    }

    clearTimeout(press.hold);
    drag = { dragging: press.workItemId, drop: null };
    list.classList.add('reordering');

    try {
      list.setPointerCapture?.(press.pointerId);
    } catch {
      // The pointer is already up; its release or cancel ends the drag.
    }

    deps.changed(drag);
    show();
  };
  /** Ends the press or drag without a move; `released` when a release that makes a click comes or came with it, which is then dropped. */
  const end = (released: boolean): void => {
    const pointerId = press?.pointerId;

    clearTimeout(press?.hold);
    press = null;

    if (drag === null) {
      return;
    }

    drag = null;
    draggedAt = released ? Date.now() : -Infinity;
    list.classList.remove('reordering');

    if (pointerId !== undefined && list.hasPointerCapture?.(pointerId) === true) {
      list.releasePointerCapture(pointerId);
    }

    deps.changed(null);
  };

  list.addEventListener(
    'pointerdown',
    (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>(REVIEW_ROWS) : null;

      // A new press anywhere in the list is not the release of an earlier drag.
      draggedAt = -Infinity;
      escaped = null;

      if (press !== null || drag !== null || event.button !== 0 || button === null || !list.contains(button)) {
        return;
      }

      const touch = event.pointerType === 'touch';

      press = { pointerId: event.pointerId, workItemId: Number(button.dataset['workItem']), x: event.clientX, y: event.clientY, touch, hold: touch ? setTimeout(begin, HOLD_MS) : undefined };
      at = { x: event.clientX, y: event.clientY };
    },
    listen,
  );
  list.addEventListener(
    'pointermove',
    (event) => {
      if (press === null || event.pointerId !== press.pointerId) {
        return;
      }

      at = { x: event.clientX, y: event.clientY };

      if (drag !== null) {
        show();
      } else if (press.touch) {
        // A finger that moves before the hold is scrolling the list.
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > HOLD_SLOP_PX) {
          end(false);
        }
      } else if ((event.buttons & 1) === 0) {
        end(false);
      } else if (Math.abs(event.clientY - press.y) > DRAG_START_PX) {
        begin();
      }
    },
    listen,
  );
  list.addEventListener(
    'pointerup',
    (event) => {
      if (press === null && event.pointerId === escaped) {
        escaped = null;
        draggedAt = Date.now();
      }

      if (press === null || event.pointerId !== press.pointerId) {
        return;
      }

      at = { x: event.clientX, y: event.clientY };

      const workItemId = drag?.dragging;
      const drop = dropHere();

      end(true);

      if (workItemId !== undefined && drop !== null) {
        deps.drop(workItemId, drop.after);
      }
    },
    listen,
  );
  // The browser took the touch for a scroll, or another window took the pointer, so no release comes. Only the list's own capture counts: the
  // row's implicit touch capture, which `begin` moves to the list, is lost too, and bubbles here.
  list.addEventListener(
    'pointercancel',
    (event) => {
      escaped = event.pointerId === escaped ? null : escaped;

      if (event.pointerId === press?.pointerId) {
        end(false);
      }
    },
    listen,
  );
  list.addEventListener('lostpointercapture', (event) => drag !== null && event.target === list && event.pointerId === press?.pointerId && end(false), listen);
  // A dragging finger moves the row, not the list; non-passive, so the browser waits for it before it scrolls.
  list.addEventListener('touchmove', (event) => drag !== null && event.cancelable && event.preventDefault(), { ...listen, passive: false });
  // A held finger would open the browser's menu for the row.
  list.addEventListener('contextmenu', (event) => press?.touch === true && event.preventDefault(), listen);
  // The release that ends a drag makes a click, on the row or the list; it is not the row's click.
  list.addEventListener(
    'click',
    (event) => {
      if (Date.now() - draggedAt < CLICK_AFTER_DRAG_MS) {
        draggedAt = -Infinity;
        event.preventDefault();
        event.stopPropagation();
      }
    },
    { ...listen, capture: true },
  );
  list.addEventListener('scroll', () => show(), { ...listen, passive: true });
  // Before the page's own Escape, which would close a drawer or a menu instead.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && drag !== null) {
        event.preventDefault();
        event.stopImmediatePropagation();
        // The mouse button or finger is still down, and its release, whenever it comes, clicks.
        escaped = press?.pointerId ?? null;
        end(false);
      }
    },
    { ...listen, capture: true },
  );
  deps.signal.addEventListener('abort', () => clearTimeout(press?.hold));

  return { refresh: show };
}
