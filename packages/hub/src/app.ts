import { randomUUID } from 'node:crypto';
import { mkdirSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { claudeSettingsPath, readRoster, spawnExec } from '@switchboard/claude';
import { Store, switchboardHome } from '@switchboard/core';
import { CODEX_PERMISSION_MODES, PERMISSION_MODES, PROVIDERS, TEMPLATE_VARIABLES } from '@switchboard/core';
import type { FlowEvent, SourceSettings } from '@switchboard/core';
import { githubSource } from '@switchboard/github';
import { zohoSource } from '@switchboard/zoho';
import { forumSource } from '@switchboard/forum';
import { findBash } from './bash.js';
import { cardsOf } from './cards.js';
import { dockView, windowsDir, writeWorkspaceFile } from './dock.js';
import { isPastePath } from './report.js';
import { DEBRIEF_SCAN_MS, Debriefs } from './debriefs.js';
import { SOURCE_KINDS, checkSettings, loadConfig, readConfigFile, saveSettings } from './config.js';
import type { HubApp } from './serve.js';
import { Runtime } from './runtime.js';
import type { ReportBody, RuntimeDeps } from './runtime.js';
import { WindowQueue } from './windowQueue.js';

const RELOAD_DEBOUNCE_MS = 300;

/** Operator events the dock may send (PRD R27). */
const OPERATOR_EVENTS = new Set(['adhoc', 'run-schedule', 'start', 'approve', 'mark-done', 'retriage', 'stop', 'delete', 'open-question', 'pick', 'retriage-pool', 'snooze', 'restore', 'move', 'reset-position']);

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
  switch (name) {
    case 'github':
      return githubSource(settings);
    case 'zoho':
      return zohoSource(settings, BASH);
    case 'forum':
      return forumSource(settings, BASH);
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

  if (body['type'] === 'snooze' && body['until'] !== null && !Number.isFinite(body['until'])) {
    return null;
  }

  // Only the fields the core reads, because a `sessionId` field would make the activity log name another subject.
  if (body['type'] === 'open-question') {
    const { workItemId, nativeSessionId } = body;

    return Number.isInteger(workItemId) && typeof nativeSessionId === 'string' ? { type: 'open-question', workItemId: workItemId as number, nativeSessionId } : null;
  }

  if ((body['type'] === 'start' || body['type'] === 'pick') && body['guidance'] != null && typeof body['guidance'] !== 'string') {
    return null;
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
  /** Overrides for tests. */
  deps?: Partial<RuntimeDeps>;
}

/** Opens the store, loads configuration, and runs the core for the hub process. */
export async function createHubApp(options: AppOptions): Promise<HubApp & { runtime: Runtime }> {
  const home = switchboardHome(options.home);
  const configDir = options.configDir ?? home;

  mkdirSync(configDir, { recursive: true });

  const store = Store.open(join(home, 'switchboard.db'));
  let config = loadConfig(configDir);
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
    ...options.deps,
  };
  const runtime = new Runtime(deps, config);
  // Kept in a file, because the window the dock is opening may replace this hub before it claims (architecture.md § Claude Code runner).
  const windowQueue = WindowQueue.load(join(home, 'window-queue.json'), deps.now, deps.log);
  const claudeRoot = dirname(deps.claudeSettings).replaceAll('\\', '/');
  const debriefs = new Debriefs({
    dir: `${claudeRoot}/.wip/debrief`,
    promptPath: `${claudeRoot}/skills/friction-review/prompt.md`,
    projectsDir: `${claudeRoot}/projects`,
    claudePath: () => config.settings.sessions.claudePath,
    codexScript: `${claudeRoot}/tools/agent-delegate/debrief.mjs`,
    codexPath: () => config.settings.sessions.codex.path,
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
  let sendWindows: (event: string, data: unknown) => number = () => 0;
  /**
   * Tells the window opened from `workspace` to claim what was left for it, because VS Code reports no focus change when the dock brings an open
   * window forward; a window claims on focus too. Nothing left for any window is announced, because only the window brought forward takes it.
   */
  const askToClaim = (workspace: string | null): void => {
    if (workspace !== null) {
      sendWindows('claim', { workspace });
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
      config = loadConfig(configDir, config);
      runtime.reload(config);
      // The dock's Settings window reads the file again (PRD R54).
      sendDock('config', {});
    }, RELOAD_DEBOUNCE_MS);
  };
  const watchers: FSWatcher[] = [watch(configDir, (_event, file) => file === 'settings.json' && reload())];

  await runtime.startup();
  runtime.start();

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
        if (!isRecord(body) || typeof body['nativeSessionId'] !== 'string') {
          return { status: 400, body: { error: 'Expected {nativeSessionId}.' } };
        }

        const contract = runtime.contract(body['nativeSessionId']);

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
      // The ticket report (PRD R83), which no report contract or usage text lists.
      '/ticket': async (body) => {
        const { sessionId, url, playbook, nativeSessionId } = isRecord(body) ? body : {};

        if (typeof sessionId !== 'string' || typeof url !== 'string' || !/^https?:\/\//i.test(url) || !optionalString(playbook) || playbook === '' || !optionalString(nativeSessionId)) {
          return { status: 400, body: { error: 'Expected {sessionId, url, playbook?}.' } };
        }

        const result = await runtime.ticket(sessionId, url, playbook ?? null, nativeSessionId || null);

        return 'refused' in result ? { status: 409, body: { error: result.refused } } : { status: 200, body: result };
      },
      '/open': async (body) => {
        if (!isRecord(body) || typeof body['sessionId'] !== 'string' || typeof body['cwd'] !== 'string' || !optionalString(body['workspace'])) {
          return { status: 400, body: { error: 'Expected {sessionId, cwd, workspace?}.' } };
        }

        if (!windowQueue.recordOpen(body['sessionId'], body['cwd'], body['workspace'] ?? null)) {
          return { status: 500, body: { error: 'The hub could not save the open; see its log.' } };
        }

        deps.log(`session ${body['sessionId']} left for ${body['workspace'] ?? body['cwd']}`);
        askToClaim(body['workspace'] ?? null);

        return { status: 200, body: { recorded: true } };
      },
      '/history': async (body) => {
        if (!isRecord(body) || !Number.isInteger(body['ticketId'])) {
          return { status: 400, body: { error: 'Expected {ticketId, revision?}.' } };
        }

        const ticketId = body['ticketId'] as number;

        // A reader that names the revision it shows gets the full history only when it changed.
        if (typeof body['revision'] === 'string' && store.ticket(ticketId) !== null && store.historyRevision(ticketId) === body['revision']) {
          return { status: 200, body: { unchanged: true } };
        }

        const history = store.ticketHistory(ticketId);

        return history === null ? { status: 409, body: { error: `Unknown ticket ${body['ticketId']}.` } } : { status: 200, body: history };
      },
      '/claim': async (body) => {
        if (!isRecord(body) || typeof body['folder'] !== 'string' || !optionalString(body['workspace']) || !(body['focused'] === undefined || typeof body['focused'] === 'boolean')) {
          return { status: 400, body: { error: 'Expected {folder, workspace?, focused?}.' } };
        }

        const workspace = body['workspace'] ?? null;
        const sessionId = windowQueue.claimOpen(body['folder'], workspace);
        const commands = windowQueue.claimCommands(workspace, body['focused'] === true);
        const claimant = workspace ?? (body['folder'] || 'a window with no folder');

        // The log shows whether a window took what the dock left for it (PRD R71).
        if (sessionId !== null) {
          deps.log(`session ${sessionId} claimed by ${claimant}`);
        }

        if (commands.length > 0) {
          deps.log(`window commands claimed by ${claimant}: ${commands.map((command) => String(command['type'])).join(', ')}`);
        }

        // The window opens the session in its provider's view; an unknown one, such as a deleted session's, in Claude's.
        const provider = sessionId === null ? null : (store.sessionByNativeId(sessionId)?.provider ?? 'claude');

        return { status: 200, body: { sessionId, provider, commands } };
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
          sendDock('config', {});
        }

        return error === null ? { status: 200, body: { done: true } } : { status: 409, body: { error } };
      },
      '/poll': async () => {
        const error = runtime.pollNow();

        return error === null ? { status: 200, body: { done: true } } : { status: 409, body: { error } };
      },
      '/dock/show': async () =>
        sendDock('show', {}) > 0 ? { status: 200, body: { shown: true } } : { status: 409, body: { error: 'The dock is not running.' } },
      // The dock's Settings window (PRD R54): settings.json with its version, and what the editor offers.
      '/config/read': async () => ({
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
      '/config/check': async (body) =>
        isRecord(body) && 'settings' in body ? { status: 200, body: { errors: checkSettings(body['settings'], runtime.enabledSources()) } } : { status: 400, body: { error: 'Expected {settings}.' } },
      '/config/save': async (body) => {
        const version = isRecord(body) ? body['version'] : undefined;

        if (!isRecord(body) || !('value' in body) || !(version === null || typeof version === 'string')) {
          return { status: 400, body: { error: 'Expected {value, version}.' } };
        }

        const moved = movedFrom(body['configDir']);

        if (moved !== null) {
          return { status: 409, body: { errors: [moved] } };
        }

        const result = saveSettings(configDir, body['value'], version, runtime.enabledSources());

        return result.errors.length === 0 ? { status: 200, body: { saved: true, version: result.version } } : { status: 409, body: { errors: result.errors } };
      },
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
    dock: () => {
      const view = dockView(runtime.snapshot(), deps.now(), windows);

      // The dock opens a row's item window from its file, so the file is there before the view is.
      for (const window of view.groups.flatMap((group) => group.rows.flatMap((row) => (row.window === null ? [] : [row.window])))) {
        try {
          writeWorkspaceFile(window, written);
        } catch (error) {
          deps.log(`workspace file ${window.file} not written: ${String(error)}`);
        }
      }

      return view;
    },
    attachDock: (send) => {
      sendDock = send;
    },
    attachWindows: (send) => {
      sendWindows = send;
    },
    snoozedUrls: () => store.snoozedTickets(deps.now()).flatMap((ticket) => (ticket.url === '' ? [] : [ticket.url])),
    cards: () => cardsOf(runtime.snapshot()),
    snoozeUrl: (url, until) => {
      const ticket = store.ticketInScopeByUrl(url);

      return ticket === null ? null : { refused: runtime.send({ type: 'snooze', ticketId: ticket.id, until }).refused };
    },
    unsnoozeUrl: (url) => {
      const ticket = store.ticketInScopeByUrl(url);

      return ticket === null ? null : { refused: runtime.send({ type: 'restore', ticketId: ticket.id }).refused };
    },
    onChange: (listener) => void runtime.onChange(listener),
    busy: () => runtime.hasActiveSessions() || debriefs.running(),
    close: () => {
      clearTimeout(pending);
      clearInterval(debriefTimer);
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
