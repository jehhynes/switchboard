import * as vscode from 'vscode';
import type { Snapshot } from '@switchboard/hub';
import { NeedsYouTracker, toastOf } from './toast.js';

/** Toasts each work item that starts needing the operator, in the focused window only (PRD R65). */
export class NeedsYouToasts {
  private readonly tracker = new NeedsYouTracker();

  /** `open` runs the click of the work item's row when the operator presses Open. */
  constructor(private readonly open: (workItemId: number) => Promise<unknown>) {}

  connected(): void {
    this.tracker.connected();
  }

  update(snapshot: Snapshot): void {
    const items = this.tracker.update(snapshot);

    // Every window gets the snapshot, so only the focused one toasts.
    if (items.length === 0 || !vscode.window.state.focused || !vscode.workspace.getConfiguration('switchboard').get<boolean>('notifyNeedsYou', true)) {
      return;
    }

    for (const item of items) {
      const toast = toastOf(item);

      void vscode.window.showInformationMessage(toast.message, ...(toast.open ? ['Open'] : [])).then((choice) => (choice === 'Open' ? this.open(item.id) : undefined));
    }
  }
}
