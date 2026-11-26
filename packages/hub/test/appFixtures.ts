import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import type { Exec } from '@switchboard/claude';
import { CodexRunner } from '@switchboard/codex';
import { Store } from '@switchboard/core';
import type { SessionRunner } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHubApp, parseAction, parseReport } from '../src/app.js';
import { windowOf, windowsDir } from '../src/dock.js';
import { loadConfig } from '../src/config.js';
import { postToHub } from '../src/client.js';
import { listenHub } from '../src/server.js';
import type { Snapshot } from '../src/snapshot.js';
import { gitBashRoot, handledBody, isPastePath, registerTitle, reportBody, ticketBody } from '../src/report.js';
import { tempHome, until } from './helpers.js';
import type { HubApp } from '../src/serve.js';
import type { RuntimeDeps } from '../src/runtime.js';

/** A page's source icon, which turns a source on or off as the list header posts it. */
export const toggleSource = (app: HubApp, body: Record<string, unknown>) => app.post['/v1/conversation/page-source']!({ window: app.page!.opened(false), ...body });






export let temp: ReturnType<typeof tempHome>;
export let closers: (() => void | Promise<void>)[] = [];

beforeEach(() => {
  temp = tempHome();
  // No test may start the real Codex. Outside Windows the default `codex` is found on PATH, also while a test's settings fail to load.
  vi.stubEnv('PATH', (process.env['PATH'] ?? '').split(delimiter).filter((dir) => !['codex', 'codex.cmd', 'codex.exe'].some((name) => existsSync(join(dir, name)))).join(delimiter));
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }

  vi.unstubAllEnvs();
  temp.remove();
});

/** Answers only the hub's Node.js check. */
export const noCli: Exec = async (file, args) => {
  if (file === 'node' && args.join(' ') === '--version') {
    return { code: 0, stdout: 'v24.0.0\n', stderr: '', missing: false, timedOut: false };
  }

  throw new Error(`unexpected call ${file} ${args.join(' ')}`);
};

/**
 * Stand-ins for the Codex runners: an app-server start gives the session a thread at once, and the hooks' trust exchange answers trusted, so no
 * test starts a real `codex` (testing.md § Codex app-server).
 */
export function fakeCodex(): NonNullable<RuntimeDeps['runners']> {
  const codexAppServer: SessionRunner = {
    start: async (action) => ({ shortId: `${action.sessionId}-thread`, nativeSessionId: `${action.sessionId}-thread` }),
    observe: async (sessions) => ({ sessions: sessions.filter((session) => session.state !== 'ended').map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) }),
    markers: () => new Map(),
    isBackground: async () => true,
    stop: async () => null,
    reconcile: async () => [],
    installHooks: async () => null,
  };
  const codex = new CodexRunner({ codexPath: () => 'codex', nodePath: () => 'node', home: join(temp.home, '.switchboard'), codexHome: join(temp.home, '.codex'), env: {}, trust: async () => null });

  return { codexAppServer, codex };
}

export function writeSettings(settings: unknown): void {
  mkdirSync(join(temp.home, '.switchboard'), { recursive: true });
  writeFileSync(join(temp.home, '.switchboard', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
}


export async function start(log: (line: string) => void = () => {}) {
  // A settings file the hub cannot use leaves the default installHooks on, so the Codex hooks' trust exchange is stubbed too.
  const app = await createHubApp({ home: temp.home, log, deps: { exec: noCli, runners: { codex: fakeCodex().codex! } } });
  closers.push(() => app.close());

  return app;
}

/** Makes a new work item start needing the operator: built once, then moved to the operator's turn and built again; resolves its ID. */
export const needingIn = (app: Awaited<ReturnType<typeof start>>) => async (title: string): Promise<number> => {
  // The in-thread snapshot builder runs at the setImmediate a change asks for and publishes in the microtasks after it, before this one.
  const published = () => new Promise((done) => setImmediate(done));

  app.runtime.send({ type: 'adhoc', prompt: title, repoRoot: 'D:/scratch', start: false });
  await app.runtime.settled();
  await published();

  const id = (app.snapshot() as { workItems: { id: number; ticket: { title: string } }[] }).workItems.find((one) => one.ticket.title === title)!.id;
  const writer = Store.open(join(temp.home, '.switchboard', 'switchboard.db'));

  writer.updateWorkItem(id, { status: 'awaiting-approval' });
  writer.close();
  app.runtime.send({ type: 'adhoc', prompt: `${title} (rebuild)`, repoRoot: 'D:/scratch', start: false });
  await app.runtime.settled();
  await published();
  return id;
};
