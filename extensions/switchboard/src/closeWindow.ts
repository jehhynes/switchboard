import * as vscode from 'vscode';
import type { DoneWindow } from './doneWindow.js';

/** Closes this window when its work is done (PRD R76); resolves to whether it asked VS Code to close. */
export async function closeIfDone(window: DoneWindow, focused: boolean = vscode.window.state.focused): Promise<boolean> {
  if (!vscode.workspace.getConfiguration('switchboard').get<boolean>('closeDoneWindows', true)) {
    return false;
  }

  // Tabs cover text, notebook and custom editors; a document can also be dirty with no tab.
  const dirty = vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.isDirty)) || vscode.workspace.textDocuments.some((document) => document.isDirty);

  if (!window.close(focused, dirty)) {
    return false;
  }

  await vscode.commands.executeCommand('workbench.action.closeWindow');

  return true;
}
