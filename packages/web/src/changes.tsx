// The Changes list (PRD R118, architecture.md § Web page): the open conversation's worktree changes from its merge base to disk, as the VS
// Code window's Open changes shows them, in a menu from the Changes button at the end of the tab strips.
import type { ComponentChildren, VNode } from 'preact';

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'U' | 'C';
export type ChangeStage = 'committed' | 'staged' | 'working' | 'untracked';

/** A row of the hub's `changes` answer. */
export interface ChangeRow {
  path: string;
  from?: string;
  status: ChangeStatus;
  stages: ChangeStage[];
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

/** The hub's `changes` answer. */
export interface ChangesList {
  scopeGen: number;
  base: string | null;
  head: string;
  rows: ChangeRow[];
  stages: Record<ChangeStage, number>;
  shown: number;
  total: number;
}

/** What the page keeps of the Changes list: the list as last read, a read on its way or why one failed, and whether its menu is open. */
export interface ChangesView {
  list: ChangesList | null;
  loading: boolean;
  error: string | null;
  menu: boolean;
  /** The conversation the list was read for: the page key, scope generation and work item. */
  for: string | null;
}

export const newChanges = (): ChangesView => ({ list: null, loading: false, error: null, menu: false, for: null });

const STATUS_TITLES: Record<ChangeStatus, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', U: 'Untracked', C: 'Conflict' };
const STAGE_TITLES: Record<ChangeStage, string> = { committed: 'committed', staged: 'staged', working: 'unstaged', untracked: 'untracked' };

/** A row's tooltip: its path, the path it was renamed from, its status and the stages that changed it. */
export function rowTitle(row: ChangeRow): string {
  const stages = row.stages.map((stage) => STAGE_TITLES[stage]);
  const said = stages.length === 0 ? '' : ` · ${stages.join(', ')}`;

  return `${row.from === undefined ? row.path : `${row.from} → ${row.path}`}\n${STATUS_TITLES[row.status]}${said}`;
}

/** The Changes button, after the strip's tabs, with the count once a list was read. */
export function changesButton(changes: ChangesView): VNode {
  const count = changes.list?.total;

  return (
    <button class={`tab changes-button${changes.menu ? ' open' : ''}`} type="button" data-action="changes-menu" aria-expanded={changes.menu} title="The worktree's changes since its base">
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
function Row({ row }: { row: ChangeRow }): VNode {
  const slash = row.path.lastIndexOf('/');
  const name = row.path.slice(slash + 1);
  const dir = slash === -1 ? '' : row.path.slice(0, slash);

  return (
    <li class={`change-row status-${row.status}`} data-path={row.path} title={rowTitle(row)}>
      <span class="codicon codicon-file" aria-hidden="true"></span>
      <span class={`change-name${row.status === 'D' ? ' deleted' : ''}`}>{name}</span>
      <span class="change-dir">{dir}</span>
      <Counts row={row} />
      <span class="change-status" aria-label={STATUS_TITLES[row.status]}>
        {row.status}
      </span>
    </li>
  );
}

/** What the menu says above its rows: since which base, how many files, and a first cut when the worktree has more than the hub lists. */
export function listNote(list: ChangesList): string {
  const since = list.base === null ? 'Uncommitted changes only, no merge base' : `Since ${list.base.slice(0, 7)}`;
  const files = list.total === 1 ? '1 file' : `${list.total} files`;

  return list.shown < list.total ? `${since} · first ${list.shown} of ${files}` : `${since} · ${files}`;
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
}

/** The page's side of the Changes list: reads it from the hub, and answers the clicks and presses that open, refresh and close its menu. */
export class ChangesController {
  readonly view: ChangesView = newChanges();
  #reading = 0;

  constructor(private readonly deps: ChangesDeps) {}

  /**
   * Follows the page's conversation: `id` names it (page key, scope generation, work item), so another one drops the list and closes the menu;
   * `turnEnded` reads an open menu's list again when the session's turn ends.
   */
  follow(id: string | null, turnEnded: boolean): void {
    if (id !== this.view.for) {
      this.#reading++;
      Object.assign(this.view, newChanges(), { for: id });
      return;
    }

    if (turnEnded && this.view.menu) {
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

    return target.closest('.changes-menu') !== null;
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
