import type { HubRecord } from '@switchboard/core';
import { postToHub } from '@switchboard/hub';
import * as vscode from 'vscode';
import { warnHub } from './hubNotice.js';

/** The Claude Code extension's editor tab is a webview of this view type (mechanics M55). */
const CLAUDE_PANEL = 'claudeVSCodePanel';
/** The name Open in terminal gives its terminals (`openTerminal` in open.ts). */
const SWITCHBOARD_TERMINAL = 'Switchboard · ';
/** The hub reads Claude's roster, then the process table, each with a 15-second timeout, before it answers. */
const BACKGROUND_TIMEOUT_MS = 35_000;

const isClaude = (tab: vscode.Tab | undefined): tab is vscode.Tab => tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(CLAUDE_PANEL);

function claudeTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(isClaude);
}

/**
 * Why this window cannot close, or null (PRD R89). `label` is the Claude tab whose session moves, found by its label because VS Code hands out new
 * `Tab` objects as tabs change; null moves the session in the Claude sidebar, so no Claude tab may be open. Tabs cover text, notebook and custom
 * editors; a document can be dirty with no tab.
 */
export function closeRefusal(label: string | null): string | null {
  const tabs = claudeTabs();

  if (label === null && tabs.length > 0) {
    return 'Close the Claude tabs first; closing the window would end their sessions.';
  }

  if (label !== null && !tabs.some((tab) => tab.label === label)) {
    return 'Open the Claude tab to continue its session in the background.';
  }

  if (label !== null && tabs.length > 1) {
    return 'Close the other Claude tabs first; closing the window would end their sessions.';
  }

  const dirty = vscode.window.tabGroups.all.some((group) => group.tabs.some((other) => other.isDirty)) || vscode.workspace.textDocuments.some((document) => document.isDirty);

  if (dirty) {
    return 'Save or discard your changes first, so the window can close.';
  }

  // Open in terminal runs a session in such a terminal (PRD R28); the window's close would end it.
  return vscode.window.terminals.some((terminal) => terminal.name.startsWith(SWITCHBOARD_TERMINAL)) ? "Close Switchboard's terminal first; closing the window would end its session." : null;
}

/**
 * The hub's move, then its last check that the moving process is still the window's only Claude session, since a session opened in the window
 * meanwhile, such as in the sidebar, would end with it and only the hub sees the window's processes; or why the window stays open.
 */
async function answersOf(record: HubRecord, label: string | null, workItemIds: number[]): Promise<{ pid: number } | { refused: string } | { silent: string }> {
  const reply = await postToHub(record, '/background', { label, hostPid: process.pid, workItemIds }, BACKGROUND_TIMEOUT_MS);

  if (reply === null) {
    return { silent: 'the session stays where it is' };
  }

  const pid = (reply.body as { pid?: unknown } | null)?.pid;

  if (reply.status !== 200 || typeof pid !== 'number') {
    return { refused: reply.error ?? `the hub answered ${reply.status}.` };
  }

  const check = await postToHub(record, '/background/check', { hostPid: process.pid, pid }, BACKGROUND_TIMEOUT_MS);

  if (check?.status === 200 && (check.body as { alone?: unknown } | null)?.alone === true) {
    return { pid };
  }

  if (check === null) {
    return { silent: 'the window stays open' };
  }

  return {
    refused:
      check.status === 200
        ? 'Another Claude session started in this window while Switchboard answered, so the window stays open.'
        : `the window's sessions could not be checked, so the window stays open: ${check.error ?? `the hub answered ${check.status}`}.`,
  };
}

export interface BackgroundDeps {
  record: HubRecord | null;
  /** The IDs of this item window's work items; null in a window that is no work item's. */
  workItemIds: number[] | null;
}

/**
 * Continue in Background (PRD R89): the hub moves a Claude session of this window to its background process, then the window closes, which ends
 * the session's process (mechanics M55). `where` is the Claude tab in front, whose tab closes first, or the Claude sidebar, which has no tab, so
 * the hub takes the window's one Claude session. A refusal, here or from the hub, closes nothing.
 */
export async function continueInBackground(deps: BackgroundDeps, where: 'tab' | 'sidebar' = 'tab'): Promise<void> {
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  const refuse = (text: string) => void vscode.window.showWarningMessage(`Switchboard: ${text}`);

  if (where === 'tab' && !isClaude(active)) {
    refuse('Open the Claude tab to continue its session in the background.');
    return;
  }

  const label = where === 'tab' ? active!.label : null;
  const refusal = closeRefusal(label);

  if (refusal !== null) {
    refuse(refusal);
    return;
  }

  if (deps.workItemIds === null || deps.workItemIds.length === 0) {
    refuse("This session is not one of Switchboard's work items.");
    return;
  }

  if (deps.record === null) {
    warnHub(null, 'the session stays where it is');
    return;
  }

  // A Claude tab with the label that closes while the hub answers may be followed by another session's tab with the same label, which must stay.
  let closedMeanwhile = false;
  const watch = vscode.window.tabGroups.onDidChangeTabs((event) => {
    closedMeanwhile ||= label !== null && event.closed.some((tab) => isClaude(tab) && tab.label === label);
  });
  const answers = await answersOf(deps.record, label, deps.workItemIds).finally(() => watch.dispose());

  if ('silent' in answers) {
    warnHub(null, answers.silent);
    return;
  }

  if ('refused' in answers) {
    refuse(answers.refused);
    return;
  }

  if (closedMeanwhile) {
    refuse('The Claude tab closed while Switchboard answered, so nothing else closes; its session continues in the background.');
    return;
  }

  // The window may have changed while the hub answered; the hub keeps the session where it is unless its process ends.
  const changed = closeRefusal(label);

  if (changed !== null) {
    refuse(`${changed} The session stays where it is.`);
    return;
  }

  if (label !== null) {
    // The one Claude tab, which closeRefusal found by the label.
    const closed = await Promise.resolve(vscode.window.tabGroups.close(claudeTabs()[0]!)).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

    if (closed !== true) {
      refuse(`the Claude tab did not close, so the session stays in it${typeof closed === 'string' ? `: ${closed}` : '.'}`);
      return;
    }
  }

  // Hiding the sidebar leaves its session running; closing the window ends it (mechanics M55).
  await vscode.commands.executeCommand('workbench.action.closeWindow');
}
