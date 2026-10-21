import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { BROWSER_PORT, HUB_NAME, PROTOCOL, hubRecordPath, switchboardHome } from '@switchboard/core';
import type { Card, HubRecord } from '@switchboard/core';
import { listenBrowser } from './browser.js';
import type { BrowserServer } from './browser.js';
import type { SnoozeByUrl, UnsnoozeByUrl } from './browserSnooze.js';
import { findHub, readHubRecord } from './discover.js';
import { holdLock, releaseLock } from './lock.js';
import { listenHub } from './server.js';
import type { Reply } from './server.js';

/** What the hub serves beyond its lifecycle: the snapshot and the dock view, requests, and the sessions that keep it running. */
export interface HubApp {
  post: Record<string, (body: unknown) => Promise<Reply>>;
  snapshot(): unknown;
  /** The dock view (PRD R71). */
  dock(): object;
  /** URLs of snoozed tickets, for the Chrome extension (PRD R56). */
  snoozedUrls(): string[];
  /** Each ticket's playbook and group, for the Chrome extension (PRD R67). */
  cards(): Card[];
  /** Snoozes a ticket by URL for the Chrome extension (PRD R66). */
  snoozeUrl: SnoozeByUrl;
  /** Ends a ticket's snooze by URL for the Chrome extension (PRD R66). */
  unsnoozeUrl: UnsnoozeByUrl;
  onChange(listener: () => void): void;
  /** Gives the app the way to send an event to the dock's streams, which answers how many it reached. */
  attachDock?(send: (event: string, data: unknown) => number): void;
  /** Receives the sender of forwarded clicks to the dock (PRD R65, R69). */
  attachDockClick?(click: (data: unknown) => boolean): void;
  /** Gives the app the way to send an event to the VS Code windows' streams. */
  attachWindows?(send: (event: string, data: unknown) => number): void;
  /** While true, the hub does not exit for lack of clients (PRD R43). */
  busy(): boolean;
  close(): void;
}

export interface ServeOptions {
  home: string;
  version: string;
  build: string;
  /** Recorded so a window can tell whether the hub reads the config folder it expects. */
  configDir: string;
  idleMs?: number;
  /** The browser endpoint's port; null serves none. Defaults to `BROWSER_PORT`. */
  browserPort?: number | null;
  /** How long a hub that lost the lock waits for the holder's record. */
  waitMs?: number;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  /** Built once this process holds the hub lock, so a losing start never opens the store. */
  app?: () => Promise<HubApp>;
}

export interface Served {
  record: HubRecord;
  stop(reason: string): Promise<void>;
}

export type ServeResult = { served: Served } | { existing: HubRecord } | { refused: string };

export const DEFAULT_IDLE_MS = 30 * 60_000;
export const DEFAULT_WAIT_MS = 5000;

/** Write through a temporary file, so a reader never sees a partial record. */
function writeRecord(path: string, record: HubRecord): void {
  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, JSON.stringify(record, null, 2));
  renameSync(temporary, path);
}

async function waitForHub(home: string, waitMs: number): Promise<HubRecord | null> {
  for (const deadline = Date.now() + waitMs; ; ) {
    const found = await findHub(home);

    if (found !== null || Date.now() > deadline) {
      return found;
    }

    await new Promise((done) => setTimeout(done, 100));
  }
}

/**
 * Serve the hub for a home, or report the hub already serving it. Only the holder of the hub lock writes or removes
 * `hub.json`, so concurrent starts leave one hub. Exits after `idleMs` with no connected client.
 */
export async function serveHub(options: ServeOptions): Promise<ServeResult> {
  const { home, version, build, configDir } = options;
  const path = hubRecordPath(home);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`));
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;

  mkdirSync(switchboardHome(home), { recursive: true });

  const lock = await holdLock(home);

  if (lock === null) {
    const existing = await waitForHub(home, options.waitMs ?? DEFAULT_WAIT_MS);

    return existing === null ? { refused: 'another process holds the hub lock but no hub answers' } : { existing };
  }

  let stopping: Promise<void> | undefined;

  const app = options.app === undefined ? undefined : await options.app();
  const server = await listenHub({
    identity: { hub: HUB_NAME, protocol: PROTOCOL, version, pid: process.pid },
    onShutdown: () => void stop('a client asked it to stop').then(() => exit(0)),
    ...(app === undefined ? {} : { post: app.post, snapshot: () => app.snapshot(), dock: () => app.dock() }),
  });

  app?.onChange(() => server.update());
  app?.attachDock?.((event, data) => server.notifyDock(event, data));
  app?.attachDockClick?.((data) => server.clickDock(data));
  app?.attachWindows?.((event, data) => server.notifyWindows(event, data));

  const browserPort = options.browserPort === undefined ? BROWSER_PORT : options.browserPort;
  let browser: BrowserServer | null = null;

  if (app !== undefined && browserPort !== null) {
    // A taken port, such as one held by a second hub for another home, costs only the Chrome extension.
    browser = await listenBrowser(browserPort, () => app.snoozedUrls(), () => app.cards(), (url, until) => app.snoozeUrl(url, until), (url) => app.unsnoozeUrl(url)).catch((error: unknown) => {
      log(`browser endpoint not served on 127.0.0.1:${browserPort}: ${String(error)}`);

      return null;
    });
  }

  const record: HubRecord = {
    protocol: PROTOCOL,
    version,
    build,
    configDir,
    execPath: process.execPath,
    port: server.port,
    token: server.token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  // Any record already here belongs to a hub that died, since this process holds the lock.
  writeRecord(path, record);

  /** Remove the record only while it is still this hub's. */
  const unclaim = (): void => {
    if (readHubRecord(home)?.token === record.token) {
      rmSync(path, { force: true });
    }
  };

  process.on('exit', unclaim);

  const idle = setInterval(
    () => {
      const since = server.emptySince();

      if (since !== null && Date.now() - since >= idleMs && app?.busy() !== true) {
        void stop('no client connected').then(() => exit(0));
      }
    },
    Math.max(50, Math.min(60_000, Math.floor(idleMs / 4))),
  );

  idle.unref();

  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      log(`stopping: ${reason}`);
      clearInterval(idle);
      process.off('exit', unclaim);
      server.stopViews();
      app?.close();
      await browser?.close();
      await server.close();
      unclaim();
      await releaseLock(lock);
    })();

    return stopping;
  };

  log(`listening on 127.0.0.1:${server.port} as pid ${process.pid}, build ${build}`);

  return { served: { record, stop } };
}
