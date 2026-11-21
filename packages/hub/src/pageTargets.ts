/**
 * The open web pages the dock opens a work item in (PRD R71): whether each runs as the installed app, and when it last opened or gained focus,
 * so one page, the one used last, acts for the hub.
 */
export class PageTargets {
  readonly #pages = new Map<string, { installed: boolean; at: number }>();
  #clock = 0;

  opened(key: string, installed: boolean): void {
    this.#pages.set(key, { installed, at: ++this.#clock });
  }

  focused(key: string): void {
    const page = this.#pages.get(key);

    if (page !== undefined) {
      page.at = ++this.#clock;
    }
  }

  closed(key: string): void {
    this.#pages.delete(key);
  }

  /** The installed page used last, which a dock click with `dock.openIn: web` shows the work item in; null with none open. */
  installed(): string | null {
    return this.#latest((page) => page.installed);
  }


  #latest(test: (page: { installed: boolean; at: number }) => boolean): string | null {
    let found: [string, number] | null = null;

    for (const [key, page] of this.#pages) {
      if (test(page) && (found === null || page.at > found[1])) {
        found = [key, page.at];
      }
    }

    return found?.[0] ?? null;
  }
}
