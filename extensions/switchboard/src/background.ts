import type { HubRecord } from '@switchboard/core';
import { postToHub } from '@switchboard/hub';
import * as vscode from 'vscode';

/** The Claude Code extension's editor tab is a webview of this view type (mechanics M55). */
const CLAUDE_PANEL = 'claudeVSCodePanel';
/** The hub reads Claude's roster, then the process table, each with a 15-second timeout, before it answers. */
const BACKGROUND_TIMEOUT_MS = 35_000;

const isClaude = (tab: vscode.Tab | undefined): tab is vscode.Tab => tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(CLAUDE_PANEL);

function claudeTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(isClaude);
}

/**
 * Why this window cannot close once its Claude tab labelled `label` does, or null (PRD R89). VS Code hands out new `Tab` objects as tabs change,
 * so the tab is found by its label. Tabs cover text, notebook and custom editors; a document can be dirty with no tab.
 */
export function closeRefusal(label: string): string | null {
  const tabs = claudeTabs();

  if (!tabs.some((tab) => tab.label === label)) {
    return 'Open the Claude tab to continue its session in the background.';
  }

  if (tabs.length > 1) {
    return 'Close the other Claude tabs first; closing the window would end their sessions.';
  }

  const dirty = vscode.window.tabGroups.all.some((group) => group.tabs.some((other) => other.isDirty)) || vscode.workspace.textDocuments.some((document) => document.isDirty);

  return dirty ? 'Save or discard your changes first, so the window can close.' : null;
}

export interface BackgroundDeps {
  record: HubRecord | null;
  /** The IDs of this item window's work items; null in a window that is no work item's. */
  workItemIds: number[] | null;
}

/**
 * Continue in Background (PRD R89): the hub moves the active Claude tab's session to its background process, then this window closes the tab,
 * which ends the tab's process (mechanics M55), and itself. A refusal, here or from the hub, closes nothing.
 */
export async function continueInBackground(deps: BackgroundDeps): Promise<void> {
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  const refuse = (text: string) => void vscode.window.showWarningMessage(`Switchboard: ${text}`);

  if (!isClaude(active)) {
    refuse('Open the Claude tab to continue its session in the background.');
    return;
  }

  const label = active.label;
  const refusal = closeRefusal(label);

  if (refusal !== null) {
    refuse(refusal);
    return;
  }

  if (deps.workItemIds === null || deps.workItemIds.length === 0) {
    refuse("This tab's session is not one of Switchboard's work items.");
    return;
  }

  const reply = deps.record === null ? null : await postToHub(deps.record, '/background', { label, hostPid: process.pid, workItemIds: deps.workItemIds }, BACKGROUND_TIMEOUT_MS);

  if (reply === null) {
    void vscode.window.showErrorMessage('Switchboard: the hub did not answer, so the session stays in its tab.');
    return;
  }

  if (reply.status !== 200) {
    refuse(reply.error ?? `the hub answered ${reply.status}.`);
    return;
  }

  // The window may have changed while the hub answered; the hub keeps the session where it is unless the tab's process ends.
  const changed = closeRefusal(label);

  if (changed !== null) {
    refuse(`${changed} The session stays in its tab.`);
    return;
  }

  // The one Claude tab, which closeRefusal found by the label.
  const closed = await Promise.resolve(vscode.window.tabGroups.close(claudeTabs()[0]!)).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

  if (closed !== true) {
    refuse(`the Claude tab did not close, so the session stays in it${typeof closed === 'string' ? `: ${closed}` : '.'}`);
    return;
  }

  await vscode.commands.executeCommand('workbench.action.closeWindow');
}
