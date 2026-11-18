import { appendFileSync, unwatchFile, watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import { hubBundlePath, hubLogPath, resolveConfigDir, switchboardHome } from '@switchboard/core';
import type { HubRecord } from '@switchboard/core';
import { buildOf, findHub, installBundle, installHolder, keepHub, makeEnsure, openEvents, postToHub, stopHub, windowItems, windowsDir } from '@switchboard/hub';
import { continueInBackground } from './background.js';
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
import { act, claimOpen, newClaudeTab, openAttach, openLink, openRow, openSession, openTab, openTarget, openTerminal, openUri, providerOf, terminalCommandOf, workspaceFile } from './open.js';
import type { OpenContext, OpenResult, WindowCommand } from './open.js';
import { Pane } from './pane.js';
import { mainTerminal, paneModel, windowRows } from './paneModel.js';
import type { PaneModel } from './paneModel.js';
import { POLL_MS, SIDES, SideBars } from './sideBars.js';
import type { EditorLayout, Kept, Outcome, Point } from './sideBars.js';
import { HubState } from './state.js';
import { ItemTabs } from './tabs.js';
import type { PaneMessage } from './webview/paneRender.js';

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
  /** Opens what a History entry links, as a click on it does, through `hub` when given, which may be null for no hub. */
  historyLink(link: { type: string; [key: string]: unknown }, hub?: HubRecord | null): Promise<unknown>;
  /** Runs a command the dock leaves for a window: Open Changes, History, Open report or Show Hub Log (PRD R71). */
  run(command: WindowCommand): Promise<unknown>;
  /** Opens a URL or file as an item window's tab; the suite's window is not an item window (PRD R72). */
  openTab(target: string): Promise<void>;
  /** Runs Continue in Background against `hub` with the given work items; the suite's window is not an item window (PRD R89). */
  background(hub: HubRecord | null, workItemIds: number[] | null, where?: 'tab' | 'sidebar'): Promise<void>;
  /** Closes this window as the item window opened from `file` would, or as its own again with null; the suite's window is not an item window (PRD R76). */
  itemWindow(file: string | null): void;
  /** Handles a state as if the hub sent it; resolves to whether the window asked VS Code to close (PRD R76). */
  receive(state: string): Promise<boolean>;
  /** Handles a focus change as VS Code reports it. */
  windowStateChanged(focused: boolean): Promise<unknown>;
  /** What each resolved Switchboard pane view last rendered, by view ID (PRD R92). */
  pane(): Record<string, PaneModel>;
  /** Runs a click in the Switchboard pane. */
  paneClick(message: PaneMessage): Promise<unknown>;
  /** The size the visible pane last reported, or null (PRD R91). */
  paneSize(): { inner: number; outer: number; dpr: number } | null;
  /** The kept side bar widths (PRD R91). */
  sideBarWidths(): Kept;
  /** Polls the side bars as the timer does. */
  pollSideBars(): Promise<Outcome>;
  /** Expands the pane once in this workspace when it has not loaded; resolves to whether it did. */
  expandPaneOnce(): Promise<boolean>;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** How long a window the dock opened waits for the hub's first state before opening its tabs (PRD R72). */
const TABS_STATE_WAIT_MS = 15_000;
/** How long after activation a visible pane has loaded; one that has not is expanded (PRD R91). */
const EXPAND_MS = 3_000;

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

  // A holder that cannot be installed fails only Code Mode starts; the cause goes to the hub log, which every window shows (PRD R94).
  void installHolder(context.asAbsolutePath('dist/holder'), switchboardHome(home)).then((installed) => {
    if ('error' in installed) {
      try {
        appendFileSync(hubLogPath(home), `${new Date().toISOString()} ${installed.error}\n`);
      } catch {
        // The home cannot be written, which the hub's own start reports.
      }
    }
  });

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
  // The workspace file this window was opened from; the suite's window sets another to act as an item window.
  let windowFile = workspaceFile();
  let done = new DoneWindow(windowFile, windowsDir(home), vscode.window.state.focused, Date.now());
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
        return openTerminal(keeper.current(), terminalCommandOf(command));
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
  const openHistoryLink = async (link: { type: string; [key: string]: unknown }, record: HubRecord | null = keeper.current()): Promise<unknown> => {
    switch (link.type) {
      case 'open':
        // A Code Mode session opens in its attach terminal, never in the Claude view (PRD R95).
        return link['codeMode'] === true
          ? openAttach(record, String(link['sessionId']), String(link['cwd']), runCommand)
          : openSession(record, String(link['sessionId']), String(link['cwd']), providerOf(link['provider']));
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
  /** Runs a row's main control from the pane as the dock does: a hub action, after its question or text, a VS Code command, or else the row's click (PRD R92). */
  const runMain = async (key: string): Promise<unknown> => {
    const snapshot = state.current();
    const row = snapshot === null || windowFile === null ? undefined : windowRows(snapshot, windowFile, windowsDir(home), Date.now()).find((shown) => shown.key === key);

    if (row === undefined || row.main === null) {
      return undefined;
    }

    const control = row.controls.find((shown) => shown.label === row.main);

    if (control !== undefined) {
      const { confirm, input } = control;

      if (confirm !== undefined && (await vscode.window.showWarningMessage(confirm.question, { modal: true, detail: confirm.detail }, confirm.action)) !== confirm.action) {
        return undefined;
      }

      // As in the dock, a blank text is not accepted, because the hub reads it as no text (PRD R77).
      const text = input === undefined ? undefined : await vscode.window.showInputBox({ title: input.question, prompt: input.detail, value: input.text ?? '', ignoreFocusOut: true, validateInput: (value) => (value.trim() === '' ? `${input.action} needs a text.` : null) });

      if (input !== undefined && text === undefined) {
        return undefined;
      }

      return act(keeper.current(), input === undefined ? control.action : { ...control.action, [input.field]: text });
    }

    const terminal = mainTerminal(row);
    const record = keeper.current();

    // Open in terminal goes through the hub, which adds the agent's CLI from `sessions.claudePath` or `sessions.codexPath` (PRD R28).
    if (terminal !== null && record !== null) {
      const left = await postToHub(record, '/window', { workspace: windowFile, command: terminal }, 10_000);

      if (left?.status !== 200) {
        void vscode.window.showErrorMessage(`Switchboard: ${left?.error ?? 'the hub did not answer.'}`);
        return undefined;
      }

      return claimOpen(record, runCommand, windowFile);
    }

    // Open in Claude or Codex, and Answer in terminal, are the row's click.
    return openRow(opening(), key);
  };
  const paneClick = (message: PaneMessage): Promise<unknown> => {
    switch (message.type) {
      case 'open':
        // Links and reports open in VS Code, as an item window's tabs do (PRD R72).
        return openTab(message.target);
      case 'main':
        return runMain(message.key);
      case 'dock':
        return showDock(keeper.current(), home);
      default:
        return Promise.resolve(undefined);
    }
  };
  const pane = new Pane(context.extensionUri, () => paneModel(state.current(), windowFile, windowsDir(home), Date.now()), paneClick);
  // The kept widths are the profile's, so every window uses them (PRD R91).
  const KEPT = 'sideBars.';
  const keptWidths = (): Kept => {
    const kept: Kept = { points: {} };

    for (const side of SIDES) {
      const value = context.globalState.get<unknown>(`${KEPT}points.${side}`);
      const points = Array.isArray(value) ? value.filter((point): point is Point => [point?.room, point?.width, point?.at].every((number) => typeof number === 'number' && number > 0)) : [];

      if (points.length > 0) {
        kept.points[side] = points;
      }
    }

    return kept;
  };
  // What the side bars kept and set, in the Output view, and as a status bar message for a moment (PRD R91).
  const sideBarLog = vscode.window.createOutputChannel('Switchboard Side Bars', { log: true });
  const sideBars = new SideBars({
    layout: () => vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout'),
    run: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    pane: () => pane.size(),
    load: keptWidths,
    save: (side, points) => context.globalState.update(`${KEPT}points.${side}`, points),
    now: Date.now,
    // `outerWidth` is not zoomed, so a zoomed window's CSS pixels are fewer (mechanics M61); a resize measures the real scale.
    zoomScale: () => 1.2 ** -vscode.workspace.getConfiguration('window').get<number>('zoomLevel', 0),
    // The frame's 14 pixels are not zoomed; the activity bar's 44 and the sashes' 16 are CSS pixels (mechanics M61).
    offset: (scale) => 14 * scale + 16 + (['top', 'bottom', 'hidden'].includes(vscode.workspace.getConfiguration('workbench.activityBar').get<string>('location', 'default')) ? 0 : 44),
    fixedWidth: () => vscode.workspace.getConfiguration('workbench.editor').get<boolean>('centeredLayoutFixedWidth', false),
    sleep,
    minWindow: () => vscode.workspace.getConfiguration('switchboard').get<number>('sideBarWidthsMinWindow', 1200),
    log: (message) => {
      sideBarLog.info(message);

      if (!message.includes('nothing to set')) {
        vscode.window.setStatusBarMessage(`$(switchboard-logo) ${message}`, 5_000);
      }
    },
  });
  const forgetWidths = async (): Promise<void> => {
    for (const key of context.globalState.keys().filter((name) => name.startsWith(KEPT))) {
      await context.globalState.update(key, undefined);
    }
  };
  let sideBarError: string | null = null;
  const pollSideBars = (): Promise<Outcome> =>
    sideBars.poll().then(
      (outcome) => {
        sideBarError = null;
        return outcome;
      },
      (error: unknown) => {
        // A failure shows once, not on every poll that meets it again.
        if (String(error) !== sideBarError) {
          sideBarError = String(error);
          void vscode.window.showErrorMessage(`Switchboard: the side bar widths were not set: ${sideBarError}`);
        }

        return 'idle' as const;
      },
    );
  const rememberWidths = (): boolean => vscode.workspace.getConfiguration('switchboard').get<boolean>('rememberSideBarWidths', true);
  const sideBarTimer = setInterval(() => {
    if (rememberWidths()) {
      void pollSideBars();
    }
  }, POLL_MS);
  // A pane that has not loaded, as one collapsed in a new worktree's window, reads no widths, so it is expanded once per workspace; a pane
  // that has loaded marks the workspace too, so one the operator collapses stays collapsed (PRD R91).
  const EXPANDED = 'pane.expanded';
  const expandPaneOnce = async (): Promise<boolean> => {
    if (!rememberWidths() || context.workspaceState.get<boolean>(EXPANDED) === true) {
      return false;
    }

    await context.workspaceState.update(EXPANDED, true);

    if (pane.resolved()) {
      return false;
    }

    await vscode.commands.executeCommand('switchboard.pane.focus', { preserveFocus: true });
    sideBarLog.info('Expanded the Switchboard pane once in this workspace: the side bar widths are read only while it is visible.');
    return true;
  };
  const expandTimer = setTimeout(() => void expandPaneOnce(), EXPAND_MS);

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
    pane.register(),
    sideBarLog,
    vscode.commands.registerCommand('switchboard.forgetSideBarWidths', async () => {
      await forgetWidths();
      await context.workspaceState.update(EXPANDED, undefined);
      sideBarLog.info('Forgot the kept widths.');
    }),
    { dispose: () => clearInterval(sideBarTimer) },
    { dispose: () => clearTimeout(expandTimer) },
    vscode.commands.registerCommand('switchboard.showHubLog', showHubLog),
    vscode.commands.registerCommand('switchboard.showDock', () => showDock(keeper.current(), home)),
    vscode.commands.registerCommand('switchboard.newClaudeTab', newClaudeTab),
    ...(['tab', 'sidebar'] as const).map((where) =>
      vscode.commands.registerCommand(where === 'tab' ? 'switchboard.continueInBackground' : 'switchboard.continueSidebarInBackground', () => {
        const snapshot = state.current();
        const file = workspaceFile();
        const workItemIds = snapshot === null || file === null ? null : windowItems(snapshot, file, windowsDir(home)).map((item) => item.id);

        return continueInBackground({ record: keeper.current(), workItemIds }, where);
      }),
    ),
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
    pane.changed();
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
      pane.changed();
    },
    status: () => ({ text: status.text, tooltip: typeof status.tooltip === 'string' ? status.tooltip : undefined }),
    historyTabs: () => history.shown(),
    restoreHistory: (saved) => history.restore(saved),
    openUri: (uri, waitMs) => openUri(opening(), uri, waitMs),
    openRow: (key, options = {}) => openRow(opening(options.hub ?? keeper.current(), options.waitMs), key),
    claim: (hub, run = runCommand) => claimOpen(hub, run),
    historyLink: (link, hub) => openHistoryLink(link, hub === undefined ? keeper.current() : hub),
    run: runCommand,
    openTab,
    background: (hub, workItemIds, where) => continueInBackground({ record: hub, workItemIds }, where),
    itemWindow: (file) => {
      windowFile = file ?? workspaceFile();
      done = new DoneWindow(windowFile, windowsDir(home), vscode.window.state.focused, Date.now());
      pane.changed();
    },
    receive: stateReceived,
    windowStateChanged,
    pane: () => pane.shown(),
    paneClick,
    paneSize: () => pane.size(),
    sideBarWidths: keptWidths,
    pollSideBars,
    expandPaneOnce,
  };
}

export function deactivate(): void {}
