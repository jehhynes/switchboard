import { randomUUID } from 'node:crypto';
import { mkdirSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { claudeSettingsPath, readRoster, spawnExec } from '@switchboard/claude';
import { Store, switchboardHome } from '@switchboard/core';
import type { FlowEvent, SourceSettings } from '@switchboard/core';
import { githubSource } from '@switchboard/github';
import { zohoSource } from '@switchboard/zoho';
import { forumSource } from '@switchboard/forum';
import { findBash } from './bash.js';
import { cardsOf } from './cards.js';
import { isPastePath } from './report.js';
import { DEBRIEF_SCAN_MS, Debriefs } from './debriefs.js';
import { loadConfig, playbooksDir, setSourceEnabled } from './config.js';
import type { HubApp } from './serve.js';
import { Runtime } from './runtime.js';
import type { ReportBody, RuntimeDeps } from './runtime.js';

const RELOAD_DEBOUNCE_MS = 300;

/** Operator events the panel may send (PRD R27). */
const OPERATOR_EVENTS = new Set(['adhoc', 'start', 'approve', 'mark-done', 'retriage', 'stop', 'pick', 'retriage-pool', 'snooze', 'restore']);

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

  // Settings and playbooks are reloaded when they change (PRD R42).
  let pending: NodeJS.Timeout | undefined;
  const reload = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      config = loadConfig(configDir, config.settings);
      runtime.reload(config);
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
        if (!isRecord(body) || typeof body['sessionId'] !== 'string' || typeof body['cwd'] !== 'string') {
          return { status: 400, body: { error: 'Expected {sessionId, cwd}.' } };
        }

        runtime.recordOpen(body['sessionId'], body['cwd']);

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
        if (!isRecord(body) || typeof body['folder'] !== 'string') {
          return { status: 400, body: { error: 'Expected {folder}.' } };
        }

        return { status: 200, body: { sessionId: runtime.claimOpen(body['folder']) } };
      },
      '/sources': async (body) => {
        if (!isRecord(body) || typeof body['name'] !== 'string' || typeof body['enabled'] !== 'boolean') {
          return { status: 400, body: { error: 'Expected {name, enabled}.' } };
        }

        const error = setSourceEnabled(configDir, body['name'], body['enabled']);

        return error === null ? { status: 200, body: { done: true } } : { status: 409, body: { error } };
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
