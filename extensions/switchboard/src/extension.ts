import { unwatchFile, watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import { hubBundlePath, hubLogPath, resolveConfigDir, switchboardHome } from '@switchboard/core';
import type { HubRecord } from '@switchboard/core';
import { buildOf, findHub, installBundle, keepHub, makeEnsure, openEvents, postToHub, stopHub, windowsDir } from '@switchboard/hub';
import { closeDueAt, closeIfDone } from './closeWindow.js';
import { showDock } from './dockApp.js';
import { DoneWindow } from './doneWindow.js';
import { openChanges } from './git.js';
import { HistoryPanels } from './historyPanel.js';
import type { HistoryMessage } from './historyPanel.js';
import { LogTail } from './hubLog.js';
import { startHub } from './hubProcess.js';
import { needsStatus } from './needs.js';
import { NeedsYouToasts } from './notify.js';
import { claimIsFor } from './claims.js';
import { claimOpen, newClaudeTab, openLink, openRow, openSession, openTab, openTarget, openTerminal, openUri, providerOf, workspaceFile } from './open.js';
import type { OpenContext, OpenResult, WindowCommand } from './open.js';
import { HubState } from './state.js';
import { ItemTabs } from './tabs.js';

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
  /** Claims what the dock left for this window from a hub, as focus or a connection does, and runs it, by default with `run` (PRD R71). */
  claim(hub: HubRecord, run?: (command: WindowCommand) => Promise<unknown>): Promise<string | null>;
  /** Runs a command the dock leaves for a window: Open Changes, History, Open report or Show Hub Log (PRD R71). */
  run(command: WindowCommand): Promise<unknown>;
  /** Opens a URL or file as an item window's tab; the suite's window is not an item window (PRD R72). */
  openTab(target: string): Promise<void>;
  /** Closes this window as the item window opened from `file` would, or as its own again with null; the suite's window is not an item window (PRD R76). */
  itemWindow(file: string | null): void;
  /** Handles a state as if the hub sent it; resolves to whether the window asked VS Code to close (PRD R76). */
  receive(state: string): Promise<boolean>;
  /** Handles a focus change as VS Code reports it. */
  windowStateChanged(focused: boolean): Promise<unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** How long a window the dock opened waits for the hub's first state before opening its tabs (PRD R72). */
const TABS_STATE_WAIT_MS = 15_000;

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

  // Every window follows hub.log, so the Output view's channel is current whichever window shows it.
  const hubLog = vscode.window.createOutputChannel('Switchboard Hub', 'log');
  const logTail = new LogTail(hubLogPath(home), (text) => hubLog.append(text));
  const readLog = (): void => logTail.read();
  const showHubLog = (): void => {
    readLog();
    hubLog.show(true);
  };

  readLog();
  watchFile(hubLogPath(home), { interval: 1000 }, readLog);

  const state = new HubState();
  const tabs = new ItemTabs(workspaceFile(), windowsDir(home), openTab);
  let done = new DoneWindow(workspaceFile(), windowsDir(home), vscode.window.state.focused, Date.now());
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Records a focus change, then closes a done window or checks again when its close is due; a window with unsaved changes is checked each minute. */
  const closeDone = async (focused?: boolean): Promise<boolean> => {
    clearTimeout(closeTimer);

    const closed = await closeIfDone(done, focused).catch((error: unknown) => (void vscode.window.showErrorMessage(`Switchboard: the window did not close: ${String(error)}`), false));
    const at = closed ? null : closeDueAt(done);

    if (at !== null) {
      const wait = at - Date.now();

      // Another call may have set a timer while this one awaited.
      clearTimeout(closeTimer);
      // setTimeout runs at once for a wait over 2^31 - 1 ms; the next check sets the rest.
      closeTimer = setTimeout(() => void closeDone(), wait > 0 ? Math.min(wait, 2 ** 31 - 1) : 60_000);
    }

    return closed;
  };
  const history = new HistoryPanels(context.extensionUri, () => keeper.current(), (link) => openHistoryLink(link));
  /** Runs a command the dock left for this window (PRD R71). */
  const runCommand = async (command: WindowCommand): Promise<unknown> => {
    switch (command.type) {
      case 'changes':
        return openChanges(String(command['path']), String(command['key']), String(command['title']));
      case 'history':
        return history.open(command as unknown as HistoryMessage);
      case 'terminal':
        return openTerminal(keeper.current(), String(command['sessionId']), String(command['cwd']), String(command['name']), typeof command['shortId'] === 'string' ? command['shortId'] : null, command['active'] === true, providerOf(command['provider']), typeof command['executable'] === 'string' && command['executable'] !== '' ? command['executable'] : undefined);
      case 'openUrl':
        return openLink(String(command['url']));
      case 'openTabs':
        return tabs.openAll(await state.first(TABS_STATE_WAIT_MS));
      case 'log':
        return showHubLog();
      default:
        return undefined;
    }
  };
  /** Opens what a History entry links (PRD R59). */
  const openHistoryLink = async (link: { type: string; [key: string]: unknown }): Promise<unknown> => {
    switch (link.type) {
      case 'open':
        return openSession(keeper.current(), String(link['sessionId']), String(link['cwd']), providerOf(link['provider']));
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

  const windowStateChanged = (focused: boolean): Promise<unknown> => {
    // Focus restarts the wait before a done window closes (PRD R76).
    const closing = closeDone(focused);

    const record = keeper.current();

    // The dock follows the window in front through the hub where it cannot see other apps' windows (architecture.md § Dock).
    if (record !== null) {
      void postToHub(record, '/window/focus', { workspace: workspaceFile(), focused, at: Date.now() }, 5_000);
      if (focused) {
        reportTheme(record);
      }
    }

    return focused ? Promise.resolve(vscode.commands.executeCommand('switchboard.claim')).catch(() => {}) : closing;
  };

  const reportTheme = (record: HubRecord): void => {
    const kind = vscode.window.activeColorTheme.kind;
    const theme = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';

    void postToHub(record, '/window/theme', { theme, at: Date.now() }, 5_000);
  };

  status.name = 'Switchboard';
  status.command = 'switchboard.showDock';
  showStatus();
  status.show();

  context.subscriptions.push(
    status,
    hubLog,
    { dispose: () => unwatchFile(hubLogPath(home), readLog) },
    history.register(),
    vscode.commands.registerCommand('switchboard.showHubLog', showHubLog),
    vscode.commands.registerCommand('switchboard.showDock', () => showDock(keeper.current(), home)),
    vscode.commands.registerCommand('switchboard.newClaudeTab', newClaudeTab),
    vscode.window.registerUriHandler({ handleUri: (uri) => void openUri(opening(), uri) }),
    vscode.commands.registerCommand('switchboard.claim', () => {
      const record = keeper.current();

      return record === null ? null : claimOpen(record, runCommand);
    }),
    vscode.window.onDidChangeWindowState((window) => void windowStateChanged(window.focused)),
    vscode.window.onDidChangeActiveColorTheme(() => {
      const record = keeper.current();
      if (record !== null && vscode.window.state.focused) {
        reportTheme(record);
      }
    }),
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
  const stateReceived = (data: string): Promise<boolean> => {
    const snapshot = JSON.parse(data);

    state.update(data);
    showStatus();
    history.changed();
    toasts.update(snapshot);
    void tabs.update(snapshot).catch((error: unknown) => void vscode.window.showErrorMessage(`Switchboard: ${String(error)}`));
    done.update(snapshot, Date.now());

    return closeDone();
  };
  const keeper = keepHub({
    ensure,
    open: (record, onEnd) =>
      openEvents(record, onEnd, undefined, (event, data) => {
        if (event === 'state') {
          void stateReceived(data);
        } else if (event === 'claim') {
          // The dock left something for this window, which may already be in front, so no focus change would claim it (PRD R71).
          if (claimIsFor(data, workspaceFile())) {
            void claimOpen(record, runCommand).catch(() => {});
          }
        } else if (event === 'hello') {
          if (vscode.window.state.focused) {
            reportTheme(record);
          }
          toasts.connected();
          void claimOpen(record, runCommand).catch(() => {});
          history.connected(record);
        }
      }, { workspace: workspaceFile() ?? '', focused: vscode.window.state.focused ? '1' : '0', at: String(Date.now()) }),
    now: Date.now,
    sleep,
    onFailed: (message) => void vscode.window.showErrorMessage(`Switchboard: ${message}`),
  });

  context.subscriptions.push({ dispose: () => keeper.dispose() }, { dispose: () => clearTimeout(closeTimer) });

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
    claim: (hub, run = runCommand) => claimOpen(hub, run),
    run: runCommand,
    openTab,
    itemWindow: (file) => {
      done = new DoneWindow(file ?? workspaceFile(), windowsDir(home), vscode.window.state.focused, Date.now());
    },
    receive: stateReceived,
    windowStateChanged,
  };
}

export function deactivate(): void {}
