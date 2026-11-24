import type { AlertSurface } from '@switchboard/core';

/**
 * The open web pages that raise needs-you alerts (PRD R65): whether each runs as the installed app and may show notifications, and when it
 * last opened or gained focus, so one page, the one used last, acts for the hub.
 */
export class PageTargets {
  readonly #pages = new Map<string, { installed: boolean; at: number; notifies: boolean }>();
  #clock = 0;

  opened(key: string, installed: boolean): void {
    this.#pages.set(key, { installed, at: ++this.#clock, notifies: false });
  }

  focused(key: string): void {
    const page = this.#pages.get(key);

    if (page !== undefined) {
      page.at = ++this.#clock;
    }
  }

  /** Whether the browser lets the page show notifications, as the page reports it; a page that cannot is never chosen to alert. */
  notifies(key: string, notifies: boolean): void {
    const page = this.#pages.get(key);

    if (page !== undefined) {
      page.notifies = notifies;
    }
  }

  closed(key: string): void {
    this.#pages.delete(key);
  }

  /**
   * The page that raises needs-you alerts for `alerts.surface`, among the pages that may show notifications: `auto` the installed page used
   * last, as for `dock`, which no longer has a surface of its own; `web` that, else any page used last; `system` none. Null leaves the alert to a
   * system notification.
   */
  alerting(surface: AlertSurface): string | null {
    return surface === 'system' ? null : (this.#latest((page) => page.notifies && page.installed) ?? (surface === 'web' ? this.#latest((page) => page.notifies) : null));
  }

  #latest(test: (page: { installed: boolean; at: number; notifies: boolean }) => boolean): string | null {
    let found: [string, number] | null = null;

    for (const [key, page] of this.#pages) {
      if (test(page) && (found === null || page.at > found[1])) {
        found = [key, page.at];
      }
    }

    return found?.[0] ?? null;
  }
}
