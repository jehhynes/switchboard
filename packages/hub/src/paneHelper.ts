import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** A report the pane helper writes (architecture.md § Pane helper): `ready` once, then the gluing's state for a marker. */
export interface PaneHelperReport {
  state: 'ready' | 'found' | 'shown' | 'hidden' | 'lost' | 'failed';
  marker: string | null;
  focused?: boolean;
  reason?: string;
}

const STATES = ['ready', 'found', 'shown', 'hidden', 'lost', 'failed'];

/** One line from the helper's stdout as a report, or null for anything else. */
export function paneHelperReport(line: string): PaneHelperReport | null {
  let body: unknown;

  try {
    body = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }

  const { state, marker = null, focused, reason } = body as Record<string, unknown>;

  if (
    !STATES.includes(String(state)) ||
    !(marker === null || typeof marker === 'string') ||
    !(focused === undefined || typeof focused === 'boolean') ||
    !(reason === undefined || (typeof reason === 'string' && reason.length <= 500))
  ) {
    return null;
  }

  return { state: state as PaneHelperReport['state'], marker, ...(focused === undefined ? {} : { focused }), ...(reason === undefined ? {} : { reason }) };
}

/** The running helper process as the supervisor uses it. */
export interface PaneHelperProcess {
  readonly pid: number | undefined;
  /** Writes one line to its stdin; false when it no longer takes one. */
  write(line: string): boolean;
  /** Closes its stdin, on which the helper lets the pane go and exits. */
  end(): void;
  kill(): void;
  onLine(listener: (line: string) => void): void;
  onError(listener: (line: string) => void): void;
  /** Once, when it exited or could not start, with why when it could not start. */
  onExit(listener: (code: number | null, error: string | null) => void): void;
}

/** Starts `file` with stdin, stdout and stderr piped and no window. */
export function spawnPaneHelper(file: string, args: readonly string[], env: NodeJS.ProcessEnv): PaneHelperProcess {
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  const exitListeners: Array<(code: number | null, error: string | null) => void> = [];
  let exited = false;
  const exit = (code: number | null, error: string | null): void => {
    if (!exited) {
      exited = true;
      exitListeners.forEach((listener) => listener(code, error));
    }
  };

  child.on('error', (error) => exit(null, error.message));
  child.on('exit', (code) => exit(code, null));
  // A write to a helper that has gone fails here rather than throwing.
  child.stdin.on('error', () => undefined);

  return {
    pid: child.pid,
    write: (line) => {
      if (!child.stdin.writable) {
        return false;
      }

      child.stdin.write(`${line}\n`);
      return true;
    },
    end: () => child.stdin.end(),
    kill: () => void child.kill(),
    onLine: (listener) => void createInterface({ input: child.stdout }).on('line', listener),
    onError: (listener) => void createInterface({ input: child.stderr }).on('line', listener),
    onExit: (listener) => void exitListeners.push(listener),
  };
}

export interface PaneHelperDeps {
  /** Starts the installed helper, or says why it cannot. */
  start(): Promise<{ process: PaneHelperProcess } | { error: string }>;
  report(report: PaneHelperReport): void;
  /** The helper is no longer running; `error` when it will not be started again until it is no longer wanted. */
  stopped(error: string | null): void;
  log(line: string): void;
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

/** A helper that exits sooner than this after its start counts as crashing. */
export const PANE_HELPER_STABLE_MS = 60_000;
/** The wait before restarting a crashed helper, doubled after each crash in a row, up to {@link PANE_HELPER_MAX_WAIT_MS}. */
export const PANE_HELPER_WAIT_MS = 1_000;
export const PANE_HELPER_MAX_WAIT_MS = 30_000;
/** Crashes in a row after which the helper is not started again until it is no longer wanted. */
export const PANE_HELPER_MAX_CRASHES = 5;
/** How long a helper asked to stop has to let the pane go before it is killed. */
export const PANE_HELPER_STOP_MS = 3_000;

/**
 * Runs the Chrome pane helper while it is wanted (architecture.md § Pane helper): starts it, passes on its reports, restarts it with a growing
 * wait when it exits on its own, gives up after {@link PANE_HELPER_MAX_CRASHES} quick crashes in a row, and stops it when it is no longer wanted.
 */
export class PaneHelper {
  #wanted = false;
  #process: PaneHelperProcess | null = null;
  #starting = false;
  #ready = false;
  /** The running helper was asked to stop, so its exit is no crash. */
  #stopping = false;
  #startedAt = 0;
  #crashes = 0;
  #gaveUp = false;
  #restart: unknown = null;
  #kill: unknown = null;
  /** The hub is closing: nothing starts again, whatever a page still wants. */
  #closed = false;

  constructor(private readonly deps: PaneHelperDeps) {}

  /** Whether a helper is running and said it is ready. */
  get ready(): boolean {
    return this.#ready;
  }

  /** Starts the helper when it is wanted and none runs, or stops it when it is no longer wanted. */
  want(on: boolean): void {
    if (this.#closed || on === this.#wanted) {
      return;
    }

    this.#wanted = on;

    if (on) {
      this.#start();
      return;
    }

    this.#cancelRestart();
    this.#gaveUp = false;
    this.#crashes = 0;
    this.#stop();
  }

  /** Sends the helper the hub's `pane` order; false when no ready helper takes it. */
  send(order: { marker: string | null; rect: unknown }): boolean {
    return this.#ready && this.#process !== null && this.#process.write(JSON.stringify({ type: 'pane', marker: order.marker, rect: order.rect }));
  }

  /** Stops the helper for good, as when the hub closes. */
  close(): void {
    this.want(false);
    this.#closed = true;
  }

  #start(): void {
    if (this.#closed || !this.#wanted || this.#gaveUp || this.#process !== null || this.#starting || this.#restart !== null) {
      return;
    }

    this.#starting = true;
    void this.deps.start().then(
      (started) => this.#started(started),
      (error: unknown) => this.#started({ error: `The Chrome pane helper could not start: ${(error as Error).message}` }),
    );
  }

  #started(started: { process: PaneHelperProcess } | { error: string }): void {
    this.#starting = false;

    if ('error' in started) {
      this.deps.log(`pane helper: ${started.error}`);
      this.#gaveUp = this.#wanted;
      this.deps.stopped(this.#wanted ? started.error : null);
      return;
    }

    const child = started.process;

    this.#process = child;
    this.#startedAt = this.deps.now();
    this.deps.log(`pane helper started (pid ${child.pid ?? '?'})`);
    child.onLine((line) => {
      if (this.#process !== child) {
        return;
      }

      const report = paneHelperReport(line);

      if (report === null) {
        this.deps.log(`pane helper: ignored a line: ${line.slice(0, 200)}`);
        return;
      }

      this.#ready ||= report.state === 'ready';
      this.deps.report(report);
    });
    child.onError((line) => this.deps.log(`pane helper: ${line.slice(0, 500)}`));
    child.onExit((code, error) => this.#exited(child, code, error));

    // Not wanted any more while it started.
    if (!this.#wanted) {
      this.#stop();
    }
  }

  #exited(child: PaneHelperProcess, code: number | null, error: string | null): void {
    if (this.#process !== child) {
      return;
    }

    this.#process = null;
    this.#ready = false;

    if (this.#kill !== null) {
      this.deps.clearTimeout(this.#kill);
      this.#kill = null;
    }

    if (this.#stopping || !this.#wanted) {
      this.#stopping = false;
      this.deps.log(`pane helper stopped (exit ${code ?? 'none'})`);
      this.deps.stopped(null);
      // Wanted again while it stopped.
      this.#start();
      return;
    }

    this.#crashes = this.deps.now() - this.#startedAt < PANE_HELPER_STABLE_MS ? this.#crashes + 1 : 1;
    this.deps.log(`pane helper exited on its own (${error ?? `exit ${code ?? 'none'}`}), ${this.#crashes} in a row`);

    if (this.#crashes >= PANE_HELPER_MAX_CRASHES) {
      this.#gaveUp = true;
      this.deps.stopped('The Chrome pane helper keeps stopping; the hub log and chrome-pane.log in the Switchboard folder say why. Reload the page to try again.');
      return;
    }

    this.deps.stopped(null);
    this.#restart = this.deps.setTimeout(() => {
      this.#restart = null;
      this.#start();
    }, Math.min(PANE_HELPER_WAIT_MS * 2 ** (this.#crashes - 1), PANE_HELPER_MAX_WAIT_MS));
  }

  #stop(): void {
    const child = this.#process;

    if (child === null || this.#kill !== null) {
      return;
    }

    this.#ready = false;
    this.#stopping = true;
    child.end();
    this.#kill = this.deps.setTimeout(() => {
      this.#kill = null;
      child.kill();
    }, PANE_HELPER_STOP_MS);
  }

  #cancelRestart(): void {
    if (this.#restart !== null) {
      this.deps.clearTimeout(this.#restart);
      this.#restart = null;
    }
  }
}
