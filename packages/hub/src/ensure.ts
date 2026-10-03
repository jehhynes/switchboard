import type { HubRecord } from '@switchboard/core';

export interface EnsureDeps {
  find(): Promise<HubRecord | null>;
  /** The build to accept, read on every attempt so all windows follow the currently installed bundle. */
  build(): string;
  /** Ask a hub to stop. True when it agreed. */
  stop(record: HubRecord): Promise<boolean>;
  /** Starts a hub and returns; the caller waits for `find` to see it. */
  start(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  logPath: string;
}

export type Ensured = { record: HubRecord } | { failed: string };

/** Ground Control measured hub startup at 85–96 ms (GC M25); five seconds allows for slow machines. */
export const START_TIMEOUT_MS = 5000;
export const STOP_TIMEOUT_MS = 5000;
export const POLL_MS = 100;

/**
 * Find a running hub of the installed build, or start one. A hub of another build is asked to stop first, and
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
    const found = await deps.find();

    if (found?.build === build) {
      return { record: found };
    }

    if (found !== null) {
      if (!(await deps.stop(found))) {
        return { failed: `The running hub (pid ${found.pid}) is from another build and refused to stop.` };
      }

      const gone = await poll(STOP_TIMEOUT_MS, async () => ((await deps.find())?.token === found.token ? null : true));

      if (gone === null) {
        return { failed: `The running hub (pid ${found.pid}) agreed to stop but is still running.` };
      }
    }

    try {
      deps.start();
    } catch (error) {
      return { failed: `Could not start the hub: ${String(error)}` };
    }

    const live = await poll(START_TIMEOUT_MS, async () => {
      const candidate = await deps.find();

      return candidate?.build === build ? candidate : null;
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
