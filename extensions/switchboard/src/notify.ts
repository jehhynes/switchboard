import * as vscode from 'vscode';
import type { Snapshot } from '@switchboard/hub';
import { runOpen } from './panel.js';
import { NeedsYouTracker, toastOf } from './toast.js';
import { openAction } from '@switchboard/hub/rows';

/** Toasts each work item that starts needing the operator, in the focused window only (PRD R65). */
export class NeedsYouToasts {
  private readonly tracker = new NeedsYouTracker();

  /** `latest` is the panel's current snapshot, read when the operator presses Open. */
  constructor(private readonly latest: () => Snapshot | null) {}

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

      void vscode.window.showInformationMessage(toast.message, ...(toast.open ? ['Open'] : [])).then((choice) => {
        // The row may have changed while the toast was shown, such as a session that started running.
        const current = this.latest()?.workItems.find((candidate) => candidate.id === item.id) ?? item;
        const action = choice === 'Open' ? openAction(current) : null;

        return action === null ? undefined : runOpen(action as { type: string });
      });
    }
  }
}
