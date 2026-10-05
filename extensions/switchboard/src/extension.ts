import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { hubBundlePath, hubLogPath } from '@switchboard/core';
import type { HubRecord } from '@switchboard/core';
import { buildOf, findHub, installBundle, keepHub, makeEnsure, openEvents, stopHub } from '@switchboard/hub';
import { startHub } from './hubProcess.js';
import { WorkItemsView, act, attach, claimOpen, openLink, openSession, openWorktree, setSource, startAdhoc } from './panel.js';
import { SettingsEditor } from './settingsEditor.js';
import { TOGGLED_SOURCES, sourceContexts } from './sources.js';
import { ROW_COMMANDS } from './webview/render.js';
import type { Snapshot } from '@switchboard/hub';

export interface SwitchboardApi {
  /** The hub this window is connected to, or null. */
  hub(): HubRecord | null;
  /** The last panel state the hub sent, or null. */
  state(): unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const shownToggles = new Map<string, string | undefined>();

/** Sets the context keys that pick each title-bar source toggle's on or off command, when they change. */
function showSourceToggles(snapshot: Snapshot): void {
  for (const [name, value] of Object.entries(sourceContexts(snapshot))) {
    if (!shownToggles.has(name) || shownToggles.get(name) !== value) {
      shownToggles.set(name, value);
      void vscode.commands.executeCommand('setContext', `switchboard.source.${name}`, value);
    }
  }
}

/** Open work items per playbook. */
function openPlaybooks(snapshot: Snapshot | null): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const item of snapshot?.workItems ?? []) {
    if (item.status !== 'done' && item.playbook !== null) {
      counts[item.playbook] = (counts[item.playbook] ?? 0) + 1;
    }
  }

  return counts;
}

export function activate(context: vscode.ExtensionContext): SwitchboardApi {
  // SWITCHBOARD_HOME points a window at another home, such as live acceptance's; the hub gets it as --home.
  const home = process.env['SWITCHBOARD_HOME'] || homedir();
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

  const view = new WorkItemsView(context.extensionUri);
  const settings = new SettingsEditor(context.extensionUri, home, () => openPlaybooks(view.state() as Snapshot | null));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WorkItemsView.id, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('switchboard.action', (action: unknown) => act(keeper.current(), action)),
    // A row's right-click menu passes the row's `data-vscode-context`, which holds the hub action for each command.
    ...Object.values(ROW_COMMANDS).map((key) =>
      vscode.commands.registerCommand(`switchboard.row.${key}`, (row: { actions: Record<string, unknown> }) => act(keeper.current(), row.actions[key])),
    ),
    vscode.commands.registerCommand('switchboard.attach', (shortId: string, name: string) => attach(shortId, name)),
    vscode.commands.registerCommand('switchboard.open', (sessionId: string, cwd: string) => openSession(keeper.current(), sessionId, cwd)),
    vscode.commands.registerCommand('switchboard.openLink', (target: string) => openLink(target)),
    vscode.commands.registerCommand('switchboard.openWorktree', (path: string) => openWorktree(path)),
    vscode.commands.registerCommand('switchboard.openSettings', () => void settings.show()),
    { dispose: () => settings.dispose() },
    vscode.commands.registerCommand('switchboard.newAdhoc', () => startAdhoc(keeper.current(), view.state() as Snapshot | null)),
    vscode.commands.registerCommand('switchboard.setSource', (name: string, enabled: boolean) => setSource(keeper.current(), name, enabled)),
    ...TOGGLED_SOURCES.flatMap((name) => [
      vscode.commands.registerCommand(`switchboard.source.${name}.on`, () => setSource(keeper.current(), name, false)),
      vscode.commands.registerCommand(`switchboard.source.${name}.off`, () => setSource(keeper.current(), name, true)),
    ]),
    vscode.commands.registerCommand('switchboard.claim', () => {
      const record = keeper.current();

      return record === null ? null : claimOpen(record);
    }),
    vscode.window.onDidChangeWindowState((state) => state.focused && void vscode.commands.executeCommand('switchboard.claim').then(undefined, () => {})),
  );

  const keeper = keepHub({
    ensure,
    open: (record, onEnd) =>
      openEvents(record, onEnd, undefined, (event, data) => {
        if (event === 'state') {
          view.update(data);
          showSourceToggles(JSON.parse(data) as Snapshot);
        } else if (event === 'hello') {
          void claimOpen(record).catch(() => {});
        }
      }),
    now: Date.now,
    sleep,
    onFailed: (message) => void vscode.window.showErrorMessage(`Switchboard: ${message}`),
  });

  context.subscriptions.push({ dispose: () => keeper.dispose() });

  return { hub: () => keeper.current(), state: () => view.state() };
}

export function deactivate(): void {}
