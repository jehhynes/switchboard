/** A terminal as far as `TerminalKeys` reads it: `vscode.Terminal` in the extension, a stand-in in tests. */
export interface KeyedTerminal {
  readonly processId: Thenable<number | undefined>;
  readonly exitStatus: unknown;
}

/** Workspace state, as `vscode.Memento` gives it. */
export interface KeyState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** The workspace state entry holding each key's terminal process ID. */
export const TERMINAL_PIDS = 'switchboard.terminalPids';

/** How long a lookup waits for a listed terminal's process ID; a terminal whose process never starts has none. */
const PID_WAIT_MS = 1_000;

function pidOf(terminal: KeyedTerminal): Promise<number | undefined> {
  return Promise.resolve(terminal.processId).then(
    (pid) => pid,
    () => undefined,
  );
}

/** The terminal's process ID, undefined when it has none, or null when it has not come within `PID_WAIT_MS`. */
function pidWithin(terminal: KeyedTerminal): Promise<number | undefined | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), PID_WAIT_MS);

    void pidOf(terminal).then((pid) => {
      clearTimeout(timer);
      resolve(pid);
    });
  });
}

/**
 * The terminals Open in terminal opened, by key (PRD R28). The map is lost when the extension host restarts, as on a window reload or an
 * extension update, while VS Code keeps the terminal and its process (mechanics M89). Each key's process ID is therefore kept in workspace state,
 * and a key with no terminal in the map takes the listed terminal running that process. A terminal VS Code revived after it quit runs a new
 * process and is not taken.
 */
export class TerminalKeys<T extends KeyedTerminal> {
  private readonly held = new Map<string, T>();
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly listed: () => readonly T[],
    private state: KeyState | null = null,
  ) {}

  setState(state: KeyState | null): void {
    this.state = state;
  }

  /** Runs `step` after the earlier steps for `key`, so two quick clicks open one terminal. */
  serial<R>(key: string, step: () => Promise<R>): Promise<R> {
    const run = (this.queue.get(key) ?? Promise.resolve()).then(step);
    const settled = run.then(
      () => {},
      () => {},
    );

    this.queue.set(key, settled);
    void settled.then(() => {
      if (this.queue.get(key) === settled) {
        this.queue.delete(key);
      }
    });

    return run;
  }

  /** The running terminal kept under `key`, taking a listed terminal that runs the key's kept process; undefined when there is none. */
  async find(key: string): Promise<T | undefined> {
    const held = this.held.get(key);

    if (held !== undefined) {
      if (this.runs(held)) {
        return held;
      }

      // Its process has ended, so another terminal may now have its process ID.
      this.held.delete(key);
      const rest = this.pids();

      delete rest[key];
      await this.write(rest);
      return undefined;
    }

    const kept = this.pids();

    if (kept[key] === undefined) {
      return undefined;
    }

    const taken = new Set(this.held.values());
    const live = this.listed().filter((terminal) => terminal.exitStatus === undefined);
    const pids = await Promise.all(live.map(pidWithin));
    // A terminal can close while the process IDs are awaited.
    const index = live.findIndex((terminal, i) => !taken.has(terminal) && pids[i] === kept[key] && this.runs(terminal));
    // Entries whose process no listed terminal runs are dropped, so the state does not grow; none while a process ID has not come.
    const complete = !pids.includes(null);
    const running = new Set(pids);
    const stale = (name: string, pid: number) => complete && kept[name] === pid && (!running.has(pid) || (index < 0 && name === key));
    // Read again, keeping what `keep` wrote while the process IDs were awaited.
    const pruned = Object.fromEntries(Object.entries(this.pids()).filter(([name, pid]) => !stale(name, pid)));

    await this.write(pruned);

    // The terminal can also close while the state is written.
    if (index < 0 || !this.runs(live[index]!)) {
      return undefined;
    }

    this.held.set(key, live[index]!);
    return live[index];
  }

  /** Keeps `terminal` under `key`, and its process ID in workspace state once VS Code reports it. */
  async keep(key: string, terminal: T): Promise<void> {
    this.held.set(key, terminal);

    const pid = await pidOf(terminal);

    if (pid !== undefined && this.held.get(key) === terminal) {
      await this.write({ ...this.pids(), [key]: pid });
    }
  }

  private runs(terminal: T): boolean {
    return terminal.exitStatus === undefined && this.listed().includes(terminal);
  }

  private pids(): Record<string, number> {
    const value = this.state?.get<unknown>(TERMINAL_PIDS);

    if (typeof value !== 'object' || value === null) {
      return {};
    }

    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => Number.isInteger(entry[1])));
  }

  private async write(pids: Record<string, number>): Promise<void> {
    await this.state?.update(TERMINAL_PIDS, Object.keys(pids).length > 0 ? pids : undefined);
  }
}
