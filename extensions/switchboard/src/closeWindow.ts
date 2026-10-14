import * as vscode from 'vscode';
import type { DoneWindow } from './doneWindow.js';

const settings = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('switchboard');

const delayMs = (): number => {
  const minutes = settings().get<unknown>('closeDoneWindowsAfterMinutes');

  return (typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0 ? minutes : 30) * 60_000;
};

/** When this window closes itself (PRD R76), null when it does not. */
export function closeDueAt(window: DoneWindow): number | null {
  return settings().get<boolean>('closeDoneWindows', true) ? window.closeAt(delayMs()) : null;
}

/** Closes this window when its work is done (PRD R76), after recording a focus change; resolves to whether it asked VS Code to close. */
export async function closeIfDone(window: DoneWindow, focused?: boolean, now: number = Date.now()): Promise<boolean> {
  if (focused !== undefined) {
    window.focus(focused, now);
  }

  if (!settings().get<boolean>('closeDoneWindows', true)) {
    return false;
  }

  // Tabs cover text, notebook and custom editors; a document can also be dirty with no tab.
  const dirty = vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.isDirty)) || vscode.workspace.textDocuments.some((document) => document.isDirty);

  if (!window.close(dirty, now, delayMs())) {
    return false;
  }

  await vscode.commands.executeCommand('workbench.action.closeWindow');

  return true;
}
