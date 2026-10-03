import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { hubBundlePath, hubLogPath } from '@switchboard/core';
import type { HubRecord } from '@switchboard/core';
import { buildOf, findHub, installBundle, keepHub, makeEnsure, openEvents, stopHub } from '@switchboard/hub';
import { startHub } from './hubProcess.js';

export interface SwitchboardApi {
  /** The hub this window is connected to, or null. */
  hub(): HubRecord | null;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export function activate(context: vscode.ExtensionContext): SwitchboardApi {
  const home = homedir();
  const bundle = hubBundlePath(home);

  installBundle(context.asAbsolutePath('dist/hub.js'), bundle);

  // A hub from another build, such as one started before this extension was updated, is replaced.
  const ensure = makeEnsure({
    find: () => findHub(home),
    build: () => buildOf(bundle),
    stop: stopHub,
    start: () => startHub(bundle, home),
    now: Date.now,
    sleep,
    logPath: hubLogPath(home),
  });

  const keeper = keepHub({
    ensure,
    open: (record, onEnd) => openEvents(record, onEnd),
    now: Date.now,
    sleep,
    onFailed: (message) => void vscode.window.showErrorMessage(`Switchboard: ${message}`),
  });

  context.subscriptions.push({ dispose: () => keeper.dispose() });

  return { hub: () => keeper.current() };
}

export function deactivate(): void {}
