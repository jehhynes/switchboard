import { homedir } from 'node:os';
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import { hubBundlePath, hubLogPath, resolveConfigDir, switchboardHome } from '@switchboard/core';
import type { HubRecord } from '@switchboard/core';
import { buildOf, findHub, installBundle, keepHub, makeEnsure, openEvents, stopHub } from '@switchboard/hub';
import { openChanges, showInSourceControl } from './git.js';
import { HistoryPanels } from './historyPanel.js';
import type { HistoryMessage } from './historyPanel.js';
import { startHub } from './hubProcess.js';
import { NeedsYouToasts } from './notify.js';
import { WorkItemsView, attach, claimOpen, copyPaste, dispatch, goTo, openLink, openQuestion, openSession, openUri, openWorktree, resume, runOpen, setSource, startAdhoc } from './panel.js';
import type { PasteChoice } from './panel.js';
import type { RowTarget } from './search.js';
import { SettingsEditor } from './settingsEditor.js';
import { TOGGLED_SOURCES, sourceContexts } from './sources.js';
import { ROW_COMMANDS } from './webview/render.js';
import type { Snapshot } from '@switchboard/hub';

export interface SwitchboardApi {
  /** The hub this window is connected to, or null. */
  hub(): HubRecord | null;
  /** The last panel state the hub sent, or null. */
  state(): unknown;
  /** The view's activity bar badge, or null before VS Code resolves the view. */
  badge(): vscode.ViewBadge | undefined | null;
  /** Shows a state as if the hub sent it, so the integration suite can show recorded snapshots. */
  show(state: string): void;
  /** What each open History tab shows (PRD R59). */
  historyTabs(): { ticketId: number; title: string; shown: string | null; error: string | null }[];
  /** Restores a History tab from a page's saved state, as VS Code does after a reload. */
  restoreHistory(state: unknown): Promise<void>;
  /** Runs the URI handler, which the integration suite cannot reach through the OS (PRD R69). */
  openUri(uri: vscode.Uri, waitMs?: number): Promise<RowTarget | null>;
  /** Runs Open in Claude against `hub`, by default the connected one, so the integration suite can stand in for a hub that accepts it (PRD R70). */
  /** Claims what the dock left for this window from a hub, as focus or a connection does, and runs it (PRD R71). */
  claim(hub: HubRecord): Promise<string | null>;
  openQuestion(workItemId: number, sessionId: string, cwd: string, options?: { waitMs?: number; hub?: HubRecord }): Promise<string>;
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

  const view = new WorkItemsView(context.extensionUri);
  const settings = new SettingsEditor(context.extensionUri, configDir, () => openPlaybooks(view.state() as Snapshot | null));
  const history = new HistoryPanels(context.extensionUri, () => keeper.current());
  /** Runs a command the dock left for this window with the panel's own handler (PRD R71). */
  const runCommand = async (command: { type: string; [key: string]: unknown }): Promise<unknown> => {
    switch (command.type) {
      case 'changes':
        return openChanges(String(command['path']), String(command['key']), String(command['title']));
      case 'history':
        return history.open(command as unknown as HistoryMessage);
      case 'openUrl':
        return openLink(String(command['url']));
      case 'settings':
        return settings.show();
      default:
        return undefined;
    }
  };

  context.subscriptions.push(
    history.register(),
    vscode.window.registerWebviewViewProvider(WorkItemsView.id, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('switchboard.action', (action: unknown) => dispatch(keeper.current(), action)),
    // A row's right-click menu passes the row's `data-vscode-context`, which holds what each command runs.
    ...Object.values(ROW_COMMANDS).map((key) =>
      vscode.commands.registerCommand(`switchboard.row.${key}`, (row: { actions: Record<string, unknown> }) => {
        const local = row.actions[key] as { path: string; key: string; title: string; pastes: PasteChoice[] };

        switch (key) {
          case 'changes':
            return openChanges(local.path, local.key, local.title);
          case 'sourceControl':
            return showInSourceControl(local.path);
          case 'copy':
            return copyPaste(local.pastes);
          case 'history':
            return history.open(row.actions[key] as HistoryMessage);
          case 'openQuestion':
          case 'attach':
            return runOpen(row.actions[key] as { type: string });
          default:
            return dispatch(keeper.current(), row.actions[key]);
        }
      }),
    ),
    vscode.commands.registerCommand('switchboard.attach', (shortId: string, name: string) => attach(shortId, name)),
    vscode.commands.registerCommand('switchboard.openQuestion', (workItemId: number, sessionId: string, cwd: string) => openQuestion(keeper.current(), view, workItemId, sessionId, cwd)),
    vscode.commands.registerCommand('switchboard.open', (sessionId: string, cwd: string) => openSession(keeper.current(), sessionId, cwd)),
    vscode.commands.registerCommand('switchboard.resume', (sessionId: string, cwd: string, name: string, active: boolean) => resume(keeper.current(), sessionId, cwd, name, active === true)),
    vscode.commands.registerCommand('switchboard.openLink', (target: string) => openLink(target)),
    vscode.commands.registerCommand('switchboard.openWorktree', (path: string) => openWorktree(path)),
    vscode.commands.registerCommand('switchboard.openSettings', () => void settings.show()),
    { dispose: () => settings.dispose() },
    vscode.commands.registerCommand('switchboard.newAdhoc', () => startAdhoc(keeper.current(), view.state() as Snapshot | null)),
    vscode.commands.registerCommand('switchboard.goTo', () => goTo(view)),
    vscode.window.registerUriHandler({ handleUri: (uri) => void openUri(view, uri) }),
    vscode.commands.registerCommand('switchboard.setSource', (name: string, enabled: boolean) => setSource(keeper.current(), name, enabled)),
    ...TOGGLED_SOURCES.flatMap((name) => [
      vscode.commands.registerCommand(`switchboard.source.${name}.on`, () => setSource(keeper.current(), name, false)),
      vscode.commands.registerCommand(`switchboard.source.${name}.off`, () => setSource(keeper.current(), name, true)),
    ]),
    vscode.commands.registerCommand('switchboard.claim', () => {
      const record = keeper.current();

      return record === null ? null : claimOpen(record, runCommand);
    }),
    vscode.window.onDidChangeWindowState((state) => state.focused && void vscode.commands.executeCommand('switchboard.claim').then(undefined, () => {})),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('switchboard.configDir')) {
        return;
      }

      reportConfigError();
      settings.moved();

      // Stopping the hub ends every window's stream; each reconnects to one hub started on the new folder.
      const record = keeper.current();

      if (record !== null && record.configDir !== configDir()) {
        keeper.expectEnd();
        void stopHub(record);
      }
    }),
  );

  const toasts = new NeedsYouToasts(() => view.state() as Snapshot | null);
  const keeper = keepHub({
    ensure,
    open: (record, onEnd) =>
      openEvents(record, onEnd, undefined, (event, data) => {
        if (event === 'state') {
          view.update(data);
          history.changed();
          showSourceToggles(JSON.parse(data) as Snapshot);
          toasts.update(JSON.parse(data) as Snapshot);
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

  return { hub: () => keeper.current(), state: () => view.state(), historyTabs: () => history.shown(), restoreHistory: (state) => history.restore(state), badge: () => view.badge(), show: (state) => view.update(state), openUri: (uri, waitMs) => openUri(view, uri, waitMs), claim: (hub: HubRecord) => claimOpen(hub, runCommand), openQuestion: (workItemId, sessionId, cwd, options = {}) => openQuestion(options.hub ?? keeper.current(), view, workItemId, sessionId, cwd, options.waitMs) };
}

export function deactivate(): void {}
