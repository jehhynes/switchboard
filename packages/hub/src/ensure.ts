import type { HubRecord } from '@switchboard/core';

export interface EnsureDeps {
  find(): Promise<HubRecord | null>;
  /** The build to accept, read on every attempt so all windows follow the currently installed bundle. */
  build(): string;
  /** The config folder the hub must read, read on every attempt so all windows follow the current setting. */
  configDir(): string;
  /** Ask a hub to stop. True when it agreed. */
  stop(record: HubRecord): Promise<boolean>;
  /** Starts a hub and returns; the caller waits for `find` to see it. */
  start(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  logPath: string;
  /** Whether a restarting hub is handing over to its successor (`pendingHandover`), which is then waited for rather than a hub started. */
  handover?(): boolean;
}

export type Ensured = { record: HubRecord } | { failed: string };

/** As long as a successor may take to take over the lock (`TAKEOVER_WAIT_MS`). */
export const HANDOVER_WAIT_MS = 30_000;
/** Ground Control measured hub startup at 85–96 ms (GC M25); five seconds allows for slow machines. */
export const START_TIMEOUT_MS = 5000;
export const STOP_TIMEOUT_MS = 5000;
export const POLL_MS = 100;

/**
 * Find a running hub of the installed build and config folder, or start one. Any other hub is asked to stop first, and
 * nothing starts until it has gone. Concurrent calls share one attempt.
 */
export function makeEnsure(deps: EnsureDeps): () => Promise<Ensured> {
  let inFlight: Promise<Ensured> | undefined;

  async function poll<T>(timeoutMs: number, check: () => Promise<T | null>): Promise<T | null> {
    for (const until = deps.now() + timeoutMs; deps.now() < until; ) {
      await deps.sleep(POLL_MS);

      const result = await check();

      if (result !== null) {
        return result;
      }
    }

    return null;
  }

  async function attempt(): Promise<Ensured> {
    const build = deps.build();
    const configDir = deps.configDir();
    const wanted = (record: HubRecord) => record.build === build && record.configDir === configDir;
    const found = await deps.find();

    if (found !== null && wanted(found)) {
      return { record: found };
    }

    if (found !== null) {
      if (!(await deps.stop(found))) {
        return { failed: `The running hub (pid ${found.pid}) is from another build or config folder and refused to stop.` };
      }

      const gone = await poll(STOP_TIMEOUT_MS, async () => ((await deps.find())?.token === found.token ? null : true));

      if (gone === null) {
        return { failed: `The running hub (pid ${found.pid}) agreed to stop but is still running.` };
      }
    }

    // A restarting hub's successor takes the lock and writes its record within seconds; a hub started now could take the lock first.
    if (found === null && deps.handover?.() === true) {
      const successor = await poll(HANDOVER_WAIT_MS, async () => {
        const candidate = await deps.find();

        return candidate !== null && wanted(candidate) ? candidate : deps.handover?.() === true ? null : false;
      });

      if (successor !== null && successor !== false) {
        return { record: successor };
      }
    }

    try {
      deps.start();
    } catch (error) {
      return { failed: `Could not start the hub: ${String(error)}` };
    }

    const live = await poll(START_TIMEOUT_MS, async () => {
      const candidate = await deps.find();

      return candidate !== null && wanted(candidate) ? candidate : null;
    });

    return live === null ? { failed: `The hub did not start within ${START_TIMEOUT_MS / 1000} seconds. Log: ${deps.logPath}` } : { record: live };
  }

  return () => {
    inFlight ??= attempt().finally(() => {
      inFlight = undefined;
    });

    return inFlight;
  };
}
