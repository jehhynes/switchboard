import type { Snapshot } from '@switchboard/hub';
import { windowTabs } from '@switchboard/hub';

/**
 * The `reuseUrlFilter` that finds a browser tab already showing `url`; VS Code matches its host and path as globs (mechanics M27). Zoho Desk
 * redirects a ticket's `/support/<portal>/ShowHomePage.do#Cases/dv/<id>` link to `/agent/<portal>/<department>/tickets/details/<id>`.
 */
export function reuseFilter(url: string): string {
  const zoho = /^(https?:\/\/[^/]+)\/support\/[^/]+\/ShowHomePage\.do#Cases\/dv\/(\d+)$/.exec(url);

  return zoho === null ? url : `${zoho[1]}/agent/*/*/tickets/details/${zoho[2]}`;
}

/**
 * Opens each of an item window's work items' focus and approval report in editor tabs (PRD R72, R79): all of them when the dock opened the window,
 * and afterwards a focus a later triage changes and a report the window has not seen. A tab the operator closes stays closed until the dock opens the window again.
 */
export class ItemTabs {
  /** Each work item's focus when last seen, so only a changed focus opens, and a work item that leaves the snapshot and returns opens nothing. */
  private readonly focuses = new Map<number, string>();
  /** Every report this window has seen, so each opens at most once, however often its work item returns to awaiting approval. */
  private readonly reports = new Set<string>();
  /** False until the first snapshot, which opens nothing. */
  private started = false;

  /** `file` is this window's workspace file, null for a window that is not an item window; `open` opens a URL or file in a tab. */
  constructor(
    private readonly file: string | null,
    private readonly windows: string,
    private readonly open: (target: string) => Promise<void>,
  ) {}

  /** Opens what the snapshot adds to the window's tabs. */
  async update(snapshot: Snapshot): Promise<void> {
    if (this.file === null) {
      return;
    }

    const { focuses, reports } = windowTabs(snapshot, this.file, this.windows);
    const changed = focuses.filter((focus) => this.focuses.get(focus.workItemId) !== focus.url).map((focus) => focus.url);
    const added = [...new Set(changed), ...reports.filter((report) => !this.reports.has(report))];
    const started = this.started;

    focuses.forEach((focus) => this.focuses.set(focus.workItemId, focus.url));
    reports.forEach((report) => this.reports.add(report));
    this.started = true;

    if (started) {
      await this.openEach(added);
    }
  }

  /** Opens every tab, for the window the dock opened; with no snapshot, opens nothing. */
  async openAll(snapshot: Snapshot | null): Promise<void> {
    if (this.file === null || snapshot === null) {
      return;
    }

    const { focuses, reports } = windowTabs(snapshot, this.file, this.windows);

    focuses.forEach((focus) => this.focuses.set(focus.workItemId, focus.url));
    reports.forEach((report) => this.reports.add(report));
    this.started = true;
    await this.openEach([...new Set(focuses.map((focus) => focus.url)), ...reports]);
  }

  /** Opens each tab in turn, so they keep their order; one that fails does not stop the rest. */
  private async openEach(tabs: string[]): Promise<void> {
    const failed: unknown[] = [];

    for (const tab of tabs) {
      await this.open(tab).catch((error: unknown) => failed.push(error));
    }

    if (failed.length > 0) {
      throw failed[0];
    }
  }
}
