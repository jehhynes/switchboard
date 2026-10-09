import type { Snapshot } from '@switchboard/hub';

/** The latest panel snapshot from this window's `/events` stream, and waits for one that passes a test. */
export class HubState {
  private latest: Snapshot | null = null;
  private waiters: (() => void)[] = [];

  /** Takes a `state` event's JSON text. */
  update(text: string): void {
    this.latest = JSON.parse(text) as Snapshot;
    this.waiters.slice().forEach((check) => check());
  }

  current(): Snapshot | null {
    return this.latest;
  }

  /** The latest snapshot, waiting up to `ms` for the first one; null when none arrives. */
  first(ms: number): Promise<Snapshot | null> {
    return this.until(() => true, ms);
  }

  /** The latest snapshot once `wanted` holds for it, waiting up to `ms` for one where it does; null when none arrives. */
  until(wanted: (snapshot: Snapshot) => boolean, ms: number): Promise<Snapshot | null> {
    return new Promise((resolve) => {
      const check = (): boolean => {
        if (this.latest === null || !wanted(this.latest)) {
          return false;
        }

        finish(this.latest);
        return true;
      };
      const finish = (snapshot: Snapshot | null) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((waiter) => waiter !== check);
        resolve(snapshot);
      };
      const timer = setTimeout(() => finish(null), ms);

      if (!check()) {
        this.waiters.push(check);
      }
    });
  }
}
