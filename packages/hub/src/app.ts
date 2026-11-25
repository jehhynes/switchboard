import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { claudeSettingsPath, readRoster, spawnExec } from '@switchboard/claude';
import { hostKey, hubBundlePath, SCHEDULE_SOURCE, NEW_CONVERSATION_TITLE, personaById, Store, switchboardHome, ticketRoot } from '@switchboard/core';
import { CODEX_PERMISSION_MODES, PERMISSION_MODES, PROVIDERS, resumesHeld, settingsWarnings, TEMPLATE_VARIABLES } from '@switchboard/core';
import type { FlowEvent, SourceSettings, ViewSettings } from '@switchboard/core';
import { findBash } from './bash.js';
import { cardsOf } from './cards.js';
import { DoneSearch } from './dockSearch.js';
import { dockView, windowsDir, writeWorkspaceFile } from './dock.js';
import { isPastePath } from './report.js';
import { DEBRIEF_SCAN_MS, Debriefs } from './debriefs.js';
import { checkSettings, filePluginPaths, loadConfig, noKind, pluginPaths, readConfigFile, saveSettings } from './config.js';
import { PluginRegistry } from './plugins.js';
import type { Config } from './config.js';
import type { HubApp } from './serve.js';
import { Runtime } from './runtime.js';
import type { ReportBody, RuntimeDeps } from './runtime.js';
import { ConversationService, claudePaths, sessionView } from './conversation.js';
import { PageConsole } from './console.js';
import { CodexConversationAdapter } from './codexConversation.js';
import { runAppServerDebrief } from '@switchboard/codex';
import { alertDetail, alertKind, VoiceControl, voiceMark } from './voice.js';
import { currentStep, questionSpeech } from '@switchboard/conversation';
import { VoiceLink } from './voiceLink.js';
import { enrolledAt, parseRemote } from '@switchboard/voice';
import { buildSnapshot } from './snapshot.js';
import type { Snapshot } from './snapshot.js';
import { SnapshotBuilder } from './snapshotBuilder.js';
import type { Built } from './snapshotBuilder.js';
import { liveScope, WindowScopes } from './windows.js';
import { tailscaleIdentity } from './tailscale.js';
import { readHubLog } from './hubLog.js';
import type { RemoteAccess } from './page.js';
import { dockRowOf, PageAccess, pageActionEvent, pageCommandOf, pageHeader, pageReportOf, pageList, pageRow, pasteText, poolRowOf, rowOpenUrl } from './page.js';
import { launcher } from './launch.js';
import type { Launcher } from './launch.js';
import { pageAsset } from './pageAssets.js';
import { PageChanges, VIEWED_REFUSED } from './changes.js';
import { needsMessage, needsReason, newlyNeeding, rowFor } from './needs.js';
import { systemNotifier } from './systemAlerts.js';
import { installedProviders } from './installed.js';
import { claudeModelChoices, CODEX_MODELS_MS, codexModelChoices, withConfigured } from './models.js';
import type { ModelChoice } from './models.js';
import { localRoots, mainCheckout, openPageFile } from './localFiles.js';
import { spawnEnvironment } from './spawn.js';
import { PageTargets } from './pageTargets.js';
import { VOICE_CLOSE, VoiceSockets } from './voiceSocket.js';
import { VOICE_OFF } from './server.js';
import type { PageBrowser } from './server.js';
import { browserExtensionZip } from './browserExtension.js';

const RELOAD_DEBOUNCE_MS = 300;
/** The page's neutral note while no device has the voice because the phone was lost (`VoiceControl.phoneLost`). */
export const PHONE_LOST_NOTE = 'Voice stopped unexpectedly on the paired device. Select Voice on this device there, or Talk here on this computer.';

/** Operator events a page's row controls may post (PRD R27). */
const OPERATOR_EVENTS = new Set(['adhoc', 'run-schedule', 'start', 'approve', 'mark-done', 'reopen', 'retry', 'stop', 'delete', 'pick', 'retriage-pool', 'snooze', 'restore', 'comment', 'move', 'reset-position', 'persona']);

const REPORT_KINDS = new Set(['stage', 'worktree', 'done', 'approval', 'link', 'playbook', 'paste', 'task', 'question']);

/** A link target: an http(s) URL (PRD R52). */
export function isLinkTarget(target: unknown): target is string {
  return typeof target === 'string' && /^https?:\/\/\S+$/i.test(target);
}

/** An approval's draft: an absolute path, which the page opens as Open report (PRD R23). */
function isReportPath(path: unknown): path is string {
  return typeof path === 'string' && (win32.isAbsolute(path) || posix.isAbsolute(path));
}

const BASH = findBash(process.platform, process.env);

/** Builds a source with the plugin its kind names, from the plugins in force. */
function sourceMaker(plugins: PluginRegistry) {
  return (name: string, settings: SourceSettings) => {
    const plugin = plugins.current.get(settings.kind);

    return plugin === undefined ? { error: noKind(settings.kind, plugins.current) } : plugin.create(name, settings, { bash: BASH });
  };
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

/** An operator event from a page's row control. The core validates its target and refuses what does not apply; a snooze names its wake time or null. */
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

  if ((body['type'] === 'start' || body['type'] === 'pick') && ((body['guidance'] != null && typeof body['guidance'] !== 'string') || (body['playbook'] != null && typeof body['playbook'] !== 'string') || (body['prompt'] != null && typeof body['prompt'] !== 'string'))) {
    return null;
  }

  // Pins a persona to a session, or clears the pin (architecture.md § Personas).
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
  launch?: Launcher;  /** What the hub this one took over from carried to it (`HubApp.handover`), such as the voice's state; null or left out for a hub that started anew. */
  handover?: Record<string, unknown> | null;
}

/** Opens the store, loads configuration, and runs the core for the hub process. */
export async function createHubApp(options: AppOptions): Promise<HubApp & { runtime: Runtime }> {
  const home = switchboardHome(options.home);
  const configDir = options.configDir ?? home;

  mkdirSync(configDir, { recursive: true });

  const store = Store.open(join(home, 'switchboard.db'));
  const plugins = new PluginRegistry(options.home);
  await plugins.use(filePluginPaths(configDir) ?? []);
  let config = loadConfig(configDir, undefined, store.homeRepos(), plugins.current);
  const deps: RuntimeDeps = {
    home: options.home,
    configDir,
    store,
    exec: spawnExec,
    makeSource: sourceMaker(plugins),
    kindInfo: (kind) => {
      const plugin = plugins.current.get(kind);

      return plugin === undefined ? undefined : { label: plugin.label, ...(plugin.icon === undefined ? {} : { icon: plugin.icon }) };
    },
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

  const logWarnings = (loaded: Config): void => {
    for (const warning of loaded.settingsWarnings) {
      deps.log(`settings.json: ${warning}`);
    }
  };

  logWarnings(config);

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
  const notifier = systemNotifier(deps.log);
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

  /** The local web page's URL, which a system notification's click opens; the server's, once it attaches it. */
  let pageUrl = (): Promise<string> => Promise.resolve(`http://127.0.0.1:${config.settings.web.port}/page/`);
  /** settings.json or a source's state changed: every page's Settings reads the file again (PRD R54). */
  const configChanged = (): void => {
    for (const key of conversation.pages()) {
      conversation.notify(key, 'config', {});
    }
  };
  /**
   * What a terminal runs, from the settings as they are when it opens: the agent's CLI from `sessions.claudePath` or
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

  /** Why a write from a Settings window that read another config folder is refused, or null; a body without `configDir` names none. */
  const movedFrom = (read: unknown): string | null =>
    typeof read === 'string' && read !== configDir ? `The config folder is now ${configDir}, not ${read}. Settings reads it again; make your change there.` : null;
  // What each item window's workspace file holds, so Open in VS Code writes only the files that changed (PRD R71).
  const written = new Map<string, string>();
  const windows = windowsDir(options.home);

  // settings.json, which holds the playbooks, is reloaded when it changes (PRD R42).
  let pending: NodeJS.Timeout | undefined;
  let reloads = 0;
  const reload = () => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      const generation = ++reloads;
      const paths = filePluginPaths(configDir);
      const resolved = paths === null ? plugins.current : await plugins.resolve(paths);

      // A later change started its own reload while the plugins were imported; it applies the newer file.
      if (generation !== reloads) {
        return;
      }

      const next = loadConfig(configDir, config, store.homeRepos(), resolved);

      // A rejected file keeps the settings in force, and with them their plugins (PRD R42).
      if (next.settingsError === null) {
        plugins.current = resolved;
      }

      config = next;
      logWarnings(config);
      runtime.reload(config);
      voice.settingsChanged();
      readRemote(config.settings.web);

      if (!config.settings.voice.enabled) {
        voiceSockets.close(() => true, VOICE_OFF);
      }

      // Every page's Settings reads the file again (PRD R54).
      configChanged();
    }, RELOAD_DEBOUNCE_MS);
  };
  const watchers: FSWatcher[] = [watch(configDir, (_event, file) => file === 'settings.json' && reload())];

  // Focused pages participate in voice routing.
  const focusedPages = new Set<string>();
  // The page that raises needs-you alerts (architecture.md § Web page).
  const pageTargets = new PageTargets();
  // Each window sees only its own work item (architecture.md § Window scope); views are built off the main thread and published whole.
  const scopes = new WindowScopes({ store, windows });
  const doneSearch = new DoneSearch();
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
  const viewSettings = (): ViewSettings => ({ briefReplies: config.settings.voice.briefReplies, expandReplies: !config.settings.voice.briefReplies, diffLayout: config.settings.web.diffLayout, diffWrap: config.settings.web.diffWrap, iframeBrowser: config.settings.web.iframeBrowser });
  // The page's list and header, sent again when the voice changes a row's mark or the notes; set once the conversation service exists.
  let pageListChanged = (): void => {};
  const builtNow = (): void => pageListChanged();
  // The page keys of paired devices' pages, which cannot take the voice back to this computer (architecture.md § Remote access).
  const remotePages = new Set<string>();
  // The ad-hoc work item an operator event made, found as the one new ad-hoc ticket's.
  const madeAdhoc = (event: FlowEvent, failed: string): { workItemId: number } | { refused: string } => {
    const before = new Set(store.adhocKeys());
    const { refused } = runtime.send(event);

    if (refused !== null) {
      return { refused };
    }

    const key = store.adhocKeys().find((one) => !before.has(one));
    const ticket = key === undefined ? null : store.findTicket('adhoc', key);
    const item = ticket === null ? undefined : store.workItemsForTicket(ticket.id)[0];

    return item === undefined ? { refused: failed } : { workItemId: item.id };
  };
  const sameFolder = (one: string, other: string): boolean => hostKey(one) === hostKey(other);

  // Codex's model list, asked of its app-server once per hub start; a failed or slow answer is asked again next time (PRD R122).
  let codexListed: Promise<ModelChoice[]> | null = null;
  const codexModels = async (): Promise<ModelChoice[]> => {
    codexListed ??= codexModelChoices(runtime.codexServer);
    const listed = codexListed;
    const answer = await Promise.race([listed.then((choices) => choices, () => null), new Promise<null>((done) => setTimeout(() => done(null), CODEX_MODELS_MS).unref())]);

    if (answer === null) {
      listed.then(() => {}, () => { if (codexListed === listed) codexListed = null; });
    }

    return answer ?? [];
  };
  // The voice socket of a paired device (architecture.md § Remote access).
  const voiceSockets = new VoiceSockets({
    now: deps.now,
    log: (line) => deps.log(line),
    opened: (device, resumed) => voice.phoneOpened(device.key, device.hash, resumed),
    resumable: (device) => voice.resumable(device.hash),
    closed: (_device, reason, refused) => voice.phoneClosed(reason, refused),
    message: (_device, data) => voice.phoneMessage(data),
    audio: (device, data) => voice.phoneAudio(device.key, data),
  });
  const voice: VoiceControl = new VoiceControl({
    link: new VoiceLink({ home, nodePath: () => config.settings.sessions.nodePath, log: (line) => deps.log(line), now: deps.now, sleep: deps.sleep }),
    settings: () => config.settings.voice,
    viewSettings: () => viewSettings(),
    store,
    // An earlier session a page shows read-only is never the voice's to speak for or dictate into.
    windows: { keys: () => scopes.keys(), scope: (key) => liveScope(scopes.scope(key)) },
    focusedWindow: () => focusedWindow,
    // Voice on a phone (architecture.md § Remote access): its voice socket, and whether its page has the focus.
    phone: {
      send: (message) => voiceSockets.send(message),
      sendBinary: (data) => voiceSockets.sendBinary(data),
      close: (reason) => voiceSockets.close(() => true, reason),
    },
    pageFocused: (key) => focusedPages.has(key),
    remotePage: (key) => remotePages.has(key),
    repliesSince: (sessionId, since) =>
      store
        .conversation(sessionId, null, 100, false)
        .items.flatMap((item) => (item.type === 'reply' && item.at >= since ? [store.reply(item.id)] : []))
        .filter((reply): reply is NonNullable<typeof reply> => reply !== null),
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
    cardSpeech: (sessionId, replyId) => conversation.cardSpeech(sessionId, replyId),
    cardUtterance: (key, sessionId, text) => conversation.cardUtterance(key, sessionId, text),
    alertText: (sessionId, cause) => {
      const session = store.session(sessionId);
      const item = session === null ? null : store.workItem(session.workItemId);

      if (session === null || item === null) {
        return null;
      }

      const latest = [...store.conversation(sessionId, null, 20, false).items].reverse().find((one) => one.type === 'reply' && one.kind === 'reply' && !one.withdrawn && one.rewrittenBy === null);
      const reply = latest?.type === 'reply' ? { speak: latest.speak ?? null, opening: latest.opening } : null;

      const ledger = conversation.ledger(sessionId);
      const first = ledger.open.length === 0 ? null : ledger.questions.get(ledger.open[0]!)!;
      const card = first === null ? null : ledger.cards.get(first.card)!;
      const current = card === null ? null : currentStep(card, conversation.drafts(sessionId).get(card.key));
      const questions = current === null ? null : { count: ledger.open.length, first: questionSpeech(current.question, 1, 1) };

      return { title: store.ticket(item.ticketId)?.title ?? '', detail: alertDetail(cause, session.state === 'waiting', reply, store.latestStatus(sessionId)?.markdown ?? null, questions) };
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
    // The page's mic mark and voice note follow the voice.
    dockChanged: builtNow,
    now: deps.now,
    log: deps.log,
  });
  // The web page's console of a held session (architecture.md § Web page).
  /**
   * Open in VS Code from the page (architecture.md § Web page): writes the row's workspace file and starts VS Code on it, or on a folder-hosted
   * conversation's folder, after checking the row offers it now; why not, or null. VS Code runs without the Switchboard extension, so the hub
   * leaves no command for the window.
   */
  const commandInWindow = async (workItemId: number, label: string): Promise<string | null> => {
    const row = dockRowOf(views().dock, workItemId);
    const built = row === null ? { refused: 'The work item is gone.' } : pageCommandOf(row, label);

    if ('refused' in built) {
      return built.refused;
    }

    const window = row!.window!;
    let destination = built.destination;

    if (window.file !== null && window.hosted !== true) {
      try {
        writeWorkspaceFile(window, written);
      } catch (error) {
        deps.log(`workspace file ${window.file} not written: ${String(error)}`);
        return `The workspace file was not written: ${(error as Error).message}`;
      }
    } else if (window.file !== null) {
      // A hosted conversation opens its host's window, whose file the host's own row writes; with no such row and no file, its own folder opens.
      const host = views().dock.groups.flatMap((group) => group.rows).map((one) => one.window).find((one) => one !== null && one.hosted !== true && one.file !== null && hostKey(one.file) === hostKey(window.file!));

      try {
        if (host !== undefined && host !== null) {
          writeWorkspaceFile(host, written);
        }
      } catch (error) {
        deps.log(`workspace file ${window.file} not written: ${String(error)}`);
        return `The workspace file was not written: ${(error as Error).message}`;
      }

      if (!existsSync(window.file)) {
        destination = window.folders[0] ?? destination;
      }
    }

    try {
      await launch.openCode(destination);
    } catch (error) {
      return `VS Code did not start: ${(error as Error).message}`;
    }

    deps.log(`page: ${label} for work item ${workItemId} in ${destination}`);
    return null;
  };
  // The web page's Changes list and diffs, read with git in the page's selected conversation's folder (architecture.md § Web page).
  const pageChanges = new PageChanges({
    isPage: (key) => scopes.isPage(key),
    scope: (key) => scopes.scope(key),
    viewed: { list: (workItemId, scope) => store.viewedFiles(workItemId, scope), set: (workItemId, scope, path, hash) => store.setViewedFile(workItemId, path, hash, deps.now(), scope) },
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
    adapters: changed => [new CodexConversationAdapter({ server: runtime.codexServer, runner: runtime.codexAppServer, store, now: deps.now, newId: randomUUID, log: deps.log, requestsChanged: () => conversation.sessionsChanged(), providerTitle: (workItemId, title, origin) => runtime.send({ type: 'conversation-title', workItemId, text: title, origin }) }, changed)],
    store,
    windows: scopes,
    switchboardHome: home,
    voice: {
      shown: (key) => voice.shown(key),
      settings: () => viewSettings(),
      spokenFor: (sessionId, command, key) => voice.spokenFor(sessionId, command, key ?? null),
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
      micTiming: (key, steps, outcome) => voice.micTiming(key, steps, outcome),
      composer: (key, focused, draft, listen) => voice.composer(key, focused, draft, listen),
    },
    personas: () => config.settings.voice,
    pinPersona: (sessionId, personaId) => runtime.send({ type: 'persona', sessionId, personaId }).refused,
    ...claudePaths(claudeRoot, homedir(), Boolean(process.env['CLAUDE_CONFIG_DIR'])),
    codexHome: runtime.codexHome,
    screen: (session, scrollback) => runtime.heldScreen(session, scrollback),
    input: { reserve: (sessionId, launch) => runtime.reserveInput(sessionId, launch), write: (session, data) => runtime.writeHeld(session, data), cannotType: () => runtime.heldCannotType() },
    hooks: () => config.settings.sessions.installHooks,
    now: deps.now,
    newId: randomUUID,
    resume: (sessionId) => runtime.resumeThread(sessionId),
    newItemSession: (workItemId, prompt, provider) => {
      const before = store.sessionsFor(workItemId).at(-1)?.id;
      const { refused } = runtime.send({ type: 'item-session', workItemId, prompt, ...(provider === undefined ? {} : { provider }) });
      const made = store.sessionsFor(workItemId).at(-1);

      return refused === null && made !== undefined && made.id !== before ? { sessionId: made.id } : { refused: refused ?? 'The conversation was not started.' };
    },
    newStandalone: (folder, provider, model, prompt) => madeAdhoc({ type: 'new-session', repoRoot: folder, provider, model, ...(prompt === null ? {} : { prompt }) }, 'The session was not made.'),
    newTask: (folder, provider, model, prompt, start) => madeAdhoc({ type: 'adhoc', prompt, repoRoot: folder, start, provider, model }, 'The task was not made.'),
    folderRoots: () => ({
      recent: store.recentFolders(),
      repoRoots: views().snapshot.repoRoots,
      worktrees: views().snapshot.workItems.flatMap((item) => (item.status !== 'done' && item.worktree != null ? [item.worktree.path] : [])),
    }),
    rememberFolder: (folder) => store.rememberFolders([folder], sameFolder),
    pageList: () => {
      const built = views();
      const row = voiceRow();

      const mark = row === null ? null : voiceMark(voice.micLive, voice.speakReplies, voice.device === 'phone');

      return pageList(built.dock, built.snapshot, row === null || mark === null ? null : { row, ...mark });
    },
    pageHeader: () => {
      const built = views();

      return { ...pageHeader({ ...built.dock, ...withVoiceNotes(built.dock.notes) }), ...(config.settings.voice.enabled && voice.device !== 'computer' ? { voiceDevice: voice.device } : {}) };
    },
    pollSources: () => runtime.pollNow(),
    restartHolder: (detail) => restartHolder(detail),
    // The page's Run a schedule now sends the `run-schedule` event; the run is its ticket's newest work item.
    runSchedule: (name) => {
      const { refused } = runtime.send({ type: 'run-schedule', name });

      if (refused !== null) {
        return { refused };
      }

      const ticket = store.findTicket(SCHEDULE_SOURCE, name);
      const newest = ticket === null ? undefined : store.workItemsForTicket(ticket.id).reduce<{ id: number } | undefined>((latest, item) => (latest === undefined || item.id > latest.id ? item : latest), undefined);

      return newest === undefined ? { refused: 'The run was not made.' } : { workItemId: newest.id };
    },
    // The list's search further back (PRD R63); a row whose work item is gone meanwhile is left out.
    searchDone: (text, since) => {
      const found = doneSearch.search(store, views().snapshot, runtime.snapshotInputs(), text, since, windows);
      const rows = found.rows.flatMap((row) => {
        const item = store.workItem(Number(/^item:(\d+)$/.exec(row.key)?.[1]));
        const ticket = item === null ? null : store.ticket(item.ticketId);

        return item === null ? [] : [pageRow(row, item.id, ticket?.hostWindow ?? null)];
      });

      return { rows, more: found.more };
    },
    // The page's source icons turn a source on or off (architecture.md § Web page).
    setSource: (name, enabled) => {
      const error = runtime.setSourceEnabled(name, enabled);

      if (error === null) {
        configChanged();
      }

      return error;
    },
    // The page's row actions run the hub's own controls, rechecked against the row as it is now (architecture.md § Web page).
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
    // A dismissal can leave a session waiting on questions with none open (PRD R103).
    questionsSettled: (sessionId) => runtime.questionsSettled(sessionId),
    // A drag of a Ready for review row on the page, which moves it within Ready for review (PRD R73).
    rowMove: (workItemId, after) => {
      const { dock } = views();

      if (dockRowOf(dock, workItemId)?.movable !== true || (after !== null && dockRowOf(dock, after)?.movable !== true)) {
        return 'The work item is not in Ready for review.';
      }

      return runtime.send({ type: 'move', workItemId, after }).refused;
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
    // The page's Open in VS Code, which starts VS Code on the row's workspace file or folder (architecture.md § Web page).
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
        focusedWindow = key;
        // A page coming to the front reads the pull requests again (PRD R92).
        runtime.refreshPullRequests();
      } else {
        focusedPages.delete(key);

        if (focusedWindow === key) {
          focusedWindow = null;
        }
      }

      voice.update();
    },
    // Give an unnamed interactive conversation a short label until its provider names it.
    messageAdded: (workItemId, text) => {
      const item = store.workItem(workItemId);
      const ticket = item === null ? null : store.ticket(item.ticketId);

      if (ticket?.source === 'adhoc' && ticket.title === NEW_CONVERSATION_TITLE && (item?.interactive || ticket.hostWindow != null)) {
        runtime.send({ type: 'conversation-title', workItemId, text });
      }
    },
    providerTitle: (workItemId, title, origin) => runtime.send({ type: 'conversation-title', workItemId, text: title, origin }),
    log: deps.log,
  });
  pageListChanged = () => conversation.pageListChanged();
  /** A finished build: windows bound to a new work item start from empty, and every stream gets the new views. */
  let announced: Snapshot | null = null;
  const published = (built: Built): void => {
    conversation.scopesChanged(scopes.update(built.snapshot));
    conversation.sessionsChanged();

    // A web page or a system notification says when a work item starts needing the operator (PRD R65).
    const newly = newlyNeeding(announced, built.snapshot);
    const newlyNeedingIds = newly.map((item) => item.id);
    const needing = newly.flatMap((item) => {
      const rowKey = rowFor(built.snapshot, { workItemId: item.id });

      return rowKey === null ? [] : [{ rowKey, workItemId: item.id, message: needsMessage(item), title: item.ticket.title, reason: needsReason(item) }];
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

    // One surface, `alerts.surface`, shows each needs-you message: a web page or a system notification.
    if (needing.length > 0) {
      const surface = config.settings.alerts.surface;
      const page = pageTargets.alerting(surface);
      // A page or notification sounds only where neither the voice's chime nor a spoken alert does, so one event makes one sound.
      const sound = config.settings.voice.needsYouSound && !chimed && unalerted.some((id) => id !== targetSession?.workItemId);

      if (page !== null) {
        conversation.pageNeeds(page, needing.map(({ workItemId, message }) => ({ workItemId, message })), sound && voice.pageMaySound(page));
      } else {
        const here = sound && voice.systemMaySound();

        void pageUrl().then(
          (base) => notifier.notify(needing.map(({ workItemId, title, reason }) => ({ workItemId, title, reason, url: `${base}#w=${workItemId}` })), here),
          (error: unknown) => deps.log(`system notification not shown: ${String(error)}`),
        );
      }
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

  /** The row of the voice target's work item, which has the mic mark on the page (architecture.md § Voice), or null. */
  function voiceRow(): string | null {
    const targetSession = voice.target === null ? null : store.session(voice.target);

    return targetSession === null ? null : `item:${targetSession.workItemId}`;
  }

  /**
   * The list's notes with the voice's problem last, and the neutral voice note while the phone was lost, as the page shows them
   * (architecture.md § Voice). Voice the operator turned off, or a phone left by choice, has no note.
   */
  function withVoiceNotes(notes: string[]): { notes: string[]; voiceNote?: string } {
    const voiceError = voice.dockError();

    return {
      notes: voiceError === null ? notes : [...notes, `Voice: ${voiceError}`],
      ...(config.settings.voice.enabled && voice.phoneLost ? { voiceNote: PHONE_LOST_NOTE } : {}),
    };
  }

  runtime.onChange(() => builder.schedule());
  runtime.setConversationReader({ read: (sessionIds) => conversation.readNow(sessionIds), catchUp: (sessionId) => conversation.catchUp(sessionId), continueAfterLimit: (sessionId, text, guard) => conversation.continueAfterLimit(sessionId, text, guard) });

  await runtime.startup();
  runtime.start();
  conversation.start();

  // The Settings editor's routes (PRD R54), which the web page posts as page commands (architecture.md § Settings).
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
        sourceKinds: plugins.current.all().map((plugin) => plugin.kind),
        sourceLabels: Object.fromEntries(plugins.current.all().map((plugin) => [plugin.kind, plugin.label])),
        sourceFields: Object.fromEntries(plugins.current.all().flatMap((plugin) => (plugin.fields === undefined ? [] : [[plugin.kind, plugin.fields]]))),
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
      isRecord(body) && 'settings' in body
        ? await (async () => {
            const draft = await plugins.resolve(pluginPaths(body['settings']) ?? []);

            return { status: 200, body: { errors: checkSettings(body['settings'], runtime.enabledSources(), store.homeRepos(), draft), warnings: settingsWarnings(body['settings']) } };
          })()
        : { status: 400, body: { error: 'Expected {settings}.' } },
    save: async (body: unknown) => {
      const version = isRecord(body) ? body['version'] : undefined;

      if (!isRecord(body) || !('value' in body) || !(version === null || typeof version === 'string')) {
        return { status: 400, body: { error: 'Expected {value, version}.' } };
      }

      const moved = movedFrom(body['configDir']);

      if (moved !== null) {
        return { status: 409, body: { errors: [moved] } };
      }

      const draft = await plugins.resolve(pluginPaths(body['value']) ?? []);
      const result = saveSettings(configDir, body['value'], version, runtime.enabledSources(), store.homeRepos(), draft);

      return result.errors.length === 0 ? { status: 200, body: { saved: true, version: result.version } } : { status: 409, body: { errors: result.errors } };
    },
    // The view options menu's Collapse details (architecture.md § Conversation view): sets `voice.briefReplies` in settings.json as a
    // Settings save would, leaving the rest of the file as it is but the `voice.expandReplies` it replaced; the reload sends every window and
    // page the new value.
    briefReplies: async (body: unknown) => {
      const on = isRecord(body) ? body['on'] : undefined;

      if (typeof on !== 'boolean') {
        return { status: 400, body: { error: 'Expected {on}.' } };
      }

      const file = readConfigFile(configDir);

      if (file.error !== null || !isRecord(file.value)) {
        return { status: 409, body: { error: file.error ?? 'settings.json is not a JSON object. Fix it in Settings.' } };
      }

      // A file Settings could not save is left for Settings to fix, so no invalid entry, such as a voice that is not an object, is dropped here.
      const invalid = checkSettings(file.value, runtime.enabledSources(), store.homeRepos(), plugins.current);

      if (invalid.length > 0) {
        return { status: 409, body: { error: invalid.join(' ') } };
      }

      const voiceIn = file.value['voice'];
      const value = { ...file.value, voice: { ...(isRecord(voiceIn) ? voiceIn : {}), briefReplies: on } };
      const result = saveSettings(configDir, value, file.version, runtime.enabledSources(), store.homeRepos(), plugins.current);

      return result.errors.length === 0 ? { status: 200, body: { briefReplies: on } } : { status: 409, body: { error: result.errors.join(' ') } };
    },
  };

  const debriefTimer = setInterval(() => void debriefs.scan(), DEBRIEF_SCAN_MS);

  // A hub that took over goes on with the voice as the hub before it left it (architecture.md § Hub lifecycle).
  voice.restore(options.handover?.['voice']);

  // What the browser extension reads and posts, on the browser endpoint and through the web page's origin (architecture.md § Browser extension).
  const browser: PageBrowser = {
    iframeEnabled: () => config.settings.web.iframeBrowser,
    snoozed: () => store.snoozedTickets(deps.now()).flatMap((ticket) => (ticket.url === '' ? [] : [ticket.url])),
    cards: () => cardsOf(views().snapshot),
    snooze: (url, until) => {
      const ticket = store.ticketInScopeByUrl(url);

      return ticket === null ? null : { refused: runtime.send({ type: 'snooze', ticketId: ticket.id, until }).refused };
    },
    unsnooze: (url) => {
      const ticket = store.ticketInScopeByUrl(url);

      return ticket === null ? null : { refused: runtime.send({ type: 'restore', ticketId: ticket.id }).refused };
    },
    download: (origin) => browserExtensionZip(join(home, 'web'), origin),
  };

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
      '/holder/list': async () => ({ status: 200, body: { sessions: await runtime.listHeld(), holder: runtime.heldHolder(), installed: runtime.holderInstalled(), held: builder.buildNow().dock.held ?? [] } }),
      '/holder/open': async (body) => {
        if (!isRecord(body) || typeof body['id'] !== 'string' || body['id'] === '') {
          return { status: 400, body: { error: 'Expected {id}.' } };
        }
        await runtime.listHeld();
        const held = builder.buildNow().dock.held?.find((one) => one.session === body['id']);
        if (held === undefined) return { status: 404, body: { error: `No held session ${body['id']}.` } };
        if (held.terminal === null) return { status: 409, body: { error: 'This held session has no terminal to open.' } };
        if (launch.openTerminal === undefined) return { status: 409, body: { error: 'This hub cannot open the terminal app.' } };
        try {
          await launch.openTerminal({ ...held.terminal, ...terminalRun(held.terminal) });
          return { status: 200, body: { opening: true } };
        } catch (error) {
          return { status: 409, body: { error: `The terminal did not start: ${(error as Error).message}` } };
        }
      },
      '/holder/stop': async (body) => {
        if (!isRecord(body) || typeof body['id'] !== 'string' || body['id'] === '') {
          return { status: 400, body: { error: 'Expected {id}.' } };
        }

        const result = await runtime.stopHeld(body['id']);

        return 'refused' in result ? { status: result.status, body: { error: result.refused } } : { status: 200, body: result };
      },
      // Restart and resume of a terminal holder from an older build (architecture.md § Restarting the holder).
      '/holder/restart': async (body) => {
        const refused = restartHolder(isRecord(body) ? body['detail'] : undefined);

        return refused === null ? { status: 200, body: { started: true } } : { status: 409, body: { error: refused } };
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
      '/v1/conversation/send': async (body) => (isRecord(body) ? conversation.send(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, text, command?}.' } }),
      '/v1/conversation/card-draft': async (body) => (isRecord(body) ? conversation.cardCommand('card-draft', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, card, draft}.' } }),
      '/v1/conversation/card-dismiss': async (body) => (isRecord(body) ? conversation.cardCommand('card-dismiss', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, card, slug}.' } }),
      // The providers a new session can start in and their models (PRD R122): the configured default first, then the form's choices.
      '/v1/conversation/providers': async () => {
        const sessions = config.settings.sessions;
        const installed = await installedProviders(sessions);
        const codex = installed.includes('codex') ? await codexModels() : [];

        return {
          status: 200,
          body: {
            defaultProvider: sessions.provider,
            installed,
            models: { claude: sessions.model, codex: sessions.codex.model },
            modelChoices: { claude: claudeModelChoices(config.settings, config.playbooks.values()), codex: withConfigured(codex, sessions.codex.model) },
          },
        };
      },
        '/v1/conversation/answer': async (body) => isRecord(body) ? conversation.answer(body) : { status: 400, body: { error: 'Expected a request answer.' } },
      '/v1/conversation/history': async (body) => (isRecord(body) ? conversation.history(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, before, limit?}.' } }),
      '/v1/conversation/seen': async (body) => (isRecord(body) ? conversation.seen(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, ids}.' } }),
      '/v1/conversation/select': async (body) => (isRecord(body) ? conversation.select(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, workItemId}.' } }),
      '/v1/conversation/page-new-session': async (body) => (isRecord(body) ? conversation.newSession(body) : { status: 400, body: { error: 'Expected {window, opId, folder, provider, model?, prompt?, run?}.' } }),
      '/v1/conversation/page-folders': async (body) => (isRecord(body) ? conversation.pageFolders(body) : { status: 400, body: { error: 'Expected {window, path?}.' } }),
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
      '/v1/conversation/page-conversation': async (body) => (isRecord(body) ? conversation.pageConversation(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, text, provider?}.' } }),
      '/v1/conversation/resume': async (body) => (isRecord(body) ? conversation.resume(body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId}.' } }),
      '/v1/conversation/pool-action': async (body) => (isRecord(body) ? conversation.poolAction(body) : { status: 400, body: { error: 'Expected {window, opId, ticketId, label}.' } }),
      '/v1/conversation/row-move': async (body) => (isRecord(body) ? conversation.rowMove(body) : { status: 400, body: { error: 'Expected {window, opId, workItemId, after}.' } }),
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
      '/v1/conversation/page-adhoc': async (body) => (isRecord(body) ? conversation.pageAdhoc(body) : { status: 400, body: { error: 'Expected {window, opId, schedule}.' } }),
      // A changed file ticked viewed, or its tick cleared, for every device (architecture.md § Web page).
      '/v1/conversation/viewed': async (body) => (isRecord(body) ? pageChanges.viewedCommand(body) : { status: 400, body: { error: VIEWED_REFUSED } }),
      '/v1/conversation/page-search': async (body) => (isRecord(body) ? conversation.pageSearch(body) : { status: 400, body: { error: 'Expected {window, text, since}.' } }),
      // The page's tabs for its work item, kept for every device (architecture.md § Web page).
      '/v1/conversation/page-tabs': async (body) => (isRecord(body) ? conversation.pageTabs(body) : { status: 400, body: { error: 'Expected {window, workItemId, tab?, close?, reopen?, openOn?}.' } }),
      '/v1/conversation/page-source': async (body) => (isRecord(body) ? conversation.pageSource(body) : { status: 400, body: { error: 'Expected {window, name, enabled}.' } }),
      '/v1/conversation/page-focus': async (body) => (isRecord(body) ? conversation.pageFocus(body) : { status: 400, body: { error: 'Expected {window, focused}.' } }),
      '/v1/conversation/persona': async (body) => (isRecord(body) ? conversation.personaCommand('persona', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, personaId}.' } }),
      '/v1/conversation/mic': async (body) => (isRecord(body) ? conversation.voiceCommand('mic', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, on}.' } }),
      '/v1/conversation/mic-timing': async (body) => (isRecord(body) ? conversation.voiceCommand('mic-timing', body) : { status: 400, body: { error: 'Expected {window, steps, outcome}.' } }),
      '/v1/conversation/composer': async (body) => (isRecord(body) ? conversation.voiceCommand('composer', body) : { status: 400, body: { error: 'Expected {window, scopeGen, opId, focused, draft}.' } }),
      // The web page's Settings (architecture.md § Web page).
      '/v1/conversation/page-settings-read': settingsRoutes.read,
      '/v1/conversation/page-voice-enroll': settingsRoutes.enroll,
      '/v1/conversation/page-settings-check': settingsRoutes.check,
      '/v1/conversation/page-settings-save': settingsRoutes.save,
      // Collapse details, from this computer's page's view options menu.
      '/v1/conversation/brief-replies': settingsRoutes.briefReplies,
    },
    snapshot: () => runtime.snapshot(),
    windowClosed: (key) => {
      if (focusedWindow === key) {
        focusedWindow = null;
      }

      focusedPages.delete(key);
      remotePages.delete(key);
      pageTargets.closed(key);
      scopes.close(key);
      conversation.windowClosed();
      voice.windowClosed(key);
    },
    conversation: (key, write) => conversation.open(key, write),
    page: {
      access: new PageAccess(store, deps.now),
      remote: () => remote,
      hubLog: (lines) => readHubLog(home, lines),
      asset: (name) => pageAsset(name, home),
      opened: (installed, remote) => {
        const key = scopes.openPage();

        if (remote === true) {
          remotePages.add(key);
        }

        pageTargets.opened(key, installed === true);

        setImmediate(() => {
          voice.update();
        });
        return key;
      },
      isPage: (key) => scopes.isPage(key),
      list: () => conversation.pageList(),
      files: (key, query) => conversation.files(key, query),
      artifact: (key, name) => conversation.artifactFile(key, name),
      localFile: async (key, target, paired) => {
        const scope = scopes.isPage(key) ? scopes.scope(key) : null;

        if (scope === null || scope.workItemId === null) {
          return null;
        }

        // The conversation's folders: its own, each of its work item's sessions' working folder and scratchpad, and its ticket's worktree and
        // repository root (architecture.md § Web page); for a paired device, only the current session's working folder and those checkouts
        // (architecture.md § Remote access).
        const ticketId = store.workItem(scope.workItemId)?.ticketId;
        const ticket = ticketId === undefined ? null : store.ticket(ticketId);
        const root = ticket === null ? null : ticketRoot(config.settings, ticket, store.reposBySource());
        const worktree = ticketId === undefined ? null : (store.worktreeFor(ticketId)?.path ?? null);
        // A reported worktree may belong to another repository than the ticket's root names, so its own main checkout counts too.
        const checkouts = [worktree, worktree === null ? null : await mainCheckout(worktree), root !== null && 'root' in root ? root.root : null];

        // Open report's draft, which may lie outside them, opens as that one file (architecture.md § Web page).
        const row = dockRowOf(views().dock, scope.workItemId);
        const report = row === null ? null : pageReportOf(row);

        // A file that is one of the work item's artifacts opens as that artifact's tab on the page.
        return openPageFile({ ...localRoots(scope, store.sessionsFor(scope.workItemId), scope.sessionId, paired, checkouts), files: report === null ? [] : [report], never: [home] }, target, (real) => conversation.pageArtifactAt(key, real));
      },
      upload: (key, scopeGen, name, bytes) => conversation.pageUpload(key, scopeGen, name, bytes),
      console: (key, sessionId, send, end) => pageConsole.open(key, sessionId, send, end),
      changes: (route, key, query) =>
        route === 'changes'
          ? pageChanges.changes(key, query.get('from'), query.get('to'))
          : route === 'diff'
            ? pageChanges.diff(key, query.get('path'), query.get('sides'), query.get('from'), query.get('to'))
            : route === 'file'
              ? pageChanges.file(key, query.get('path'), query.get('side'), query.get('from'), query.get('to'))
              : Promise.resolve({ status: 404, body: { error: 'not found' } }),
      voice: {
        enabled: () => config.settings.voice.enabled,
        accept: (request, socket, head, device) => voiceSockets.accept(request, socket, head, device),
        close: (match, reason, code) => voiceSockets.close(match, reason, code),
      },
      browser,
    },
    pagePort: () => config.settings.web.port,
    attachPageUrl: (url) => {
      pageUrl = url;
    },
    attachRemote: (changed) => {
      remoteChanged = changed;
    },
    snoozedUrls: () => browser.snoozed(),
    cards: () => browser.cards(),
    snoozeUrl: (url, until) => browser.snooze(url, until),
    unsnoozeUrl: (url) => browser.unsnooze(url),
    busy: () => runtime.hasActiveSessions() || debriefs.running(),
    quiet: () => runtime.restartBlocker() ?? (conversation.sending() ? 'a message is being sent' : (voice.restartBlocker() ?? (debriefs.running() ? 'a friction debrief is running' : null))),
    // The voice goes on as it was under the hub that takes over: the phone's page takes it back without a tap (architecture.md § Hub lifecycle).
    handover: () => ({ voice: voice.handoverState() }),
    handedOver: () => {
      voice.handOver();
      voiceSockets.close(() => true, 'Switchboard is restarting.', VOICE_CLOSE.restarting);
    },
    close: () => {
      clearTimeout(pending);
      clearInterval(debriefTimer);
      voice.close();
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
