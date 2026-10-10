import type { Snapshot } from '@switchboard/hub';
import { windowItems } from '@switchboard/hub';

const MID_TURN = new Set(['starting', 'running', 'waiting']);

/** Decides when an item window closes because its work is done (PRD R76). */
export class DoneWindow {
  /** The work items this window saw not done, so a window opened on done work never closes itself. */
  private readonly sawOpen = new Set<number>();
  private done = false;
  private closed = false;

  /** `file` is this window's workspace file, null for a window that is not an item window. */
  constructor(
    private readonly file: string | null,
    private readonly windows: string,
  ) {}

  update(snapshot: Snapshot): void {
    if (this.file === null) {
      return;
    }

    const items = windowItems(snapshot, this.file, this.windows);

    items.filter((item) => item.status !== 'done').forEach((item) => this.sawOpen.add(item.id));
    this.done =
      items.some((item) => this.sawOpen.has(item.id)) && items.every((item) => item.status === 'done' && !item.sessions.some((session) => MID_TURN.has(session.state)));
  }

  /** True once, when the window's work is done and the window is neither focused nor holding unsaved changes. */
  close(focused: boolean, dirty: boolean): boolean {
    if (!this.done || this.closed || focused || dirty) {
      return false;
    }

    this.closed = true;

    return true;
  }
}
