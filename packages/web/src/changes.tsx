// The Changes list and the diff tabs (PRD R118, architecture.md § Web page): the open conversation's worktree changes from its merge base to
// disk, as the VS Code window's Open changes shows them, in a menu from the Changes button at the end of the tab strips; each file opens in a
// closable tab of its own, drawn by the diff viewer the page loads on first use.
import type { ComponentChildren, VNode } from 'preact';
import { FileIcon } from './fileIcons.js';
import { mount, unmount } from './island.js';
import type { ChangeRow, ChangesList, ChangeStage, ChangeStatus, DiffData, FileData } from '@switchboard/protocol';
import type { DiffModule, DiffMount } from './diff/types.js';

export type { ChangeRow, ChangesList, ChangeStage, ChangeStatus } from '@switchboard/protocol';

/** What the page keeps of the Changes list: the list as last read, a read on its way or why one failed, and whether its menu is open. */
export interface ChangesView {
  list: ChangesList | null;
  loading: boolean;
  error: string | null;
  menu: boolean;
  /** The conversation the list was read for: the page key, scope generation and work item. */
  for: string | null;
  /** The files with a tab, in the order they opened, and the one the diff tab shows. */
  tabs: string[];
  open: string | null;
}

export const newChanges = (): ChangesView => ({ list: null, loading: false, error: null, menu: false, for: null, tabs: [], open: null });

/** Where the diff's sides go: side by side, one above the other, or by the pane's width (`auto`, stacked and wrapped under {@link SPLIT_MIN_WIDTH}). */
export type DiffLayout = 'auto' | 'split' | 'stacked';
/** The narrowest pane a diff shows side by side in, as VS Code's diff editor switches to inline at 900 px. */
export const SPLIT_MIN_WIDTH = 900;
const LAYOUT_KEY = 'switchboard.diffLayout';
const WRAP_KEY = 'switchboard.diffWrap';

/** The layout and wrapping a diff shows with in a pane `width` pixels wide. */
export function diffLayout(choice: DiffLayout, wrap: boolean | null, width: number): { layout: 'split' | 'stacked'; wrap: boolean } {
  const layout = choice === 'auto' ? (width > 0 && width < SPLIT_MIN_WIDTH ? 'stacked' : 'split') : choice;

  return { layout, wrap: wrap ?? (choice === 'auto' && layout === 'stacked') };
}

const STATUS_TITLES: Record<ChangeStatus, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', U: 'Untracked', C: 'Conflict' };
const STAGE_TITLES: Record<ChangeStage, string> = { committed: 'committed', staged: 'staged', working: 'unstaged', untracked: 'untracked' };

/** A row's tooltip: its path, the path it was renamed from, its status and the stages that changed it. */
export function rowTitle(row: ChangeRow): string {
  const stages = row.stages.map((stage) => STAGE_TITLES[stage]);
  const said = stages.length === 0 ? '' : ` · ${stages.join(', ')}`;

  return `${row.from === undefined ? row.path : `${row.from} → ${row.path}`}\n${STATUS_TITLES[row.status]}${said}`;
}

/** A file's name, the last part of its path. */
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * The diff tabs, one per file opened from the list, each with its status colour and a close button, as an artifact's tab is drawn; `shown` is
 * whether the strip shows the diff tab now, so the open file's tab is selected.
 */
export function diffTabs(changes: ChangesView, shown: boolean): ComponentChildren {
  return changes.tabs.map((path) => {
    const selected = shown && path === changes.open;
    const row = changes.list?.rows.find((one) => one.path === path);

    return (
      <span class={`tab diff-tab${path === changes.tabs[0] ? ' push' : ''}${selected ? ' selected' : ''}${row === undefined ? '' : ` status-${row.status}`}`} role="presentation">
        <button class="tab-open" type="button" role="tab" data-action="diff-tab" data-path={path} aria-selected={selected} tabindex={selected ? 0 : -1} title={row === undefined ? path : rowTitle(row)}>
          <FileIcon path={path} />
          <span class="tab-label">{baseName(path)}</span>
        </button>
        <button class="tab-close" type="button" data-action="diff-close" data-path={path} aria-label={`Close ${baseName(path)}`} title="Close" tabindex={selected ? 0 : -1}>
          <span class="codicon codicon-close" aria-hidden="true"></span>
        </button>
      </span>
    );
  });
}

/** The Changes button, after the strip's tabs, with the count once a list was read. */
export function changesButton(changes: ChangesView): VNode {
  const count = changes.list?.total;

  return (
    <button class={`tab changes-button${changes.tabs.length === 0 ? ' push' : ''}${changes.menu ? ' open' : ''}`} type="button" data-action="changes-menu" aria-expanded={changes.menu} title="The worktree's changes since its base">
      <span class="codicon codicon-diff-multiple" aria-hidden="true"></span>
      <span class="tab-label">Changes</span>
      {count === undefined ? null : <span class="tab-badge muted">{count}</span>}
      <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
    </button>
  );
}

function Counts({ row }: { row: ChangeRow }) {
  if (row.binary) {
    return <span class="change-counts">binary</span>;
  }

  return (
    <span class="change-counts">
      {row.additions === null ? null : <span class="added">+{row.additions}</span>}
      {row.deletions === null || row.deletions === 0 ? null : <span class="deleted">−{row.deletions}</span>}
    </span>
  );
}

/** One row: the file's name, its folder, the lines added and deleted, and its status letter, as VS Code's Source Control draws a change. */
/** A file's Viewed tick, as on a pull request: ticked at the content it had, cleared when that changes. */
function ViewedBox({ row }: { row: ChangeRow }): VNode {
  return (
    <label class="change-viewed" title={row.viewed === true ? 'Viewed; untick to read it again' : 'Mark viewed'}>
      <input type="checkbox" data-action="diff-viewed" data-path={row.path} checked={row.viewed === true} aria-label={`Viewed ${row.path}`} />
    </label>
  );
}

function Row({ row }: { row: ChangeRow }): VNode {
  const slash = row.path.lastIndexOf('/');
  const name = row.path.slice(slash + 1);
  const dir = slash === -1 ? '' : row.path.slice(0, slash);

  return (
    <li class={`change-item${row.viewed === true ? ' viewed' : ''}`}>
      <button class={`change-row status-${row.status}`} type="button" data-action="diff-open" data-path={row.path} title={rowTitle(row)}>
      <FileIcon path={row.path} />
      <span class={`change-name${row.status === 'D' ? ' deleted' : ''}`}>{name}</span>
      <span class="change-dir">{dir}</span>
      <Counts row={row} />
      <span class="change-status" aria-label={STATUS_TITLES[row.status]}>
        {row.status}
      </span>
      </button>
      <ViewedBox row={row} />
    </li>
  );
}

/** What the menu says above its rows: since which base, how many files, and a first cut when the worktree has more than the hub lists. */
export function listNote(list: ChangesList): string {
  const since = list.base === null ? 'Uncommitted changes only, no merge base' : `Since ${list.base.slice(0, 7)}`;
  const files = list.total === 1 ? '1 file' : `${list.total} files`;

  const viewed = list.rows.filter((row) => row.viewed === true).length;
  const ticked = viewed === 0 ? '' : ` · ${viewed} viewed`;

  return list.shown < list.total ? `${since} · first ${list.shown} of ${files}${ticked}` : `${since} · ${files}${ticked}`;
}

/** The Changes menu while open, under the strip: its note and Refresh, then the rows, or why there are none. */
export function renderChangesMenu(changes: ChangesView): VNode | null {
  if (!changes.menu) {
    return null;
  }

  const list = changes.list;
  let body: ComponentChildren;

  if (changes.error !== null) {
    body = <p class="changes-empty error">{changes.error}</p>;
  } else if (list === null) {
    body = <p class="changes-empty">Reading the changes…</p>;
  } else if (list.rows.length === 0) {
    body = <p class="changes-empty">{list.base === null ? 'No uncommitted changes, and no merge base was found.' : 'No changes since the merge base.'}</p>;
  } else {
    body = (
      <ul class="changes-rows" aria-label="Changes">
        {list.rows.map((row) => (
          <Row row={row} />
        ))}
      </ul>
    );
  }

  return (
    <div class="glass changes-menu">
      <div class="changes-head">
        <span class="changes-note">{list === null ? 'Changes' : listNote(list)}</span>
        <button class="icon" type="button" data-action="changes-refresh" title="Refresh" aria-label="Refresh" disabled={changes.loading}>
          <span class={`codicon codicon-refresh${changes.loading ? ' codicon-modifier-spin' : ''}`} aria-hidden="true"></span>
        </button>
      </div>
      {body}
    </div>
  );
}

export interface ChangesDeps {
  fetch: typeof fetch;
  /** The page key, null before the stream's hello. */
  key(): string | null;
  draw(): void;
  /** Shows the diff tab, in the side column on a wide screen and in the conversation's strip on a narrower one. */
  showDiff(): void;
  /** The last diff tab closed while it showed: the strip shows another tab. */
  closedDiff(): void;
  /** Loads the diff viewer's module on first use; null when it cannot load. */
  loadDiff(): Promise<DiffModule | null>;
  /** Empties a pane Preact drew into, before the diff tab draws into it itself. */
  takePane(pane: HTMLElement): void;
  /** The work item the page shows, which a `viewed` event must name. */
  workItemId(): number | null;
  /** Posts a command for the conversation the page shows, with its `scopeGen`. */
  command(name: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** A diff tab's file view: the file at a line, on disk or at the base, opened from a line number of its diff. */
interface FileOpen {
  path: string;
  side: 'disk' | 'base';
  line: number;
  entry: { state: 'loading' } | { state: 'ok'; data: FileData; version: string } | { state: 'error'; error: string };
}

/** What the file view says in place of the file: a read on its way, why it failed, a binary file or one too large. */
export function fileNote(entry: FileOpen['entry']): string | null {
  if (entry.state === 'loading') {
    return 'Reading the file…';
  }

  if (entry.state === 'error') {
    return entry.error;
  }

  return entry.data.binary ? 'Binary file not shown.' : entry.data.tooLarge ? 'This file is too large to show here. Open it in VS Code.' : null;
}

/** A file's diff as read: on its way, read, or why not. */
type DiffEntry = { state: 'loading' } | { state: 'ok'; data: DiffData; version: string } | { state: 'error'; error: string };

/** The diff tab's header: the path, a rename's old path, the counts, the layout and wrap controls and Refresh. */
function DiffHead({ path, row, choice, wrap, loading, file, note }: { path: string; row: ChangeRow | undefined; choice: DiffLayout; wrap: boolean; loading: boolean; file: FileOpen | null; note: string | null }): VNode {
  // Open in VS Code opens the file on disk, at the file view's line; a deleted file has none.
  const openable = file === null ? row?.status !== 'D' : file.side === 'disk';
  const open = openable ? (
    <button class="diff-open" type="button" data-action="diff-open-vscode" title="Open the file in its VS Code window">
      <span class="codicon codicon-go-to-file" aria-hidden="true"></span>
      Open in VS Code
    </button>
  ) : null;

  if (file !== null) {
    return (
      <div class="diff-head">
        <button class="icon" type="button" data-action="diff-back" title="Back to the diff" aria-label="Back to the diff">
          <span class="codicon codicon-arrow-left" aria-hidden="true"></span>
        </button>
        <span class="diff-title" title={file.path}>
          {file.path}:{file.line}
          {file.side === 'base' ? <span class="diff-from"> at the base</span> : null}
        </span>
        <span class="diff-tools">
          {note === null ? null : <span class="diff-note">{note}</span>}
          {open}
        </span>
      </div>
    );
  }

  return (
    <div class="diff-head">
      <span class={`diff-title${row === undefined ? '' : ` status-${row.status}`}`} title={row === undefined ? path : rowTitle(row)}>
        {row?.from === undefined ? null : <span class="diff-from">{row.from} → </span>}
        {path}
      </span>
      {row === undefined ? null : <Counts row={row} />}
      <span class="diff-tools">
        <span class="diff-layout" role="group" aria-label="Layout">
          {(['auto', 'split', 'stacked'] as const).map((one) => (
            <button type="button" data-action="diff-layout" data-layout={one} aria-pressed={choice === one} title={one === 'auto' ? `Side by side from ${SPLIT_MIN_WIDTH} px, else stacked and wrapped` : one === 'split' ? 'Side by side' : 'Stacked'}>
              {one === 'auto' ? 'Auto' : one === 'split' ? 'Split' : 'Stacked'}
            </button>
          ))}
        </span>
        <button class="diff-wrap" type="button" data-action="diff-wrap" aria-pressed={wrap} title="Wrap long lines">
          Wrap
        </button>
        {row === undefined ? null : (
          <label class="diff-viewed">
            <input type="checkbox" data-action="diff-viewed" data-path={path} checked={row.viewed === true} />
            Viewed
          </label>
        )}
        <button class="icon" type="button" data-action="diff-refresh" title="Refresh" aria-label="Refresh" disabled={loading}>
          <span class={`codicon codicon-refresh${loading ? ' codicon-modifier-spin' : ''}`} aria-hidden="true"></span>
        </button>
        {note === null ? null : <span class="diff-note">{note}</span>}
        {open}
      </span>
    </div>
  );
}

/** What the diff tab says in place of a diff: a binary file, one too large, a read on its way or why it failed. */
export function diffNote(entry: DiffEntry | undefined): string | null {
  if (entry === undefined || entry.state === 'loading') {
    return 'Reading the diff…';
  }

  if (entry.state === 'error') {
    return entry.error;
  }

  if (entry.data.binary) {
    return 'Binary file not shown.';
  }

  return entry.data.tooLarge === 'patch' || entry.data.patch === null ? 'This change is too large to show here. Open it in VS Code.' : null;
}

/** The page's side of the Changes list: reads it from the hub, and answers the clicks and presses that open, refresh and close its menu. */
export class ChangesController {
  readonly view: ChangesView = newChanges();
  #reading = 0;
  /** Each opened file's diff as read, by path, dropped with the list. */
  readonly #diffs = new Map<string, DiffEntry>();
  #diffReads = 0;
  /** The diff viewer on each host it draws into, dropped once its host leaves the page. */
  readonly #mounted = new Map<HTMLElement, { mount: DiffMount | null; layout: string }>();
  #module: Promise<DiffModule | null> | null = null;
  /** Each diff tab's file view while it shows one, by the tab's path, and what Open in VS Code last said. */
  readonly #files = new Map<string, FileOpen>();
  #note: { path: string; text: string } | null = null;
  #layout: DiffLayout = 'auto';
  #wrap: boolean | null = null;

  constructor(private readonly deps: ChangesDeps) {
    try {
      const layout = localStorage.getItem(LAYOUT_KEY);
      const wrap = localStorage.getItem(WRAP_KEY);

      this.#layout = layout === 'split' || layout === 'stacked' ? layout : 'auto';
      this.#wrap = wrap === null ? null : wrap === '1';
    } catch {
      // Without local storage the choices last until the page reloads.
    }
  }

  /**
   * Follows the page's conversation: `id` names it (page key, scope generation, work item), so another one drops the list and closes the menu;
   * `turnEnded` reads an open menu's list again when the session's turn ends.
   */
  follow(id: string | null, turnEnded: boolean): void {
    if (id !== this.view.for) {
      this.#reading++;
      this.#diffReads++;
      this.#diffs.clear();
      this.#files.clear();
      this.#note = null;
      Object.assign(this.view, newChanges(), { for: id });
      return;
    }

    if (turnEnded && this.view.menu) {
      void this.refresh();
    }

    if (turnEnded && this.view.open !== null) {
      void this.readDiff(this.view.open);
    }
  }

  /** Reads the list again; an answer for a conversation the page has left since is dropped. */
  async refresh(): Promise<void> {
    const key = this.deps.key();

    if (key === null) {
      return;
    }

    const reading = ++this.#reading;

    this.view.loading = true;
    this.deps.draw();

    let list: ChangesList | null = null;
    let error: string | null = null;

    try {
      const response = await this.deps.fetch(`/v1/conversation/changes?window=${encodeURIComponent(key)}`, { credentials: 'same-origin' });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (response.ok) {
        list = body as unknown as ChangesList;
      } else {
        error = String(body['error'] ?? `Switchboard answered ${response.status}.`);
      }
    } catch (failure) {
      error = `Switchboard did not answer: ${String(failure)}`;
    }

    if (reading !== this.#reading) {
      return;
    }

    this.view.loading = false;
    this.view.error = error;
    this.view.list = list ?? this.view.list;
    this.deps.draw();
  }

  /** Handles a click on the Changes button or in its menu; false for any other click. */
  click(target: HTMLElement): boolean {
    const action = target.closest<HTMLElement>('[data-action]')?.dataset['action'];

    if (action === 'changes-menu') {
      this.view.menu = !this.view.menu;

      if (this.view.menu) {
        void this.refresh();
      }

      this.deps.draw();
      return true;
    }

    if (action === 'changes-refresh') {
      void this.refresh();
      return true;
    }

    const path = target.closest<HTMLElement>('[data-path]')?.dataset['path'];

    if ((action === 'diff-open' || action === 'diff-tab') && path !== undefined) {
      this.openDiff(path);
      return true;
    }

    if (action === 'diff-close' && path !== undefined) {
      this.closeDiff(path);
      return true;
    }

    if (action === 'diff-layout') {
      this.#layout = (target.closest<HTMLElement>('[data-layout]')?.dataset['layout'] as DiffLayout | undefined) ?? 'auto';
      this.#keep(LAYOUT_KEY, this.#layout === 'auto' ? null : this.#layout);
      this.deps.draw();
      return true;
    }

    if (action === 'diff-wrap') {
      this.#wrap = !this.#shownLayout(target.closest<HTMLElement>('.diff-view')?.parentElement ?? null).wrap;
      this.#keep(WRAP_KEY, this.#wrap ? '1' : '0');
      this.deps.draw();
      return true;
    }

    if (action === 'diff-refresh' && this.view.open !== null) {
      void this.readDiff(this.view.open);
      return true;
    }

    if (action === 'diff-viewed' && path !== undefined) {
      void this.toggleViewed(path);
      return true;
    }

    if (action === 'diff-back' && this.view.open !== null) {
      this.#files.delete(this.view.open);
      this.deps.draw();
      return true;
    }

    if (action === 'diff-open-vscode' && this.view.open !== null) {
      void this.openInVsCode(this.view.open);
      return true;
    }

    return target.closest('.changes-menu') !== null;
  }

  /** Opens a file's diff in its own tab, or shows its tab, and reads it when it has not been read. */
  openDiff(path: string): void {
    if (!this.view.tabs.includes(path)) {
      this.view.tabs.push(path);
    }

    this.view.open = path;
    this.view.menu = false;

    if (!this.#diffs.has(path)) {
      void this.readDiff(path);
    }

    this.deps.showDiff();
  }

  /** Closes a file's tab; closing the one shown shows its neighbour, or another tab of the strip when it was the last. */
  closeDiff(path: string): void {
    const at = this.view.tabs.indexOf(path);

    if (at === -1) {
      return;
    }

    this.view.tabs.splice(at, 1);
    this.#diffs.delete(path);
    this.#files.delete(path);
    this.#diffSeq.delete(path);
    this.#loadingDiff.delete(path);

    if (this.view.open === path) {
      this.view.open = this.view.tabs[Math.min(at, this.view.tabs.length - 1)] ?? null;

      if (this.view.open === null) {
        this.deps.closedDiff();
        return;
      }
    }

    this.deps.draw();
  }

  /** Reads a file's diff from the hub; an answer for a conversation or a read the page has moved on from is dropped. */
  async readDiff(path: string): Promise<void> {
    const key = this.deps.key();

    if (key === null) {
      return;
    }

    const reading = this.#diffReads;
    const seq = ++this.#seq;
    const before = this.#diffs.get(path);

    this.#diffSeq.set(path, seq);

    this.#diffs.set(path, before?.state === 'ok' ? before : { state: 'loading' });
    this.#loadingDiff.add(path);
    this.deps.draw();

    let entry: DiffEntry;

    try {
      const response = await this.deps.fetch(`/v1/conversation/diff?window=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      entry = response.ok ? { state: 'ok', data: body as unknown as DiffData, version: response.headers?.get?.('ETag') ?? String(body['version'] ?? Date.now()) } : { state: 'error', error: String(body['error'] ?? `Switchboard answered ${response.status}.`) };
    } catch (failure) {
      entry = { state: 'error', error: `Switchboard did not answer: ${String(failure)}` };
    }

    if (reading !== this.#diffReads || !this.view.tabs.includes(path) || this.#diffSeq.get(path) !== seq) {
      return;
    }

    this.#loadingDiff.delete(path);
    this.#diffs.set(path, entry);
    this.deps.draw();
  }

  readonly #loadingDiff = new Set<string>();
  /** Each file's latest read, so an older answer that arrives after a newer one, or after its tab closed, is dropped. */
  readonly #diffSeq = new Map<string, number>();
  #seq = 0;
  /** The panes the diff tab drew into, watched so Auto follows a pane resized past 900 px without a redraw. */
  #resize: ResizeObserver | null = null;
  readonly #watched = new WeakSet<HTMLElement>();

  /** Gives the diff shown in `pane` the layout its width calls for now. */
  #relayout(pane: HTMLElement): void {
    const host = pane.querySelector<HTMLElement>(':scope > .diff-view > .diff-host');
    const mounted = host === null ? undefined : this.#mounted.get(host);
    const shown = this.#shownLayout(pane);
    // A file view is always stacked; only its wrapping follows the width.
    const layout = host?.classList.contains('file-view') === true ? `stacked ${shown.wrap}` : `${shown.layout} ${shown.wrap}`;

    if (mounted !== undefined && mounted.layout !== layout) {
      mounted.layout = layout;
      mounted.mount?.set(shown.layout, shown.wrap);
    }
  }

  /**
   * Shows the open tab's file at a line, from a line number clicked in its diff: the file on disk for the new side, the file at the base for the
   * old side (a deleted file's only side).
   */
  openFileView(side: 'old' | 'new', line: number): void {
    const tab = this.view.open;
    const row = tab === null ? undefined : this.view.list?.rows.find((one) => one.path === tab);

    if (tab === null) {
      return;
    }

    const base = side === 'old' || row?.status === 'D';
    const open: FileOpen = { path: base ? (row?.from ?? tab) : tab, side: base ? 'base' : 'disk', line, entry: { state: 'loading' } };

    this.#files.set(tab, open);
    this.#note = null;
    this.deps.draw();
    void this.#readFile(tab, open);
  }

  async #readFile(tab: string, open: FileOpen): Promise<void> {
    const key = this.deps.key();
    const reading = this.#diffReads;

    if (key === null) {
      return;
    }

    try {
      const response = await this.deps.fetch(`/v1/conversation/file?window=${encodeURIComponent(key)}&path=${encodeURIComponent(open.path)}&side=${open.side}`, { credentials: 'same-origin' });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      open.entry = response.ok ? { state: 'ok', data: body as unknown as FileData, version: response.headers?.get?.('ETag') ?? String(Date.now()) } : { state: 'error', error: String(body['error'] ?? `Switchboard answered ${response.status}.`) };
    } catch (failure) {
      open.entry = { state: 'error', error: `Switchboard did not answer: ${String(failure)}` };
    }

    if (reading === this.#diffReads && this.#files.get(tab) === open) {
      this.deps.draw();
    }
  }

  /**
   * Ticks a file viewed at the content the page shows, or clears its tick, in the hub, for every device; a file that changed since is read again
   * rather than ticked.
   */
  async toggleViewed(path: string): Promise<void> {
    const row = this.view.list?.rows.find((one) => one.path === path);

    if (row === undefined) {
      return;
    }

    row.viewed = row.viewed !== true;
    this.deps.draw();

    // One post at a time per file, the last click's choice sent once the one on its way answers, so the hub ends where the page shows.
    if (this.#ticking.has(row)) {
      return;
    }

    this.#ticking.add(row);

    try {
      for (let sent: boolean | null = null; row.viewed !== sent; ) {
        sent = row.viewed === true;

        const answer = await this.deps.command('viewed', { path, hash: row.hash, viewed: sent });

        if (answer.status !== 200) {
          row.viewed = !sent;
          this.view.error = String(answer.body['error'] ?? `Switchboard answered ${answer.status}.`);
          this.deps.draw();
          void this.refresh();
          return;
        }
      }
    } finally {
      this.#ticking.delete(row);
    }
  }

  /** The rows whose tick is being posted: a list read again has new rows, which post on their own. */
  readonly #ticking = new WeakSet<ChangeRow>();

  /** Another device ticked a file or cleared its tick: the list follows it while the file's content is the one ticked. */
  viewedEvent(data: Record<string, unknown>): void {
    const row = data['workItemId'] === this.deps.workItemId() ? this.view.list?.rows.find((one) => one.path === data['path'] && one.hash === data['hash']) : undefined;

    if (row !== undefined && typeof data['viewed'] === 'boolean') {
      row.viewed = data['viewed'];
      this.deps.draw();
    }
  }

  /** Opens the tab's file, at the file view's line or its first, in the work item's VS Code window, and says how that went. */
  async openInVsCode(tab: string): Promise<void> {
    const open = this.#files.get(tab);
    const answer = await this.deps.command('open-file', { path: open?.path ?? tab, line: open?.line ?? 1 });

    this.#note = { path: tab, text: answer.status === 200 ? 'Opened in VS Code.' : String(answer.body['error'] ?? `Switchboard answered ${answer.status}.`) };
    this.deps.draw();
  }

  #keep(key: string, value: string | null): void {
    try {
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    } catch {
      // Kept until the page reloads.
    }
  }

  /** The layout and wrapping the diff shows with in `pane` now. */
  #shownLayout(pane: HTMLElement | null): { layout: 'split' | 'stacked'; wrap: boolean } {
    return diffLayout(this.#layout, this.#wrap, pane?.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 0));
  }

  /**
   * Draws the open file's diff into a pane: its header, then the diff viewer, which keeps its own DOM, mounted once per file and version and
   * given the layout again when the pane's width or a choice changes it.
   */
  drawDiff(pane: HTMLElement): void {
    const path = this.view.open;

    if (path === null) {
      return;
    }

    if (!this.#watched.has(pane) && typeof ResizeObserver === 'function') {
      this.#resize ??= new ResizeObserver((entries) => entries.forEach((one) => this.#relayout(one.target as HTMLElement)));
      this.#resize.observe(pane);
      this.#watched.add(pane);
    }

    const entry = this.#diffs.get(path);
    const file = this.#files.get(path) ?? null;
    const shown = this.#shownLayout(pane);
    const version = file !== null ? `file ${file.side} ${file.path} ${file.line} ${file.entry.state === 'ok' ? file.entry.version : file.entry.state}` : entry?.state === 'ok' ? entry.version : (entry?.state ?? '');
    const id = `${path}\u0000${version}`;
    let view = pane.querySelector<HTMLElement>(':scope > .diff-view');

    if (view?.dataset['diff'] !== id) {
      this.deps.takePane(pane);
      view = document.createElement('div');
      view.className = 'diff-view';
      view.dataset['diff'] = id;
      view.append(document.createElement('div'), document.createElement('div'));
      view.lastElementChild!.className = 'diff-host';
      pane.replaceChildren(view);
      this.drop();

      if (file === null) {
        this.#mountInto(view.lastElementChild as HTMLElement, entry, shown);
      } else {
        view.lastElementChild!.classList.add('file-view');
        this.#mountFileInto(view.lastElementChild as HTMLElement, file, shown.wrap);
      }
    }

    this.#relayout(pane);
    mount(view.firstElementChild!, <DiffHead path={path} row={this.view.list?.rows.find((one) => one.path === path)} choice={this.#layout} wrap={shown.wrap} loading={this.#loadingDiff.has(path)} file={file} note={this.#note?.path === path ? this.#note.text : null} />);
  }

  /** Mounts the diff viewer on a host once its module loads, or says why there is no diff to show. */
  #mountInto(host: HTMLElement, entry: DiffEntry | undefined, shown: { layout: 'split' | 'stacked'; wrap: boolean }): void {
    const say = (text: string): void => {
      const note = document.createElement('p');

      note.className = 'empty';
      note.textContent = text;
      host.replaceChildren(note);
    };
    const note = diffNote(entry);

    this.#mounted.set(host, { mount: null, layout: `${shown.layout} ${shown.wrap}` });

    if (note !== null || entry?.state !== 'ok') {
      say(note ?? 'Reading the diff…');
      return;
    }

    say('Loading the diff viewer…');
    this.#module ??= this.deps.loadDiff();
    void this.#module.then((module) => {
      const kept = this.#mounted.get(host);

      if (kept === undefined || !host.isConnected) {
        return;
      }

      if (module === null) {
        this.#module = null;
        say('The diff viewer could not be loaded. Reload the page to try again.');
        return;
      }

      host.replaceChildren();

      const [layout, wrap] = kept.layout.split(' ') as ['split' | 'stacked', string];

      kept.mount = module.mountDiff(host, entry.data, entry.version, { layout, wrap: wrap === 'true', onLine: (side, line) => this.openFileView(side, line) });

      if (kept.mount === null) {
        say("git's patch for this file could not be read.");
      } else if (entry.data.tooLarge === 'sides') {
        host.classList.add('patch-only');
      }
    });
  }

  /** Mounts the file view on a host once the viewer loads, or says why there is no file to show. */
  #mountFileInto(host: HTMLElement, file: FileOpen, wrap: boolean): void {
    const say = (text: string): void => {
      const line = document.createElement('p');

      line.className = 'empty';
      line.textContent = text;
      host.replaceChildren(line);
    };
    const note = fileNote(file.entry);
    const entry = file.entry;

    this.#mounted.set(host, { mount: null, layout: `stacked ${wrap}` });

    if (note !== null || entry.state !== 'ok') {
      say(note ?? 'Reading the file…');
      return;
    }

    say('Loading the diff viewer…');
    this.#module ??= this.deps.loadDiff();
    void this.#module.then((module) => {
      const kept = this.#mounted.get(host);

      if (kept === undefined || !host.isConnected) {
        return;
      }

      if (module === null) {
        this.#module = null;
        say('The diff viewer could not be loaded. Reload the page to try again.');
        return;
      }

      host.replaceChildren();
      kept.mount = module.mountFile(host, entry.data, entry.version, { wrap, line: file.line });
    });
  }

  /** Ends the diff viewers whose host has left the page. */
  drop(): void {
    for (const [host, mounted] of this.#mounted) {
      if (!host.isConnected) {
        this.#mounted.delete(host);
        mounted.mount?.dispose();
      }
    }
  }

  /** Closes the menu on a press outside it and its button; true when it closed. */
  pointerDown(target: EventTarget | null): boolean {
    if (!this.view.menu || (target instanceof Element && target.closest('.changes-menu, .changes-button') !== null)) {
      return false;
    }

    this.view.menu = false;
    return true;
  }

  /** Closes the menu on Escape; true when it closed. */
  escape(): boolean {
    if (!this.view.menu) {
      return false;
    }

    this.view.menu = false;
    return true;
  }
}