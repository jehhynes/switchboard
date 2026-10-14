import type { Snapshot } from '@switchboard/hub';
import { windowItems } from '@switchboard/hub';

const MID_TURN = new Set(['starting', 'running', 'waiting']);

/** Decides when an item window closes because its work is done (PRD R76). */
export class DoneWindow {
  /** The work items this window saw not done, so a window opened on done work never closes itself. */
  private readonly sawOpen = new Set<number>();
  /** When the window's work became done, null while it is not done. */
  private doneAt: number | null = null;
  /** When the window lost focus, null while it is focused. */
  private blurredAt: number | null;
  private closed = false;

  /** `file` is this window's workspace file, null for a window that is not an item window. */
  constructor(
    private readonly file: string | null,
    private readonly windows: string,
    focused: boolean,
    now: number,
  ) {
    this.blurredAt = focused ? null : now;
  }

  update(snapshot: Snapshot, now: number): void {
    if (this.file === null) {
      return;
    }

    const items = windowItems(snapshot, this.file, this.windows);

    items.filter((item) => item.status !== 'done').forEach((item) => this.sawOpen.add(item.id));

    const done =
      items.some((item) => this.sawOpen.has(item.id)) && items.every((item) => item.status === 'done' && !item.sessions.some((session) => MID_TURN.has(session.state)));

    this.doneAt = done ? (this.doneAt ?? now) : null;
  }

  focus(focused: boolean, now: number): void {
    this.blurredAt = focused ? null : (this.blurredAt ?? now);
  }

  /** When the window closes: `delayMs` after its work is done and it lost focus, both still true; null while either is not, or once closed. */
  closeAt(delayMs: number): number | null {
    return this.closed || this.doneAt === null || this.blurredAt === null ? null : Math.max(this.doneAt, this.blurredAt) + delayMs;
  }

  /** True once, when `closeAt` has passed and the window holds no unsaved changes. */
  close(dirty: boolean, now: number, delayMs: number): boolean {
    const at = this.closeAt(delayMs);

    if (at === null || now < at || dirty) {
      return false;
    }

    this.closed = true;

    return true;
  }
}
