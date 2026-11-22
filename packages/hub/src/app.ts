import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, watch, writeFileSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { claudeSettingsPath, readRoster, spawnExec } from '@switchboard/claude';
import { hostKey, hubBundlePath, NEW_CONVERSATION_TITLE, PANE_EXTENSION_ID, personaById, Store, switchboardHome } from '@switchboard/core';
import { CODEX_PERMISSION_MODES, PERMISSION_MODES, PROVIDERS, resumesHeld, TEMPLATE_VARIABLES } from '@switchboard/core';
import type { FlowEvent, SourceSettings, ViewSettings } from '@switchboard/core';
import { githubSource } from '@switchboard/github';
import { zohoSource } from '@switchboard/zoho';
import { forumSource } from '@switchboard/forum';
import { findBash } from './bash.js';
import { cardsOf } from './cards.js';
import { DoneSearch } from './dockSearch.js';
import { dockView, windowOf, windowsDir, writeWorkspaceFile } from './dock.js';
import type { DockRow, DockTerminal } from './dock.js';
import { isPastePath } from './report.js';
import { codeModeTerminal, rowKeyOf } from './rows.js';
import { DEBRIEF_SCAN_MS, Debriefs } from './debriefs.js';
import { SOURCE_KINDS, checkSettings, loadConfig, readConfigFile, saveSettings } from './config.js';
import type { HubApp } from './serve.js';
import { Runtime } from './runtime.js';
import type { ReportBody, RuntimeDeps } from './runtime.js';
import { WindowQueue } from './windowQueue.js';
import { ConversationService, claudePaths, sessionView } from './conversation.js';
import { PageConsole } from './console.js';
import { CodexConversationAdapter } from './codexConversation.js';
import { runAppServerDebrief } from '@switchboard/codex';
import { alertDetail, alertKind, VoiceControl, voiceMark } from './voice.js';
import { VoiceLink } from './voiceLink.js';
import { enrolledAt, parseRemote } from '@switchboard/voice';
import { buildSnapshot } from './snapshot.js';
import type { Snapshot, WorkItemView } from './snapshot.js';
import { SnapshotBuilder } from './snapshotBuilder.js';
import type { Built } from './snapshotBuilder.js';
import { WindowScopes } from './windows.js';
import { tailscaleIdentity } from './tailscale.js';
import type { RemoteAccess } from './page.js';
import { dockRowOf, PageAccess, pageActionEvent, OPEN_IN_VSCODE, pageCommandOf, pageHeader, pageList, pageRow, pasteText, poolRowOf, rowOpenUrl } from './page.js';
import { launcher } from './launch.js';
import type { Launcher } from './launch.js';
import { pageAsset } from './pageAssets.js';
import { PageChanges } from './changes.js';
import { needsMessage, newlyNeeding, rowFor, targetForUrl } from './needs.js';
import { installedProviders } from './installed.js';
import { PaneLink } from './paneLink.js';
import { PaneState, paneRect, paneTabs } from './pane.js';
import { localRoots, openLocalFile } from './localFiles.js';
import { PaneHelper, spawnPaneHelper } from './paneHelper.js';
import type { PaneHelperDeps } from './paneHelper.js';
import { currentHolderBuild, PANE_HELPER_INSTALL, paneHelperRecordPath, reserveHolderBuild } from './holderInstall.js';
import { spawnEnvironment } from './spawn.js';
import { PageTargets } from './pageTargets.js';
import { VoiceSockets } from './voiceSocket.js';
import { VOICE_OFF } from './server.js';

const RELOAD_DEBOUNCE_MS = 300;
/** The dock's note while no device has the voice, after the phone that had it left. */
const NO_VOICE_DEVICE = 'Voice: the phone that had it left. Use Talk here to bring it to this computer, or tap Voice on this phone again.';

/** Operator events the dock may send (PRD R27). */
const OPERATOR_EVENTS = new Set(['adhoc', 'run-schedule', 'start', 'approve', 'mark-done', 'reopen', 'retry', 'stop', 'delete', 'open-question', 'pick', 'retriage-pool', 'snooze', 'restore', 'comment', 'move', 'reset-position', 'persona']);

const REPORT_KINDS = new Set(['stage', 'worktree', 'done', 'approval', 'link', 'playbook', 'paste', 'task', 'question']);

/** A link target: an http(s) URL (PRD R52). */
export function isLinkTarget(target: unknown): target is string {
  return typeof target === 'string' && /^https?:\/\/\S+$/i.test(target);
}

/** An approval's draft: an absolute path, which opens in VS Code (PRD R23). */
function isReportPath(path: unknown): path is string {
  return typeof path === 'string' && (win32.isAbsolute(path) || posix.isAbsolute(path));
}

const BASH = findBash(process.platform, process.env);

function makeSource(name: string, settings: SourceSettings) {
  switch (settings.kind) {
    case 'github':
      return githubSource(name, settings);
    case 'zoho':
      return zohoSource(name, settings, BASH);
    case 'forum':
      return forumSource(name, settings, BASH);
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A report body names a session, one of the report kinds, and that kind's text. */
export function parseReport(body: unknown): ReportBody | null {
  if (!isRecord(body) || typeof body['sessionId'] !== 'string' || !REPORT_KINDS.has(String(body['kind']))) {
    return null;
  }

  if (body['kind'] === 'link') {
    const label = body['label'];

    return typeof label === 'string' && label.trim() !== '' && isLinkTarget(body['target'])
      ? { sessionId: body['sessionId'], kind: 'link', label: label.trim(), target: body['target'] }
      : null;
  }

  if (body['kind'] === 'done') {
    return { sessionId: body['sessionId'], kind: 'done' };
  }

  if (body['kind'] === 'paste') {
    const label = body['label'];

    return typeof label === 'string' && label.trim() !== '' && isPastePath(body['file'])
      ? { sessionId: body['sessionId'], kind: 'paste', label: label.trim(), file: body['file'] }
      : null;
  }

  if (body['kind'] === 'question') {
    const text = body['text'];

    return typeof text === 'string' && text.trim() !== '' ? { sessionId: body['sessionId'], kind: 'question', text: text.trim() } : null;
  }

  const optional = (field: string, valid: (value: unknown) => boolean) => body[field] === undefined || body[field] === null || valid(body[field]);

  // A task's repo is checked against the repo roots by the core; here it must be an absolute path (PRD R68).
  if (body['kind'] === 'task') {
    const prompt = body['prompt'];

    return typeof prompt === 'string' && prompt !== '' && optional('repo', isReportPath) && optional('title', (value) => typeof value === 'string')
      ? { sessionId: body['sessionId'], kind: 'task', prompt, repo: (body['repo'] as string | undefined) ?? null, title: (body['title'] as string | undefined) ?? null }
      : null;
  }

  const text = { stage: 'stage', worktree: 'path', approval: 'prompt', playbook: 'playbook' }[body['kind'] as Exclude<ReportBody['kind'], 'link' | 'done' | 'paste' | 'task' | 'question'>];
  const value = body[text];

  if (body['kind'] === 'approval' && !(optional('summary', (value) => typeof value === 'string') && optional('report', isReportPath))) {
    return null;
  }

  if (typeof value !== 'string' || value === '') {
    return null;
  }

  return { ...body, [text]: value, ...(body['kind'] === 'approval' ? { summary: body['summary'] ?? null, report: body['report'] ?? null } : {}) } as ReportBody;
}

/** An operator event from the panel. The core validates its target and refuses what does not apply; a snooze names its wake time or null. */
export function parseAction(body: unknown): FlowEvent | null {
  if (!isRecord(body) || !OPERATOR_EVENTS.has(String(body['type']))) {
    return null;
  }

  if (body['type'] === 'snooze' && ((body['until'] !== null && !Number.isFinite(body['until'])) || (body['comment'] != null && typeof body['comment'] !== 'string'))) {
    return null;
  }

  if (body['type'] === 'comment') {
    const { workItemId, text } = body;

    return Number.isInteger(workItemId) && typeof text === 'string' ? { type: 'comment', workItemId: workItemId as number, text } : null;
  }

  // Only the fields the core reads, because a `sessionId` field would make the activity log name another subject.
  if (body['type'] === 'open-question') {
    const { workItemId, nativeSessionId } = body;

    return Number.isInteger(workItemId) && typeof nativeSessionId === 'string' ? { type: 'open-question', workItemId: workItemId as number, nativeSessionId } : null;
  }

  if ((body['type'] === 'start' || body['type'] === 'pick') && ((body['guidance'] != null && typeof body['guidance'] !== 'string') || (body['playbook'] != null && typeof body['playbook'] !== 'string') || (body['prompt'] != null && typeof body['prompt'] !== 'string'))) {
    return null;
  }

  // A dock row's Persona menu pins a persona to the row's session, or clears the pin (architecture.md § Personas).
  if (body['type'] === 'persona') {
    const { sessionId, personaId } = body;

    return typeof sessionId === 'string' && (personaId === null || typeof personaId === 'string') ? { type: 'persona', sessionId, personaId } : null;
  }

  if (body['type'] === 'run-schedule') {
    return typeof body['name'] === 'string' ? { type: 'run-schedule', name: body['name'] } : null;
  }

  if (body['type'] === 'move') {
    const { workItemId, after } = body;

    return Number.isInteger(workItemId) && (after === null || Number.isInteger(after)) ? { type: 'move', workItemId: workItemId as number, after: after as number | null } : null;
  }

  return body as unknown as FlowEvent;
}

export interface AppOptions {
  home: string;
  /** The folder holding settings.json; the Switchboard home when left out. */
  configDir?: string;
  log(line: string): void;
  /** The Code Mode idle limit (`--code-mode-idle-ms`); 1 hour when left out. */
  codeModeIdleMs?: number;
  /** Overrides for tests. */
  deps?: Partial<RuntimeDeps>;
  /**
   * The script that runs the snapshot worker (architecture.md § Hub lifecycle): the hub bundle itself, which runs as the worker when started as
   * one. Without it the snapshot is built on the main thread.
   */
  snapshotWorker?: string;
  /** What the hub starts for the web page, such as the browser for a link; tests replace it. */
  launch?: Launcher;
  /** Starts the Chrome pane helper (architecture.md § Pane helper); tests replace it. */
  startPaneHelper?: PaneHelperDeps['start'];
}

/** Opens the store, loads configuration, and runs the core for the hub process. */
export async function createHubApp(options: AppOptions): Promise<HubApp & { runtime: Runtime }> {
  const home = switchboardHome(options.home);
  const configDir = options.configDir ?? home;

  mkdirSync(configDir, { recursive: true });

  const store = Store.open(join(home, 'switchboard.db'));
  let config = loadConfig(configDir, undefined, store.homeRepos());
  const deps: RuntimeDeps = {
    home: options.home,
    configDir,
    store,
    exec: spawnExec,
    makeSource,
    now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    newSessionId: () => randomUUID().slice(0, 8),
    claudeSettings: claudeSettingsPath(homedir(), process.env),
    // Codex reads CODEX_HOME when the operator set it, else ~/.codex.
    codex: { home: process.env['CODEX_HOME'] || join(homedir(), '.codex'), env: {} },
    log: options.log,
    ...(options.codeModeIdleMs === undefined ? {} : { codeModeIdleMs: options.codeModeIdleMs }),
    ...options.deps,
  };

  if (deps.codeModeIdleMs !== undefined) {
    deps.log(`Code Mode idle limit: ${deps.codeModeIdleMs} ms`);
  }

  // The names and logins the web page is served to through tailscale serve (architecture.md § Remote access), read at start and again when
  // web.remoteHosts, web.remoteLogins or web.tailscale changes; with web.tailscale, this machine's Tailscale name and owner join them once
  // `tailscale status` answers. A change that no longer allows a remote device ends its open streams.
  let remote: RemoteAccess = { hosts: [], logins: [] };
  let remoteRead: string | null = null;
  let remoteReads = 0;
  // Tailscale's name and owner as last read, kept while web.tailscale stays on, so a change of the lists does not drop them until it answers again.
  let tailscaleFound: { host: string; login: string } | null = null;
  let remoteChanged: () => void = () => {};
  const readRemote = (web: { remoteHosts: string[]; remoteLogins: string[]; tailscale: boolean }): void => {
    const read = JSON.stringify([web.remoteHosts, web.remoteLogins, web.tailscale]);

    if (read === remoteRead) {
      return;
    }

    const first = remoteRead === null;
    const mine = ++remoteReads;
    const allowed = (): RemoteAccess =>
      tailscaleFound === null
        ? { hosts: [...web.remoteHosts], logins: [...web.remoteLogins] }
        : { hosts: [...new Set([tailscaleFound.host, ...web.remoteHosts])], logins: [...new Set([...web.remoteLogins, tailscaleFound.login])] };

    remoteRead = read;
    tailscaleFound = web.tailscale ? tailscaleFound : null;
    remote = allowed();
    remoteChanged();

    if (web.tailscale) {
      void tailscaleIdentity(deps.exec).then((found) => {
        if (mine !== remoteReads) {
          return;
        }

        if ('error' in found) {
          deps.log(`web page: Tailscale not used: ${found.error}`);
          tailscaleFound = null;
        } else {
          deps.log(`web page: served as https://${found.host} to the Tailscale login ${found.login} through tailscale serve`);
          tailscaleFound = found;
        }

        remote = allowed();
        remoteChanged();
      });
    } else if (remote.hosts.length > 0) {
      deps.log(remote.logins.length > 0 ? `web page: served as ${remote.hosts.map((host) => `https://${host}`).join(', ')} through tailscale serve` : 'web page: web.remoteHosts is set but web.remoteLogins is empty, so no remote device is let in');
    } else if (!first) {
      deps.log('web page: not served to other devices');
    }
  };

  readRemote(config.settings.web);

  const runtime = new Runtime(deps, config);
  const launch = options.launch ?? launcher();
  // Kept in a file, because the window the dock is opening may replace this hub before it claims (architecture.md § Claude Code runner).
  const windowQueue = WindowQueue.load(join(home, 'window-queue.json'), deps.now, deps.log);
  const claudeRoot = dirname(deps.claudeSettings).replaceAll('\\', '/');
  const debriefs = new Debriefs({
    appServer: { history: id => runtime.codexAppServer.history(id), run: (id, prompt, timeoutMs) => runAppServerDebrief(runtime.codexServer, id, prompt, timeoutMs) },
    dir: `${claudeRoot}/.wip/debrief`,
    promptPath: `${claudeRoot}/skills/friction-review/prompt.md`,
    projectsDir: `${claudeRoot}/projects`,
    claudePath: () => config.settings.sessions.claudePath,
    codexScript: `${claudeRoot}/tools/agent-delegate/debrief.mjs`,
    codexPath: () => config.settings.sessions.codexPath,
    codexHome: deps.codex?.home ?? join(homedir(), '.codex'),
    nodePath: process.execPath,
    exec: deps.exec,
    enabled: () => config.settings.sessions.debriefs,
    sessions: () => store.startedSessions(),
    workItemDone: (id) => store.workItem(id)?.status === 'done',
    roster: () => readRoster(config.settings.sessions.claudePath, deps.exec),
    now: deps.now,
    newId: randomUUID,
    log: deps.log,
  });

  let sendDock: (event: string, data: unknown) => number = () => 0;
  /** settings.json or a source's state changed: the dock's Settings window and every page's Settings read the file again (PRD R54). */
  const configChanged = (): void => {
    sendDock('config', {});

    for (const key of conversation.pages()) {
      conversation.notify(key, 'config', {});
    }
  };
  let clickDock: (data: unknown) => boolean = () => false;
  let sendWindows: (event: string, data: unknown, keys?: readonly string[]) => number = () => 0;
  /**
   * Tells the window opened from `workspace` to claim what was left for it, because VS Code reports no focus change when the dock brings an open
   * window forward; a window claims on focus too. Nothing left for any window is announced, because only the window brought forward takes it.
   */
  /**
   * What a terminal runs, from the settings as they are when the window or dock takes it: the agent's CLI from `sessions.claudePath` or
   * `sessions.codexPath` (PRD R28), or for a Code Mode session `hub.js attach <Switchboard session ID>` with `sessions.nodePath` (PRD R95).
   */
  const terminalRun = (terminal: { provider?: unknown; codeMode?: unknown; execution?: unknown; sessionId?: unknown }): { executable: string; args?: string[] } => {
    const sessions = config.settings.sessions;

    if (terminal.codeMode === true) {
      return { executable: sessions.nodePath, args: [hubBundlePath(options.home), 'attach', String(terminal.sessionId)] };
    }
    if (terminal.execution === 'app-server') {
      const codexHome = runtime.codexHome;
      return { executable: sessions.codexPath, args: ['resume', '--remote', `unix://${join(codexHome, 'app-server-control', 'app-server-control.sock').replaceAll('\\', '/')}`, String(terminal.sessionId)] };
    }

    return { executable: terminal.provider === 'codex' ? sessions.codexPath : sessions.claudePath };
  };

  /**
   * The destination of a work item's window: its workspace file, its host's for a hosted conversation, which for a folder-hosted one is the host
   * folder; from the store when the snapshot no longer lists it, as for a History link to a session done long ago; null for a work item with no window.
   */
  const itemWindowFile = (workItemId: number): string | null => {
    const shown = views().snapshot.workItems.find((one) => one.id === workItemId);
    const item = store.workItem(workItemId);
    const ticket = item === null ? null : store.ticket(item.ticketId);
    const view = shown ?? (item === null || ticket === null ? null : ({ ...item, ticket, sessions: store.sessionsFor(item.id), worktree: store.worktreeFor(ticket.id) } as unknown as WorkItemView));

    const window = view === null ? null : windowOf(view, windows);

    return window === null ? null : (window.file ?? window.folder ?? null);
  };

  /**
   * The attach terminal command for a claimed open of a Code Mode session, which the Claude view refuses (PRD R95), or of an ended registered
   * session, which resumes in the holder (PRD R81); null for any other session.
   */
  const codeModeOpen = (sessionId: string): Record<string, unknown> | null => {
    const session = store.session(sessionId) ?? store.sessionByNativeId(sessionId);
    if (session?.execution === 'app-server') return { type: 'conversation' };
    const item = session !== null && (session.codeMode === true || resumesHeld(session)) ? store.workItem(session.workItemId) : null;
    const ticket = item === null ? null : store.ticket(item.ticketId);

    return session === null || ticket === null ? null : codeModeTerminal(ticket, session);
  };

  // Only the destination window's streams hear the nudge, by the keys bound to it, an item window's file or a folder window's folder (architecture.md § Window scope).
  const askToClaim = (workspace: string | null): void => {
    if (workspace !== null) {
      sendWindows('claim', { workspace }, scopes.keysOf(workspace));
    }
  };
  /** Why a write from a Settings window that read another config folder is refused, or null; a body without `configDir` names none. */
  const movedFrom = (read: unknown): string | null =>
    typeof read === 'string' && read !== configDir ? `The config folder is now ${configDir}, not ${read}. Settings reads it again; make your change there.` : null;
  // What each item window's workspace file holds, so a dock view writes only the files that changed (PRD R71).
  const written = new Map<string, string>();
  const windows = windowsDir(options.home);

  // settings.json, which holds the playbooks, is reloaded when it changes (PRD R42).
  let pending: NodeJS.Timeout | undefined;
  const reload = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      config = loadConfig(configDir, config, store.homeRepos());
      runtime.reload(config);
      voice.settingsChanged();
      readRemote(config.settings.web);

      if (!config.settings.voice.enabled) {
        voiceSockets.close(() => true, VOICE_OFF);
      }

      if (!config.settings.web.chromePane) {
        paneLink.closeAll();
      }

      pane.update();

      // The dock's Settings window reads the file again (PRD R54).
      configChanged();
    }, RELOAD_DEBOUNCE_MS);
  };
  const watchers: FSWatcher[] = [watch(configDir, (_event, file) => file === 'settings.json' && reload())];

  // The Chrome pane's paired socket with the extension (architecture.md § Pane socket).
  const paneLink = new PaneLink({
    origin: `chrome-extension://${PANE_EXTENSION_ID}`,
    file: join(home, 'chrome-pane.json'),
    enabled: () => config.settings.web.chromePane,
    now: deps.now,
    log: deps.log,
    message: (message) => pane.extensionMessage(message),
    changed: () => pane.update(),
  });
  // The Chrome pane helper, started while a page needs the pane (architecture.md § Pane helper).
  const paneHelper = new PaneHelper({
    start: options.startPaneHelper ?? (() => startPaneHelper(home)),
    report: (report) => {
      if (!pane.helperReport(report)) {
        deps.log(`pane helper: a report for an old marker: ${report.state}`);
      }
    },
    stopped: (error) => pane.helperStopped(error),
    log: deps.log,
    now: deps.now,
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  });
  // Pages whose own focus is on, and the page whose pane window has the focus, which counts as the page's (architecture.md § Pane state).
  const focusedPages = new Set<string>();
  // The installed page a dock click opens a work item in, and the page that raises needs-you alerts (architecture.md § Web page).
  const pageTargets = new PageTargets();
  let paneFocusedFor: string | null = null;
  const pane: PaneState = new PaneState({
    enabled: () => config.settings.web.chromePane,
    extension: () => paneLink.state(),
    toExtension: (message) => paneLink.send(message),
    toHelper: (order) => paneHelper.send(order),
    want: (on) => paneHelper.want(on),
    toPage: (key, view) => conversation.notify(key, 'pane', { pane: view }),
    pages: () => conversation.pages(),
    selected: (key) => scopes.scope(key)?.workItemId ?? null,
    tabsOf: (key) => {
      const workItemId = scopes.scope(key)?.workItemId ?? null;
      const dock = views().dock;
      const row = workItemId === null ? null : dockRowOf(dock, workItemId);

      const tabs = row === null ? null : paneTabs(row, dock.groups.find((group) => group.rows.includes(row))?.key ?? null);

      return tabs === null ? null : { workItemId: workItemId!, ...tabs };
    },
    focused: (key, focused) => {
      paneFocusedFor = focused ? key : paneFocusedFor === key ? null : paneFocusedFor;

      if (focused) {
        focusedWindow = key;
        voice.windowGained(deps.now());
      } else if (focusedWindow === key && !focusedPages.has(key)) {
        focusedWindow = null;
      }

      voice.update();
    },
    log: deps.log,
  });

  // Each window sees only its own work item (architecture.md § Window scope); views are built off the main thread and published whole.
  const scopes = new WindowScopes({ store, windows, now: deps.now });
  const doneSearch = new DoneSearch();
  /** A done work item's ID and ticket by its row key, for a row the dock's search found before the Done list (PRD R63). */
  const olderRow = (rowKey: string): { id: number; ticket: { hostWindow?: string | null } } | undefined => {
    const item = /^item:(\d+)$/.test(rowKey) ? store.workItem(Number(rowKey.slice(5))) : null;
    const ticket = item === null || item.status !== 'done' ? null : store.ticket(item.ticketId);

    return item === null || ticket === null ? undefined : { id: item.id, ticket };
  };
  const builtListeners: Array<() => void> = [];
  const builder = new SnapshotBuilder({
    inputs: () => runtime.snapshotInputs(),
    inThread: (inputs) => {
      const snapshot = buildSnapshot(store, inputs);

      return { snapshot, dock: dockView(snapshot, inputs.now, windows) };
    },
    onBuilt: (built) => published(built),
    worker: options.snapshotWorker === undefined ? null : { script: options.snapshotWorker, data: { kind: 'snapshot', db: join(home, 'switchboard.db'), windows } },
    now: deps.now,
    log: deps.log,
  });
  // The window in front, which the voice follows (architecture.md § Voice).
  let focusedWindow: string | null = null;
  // What a window's view and the web page read of the settings, in each `hello` and again when settings.json is reloaded.
  const viewSettings = (): ViewSettings => ({ expandReplies: config.settings.voice.expandReplies, diffLayout: config.settings.web.diffLayout, diffWrap: config.settings.web.diffWrap });
  // The page's list and header, sent again when the voice changes the dock's view; set once the conversation service exists.
  let pageListChanged = (): void => {};
  const builtNow = (): void => {
    pageListChanged();

    for (const listener of builtListeners) {
      listener();
    }
  };
  // The page keys of paired devices' pages, which cannot take the voice back to this computer (architecture.md § Remote access).
  const remotePages = new Set<string>();
  // The voice socket of a paired device (architecture.md § Remote access).
  const voiceSockets = new VoiceSockets({
    now: deps.now,
    log: (line) => deps.log(line),
    opened: (device) => voice.phoneOpened(device.key),
    closed: (_device, reason) => voice.phoneClosed(reason),
    message: (_device, data) => voice.phoneMessage(data),
    audio: (device, data) => voice.phoneAudio(device.key, data),
  });
  const voice: VoiceControl = new VoiceControl({
    link: new VoiceLink({ home, nodePath: () => config.settings.sessions.nodePath, log: (line) => deps.log(line), now: deps.now, sleep: deps.sleep }),
    settings: () => config.settings.voice,
    viewSettings: () => viewSettings(),
    store,
    windows: { keys: () => scopes.keys(), scope: (key) => scopes.scope(key) },
    focusedWindow: () => focusedWindow,
    // Voice on a phone (architecture.md § Remote access): its voice socket, and whether its page has the focus.
    phone: {
      send: (message) => voiceSockets.send(message),
      sendBinary: (data) => voiceSockets.sendBinary(data),
      close: (reason) => voiceSockets.close(() => true, reason),
    },
    pageFocused: (key) => focusedPages.has(key),
    remotePage: (key) => remotePages.has(key),
    full: (sessionId) => {
      const session = store.session(sessionId);

      return session !== null && sessionView(session, true, config.settings.sessions.installHooks).conversation === 'full';
    },
    session: (sessionId) => {
      const session = store.session(sessionId);

      return session === null ? null : { workItemId: session.workItemId, cwd: session.cwd };
    },
    persona: (sessionId) => personaById(config.settings.voice, store.session(sessionId)?.personaId),
    // Spoken alerts (architecture.md § Spoken alerts): the work item's title and what an answer reads.
    alertText: (sessionId, cause) => {
      const session = store.session(sessionId);
      const item = session === null ? null : store.workItem(session.workItemId);

      if (session === null || item === null) {
        return null;
      }

      const latest = [...store.conversation(sessionId, null, 20, false).items].reverse().find((one) => one.type === 'reply' && one.kind === 'reply' && !one.withdrawn && one.rewrittenBy === null);
      const reply = latest?.type === 'reply' ? { speak: latest.speak ?? null, opening: latest.opening } : null;

      return { title: store.ticket(item.ticketId)?.title ?? '', detail: alertDetail(cause, session.state === 'waiting', reply, store.latestStatus(sessionId)?.markdown ?? null) };
    },
    replyChanged: (replyId) => conversation.replyUpdated(replyId),
    notify: (key, type, payload) => conversation.notify(key, type, payload),
    // Dictation (architecture.md § Dictation).
    busy: (sessionId) => store.session(sessionId)?.state === 'running',
    lastReply: (sessionId) => {
      const items = store.conversation(sessionId, null, 20, false).items;

      const latest = [...items].reverse().find((item) => item.type === 'reply' && item.kind === 'reply' && !item.withdrawn && item.rewrittenBy === null && item.opening !== '');

      return latest?.type === 'reply' ? latest.opening : null;
    },
    originRepo: async (cwd) => {
      const result = await deps.exec('git', ['remote', 'get-url', 'origin'], { cwd, timeoutMs: 5_000 });

      return result.code === 0 ? parseRemote(result.stdout) : null;
    },
    dictate: (key, sessionId, text, pieces, partial, interrupted) => conversation.dictate(key, sessionId, text, pieces, partial, interrupted ?? null),
    enrolledAt: () => enrolledAt(home),
    fragmentsDir: join(home, 'voice'),
    // The dock's mic mark and voice note are added to its view as it is sent.
    dockChanged: builtNow,
    now: deps.now,
    log: deps.log,
  });
  // The web page's console of a held session (architecture.md § Web page).
  /**
   * Runs a VS Code control of a work item's row from the page (architecture.md § Web page): opens or brings forward the row's window and leaves it
   * the dock's command for the label, or `command` in its place, after checking the row offers the label now: why not, or null.
   */
  const commandInWindow = (workItemId: number, label: string, command?: Record<string, unknown>): string | null => {
    const row = dockRowOf(views().dock, workItemId);
    const built = row === null ? { refused: 'The work item is gone.' } : pageCommandOf(row, label);

    if ('refused' in built) {
      return built.refused;
    }

    const destination = built.destination;
    const left = command ?? built.command;
    // A window not open yet shows its tabs once it opens, as one the dock opens does (PRD R72); a folder window has none.
    const ids = [...(row!.window?.file != null && scopes.keysOf(destination).length === 0 ? [{ type: 'openTabs' }] : []), ...(left === null ? [] : [left])].map((one) => windowQueue.recordCommand(one, destination));

    if (ids.includes(null)) {
      ids.forEach((id) => id !== null && windowQueue.withdrawCommand(id));
      return 'The hub could not save the command; see its log.';
    }

    try {
      launch.openCode(destination);
    } catch (error) {
      ids.forEach((id) => windowQueue.withdrawCommand(id!));
      return `VS Code did not start: ${(error as Error).message}`;
    }

    askToClaim(destination);
    deps.log(`page: ${label}${command === undefined ? '' : ` (${String(command['type'])})`} for work item ${workItemId} in ${destination}`);
    return null;
  };
  // The web page's Changes list and diffs, read with git in the page's selected conversation's folder (architecture.md § Web page).
  const pageChanges = new PageChanges({
    isPage: (key) => scopes.isPage(key),
    scope: (key) => scopes.scope(key),
    openFile: (workItemId, path, line) => commandInWindow(workItemId, OPEN_IN_VSCODE, { type: 'openFile', path, line }),
    viewed: { list: (workItemId) => store.viewedFiles(workItemId), set: (workItemId, path, hash) => store.setViewedFile(workItemId, path, hash, deps.now()) },
    viewedChanged: (workItemId, from, payload) => {
      for (const key of conversation.pages()) {
        if (key !== from && scopes.scope(key)?.workItemId === workItemId) {
          conversation.notify(key, 'viewed', { workItemId, ...payload });
        }
      }
    },
  });
  const pageConsole = new PageConsole({
    isPage: (key) => scopes.isPage(key),
    scope: (key) => scopes.scope(key),
    session: (id) => store.session(id),
    view: (session, handlers) => runtime.viewHeld(session, handlers),
    reserve: (sessionId, launch) => runtime.reserveInput(sessionId, launch),
    write: (session, data) => runtime.writeHeld(session, data, true),
    size: (session, cols, rows) => runtime.sizeHeld(session, cols, rows),
    log: deps.log,
  });
  const conversation: ConversationService = new ConversationService({
    adapters: changed => [new CodexConversationAdapter({ server: runtime.codexServer, runner: runtime.codexAppServer, store, now: deps.now, newId: randomUUID, log: deps.log, requestsChanged: () => conversation.sessionsChanged() }, changed)],
    store,
    windows: scopes,
    voice: {
      shown: (key) => voice.shown(key),
      settings: () => viewSettings(),
      spokenFor: (sessionId, command) => voice.spokenFor(sessionId, command),
      replyChanged: (reply) => voice.replyChanged(reply),
      talkHere: (key) => voice.talkHere(key),
      stopSpeaking: (key) => voice.stopSpeaking(key),
      setSpeakReplies: (on) => voice.setSpeakReplies(on),
      replay: (key, replyId) => voice.replay(key, replyId),
      update: () => voice.update(),
      selected: (key) => voice.selected(key),
      expressive: () => config.settings.voice.expressive,
      dictated: (key, sessionId) => voice.dictated(key, sessionId),
      interruption: (key, sessionId) => voice.interruption(key, sessionId),
      heard: (tags) => voice.heard(tags),
      delivered: (message) => voice.delivered(message),
      timing: (messageId) => voice.timing(messageId),
      mic: (key, on) => voice.mic(key, on),
      composer: (key, focused, draft) => voice.composer(key, focused, draft),
    },
    personas: () => config.settings.voice,
    pinPersona: (sessionId, personaId) => runtime.send({ type: 'persona', sessionId, personaId }).refused,
    ...claudePaths(claudeRoot, homedir(), Boolean(process.env['CLAUDE_CONFIG_DIR'])),
    screen: (session, scrollback) => runtime.heldScreen(session, scrollback),
    input: { reserve: (sessionId, launch) => runtime.reserveInput(sessionId, launch), write: (session, data) => runtime.writeHeld(session, data), cannotType: () => runtime.heldCannotType() },
    hooks: () => config.settings.sessions.installHooks,
    now: deps.now,
    newId: randomUUID,
    resume: (sessionId) => runtime.resumeThread(sessionId),
    newConversation: (hostWindow, folder, provider) => {
      const { refused } = runtime.send({ type: 'new-conversation', hostWindow, folder, ...(provider === undefined ? {} : { provider }) });
      const made = refused === null ? store.hostedWorkItems(hostWindow)[0] : undefined;

      return made === undefined ? { refused: refused ?? 'The conversation was not made.' } : { workItemId: made.id };
    },
    pageList: () => {
      const built = views();
      const row = voiceRow();

      return pageList(built.dock, built.snapshot, row === null ? null : { row, ...voiceMark(voice.micLive, voice.device === 'phone') });
    },
    pageHeader: () => {
      const built = views();

      return { ...pageHeader({ ...built.dock, notes: withVoiceNote(built.dock.notes) }, built.snapshot), ...(config.settings.voice.enabled && voice.device !== 'computer' ? { voiceDevice: voice.device } : {}) };
    },
    pollSources: () => runtime.pollNow(),
    restartHolder: (detail) => restartHolder(detail),
    // The page's New ad-hoc session runs the dock's `adhoc` and `run-schedule` events.
    operatorEvent: (event) => {
      const parsed = parseAction(event);

      return parsed === null ? 'Unknown action.' : runtime.send(parsed).refused;
    },
    // The list's search further back, as the dock's (PRD R63); a row whose work item is gone meanwhile is left out.
    searchDone: (text, since) => {
      const found = doneSearch.search(store, views().snapshot, runtime.snapshotInputs(), text, since, windows);
      const rows = found.rows.flatMap((row) => {
        const item = store.workItem(Number(/^item:(\d+)$/.exec(row.key)?.[1]));
        const ticket = item === null ? null : store.ticket(item.ticketId);

        return item === null ? [] : [pageRow(row, item.id, ticket?.hostWindow ?? null)];
      });

      return { rows, more: found.more };
    },
    // The page's source icons turn a source on or off as the dock's do (architecture.md § Web page).
    setSource: (name, enabled) => {
      const error = runtime.setSourceEnabled(name, enabled);

      if (error === null) {
        configChanged();
      }

      return error;
    },
    // The page's row actions run as the dock's, rechecked against the row as it is now (architecture.md § Web page).
    rowAction: (workItemId, label, extra) => {
      const row = dockRowOf(views().dock, workItemId);
      const built = row === null ? { refused: 'The work item is gone.' } : pageActionEvent(row, label, extra);

      if ('refused' in built) {
        return built.refused;
      }

      const parsed = parseAction(built.event);

      return parsed === null ? 'The work item no longer offers this.' : runtime.send(parsed).refused;
    },
    // The page's Resume: the attach terminal's resume of a Code Mode session or an ended registered one, without the terminal, or a Codex
    // app-server thread's.
    resumeSession: async (sessionId) => {
      const session = store.session(sessionId);

      if (session !== null && (session.codeMode === true || resumesHeld(session))) {
        const result = await runtime.attach(sessionId);

        return 'refused' in result ? result.refused : null;
      }

      return session?.execution === 'app-server' ? runtime.resumeThread(sessionId) : 'This session resumes only in Claude.';
    },
    // A pool ticket's controls, which the page runs from its row's menu, rechecked against the row as it is now (architecture.md § Web page).
    poolAction: (ticketId, label, extra) => {
      const row = poolRowOf(views().dock, ticketId);
      const built = row === null ? { refused: 'The ticket is no longer in the pool.' } : pageActionEvent(row, label, extra);

      if ('refused' in built) {
        return built.refused;
      }

      const parsed = parseAction(built.event);

      return parsed === null ? 'The ticket no longer offers this.' : runtime.send(parsed).refused;
    },
    // The page's VS Code controls: the dock's command left for the row's window, which VS Code opens or brings forward (architecture.md § Web page).
    rowCommand: (workItemId, label) => commandInWindow(workItemId, label),
    // The installed page's link, opened in the default browser only when its row holds it now (architecture.md § Web page).
    rowOpen: (rowKey, url) => {
      const row = views().dock.groups.flatMap((group) => group.rows).find((one) => one.key === rowKey) ?? null;
      const target = row === null ? null : rowOpenUrl(row, url);

      if (target === null) {
        return row === null ? 'The work item is gone.' : 'The work item no longer links to this.';
      }

      try {
        launch.openUrl(target);
        return null;
      } catch (error) {
        return `The browser did not open ${url}: ${(error as Error).message}`;
      }
    },
    rowPaste: async (workItemId, label) => {
      const paste = dockRowOf(views().dock, workItemId)?.pastes.find((one) => one.label === label);

      return paste === undefined ? null : pasteText(paste.file);
    },
    // A focused, visible page counts as a focused window for the voice (architecture.md § Web page).
    pageFocused: (key, focused, notify) => {
      if (notify !== undefined) {
        pageTargets.notifies(key, notify);
      }

      if (focused) {
        focusedPages.add(key);
        pageTargets.focused(key);
        pane.pageFocused(key);
        focusedWindow = key;
        voice.windowGained(deps.now());
      } else {
        focusedPages.delete(key);

        // Focus in the page's pane window is the page's own (architecture.md § Pane state).
        if (focusedWindow === key && paneFocusedFor !== key) {
          focusedWindow = null;
        }
      }

      voice.update();
    },
    // A hosted conversation is titled by its first message (architecture.md § Hosted conversations).
    messageAdded: (workItemId, text) => {
      const item = store.workItem(workItemId);
      const ticket = item === null ? null : store.ticket(item.ticketId);

      if (ticket?.hostWindow != null && ticket.title === NEW_CONVERSATION_TITLE) {
        runtime.send({ type: 'conversation-title', workItemId, text });
      }
    },
    log: deps.log,
  });
  pageListChanged = () => conversation.pageListChanged();
  /** A finished build: windows bound to a new work item start from empty, and every stream gets the new views. */
  let announced: Snapshot | null = null;
  const published = (built: Built): void => {
    conversation.scopesChanged(scopes.update(built.snapshot));
    conversation.sessionsChanged();
    pane.update();

    // The dock or a web page says when a work item starts needing the operator, which the windows no longer see (PRD R65).
    const newly = newlyNeeding(announced, built.snapshot);
    const newlyNeedingIds = newly.map((item) => item.id);
    const needing = newly.flatMap((item) => {
      const rowKey = rowFor(built.snapshot, { workItemId: item.id });

      return rowKey === null ? [] : [{ rowKey, workItemId: item.id, message: needsMessage(item) }];
    });

    announced = built.snapshot;

    // Spoken alerts for the live Code Mode sessions' turns and waits; a work item alerted gets no needs-you sound as well (architecture.md § Spoken alerts).
    const alerted = voice.sessionsChanged(
      built.snapshot.workItems.flatMap((item) =>
        item.sessions.flatMap((session) =>
          session.state !== 'ended' && sessionView(session, true, config.settings.sessions.installHooks).conversation === 'full' ? [{ sessionId: session.id, workItemId: item.id, kind: alertKind(session) }] : [],
        ),
      ),
    );
    // The needs-you sound, for a work item other than the voice target's (architecture.md § Voice).
    const targetSession = voice.target === null ? null : store.session(voice.target);
    const unalerted = newlyNeedingIds.filter((id) => !alerted.includes(id));
    const chimed = voice.needsYou(unalerted, targetSession?.workItemId ?? null);

    // One surface, `alerts.surface`, shows each needs-you message: a web page or the dock (architecture.md § Dock, Needs you).
    if (needing.length > 0) {
      const page = pageTargets.alerting(config.settings.alerts.surface);

      if (page === null) {
        sendDock('needs', { items: needing.map(({ rowKey, message }) => ({ rowKey, message })) });
      } else {
        // The page sounds only where neither the voice's chime nor a spoken alert does, so one event makes one sound.
        const sound = config.settings.voice.needsYouSound && !chimed && voice.pageMaySound(page) && unalerted.some((id) => id !== targetSession?.workItemId);

        conversation.pageNeeds(page, needing.map(({ workItemId, message }) => ({ workItemId, message })), sound);
      }
    }

    for (const listener of builtListeners) {
      listener();
    }
  };
  /** The latest views; on the main thread, built again when a change came since, so a reader sees it at once. */
  /**
   * Restart and resume (architecture.md § Restarting the holder): `detail`, the confirmation the operator accepted, must still be the one the view
   * asks, so a session that started a turn while the operator read it is never interrupted unnamed. Without one, as from an older client, it runs.
   */
  const restartHolder = (detail: unknown): string | null => {
    if (typeof detail === 'string' && detail !== views().dock.holderNotice?.confirm?.detail) {
      return 'The held sessions changed since you were asked. Press Restart and resume again to see them.';
    }

    return runtime.restartHolder();
  };
  const views = (): Built => (builder.inThread && builder.dirty ? builder.buildNow() : (builder.latest() ?? builder.buildNow()));

  /** The dock view with each terminal's command, from the settings as they are now; each row's workspace file is written first. */
const dockWithRuns = () => {
    const view = views().dock;

    // The dock opens a row's item window from its file, so the file is there before the view is.
    // A hosted conversation's row names its host's window, whose file the host's primary work item writes.
    for (const window of view.groups.flatMap((group) => group.rows.flatMap((row) => (row.window === null || row.window.hosted === true ? [] : [row.window])))) {
      try {
        writeWorkspaceFile(window, written);
      } catch (error) {
        deps.log(`workspace file ${window.file} not written: ${String(error)}`);
      }
    }

    const executable = (terminal: DockTerminal): DockTerminal => ({ ...terminal, ...terminalRun(terminal) });

    // The voice target's row has the mic mark, and a voice problem is a note: no window shows another's or a global one (architecture.md § Voice).
    const activeRow = voiceRow();

    return {
      ...view,
      openIn: config.settings.dock.openIn,
      notes: withVoiceNote(view.notes),
      ...(view.held === undefined ? {} : { held: view.held.map((one) => (one.terminal === null ? one : { ...one, terminal: executable(one.terminal) })) }),
      groups: view.groups.map((group) => ({
        ...group,
        rows: group.rows.map((row) => ({
          ...row,
          open: row.open?.type === 'terminal' ? { ...executable(row.open), type: 'terminal' as const } : row.open,
          terminal: row.terminal === null ? null : executable(row.terminal),
          voice: row.key === activeRow ? voiceMark(voice.micLive, voice.device === 'phone') : null,
          controls: [...row.controls, ...personaControls(row.key)],
        })),
      })),
    };
  };
  const dockRows = () => dockWithRuns().groups.flatMap((group) => group.rows);

  /** The row of the voice target's work item, which has the mic mark in the dock and on the page (architecture.md § Voice), or null. */
  function voiceRow(): string | null {
    const targetSession = voice.target === null ? null : store.session(voice.target);

    return targetSession === null ? null : `item:${targetSession.workItemId}`;
  }

  /** The dock's notes with the voice's problem last, as the dock and the page show them (architecture.md § Voice). */
  function withVoiceNote(notes: string[]): string[] {
    const voiceError = voice.dockError();
    const withError = voiceError === null ? notes : [...notes, `Voice: ${voiceError}`];

    return voice.device === 'none' && config.settings.voice.enabled ? [...withError, NO_VOICE_DEVICE] : withError;
  }

  /**
   * A row's Persona menu (architecture.md § Personas): with `voice.enabled` on and a roster, each persona for the work item's current Code Mode
   * session, the session's own checked, and Clear pin while one is pinned.
   */
  function personaControls(rowKey: string): DockRow['controls'] {
    const voiceSettings = config.settings.voice;
    const workItemId = rowKey.startsWith('item:') ? Number(rowKey.slice(5)) : null;
    const session = workItemId === null ? null : (store.sessionsFor(workItemId).at(-1) ?? null);

    if (!voiceSettings.enabled || voiceSettings.personas.length === 0 || session === null || (session.codeMode !== true && session.execution !== 'app-server')) {
      return [];
    }

    const pinned = session.personaPinned === true;
    const action = (personaId: string | null) => ({ type: 'persona', sessionId: session.id, personaId });

    return [
      ...voiceSettings.personas.map((persona) => ({
        label: pinned && session.personaId === persona.id ? `${persona.name} (pinned)` : persona.name,
        glyph: '',
        action: action(persona.id),
        group: 'Persona',
        checked: session.personaId === persona.id,
      })),
      ...(pinned ? [{ label: 'Clear pin', glyph: '', action: action(null), group: 'Persona', checked: false }] : []),
    ];
  }

  runtime.onChange(() => builder.schedule());
  runtime.setConversationReader({ read: (sessionIds) => conversation.readNow(sessionIds), catchUp: (sessionId) => conversation.catchUp(sessionId), continueAfterLimit: (sessionId, text, guard) => conversation.continueAfterLimit(sessionId, text, guard) });

  await runtime.startup();
  runtime.start();
  conversation.start();

  // The Settings editor's routes (PRD R54): the dock posts them with the hub token, and the web page as page commands (architecture.md § Settings window).
  const settingsRoutes = {
    // settings.json with its version, and what the editor offers.
    read: async () => ({
      status: 200,
      body: {
        settings: readConfigFile(configDir),
        configDir,
        permissionModes: [...PERMISSION_MODES],
        codexPermissionModes: [...CODEX_PERMISSION_MODES],
        providers: [...PROVIDERS],
        templateVariables: [...TEMPLATE_VARIABLES],
        sourceKinds: [...SOURCE_KINDS],
        inUse: openPlaybooks(runtime),
        enabled: Object.fromEntries(Object.keys(config.settings.sources).map((name) => [name, runtime.enabledSources().has(name)])),
      },
    }),
    // The Voice page's Enroll my voice (architecture.md § Voice check and barge-in): starts or cancels enrolment, or reads how it stands.
    enroll: async (body: unknown) => {
      const action = isRecord(body) ? body['action'] : undefined;

      if (action !== 'start' && action !== 'cancel' && action !== 'status') {
        return { status: 400, body: { error: "Expected {action: 'start' | 'cancel' | 'status'}." } };
      }

      const refused = action === 'status' ? null : voice.enroll(action);

      return refused === null ? { status: 200, body: { enrollment: voice.enrollment() } } : { status: 409, body: { error: refused, enrollment: voice.enrollment() } };
    },
    check: async (body: unknown) =>
      isRecord(body) && 'settings' in body ? { status: 200, body: { errors: checkSettings(body['settings'], runtime.enabledSources(), store.homeRepos()) } } : { status: 400, body: { error: 'Expected {settings}.' } },
    save: async (body: unknown) => {
      const version = isRecord(body) ? body['version'] : undefined;

      if (!isRecord(body) || !('value' in body) || !(version === null || typeof version === 'string')) {
        return { status: 400, body: { error: 'Expected {value, version}.' } };
      }

      const moved = movedFrom(body['configDir']);

      if (moved !== null) {
        return { status: 409, body: { errors: [moved] } };
      }

      const result = saveSettings(configDir, body['value'], version, runtime.enabledSources(), store.homeRepos());

      return result.errors.length === 0 ? { status: 200, body: { saved: true, version: result.version } } : { status: 409, body: { errors: result.errors } };
    },
    // The view options menu's Expand spoken replies (architecture.md § Conversation view): sets `voice.expandReplies` in settings.json as a
    // Settings save would, leaving the rest of the file as it is; the reload sends every window and page the new value.
    expandReplies: async (body: unknown) => {
      const on = isRecord(body) ? body['on'] : undefined;

      if (typeof on !== 'boolean') {
        return { status: 400, body: { error: 'Expected {on}.' } };
      }

      const file = readConfigFile(configDir);

      if (file.error !== null || !isRecord(file.value)) {
        return { status: 409, body: { error: file.error ?? 'settings.json is not a JSON object. Fix it in Settings.' } };
      }

      // A file Settings could not save is left for Settings to fix, so no invalid entry, such as a voice that is not an object, is dropped here.
      const invalid = checkSettings(file.value, runtime.enabledSources(), store.homeRepos());

      if (invalid.length > 0) {
        return { status: 409, body: { error: invalid.join(' ') } };
      }

      const voiceIn = file.value['voice'];
      const value = { ...file.value, voice: { ...(isRecord(voiceIn) ? voiceIn : {}), expandReplies: on } };
      const result = saveSettings(configDir, value, file.version, runtime.enabledSources(), store.homeRepos());

      return result.errors.length === 0 ? { status: 200, body: { expandReplies: on } } : { status: 409, body: { error: result.errors.join(' ') } };
    },
  };

  const debriefTimer = setInterval(() => void debriefs.scan(), DEBRIEF_SCAN_MS);

  return {
    runtime,
    post: {
      '/report': async (body) => {
        const report = parseReport(body);

        if (report === null) {
          const error = 'Expected {sessionId, kind, stage|path|reason|prompt|label and target}.';

          if (isRecord(body) && typeof body['sessionId'] === 'string') {
            runtime.refuseReport(body['sessionId'], body, error);
          }

          return { status: 400, body: { error } };
        }

        const native = isRecord(body) && typeof body['nativeSessionId'] === 'string' ? body['nativeSessionId'] : null;
        const { refused } = await runtime.report(report, native);

        return refused === null ? { status: 200, body: { recorded: true } } : { status: 409, body: { error: refused } };
      },
      '/contract': async (body) => {
        // An older contract hook names no source; it runs only after a compaction.
        if (!isRecord(body) || typeof body['nativeSessionId'] !== 'string' || !(body['source'] === undefined || body['source'] === 'compact' || body['source'] === 'resume')) {
          return { status: 400, body: { error: 'Expected {nativeSessionId, source?} with source compact or resume.' } };
        }

        const contract = runtime.contract(body['nativeSessionId'], body['source'] ?? 'compact');

        // A Codex client resumed an ended app-server thread, as Open in terminal does (PRD R107).
        if (body['source'] === 'resume') {
          runtime.threadResumedElsewhere(body['nativeSessionId']);
        }

        return contract === null ? { status: 404, body: { error: 'No Switchboard session has this Claude session ID.' } } : { status: 200, body: { contract } };
      },
      // The register command (PRD R81), which no report contract or usage text lists.
      '/register': async (body) => {
        if (!isRecord(body) || typeof body['nativeSessionId'] !== 'string' || body['nativeSessionId'] === '' || typeof body['title'] !== 'string') {
          return { status: 400, body: { error: 'Expected {nativeSessionId, title}.' } };
        }

        const result = await runtime.register(body['nativeSessionId'], body['title']);

        return 'refused' in result ? { status: 409, body: { error: result.refused } } : { status: 200, body: result };
      },
      // The attach client of a Code Mode session (PRD R95).
      '/attach': async (body) => {
        if (!isRecord(body) || typeof body['sessionId'] !== 'string' || body['sessionId'] === '') {
          return { status: 400, body: { error: 'Expected {sessionId}.' } };
        }

        const result = await runtime.attach(body['sessionId']);

        return 'refused' in result ? { status: result.status, body: { error: result.refused } } : { status: 200, body: result };
      },
      // hub.js holder list and stop (PRD R94).
      '/holder/list': async () => ({ status: 200, body: { sessions: await runtime.listHeld(), holder: runtime.heldHolder(), installed: runtime.holderInstalled() } }),
      '/holder/stop': async (body) => {
        if (!isRecord(body) || typeof body['id'] !== 'string' || body['id'] === '') {
          return { status: 400, body: { error: 'Expected {id}.' } };
        }

        const result = await runtime.stopHeld(body['id']);

        return 'refused' in result ? { status: result.status, body: { error: result.refused } } : { status: 200, body: result };
      },
      // The dock's Restart and resume of a terminal holder from an older build (architecture.md § Restarting the holder).
      '/holder/restart': async (body) => {
        const refused = restartHolder(isRecord(body) ? body['detail'] : undefined);

        return refused === null ? { status: 200, body: { started: true } } : { status: 409, body: { error: refused } };
      },
      // Continue in Background from an item window's Claude tab (PRD R89).
      '/background': async (body) => {
        const { label, hostPid, workItemIds } = isRecord(body) ? body : {};

        // A null label is the Claude sidebar, which has no tab.
        if ((label !== null && (typeof label !== 'string' || label === '')) || !Number.isInteger(hostPid) || !Array.isArray(workItemIds) || !workItemIds.every((id) => Number.isInteger(id))) {
          return { status: 400, body: { error: 'Expected {label, hostPid, workItemIds}.' } };
        }

        const result = await runtime.background(label as string | null, hostPid as number, workItemIds as number[]);

        return 'pid' in result ? { status: 200, body: { pid: result.pid } } : { status: 409, body: { error: result.refused } };
      },
      // Continue in Background's last check before the window closes (PRD R89).
      '/background/check': async (body) => {
        const { hostPid, pid } = isRecord(body) ? body : {};

        if (!Number.isInteger(hostPid) || !Number.isInteger(pid)) {
          return { status: 400, body: { error: 'Expected {hostPid, pid}.' } };
        }

        const alone = await runtime.windowAlone(hostPid as number, pid as number);

        return typeof alone === 'boolean' ? { status: 200, body: { alone } } : { status: 409, body: { error: alone.error } };
      },
      // The ticket report (PRD R83), which no report contract or usage text lists.
      '/ticket': async (body) => {
        const { sessionId, url, playbook, nativeSessionId } = isRecord(body) ? body : {};

        if (typeof sessionId !== 'string' || typeof url !== 'string' || !/^https?:\/\//i.test(url) || !optionalString(playbook) || playbook === '' || !optionalString(nativeSessionId)) {
          return { status: 400, body: { error: 'Expected {sessionId, url, playbook?}.' } };
        }

        const result = await runtime.ticket(sessionId, url, playbook ?? null, nativeSessionId || null);

        return 'refused' in result ? { status: 409, body: { error: result.refused } } : { status: 200, body: result };
      },
      '/handled': async (body) => {
        const { sessionId, url, releaseKey, nativeSessionId } = isRecord(body) ? body : {};
        if (typeof sessionId !== 'string' || typeof url !== 'string' || !/^https?:\/\//i.test(url) || !optionalString(releaseKey) || releaseKey === '' || !optionalString(nativeSessionId)) {
          return { status: 400, body: { error: 'Expected {sessionId, url, releaseKey?}.' } };
        }
        const result = await runtime.handled(sessionId, url, releaseKey ?? null, nativeSessionId || null);
        return 'refused' in result ? { status: 409, body: { error: result.refused } } : { status: 200, body: result };
      },
      '/open': async (body) => {
        if (!isRecord(body) || typeof body['sessionId'] !== 'string' || typeof body['cwd'] !== 'string' || !optionalString(body['workspace']) || !optionalString(body['window'])) {
          return { status: 400, body: { error: 'Expected {sessionId, cwd, workspace?, window?}.' } };
        }

        const sessionId = body['sessionId'];
        const session = store.session(sessionId) ?? store.sessionByNativeId(sessionId);
        const window = typeof body['window'] === 'string' ? body['window'] : null;
        // The destination window (architecture.md § Window scope): the window that asked, for a session of its own conversations, else the
        // session's own window, its host's for a hosted conversation. A workspace the caller names must be that window, so no caller can route
        // another work item's session to a window of its choice; only a session the store does not know goes where the caller names.
        const asker = window !== null && session !== null && scopes.holds(window, session.workItemId) ? scopes.hostOf(window) : null;
        const own = session === null ? null : itemWindowFile(session.workItemId);
        const named = body['workspace'] ?? null;

        if (asker === null && session !== null && named !== null && (own === null || hostKey(named) !== hostKey(own))) {
          return { status: 409, body: { error: 'The session opens only in its own window.' } };
        }

        const workspace = asker ?? (session === null ? named : own);

        if (workspace === null) {
          return { status: 409, body: { error: 'The session has no window to open it in.' } };
        }

        const id = windowQueue.recordOpen(sessionId, body['cwd'], workspace);

        if (id === null) {
          return { status: 500, body: { error: 'The hub could not save the open; see its log.' } };
        }

        deps.log(`session ${sessionId} left for ${workspace}`);
        askToClaim(workspace);

        // `here`: the destination is the asking window, which then claims at once, since it gains no focus; a folder window cannot tell from the path.
        const mine = window === null ? null : scopes.hostOf(window);

        return { status: 200, body: { recorded: true, id, workspace, here: mine !== null && hostKey(mine) === hostKey(workspace) } };
      },
      '/history': async (body) => {
        if (!isRecord(body) || !Number.isInteger(body['ticketId']) || typeof body['window'] !== 'string') {
          return { status: 400, body: { error: 'Expected {window, ticketId, revision?}.' } };
        }

        const ticketId = body['ticketId'] as number;

        // A window reads only its own work item's History, or one the dock sent it (architecture.md § Window scope).
        if (!scopes.allowsTicket(body['window'], ticketId, views().snapshot)) {
          return { status: 403, body: { error: 'Not in this window.' } };
        }

        // A reader that names the revision it shows gets the full history only when it changed.
        if (typeof body['revision'] === 'string' && store.ticket(ticketId) !== null && store.historyRevision(ticketId) === body['revision']) {
          return { status: 200, body: { unchanged: true } };
        }

        const history = store.ticketHistory(ticketId);

        return history === null ? { status: 409, body: { error: `Unknown ticket ${body['ticketId']}.` } } : { status: 200, body: history };
      },
      '/v1/conversation/send': async (body) => (isRecord(body) ? conversation.send(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, text, command?}.' } }),
      // `installed` lets the dock skip its provider choice when only one CLI is found (PRD R104).
      '/v1/conversation/providers': async () => ({ status: 200, body: { defaultProvider: config.settings.sessions.provider, installed: await installedProviders(config.settings.sessions) } }),
        '/v1/conversation/answer': async (body) => isRecord(body) ? conversation.answer(body) : { status: 400, body: { error: 'Expected a request answer.' } },
      '/v1/conversation/history': async (body) => (isRecord(body) ? conversation.history(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, before, limit?}.' } }),
      '/v1/conversation/seen': async (body) => (isRecord(body) ? conversation.seen(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, ids}.' } }),
      '/v1/conversation/select': async (body) => (isRecord(body) ? conversation.select(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, workItemId}.' } }),
      '/v1/conversation/new-conversation': async (body) => (isRecord(body) ? conversation.newConversation(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId}.' } }),
      '/v1/conversation/statuses': async (body) => (isRecord(body) ? conversation.statuses(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, before, limit?}.' } }),
      '/v1/conversation/commands': async (body) => (isRecord(body) ? conversation.commands(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId}.' } }),
      '/v1/conversation/talk-here': async (body) => (isRecord(body) ? conversation.voiceCommand('talk-here', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId}.' } }),
      '/v1/conversation/stop-speaking': async (body) => (isRecord(body) ? conversation.voiceCommand('stop-speaking', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId}.' } }),
      '/v1/conversation/speak-replies': async (body) => (isRecord(body) ? conversation.voiceCommand('speak-replies', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, on}.' } }),
      '/v1/conversation/replay': async (body) => (isRecord(body) ? conversation.voiceCommand('replay', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, replyId}.' } }),
      '/v1/conversation/personas': async (body) => (isRecord(body) ? conversation.personaCommand('personas', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId}.' } }),
      '/v1/conversation/row-action': async (body) => (isRecord(body) ? conversation.rowAction(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, workItemId, label}.' } }),
      '/v1/conversation/prompt': async (body) => (isRecord(body) ? conversation.prompt(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId}.' } }),
      '/v1/conversation/console-input': async (body) => (isRecord(body) ? pageConsole.input(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, data, cols?, rows?}.' } }),
      '/v1/conversation/prompt-key': async (body) => (isRecord(body) ? conversation.promptKey(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, prompt, key}.' } }),
      '/v1/conversation/page-conversation': async (body) => (isRecord(body) ? conversation.pageConversation(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, provider?}.' } }),
      '/v1/conversation/resume': async (body) => (isRecord(body) ? conversation.resume(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId}.' } }),
      '/v1/conversation/pool-action': async (body) => (isRecord(body) ? conversation.poolAction(body) : { status: 400, body: { error: 'Expected {window, opId, ticketId, label}.' } }),
      '/v1/conversation/row-command': async (body) => (isRecord(body) ? conversation.rowCommand(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, workItemId, label}.' } }),
      '/v1/conversation/row-open': async (body) => (isRecord(body) ? conversation.rowOpen(body) : { status: 400, body: { error: 'Expected {window, opId, workItemId, url}.' } }),
      '/v1/conversation/row-paste': async (body) => (isRecord(body) ? conversation.rowPaste(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, workItemId, label}.' } }),
      '/v1/conversation/page-history': async (body) => (isRecord(body) ? conversation.pageHistory(body) : { status: 400, body: { error: 'Expected {window, ticketId}.' } }),
      '/v1/conversation/page-poll': async (body) => (isRecord(body) ? conversation.pagePoll(body) : { status: 400, body: { error: 'Expected {window}.' } }),
      // Voice on the computer from this computer's page, taking the voice back from the phone (architecture.md § Remote access).
      '/v1/conversation/page-voice-computer': async (body) => {
        if (!isRecord(body) || typeof body['window'] !== 'string') {
          return { status: 400, body: { error: 'Expected {window}.' } };
        }

        if (!scopes.isPage(body['window'])) {
          return { status: 403, body: { error: 'Not in this window.' } };
        }

        const refused = voice.toComputer(body['window']);

        return refused === null ? { status: 200, body: { device: 'computer' } } : { status: 409, body: { error: refused } };
      },
      '/v1/conversation/page-holder-restart': async (body) => (isRecord(body) ? conversation.pageHolderRestart(body) : { status: 400, body: { error: 'Expected {window}.' } }),
      '/v1/conversation/page-adhoc': async (body) => (isRecord(body) ? conversation.pageAdhoc(body) : { status: 400, body: { error: 'Expected {window, opId, prompt, repoRoot, start, provider}.' } }),
      '/v1/conversation/page-folder-conversation': async (body) => (isRecord(body) ? conversation.pageFolderConversation(body) : { status: 400, body: { error: 'Expected {window, opId, folder, provider?}.' } }),
      // A changed file opened at a line in the work item's VS Code window (architecture.md § Web page).
      // A changed file ticked viewed, or its tick cleared, for every device (architecture.md § Web page).
      '/v1/conversation/viewed': async (body) => (isRecord(body) ? pageChanges.viewedCommand(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, path, hash, viewed}.' } }),
      '/v1/conversation/open-file': async (body) => (isRecord(body) ? pageChanges.openFileCommand(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, path, line}.' } }),
      '/v1/conversation/page-search': async (body) => (isRecord(body) ? conversation.pageSearch(body) : { status: 400, body: { error: 'Expected {window, text, since}.' } }),
      // The page's tabs for its work item, kept for every device (architecture.md § Web page).
      '/v1/conversation/page-tabs': async (body) => (isRecord(body) ? conversation.pageTabs(body) : { status: 400, body: { error: 'Expected {window, workItemId, tab?, close?, reopen?, openOn?}.' } }),
      '/v1/conversation/page-source': async (body) => (isRecord(body) ? conversation.pageSource(body) : { status: 400, body: { error: 'Expected {window, name, enabled}.' } }),
      // A one-time token the page hands the Chrome extension to pair it (architecture.md § Pane socket).
      '/v1/conversation/pane-pair': async (body) => {
        if (!isRecord(body) || typeof body['window'] !== 'string') {
          return { status: 400, body: { error: 'Expected {window}.' } };
        }

        if (!scopes.isPage(body['window'])) {
          return { status: 403, body: { error: 'Not in this window.' } };
        }

        if (!config.settings.web.chromePane) {
          return { status: 409, body: { error: 'The Chrome pane is off. Turn on Chrome pane in the dock’s Settings, General page.' } };
        }

        return { status: 200, body: { token: paneLink.pairingToken(), extensionId: PANE_EXTENSION_ID } };
      },
      // A web link the page's conversation shows, opened in the Chrome pane's window rather than a new browser tab (architecture.md § Pane state).
      '/v1/conversation/pane-open': async (body) => {
        const url = isRecord(body) ? body['url'] : undefined;

        if (!isRecord(body) || typeof body['window'] !== 'string' || typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url) || !URL.canParse(url)) {
          return { status: 400, body: { error: 'Expected {window, url} with an http or https URL.' } };
        }

        const workItemId = scopes.isPage(body['window']) ? (scopes.scope(body['window'])?.workItemId ?? null) : null;

        if (workItemId === null) {
          return { status: 403, body: { error: 'Not in this window.' } };
        }

        if (!config.settings.web.chromePane || paneLink.state() !== 'paired') {
          return { status: 409, body: { error: 'The Chrome pane is not connected.' } };
        }

        return pane.open(body['window'], workItemId, url) ? { status: 200, body: { opened: true } } : { status: 409, body: { error: 'The Chrome pane cannot show the link.' } };
      },
      // The page's right column for the Chrome pane, or null (architecture.md § Pane state).
      '/v1/conversation/pane-rect': async (body) => {
        if (!isRecord(body) || typeof body['window'] !== 'string' || !(body['rect'] === null || isRecord(body['rect']))) {
          return { status: 400, body: { error: 'Expected {window, rect}.' } };
        }

        if (!scopes.isPage(body['window'])) {
          return { status: 403, body: { error: 'Not in this window.' } };
        }

        pane.pageRect(body['window'], paneRect(body['rect']), typeof body['seq'] === 'number' ? body['seq'] : undefined);
        return { status: 200, body: { done: true } };
      },
      '/v1/conversation/page-focus': async (body) => (isRecord(body) ? conversation.pageFocus(body) : { status: 400, body: { error: 'Expected {window, focused}.' } }),
      '/v1/conversation/persona': async (body) => (isRecord(body) ? conversation.personaCommand('persona', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, personaId}.' } }),
      '/v1/conversation/mic': async (body) => (isRecord(body) ? conversation.voiceCommand('mic', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, on}.' } }),
      '/v1/conversation/composer': async (body) => (isRecord(body) ? conversation.voiceCommand('composer', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, focused, draft}.' } }),
      '/claim': async (body) => {
        if (!isRecord(body) || typeof body['folder'] !== 'string' || !optionalString(body['workspace']) || !(body['focused'] === undefined || typeof body['focused'] === 'boolean') || !optionalString(body['window'])) {
          return { status: 400, body: { error: 'Expected {folder, workspace?, focused?, window?}.' } };
        }

        const keyed = typeof body['window'] === 'string' && scopes.has(body['window']);
        // A window claims an open only by its key's binding, never by a workspace or folder it names (architecture.md § Window scope).
        const bound = keyed ? scopes.hostOf(body['window'] as string) : null;
        // Commands left for a workspace go only to the window its key binds; a claim with no binding takes only those left for any window.
        const workspace = bound;
        const claimed = windowQueue.claimOpen(bound);
        const attach = claimed === null ? null : codeModeOpen(claimed);
        const sessionId = attach === null ? claimed : null;
        // A History command the dock left lets the window that claims it, named by its key, read that ticket's History. A claim with no key a
        // connected window holds leaves it queued as it was, for the next claim, which has one, since the window could not read that History;
        // it keeps its ID, so the dock can still withdraw it, its time, so it still expires, and its workspace, so it still goes to its window.
        const accepts = (command: Record<string, unknown>) => keyed || command['type'] !== 'history';
        const delivered = [...(attach === null ? [] : [attach]), ...windowQueue.claimCommands(workspace, body['focused'] === true, accepts)].map((command) =>
          command['type'] === 'terminal' ? { ...command, ...terminalRun(command) } : command,
        );

        for (const command of delivered.filter((one) => one['type'] === 'history' && Number.isInteger(one['ticketId']))) {
          scopes.grant(body['window'] as string, command['ticketId'] as number);
        }

        const claimant = workspace ?? (body['folder'] || 'a window with no folder');


        // The log shows whether a window took what the dock left for it (PRD R71).
        if (claimed !== null) {
          deps.log(`session ${claimed} claimed by ${claimant}${attach === null ? '' : ' as its attach terminal'}`);
        }

        if (delivered.length > 0) {
          deps.log(`window commands claimed by ${claimant}: ${delivered.map((command) => String(command['type'])).join(', ')}`);
        }

        // The window opens the session in its provider's view; an unknown one, such as a deleted session's, in Claude's.
        const provider = sessionId === null ? null : (store.sessionByNativeId(sessionId)?.provider ?? 'claude');

        return { status: 200, body: { sessionId, provider, commands: delivered } };
      },
      '/window': async (body) => {
        if (!isRecord(body) || !optionalString(body['workspace']) || !isWindowCommand(body['command'], body['workspace'] ?? null)) {
          return { status: 400, body: { error: 'Expected {workspace, command} with a changes, terminal, history, log or openUrl command, or openTabs for a workspace.' } };
        }

        const id = windowQueue.recordCommand(body['command'], body['workspace'] ?? null);

        if (id === null) {
          return { status: 500, body: { error: 'The hub could not save the command; see its log.' } };
        }

        deps.log(`window command ${id} ${String(body['command']['type'])} left for ${body['workspace'] ?? 'any window'}`);
        askToClaim(body['workspace'] ?? null);

        return { status: 200, body: { id } };
      },
      // The dock withdraws a session it left for a window its click did not reach, so no window opens it later (architecture.md § Dock).
      '/open/withdraw': async (body) => {
        if (!isRecord(body) || !Number.isInteger(body['id'])) {
          return { status: 400, body: { error: 'Expected {id}.' } };
        }

        const withdrawn = windowQueue.withdrawOpen(body['id'] as number);

        if (withdrawn) {
          deps.log(`open ${body['id']} withdrawn`);
        }

        return { status: 200, body: { withdrawn } };
      },
      '/window/withdraw': async (body) => {
        if (!isRecord(body) || !Number.isInteger(body['id'])) {
          return { status: 400, body: { error: 'Expected {id}.' } };
        }

        const withdrawn = windowQueue.withdrawCommand(body['id'] as number);

        if (withdrawn) {
          deps.log(`window command ${body['id']} withdrawn`);
        }

        return { status: 200, body: { withdrawn } };
      },
      '/sources': async (body) => {
        if (!isRecord(body) || typeof body['name'] !== 'string' || typeof body['enabled'] !== 'boolean') {
          return { status: 400, body: { error: 'Expected {name, enabled}.' } };
        }

        const error = runtime.setSourceEnabled(body['name'], body['enabled']);

        if (error === null) {
          // The Settings window reads again, so its source states and checks follow the toggle (PRD R54).
          configChanged();
        }

        return error === null ? { status: 200, body: { done: true } } : { status: 409, body: { error } };
      },
      '/poll': async () => {
        const error = runtime.pollNow();

        return error === null ? { status: 200, body: { done: true } } : { status: 409, body: { error } };
      },
      /**
       * Open in Switchboard (PRD R69): the row of a ticket URL, for the window VS Code gave the link, which runs its click itself because the dock
       * today only calls SetForegroundWindow on an open item window, which Windows refuses a process without the latest input (mechanics M26). The
       * one exception to the window scope rule: the operator asked for that row.
       */
      '/open-url': async (body) => {
        if (!isRecord(body) || typeof body['url'] !== 'string' || body['url'] === '') {
          return { status: 400, body: { error: 'Expected {url}.' } };
        }

        const snapshot = views().snapshot;
        const target = targetForUrl(snapshot, body['url']);
        const rowKey = target === null ? null : rowFor(snapshot, target);
        const row = rowKey === null ? undefined : dockRows().find((one) => one.key === rowKey);

        return row === undefined ? { status: 404, body: { error: `Switchboard has no work item for ${body['url']}` } } : { status: 200, body: { row } };
      },
      // VS Code forwards the click of a row that opens a terminal or nothing, which only the dock runs (PRD R65, R69, R71).
      '/dock/click': async (body) => {
        if (!isRecord(body) || typeof body['rowKey'] !== 'string') {
          return { status: 400, body: { error: 'Expected {rowKey}.' } };
        }

        return clickDock({ rowKey: body['rowKey'] }) ? { status: 202, body: { sent: true } } : { status: 409, body: { error: 'The dock is not running.' } };
      },
      // The dock's search past its Done list (PRD R63): Done rows from `since`, in epoch milliseconds, whose search text holds every word of `text`.
      '/dock/search': async (body) => {
        if (!isRecord(body) || typeof body['text'] !== 'string' || typeof body['since'] !== 'number' || !Number.isFinite(body['since'])) {
          return { status: 400, body: { error: 'Expected {text, since}, the search text and the epoch milliseconds to search from.' } };
        }

        return { status: 200, body: doneSearch.search(store, views().snapshot, runtime.snapshotInputs(), body['text'], body['since'], windows) };
      },
      // A dock row's click (architecture.md § Dock): a hosted conversation becomes its host binding's selection, shown by the window the click opens.
      '/dock/select': async (body) => {
        if (!isRecord(body) || typeof body['rowKey'] !== 'string') {
          return { status: 400, body: { error: 'Expected {rowKey}.' } };
        }

        // A row the search found before the Done list is not in the snapshot (PRD R63).
        const item = views().snapshot.workItems.find((one) => rowKeyOf(one) === body['rowKey']) ?? olderRow(body['rowKey']);

        if (item === undefined) {
          return { status: 404, body: { error: 'No work item has that row.' } };
        }

        const { keys, selected } = scopes.selectFor(item.id, item.ticket.hostWindow ?? null);

        conversation.scopesChanged(keys);
        conversation.conversationsChanged();

        // From slice 9 a row click is also Talk here for its work item's session, when one of its windows is connected (architecture.md § Voice).
        const voiceRefused = config.settings.voice.enabled ? voice.dockSelect(item.id) : null;

        return { status: 200, body: { selected, ...(voiceRefused === null ? {} : { voice: voiceRefused }) } };
      },
      // A dock row's click with `dock.openIn: web`, or its Alt-click (architecture.md § Dock): the installed page used last shows the work item and
      // puts the marker in its title, by which the dock brings its window forward; with no installed page open the dock opens the page at it.
      '/dock/page': async (body, context) => {
        if (!isRecord(body) || typeof body['rowKey'] !== 'string') {
          return { status: 400, body: { error: 'Expected {rowKey}.' } };
        }

        const item = views().snapshot.workItems.find((one) => rowKeyOf(one) === body['rowKey']) ?? olderRow(body['rowKey']);

        if (item === undefined) {
          return { status: 404, body: { error: 'No work item has that row.' } };
        }

        const key = pageTargets.installed();

        if (key !== null) {
          const marker = randomBytes(6).toString('hex');

          conversation.notify(key, 'show', { workItemId: item.id, marker });
          return { status: 200, body: { marker } };
        }

        const page = (await context?.pageUrl()) ?? `http://127.0.0.1:${config.settings.web.port}/page/`;

        return { status: 200, body: { url: `${page}#w=${item.id}` } };
      },
      // The dock reports a session's terminal window coming to the front, or null when it left (architecture.md § Voice): the voice follows it as
      // it follows a window.
      '/dock/focus': async (body) => {
        const sessionId = isRecord(body) ? body['sessionId'] : undefined;
        const at = isRecord(body) ? (body['at'] ?? deps.now()) : undefined;

        if (!(sessionId === null || (typeof sessionId === 'string' && sessionId !== '')) || typeof at !== 'number') {
          return { status: 400, body: { error: 'Expected {sessionId, at?}, a session ID or null and the epoch milliseconds of the change.' } };
        }

        if (sessionId !== null && store.session(sessionId) === null) {
          voice.terminalFocused(null, at);
          return { status: 404, body: { error: 'No session has that ID.' } };
        }

        voice.terminalFocused(sessionId, at);
        return { status: 200, body: { focus: sessionId } };
      },
      // The dock's New conversation in a folder (architecture.md § Hosted conversations): a conversation hosted by a folder, selected there before its window opens.
      '/dock/new-conversation': async (body) => (isRecord(body) ? conversation.dockConversation(body) : { status: 400, body: { error: 'Expected {folder, opId}.' } }),
      '/dock/show': async () =>
        sendDock('show', {}) > 0 ? { status: 200, body: { shown: true } } : { status: 409, body: { error: 'The dock is not running.' } },
      // The dock's Settings window (PRD R54).
      '/config/read': settingsRoutes.read,
      '/config/voice-enroll': settingsRoutes.enroll,
      '/config/check': settingsRoutes.check,
      '/config/save': settingsRoutes.save,
      // The web page's Settings (architecture.md § Web page): the same routes as page commands.
      '/v1/conversation/page-settings-read': settingsRoutes.read,
      '/v1/conversation/page-voice-enroll': settingsRoutes.enroll,
      '/v1/conversation/page-settings-check': settingsRoutes.check,
      '/v1/conversation/page-settings-save': settingsRoutes.save,
      // Expand spoken replies, from a window's view title menu (hub token) or this computer's page's view options menu (page command).
      '/v1/conversation/expand-replies': settingsRoutes.expandReplies,
      '/action': async (body) => {
        const event = parseAction(body);

        if (event === null) {
          return { status: 400, body: { error: 'Unknown action.' } };
        }

        const { refused } = runtime.send(event);

        return refused === null ? { status: 200, body: { done: true } } : { status: 409, body: { error: refused } };
      },
    },
    snapshot: () => runtime.snapshot(),
    windowOpened: (workspace, folder = null) => {
      const key = scopes.open(workspace, builder.latest()?.snapshot ?? null, folder);

      // After the stream registers it, so the voice sees the window.
      setImmediate(() => voice.update());

      return key;
    },
    windowFocused: (key, at) => {
      // VS Code reports a blur when the browser takes the focus, which may arrive after the page reported it has it.
      if (key !== null || focusedWindow === null || !scopes.isPage(focusedWindow)) {
        focusedWindow = key;
      }

      // A VS Code window in front is no session's terminal, unless the dock reported a terminal since that window's change.
      if (key !== null) {
        voice.windowGained(at);
        // A window coming to the front reads its pull requests again (PRD R92).
        runtime.refreshPullRequests();
      }

      voice.update();
    },
    windowFolder: (key) => scopes.folderOf(key),
    windowClosed: (key) => {
      if (focusedWindow === key) {
        focusedWindow = null;
      }

      focusedPages.delete(key);
      remotePages.delete(key);
      pageTargets.closed(key);
      paneFocusedFor = paneFocusedFor === key ? null : paneFocusedFor;
      pane.pageClosed(key);
      scopes.close(key);
      conversation.windowClosed();
      voice.windowClosed(key);
    },
    windowState: (key) => scopes.scoped(key, views().snapshot),
    conversation: (key, write) => conversation.open(key, write),
    page: {
      access: new PageAccess(store, deps.now),
      remote: () => remote,
      asset: (name) => pageAsset(name, home),
      opened: (installed, remote) => {
        const key = scopes.openPage();

        if (remote === true) {
          remotePages.add(key);
        }

        pageTargets.opened(key, installed === true);

        setImmediate(() => {
          voice.update();
          pane.update();
        });
        return key;
      },
      isPage: (key) => scopes.isPage(key),
      list: () => conversation.pageList(),
      files: (key, query) => conversation.files(key, query),
      artifact: (key, name) => conversation.artifactFile(key, name),
      localFile: async (key, target) => {
        const scope = scopes.isPage(key) ? scopes.scope(key) : null;

        if (scope === null || scope.workItemId === null) {
          return null;
        }

        // The conversation's folders: its own, and each of its work item's sessions' working folder and scratchpad (architecture.md § Web page).
        return openLocalFile(localRoots(scope, store.sessionsFor(scope.workItemId), scope.sessionId), target);
      },
      upload: (key, scopeGen, name, bytes) => conversation.pageUpload(key, scopeGen, name, bytes),
      console: (key, sessionId, send, end) => pageConsole.open(key, sessionId, send, end),
      changes: (route, key, query) =>
        route === 'changes'
          ? pageChanges.changes(key)
          : route === 'diff'
            ? pageChanges.diff(key, query.get('path'), query.get('sides'))
            : route === 'file'
              ? pageChanges.file(key, query.get('path'), query.get('side'))
              : Promise.resolve({ status: 404, body: { error: 'not found' } }),
      voice: {
        enabled: () => config.settings.voice.enabled,
        accept: (request, socket, head, device) => voiceSockets.accept(request, socket, head, device),
        close: (match, reason) => voiceSockets.close(match, reason),
      },
    },
    pagePort: () => config.settings.web.port,
    dock: () => dockWithRuns(),
    attachDock: (send) => {
      sendDock = send;
    },
    attachDockClick: (click) => {
      clickDock = click;
    },
    attachRemote: (changed) => {
      remoteChanged = changed;
    },
    attachWindows: (send) => {
      sendWindows = send;
    },
    snoozedUrls: () => store.snoozedTickets(deps.now()).flatMap((ticket) => (ticket.url === '' ? [] : [ticket.url])),
    cards: () => cardsOf(views().snapshot),
    snoozeUrl: (url, until) => {
      const ticket = store.ticketInScopeByUrl(url);

      return ticket === null ? null : { refused: runtime.send({ type: 'snooze', ticketId: ticket.id, until }).refused };
    },
    paneUpgrade: (request, socket, head) => paneLink.upgrade(request, socket, head),
    paneEnabled: () => config.settings.web.chromePane,
    unsnoozeUrl: (url) => {
      const ticket = store.ticketInScopeByUrl(url);

      return ticket === null ? null : { refused: runtime.send({ type: 'restore', ticketId: ticket.id }).refused };
    },
    onChange: (listener) => void builtListeners.push(listener),
    busy: () => runtime.hasActiveSessions() || debriefs.running(),
    quiet: () => runtime.restartBlocker() ?? (conversation.sending() ? 'a message is being sent' : voice.speaking() ? 'the voice is speaking a reply or enrolling' : debriefs.running() ? 'a friction debrief is running' : null),
    close: () => {
      clearTimeout(pending);
      clearInterval(debriefTimer);
      voice.close();
      paneHelper.close();
      paneLink.closeAll();
      pageConsole.close();
      conversation.stop();
      builder.close();
      runtime.stop();

      for (const watcher of watchers) {
        watcher.close();
      }

      store.close();
    },
  };
}

/**
 * Starts the installed Chrome pane helper's current build (architecture.md § Pane helper), reserving its folder and naming it in
 * `pane-helper.json` so an install keeps it, or says why it cannot.
 */
async function startPaneHelper(home: string): Promise<Awaited<ReturnType<PaneHelperDeps['start']>>> {
  if (process.platform !== 'win32') {
    return { error: 'The Chrome pane works on Windows only.' };
  }

  const build = currentHolderBuild(home, PANE_HELPER_INSTALL);

  if (build === null || !(await reserveHolderBuild(home, build, PANE_HELPER_INSTALL))) {
    return { error: 'The Chrome pane helper is not installed. Open a VS Code window with the Switchboard extension, which installs it, then reload this page.' };
  }

  const helper = spawnPaneHelper(join(home, PANE_HELPER_INSTALL.name, build, PANE_HELPER_INSTALL.entry), ['--home', home], spawnEnvironment(process.env));

  try {
    writeFileSync(paneHelperRecordPath(home), JSON.stringify({ build, pid: helper.pid ?? 0 }));
  } catch {
    // Without the record an install may remove the build's other files; the running helper has loaded what it needs.
  }

  return { process: helper };
}

/** Open work items per playbook, so deleting a playbook can say what still uses it. */
function openPlaybooks(runtime: Runtime): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const item of runtime.snapshot().workItems) {
    if (item.status !== 'done' && item.playbook !== null) {
      counts[item.playbook] = (counts[item.playbook] ?? 0) + 1;
    }
  }

  return counts;
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

/** A command the dock leaves for a VS Code window, with the fields the window's handler reads (PRD R71). */
function isWindowCommand(value: unknown, workspace: string | null): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const text = (key: string) => typeof value[key] === 'string' && value[key] !== '';

  switch (value['type']) {
    case 'changes':
      return text('path') && text('key') && typeof value['title'] === 'string';
    case 'history':
      return Number.isInteger(value['ticketId']) && text('key');
    case 'terminal':
      return text('sessionId') && text('cwd') && text('name') && (value['shortId'] === null || text('shortId')) && typeof value['active'] === 'boolean';
    case 'openUrl':
      return text('url');
    case 'log':
      return true;
    // An item window opens its own tabs (PRD R72), so another window cannot take the command.
    case 'openTabs':
      return workspace !== null;
    default:
      return false;
  }
}
