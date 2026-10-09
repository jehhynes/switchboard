import { randomUUID } from 'node:crypto';
import { mkdirSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { claudeService, claudeSettingsPath, readRoster, spawnExec } from '@switchboard/claude';
import { Store, switchboardHome } from '@switchboard/core';
import { PERMISSION_MODES, PLAYBOOK_REPORTS, TEMPLATE_VARIABLES } from '@switchboard/core';
import type { FlowEvent, PlaybookFields, SourceSettings } from '@switchboard/core';
import { githubSource } from '@switchboard/github';
import { zohoSource } from '@switchboard/zoho';
import { forumSource } from '@switchboard/forum';
import { findBash } from './bash.js';
import { cardsOf } from './cards.js';
import { dockView, windowsDir, writeWorkspaceFile } from './dock.js';
import { isPastePath } from './report.js';
import { DEBRIEF_SCAN_MS, Debriefs } from './debriefs.js';
import { SOURCE_KINDS, checkPlaybook, checkSettings, deletePlaybook, loadConfig, playbooksDir, readConfigFiles, savePlaybook, saveSettings, setSourceEnabled } from './config.js';
import type { HubApp } from './serve.js';
import { Runtime } from './runtime.js';
import type { ReportBody, RuntimeDeps } from './runtime.js';

const RELOAD_DEBOUNCE_MS = 300;

/** Operator events the dock may send (PRD R27). */
const OPERATOR_EVENTS = new Set(['adhoc', 'start', 'approve', 'mark-done', 'retriage', 'stop', 'answer', 'open-question', 'pick', 'retriage-pool', 'snooze', 'restore']);

const REPORT_KINDS = new Set(['stage', 'worktree', 'done', 'approval', 'link', 'playbook', 'paste', 'task']);

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

  const optional = (field: string, valid: (value: unknown) => boolean) => body[field] === undefined || body[field] === null || valid(body[field]);

  // A task's repo is checked against the repo roots by the core; here it must be an absolute path (PRD R68).
  if (body['kind'] === 'task') {
    const prompt = body['prompt'];

    return typeof prompt === 'string' && prompt !== '' && optional('repo', isReportPath) && optional('title', (value) => typeof value === 'string')
      ? { sessionId: body['sessionId'], kind: 'task', prompt, repo: (body['repo'] as string | undefined) ?? null, title: (body['title'] as string | undefined) ?? null }
      : null;
  }

  const text = { stage: 'stage', worktree: 'path', approval: 'prompt', playbook: 'playbook' }[body['kind'] as Exclude<ReportBody['kind'], 'link' | 'done' | 'paste' | 'task'>];
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
  if (body['type'] === 'answer' || body['type'] === 'open-question') {
    const { workItemId, nativeSessionId } = body;

    if (!Number.isInteger(workItemId) || typeof nativeSessionId !== 'string') {
      return null;
    }

    if (body['type'] === 'open-question') {
      return { type: 'open-question', workItemId: workItemId as number, nativeSessionId };
    }

    return typeof body['answer'] === 'string' && typeof body['question'] === 'string'
      ? { type: 'answer', workItemId: workItemId as number, nativeSessionId, question: body['question'], answer: body['answer'] }
      : null;
  }

  return body as unknown as FlowEvent;
}

export interface AppOptions {
  home: string;
  /** The folder holding settings.json and playbooks/; the Switchboard home when left out. */
  configDir?: string;
  log(line: string): void;
  /** Overrides for tests. */
  deps?: Partial<RuntimeDeps>;
}

/** Opens the store, loads configuration, and runs the core for the hub process. */
export async function createHubApp(options: AppOptions): Promise<HubApp & { runtime: Runtime }> {
  const home = switchboardHome(options.home);
  const configDir = options.configDir ?? home;

  mkdirSync(playbooksDir(configDir), { recursive: true });

  const store = Store.open(join(home, 'switchboard.db'));
  let config = loadConfig(configDir);
  const deps: RuntimeDeps = {
    home: options.home,
    configDir,
    store,
    exec: spawnExec,
    claudePath: 'claude',
    makeSource,
    now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    newSessionId: () => randomUUID().slice(0, 8),
    claudeSettings: claudeSettingsPath(homedir(), process.env),
    service: claudeService,
    log: options.log,
    ...options.deps,
  };
  const runtime = new Runtime(deps, config);
  const claudeRoot = dirname(deps.claudeSettings).replaceAll('\\', '/');
  const debriefs = new Debriefs({
    dir: `${claudeRoot}/.wip/debrief`,
    promptPath: `${claudeRoot}/skills/friction-review/prompt.md`,
    projectsDir: `${claudeRoot}/projects`,
    claudePath: deps.claudePath,
    codexScript: `${claudeRoot}/tools/agent-delegate/debrief.mjs`,
    nodePath: process.execPath,
    exec: deps.exec,
    enabled: () => config.settings.sessions.debriefs,
    sessions: () => store.startedSessions(),
    workItemDone: (id) => store.workItem(id)?.status === 'done',
    roster: () => readRoster(deps.claudePath, deps.exec),
    now: deps.now,
    newId: randomUUID,
    log: deps.log,
  });

  let sendDock: (event: string, data: unknown) => number = () => 0;
  /** Why a write from a Settings window that read another config folder is refused, or null; a body without `configDir` names none. */
  const movedFrom = (read: unknown): string | null =>
    typeof read === 'string' && read !== configDir ? `The config folder is now ${configDir}, not ${read}. Settings reads it again; make your change there.` : null;
  // What each item window's workspace file holds, so a dock view writes only the files that changed (PRD R71).
  const written = new Map<string, string>();
  const windows = windowsDir(options.home);

  // Settings and playbooks are reloaded when they change (PRD R42).
  let pending: NodeJS.Timeout | undefined;
  const reload = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      config = loadConfig(configDir, config.settings);
      runtime.reload(config);
      // The dock's Settings window reads the files again (PRD R54).
      sendDock('config', {});
    }, RELOAD_DEBOUNCE_MS);
  };
  const watchers: FSWatcher[] = [
    watch(configDir, (_event, file) => file === 'settings.json' && reload()),
    watch(playbooksDir(configDir), { recursive: true }, reload),
  ];

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

        const { refused } = await runtime.report(report);

        return refused === null ? { status: 200, body: { recorded: true } } : { status: 409, body: { error: refused } };
      },
      '/open': async (body) => {
        if (!isRecord(body) || typeof body['sessionId'] !== 'string' || typeof body['cwd'] !== 'string' || !optionalString(body['workspace'])) {
          return { status: 400, body: { error: 'Expected {sessionId, cwd, workspace?}.' } };
        }

        runtime.recordOpen(body['sessionId'], body['cwd'], body['workspace'] ?? null);

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

        return { status: 200, body: { sessionId: runtime.claimOpen(body['folder'], workspace), commands: runtime.claimCommands(workspace, body['focused'] === true) } };
      },
      '/window': async (body) => {
        if (!isRecord(body) || !optionalString(body['workspace']) || !isWindowCommand(body['command'], body['workspace'] ?? null)) {
          return { status: 400, body: { error: 'Expected {workspace, command} with a changes, history or openUrl command, or openTabs for a workspace.' } };
        }

        return { status: 200, body: { id: runtime.recordCommand(body['command'], body['workspace'] ?? null) } };
      },
      '/window/withdraw': async (body) => {
        if (!isRecord(body) || !Number.isInteger(body['id'])) {
          return { status: 400, body: { error: 'Expected {id}.' } };
        }

        return { status: 200, body: { withdrawn: runtime.withdrawCommand(body['id'] as number) } };
      },
      '/sources': async (body) => {
        if (!isRecord(body) || typeof body['name'] !== 'string' || typeof body['enabled'] !== 'boolean') {
          return { status: 400, body: { error: 'Expected {name, enabled}.' } };
        }

        const error = setSourceEnabled(configDir, body['name'], body['enabled']);

        return error === null ? { status: 200, body: { done: true } } : { status: 409, body: { error } };
      },
      '/dock/show': async () =>
        sendDock('show', {}) > 0 ? { status: 200, body: { shown: true } } : { status: 409, body: { error: 'The dock is not running.' } },
      // The dock's Settings window (PRD R54): the files with their versions, and what the editor offers.
      '/config/read': async () => ({
        status: 200,
        body: { ...readConfigFiles(configDir), configDir, permissionModes: [...PERMISSION_MODES], templateVariables: [...TEMPLATE_VARIABLES], sourceKinds: [...SOURCE_KINDS], inUse: openPlaybooks(runtime) },
      }),
      '/config/check': async (body) => {
        if (isRecord(body) && body['target'] === 'settings') {
          return { status: 200, body: { errors: checkSettings(body['settings']) } };
        }

        if (!isRecord(body) || body['target'] !== 'playbook' || typeof body['name'] !== 'string' || !isPlaybookFields(body['playbook'])) {
          return { status: 400, body: { error: 'Expected {target: settings, settings} or {target: playbook, name, playbook}.' } };
        }

        const checked = checkPlaybook(body['name'], body['playbook']);

        return { status: 200, body: { errors: 'errors' in checked ? checked.errors : [] } };
      },
      '/config/save': async (body) => {
        const version = isRecord(body) ? body['version'] : undefined;

        if (!isRecord(body) || !(version === null || typeof version === 'string')) {
          return { status: 400, body: { error: 'Expected {target, version} with the settings or a playbook.' } };
        }

        const moved = movedFrom(body['configDir']);

        if (moved !== null) {
          return { status: 409, body: { errors: [moved] } };
        }

        let errors: string[];

        if (body['target'] === 'settings') {
          errors = saveSettings(configDir, body['value'], version);
        } else if (body['target'] === 'playbook' && typeof body['name'] === 'string' && isPlaybookFields(body['playbook'])) {
          errors = savePlaybook(configDir, body['name'], body['playbook'], version);
        } else {
          return { status: 400, body: { error: 'Expected {target: settings, value, version} or {target: playbook, name, playbook, version}.' } };
        }

        return errors.length === 0 ? { status: 200, body: { saved: true } } : { status: 409, body: { errors } };
      },
      '/config/delete': async (body) => {
        if (!isRecord(body) || typeof body['name'] !== 'string' || typeof body['version'] !== 'string') {
          return { status: 400, body: { error: 'Expected {name, version}.' } };
        }

        const moved = movedFrom(body['configDir']);

        if (moved !== null) {
          return { status: 409, body: { errors: [moved] } };
        }

        const errors = deletePlaybook(configDir, body['name'], body['version']);

        return errors.length === 0 ? { status: 200, body: { deleted: true } } : { status: 409, body: { errors } };
      },
      '/action': async (body) => {
        const event = parseAction(body);

        if (event === null) {
          return { status: 400, body: { error: 'Unknown action.' } };
        }

        const { refused } = event.type === 'answer' ? runtime.answer(event) : runtime.send(event);

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

/** A playbook's fields as the Settings window sends them, with the types `checkPlaybook` reads. */
function isPlaybookFields(value: unknown): value is PlaybookFields {
  if (!isRecord(value)) {
    return false;
  }

  const nullableString = (key: string) => value[key] === null || typeof value[key] === 'string';

  return (
    typeof value['description'] === 'string' &&
    (value['kind'] === 'task' || value['kind'] === 'triage') &&
    ['autoStart', 'requiresWorktree', 'approvalSends', 'rates'].every((key) => typeof value[key] === 'boolean') &&
    nullableString('permissionMode') &&
    nullableString('model') &&
    (value['workdir'] === 'worktree' || value['workdir'] === 'repoRoot') &&
    Array.isArray(value['reports']) &&
    value['reports'].every((report) => (PLAYBOOK_REPORTS as readonly unknown[]).includes(report)) &&
    typeof value['template'] === 'string'
  );
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
    case 'openUrl':
      return text('url');
    // An item window opens its own tabs (PRD R72), so another window cannot take the command.
    case 'openTabs':
      return workspace !== null;
    default:
      return false;
  }
}
