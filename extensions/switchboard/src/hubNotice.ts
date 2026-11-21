import * as vscode from 'vscode';

/** The button of the warning that the hub did not answer; it runs Switchboard: Show Hub Log. */
export const SHOW_HUB_LOG = 'Show Hub Log';

/**
 * Warns why a request to the hub failed: with `reply` null, that the hub did not answer, with a Show Hub Log button; else the hub's refusal.
 * `outcome` says what the silence leaves, as in "the session stays where it is".
 */
export function warnHub(reply: { status: number; error?: string | null } | null, outcome?: string): void {
  if (reply !== null) {
    void vscode.window.showWarningMessage(`Switchboard: ${reply.error ?? `the hub answered ${reply.status}.`}`);
    return;
  }

  void vscode.window.showWarningMessage(`Switchboard: the hub did not answer${outcome === undefined ? '' : `, so ${outcome}`}.`, SHOW_HUB_LOG).then((choice) => {
    if (choice === SHOW_HUB_LOG) {
      void vscode.commands.executeCommand('switchboard.showHubLog');
    }
  });
}
