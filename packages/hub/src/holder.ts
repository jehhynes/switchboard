import { rotateLog } from '@switchboard/core';
import type { LogLevel } from '@switchboard/core';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answers } from '@switchboard/core';
import { HolderClient, LOG_FILE, PROTOCOL, holderLockAddress, killTree, parseHolderRecord, recordPath } from '@switchboard/holder';
import type { ConnectOptions, HolderRecord, SessionEntry, SpawnRequest } from '@switchboard/holder';
import { currentHolderBuild, reserveHolderBuild } from './holderInstall.js';

/** How long a started holder may take to answer (architecture.md § Terminal holder). */
export const HOLDER_START_MS = 10_000;
const POLL_MS = 100;

/** The holder calls the hub makes; `HolderClient` provides them. */
export interface HolderConnection {
  readonly welcome: { protocol: number; build: string; pid: number; features?: string[] };
  readonly compatible: boolean;
  spawn(request: SpawnRequest): Promise<{ session: string; pid: number }>;
  list(): Promise<SessionEntry[]>;
  kill(session: string): Promise<number | null>;
  screen(session: string): Promise<{ head: string; text: string }>;
  /** Present on a holder client; call it only when `welcome.features` names `snapshot`. */
  snapshot?(session: string, scrollback: number): Promise<{ data: string; cols: number; rows: number; rev: number; keyAt?: number | null }>;
  /** Present on a holder client; call it only when `welcome.features` names `write`. */
  write?(session: string, data: string, key?: boolean): Promise<{ rev: number }>;
  /** Present on a holder client; call it only when `welcome.features` names `view`. */
  size?(session: string, cols: number, rows: number): Promise<{ rev: number }>;
  shutdown(): Promise<void>;
  onClose(listener: () => void): void;
  close(): void;
}

/** `gone`: no holder holds the lock, so every session it held has ended (PRD R94). */
export type HolderFound = { holder: HolderConnection } | { gone: true } | { error: string };

/** A restart's outcome: the holder of the installed build, the live sessions that kept the old one running, or why it failed. */
export type HolderRestart = { holder: HolderConnection } | { live: string[] } | { error: string };

/** How long a holder asked to exit may take to answer `shutdown`. */
const SHUTDOWN_ANSWER_MS = 5_000;

export interface HolderLinkDeps {
  /** The Switchboard home, which holds `holder.json` and the installed builds. */
  home: string;
  /** Read at each start, so a change to `sessions.nodePath` applies to the next one. */
  nodePath(): string;
  log(line: string, level?: LogLevel): void;
  /** Called each time a lookup finds no holder holding the lock, before a start replaces it, so the sessions it held end (PRD R94). */
  gone?(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  connect?(options: ConnectOptions): Promise<HolderConnection>;
  /** Whether a process holds the holder's lock. */
  lockHeld?(): Promise<boolean>;
  /** Starts `<nodePath> <script> <args>` detached, with its output appended to the log file. */
  launch?(nodePath: string, args: string[], logPath: string): void;
  /** Ends a process and its descendants, as `taskkill /T /F` does; the error when it could not. */
  killTree?(pid: number): Promise<{ error: string } | null>;
}

/** The holder's environment: the hub's without VS Code's runtime and window variables. */
function holderEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(ELECTRON_|VSCODE_)/i.test(name) && name.toUpperCase() !== 'NODE_OPTIONS'));
}

function launchDetached(nodePath: string, args: string[], logPath: string): void {
  rotateLog(logPath);

  const log = openSync(logPath, 'a');

  try {
    const child = spawn(nodePath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: holderEnvironment(process.env) });

    child.on('error', () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}

/**
 * The hub's link to the terminal holder of its home (architecture.md § Terminal holder): one connection, kept while it lasts. `find(true)` starts
 * a holder when none runs, and replaces one of another protocol once it holds no live session.
 */
export class HolderLink {
  #client: { holder: HolderConnection } | null = null;
  /** The record of the holder `#client` is connected to. */
  #answered: HolderRecord | null = null;
  #connecting: Promise<HolderFound> | null = null;
  #starting: Promise<HolderFound> | null = null;

  constructor(private readonly deps: HolderLinkDeps) {}

  get logPath(): string {
    return join(this.deps.home, LOG_FILE);
  }

  find(start: boolean): Promise<HolderFound> {
    if (!start) {
      return this.#find(false);
    }

    this.#starting ??= this.#find(true).finally(() => {
      this.#starting = null;
    });

    return this.#starting;
  }

  /** The port and token of the holder this link is connected to, which an attach client uses; null while none answered. */
  record(): { port: number; token: string } | null {
    return this.#client === null || this.#answered === null ? null : { port: this.#answered.port, token: this.#answered.token };
  }

  /** The holder this link is connected to, without a lookup; null while none answered. */
  connected(): HolderConnection | null {
    return this.#client?.holder ?? null;
  }

  /** The holder build installed in the home, which the next start runs; null when none is. */
  installed(): string | null {
    return currentHolderBuild(this.deps.home);
  }

  /**
   * Ends the holder, once it holds no live session, and starts the installed build (architecture.md § Restarting the holder). A start waits for it,
   * so no session is spawned in the old holder meanwhile. A holder that does not exit within 10 seconds of `shutdown` has its process tree ended.
   */
  restart(): Promise<HolderRestart> {
    const before = this.#starting ?? Promise.resolve(null);
    const ending = before.catch(() => null).then(() => this.#end());
    const starting: Promise<HolderFound> = ending.then((ended) => (ended === null ? this.#find(true) : this.#find(false)));
    const held = starting.finally(() => {
      if (this.#starting === held) {
        this.#starting = null;
      }
    });

    this.#starting = held;

    return ending.then(async (ended) => {
      if (ended !== null) {
        return ended;
      }

      const found = await held;

      return 'holder' in found ? found : { error: 'error' in found ? found.error : 'The terminal holder did not start.' };
    });
  }

  /** Ends the holder when it holds no live session: null once no holder holds the lock. */
  async #end(): Promise<{ live: string[] } | { error: string } | null> {
    const found = await this.#connected();

    if ('gone' in found) {
      return null;
    }

    if ('error' in found) {
      return found;
    }

    const old = found.holder;
    let live: string[];

    try {
      live = (await old.list()).filter((entry) => entry.exitedAt === null).map((entry) => entry.session);
    } catch (error) {
      return { error: (error as Error).message };
    }

    if (live.length > 0) {
      return { live };
    }

    let timer: NodeJS.Timeout | undefined;
    let refused = false;

    // A holder that does not answer is ended below.
    await Promise.race([old.shutdown(), new Promise<void>((done) => (timer = setTimeout(done, SHUTDOWN_ANSWER_MS)))])
      .catch(() => (refused = true))
      .finally(() => clearTimeout(timer));

    // It refuses while it holds a live session, as one whose spawn began before the list; that session goes back to the caller, never ended here.
    if (refused) {
      const started = await old.list().then(
        (entries) => entries.filter((entry) => entry.exitedAt === null).map((entry) => entry.session),
        () => [],
      );

      if (started.length > 0) {
        return { live: started };
      }
    }

    this.close();

    if (await this.#exited()) {
      this.deps.log(`terminal holder ${old.welcome.build} ended to start the installed build`);
      return null;
    }

    const failed = await (this.deps.killTree ?? killTree)(old.welcome.pid);

    if (failed !== null) {
      return { error: `The terminal holder (pid ${old.welcome.pid}) did not exit and could not be ended: ${failed.error}` };
    }

    if (!(await this.#exited())) {
      return { error: `The terminal holder (pid ${old.welcome.pid}) did not exit within ${HOLDER_START_MS / 1000} seconds of its process tree being ended.` };
    }

    this.deps.log(`terminal holder ${old.welcome.build} did not exit, so its process tree was ended to start the installed build`, 'warn');
    return null;
  }

  /** Whether the holder's lock is free within 10 seconds. */
  async #exited(): Promise<boolean> {
    for (const until = this.deps.now() + HOLDER_START_MS; await this.#lockHeld(); ) {
      if (this.deps.now() >= until) {
        return false;
      }

      await this.deps.sleep(POLL_MS);
    }

    return true;
  }

  /** Closes the connection; the holder and its sessions keep running. */
  close(): void {
    this.#client?.holder.close();
    this.#client = null;
  }

  async #find(start: boolean): Promise<HolderFound> {
    const found = await this.#connected();

    if ('error' in found) {
      return found;
    }

    if ('gone' in found) {
      return start ? this.#start() : found;
    }

    if (!start || found.holder.compatible) {
      return found;
    }

    return this.#replace(found.holder);
  }

  /** The cached connection, or a new one to the holder the record names; `gone` when no holder holds the lock. */
  /** `notify`: a free lock is reported through `gone`; a start waiting for its own holder sets it false, since the lock is free until it runs. */
  #connected(notify = true): Promise<HolderFound> {
    if (this.#client !== null) {
      return Promise.resolve(this.#client);
    }

    // Concurrent lookups share one connection.
    this.#connecting ??= this.#connect(notify).finally(() => {
      this.#connecting = null;
    });

    return this.#connecting;
  }

  async #connect(notify: boolean): Promise<HolderFound> {
    const record = this.#readRecord();

    if (record !== null) {
      try {
        const client = await (this.deps.connect ?? HolderClient.connect)({ port: record.port, token: record.token });

        // A record left by a holder that exited by force can name a port another process now uses.
        if (client.welcome.pid === record.pid) {
          const found = { holder: client };

          this.#client = found;
          this.#answered = record;
          client.onClose(() => {
            if (this.#client === found) {
              this.#client = null;
            }
          });

          return found;
        }

        client.close();
      } catch {
        // Not answering; the lock decides whether it is gone.
      }
    }

    if (await this.#lockHeld()) {
      return { error: 'The terminal holder holds its lock but does not answer.' };
    }

    if (notify) {
      this.deps.gone?.();
    }

    return { gone: true };
  }

  #readRecord(): HolderRecord | null {
    try {
      return parseHolderRecord(readFileSync(recordPath(this.deps.home), 'utf8'));
    } catch {
      return null;
    }
  }

  #lockHeld(): Promise<boolean> {
    return this.deps.lockHeld?.() ?? answers(holderLockAddress(this.deps.home));
  }

  /** A holder of another protocol keeps its live sessions; once it holds none it is asked to exit, and this build starts. */
  async #replace(old: HolderConnection): Promise<HolderFound> {
    let live: number;

    try {
      live = (await old.list()).filter((entry) => entry.exitedAt === null).length;
    } catch (error) {
      return { error: (error as Error).message };
    }

    if (live > 0) {
      return { error: `The terminal holder is from another version of Switchboard; it is replaced once its ${live} session${live === 1 ? '' : 's'} end.` };
    }

    try {
      await old.shutdown();
    } catch (error) {
      return { error: `The terminal holder of protocol ${old.welcome.protocol} did not exit: ${(error as Error).message}` };
    }

    this.close();

    for (const until = this.deps.now() + HOLDER_START_MS; await this.#lockHeld(); ) {
      if (this.deps.now() >= until) {
        return { error: `The terminal holder of protocol ${old.welcome.protocol} did not exit within ${HOLDER_START_MS / 1000} seconds.` };
      }

      await this.deps.sleep(POLL_MS);
    }

    this.deps.log(`terminal holder of protocol ${old.welcome.protocol} replaced by protocol ${PROTOCOL}`);

    return this.#start();
  }

  async #start(): Promise<HolderFound> {
    const build = currentHolderBuild(this.deps.home);

    if (build === null || !(await reserveHolderBuild(this.deps.home, build))) {
      return { error: `The terminal holder is not installed in ${join(this.deps.home, 'holder')}; run hub.js install (npm run install-local) to install it.` };
    }

    try {
      (this.deps.launch ?? launchDetached)(this.deps.nodePath(), [join(this.deps.home, 'holder', build, 'holder.js'), `--home=${this.deps.home}`, `--build=${build}`], this.logPath);
    } catch (error) {
      return { error: `The terminal holder could not start: ${(error as Error).message} Log: ${this.logPath}` };
    }

    this.deps.log(`started the terminal holder ${build}`);

    for (const until = this.deps.now() + HOLDER_START_MS; this.deps.now() < until; ) {
      await this.deps.sleep(POLL_MS);

      const found = await this.#connected(false);

      if ('holder' in found) {
        return found;
      }
    }

    return { error: `The terminal holder did not start within ${HOLDER_START_MS / 1000} seconds. Log: ${this.logPath}` };
  }
}
