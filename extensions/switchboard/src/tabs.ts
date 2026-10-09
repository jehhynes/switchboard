import type { Snapshot } from '@switchboard/hub';
import { windowTabs } from '@switchboard/hub';

/**
 * Opens an item window's ticket, its links and its approval report in editor tabs (PRD R72): all of them when the dock opened the window, and
 * afterwards each one a snapshot adds. A tab the operator closes stays closed until the dock opens the window again.
 */
export class ItemTabs {
  /** Every URL the window has seen, so a URL that leaves the snapshot, as with a Done item that ages out, does not open again when it returns. */
  private readonly urls = new Set<string>();
  /** The reports in the last snapshot, so a report opens again each time its work item starts awaiting approval. */
  private reports = new Set<string>();
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

    const { urls, reports } = windowTabs(snapshot, this.file, this.windows);
    const added = [...urls.filter((url) => !this.urls.has(url)), ...reports.filter((report) => !this.reports.has(report))];
    const started = this.started;

    urls.forEach((url) => this.urls.add(url));
    this.reports = new Set(reports);
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

    const { urls, reports } = windowTabs(snapshot, this.file, this.windows);

    urls.forEach((url) => this.urls.add(url));
    reports.forEach((report) => this.reports.add(report));
    this.started = true;
    await this.openEach([...urls, ...reports]);
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
