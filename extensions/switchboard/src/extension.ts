import { homedir } from 'node:os';
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import { hubBundlePath, hubLogPath, resolveConfigDir, switchboardHome } from '@switchboard/core';
import type { HubRecord } from '@switchboard/core';
import { buildOf, findHub, installBundle, keepHub, makeEnsure, openEvents, stopHub } from '@switchboard/hub';
import { showDock } from './dockApp.js';
import { openChanges } from './git.js';
import { HistoryPanels } from './historyPanel.js';
import type { HistoryMessage } from './historyPanel.js';
import { startHub } from './hubProcess.js';
import { needsStatus } from './needs.js';
import { NeedsYouToasts } from './notify.js';
import { claimOpen, openLink, openRow, openSession, openTarget, openUri } from './open.js';
import type { OpenContext, OpenResult, WindowCommand } from './open.js';
import { HubState } from './state.js';

export interface SwitchboardApi {
  /** The hub this window is connected to, or null. */
  hub(): HubRecord | null;
  /** The last snapshot the hub sent, or null. */
  state(): unknown;
  /** Shows a state as if the hub sent it, so the integration suite can use recorded snapshots. */
  show(state: string): void;
  /** The status bar item's text and tooltip (PRD R64). */
  status(): { text: string; tooltip: string | undefined };
  /** What each open History tab shows (PRD R59). */
  historyTabs(): { ticketId: number; title: string; shown: string | null; error: string | null }[];
  /** Restores a History tab from a page's saved state, as VS Code does after a reload. */
  restoreHistory(state: unknown): Promise<void>;
  /** Runs the URI handler, which the integration suite cannot reach through the OS (PRD R69); resolves to the row's key. */
  openUri(uri: vscode.Uri, waitMs?: number): Promise<string | null>;
  /** Runs a row's click against `hub`, by default the connected one, as a notification's Open does (PRD R65, R71). */
  openRow(key: string, options?: { hub?: HubRecord; waitMs?: number }): Promise<OpenResult>;
  /** Claims what the dock left for this window from a hub, as focus or a connection does, and runs it (PRD R71). */
  claim(hub: HubRecord): Promise<string | null>;
  /** Runs a command the dock leaves for a window: Open Changes, History or Open report (PRD R71). */
  run(command: WindowCommand): Promise<unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export function activate(context: vscode.ExtensionContext): SwitchboardApi {
  // SWITCHBOARD_HOME points a window at another home, such as live acceptance's; the hub gets it as --home.
  const home = process.env['SWITCHBOARD_HOME'] || homedir();
  const bundle = hubBundlePath(home);
  // Read on every use, so all windows follow the current setting and never replace each other's hub.
  const configDir = (): string => {
    // An overridden home is for isolation, so it ignores a config folder that would hold the operator's own settings.
    const setting = process.env['SWITCHBOARD_HOME'] ? '' : vscode.workspace.getConfiguration('switchboard').get<string>('configDir', '');
    const resolved = resolveConfigDir(setting, home, homedir());

    return 'dir' in resolved ? resolved.dir : resolve(switchboardHome(home));
  };
  const reportConfigError = (): void => {
    const resolved = resolveConfigDir(vscode.workspace.getConfiguration('switchboard').get<string>('configDir', ''), home, homedir());

    if ('error' in resolved && !process.env['SWITCHBOARD_HOME']) {
      void vscode.window.showErrorMessage(`Switchboard: ${resolved.error}. Using ${configDir()}.`);
    }
  };

  reportConfigError();
  installBundle(context.asAbsolutePath('dist/hub.js'), bundle);

  // A hub from another build or config folder, such as one started before this extension was updated, is replaced.
  const ensure = makeEnsure({
    find: () => findHub(home),
    build: () => buildOf(bundle),
    configDir,
    stop: stopHub,
    start: () => startHub(bundle, home, configDir()),
    now: Date.now,
    sleep,
    logPath: hubLogPath(home),
  });

  const state = new HubState();
  const history = new HistoryPanels(context.extensionUri, () => keeper.current(), (link) => openHistoryLink(link));
  /** Runs a command the dock left for this window (PRD R71). */
  const runCommand = async (command: WindowCommand): Promise<unknown> => {
    switch (command.type) {
      case 'changes':
        return openChanges(String(command['path']), String(command['key']), String(command['title']));
      case 'history':
        return history.open(command as unknown as HistoryMessage);
      case 'openUrl':
        return openLink(String(command['url']));
      default:
        return undefined;
    }
  };
  /** Opens what a History entry links (PRD R59). */
  const openHistoryLink = async (link: { type: string; [key: string]: unknown }): Promise<unknown> => {
    switch (link.type) {
      case 'open':
        return openSession(keeper.current(), String(link['sessionId']), String(link['cwd']));
      case 'openFolder':
        // VS Code focuses a window that already has the folder.
        return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(String(link['path'])), { forceNewWindow: true });
      case 'openUrl':
        return openLink(String(link['url']));
      default:
        return undefined;
    }
  };
  const opening = (record: HubRecord | null = keeper.current(), waitMs?: number): OpenContext => ({ record, state, home, run: runCommand, ...(waitMs === undefined ? {} : { waitMs }) });

  const status = vscode.window.createStatusBarItem('switchboard.needs', vscode.StatusBarAlignment.Left, 100);
  const showStatus = (): void => {
    const shown = needsStatus(state.current());

    status.text = shown.text;
    status.tooltip = shown.tooltip;
  };

  status.name = 'Switchboard';
  status.command = 'switchboard.showDock';
  showStatus();
  status.show();

  context.subscriptions.push(
    status,
    history.register(),
    vscode.commands.registerCommand('switchboard.showDock', () => showDock(keeper.current(), home)),
    vscode.window.registerUriHandler({ handleUri: (uri) => void openUri(opening(), uri) }),
    vscode.commands.registerCommand('switchboard.claim', () => {
      const record = keeper.current();

      return record === null ? null : claimOpen(record, runCommand);
    }),
    vscode.window.onDidChangeWindowState((window) => window.focused && void vscode.commands.executeCommand('switchboard.claim').then(undefined, () => {})),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('switchboard.configDir')) {
        return;
      }

      reportConfigError();

      // Stopping the hub ends every window's stream; each reconnects to one hub started on the new folder.
      const record = keeper.current();

      if (record !== null && record.configDir !== configDir()) {
        keeper.expectEnd();
        void stopHub(record);
      }
    }),
  );

  const toasts = new NeedsYouToasts((workItemId) => openTarget(opening(), { workItemId }));
  const keeper = keepHub({
    ensure,
    open: (record, onEnd) =>
      openEvents(record, onEnd, undefined, (event, data) => {
        if (event === 'state') {
          state.update(data);
          showStatus();
          history.changed();
          toasts.update(JSON.parse(data));
        } else if (event === 'hello') {
          toasts.connected();
          void claimOpen(record, runCommand).catch(() => {});
          history.connected(record);
        }
      }),
    now: Date.now,
    sleep,
    onFailed: (message) => void vscode.window.showErrorMessage(`Switchboard: ${message}`),
  });

  context.subscriptions.push({ dispose: () => keeper.dispose() });

  return {
    hub: () => keeper.current(),
    state: () => state.current(),
    show: (text) => {
      state.update(text);
      showStatus();
    },
    status: () => ({ text: status.text, tooltip: typeof status.tooltip === 'string' ? status.tooltip : undefined }),
    historyTabs: () => history.shown(),
    restoreHistory: (saved) => history.restore(saved),
    openUri: (uri, waitMs) => openUri(opening(), uri, waitMs),
    openRow: (key, options = {}) => openRow(opening(options.hub ?? keeper.current(), options.waitMs), key),
    claim: (hub) => claimOpen(hub, runCommand),
    run: runCommand,
  };
}

export function deactivate(): void {}
