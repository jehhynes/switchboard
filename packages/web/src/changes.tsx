// The Changes tab (PRD R118, architecture.md § Web page): the open conversation's worktree changes from its merge base to disk, as the VS Code
// window's Open changes shows them, every changed file's diff in one scrolling tab at the end of the tab strips, drawn by the diff viewer the page
// loads on first use, which reads only the files near the view, under a bar with the list's counts, its toggles, a Files menu to go to a file
// and a scope menu that picks what the list compares: every change since the base, the uncommitted changes, one commit, or two points.
import type { ComponentChildren, VNode } from 'preact';
import { DIFF_BUDGET, evictions, largeReason, MAX_IN_FLIGHT, rowKey, wantedIndexes } from './changesWindow.js';
import { FileIcon } from './fileIcons.js';
import { mount } from './island.js';
import { ago } from './render.js';
import type { ChangeRow, ChangesList, ChangeStage, ChangeStatus, CommitInfo, DiffData, FileData } from '@switchboard/protocol';
import type { ChangesMount, DiffModule, DiffMount, RowContent } from './diff/types.js';

export type { ChangeRow, ChangesList, ChangeStage, ChangeStatus, CommitInfo } from '@switchboard/protocol';

/** What the page keeps of the Changes tab: the list as last read, a read on its way or why one failed, whether its Files menu is open, and the tab. */
export interface ChangesView {
  list: ChangesList | null;
  loading: boolean;
  error: string | null;
  menu: boolean;
  /** The conversation the list was read for: the page key, scope generation and work item. */
  for: string | null;
  /** Whether the Changes tab was opened since the page came to the conversation: its list is read again when a turn ends. */
  tab: boolean;
  /** Whether the Changes tab leaves out the files ticked viewed. */
  hideViewed: boolean;
  /** What the list and the tab compare, every change since the base until the operator picks another; it lasts until the page leaves the conversation. */
  range: ChangeRange;
  /** Whether the scope menu is open, and its Compare pickers' choice while they show. */
  scopeMenu: boolean;
  compare: ChangeRange | null;
}

/**
 * What the list compares, as the change routes' `from` and `to` take it: from `base`, `HEAD` or a commit since the base, to `worktree` (disk),
 * `HEAD`, which follows new commits, or a commit since the base.
 */
export interface ChangeRange {
  from: string;
  to: string;
}

export const ALL_CHANGES: ChangeRange = { from: 'base', to: 'worktree' };
export const UNCOMMITTED: ChangeRange = { from: 'HEAD', to: 'worktree' };

export const newChanges = (): ChangesView => ({ list: null, loading: false, error: null, menu: false, for: null, tab: false, hideViewed: false, range: ALL_CHANGES, scopeMenu: false, compare: null });

const sameRange = (a: ChangeRange, b: ChangeRange): boolean => a.from === b.from && a.to === b.to;
const short = (sha: string): string => sha.slice(0, 7);

/** The commit a list's rows compare from, or HEAD by its ID: a new commit changes what a list from HEAD shows. */
function fromRef(list: ChangesList): string {
  return list.from === 'base' ? (list.base ?? `HEAD ${list.head}`) : list.from === 'HEAD' ? `HEAD ${list.head}` : list.from;
}

/** What a file's diff is read against, for the key a held diff is kept by: the range's start, and its end when that is a commit. */
export function listRef(list: ChangesList | null): string | null {
  return list === null ? null : list.to === 'worktree' ? fromRef(list) : `${fromRef(list)}..${list.to === 'HEAD' ? list.head : list.to}`;
}

/** The scope a list's viewed ticks are kept under in the hub: empty for a range to disk, else `<from>..<to>` by commit IDs. */
export function tickScope(list: ChangesList): string {
  return list.to === 'worktree' ? '' : `${list.from === 'base' ? (list.base ?? list.head) : list.from}..${list.to === 'HEAD' ? list.head : list.to}`;
}

/** Which of the scope menu's choices a range is: every change since the base, the uncommitted ones, one commit's own, or two points compared. */
export type ScopeKind = 'all' | 'uncommitted' | 'commit' | 'compare';

export function scopeKind(range: ChangeRange, commits: readonly CommitInfo[], base: string | null = null): ScopeKind {
  if (range.to === 'worktree') {
    return range.from === 'base' ? 'all' : range.from === 'HEAD' ? 'uncommitted' : 'compare';
  }

  const commit = commits.find((one) => one.sha === range.to);
  const from = range.from === 'base' ? base : range.from;

  return commit !== undefined && commit.parent !== null && commit.parent === from ? 'commit' : 'compare';
}

/** A point of a range by name: the base, the working tree, HEAD, or a commit by its short ID. */
export function pointLabel(point: string, base: string | null): string {
  return point === 'base' || point === base ? 'Base' : point === 'worktree' ? 'Working tree' : point === 'HEAD' ? 'HEAD' : short(point);
}

/** What the scope button says: the scope in a few words. */
export function scopeLabel(range: ChangeRange, commits: readonly CommitInfo[], base: string | null): string {
  const kind = scopeKind(range, commits, base);
  const commit = commits.find((one) => one.sha === range.to);

  return kind === 'all' ? 'All changes' : kind === 'uncommitted' ? 'Uncommitted' : kind === 'commit' ? `${short(commit!.sha)} ${commit!.subject}` : `${pointLabel(range.from, base)} → ${pointLabel(range.to, base)}`;
}

/** The scope in full, for the scope button's tooltip and the bar note's. */
export function scopeTitle(range: ChangeRange, commits: readonly CommitInfo[], base: string | null): string {
  const kind = scopeKind(range, commits, base);
  const commit = commits.find((one) => one.sha === range.to);

  return kind === 'all'
    ? base === null
      ? 'Uncommitted changes only, no merge base'
      : `All changes since the base, ${short(base)}`
    : kind === 'uncommitted'
      ? 'Uncommitted changes, against HEAD'
      : kind === 'commit'
        ? `Commit ${short(commit!.sha)}: ${commit!.subject}`
        : `From ${pointLabel(range.from, base)} to ${pointLabel(range.to, base)}`;
}

/** The range a list was read for. */
const rangeOf = (list: ChangesList): ChangeRange => ({ from: list.from, to: list.to });

/** Where the diff's sides go: side by side, one above the other, or by the pane's width (`auto`, stacked and wrapped under {@link SPLIT_MIN_WIDTH}). */
export type DiffLayout = 'auto' | 'split' | 'stacked';
/** Whether long lines wrap: always, never, or only while `auto` stacks the sides (`web.diffWrap`). */
export type DiffWrap = 'auto' | 'on' | 'off';
/** The narrowest pane a diff shows side by side in, as VS Code's diff editor switches to inline at 900 px. */
export const SPLIT_MIN_WIDTH = 900;
/** This device's Wrap choice on the Changes tab's bar, `on` or `off`; without one the diffs follow `web.diffWrap`. */
export const WRAP_KEY = 'switchboard.diffWrap';

/** The Wrap choice this device keeps, or null when it has none or no local storage. */
function storedWrap(): 'on' | 'off' | null {
  try {
    const kept = localStorage.getItem(WRAP_KEY);

    return kept === 'on' || kept === 'off' ? kept : null;
  } catch {
    return null;
  }
}

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

/**
 * The Changes tab, the strip's one Changes item, after its other tabs and any file tabs: how many files are viewed of all once the list was read.
 * Choosing it opens the diffs; it has no close mark, as the other fixed tabs have none. `push` when nothing comes between it and the tabs before.
 */
export function changesTab(changes: ChangesView, shown: boolean, push = true): VNode {
  const list = changes.list;
  const viewed = list === null ? 0 : totals(list).viewed;
  const kind = scopeKind(changes.range, list?.commits ?? [], list?.base ?? null);
  const files = kind === 'uncommitted' ? 'uncommitted files' : 'files';
  const title = kind === 'all' ? "Every changed file's diff since the base" : kind === 'uncommitted' ? "Every uncommitted file's diff" : `Every changed file's diff: ${scopeTitle(changes.range, list?.commits ?? [], list?.base ?? null)}`;

  return (
    <button class={`tab changes-tab${push ? ' push' : ''}${shown ? ' selected' : ''}`} type="button" role="tab" data-action="diff-tab" aria-selected={shown} tabindex={shown ? 0 : -1} title={title} aria-label={list === null ? 'Changes' : `Changes, ${viewed} of ${list.total} ${files} viewed`}>
      <span class="codicon codicon-diff-multiple" aria-hidden="true"></span>
      <span class="tab-label">Changes</span>
      {list === null ? null : <span class="tab-badge muted">{`${viewed}/${list.total}`}</span>}
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

/** What the Changes tab's bar says: how many files, uncommitted ones when the list has those alone, the lines added and deleted, how many are viewed, and a first cut when the worktree has more than the hub lists. */
export function listNote(list: ChangesList): string {
  const kind = scopeKind(rangeOf(list), list.commits, list.base) === 'uncommitted' ? ' uncommitted' : '';
  const files = list.total === 1 ? `1${kind} file` : `${list.total}${kind} files`;
  const { viewed, additions, deletions } = totals(list);
  const ticked = viewed === 0 ? '' : ` · ${viewed} viewed`;
  const lines = ` · +${additions} −${deletions}`;

  return list.shown < list.total ? `Showing ${list.shown} of ${files}${lines}${ticked}` : `${files}${lines}${ticked}`;
}

/** The bar note's tooltip: what the list compares. */
export function listBase(list: ChangesList): string {
  return scopeTitle(rangeOf(list), list.commits, list.base);
}

/** What the Files menu and the Changes tab say when the list has no rows. */
export function emptyNote(list: ChangesList): string {
  const kind = scopeKind(rangeOf(list), list.commits, list.base);

  return kind === 'uncommitted'
    ? 'No uncommitted changes.'
    : kind === 'commit'
      ? 'This commit changes no files.'
      : kind === 'compare'
        ? 'No changes between these points.'
        : list.base === null
          ? 'No uncommitted changes, and no merge base was found.'
          : 'No changes since the merge base.';
}

/** Wrap, pressed while long lines wrap: on the Changes tab's bar, and at the end of the file view's header, which covers the bar. */
function WrapButton({ wrapped, disabled, className }: { wrapped: boolean; disabled?: boolean; className: string }): VNode {
  const label = wrapped ? "Don't wrap long lines" : 'Wrap long lines';

  return (
    <button class={className} type="button" data-action="changes-wrap" title={label} aria-label={label} aria-pressed={wrapped} disabled={disabled}>
      <span class="codicon codicon-word-wrap" aria-hidden="true"></span>
    </button>
  );
}

/** A button of the Changes tab's bar: a codicon with its name as tooltip. */
function HeadButton({ action, icon, label, pressed, disabled }: { action: string; icon: string; label: string; pressed?: boolean; disabled?: boolean }): VNode {
  return (
    <button class="icon" type="button" data-action={action} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled}>
      <span class={`codicon codicon-${icon}`} aria-hidden="true"></span>
    </button>
  );
}

/** The Files menu's rows, or why there are none. */
function FilesMenu({ changes }: { changes: ChangesView }): VNode {
  const list = changes.list;
  let body: ComponentChildren;

  if (changes.error !== null) {
    body = <p class="changes-empty error">{changes.error}</p>;
  } else if (list === null) {
    body = <p class="changes-empty">Reading the changes…</p>;
  } else if (list.rows.length === 0) {
    body = <p class="changes-empty">{emptyNote(list)}</p>;
  } else {
    body = (
      <ul class="changes-rows" aria-label="Files">
        {list.rows.map((row) => (
          <Row row={row} />
        ))}
      </ul>
    );
  }

  return <div class="glass changes-menu">{body}</div>;
}

const SCOPE_ICONS: Record<ScopeKind, string> = { all: 'diff-multiple', uncommitted: 'diff-modified', commit: 'git-commit', compare: 'git-compare' };

/** A choice of the scope menu, ticked while it is the scope shown. */
function ScopeItem({ range, checked, title, children }: { range: ChangeRange; checked: boolean; title?: string; children: ComponentChildren }): VNode {
  return (
    <button class="scope-item" type="button" aria-pressed={checked} data-action="changes-scope-pick" data-from={range.from} data-to={range.to} title={title}>
      <span class={`codicon codicon-${checked ? 'check' : 'blank'}`} aria-hidden="true"></span>
      {children}
    </button>
  );
}

/**
 * Where a point stands in the branch's history, so a range's end must be newer than its start: the working tree, then each commit since the
 * base, newest first, then the base.
 */
export function pointOrder(point: string, commits: readonly CommitInfo[], base: string | null): number {
  const at = commits.findIndex((one) => one.sha === point);

  return point === 'worktree' ? -1 : point === 'HEAD' ? 0 : at !== -1 ? at : point === 'base' || point === base ? commits.length : Number.NaN;
}

/** Whether Compare can show a range: its end newer than its start. */
export function compareValid(range: ChangeRange, commits: readonly CommitInfo[], base: string | null): boolean {
  return pointOrder(range.to, commits, base) < pointOrder(range.from, commits, base);
}

/** The scope menu's Compare pickers: From the base or a commit, To HEAD, a commit or the working tree, each newer than From. */
function ComparePickers({ compare, commits, base }: { compare: ChangeRange; commits: readonly CommitInfo[]; base: string | null }): VNode {
  const option = (value: string, label: string, chosen: string, disabled = false) => (
    <option value={value} selected={value === chosen} disabled={disabled}>
      {label}
    </option>
  );
  const commitLabel = (commit: CommitInfo) => `${short(commit.sha)} ${commit.subject}`;
  const from = pointOrder(compare.from, commits, base);

  return (
    <div class="scope-compare">
      <label class="scope-field">
        <span>From</span>
        <select data-compare="from" aria-label="Compare from">
          {option('base', base === null ? 'Base' : `Base (${short(base)})`, compare.from)}
          {commits.map((commit) => option(commit.sha, commitLabel(commit), compare.from))}
        </select>
      </label>
      <label class="scope-field">
        <span>To</span>
        <select data-compare="to" aria-label="Compare to">
          {option('HEAD', 'HEAD, following new commits', compare.to, !(0 < from))}
          {commits.map((commit, index) => option(commit.sha, commitLabel(commit), compare.to, !(index < from)))}
          {option('worktree', 'Working tree', compare.to)}
        </select>
      </label>
      <button class="scope-go" type="button" data-action="changes-compare-go" disabled={!compareValid(compare, commits, base)}>
        Compare
      </button>
    </div>
  );
}

/** The scope menu: every change since the base, the uncommitted changes, each commit since the base newest first, and Compare. */
function ScopeMenu({ changes, now }: { changes: ChangesView; now: number }): VNode {
  const list = changes.list;
  const commits = list?.commits ?? [];
  const base = list?.base ?? null;
  const kind = scopeKind(changes.range, commits, base);

  return (
    <div class="glass changes-menu changes-scope-menu" role="group" aria-label="Changes to show">
      <ScopeItem range={ALL_CHANGES} checked={kind === 'all'}>
        <span class="scope-text">{base === null ? 'All changes (no merge base)' : 'All changes since the base'}</span>
      </ScopeItem>
      <ScopeItem range={UNCOMMITTED} checked={kind === 'uncommitted'}>
        <span class="scope-text">Uncommitted changes</span>
      </ScopeItem>
      {commits.length === 0 ? null : (
        <>
          <div class="scope-heading">
            Commits
          </div>
          <div class="scope-commits" role="group" aria-label="Commits">
            {commits.map((commit) => (
              <ScopeItem range={{ from: commit.parent ?? 'base', to: commit.sha }} checked={kind === 'commit' && changes.range.to === commit.sha} title={`${commit.sha}\n${commit.subject}`}>
                <code class="scope-sha">{short(commit.sha)}</code>
                <span class="scope-text">{commit.subject}</span>
                <span class="scope-time">{ago(commit.time * 1000, now)}</span>
              </ScopeItem>
            ))}
            {list?.commitsMore === true ? <p class="changes-empty">Only the latest {commits.length} commits are listed.</p> : null}
          </div>
          {changes.compare === null ? (
            <button class="scope-item" type="button" aria-pressed={kind === 'compare'} data-action="changes-compare">
              <span class={`codicon codicon-${kind === 'compare' ? 'check' : 'blank'}`} aria-hidden="true"></span>
              <span class="scope-text">{kind === 'compare' ? `Compare… ${scopeLabel(changes.range, commits, base)}` : 'Compare…'}</span>
            </button>
          ) : (
            <ComparePickers compare={changes.compare} commits={commits} base={base} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The Changes tab's bar, above the diffs: Files, which opens the list of files to go to one, the scope menu, the note, then Hide viewed,
 * Collapse all, Expand all, Wrap, pressed while long lines wrap, and Refresh. Open in VS Code is in the work item's Actions menu, not here.
 */
export function renderChangesBar(changes: ChangesView, wrapped: boolean, now = Date.now()): ComponentChildren {
  const list = changes.list;
  const empty = list === null || list.rows.length === 0;
  const commits = list?.commits ?? [];
  const base = list?.base ?? null;
  const title = scopeTitle(changes.range, commits, base);

  return [
    <button class={`changes-files${changes.menu ? ' open' : ''}`} type="button" data-action="changes-menu" aria-expanded={changes.menu} title="Go to a file" aria-label="Files">
      <span class="codicon codicon-list-flat" aria-hidden="true"></span>
      <span class="changes-files-label">Files</span>
      <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
    </button>,
    changes.menu ? <FilesMenu changes={changes} /> : null,
    <button class={`changes-scope${changes.scopeMenu ? ' open' : ''}`} type="button" data-action="changes-scope" aria-expanded={changes.scopeMenu} title={`Showing: ${title}`} aria-label={`Changes to show: ${title}`}>
      <span class={`codicon codicon-${SCOPE_ICONS[scopeKind(changes.range, commits, base)]}`} aria-hidden="true"></span>
      <span class="changes-scope-label">{scopeLabel(changes.range, commits, base)}</span>
      <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
    </button>,
    changes.scopeMenu ? <ScopeMenu changes={changes} now={now} /> : null,
    <span class={`changes-note${changes.error !== null && list !== null ? ' error' : ''}`} title={list === null ? undefined : listBase(list)}>
      {changes.error !== null && list !== null ? changes.error : list === null ? 'Changes' : listNote(list)}
    </span>,
    <HeadButton action="changes-hide-viewed" icon={changes.hideViewed ? 'eye-closed' : 'eye'} label={changes.hideViewed ? 'Show viewed files' : 'Hide viewed files'} pressed={changes.hideViewed} disabled={empty} />,
    <HeadButton action="changes-collapse-all" icon="collapse-all" label="Collapse all" disabled={empty} />,
    <HeadButton action="changes-expand-all" icon="expand-all" label="Expand all" disabled={empty} />,
    <WrapButton className="icon" wrapped={wrapped} disabled={empty} />,
    <button class="icon" type="button" data-action="changes-refresh" title="Refresh" aria-label="Refresh" disabled={changes.loading}>
      <span class={`codicon codicon-refresh${changes.loading ? ' codicon-modifier-spin' : ''}`} aria-hidden="true"></span>
    </button>,
  ];
}

export interface ChangesDeps {
  fetch: typeof fetch;
  /** The page key, null before the stream's hello. */
  key(): string | null;
  draw(): void;
  /** Shows the Changes tab, in the side column on a wide screen and in the conversation's strip on a narrower one. */
  showDiff(): void;
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

/** Where the file view's file is read, after its line: the range's start for the old side, its end commit for the new side; null on disk. */
export function fileAt(list: ChangesList | null, side: 'disk' | 'base'): string | null {
  if (list === null) {
    return null;
  }

  const point = side === 'base' ? list.from : list.to;

  return point === 'worktree' ? null : point === 'base' && list.base === null ? ' at HEAD' : point === 'base' || point === list.base ? ' at the base' : point === 'HEAD' ? ' at HEAD' : ` at ${short(point)}`;
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
      <input type="checkbox" data-action="diff-viewed" data-path={row.path} checked={row.viewed === true} aria-label={`Viewed ${row.path}`} />
      <span class="diff-viewed-label">Viewed</span>
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

/** The page's side of the Changes tab: reads the list and the diffs from the hub, and answers the clicks and presses on the tab, its bar and its Files menu. */
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
  /** The binary, generated and large files collapsed once, so one the operator expanded is not collapsed again. */
  readonly #largeSeen = new Set<string>();
  #file: FileOpen | null = null;
  /** The pane the Changes tab drew into, watched so Auto follows a pane resized past 900 px without a redraw. */
  #resize: ResizeObserver | null = null;
  readonly #watched = new WeakSet<HTMLElement>();
  /** The file view's viewer, and its header's end, which holds Wrap. */
  #fileMount: { host: HTMLElement; mount: DiffMount | null; meta: HTMLElement | null } | null = null;
  /** Each file's header element the viewer shows after its counts, by path, drawn again on every draw. */
  readonly #metas = new Map<string, HTMLElement>();
  /** Each file's header element the viewer shows before its name, by path, drawn again on every draw. */
  readonly #prefixes = new Map<string, HTMLElement>();
  /** This device's Wrap choice, which overrides `web.diffWrap` once the operator has toggled Wrap ({@link WRAP_KEY}). */
  #wrap = storedWrap();

  constructor(private readonly deps: ChangesDeps) {}

  /**
   * A diff or file read answered that the scope's commit is no longer on the branch: unless the page has moved on since the read began, the
   * list goes back to every change since the base, as a list read does. True when it did.
   */
  #staleBack(body: Record<string, unknown>, generation: number): boolean {
    if (body['stale'] !== true || generation !== this.#generation || sameRange(this.view.range, ALL_CHANGES)) {
      return false;
    }

    this.#setRange(ALL_CHANGES);
    return true;
  }

  /** The change routes' query for the scope: nothing for every change since the base. */
  #only(range: ChangeRange = this.view.range): string {
    return sameRange(range, ALL_CHANGES) ? '' : `&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  }

  /**
   * Shows another scope, until the page leaves the conversation: the diffs read for the other list are dropped and the list is read again;
   * which files are collapsed stays.
   */
  #setRange(range: ChangeRange): void {
    this.view.scopeMenu = false;
    this.view.compare = null;

    if (sameRange(range, this.view.range)) {
      this.deps.draw();
      return;
    }

    this.view.range = range;
    this.#reading++;
    this.#generation++;
    this.#held.clear();
    this.#inFlight.clear();
    this.#failed.clear();
    this.#hunk = null;
    this.#jump = null;
    this.#file = null;
    this.#collapseViewed = true;
    this.#unmount();
    this.view.list = null;
    this.view.error = null;
    void this.refresh();
  }

  /**
   * Follows the page's conversation: `id` names it (page key, scope generation, work item), so another one drops the list, its diffs and the
   * Changes tab; `turnEnded` reads the list again when the session's turn ends once the tab was opened.
   */
  follow(id: string | null, turnEnded: boolean): void {
    if (id !== this.view.for) {
      this.#focusPath = null;
      this.#reading++;
      this.#generation++;
      this.#held.clear();
      this.#inFlight.clear();
      this.#failed.clear();
      this.#collapsed.clear();
      this.#largeSeen.clear();
      this.#hunk = null;
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
    let stale = false;

    try {
      const response = await this.deps.fetch(`/v1/conversation/changes?window=${encodeURIComponent(key)}${this.#only()}`, { credentials: 'same-origin' });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (response.ok) {
        // An answer without a range, as from a hub older than the page, is every change since the base.
        const read = body as Partial<ChangesList>;

        list = { ...(body as unknown as ChangesList), from: read.from ?? 'base', to: read.to ?? 'worktree', commits: Array.isArray(read.commits) ? read.commits : [], commitsMore: read.commitsMore === true };
      } else {
        error = String(body['error'] ?? `Switchboard answered ${response.status}.`);
        stale = body['stale'] === true;
      }
    } catch (failure) {
      error = `Switchboard did not answer: ${String(failure)}`;
    }

    if (reading !== this.#reading) {
      return;
    }

    // The chosen commit is no longer on the branch, as after a rebase: the list falls back to every change since the base.
    if (stale && !sameRange(this.view.range, ALL_CHANGES)) {
      this.view.loading = false;
      this.#setRange(ALL_CHANGES);
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

    this.#collapseLarge();

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

  /** Collapses each binary, generated or large file the first time the list has it, so its diff is read only when it is expanded. */
  #collapseLarge(): void {
    for (const row of this.view.list?.rows ?? []) {
      if (!this.#largeSeen.has(row.path) && largeReason(row) !== null) {
        this.#largeSeen.add(row.path);
        this.#collapsed.add(row.path);
        this.#mount?.mount.setCollapsed(row.path, true);
      }
    }
  }

  /** Handles a click on the Changes tab, its bar, its Files menu or its diffs; false for any other click. */
  click(target: HTMLElement): boolean {
    const action = target.closest<HTMLElement>('[data-action]')?.dataset['action'];

    if (action === 'changes-menu') {
      this.view.menu = !this.view.menu;
      this.view.scopeMenu = false;
      this.deps.draw();
      return true;
    }

    if (action === 'changes-scope') {
      this.view.scopeMenu = !this.view.scopeMenu;
      this.view.compare = null;
      this.view.menu = false;
      this.deps.draw();
      return true;
    }

    if (action === 'changes-scope-pick') {
      const item = target.closest<HTMLElement>('[data-action]')!;

      const bar = target.closest<HTMLElement>('.changes-bar');

      this.#setRange({ from: item.dataset['from'] ?? 'base', to: item.dataset['to'] ?? 'worktree' });
      this.#focusScope(bar);
      return true;
    }

    if (action === 'changes-compare') {
      const list = this.view.list;
      const range = this.view.range;
      const kind = scopeKind(range, list?.commits ?? [], list?.base ?? null);
      const start = range.from === list?.base ? 'base' : range.from;

      // The pickers start at the scope shown when it is one commit's or a comparison, else at the base and the working tree.
      this.view.compare = (kind === 'commit' || kind === 'compare') && list !== null && compareValid({ from: start, to: range.to }, list.commits, list.base) ? { from: start, to: range.to } : { ...ALL_CHANGES };
      this.deps.draw();
      return true;
    }

    if (action === 'changes-compare-go') {
      const compare = this.view.compare;
      const list = this.view.list;

      if (compare !== null && list !== null && compareValid(compare, list.commits, list.base)) {
        // From HEAD to the working tree is the uncommitted changes, and from the base, every change since it.
        const bar = target.closest<HTMLElement>('.changes-bar');

        this.#setRange(compare.to === 'worktree' && compare.from === list.commits[0]?.sha ? UNCOMMITTED : compare.to === 'worktree' && compare.from === 'base' ? ALL_CHANGES : compare);
        this.#focusScope(bar);
      }

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

    if (action === 'changes-wrap') {
      // The opposite of what the pane shows now, kept on this device even where Settings cannot be changed, as on a paired phone.
      this.#wrap = this.#shownLayout(target.closest<HTMLElement>('.diff-pane')).wrap ? 'off' : 'on';

      try {
        localStorage.setItem(WRAP_KEY, this.#wrap);
      } catch {
        // A page without local storage keeps the choice until it reloads.
      }

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

  /** Shows the Changes tab, at a file's diff when `path` names one; its first showing in a conversation reads the list. */
  /** The file the operator last went to in the diff, from a row or a line, for the route (route.ts); null for none. */
  get focusPath(): string | null {
    return this.#focusPath;
  }

  #focusPath: string | null = null;

  openChanges(path: string | null): void {
    const opening = !this.view.tab;

    if (path !== null) {
      this.#focusPath = path;
    }

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
      const response = await this.deps.fetch(`/v1/conversation/diff?window=${encodeURIComponent(pageKey)}&path=${encodeURIComponent(row.path)}&sides=0${this.#only()}`, {
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
          if (this.#staleBack(body, generation)) {
            return;
          }

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
    if (now === undefined || rowKey(listRef(this.view.list), now) !== key) {
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
    const base = listRef(this.view.list);

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
      const response = await this.deps.fetch(`/v1/conversation/diff?window=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}${this.#only()}`, { credentials: 'same-origin' });

      if (!response.ok) {
        this.#staleBack((await response.json().catch(() => ({}))) as Record<string, unknown>, generation);
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

    this.#focusPath = path;
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
      const response = await this.deps.fetch(`/v1/conversation/file?window=${encodeURIComponent(key)}&path=${encodeURIComponent(open.path)}&side=${open.side}${this.#only()}`, { credentials: 'same-origin' });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (!response.ok && this.#staleBack(body, generation)) {
        return;
      }

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

    // The range the row was shown in, kept for every post, even after another scope is chosen meanwhile.
    const range = this.view.list === null ? this.view.range : rangeOf(this.view.list);

    try {
      for (let sent: boolean | null = null; row.viewed !== sent; ) {
        sent = row.viewed === true;

        const answer = await this.deps.command('viewed', { path, hash: row.hash, viewed: sent, from: range.from, to: range.to });

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
    const list = this.view.list;
    const row = data['workItemId'] === this.deps.workItemId() && list !== null && (data['scope'] ?? '') === tickScope(list) ? list.rows.find((one) => one.path === data['path'] && one.hash === data['hash']) : undefined;

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

    return diffLayout(settings.layout, this.#wrap ?? settings.wrap, pane?.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 0));
  }

  /** Gives the diffs and the file view shown in `pane` the layout its width calls for now, and its bar's Wrap the wrapping. */
  #relayout(pane: HTMLElement): void {
    const shown = this.#shownLayout(pane);
    const mounted = this.#mount;
    const bar = pane.querySelector<HTMLElement>(':scope > .diff-view > .changes-bar');

    if (bar !== null) {
      mount(bar, renderChangesBar(this.view, shown.wrap));
    }

    if (mounted !== null && pane.contains(mounted.host) && mounted.layout !== `${shown.layout} ${shown.wrap}`) {
      mounted.layout = `${shown.layout} ${shown.wrap}`;
      mounted.mount.set(shown.layout, shown.wrap);
    }

    if (this.#fileMount !== null && pane.contains(this.#fileMount.host)) {
      this.#fileMount.mount?.set('stacked', shown.wrap);

      if (this.#fileMount.meta !== null) {
        mount(this.#fileMount.meta, <WrapButton className="diff-wrap" wrapped={shown.wrap} />);
      }
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
   * Draws the Changes tab into a pane: its bar, then every row's diff in one view, mounted once per conversation and given the layout again when
   * the pane's width changes, and over both the file view while one is open.
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
      // Focusable, so a click in the diffs gives it the focus its keys need.
      view.tabIndex = 0;

      const bar = document.createElement('div');
      const host = document.createElement('div');

      bar.className = 'changes-bar';
      host.className = 'diff-host';
      view.append(bar, host);
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
        this.#say(host, emptyNote(list));
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

      // The list went or emptied while the module loaded, as when another scope was chosen: the next draw says why, or mounts once it is read.
      if (this.view.list === null || this.view.list.rows.length === 0) {
        this.deps.draw();
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
      // A viewer mounted again, as when the tab is chosen again, starts n and p from the line at the top.
      this.#hunk = null;

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
    const kept = { host, mount: null as DiffMount | null, meta: null as HTMLElement | null };

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
      const meta = slot();
      const wrap = this.#shownLayout(host.closest<HTMLElement>('.diff-pane') ?? host).wrap;

      kept.meta = meta;
      mount(prefix, <BackButton />);
      mount(meta, <WrapButton className="diff-wrap" wrapped={wrap} />);
      mount(suffix, <span class="diff-at">:{file.line}{fileAt(this.view.list, file.side) === null ? null : <span class="diff-from">{fileAt(this.view.list, file.side)}</span>}</span>);
      host.replaceChildren();
      kept.mount = module.mountFile(host, entry.data, entry.version, { wrap, line: file.line, prefix, suffix, meta });
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

  /** The hunk n and p last went to, so the next press goes on from it while its file is the one at the top. */
  #hunk: { path: string; index: number } | null = null;

  /**
   * The Changes tab's keys, while the focus is in it and not in a field: j and k the next and previous file, n and p the next and previous change,
   * v ticks or clears the file at the top viewed, x collapses or expands it, ] and [ the next and previous file not viewed, Escape leaves a file
   * view. True when the key was the tab's.
   */
  key(event: KeyboardEvent): boolean {
    const target = event.target instanceof Element ? event.target : null;

    if (event.ctrlKey || event.metaKey || event.altKey || target === null || target.closest('.diff-view') === null || target.closest('input, textarea, select, [contenteditable="true"], .changes-menu') !== null) {
      return false;
    }

    if (this.#file !== null) {
      if (event.key !== 'Escape') {
        return false;
      }

      this.#file = null;
      this.deps.draw();
      return true;
    }

    const mounted = this.#mount;

    if (mounted === null || !['j', 'k', 'n', 'p', 'v', 'x', '[', ']'].includes(event.key)) {
      return false;
    }

    const rows = this.#rows();
    const current = mounted.mount.current();
    const at = rows.findIndex((row) => row.path === current);

    if (at === -1) {
      return true;
    }

    const go = (path: string | undefined): void => {
      if (path !== undefined) {
        this.#hunk = null;
        mounted.mount.scrollToFile(path);
      }
    };

    if (event.key === 'j' || event.key === 'k') {
      go(rows[at + (event.key === 'j' ? 1 : -1)]?.path);
    } else if (event.key === ']' || event.key === '[') {
      const step = event.key === ']' ? 1 : -1;

      for (let index = at + step; index >= 0 && index < rows.length; index += step) {
        if (rows[index]!.viewed !== true) {
          go(rows[index]!.path);
          break;
        }
      }
    } else if (event.key === 'v') {
      void this.toggleViewed(current!);
    } else if (event.key === 'x') {
      this.#setCollapsed(current!, !this.#collapsed.has(current!));
    } else {
      this.#stepHunk(rows, at, event.key === 'n' ? 1 : -1);
    }

    return true;
  }

  /** Goes to the next or previous change from the last one gone to, or from the file at the top, across files; a file with no diff drawn yet is gone to whole. */
  #stepHunk(rows: ChangeRow[], at: number, step: 1 | -1): void {
    const mount = this.#mount!.mount;
    // The first press in a file goes on from the line at the top of the view, so it never jumps back past what the operator scrolled to.
    const here = rows[at]!.path;
    const shown = this.#collapsed.has(here) ? [] : mount.hunkStarts(here);
    const line = mount.topLine(here);
    const before = line === null ? -1 : shown.filter((one) => one.line < line).length - 1;
    const atLine = line !== null && shown[before + 1]?.line === line ? before + 1 : before;
    const from = this.#hunk !== null && this.#hunk.path === here ? this.#hunk : { path: here, index: line === null ? (step === 1 ? -1 : 0) : step === 1 ? atLine : before + 1 };
    let file = at;
    let index = from.index + step;

    while (file >= 0 && file < rows.length) {
      const path = rows[file]!.path;
      const starts = this.#collapsed.has(path) ? [] : mount.hunkStarts(path);

      if (file !== at && starts.length === 0) {
        this.#hunk = null;
        mount.scrollToFile(path);
        return;
      }

      if (index >= 0 && index < starts.length) {
        this.#hunk = { path, index };
        mount.scrollToLine(path, starts[index]!.line, starts[index]!.side);
        return;
      }

      file += step;
      index = step === 1 ? 0 : (file >= 0 && file < rows.length ? (this.#collapsed.has(rows[file]!.path) ? 0 : mount.hunkStarts(rows[file]!.path).length) - 1 : -1);
    }
  }

  /**
   * A Compare picker changed: the choice follows it, and a To no longer newer than From moves to the working tree. True when the field was one
   * of them.
   */
  input(target: EventTarget | null): boolean {
    const field = target instanceof HTMLSelectElement ? target : null;
    const which = field?.dataset['compare'];
    const compare = this.view.compare;

    if (field === null || (which !== 'from' && which !== 'to') || compare === null) {
      return false;
    }

    compare[which] = field.value;

    if (which === 'from' && !compareValid(compare, this.view.list?.commits ?? [], this.view.list?.base ?? null)) {
      compare.to = 'worktree';
    }

    this.deps.draw();
    return true;
  }

  /** Closes the Files menu or the scope menu on a press outside it and its button; true when one closed. */
  pointerDown(target: EventTarget | null): boolean {
    if ((!this.view.menu && !this.view.scopeMenu) || (target instanceof Element && target.closest('.changes-menu, .changes-files, .changes-scope') !== null)) {
      return false;
    }

    this.view.menu = false;
    this.view.scopeMenu = false;
    this.view.compare = null;
    return true;
  }

  /** The scope button keeps the focus once a choice of its menu, which goes with the menu, is taken. */
  #focusScope(bar: HTMLElement | null): void {
    bar?.querySelector<HTMLElement>('.changes-scope')?.focus();
  }

  /** Closes the Files menu or the scope menu on Escape: which one closed, so its button takes the focus back, or null. */
  escape(): 'files' | 'scope' | null {
    if (!this.view.menu && !this.view.scopeMenu) {
      return null;
    }

    const closed = this.view.scopeMenu ? 'scope' : 'files';

    this.view.menu = false;
    this.view.scopeMenu = false;
    this.view.compare = null;
    return closed;
  }
}