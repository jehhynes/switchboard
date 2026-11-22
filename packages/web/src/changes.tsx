// The Changes list and the Changes tab (PRD R118, architecture.md § Web page): the open conversation's worktree changes from its merge base to
// disk, as the VS Code window's Open changes shows them, in a menu from the Changes button at the end of the tab strips, and every changed file's
// diff in one scrolling Changes tab, drawn by the diff viewer the page loads on first use, which reads only the files near the view.
import type { ComponentChildren, VNode } from 'preact';
import { DIFF_BUDGET, evictions, MAX_IN_FLIGHT, rowKey, wantedIndexes } from './changesWindow.js';
import { FileIcon } from './fileIcons.js';
import { mount } from './island.js';
import type { ChangeRow, ChangesList, ChangeStage, ChangeStatus, DiffData, FileData } from '@switchboard/protocol';
import type { ChangesMount, DiffModule, DiffMount, RowContent } from './diff/types.js';

export type { ChangeRow, ChangesList, ChangeStage, ChangeStatus } from '@switchboard/protocol';

/** What the page keeps of the Changes list: the list as last read, a read on its way or why one failed, whether its menu is open, and the Changes tab. */
export interface ChangesView {
  list: ChangesList | null;
  loading: boolean;
  error: string | null;
  menu: boolean;
  /** The conversation the list was read for: the page key, scope generation and work item. */
  for: string | null;
  /** Whether the Changes tab is open. */
  tab: boolean;
  /** Whether the Changes tab leaves out the files ticked viewed. */
  hideViewed: boolean;
}

export const newChanges = (): ChangesView => ({ list: null, loading: false, error: null, menu: false, for: null, tab: false, hideViewed: false });

/** Where the diff's sides go: side by side, one above the other, or by the pane's width (`auto`, stacked and wrapped under {@link SPLIT_MIN_WIDTH}). */
export type DiffLayout = 'auto' | 'split' | 'stacked';
/** Whether long lines wrap: always, never, or only while `auto` stacks the sides (`web.diffWrap`). */
export type DiffWrap = 'auto' | 'on' | 'off';
/** The narrowest pane a diff shows side by side in, as VS Code's diff editor switches to inline at 900 px. */
export const SPLIT_MIN_WIDTH = 900;

/** The layout and wrapping a diff shows with in a pane `width` pixels wide. */
export function diffLayout(choice: DiffLayout, wrap: DiffWrap, width: number): { layout: 'split' | 'stacked'; wrap: boolean } {
  const layout = choice === 'auto' ? (width > 0 && width < SPLIT_MIN_WIDTH ? 'stacked' : 'split') : choice;

  return { layout, wrap: wrap === 'auto' ? choice === 'auto' && layout === 'stacked' : wrap === 'on' };
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

/** How many files are ticked viewed, and the lines added and deleted over every row. */
function totals(list: ChangesList): { viewed: number; additions: number; deletions: number } {
  return list.rows.reduce((sum, row) => ({ viewed: sum.viewed + (row.viewed === true ? 1 : 0), additions: sum.additions + (row.additions ?? 0), deletions: sum.deletions + (row.deletions ?? 0) }), { viewed: 0, additions: 0, deletions: 0 });
}

/** The Changes tab, after the strip's other tabs and before the Changes button, with how many files are viewed of all and a close mark; `shown` is whether the strip shows it now. */
export function diffTabs(changes: ChangesView, shown: boolean): ComponentChildren {
  if (!changes.tab) {
    return null;
  }

  const list = changes.list;
  const progress = list === null ? null : `${totals(list).viewed}/${list.total}`;

  return (
    <span class={`tab diff-tab push${shown ? ' selected' : ''}`} role="presentation">
      <button class="tab-open" type="button" role="tab" data-action="diff-tab" aria-selected={shown} tabindex={shown ? 0 : -1} title="Every changed file's diff" aria-label={progress === null ? 'Changes' : `Changes, ${progress} viewed`}>
        <span class="codicon codicon-diff-multiple" aria-hidden="true"></span>
        <span class="tab-label">Changes</span>
        {progress === null ? null : <span class="tab-badge muted">{progress}</span>}
      </button>
      <button class="tab-close" type="button" data-action="diff-close" aria-label="Close Changes" title="Close" tabindex={shown ? 0 : -1}>
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </span>
  );
}

/** The Changes button, after the strip's tabs, with the count once a list was read. */
export function changesButton(changes: ChangesView): VNode {
  const count = changes.list?.total;

  return (
    <button class={`tab changes-button${changes.tab ? '' : ' push'}${changes.menu ? ' open' : ''}`} type="button" data-action="changes-menu" aria-expanded={changes.menu} aria-label={count === undefined ? 'Changes list' : `Changes list, ${count} files`} title="The worktree's changes since its base">
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

/** What the menu says above its rows: how many files, the lines added and deleted, how many are viewed, and a first cut when the worktree has more than the hub lists. */
export function listNote(list: ChangesList): string {
  const files = list.total === 1 ? '1 file' : `${list.total} files`;
  const { viewed, additions, deletions } = totals(list);
  const ticked = viewed === 0 ? '' : ` · ${viewed} viewed`;
  const lines = ` · +${additions} −${deletions}`;

  return list.shown < list.total ? `first ${list.shown} of ${files}${lines}${ticked}` : `${files}${lines}${ticked}`;
}

/** The menu note's tooltip: since which base. */
export function listBase(list: ChangesList): string {
  return list.base === null ? 'Uncommitted changes only, no merge base' : `Since ${list.base.slice(0, 7)}`;
}

/** A header button of the Changes menu: a codicon with its name as tooltip. */
function HeadButton({ action, icon, label, pressed, disabled }: { action: string; icon: string; label: string; pressed?: boolean; disabled?: boolean }): VNode {
  return (
    <button class="icon" type="button" data-action={action} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled}>
      <span class={`codicon codicon-${icon}`} aria-hidden="true"></span>
    </button>
  );
}

/**
 * The Changes menu while open, under the strip: its note, Hide viewed, Collapse all, Expand all and Refresh, then the rows, or why there are
 * none. Open in VS Code is in the work item's Actions menu, not here.
 */
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

  const empty = list === null || list.rows.length === 0;

  return (
    <div class="glass changes-menu">
      <div class="changes-head">
        <span class="changes-note" title={list === null ? undefined : listBase(list)}>
          {list === null ? 'Changes' : listNote(list)}
        </span>
        <HeadButton action="changes-hide-viewed" icon={changes.hideViewed ? 'eye-closed' : 'eye'} label={changes.hideViewed ? 'Show viewed files' : 'Hide viewed files'} pressed={changes.hideViewed} disabled={empty} />
        <HeadButton action="changes-collapse-all" icon="collapse-all" label="Collapse all" disabled={empty} />
        <HeadButton action="changes-expand-all" icon="expand-all" label="Expand all" disabled={empty} />
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
  /** Shows the Changes tab, in the side column on a wide screen and in the conversation's strip on a narrower one. */
  showDiff(): void;
  /** The Changes tab closed while it showed: the strip shows another tab. */
  closedDiff(): void;
  /** Loads the diff viewer's module on first use; null when it cannot load. */
  loadDiff(): Promise<DiffModule | null>;
  /** Empties a pane Preact drew into, before the Changes tab draws into it itself. */
  takePane(pane: HTMLElement): void;
  /** The work item the page shows, which a `viewed` event must name. */
  workItemId(): number | null;
  /** Posts a command for the conversation the page shows, with its `scopeGen`. */
  command(name: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  /** The diff viewer's layout and wrapping, from the settings (`web.diffLayout`, `web.diffWrap`). */
  diffSettings(): { layout: DiffLayout; wrap: DiffWrap };
}

/** The Changes tab's file view: a file at a line, on disk or at the base, opened from a line number of its diff. */
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

/** What the Changes tab says in place of a file's diff: a binary file, one too large, a read on its way or why it failed. */
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

/** A file's diff the Changes tab holds: what it was read for, its ETag, how many characters it holds and whether its sides were read too. */
interface Held {
  key: string;
  etag: string | null;
  content: RowContent;
  chars: number;
  hydrated: boolean;
}

/** What the viewer draws a row's header and placeholder from, so a change to any of it draws the row again. */
function rowShape(row: ChangeRow): string {
  return JSON.stringify([row.path, row.from ?? null, row.status, row.additions, row.deletions, row.binary]);
}

/** The file view's way back to the diffs, before the file's name in its header and before what the view says in place of the file. */
function BackButton(): VNode {
  return (
    <button class="diff-back" type="button" data-action="diff-back" title="Back to the diffs" aria-label="Back to the diffs">
      <span class="codicon codicon-arrow-left" aria-hidden="true"></span>
    </button>
  );
}

/** What a file's own header carries after its counts: its Viewed tick. */
function DiffTools({ row }: { row: ChangeRow | undefined }): VNode | null {
  return row === undefined ? null : (
    <label class="diff-viewed" title={row.viewed === true ? 'Viewed; untick to read it again' : 'Mark viewed'}>
      <input type="checkbox" data-action="diff-viewed" data-path={row.path} checked={row.viewed === true} />
      Viewed
    </label>
  );
}

/** A file's collapse chevron, before its name in its own header: down while its diff shows, right while it is collapsed to its header. */
function Chevron({ path, collapsed }: { path: string; collapsed: boolean }): VNode {
  return (
    <button class="diff-chevron" type="button" data-action="diff-collapse" data-path={path} aria-expanded={!collapsed} aria-label={collapsed ? `Expand ${path}` : `Collapse ${path}`} title={collapsed ? 'Expand' : 'Collapse'}>
      <span class={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} aria-hidden="true"></span>
    </button>
  );
}

/** An element the viewer puts in a file's own header. */
function slot(): HTMLElement {
  const element = document.createElement('span');

  element.className = 'diff-slot';
  return element;
}

/** The page's side of the Changes list and tab: reads them from the hub, and answers the clicks and presses on the list, its menu and the tab. */
export class ChangesController {
  readonly view: ChangesView = newChanges();
  #reading = 0;
  /** Bumped when the page leaves the conversation, so an answer read for the one it left is dropped. */
  #generation = 0;
  #module: Promise<DiffModule | null> | null = null;
  /** The Changes tab's viewer and the host it draws into, null before the module loads or once its host left the page. */
  #mount: { host: HTMLElement; mount: ChangesMount; layout: string; paths: string[] } | null = null;
  /** Each held file's diff, by path. */
  readonly #held = new Map<string, Held>();
  /** The reads on their way, by path, with the key each was asked for. */
  readonly #inFlight = new Map<string, string>();
  /** The keys a read failed for, retried once the list is read again. */
  readonly #failed = new Set<string>();
  /** The file to bring to the top once the viewer has mounted. */
  #jump: string | null = null;
  #collapsed = new Set<string>();
  /** The files collapsed because they are ticked viewed, which expand again when the tick goes, as it does when the file changes. */
  readonly #viewedCollapsed = new Set<string>();
  /** Whether the next mount collapses the viewed files: only when the tab opens, so a file the operator expanded stays so across remounts. */
  #collapseViewed = false;
  #file: FileOpen | null = null;
  /** The pane the Changes tab drew into, watched so Auto follows a pane resized past 900 px without a redraw. */
  #resize: ResizeObserver | null = null;
  readonly #watched = new WeakSet<HTMLElement>();
  #fileMount: { host: HTMLElement; mount: DiffMount | null } | null = null;
  /** Each file's header element the viewer shows after its counts, by path, drawn again on every draw. */
  readonly #metas = new Map<string, HTMLElement>();
  /** Each file's header element the viewer shows before its name, by path, drawn again on every draw. */
  readonly #prefixes = new Map<string, HTMLElement>();

  constructor(private readonly deps: ChangesDeps) {}

  /**
   * Follows the page's conversation: `id` names it (page key, scope generation, work item), so another one drops the list, its diffs and the
   * Changes tab; `turnEnded` reads the list again when the session's turn ends while the menu or the tab is open.
   */
  follow(id: string | null, turnEnded: boolean): void {
    if (id !== this.view.for) {
      this.#reading++;
      this.#generation++;
      this.#held.clear();
      this.#inFlight.clear();
      this.#failed.clear();
      this.#collapsed.clear();
      this.#jump = null;
      this.#file = null;
      this.#unmount();
      Object.assign(this.view, newChanges(), { for: id });
      return;
    }

    if (turnEnded && (this.view.menu || this.view.tab)) {
      void this.refresh();
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

    if (list !== null) {
      this.view.list = list;
      this.#failed.clear();
      this.#syncRows();
    }

    this.deps.draw();
  }

  /** The rows the Changes tab shows, in the list's order: all, or those not ticked viewed. */
  #rows(): ChangeRow[] {
    const rows = this.view.list?.rows ?? [];

    return this.view.hideViewed ? rows.filter((row) => row.viewed !== true) : rows;
  }

  /** Gives the viewer the rows shown now, drops held diffs of rows that went, and reads what the view wants. */
  #syncRows(): void {
    // A file collapsed for its tick expands once the tick is gone, as when the file changed since it was ticked.
    for (const path of [...this.#viewedCollapsed]) {
      if (this.view.list?.rows.find((one) => one.path === path)?.viewed !== true) {
        this.#viewedCollapsed.delete(path);
        this.#collapsed.delete(path);
        this.#mount?.mount.setCollapsed(path, false);
      }
    }

    const rows = this.#rows();
    const paths = new Set(this.view.list?.rows.map((row) => row.path) ?? []);

    for (const path of [...this.#held.keys()].filter((one) => !paths.has(one))) {
      this.#held.delete(path);
    }

    const mounted = this.#mount;

    if (mounted !== null) {
      const next = rows.map(rowShape);
      const before = new Map(mounted.paths.map((shape) => [JSON.parse(shape)[0] as string, shape]));

      if (next.join('\u0000') !== mounted.paths.join('\u0000')) {
        mounted.paths = next;
        mounted.mount.setRows(rows);

        for (const [index, row] of rows.entries()) {
          const held = this.#held.get(row.path);

          // A row shown again draws what is held for it, and its collapse; a row whose header data changed gets a placeholder drawn from it.
          if (before.get(row.path) !== next[index]) {
            mounted.mount.setRow(row.path, held?.content ?? null);
            mounted.mount.setCollapsed(row.path, this.#collapsed.has(row.path));
          }
        }
      }
    }

    this.#pump();
  }

  /** Handles a click on the Changes button, its menu or the Changes tab; false for any other click. */
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

    if (action === 'changes-hide-viewed') {
      this.view.hideViewed = !this.view.hideViewed;
      this.#syncRows();
      this.deps.draw();
      return true;
    }

    if (action === 'changes-collapse-all' || action === 'changes-expand-all') {
      const collapse = action === 'changes-collapse-all';

      this.#collapsed = collapse ? new Set(this.view.list?.rows.map((row) => row.path)) : new Set();
      this.#viewedCollapsed.clear();
      this.#rows().forEach((row) => this.#mount?.mount.setCollapsed(row.path, collapse));
      this.deps.draw();
      this.#pump();
      return true;
    }

    if (action === 'diff-collapse') {
      const toggled = target.closest<HTMLElement>('[data-path]')?.dataset['path'];

      if (toggled !== undefined) {
        this.#setCollapsed(toggled, !this.#collapsed.has(toggled));
      }

      return true;
    }

    const path = target.closest<HTMLElement>('[data-path]')?.dataset['path'];

    if (action === 'diff-open' && path !== undefined) {
      this.openChanges(path);
      return true;
    }

    if (action === 'diff-tab') {
      this.openChanges(null);
      return true;
    }

    if (action === 'diff-close') {
      this.closeChanges();
      return true;
    }

    if (action === 'diff-viewed' && path !== undefined) {
      void this.toggleViewed(path);
      return true;
    }

    if (action === 'diff-back') {
      this.#file = null;
      this.deps.draw();
      return true;
    }

    return target.closest('.changes-menu') !== null;
  }

  /** Opens the Changes tab, or shows it, at a file's diff when `path` names one; opening it reads the list again. */
  openChanges(path: string | null): void {
    const opening = !this.view.tab;

    if (opening) {
      this.#collapseViewed = true;
    }

    this.view.tab = true;
    this.view.menu = false;
    this.#file = null;

    if (path !== null) {
      // A file hidden as viewed shows again when picked.
      if (this.view.hideViewed && this.view.list?.rows.find((row) => row.path === path)?.viewed === true) {
        this.view.hideViewed = false;
        this.#syncRows();
      }

      this.#jump = path;
      this.#scrollToJump();
    }

    if (opening) {
      void this.refresh();
    }

    this.deps.showDiff();
  }

  /** Closes the Changes tab; the strip shows another tab. */
  closeChanges(): void {
    if (!this.view.tab) {
      return;
    }

    this.view.tab = false;
    this.#file = null;
    this.#unmount();
    this.deps.closedDiff();
  }

  #scrollToJump(): void {
    if (this.#jump !== null && this.#mount !== null) {
      this.#mount.mount.scrollToFile(this.#jump);
      this.#jump = null;
    }
  }

  /** Reads one file's diff, the patch alone, sending the ETag of what is held for it so an unchanged one answers 304. */
  async #read(row: ChangeRow, key: string): Promise<void> {
    const pageKey = this.deps.key();
    const generation = this.#generation;

    if (pageKey === null) {
      return;
    }

    const held = this.#held.get(row.path);

    this.#inFlight.set(row.path, key);

    let next: Held | null = null;
    let failed = false;

    try {
      const response = await this.deps.fetch(`/v1/conversation/diff?window=${encodeURIComponent(pageKey)}&path=${encodeURIComponent(row.path)}&sides=0`, {
        credentials: 'same-origin',
        ...(held?.etag == null ? {} : { headers: { 'If-None-Match': held.etag } }),
      });

      if (response.status === 304 && held !== undefined) {
        next = { ...held, key };
      } else {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

        if (response.ok) {
          const data = body as unknown as DiffData;
          const note = diffNote({ state: 'ok', data, version: '' });

          next = { key, etag: response.headers?.get?.('ETag') ?? null, content: note === null ? { data } : { note }, chars: data.patch?.length ?? 0, hydrated: false };
        } else {
          next = { key, etag: null, content: { note: String(body['error'] ?? `Switchboard answered ${response.status}.`) }, chars: 0, hydrated: false };
          failed = true;
        }
      }
    } catch (failure) {
      next = { key, etag: null, content: { note: `Switchboard did not answer: ${String(failure)}` }, chars: 0, hydrated: false };
      failed = true;
    }

    if (generation !== this.#generation || this.#inFlight.get(row.path) !== key) {
      return;
    }

    this.#inFlight.delete(row.path);

    const now = this.view.list?.rows.find((one) => one.path === row.path);

    // The list was read again meanwhile and the row changed: this answer is for content no longer shown.
    if (now === undefined || rowKey(this.view.list?.base ?? null, now) !== key) {
      this.#pump();
      return;
    }

    if (failed) {
      // A failed read shows why but holds nothing, so it is read again once the list is.
      this.#failed.add(key);
      this.#mount?.mount.setRow(row.path, next.content);
    } else {
      const current = this.#held.get(row.path);

      this.#held.set(row.path, next);

      if (current === undefined || next.content !== current.content) {
        this.#mount?.mount.setRow(row.path, next.content);
      }
    }

    this.#pump();
  }

  /** Starts the reads the view wants, at most {@link MAX_IN_FLIGHT} at a time, then gives up held diffs past the budget, the furthest first. */
  #pump(): void {
    const mounted = this.#mount;
    const base = this.view.list?.base ?? null;

    if (mounted === null || !this.view.tab) {
      return;
    }

    const rows = this.#rows();
    const visible = mounted.mount.visible();
    // A collapsed file shows only its header, so its diff is not read until it is expanded.
    const wanted = wantedIndexes(visible, rows.length)
      .map((index) => rows[index]!)
      .filter((row) => !this.#collapsed.has(row.path));

    for (const row of wanted) {
      if (this.#inFlight.size >= MAX_IN_FLIGHT) {
        break;
      }

      const key = rowKey(base, row);

      if (this.#held.get(row.path)?.key !== key && !this.#inFlight.has(row.path) && !this.#failed.has(key)) {
        void this.#read(row, key);
      }
    }

    const index = new Map(rows.map((row, at) => [row.path, at]));
    const out = evictions(
      [...this.#held].map(([path, held]) => ({ path, index: index.get(path) ?? -1, chars: held.chars, hydrated: held.hydrated })),
      // A row being read is never given up, so its answer always lands on what it holds.
      new Set([...wanted.map((row) => row.path), ...this.#inFlight.keys()]),
      visible,
      DIFF_BUDGET,
    );

    for (const path of out) {
      const height = mounted.mount.heightOf(path);

      this.#held.delete(path);

      // A placeholder as tall as the diff was, so the view does not move.
      if (height !== undefined) {
        mounted.mount.setRow(path, null, mounted.mount.linesFor(height));
      }
    }
  }

  /** Reads a file's diff with both sides, for a region of its patch-only diff expanded; null when it cannot be read. */
  async #loadSides(path: string): Promise<DiffData | null> {
    const key = this.deps.key();
    const generation = this.#generation;

    if (key === null) {
      return null;
    }

    try {
      const response = await this.deps.fetch(`/v1/conversation/diff?window=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as DiffData;
      const held = this.#held.get(path);
      const shown = held !== undefined && 'data' in (held.content ?? {}) ? (held.content as { data: DiffData }).data.patch : null;

      // The file changed since its patch was read: its sides would not match, so its diff is read again instead.
      if (generation === this.#generation && held !== undefined && data.patch !== shown) {
        held.key = '';
        this.#pump();
        return null;
      }

      if (generation === this.#generation && held !== undefined) {
        held.chars += (data.old?.length ?? 0) + (data.new?.length ?? 0);
        held.hydrated = true;
      }

      return data;
    } catch {
      return null;
    }
  }

  /**
   * Shows a file at a line, from a line number clicked in its diff: the file on disk for the new side, the file at the base for the old side (a
   * deleted file's only side), over the diffs, which keep their place for Back.
   */
  openFileView(path: string, side: 'old' | 'new', line: number): void {
    const row = this.view.list?.rows.find((one) => one.path === path);
    const base = side === 'old' || row?.status === 'D';
    const open: FileOpen = { path: base ? (row?.from ?? path) : path, side: base ? 'base' : 'disk', line, entry: { state: 'loading' } };

    this.#file = open;
    this.deps.draw();
    void this.#readFile(open);
  }

  async #readFile(open: FileOpen): Promise<void> {
    const key = this.deps.key();
    const generation = this.#generation;

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

    if (generation === this.#generation && this.#file === open) {
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
    this.#tickCollapse(path, row.viewed);
    this.#viewedChanged();

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
          this.#setCollapsed(path, row.viewed, true);
          this.view.error = String(answer.body['error'] ?? `Switchboard answered ${answer.status}.`);
          this.#viewedChanged();
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

      // Collapsed only while off screen, so nothing is pulled from under the reader.
      if (row.viewed && !this.#onScreen(row.path)) {
        this.#setCollapsed(row.path, true, true);
      } else if (!row.viewed && this.#viewedCollapsed.has(row.path)) {
        // A file collapsed for its tick opens when another device clears it.
        this.#setCollapsed(row.path, false);
      }

      this.#viewedChanged();
    }
  }

  /** Whether a row of the Changes tab meets the view now. */
  #onScreen(path: string): boolean {
    const visible = this.#mount?.mount.visible() ?? null;
    const index = this.#rows().findIndex((one) => one.path === path);

    return visible !== null && index >= visible.first && index <= visible.last;
  }

  /**
   * A tick collapses the file and an untick expands it in place, as on a pull request; a file ticked while its header was at the top brings the
   * next file's header there, so reading goes on downward.
   */
  #tickCollapse(path: string, viewed: boolean): void {
    const mounted = this.#mount;
    const top = viewed && mounted !== null && mounted.mount.current() === path;

    this.#setCollapsed(path, viewed, true);

    if (top) {
      // The next file after it in the list that the tab still shows: with viewed files hidden, the ticked file has already left the tab.
      const all = this.view.list?.rows ?? [];
      const shown = new Set(this.#rows().map((one) => one.path));
      const next = all.slice(all.findIndex((one) => one.path === path) + 1).find((one) => shown.has(one.path));

      if (next !== undefined) {
        mounted.mount.scrollToFile(next.path);
      }
    }
  }

  /** A tick changed: the tab's count follows, and with viewed files hidden, so do its rows. */
  #viewedChanged(): void {
    if (this.view.hideViewed) {
      this.#syncRows();
    }

    this.deps.draw();
  }

  /** The layout and wrapping the diffs show with in `pane` now. */
  #shownLayout(pane: HTMLElement | null): { layout: 'split' | 'stacked'; wrap: boolean } {
    const settings = this.deps.diffSettings();

    return diffLayout(settings.layout, settings.wrap, pane?.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 0));
  }

  /** Gives the diffs and the file view shown in `pane` the layout its width calls for now. */
  #relayout(pane: HTMLElement): void {
    const shown = this.#shownLayout(pane);
    const mounted = this.#mount;

    if (mounted !== null && pane.contains(mounted.host) && mounted.layout !== `${shown.layout} ${shown.wrap}`) {
      mounted.layout = `${shown.layout} ${shown.wrap}`;
      mounted.mount.set(shown.layout, shown.wrap);
    }

    if (this.#fileMount !== null && pane.contains(this.#fileMount.host)) {
      this.#fileMount.mount?.set('stacked', shown.wrap);
    }
  }

  /** Says `text` in a host in place of the diffs. */
  #say(host: HTMLElement, text: string): void {
    const note = document.createElement('p');

    note.className = 'empty';
    note.textContent = text;
    host.replaceChildren(note);
  }

  #unmount(): void {
    this.#metas.clear();
    this.#prefixes.clear();
    this.#mount?.mount.dispose();
    this.#mount = null;
    this.#fileMount?.mount?.dispose();
    this.#fileMount = null;
  }

  /**
   * Draws the Changes tab into a pane: every row's diff in one view, mounted once per conversation and given the layout again when the pane's
   * width changes, and over it the file view while one is open. Nothing sits above the diffs.
   */
  drawDiff(pane: HTMLElement): void {
    if (!this.view.tab) {
      return;
    }

    if (!this.#watched.has(pane) && typeof ResizeObserver === 'function') {
      this.#resize ??= new ResizeObserver((entries) => entries.forEach((one) => this.#relayout(one.target as HTMLElement)));
      this.#resize.observe(pane);
      this.#watched.add(pane);
    }

    let view = pane.querySelector<HTMLElement>(':scope > .diff-view');

    if (view?.dataset['diff'] !== this.view.for) {
      this.deps.takePane(pane);
      view = document.createElement('div');
      view.className = 'diff-view';
      view.dataset['diff'] = this.view.for ?? '';

      const host = document.createElement('div');

      host.className = 'diff-host';
      view.append(host);
      pane.replaceChildren(view);
      this.drop();
    }

    const host = view.querySelector<HTMLElement>(':scope > .diff-host')!;
    const list = this.view.list;

    if (this.#mount === null || this.#mount.host !== host) {
      if (this.view.error !== null && list === null) {
        this.#say(host, this.view.error);
      } else if (list === null) {
        this.#say(host, 'Reading the changes…');
      } else if (list.rows.length === 0) {
        this.#say(host, list.base === null ? 'No uncommitted changes, and no merge base was found.' : 'No changes since the merge base.');
      } else if (host.dataset['mounting'] !== 'yes') {
        host.dataset['mounting'] = 'yes';
        this.#mountInto(host);
      }
    }

    this.#relayout(pane);
    this.#drawFile(view);

    for (const [path, element] of this.#metas) {
      mount(element, <DiffTools row={this.view.list?.rows.find((one) => one.path === path)} />);
    }

    for (const [path, element] of this.#prefixes) {
      mount(element, <Chevron path={path} collapsed={this.#collapsed.has(path)} />);
    }
  }

  /** A file's header element before its name, holding its collapse chevron. */
  #prefix(path: string): HTMLElement {
    let element = this.#prefixes.get(path);

    if (element === undefined) {
      element = slot();
      this.#prefixes.set(path, element);
      mount(element, <Chevron path={path} collapsed={this.#collapsed.has(path)} />);
    }

    return element;
  }

  /** Collapses or expands a file of the Changes tab, keeping that for when the viewer mounts again, and turns its chevron. */
  #setCollapsed(path: string, collapsed: boolean, byTick = false): void {
    if (byTick && collapsed) {
      this.#viewedCollapsed.add(path);
    } else {
      this.#viewedCollapsed.delete(path);
    }

    if (collapsed) {
      this.#collapsed.add(path);
    } else {
      this.#collapsed.delete(path);
    }

    this.#mount?.mount.setCollapsed(path, collapsed);
    this.deps.draw();
    this.#pump();
  }

  /** A collapsed file's header clicked, away from its controls: it expands. */
  #headerClicked(path: string): void {
    if (this.#collapsed.has(path)) {
      this.#setCollapsed(path, false);
    }
  }

  /** A file's header element after its counts, holding its Viewed tick. */
  #meta(path: string): HTMLElement {
    let element = this.#metas.get(path);

    if (element === undefined) {
      element = slot();
      this.#metas.set(path, element);
      mount(element, <DiffTools row={this.view.list?.rows.find((one) => one.path === path)} />);
    }

    return element;
  }

  /** Mounts the viewer on the host once its module loads, or says why it cannot. */
  #mountInto(host: HTMLElement): void {
    this.#say(host, 'Loading the diff viewer…');
    this.#module ??= this.deps.loadDiff();
    void this.#module.then((module) => {
      delete host.dataset['mounting'];

      if (!host.isConnected || !this.view.tab) {
        return;
      }

      if (module === null) {
        this.#module = null;
        this.#say(host, 'The diff viewer could not be loaded. Reload the page to try again.');
        return;
      }

      const rows = this.#rows();
      const shown = this.#shownLayout(host.closest<HTMLElement>('.diff-pane') ?? host);

      host.replaceChildren();
      this.#mount?.mount.dispose();

      const mount = module.mountChanges(host, rows, { layout: shown.layout, wrap: shown.wrap, loadSides: (path) => this.#loadSides(path), onLine: (path, side, line) => this.openFileView(path, side, line), headerMeta: (path) => this.#meta(path), headerPrefix: (path) => this.#prefix(path), onHeader: (path) => this.#headerClicked(path) });

      // Viewed files start collapsed when the tab opens, as on a pull request.
      if (this.#collapseViewed) {
        this.#collapseViewed = false;

        for (const row of rows.filter((one) => one.viewed === true)) {
          this.#collapsed.add(row.path);
          this.#viewedCollapsed.add(row.path);
        }
      }

      this.#mount = { host, mount, layout: `${shown.layout} ${shown.wrap}`, paths: rows.map(rowShape) };

      for (const row of rows) {
        const held = this.#held.get(row.path);

        if (held !== undefined) {
          mount.setRow(row.path, held.content);
        }

        if (this.#collapsed.has(row.path)) {
          mount.setCollapsed(row.path, true);
        }
      }

      mount.onWant(() => this.#pump());
      this.#scrollToJump();
      this.#pump();
    });
  }

  /**
   * Draws the file view over the diffs while one is open, or takes it away: the file's own header holds Back before its name and the line after
   * it, so nothing sits above it either.
   */
  #drawFile(view: HTMLElement): void {
    let overlay = view.querySelector<HTMLElement>(':scope > .file-overlay');
    const file = this.#file;

    if (file === null) {
      if (overlay !== null) {
        overlay.remove();
        this.#fileMount?.mount?.dispose();
        this.#fileMount = null;
      }

      return;
    }

    const id = `${file.side} ${file.path} ${file.line} ${file.entry.state === 'ok' ? file.entry.version : file.entry.state}`;

    if (overlay?.dataset['file'] !== id) {
      overlay?.remove();
      this.#fileMount?.mount?.dispose();
      overlay = document.createElement('div');
      overlay.className = 'file-overlay';
      overlay.dataset['file'] = id;

      const host = document.createElement('div');

      host.className = 'diff-host file-view';
      overlay.append(host);
      view.append(overlay);
      this.#mountFileInto(host, file);
    }
  }

  /** Mounts the file view on a host once the viewer loads, or says why there is no file to show, with the way back. */
  #mountFileInto(host: HTMLElement, file: FileOpen): void {
    const say = (text: string): void => {
      const line = document.createElement('p');

      line.className = 'empty';
      host.replaceChildren(line);
      mount(line, [<BackButton />, text]);
    };
    const note = fileNote(file.entry);
    const entry = file.entry;
    const kept = { host, mount: null as DiffMount | null };

    this.#fileMount = kept;

    if (note !== null || entry.state !== 'ok') {
      say(note ?? 'Reading the file…');
      return;
    }

    say('Loading the diff viewer…');
    this.#module ??= this.deps.loadDiff();
    void this.#module.then((module) => {
      if (this.#fileMount !== kept || !host.isConnected) {
        return;
      }

      if (module === null) {
        this.#module = null;
        say('The diff viewer could not be loaded. Reload the page to try again.');
        return;
      }

      const prefix = slot();
      const suffix = slot();

      mount(prefix, <BackButton />);
      mount(suffix, <span class="diff-at">:{file.line}{file.side === 'base' ? <span class="diff-from"> at the base</span> : null}</span>);
      host.replaceChildren();
      kept.mount = module.mountFile(host, entry.data, entry.version, { wrap: this.#shownLayout(host.closest<HTMLElement>('.diff-pane') ?? host).wrap, line: file.line, prefix, suffix });
    });
  }

  /** Ends the viewers whose host has left the page. */
  drop(): void {
    if (this.#mount !== null && !this.#mount.host.isConnected) {
      this.#mount.mount.dispose();
      this.#mount = null;
    }

    if (this.#fileMount !== null && !this.#fileMount.host.isConnected) {
      this.#fileMount.mount?.dispose();
      this.#fileMount = null;
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