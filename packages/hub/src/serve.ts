import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { BROWSER_PORT, HUB_NAME, PROTOCOL, hubRecordPath, switchboardHome } from '@switchboard/core';
import type { Card, HubRecord } from '@switchboard/core';
import { listenBrowser } from './browser.js';
import type { BrowserServer } from './browser.js';
import type { SnoozeByUrl, UnsnoozeByUrl } from './browserSnooze.js';
import { findHub, readHubRecord } from './discover.js';
import { holdLock, releaseLock } from './lock.js';
import { clearHandover, handedOver, HubRestart, installedBuild, pendingHandover, RESTART_CHECK_MS, TAKEOVER_WAIT_MS, writeHandover } from './restart.js';
import type { Successor } from './restart.js';
import { listenHub } from './server.js';
import { clearStopped, writeStopped } from './supervise.js';
import type { PageRoutes, PostContext, Reply } from './server.js';

/** What the hub serves beyond its lifecycle: the snapshot and the dock view, requests, and the sessions that keep it running. */
export interface HubApp {
  post: Record<string, (body: unknown, context?: PostContext) => Promise<Reply>>;
  snapshot(): unknown;
  /** A page's conversation stream closed, so its page key dies. */
  windowClosed?(key: string): void;
  /** Opens a page's conversation stream; null for a key no page holds. */
  conversation?(key: string, write: (frame: string) => void): { close(): void } | null;
  /** The web page's routes (architecture.md § Web page). */
  page?: PageRoutes;
  /** The web page's fixed port, `web.port` as the hub started; 0 for none. */
  pagePort?(): number;
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
  /** Gives the app the way to end the remote page streams that a change of remote access no longer allows. */
  attachRemote?(changed: () => void): void;
  /** Gives the app the local web page's URL once it is served, which a needs-you system notification opens (PRD R65). */
  attachPageUrl?(url: () => Promise<string>): void;
  /** While true, the hub does not exit for lack of clients (PRD R43). */
  busy(): boolean;
  /** Why the hub cannot restart onto a new build now, or null when it is quiet (architecture.md § Hub lifecycle). */
  quiet?(): string | null;
  /**
   * What the app carries to its successor's app as the hub hands over, such as the voice's device and target, written to `hub-handover.json`;
   * it changes nothing (architecture.md § Hub lifecycle).
   */
  handover?(): Record<string, unknown>;
  /** The handover file is written: the app stops acting on what it handed over. */
  handedOver?(): void;
  close(): void;
}

export interface ServeOptions {
  home: string;
  version: string;
  build: string;
  /** Recorded so a window can tell whether the hub reads the config folder it expects. */
  configDir: string;
  /** Exit after this long with no connected client, for tests; without it the hub runs until it is stopped. */
  idleMs?: number;
  /** The browser endpoint's port; null serves none. Defaults to `BROWSER_PORT`. */
  browserPort?: number | null;
  /** The web page's fixed port in place of the app's `web.port`; 0 serves the page only on the hub's port. */
  pagePort?: number;
  /** How long a hub that lost the lock waits for the holder's record. */
  waitMs?: number;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  /** Built once this process holds the hub lock, so a losing start never opens the store; a successor's gets what the hub before it carried. */
  app?: (carried: Record<string, unknown> | null) => Promise<HubApp>;
  /** The pid of the hub this one takes over from, whose lock it waits for (`--takeover`). */
  takeover?: number;
  /** Restarts onto the installed bundle when that is another build (architecture.md § Hub lifecycle). */
  restart?: RestartOptions;
}

export interface RestartOptions {
  /** The installed bundle, `<home>/.switchboard/hub.js`. */
  bundle: string;
  /** Starts the installed bundle as the successor and resolves once it is ready. */
  successor(): Promise<Successor | { error: string }>;
  checkMs?: number;
  takeoverWaitMs?: number;
}

export interface Served {
  record: HubRecord;
  stop(reason: string): Promise<void>;
}

export type ServeResult = { served: Served } | { existing: HubRecord } | { refused: string };

export const DEFAULT_WAIT_MS = 5000;
/** How long a stopping hub waits for the requests it is answering before it closes the app. */
export const STOP_REQUESTS_MS = 5000;

/** Write through a temporary file, so a reader never sees a partial record. */
function writeRecord(path: string, record: HubRecord): void {
  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, JSON.stringify(record, null, 2));
  renameSync(temporary, path);
}

async function waitForHub(home: string, waitMs: number, wanted: (found: HubRecord) => boolean = () => true): Promise<HubRecord | null> {
  for (const deadline = Date.now() + waitMs; ; ) {
    const found = await findHub(home);

    if ((found !== null && wanted(found)) || Date.now() > deadline) {
      return found !== null && wanted(found) ? found : null;
    }

    await new Promise((done) => setTimeout(done, 100));
  }
}

/**
 * Serve the hub for a home, or report the hub already serving it. Only the holder of the hub lock writes or removes
 * `hub.json`, so concurrent starts leave one hub. Runs until it is stopped, or with `idleMs` until that long passes with no connected client.
 */
export async function serveHub(options: ServeOptions): Promise<ServeResult> {
  const { home, version, build, configDir } = options;
  const path = hubRecordPath(home);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`));
  const idleMs = options.idleMs;

  mkdirSync(switchboardHome(home), { recursive: true });

  // A hub restarting onto a new build hands over to its successor; a hub a window or the dock starts meanwhile waits for that one, since it could
  // take the lock first, and stops waiting once the handover names no running successor.
  const awaitSuccessor = async (): Promise<HubRecord | null> => {
    for (const deadline = Date.now() + (options.restart?.takeoverWaitMs ?? TAKEOVER_WAIT_MS); options.takeover === undefined && Date.now() < deadline; ) {
      const handover = pendingHandover(home);

      if (handover === null) {
        return null;
      }

      const found = await findHub(home);

      if (found !== null && found.pid === handover.pid) {
        return found;
      }

      await new Promise((done) => setTimeout(done, 100));
    }

    return null;
  };

  const waited = await awaitSuccessor();

  if (waited !== null) {
    return { existing: waited };
  }

  let lock = await holdLock(home);

  // A start that checked before the old hub named its successor can still take the lock that hub releases; it gives the lock back to the successor.
  if (lock !== null && options.takeover === undefined && pendingHandover(home) !== null) {
    await releaseLock(lock);

    const successor = await awaitSuccessor();

    if (successor !== null) {
      return { existing: successor };
    }

    lock = await holdLock(home);
  }

  // A successor waits for the hub it takes over from to let go of the lock, unless another hub took it meanwhile.
  for (const deadline = Date.now() + (options.restart?.takeoverWaitMs ?? TAKEOVER_WAIT_MS); lock === null && options.takeover !== undefined; ) {
    const other = await findHub(home);

    if (other !== null && other.pid !== options.takeover) {
      return { existing: other };
    }

    if (Date.now() > deadline) {
      return { refused: `the hub (pid ${options.takeover}) did not hand over the hub lock within ${(options.restart?.takeoverWaitMs ?? TAKEOVER_WAIT_MS) / 1000} seconds` };
    }

    await new Promise((done) => setTimeout(done, 50));
    lock = await holdLock(home);
  }

  if (lock === null) {
    const existing = await waitForHub(home, options.waitMs ?? DEFAULT_WAIT_MS);

    return existing === null ? { refused: 'another process holds the hub lock but no hub answers' } : { existing };
  }

  const hubLock = lock;

  // Cleared as soon as this hub holds the lock, so a start that fails from here on counts as a crash rather than the earlier deliberate stop.
  clearStopped(home);

  let stopping: Promise<void> | undefined;

  const app = options.app === undefined ? undefined : await options.app(options.takeover === undefined ? null : handedOver(home, process.pid));
  const server = await listenHub({
    identity: { hub: HUB_NAME, protocol: PROTOCOL, version, pid: process.pid },
    build,
    log,
    onShutdown: () => void stop('a client asked it to stop').then(() => exit(0)),
    onRestart: () => {
      const asked = restart?.request() ?? { refused: 'This hub cannot restart itself.' };

      return 'refused' in asked ? { status: 409, body: { error: asked.refused } } : { status: 200, body: { build, ...asked } };
    },
    ...(app === undefined
      ? {}
      : {
          post: app.post,
          dock: () => app.dock(),
          ...(app.windowClosed === undefined ? {} : { windowClosed: (key: string) => app.windowClosed!(key) }),
          ...(app.conversation === undefined ? {} : { conversation: (key: string, write: (frame: string) => void) => app.conversation!(key, write) }),
          ...(app.page === undefined ? {} : { page: app.page }),
        }),
  });

  // A burst of changes, such as a poll's worktree links, rebuilds the views once.
  let update: NodeJS.Immediate | undefined;

  app?.onChange(() => {
    update ??= setImmediate(() => {
      update = undefined;
      server.update();
    });
  });
  app?.attachDock?.((event, data) => server.notifyDock(event, data));
  app?.attachDockClick?.((data) => server.clickDock(data));
  app?.attachRemote?.(() => server.remoteChanged());
  app?.attachPageUrl?.(() => server.pageUrl());

  const pagePort = options.pagePort ?? app?.pagePort?.() ?? 0;

  if (app?.page !== undefined && pagePort > 0) {
    // A taken port leaves the page on the hub's own port, whose links then say so.
    void server.listenPage(pagePort).then((error) =>
      log(error === null ? `web page on http://127.0.0.1:${pagePort}/page/` : `web page not served on 127.0.0.1:${pagePort}: ${error}; it is on the hub's port ${server.port}, which changes at each start`),
    );
  }

  const browserPort = options.browserPort === undefined ? BROWSER_PORT : options.browserPort;
  let browser: BrowserServer | null = null;

  if (app !== undefined && browserPort !== null) {
    // A taken port, such as one held by a second hub for another home, costs only the Chrome extension.
    browser = await listenBrowser(browserPort, () => app.snoozedUrls(), () => app.cards(), (url, until) => app.snoozeUrl(url, until), (url) => app.unsnoozeUrl(url), async () => {
      const origin = new URL(await server.pageUrl()).origin;
      return { enabled: app.page?.browser?.iframeEnabled?.() === true, origins: [origin, origin.replace('127.0.0.1', 'localhost')] };
    }).catch((error: unknown) => {
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
    ...(options.restart === undefined ? {} : { restarts: true }),
  };

  // Any record already here belongs to a hub that died, since this process holds the lock.
  writeRecord(path, record);
  clearHandover(home, process.pid);

  /** Remove the record only while it is still this hub's. */
  const unclaim = (): void => {
    if (readHubRecord(home)?.token === record.token) {
      rmSync(path, { force: true });
    }
  };

  process.on('exit', unclaim);

  const idle =
    idleMs === undefined
      ? undefined
      : setInterval(
          () => {
            const since = server.emptySince();

            if (since !== null && Date.now() - since >= idleMs && app?.busy() !== true) {
              void stop('no client connected').then(() => exit(0));
            }
          },
          Math.max(50, Math.min(60_000, Math.floor(idleMs / 4))),
        );

  idle?.unref();

  const restartOptions = options.restart;
  const restart =
    restartOptions === undefined
      ? null
      : new HubRestart({
          build,
          installed: installedBuild(restartOptions.bundle),
          quiet: () => (stopping !== undefined ? 'the hub is stopping' : server.inFlight() > 0 ? 'a request is being answered' : (app?.quiet?.() ?? null)),
          successor: () => restartOptions.successor(),
          handOver: async (started) => {
            try {
              writeHandover(home, started.pid, Date.now(), app?.handover?.());
            } catch (error) {
              started.cancel();
              return { error: `the handover could not be written: ${(error as Error).message}` };
            }

            app?.handedOver?.();
            server.hold('The hub is restarting onto a new build; try again in a few seconds.');
            await stop('restarting onto the installed build', false);

            const successor = await waitForHub(home, restartOptions.takeoverWaitMs ?? TAKEOVER_WAIT_MS, (found) => found.token !== record.token);

            log(successor === null ? `hub restart: no hub took over within ${(restartOptions.takeoverWaitMs ?? TAKEOVER_WAIT_MS) / 1000} seconds; hub.js start or its supervisor starts one` : `hub restart: pid ${successor.pid} took over with build ${successor.build}`);
            exit(0);
          },
          log,
        });
  const restartTimer = restart === null ? undefined : setInterval(() => void restart.check(), restartOptions?.checkMs ?? RESTART_CHECK_MS);

  restartTimer?.unref();

  /** `deliberate`: a stop the supervisor leaves stopped, which a restart onto a new build is not. */
  const stop = (reason: string, deliberate = true): Promise<void> => {
    stopping ??= (async () => {
      log(`stopping: ${reason}`);

      // Written while this hub still holds the lock, so the supervisor never sees the lock free without it.
      if (deliberate) {
        try {
          writeStopped(home, reason);
        } catch (error) {
          log(`hub-stopped.json could not be written: ${(error as Error).message}`);
        }
      }

      clearInterval(idle);
      clearInterval(restartTimer);
      clearImmediate(update);
      process.off('exit', unclaim);
      server.stopViews();
      // A request being answered still uses the app; later ones are refused, and the app closes once those finish or after 5 seconds.
      server.hold(`The hub is stopping: ${reason}.`);

      for (const until = Date.now() + STOP_REQUESTS_MS; server.inFlight() > 0 && Date.now() < until; ) {
        await new Promise((done) => setTimeout(done, 20));
      }

      await browser?.close();
      // Closing the server ends the streams, whose close handlers still read the app's store, such as the pane's tabs of a page that closes; the
      // app closes after them.
      await server.close();
      await new Promise((done) => setImmediate(done));
      app?.close();
      unclaim();
      await releaseLock(hubLock);
    })();

    return stopping;
  };

  log(`listening on 127.0.0.1:${server.port} as pid ${process.pid}, build ${build}`);

  return { served: { record, stop } };
}
