import type { HubRecord } from '@switchboard/core';
import type { EventStream } from './client.js';
import type { Ensured } from './ensure.js';

export interface KeeperDeps {
  ensure(): Promise<Ensured>;
  open(record: HubRecord, onEnd: () => void): Promise<EventStream | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
  onFailed(message: string): void;
}

export interface Keeper {
  /** The hub this client is connected to, or null. */
  current(): HubRecord | null;
  /** The current stream will end on purpose, such as a hub stopped for a new config folder, so its end is not a failure. */
  expectEnd(): void;
  /** Resolves when the loop stops: after `dispose()` or after giving up. */
  done: Promise<void>;
  dispose(): void;
}

export const RETRY_MS = 1000;
export const MAX_FAILURES = 3;
/** A connection that ends sooner than this counts as a failure, so a hub that keeps crashing is not restarted forever. */
export const STABLE_MS = 10_000;

/** Keep one event stream open to a running hub, starting or restarting the hub when the stream ends. */
export function keepHub(deps: KeeperDeps): Keeper {
  let disposed = false;
  let current: HubRecord | null = null;
  let stream: EventStream | null = null;
  let wake: (() => void) | null = null;
  let expected = false;

  async function run(): Promise<void> {
    let failures = 0;
    let reason = '';

    while (!disposed) {
      const ensured = await deps.ensure();

      if (disposed) {
        return;
      }

      if ('failed' in ensured) {
        failures++;
        reason = ensured.failed;
      } else {
        const ended = new Promise<void>((resolve) => {
          wake = resolve;
        });
        const opened = await deps.open(ensured.record, () => wake?.());

        if (disposed) {
          opened?.close();

          return;
        }

        if (opened === null) {
          failures++;
          reason = `The hub on port ${ensured.record.port} refused the connection.`;
        } else {
          const connectedAt = deps.now();

          expected = false;

          current = ensured.record;
          stream = opened;
          await ended;
          current = null;
          stream = null;

          if (disposed) {
            return;
          }

          failures = !expected && deps.now() - connectedAt < STABLE_MS ? failures + 1 : 0;
          reason = 'The hub kept stopping shortly after starting.';
        }
      }

      if (failures >= MAX_FAILURES) {
        deps.onFailed(reason);

        return;
      }

      await deps.sleep(RETRY_MS);
    }
  }

  const done = run();

  return {
    current: () => current,
    expectEnd: () => {
      expected = true;
    },
    done,
    dispose: () => {
      disposed = true;
      stream?.close();
      wake?.();
    },
  };
}
