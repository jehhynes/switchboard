import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { switchboardHome } from '@switchboard/core';
import type { HubRecord } from '@switchboard/core';
import { postToHub } from '@switchboard/hub';

/** Where `npm run publish --workspace @switchboard/dock` puts the dock: `<Switchboard home>/dock/Switchboard.Dock`, with `.exe` on Windows. */
export function dockPath(home: string, platform: NodeJS.Platform = process.platform): string {
  return join(switchboardHome(home), 'dock', platform === 'win32' ? 'Switchboard.Dock.exe' : 'Switchboard.Dock');
}

/** Starts the dock on the window's home; it outlives the window. */
function startDock(path: string, home: string): void {
  // The dock starts Code.exe, which would run as Node with these.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ELECTRON_|VSCODE_)/i.test(name)));

  const child = spawn(path, ['--home', home], { detached: true, stdio: 'ignore', env });

  child.on('error', (error) => void vscode.window.showErrorMessage(`Switchboard: the dock did not start: ${error.message}`));
  child.unref();
}

/**
 * The status bar item's click (PRD R71): the running dock comes forward; with no dock connected to the hub, the installed dock is started.
 * Resolves to what happened.
 */
export async function showDock(record: HubRecord | null, home: string, start: (path: string, home: string) => void = startDock): Promise<'shown' | 'started' | 'missing'> {
  if (record !== null && (await postToHub(record, '/dock/show', {}, 5_000))?.status === 200) {
    return 'shown';
  }

  const path = dockPath(home);

  if (!existsSync(path)) {
    void vscode.window.showWarningMessage(`Switchboard: the dock is not installed at ${path}.`);
    return 'missing';
  }

  start(path, home);

  return 'started';
}
