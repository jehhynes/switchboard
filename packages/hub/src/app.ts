import { randomUUID } from 'node:crypto';
import { mkdirSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { spawnExec } from '@switchboard/claude';
import { Store, switchboardHome } from '@switchboard/core';
import type { FlowEvent, SourceSettings } from '@switchboard/core';
import { githubSource } from '@switchboard/github';
import { loadConfig, playbooksDir } from './config.js';
import type { HubApp } from './serve.js';
import { Runtime } from './runtime.js';
import type { ReportBody, RuntimeDeps } from './runtime.js';

const RELOAD_DEBOUNCE_MS = 300;

/** Operator events the panel may send (PRD R27). */
const OPERATOR_EVENTS = new Set(['adhoc', 'approve', 'retry', 'mark-done', 'retriage', 'change-playbook', 'stop']);

const REPORT_KINDS = new Set(['stage', 'worktree', 'done', 'blocked']);

function makeSource(name: string, settings: SourceSettings) {
  return name === 'github' ? githubSource(settings) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A report body names a session, one of the four kinds, and that kind's text. */
export function parseReport(body: unknown): ReportBody | null {
  if (!isRecord(body) || typeof body['sessionId'] !== 'string' || !REPORT_KINDS.has(String(body['kind']))) {
    return null;
  }

  const text = { stage: 'stage', worktree: 'path', done: 'summary', blocked: 'reason' }[body['kind'] as ReportBody['kind']];
  const value = body[text];

  if (body['kind'] === 'done' ? value !== null && value !== undefined && typeof value !== 'string' : typeof value !== 'string' || value === '') {
    return null;
  }

  return { ...body, [text]: value ?? null } as ReportBody;
}

/** An operator event from the panel. The core validates its target and refuses what does not apply. */
export function parseAction(body: unknown): FlowEvent | null {
  return isRecord(body) && OPERATOR_EVENTS.has(String(body['type'])) ? (body as unknown as FlowEvent) : null;
}

export interface AppOptions {
  home: string;
  log(line: string): void;
  /** Overrides for tests. */
  deps?: Partial<RuntimeDeps>;
}

/** Opens the store, loads configuration, and runs the core for the hub process. */
export async function createHubApp(options: AppOptions): Promise<HubApp & { runtime: Runtime }> {
  const home = switchboardHome(options.home);

  mkdirSync(join(home, 'playbooks'), { recursive: true });

  const store = Store.open(join(home, 'switchboard.db'));
  let config = loadConfig(options.home);
  const runtime = new Runtime(
    {
      home: options.home,
      store,
      exec: spawnExec,
      claudePath: 'claude',
      makeSource,
      now: Date.now,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      newSessionId: () => randomUUID().slice(0, 8),
      env: process.env,
      log: options.log,
      ...options.deps,
    },
    config,
  );

  // Settings and playbooks are reloaded when they change (PRD R42).
  let pending: NodeJS.Timeout | undefined;
  const reload = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      config = loadConfig(options.home, config.settings);
      runtime.reload(config);
    }, RELOAD_DEBOUNCE_MS);
  };
  const watchers: FSWatcher[] = [
    watch(home, (_event, file) => file === 'settings.json' && reload()),
    watch(playbooksDir(options.home), { recursive: true }, reload),
  ];

  await runtime.startup();
  runtime.start();

  return {
    runtime,
    post: {
      '/report': async (body) => {
        const report = parseReport(body);

        if (report === null) {
          return { status: 400, body: { error: 'Expected {sessionId, kind, stage|path|summary|reason}.' } };
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
      '/claim': async (body) => {
        if (!isRecord(body) || typeof body['folder'] !== 'string') {
          return { status: 400, body: { error: 'Expected {folder}.' } };
        }

        return { status: 200, body: { sessionId: runtime.claimOpen(body['folder']) } };
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
    onChange: (listener) => void runtime.onChange(listener),
    busy: () => runtime.hasActiveSessions(),
    close: () => {
      clearTimeout(pending);
      runtime.stop();

      for (const watcher of watchers) {
        watcher.close();
      }

      store.close();
    },
  };
}
