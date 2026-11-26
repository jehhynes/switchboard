// The Changes tab (PRD R118, architecture.md § Web page): the open conversation's worktree changes from its merge base to disk,
// every changed file's diff in one scrolling tab at the end of the tab strips, drawn by the diff viewer the page
// loads on first use, which reads only the files near the view, under a bar with the list's counts, its toggles, a Files menu to go to a file
// and a scope menu that picks what the list compares: every change since the base, the uncommitted changes, one commit, or two points.
import type { ComponentChildren, VNode } from 'preact';
import { DIFF_BUDGET, evictions, largeReason, MAX_IN_FLIGHT, rowKey, wantedIndexes } from './changesWindow.js';
import { FileIcon } from './fileIcons.js';
import { mount } from './island.js';
import { ago } from './render.js';
import { readVersion } from './readVersion.js';
import { keepWrap, storedWrap } from './wrapPref.js';
import { CodeDraw, FileBody, sayIn } from './fileView.js';
import { worktreeMarkdown } from './changesMarkdown.js';
import { ChangesTreeView, newTree, PEEKS_KEPT } from './changesTree.js';
import type { TreeState } from './changesTree.js';
import type { LineRange } from './diff/types.js';
import type { ChangeRow, ChangesList, ChangeStage, ChangeStatus, CommitInfo, DiffData, FileData, SearchData, StackData, TreeData } from '@switchboard/protocol';
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
  /** Whether the bar's `⋯` menu is open. */
  more: boolean;
  /** Whether the diffs ignore whitespace (`ws=ignore`). */
  ignoreSpace: boolean;
  /** The picker of what to compare a commit or base with, open under the bar: the point chosen first and the picker's filter. */
  compare: { point: string; query: string } | null;
}

/** A point the Compare picker offers: a commit or a base, and whether it can be compared with the point chosen first. */
export interface ComparePoint {
  point: string;
  kind: 'commit' | 'branch';
  label: string;
  sub: string;
  valid: boolean;
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

export const newChanges = (): ChangesView => ({ list: null, loading: false, error: null, menu: false, for: null, tab: false, hideViewed: false, range: ALL_CHANGES, more: false, ignoreSpace: false, compare: null });

/** This device's diff layout, Auto, Split or Stacked, kept as Wrap is; Auto follows `web.diffLayout` and the pane's width. */
export const LAYOUT_KEY = 'switchboard.diffLayoutChoice';
/** Whether this device pins the Changes tree beside the diffs, and how wide it keeps it. */
export const TREE_PIN_KEY = 'switchboard.changesTreePinned';
export const TREE_WIDTH_KEY = 'switchboard.changesTreeWidth';
/** The narrowest tab the tree starts pinned in, and under which it is always a flyout. */
export const TREE_PIN_MIN_WIDTH = 1100;
export const TREE_FLYOUT_MAX_WIDTH = 720;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function keep(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Kept until the page reloads.
  }
}

/** The layout this device chose on the bar's `⋯` menu, or null to follow the settings. */
export function storedLayout(): 'split' | 'stacked' | null {
  const kept = stored(LAYOUT_KEY);

  return kept === 'split' || kept === 'stacked' ? kept : null;
}

/** Whether the tree is pinned in a tab `width` pixels wide: never under {@link TREE_FLYOUT_MAX_WIDTH}, else as this device chose, else from {@link TREE_PIN_MIN_WIDTH}. */
export function treePinned(width: number, choice: string | null, phone = false): boolean {
  if (phone || (width > 0 && width < TREE_FLYOUT_MAX_WIDTH)) {
    return false;
  }

  return choice === '1' ? true : choice === '0' ? false : width >= TREE_PIN_MIN_WIDTH;
}

/** The text a quote of lines puts in the composer: the path and lines, the side and the revision, and the lines in a fence. */
export function quoteText(path: string, start: number, end: number, side: 'old' | 'new' | null, revision: string | null, lines: string[]): string {
  const where = `${path}:${start}${end === start ? '' : `-${end}`}`;
  const said = [side === 'old' ? 'old side' : side === 'new' ? 'new side' : null, revision].filter((one) => one !== null).join(', ');
  const fence = lines.some((line) => line.includes('```')) ? '````' : '```';

  return `\`${where}\`${said === '' ? '' : ` (${said})`}:\n${fence}\n${lines.join('\n')}\n${fence}\n`;
}

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
      ? 'Uncommitted changes, against the last commit'
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
export { WRAP_KEY } from './wrapPref.js';

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
 * The Changes tab, the strip's one Changes item, first after Conversation (tabs.ts): how many files are viewed of all once the list
 * was read. Choosing it opens the diffs; it has no close mark, as the other fixed tabs have none.
 */
export function changesTab(changes: ChangesView, shown: boolean): VNode {
  const list = changes.list;
  const viewed = list === null ? 0 : totals(list).viewed;
  const kind = scopeKind(changes.range, list?.commits ?? [], list?.base ?? null);
  const files = kind === 'uncommitted' ? 'uncommitted files' : 'files';
  const title = kind === 'all' ? "Every changed file's diff since the base" : kind === 'uncommitted' ? "Every uncommitted file's diff" : `Every changed file's diff: ${scopeTitle(changes.range, list?.commits ?? [], list?.base ?? null)}`;

  return (
    <button class={`tab changes-tab${shown ? ' selected' : ''}`} type="button" role="tab" data-action="diff-tab" aria-selected={shown} tabindex={shown ? 0 : -1} title={title} aria-label={list === null ? 'Changes' : `Changes, ${viewed} of ${list.total} ${files} viewed`}>
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

/** What the Changes tab's bar says: how many files, uncommitted ones when the list has those alone, the lines added and deleted, and a first cut when the worktree has more than the hub lists; the tab's badge counts the viewed ones. */
export function listNote(list: ChangesList): string {
  const kind = scopeKind(rangeOf(list), list.commits, list.base) === 'uncommitted' ? ' uncommitted' : '';
  const files = list.total === 1 ? `1${kind} file` : `${list.total}${kind} files`;
  const { additions, deletions } = totals(list);
  const lines = ` · +${additions} −${deletions}`;

  return list.shown < list.total ? `Showing ${list.shown} of ${files}${lines}` : `${files}${lines}`;
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
      ? 'This commit changes no files. Choose another range in the tree.'
      : kind === 'compare'
        ? 'No changes between these points. Choose another range in the tree.'
        : list.base === null
          ? 'No uncommitted changes, and no merge base was found. Changes appear here when the session edits a file.'
          : 'No changes since the merge base. They appear here when the session edits a file.';
}

/** Wrap, pressed while long lines wrap: on the Changes tab's bar, and at the end of the file view's header, which covers the bar. */
function WrapButton({ wrapped, disabled, className }: { wrapped: boolean; disabled?: boolean; className: string }): VNode {
  const label = wrapped ? 'Do not wrap long lines' : 'Wrap long lines';

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

/** How the tree sits, for the bar: pinned beside the diffs, or a flyout open or closed; and the Compare picker's points while it is open. */
export interface BarTree {
  pinned: boolean;
  /** A file shows over the diffs, so the bar's back closes it before it changes the range. */
  fileOpen: boolean;
  /** The file shown: its icon and path after the way back, and its tools before Wrap. */
  file?: { head: ComponentChildren; tools: ComponentChildren } | null;
  flyout: boolean;
  compare: { label: string; points: ComparePoint[] } | null;
  layout: 'auto' | 'split' | 'stacked';
}

/** The Compare picker under the bar: every other commit and base of the branch, filtered as typed; choosing one shows the changes between them. */
function CompareMenu({ query, label, points }: { query: string; label: string; points: ComparePoint[] }): VNode {
  const needle = query.trim().toLowerCase();
  const shown = needle === '' ? points : points.filter((one) => `${one.label} ${one.sub}`.toLowerCase().includes(needle));

  return (
    <div class="glass changes-menu compare-menu" role="dialog" aria-label={`Compare ${label} with`}>
      <div class="compare-head">
        Compare <strong>{label}</strong> with
      </div>
      <input class="compare-filter" type="text" data-compare-filter value={query} placeholder="Filter commits and branches" aria-label="Filter commits and branches" spellcheck={false} />
      <div class="compare-list" role="listbox" aria-label="Commits and branches">
        {shown.length === 0 ? <p class="changes-empty">Nothing matches.</p> : null}
        {shown.map((one) => (
          <button type="button" class="scope-item" role="option" aria-selected={false} data-action="tree-compare-pick" data-point={one.point} disabled={!one.valid} title={one.valid ? undefined : 'Not on this branch’s line, so it cannot be compared'}>
            <span class={`codicon codicon-${one.kind === 'branch' ? 'git-branch' : 'git-commit'}`} aria-hidden="true"></span>
            <span class="scope-text">{one.label}</span>
            <span class="compare-sub">{one.sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The bar's `⋯` menu: the layout, Ignore whitespace, and on a phone the bar's toggles, which the bar has no room for there. */
function MoreMenu({ changes, wrapped, tree, empty }: { changes: ChangesView; wrapped: boolean; tree: BarTree; empty: boolean }): VNode {
  const layout = (value: 'auto' | 'split' | 'stacked', label: string) => (
    <button type="button" class="scope-item" data-action="changes-layout" data-layout={value} aria-pressed={tree.layout === value}>
      <span class={`codicon codicon-${tree.layout === value ? 'check' : 'blank'}`} aria-hidden="true"></span>
      <span class="scope-text">{label}</span>
    </button>
  );
  const item = (action: string, label: string, pressed?: boolean, disabled?: boolean) => (
    <button type="button" class="scope-item more-phone" data-action={action} aria-pressed={pressed} disabled={disabled}>
      <span class={`codicon codicon-${pressed === true ? 'check' : 'blank'}`} aria-hidden="true"></span>
      <span class="scope-text">{label}</span>
    </button>
  );

  return (
    <div class="glass changes-menu changes-more-menu" role="group" aria-label="More">
      <div class="scope-heading">Layout</div>
      {layout('auto', 'Auto')}
      {layout('split', 'Split')}
      {layout('stacked', 'Stacked')}
      <div class="scope-heading">Diffs</div>
      <button type="button" class="scope-item" data-action="changes-whitespace" aria-pressed={changes.ignoreSpace}>
        <span class={`codicon codicon-${changes.ignoreSpace ? 'check' : 'blank'}`} aria-hidden="true"></span>
        <span class="scope-text">Ignore whitespace</span>
      </button>
      {item('changes-hide-viewed', 'Hide viewed files', changes.hideViewed, empty)}
      {item('changes-collapse-all', 'Collapse all', undefined, empty)}
      {item('changes-expand-all', 'Expand all', undefined, empty)}
      {item('changes-wrap', 'Wrap long lines', wrapped, empty)}
      {item('changes-refresh', 'Refresh', undefined, changes.loading)}
    </div>
  );
}

/**
 * The Changes tab's bar, above the diffs: the tree's button while it is not pinned, Files, which opens the list of files to go to one, the scope
 * menu, the note, then Hide viewed, Collapse all, Expand all, Wrap, pressed while long lines wrap, Refresh, and `⋯`. Open in VS Code is in the
 * work item's Actions menu, not here.
 */
export function renderChangesBar(changes: ChangesView, wrapped: boolean, now = Date.now(), tree: BarTree = { pinned: true, fileOpen: false, flyout: false, compare: null, layout: 'auto' }): ComponentChildren {
  const list = changes.list;
  const empty = list === null || list.rows.length === 0;
  const commits = list?.commits ?? [];
  const base = list?.base ?? null;
  const title = scopeTitle(changes.range, commits, base);
  const treeButton = tree.pinned ? null : (
    <button class={`changes-tree-button${tree.flyout ? ' open' : ''}`} type="button" data-action="tree-flyout" aria-expanded={tree.flyout} title="Files and commits (Ctrl+B pins them)" aria-label="Files and commits">
      {/* VS Code's sidebar toggle, so it reads as showing a panel rather than as another list beside Files. */}
      <span class={`codicon codicon-layout-sidebar-left${tree.flyout ? '' : '-off'}`} aria-hidden="true"></span>
    </button>
  );

  // A file shown over the diffs keeps only what applies to it: the tree's button, the way back, the file's icon and path, its tools, and Wrap.
  // The diffs' controls return with the diffs.
  if (tree.fileOpen) {
    return [
      treeButton,
      <button class="changes-back" type="button" data-action="changes-back" title="Back to the diffs (Escape)" aria-label="Back to the diffs">
        <span class="codicon codicon-arrow-left" aria-hidden="true"></span>
      </button>,
      tree.file?.head ?? <span class="changes-spacer"></span>,
      tree.file?.tools ?? null,
      <WrapButton className="icon changes-file-wrap" wrapped={wrapped} disabled={false} />,
    ];
  }

  return [
    // The tree's button first, then the way back from a range other than every change since the base, where a file's way back is too.
    treeButton,
    !sameRange(changes.range, ALL_CHANGES) ? (
      <button class="changes-back" type="button" data-action="changes-back" title="Back to every change since the base" aria-label="Back to every change since the base">
        <span class="codicon codicon-arrow-left" aria-hidden="true"></span>
      </button>
    ) : null,
    <button class={`changes-files${changes.menu ? ' open' : ''}`} type="button" data-action="changes-menu" aria-expanded={changes.menu} title="Go to a file" aria-label="Files">
      <span class="changes-files-label">Files</span>
      <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
    </button>,
    changes.menu ? <FilesMenu changes={changes} /> : null,
    changes.compare !== null && tree.compare !== null ? <CompareMenu query={changes.compare.query} label={tree.compare.label} points={tree.compare.points} /> : null,
    // What the diffs compare, which the tree chooses.
    <span class="changes-scope" title={`Comparing: ${title}`}>
      <span class={`codicon codicon-${SCOPE_ICONS[scopeKind(changes.range, commits, base)]}`} aria-hidden="true"></span>
      <span class="changes-scope-label">{scopeLabel(changes.range, commits, base)}</span>
    </span>,
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
    <button class={`icon changes-more${changes.more ? ' open' : ''}`} type="button" data-action="changes-more" title="More" aria-label="More" aria-expanded={changes.more}>
      <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
    </button>,
    changes.more ? <MoreMenu changes={changes} wrapped={wrapped} tree={tree} empty={empty} /> : null,
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
  /** Whether the Changes tab is in view: shown in its strip, on a page the operator can see; a file view on disk is read again only then. */
  inView?(): boolean;
  /** Draws the Mermaid diagrams in an element, after a Markdown file's preview is drawn. */
  drawDiagrams?(element: HTMLElement): void;
  /** Puts a quote of lines at the end of the message being written, for the conversation the page shows. */
  quote?(text: string): void;
}

/**
 * The Changes tab's file view: a file at a line, opened from a line number of its diff, or from the tree, a search result or a Markdown link,
 * which show the file on disk whatever range is chosen. What it shows is named exactly: the path read, the change row it belongs to, the
 * side and the range it was read in.
 */
export interface FileOpen {
  /** The path read and shown: a renamed file's old path on its old side. */
  path: string;
  /** The change row of the shown list this file's revision is a side of, when it is one; Diff | File offers that row's diff. */
  rowPath: string | null;
  side: 'disk' | 'base';
  /** The range the file was read in: the shown list's for a file opened from its diff, the uncommitted range for one opened on disk. */
  range: ChangeRange;
  line: number | null;
  entry: { state: 'loading' } | { state: 'ok'; data: FileData; version: string; etag: string | null } | { state: 'error'; error: string; refused: boolean };
  /** A Markdown file shows its source rather than its preview: opened at a line, from a diff or a search result. */
  source: boolean;
}

/** How the file view draws a file: code and text, Markdown, a picture or a PDF. */
export function fileKind(data: FileData): 'code' | 'markdown' | 'image' | 'pdf' {
  return data.media === 'application/pdf' ? 'pdf' : typeof data.media === 'string' && data.media.startsWith('image/') && data.contents === null ? 'image' : /\.(md|markdown)$/i.test(data.path) && data.contents !== null ? 'markdown' : 'code';
}

/** Whether a file view shows the file on disk, which can change while it shows and is read again; a commit's or the base's cannot. */
export const onDisk = (open: FileOpen): boolean => open.side === 'disk' && open.range.to === 'worktree';

export { LINK_REFUSED, worktreeTarget } from './changesMarkdown.js';

/** Where the file view's file is read, after its line: the range's start for the old side, its end commit for the new side; null on disk. */
export function fileAt(list: ChangesList | null, side: 'disk' | 'base'): string | null {
  if (list === null) {
    return null;
  }

  const point = side === 'base' ? list.from : list.to;

  return point === 'worktree' ? null : point === 'base' && list.base === null ? ' at HEAD' : point === 'base' || point === list.base ? ' at the base' : point === 'HEAD' ? ' at HEAD' : ` at ${short(point)}`;
}

/** What the file view says in place of the file: a read on its way, why it failed, a binary file or one too large; a picture or PDF shows. */
export function fileNote(entry: FileOpen['entry']): string | null {
  if (entry.state === 'loading') {
    return 'Reading the file…';
  }

  if (entry.state === 'error') {
    return entry.error;
  }

  const kind = fileKind(entry.data);

  if (kind === 'image' || kind === 'pdf') {
    return null;
  }

  return entry.data.binary ? 'Binary file not shown.' : entry.data.tooLarge ? 'This file is too large to show here. Open it in VS Code.' : null;
}

/** A point of a range as a quote names it: on disk, the base, HEAD or a commit, by short ID. */
export function pointName(point: string, list: ChangesList | null): string {
  return point === 'worktree' ? 'on disk' : point === 'base' ? (list?.base == null ? 'HEAD' : `base ${short(list.base)}`) : point === 'HEAD' ? `HEAD ${short(list?.head ?? '')}` : short(point);
}

/** The lines `start` to `end` of a diff's side: from the whole side when it was read, else from the patch's lines on that side. */
export function patchLines(data: DiffData, side: 'old' | 'new', start: number, end: number): string[] {
  const whole = side === 'old' ? data.old : data.new;

  if (whole !== null) {
    return whole.split('\n').slice(start - 1, end);
  }

  const lines: string[] = [];
  let line = 0;

  for (const text of (data.patch ?? '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);

    if (hunk !== null) {
      line = Number(side === 'old' ? hunk[1] : hunk[2]);
      continue;
    }

    if (line === 0 || text.startsWith('\\')) {
      continue;
    }

    const mark = text[0];

    if (mark === ' ' || (side === 'old' ? mark === '-' : mark === '+')) {
      if (line >= start && line <= end) {
        lines.push(text.slice(1));
      }

      line++;
    }
  }

  return lines;
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

  if (entry.data.same === true) {
    return 'No differences ignoring whitespace. Turn off Ignore whitespace in ⋯ to see them.';
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


/** A Markdown file's switch between its preview and its source. */
function SourceButton({ source }: { source: boolean }): VNode {
  const label = source ? 'Show the preview' : 'Show the source';

  return (
    <button class="diff-wrap file-source" type="button" data-action="file-source" title={label} aria-label={label} aria-pressed={source}>
      <span class={`codicon codicon-${source ? 'open-preview' : 'code'}`} aria-hidden="true"></span>
    </button>
  );
}

/** Diff | File, in a file view whose file is a side of a change row the list shows: Diff goes to that row's diff. */
function FileToggle(): VNode {
  return (
    <span class="file-toggle" role="group" aria-label="Show">
      <button type="button" data-action="file-diff" aria-pressed="false" title="Show this file's diff">
        Diff
      </button>
      <button type="button" aria-pressed="true" disabled>
        File
      </button>
    </span>
  );
}

/** Quote, while lines are selected: puts them in the message being written, with the file, lines, side and revision. */
function QuoteButton(): VNode {
  return (
    <button class="diff-wrap diff-quote" type="button" data-action="diff-quote" title="Quote the selected lines in the message" aria-label="Quote the selected lines in the message">
      <span class="codicon codicon-quote" aria-hidden="true"></span>
    </button>
  );
}

/** What a file's own header carries after its counts: Quote while lines of it are selected, then its Viewed tick. */
function DiffTools({ row, quote = false }: { row: ChangeRow | undefined; quote?: boolean }): VNode | null {
  return row === undefined ? null : (
    <>
      {quote ? <QuoteButton /> : null}
      <label class="diff-viewed" title={row.viewed === true ? 'Viewed; untick to read it again' : 'Mark viewed'}>
        <input type="checkbox" data-action="diff-viewed" data-path={row.path} checked={row.viewed === true} aria-label={`Viewed ${row.path}`} />
        <span class="diff-viewed-label">Viewed</span>
      </label>
    </>
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
  /** The file view's code, drawn by the diff viewer's file mode. */
  readonly #code: CodeDraw;
  /** Whether the file view's file is being read, and whether a newer read was asked for meanwhile, whose answer replaces that read's. */
  #fileReading: FileOpen | null = null;
  #fileNewer = false;
  /** Each file's header element the viewer shows after its counts, by path, drawn again on every draw. */
  readonly #metas = new Map<string, HTMLElement>();
  /** Each file's header element the viewer shows before its name, by path, drawn again on every draw. */
  readonly #prefixes = new Map<string, HTMLElement>();

  /** The tree beside the diffs: the stack, the worktree's files, the uncommitted changes, commits read open, search and its choices. */
  readonly tree: TreeState = newTree();
  /** Bumped when the page leaves the conversation, so a tree read for the one it left is dropped. */
  #treeGen = 0;
  /** Bumped by each tree read, so an older read answering after a newer one is dropped. */
  #treeReads = 0;
  #stackRetry: ReturnType<typeof setTimeout> | null = null;
  #searchGen = 0;
  #searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the tree's flyout is open while it is not pinned. */
  #flyout = false;
  /** Whether the next bar drawn focuses its tree button, after the tree that had the focus closed. */
  #focusTreeButton = false;
  /** Whether the next bar drawn focuses the Compare picker's filter, just opened. */
  #focusCompare = false;
  /** The width the Changes tab was last drawn at, which decides whether the tree may pin. */
  #width = 0;
  /** Lines selected in the file view or in one file's diff, which Quote puts in the message. */
  #selection: { path: string; range: LineRange; in: 'file' | 'diff' } | null = null;

  constructor(private readonly deps: ChangesDeps) {
    this.#code = new CodeDraw({ loadDiff: () => this.#loadModule() });
  }

  /** Whether the tree is pinned beside the diffs now. */
  get pinned(): boolean {
    return treePinned(this.#width, stored(TREE_PIN_KEY), this.#phone());
  }

  /** Whether the page has the phone's layout, where the tree is never pinned, even on a phone in landscape wider than the flyout's limit. */
  #phone(): boolean {
    return typeof document !== 'undefined' && document.documentElement.classList.contains('phone');
  }

  /**
   * The bar's part for the file shown: its icon and path with the line and revision after it, then Quote while lines are selected, Diff | File
   * for a side of a listed change row, and a Markdown file's Source; null with no file shown.
   */
  #fileBar(): { head: ComponentChildren; tools: ComponentChildren } | null {
    const file = this.#file;

    if (file === null) {
      return null;
    }

    const entry = file.entry;
    const kind = entry.state === 'ok' && fileNote(entry) === null ? fileKind(entry.data) : null;
    const at = file.range.to === 'worktree' && file.side === 'disk' ? null : fileAt(this.view.list === null ? null : { ...this.view.list, from: file.range.from, to: file.range.to }, file.side);
    const head = (
      <span class="changes-file-head" title={file.path}>
        <FileIcon path={file.path} />
        <span class="changes-file-title">
          <bdi dir="ltr">{file.path}</bdi>
          <span class="diff-at">
            {file.line === null ? null : `:${file.line}`}
            {at === null ? null : <span class="diff-from">{at}</span>}
          </span>
        </span>
      </span>
    );
    const quote = kind === 'code' || (kind === 'markdown' && file.source) ? this.#selection?.in === 'file' : false;

    return {
      head,
      tools: (
        <>
          {quote ? <QuoteButton /> : null}
          {file.rowPath === null ? null : <FileToggle />}
          {kind === 'markdown' ? <SourceButton source={file.source} /> : null}
        </>
      ),
    };
  }

  /** How the bar shows the tree. */
  #barTree(): BarTree {
    const layout = storedLayout();

    return { pinned: this.pinned, fileOpen: this.#file !== null, file: this.#fileBar(), flyout: this.#flyout, compare: this.view.compare === null ? null : this.#comparePoints(this.view.compare.point), layout: layout ?? 'auto' };
  }

  /**
   * What the Compare picker offers for `point`: this branch's commits, then each base by name followed by its commits, then the default branch,
   * leaving out `point` itself; a point that is no commit or base of the branch's line cannot be compared.
   */
  #comparePoints(point: string): { label: string; points: ComparePoint[] } {
    const stack = this.tree.stack;
    const list = this.view.list;
    const commits = this.#treeCommits();
    const base = list?.base ?? null;
    const infos = new Map<string, CommitInfo>([...(list?.commits ?? []), ...(stack?.infos ?? [])].map((one) => [one.sha, one]));
    const all: ComparePoint[] = [];
    const seen = new Set<string>();
    const now = Date.now();
    const add = (one: Omit<ComparePoint, 'valid'>) => {
      if (seen.has(one.point)) {
        return;
      }

      seen.add(one.point);
      all.push({ ...one, valid: compareValid({ from: one.point, to: point }, commits, base) || compareValid({ from: point, to: one.point }, commits, base) });
    };
    const commit = (sha: string) => {
      const info = infos.get(sha);

      add({ point: sha, kind: 'commit', label: info?.subject ?? short(sha), sub: info === undefined ? short(sha) : `${short(sha)} · ${ago(info.time * 1000, now)}` });
    };

    (stack?.commitIds ?? list?.commits.map((one) => one.sha) ?? []).forEach(commit);

    for (const link of stack?.links ?? []) {
      if (link.relation !== 'below') {
        continue;
      }

      if (link.forkPoint !== null) {
        add({ point: link.forkPoint, kind: 'branch', label: link.name, sub: short(link.forkPoint) });
      }

      link.commitIds.forEach(commit);
    }

    const main = stack?.main.ref;

    add({ point: 'base', kind: 'branch', label: main == null ? 'Default branch' : main.slice(main.indexOf('/') + 1), sub: 'default branch' });

    const chosen = all.find((one) => one.point === point);

    return { label: chosen?.label ?? short(point), points: all.filter((one) => one.point !== point) };
  }

  /** The diffs' ignore-whitespace query, part of every diff read and of the key a held diff is kept by. */
  #ws(): string {
    return this.view.ignoreSpace ? '&ws=ignore' : '';
  }

  /** What a held diff was read against: the list's range, and whether whitespace was ignored. */
  #ref(): string | null {
    const ref = listRef(this.view.list);

    return ref === null ? null : `${ref}${this.view.ignoreSpace ? ' ws' : ''}`;
  }

  /**
   * Reads the tree's answers: the stack, the worktree's files and the uncommitted changes, each kept apart from the list the diffs show, so
   * choosing a commit changes only that list. `force`, from Refresh, reads the stack past its caches. A stack whose GitHub phase had not ended
   * is read once more after the deadline.
   */
  async #readTree(force = false, retry = false): Promise<void> {
    const key = this.deps.key();
    const gen = this.#treeGen;
    // A retry of the stack alone does not make an earlier full read stale.
    const order = retry ? this.#treeReads : ++this.#treeReads;

    if (key === null) {
      return;
    }

    const read = async <T,>(url: string): Promise<{ body: T } | { error: string }> => {
      try {
        const response = await this.deps.fetch(url, { credentials: 'same-origin' });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

        return response.ok ? { body: body as T } : { error: String(body['error'] ?? `Switchboard could not load this (status ${response.status}). Try again.`) };
      } catch (failure) {
        return { error: `Switchboard did not answer: ${String(failure)}` };
      }
    };
    const window = encodeURIComponent(key);
    const uncommittedShown = this.view.list !== null && sameRange(rangeOf(this.view.list), UNCOMMITTED);
    const [stack, tree, uncommitted] = await Promise.all([
      read<StackData>(`/v1/conversation/stack?window=${window}${force ? '&refresh=1' : ''}`),
      retry ? null : read<TreeData>(`/v1/conversation/tree?window=${window}`),
      retry || uncommittedShown ? null : read<ChangesList>(`/v1/conversation/changes?window=${window}&from=HEAD&to=worktree`),
    ]);

    if (gen !== this.#treeGen || order !== this.#treeReads) {
      return;
    }

    // An answer without the fields the tree draws from, as from a hub older than the page, is no answer.
    if ('body' in stack && Array.isArray(stack.body.links) && Array.isArray(stack.body.commitIds)) {
      this.tree.stack = stack.body;
      this.tree.stackError = null;

      if (stack.body.github.state === 'pending' && !retry) {
        this.#stackRetry = setTimeout(() => {
          this.#stackRetry = null;
          void this.#readTree(false, true);
        }, 3_500);
      }
    } else if ('error' in stack) {
      this.tree.stackError = stack.error;
    }

    if (tree !== null && 'body' in tree && Array.isArray(tree.body.paths)) {
      this.tree.tree = tree.body;
    }

    if (uncommitted !== null && 'body' in uncommitted && Array.isArray(uncommitted.body.rows)) {
      this.tree.uncommitted = uncommitted.body;
    } else if (uncommittedShown) {
      this.tree.uncommitted = this.view.list;
    }

    this.deps.draw();
  }

  /** Reads an expanded commit's own changes, for its files in the tree, without making them the list the diffs show. */
  async #peek(sha: string, parent: string): Promise<void> {
    const key = this.deps.key();
    const gen = this.#treeGen;

    if (key === null) {
      return;
    }

    this.tree.peeks.delete(sha);
    this.tree.peeks.set(sha, 'loading');

    while (this.tree.peeks.size > PEEKS_KEPT) {
      this.tree.peeks.delete(this.tree.peeks.keys().next().value!);
    }

    let answer: ChangesList | { error: string };

    try {
      const response = await this.deps.fetch(`/v1/conversation/changes?window=${encodeURIComponent(key)}&from=${encodeURIComponent(parent)}&to=${encodeURIComponent(sha)}`, { credentials: 'same-origin' });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      answer = response.ok ? (body as unknown as ChangesList) : { error: String(body['error'] ?? `Switchboard could not load this (status ${response.status}). Try again.`) };
    } catch (failure) {
      answer = { error: `Switchboard did not answer: ${String(failure)}` };
    }

    if (gen === this.#treeGen && this.tree.peeks.has(sha)) {
      this.tree.peeks.set(sha, answer);
      this.deps.draw();
    }
  }

  /** Runs the search route for the box's text, dropping an answer for an older search. */
  async #search(): Promise<void> {
    const key = this.deps.key();
    const query = this.tree.query.trim();
    const gen = ++this.#searchGen;

    if (key === null || query === '' || !this.tree.text) {
      this.tree.search = null;
      this.deps.draw();
      return;
    }

    this.tree.search = 'running';
    this.tree.searchError = null;
    this.deps.draw();

    const flag = (on: boolean) => (on ? '1' : '0');

    try {
      const response = await this.deps.fetch(`/v1/conversation/search?window=${encodeURIComponent(key)}&gen=${gen}&q=${encodeURIComponent(query)}&case=${flag(this.tree.matchCase)}&word=${flag(this.tree.word)}&regex=${flag(this.tree.regex)}`, { credentials: 'same-origin' });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (gen !== this.#searchGen) {
        return;
      }

      if (response.ok) {
        this.tree.search = body as unknown as SearchData;
      } else if (response.status !== 409) {
        this.tree.search = null;
        this.tree.searchError = String(body['error'] ?? `Switchboard could not load this (status ${response.status}). Try again.`);
      }
    } catch (failure) {
      if (gen === this.#searchGen) {
        this.tree.searchError = `Switchboard did not answer: ${String(failure)}`;
      }
    }

    this.deps.draw();
  }

  /** Ticks an uncommitted file viewed from the tree, or clears its tick: the tick is the one the list to disk shows, so both follow it. */
  async #tickUncommitted(path: string): Promise<void> {
    const row = this.tree.uncommitted?.rows.find((one) => one.path === path);

    if (row === undefined) {
      return;
    }

    // A file the diffs show at this content is ticked as its diff's tick is, collapsing it and taking back a refusal there too.
    if (this.view.list !== null && this.view.list.to === 'worktree' && this.view.list.rows.some((one) => one.path === path && one.hash === row.hash)) {
      await this.toggleViewed(path, { from: 'HEAD', to: 'worktree' });
      return;
    }

    row.viewed = row.viewed !== true;
    this.#viewedChanged();

    // One post at a time per file, as for a diff's tick.
    if (this.#ticking.has(row)) {
      return;
    }

    this.#ticking.add(row);

    try {
      for (let sent: boolean | null = null; row.viewed !== sent; ) {
        sent = row.viewed === true;

        const answer = await this.deps.command('viewed', { path, hash: row.hash, viewed: sent, from: 'HEAD', to: 'worktree' });

        if (answer.status !== 200) {
          row.viewed = !sent;
          this.view.error = String(answer.body['error'] ?? `Switchboard could not load this (status ${answer.status}). Try again.`);
          void this.#readTree();
          this.#viewedChanged();
          return;
        }
      }
    } finally {
      this.#ticking.delete(row);
    }
  }

  /** Handles a click in the tree, or on the bar's tree button; false for any other. */
  #treeClick(target: HTMLElement, action: string | undefined): boolean {
    const button = target.closest<HTMLElement>('[data-action]');
    const data = button?.dataset ?? {};
    const closeFlyout = () => {
      if (!this.pinned) {
        this.#flyout = false;
      }
    };

    switch (action) {
      case 'tree-toggle': {
        const key = data['key'] ?? '';
        const open = key === 'files' || key === 'commits' || key === 'branch' ? !this.tree.closed.has(key) : this.tree.open.has(key);

        if (key === 'files' || key === 'commits' || key === 'branch') {
          open ? this.tree.closed.add(key) : this.tree.closed.delete(key);
        } else {
          open ? this.tree.open.delete(key) : this.tree.open.add(key);
        }

        const sha = data['sha'];

        if (!open && sha !== undefined && !this.tree.peeks.has(sha)) {
          const parent = this.#treeCommits().find((one) => one.sha === sha)?.parent ?? 'base';

          void this.#peek(sha, parent);
        }

        this.deps.draw();
        return true;
      }
      case 'tree-range': {
        const range = { from: data['from'] ?? 'base', to: data['to'] ?? 'worktree' };

        this.tree.menu = null;
        closeFlyout();
        this.#setRange(sameRange(range, UNCOMMITTED) ? UNCOMMITTED : sameRange(range, ALL_CHANGES) ? ALL_CHANGES : range);
        this.openChanges(null);
        return true;
      }
      case 'tree-file-diff':
      case 'tree-file-change': {
        const path = data['path'] ?? '';

        closeFlyout();
        this.#setRange(action === 'tree-file-change' ? UNCOMMITTED : { from: data['from'] ?? 'base', to: data['to'] ?? 'worktree' });
        this.openChanges(path);
        return true;
      }
      case 'tree-disk': {
        const line = Number(data['line']);

        closeFlyout();
        this.openDiskFile(data['path'] ?? '', Number.isInteger(line) && line > 0 ? line : null);
        return true;
      }
      case 'tree-files':
        this.tree.files = data['mode'] === 'all' ? 'all' : 'changed';
        this.deps.draw();
        return true;
      case 'tree-viewed':
        void this.#tickUncommitted(data['path'] ?? '');
        return true;
      case 'tree-option': {
        const option = data['option'];

        if (option === 'text' || option === 'matchCase' || option === 'word' || option === 'regex') {
          this.tree[option] = !this.tree[option];
        }

        void this.#search();
        return true;
      }
      case 'tree-options':
        this.tree.options = !this.tree.options;
        this.deps.draw();
        return true;
      case 'tree-pin':
        this.togglePin();
        return true;
      case 'tree-flyout':
        this.#flyout = !this.#flyout;
        this.tree.options = false;
        this.deps.draw();
        return true;
      case 'tree-menu': {
        const point = data['point'] ?? null;

        this.tree.menu = this.tree.menu === point ? null : point;
        this.deps.draw();
        return true;
      }
      case 'tree-compare':
        // The picker opens under the bar, over the diffs, so the tree's flyout steps aside for it.
        this.tree.menu = null;
        this.view.menu = false;
        this.view.more = false;
        this.view.compare = data['point'] === undefined ? null : { point: data['point'], query: '' };
        // A file shown over the diffs gives way, since the picker and what it chooses are the diffs'.
        this.#file = null;
        this.#selection = null;
        this.#focusCompare = this.view.compare !== null;
        closeFlyout();
        this.deps.draw();
        return true;
      case 'tree-compare-pick': {
        const from = this.view.compare?.point ?? null;
        const to = data['point'] ?? null;
        const list = this.view.list;

        this.view.compare = null;

        if (from !== null && to !== null && list !== null) {
          // Whichever was picked first, the older point is the start.
          const forward = { from, to };
          const commits = this.#treeCommits();
          const range = compareValid(forward, commits, list.base) ? forward : { from: to, to: from };

          if (compareValid(range, commits, list.base)) {
            closeFlyout();
            this.#setRange(range);
            this.openChanges(null);
            return true;
          }

          this.view.error = 'These two points cannot be compared: the end must be a commit on this branch after the start.';
        }

        this.deps.draw();
        return true;
      }
      case 'tree-noop':
        return true;
      default:
        return false;
    }
  }

  /** This branch's commits newest first, as the stack orders them past the list's 200, else as the list does. */
  #treeCommits(): CommitInfo[] {
    const stack = this.tree.stack;
    const list = this.view.list?.commits ?? [];

    if (stack === null) {
      return list;
    }

    const infos = new Map([...(stack.infos ?? []), ...list].map((one) => [one.sha, one]));
    const order = [...stack.commitIds, ...stack.links.filter((link) => link.relation === 'below').flatMap((link) => link.commitIds)];

    return order.map((sha) => infos.get(sha)).filter((one): one is CommitInfo => one !== undefined);
  }

  /** Pins the tree beside the diffs, or unpins it, on this device (Ctrl+B); a tab too narrow to pin it opens or closes its flyout instead. */
  togglePin(): void {
    const focused = typeof document !== 'undefined' && document.activeElement?.closest('.changes-tree') != null;

    if (this.#phone() || (this.#width > 0 && this.#width < TREE_FLYOUT_MAX_WIDTH)) {
      this.#flyout = !this.#flyout;
    } else {
      keep(TREE_PIN_KEY, this.pinned ? '0' : '1');
      this.#flyout = false;
    }

    // A tree hidden while it had the focus hands it to the bar's tree button, so the keys still have a place.
    this.#focusTreeButton = focused && !this.pinned && !this.#flyout;

    this.deps.draw();
  }

  /** Builds the quote of the selected lines and puts it in the message. */
  #quote(): void {
    const selection = this.#selection;

    if (selection === null) {
      return;
    }

    const { start, end } = { start: Math.min(selection.range.start, selection.range.end), end: Math.max(selection.range.start, selection.range.end) };

    if (selection.in === 'file') {
      const file = this.#file;
      const contents = file?.entry.state === 'ok' ? (file.entry.data.contents ?? '') : '';
      const revision = file === null ? null : onDisk(file) ? 'on disk' : file.side === 'base' ? pointName(file.range.from, this.view.list) : pointName(file.range.to, this.view.list);

      this.deps.quote?.(quoteText(file?.path ?? selection.path, start, end, null, revision, contents.split('\n').slice(start - 1, end)));
    } else {
      const held = this.#held.get(selection.path);
      const data = held !== undefined && held.content !== null && 'data' in held.content ? held.content.data : null;
      const old = selection.range.side === 'deletions';
      const row = this.view.list?.rows.find((one) => one.path === selection.path);
      const path = old ? (row?.from ?? selection.path) : selection.path;
      const list = this.view.list;

      this.deps.quote?.(quoteText(path, start, end, old ? 'old' : 'new', list === null ? null : pointName(old ? list.from : list.to, list), data === null ? [] : patchLines(data, old ? 'old' : 'new', start, end)));
    }
  }

  /** The diff viewer's module, loaded once for the diffs and the file view. */
  #loadModule(): Promise<DiffModule | null> {
    this.#module ??= this.deps.loadDiff();
    return this.#module.then((module) => {
      if (module === null) {
        this.#module = null;
      }

      return module;
    });
  }

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
    if (sameRange(range, this.view.range)) {
      this.deps.draw();
      return;
    }

    this.view.range = range;
    this.#selection = null;
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
    // The tree stays as it is: another range changes only the list the diffs show.
    void this.refresh(false, false);
  }

  /**
   * Follows the page's work item: `id` names it (`followed` in main.ts), so another one drops the list, its diffs and the Changes tab;
   * `turnEnded` reads the list again, once the tab was opened, when the session's turn ends or another session of the work item starts.
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
      Object.assign(this.tree, newTree());
      this.#treeGen++;
      this.#searchGen++;
      this.#flyout = false;
      this.#selection = null;

      if (this.#stackRetry !== null) {
        clearTimeout(this.#stackRetry);
        this.#stackRetry = null;
      }

      return;
    }

    if (turnEnded && (this.view.menu || this.view.tab)) {
      void this.refresh();
    }
  }

  /** Reads the list again, and the tree while the tab is open (`force` past the stack's caches, as Refresh does); an answer for a conversation the page has left since is dropped. */
  async refresh(force = false, tree = true): Promise<void> {
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
      const answer = this.deps.fetch(`/v1/conversation/changes?window=${encodeURIComponent(key)}${this.#only()}`, { credentials: 'same-origin' });

      if (this.view.tab && tree) {
        void this.#readTree(force);
      }

      const response = await answer;
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (response.ok) {
        // An answer without a range, as from a hub older than the page, is every change since the base.
        const read = body as Partial<ChangesList>;

        list = { ...(body as unknown as ChangesList), from: read.from ?? 'base', to: read.to ?? 'worktree', commits: Array.isArray(read.commits) ? read.commits : [], commitsMore: read.commitsMore === true };
      } else {
        error = String(body['error'] ?? `Switchboard could not load this (status ${response.status}). Try again.`);
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

      if (sameRange(rangeOf(list), UNCOMMITTED)) {
        this.tree.uncommitted = list;
      }

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

    if (action?.startsWith('tree-') === true && this.#treeClick(target, action)) {
      return true;
    }

    if (action === 'changes-back') {
      if (this.#file !== null) {
        this.#file = null;
        this.#selection = null;
        this.deps.draw();
      } else {
        this.#setRange(ALL_CHANGES);
      }

      return true;
    }

    if (action === 'changes-more') {
      this.view.more = !this.view.more;
      this.view.menu = false;
      this.deps.draw();
      return true;
    }

    if (action === 'changes-layout') {
      const choice = target.closest<HTMLElement>('[data-action]')!.dataset['layout'];

      keep(LAYOUT_KEY, choice === 'split' || choice === 'stacked' ? choice : 'auto');
      this.deps.draw();
      return true;
    }

    if (action === 'changes-whitespace') {
      this.view.ignoreSpace = !this.view.ignoreSpace;
      this.view.more = false;
      // Every held diff was read with the other mode; the view reads them again for this one.
      this.#syncRows();
      this.deps.draw();
      return true;
    }

    if (action === 'diff-quote') {
      this.#quote();
      return true;
    }

    if (action === 'changes-menu') {
      this.view.menu = !this.view.menu;
      this.view.more = false;
      this.deps.draw();
      return true;
    }

    if (action === 'changes-refresh') {
      this.view.more = false;
      void this.refresh(true);
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
      keepWrap(this.#shownLayout(target.closest<HTMLElement>('.diff-pane')).wrap ? 'off' : 'on');
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

    if (action === 'file-source') {
      if (this.#file !== null) {
        this.#file.source = !this.#file.source;
        this.deps.draw();
      }

      return true;
    }

    if (action === 'file-diff') {
      const row = this.#file?.rowPath ?? null;

      this.#file = null;

      if (row !== null) {
        this.openChanges(row);
      }

      this.deps.draw();
      return true;
    }

    if (action === 'changes-file') {
      const link = target.closest<HTMLElement>('[data-action]')!;
      const line = Number(link.dataset['line']);

      this.openDiskFile(link.dataset['path'] ?? '', Number.isInteger(line) && line > 0 ? line : null);
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
      const response = await this.deps.fetch(`/v1/conversation/diff?window=${encodeURIComponent(pageKey)}&path=${encodeURIComponent(row.path)}&sides=0${this.#only()}${this.#ws()}`, {
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

          next = { key, etag: null, content: { note: String(body['error'] ?? `Switchboard could not load this (status ${response.status}). Try again.`) }, chars: 0, hydrated: false };
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
    if (now === undefined || rowKey(this.#ref(), now) !== key) {
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
    const base = this.#ref();

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
      const response = await this.deps.fetch(`/v1/conversation/diff?window=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}${this.#only()}${this.#ws()}`, { credentials: 'same-origin' });

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

    this.#focusPath = path;
    this.#openFile({ path: base ? (row?.from ?? path) : path, rowPath: row === undefined ? null : path, side: base ? 'base' : 'disk', range: this.view.range, line, entry: { state: 'loading' }, source: true });
  }

  /**
   * Shows a file of the worktree as it is on disk, at a line, from the tree, a search result or a Markdown link, whatever range is chosen;
   * Diff | File offers its diff only while the shown list's rows end on disk and it is one of them.
   */
  openDiskFile(path: string, line: number | null): void {
    const list = this.view.list;
    const row = list !== null && list.to === 'worktree' ? list.rows.find((one) => one.path === path && one.status !== 'D') : undefined;

    this.view.tab = true;
    // At a line, as from a search result, a Markdown file shows its source there; otherwise its preview.
    this.#openFile({ path, rowPath: row?.path ?? null, side: 'disk', range: UNCOMMITTED, line, entry: { state: 'loading' }, source: line !== null });
    this.deps.showDiff();
  }

  #openFile(open: FileOpen): void {
    this.#file = open;
    this.#selection = null;
    this.#fileNewer = false;
    this.deps.draw();
    void this.#readFile(open);
  }

  /** The file view shown, while there is one. */
  get fileShown(): FileOpen | null {
    return this.#file;
  }

  /**
   * Reads the file view's file again while it shows a file on disk and is in view, so a file the session changes shows its new version: after a
   * turn ends, on a reconnect and when the page shows, and on every `poll`, which leaves a read on its way to answer rather than asking for a
   * newer one, so a slow hub still answers. A file at a commit or the base cannot change and is not read again.
   */
  refreshFile(poll = false): void {
    const open = this.#file;

    if (open !== null && onDisk(open) && open.entry.state !== 'loading' && (this.deps.inView?.() ?? true)) {
      void this.#readFile(open, true, !poll);
    }
  }

  /**
   * Reads the file view's file. `again` sends the ETag it holds, so an unchanged file answers 304 and nothing is drawn, and keeps what it shows
   * when the hub does not answer. A read asked for while another is on its way, unless by a poll (`newer` false), drops that read's answer and is
   * made once it is back. An answer for another file view, scope or conversation is dropped.
   */
  async #readFile(open: FileOpen, again = false, newer = true): Promise<void> {
    const key = this.deps.key();
    const generation = this.#generation;

    if (key === null) {
      return;
    }

    if (this.#fileReading === open) {
      this.#fileNewer ||= newer;
      return;
    }

    const etag = again && open.entry.state === 'ok' ? open.entry.etag : null;
    let entry: FileOpen['entry'] | null = null;

    this.#fileReading = open;

    try {
      const response = await this.deps.fetch(`/v1/conversation/file?window=${encodeURIComponent(key)}&path=${encodeURIComponent(open.path)}&side=${open.side}${this.#only(open.range)}`, { credentials: 'same-origin', ...(etag === null ? {} : { headers: { 'If-None-Match': etag } }) });

      if (response.status === 304 || (again && !response.ok && response.status !== 404 && response.status !== 403)) {
        entry = null;
      } else {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

        if (!response.ok && this.#staleBack(body, generation)) {
          return;
        }

        const tag = response.headers?.get?.('ETag') ?? null;

        entry = response.ok ? { state: 'ok', data: body as unknown as FileData, version: tag ?? readVersion(), etag: tag } : { state: 'error', error: String(body['error'] ?? `Switchboard could not load this (status ${response.status}). Try again.`), refused: response.status === 403 };
      }
    } catch (failure) {
      entry = again ? null : { state: 'error', error: `Switchboard did not answer: ${String(failure)}`, refused: false };
    } finally {
      if (this.#fileReading === open) {
        this.#fileReading = null;
      }
    }

    if (generation !== this.#generation || this.#file !== open) {
      return;
    }

    if (this.#fileNewer) {
      this.#fileNewer = false;
      void this.#readFile(open, open.entry.state !== 'loading');
      return;
    }

    if (entry !== null && !(entry.state === 'error' && open.entry.state === 'error' && entry.error === open.entry.error)) {
      open.entry = entry;
      this.deps.draw();
    }
  }

  /**
   * Ticks a file viewed at the content the page shows, or clears its tick, in the hub, for every device; a file that changed since is read again
   * rather than ticked.
   */
  async toggleViewed(path: string, posted?: ChangeRange): Promise<void> {
    const row = this.view.list?.rows.find((one) => one.path === path);

    if (row === undefined) {
      return;
    }

    row.viewed = row.viewed !== true;

    // A list to disk keeps its ticks with the uncommitted list's, so the tree's tick follows.
    const mirror = this.view.list?.to === 'worktree' ? this.tree.uncommitted?.rows.find((one) => one !== row && one.path === path && one.hash === row.hash) : undefined;

    if (mirror !== undefined) {
      mirror.viewed = row.viewed;
    }

    this.#tickCollapse(path, row.viewed);
    this.#viewedChanged();

    // One post at a time per file, the last click's choice sent once the one on its way answers, so the hub ends where the page shows.
    if (this.#ticking.has(row)) {
      return;
    }

    this.#ticking.add(row);

    // The range the row was shown in, kept for every post, even after another scope is chosen meanwhile.
    const range = posted ?? (this.view.list === null ? this.view.range : rangeOf(this.view.list));

    try {
      for (let sent: boolean | null = null; row.viewed !== sent; ) {
        sent = row.viewed === true;

        const answer = await this.deps.command('viewed', { path, hash: row.hash, viewed: sent, from: range.from, to: range.to });

        if (answer.status !== 200) {
          row.viewed = !sent;
          this.#setCollapsed(path, row.viewed, true);
          this.view.error = String(answer.body['error'] ?? `Switchboard could not load this (status ${answer.status}). Try again.`);
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
    const mirror = data['workItemId'] === this.deps.workItemId() && (data['scope'] ?? '') === '' ? this.tree.uncommitted?.rows.find((one) => one.path === data['path'] && one.hash === data['hash']) : undefined;

    if (mirror !== undefined && typeof data['viewed'] === 'boolean') {
      mirror.viewed = data['viewed'];
      this.deps.draw();
    }

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

    // The diffs' own width: a pinned tree takes its share of the pane.
    const diffs = pane?.querySelector<HTMLElement>(':scope > .diff-view.tree-pinned > .diff-host')?.clientWidth || 0;

    return diffLayout(storedLayout() ?? settings.layout, storedWrap() ?? settings.wrap, diffs || pane?.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 0));
  }

  /** Gives the diffs and the file view shown in `pane` the layout its width calls for now, and its bar's Wrap the wrapping. */
  #relayout(pane: HTMLElement): void {
    const shown = this.#shownLayout(pane);
    const mounted = this.#mount;
    const bar = pane.querySelector<HTMLElement>(':scope > .diff-view > .changes-bar');

    if (bar !== null) {
      mount(bar, renderChangesBar(this.view, shown.wrap, Date.now(), this.#barTree()));

      if (this.#focusTreeButton) {
        this.#focusTreeButton = false;
        bar.querySelector<HTMLElement>('.changes-tree-button')?.focus();
      }

      if (this.#focusCompare) {
        this.#focusCompare = false;
        bar.querySelector<HTMLElement>('input[data-compare-filter]')?.focus();
      }

      // The flyout opens under the bar, however many lines the bar wraps to, so it never covers the bar's controls.
      const tree = pane.querySelector<HTMLElement>(':scope > .diff-view > .changes-tree');

      if (tree !== null) {
        tree.style.top = this.pinned ? '' : `${bar.offsetHeight}px`;
      }
    }

    if (mounted !== null && pane.contains(mounted.host) && mounted.layout !== `${shown.layout} ${shown.wrap}`) {
      mounted.layout = `${shown.layout} ${shown.wrap}`;
      mounted.mount.set(shown.layout, shown.wrap);
    }

    const view = pane.querySelector<HTMLElement>(':scope > .diff-view');

    if (this.#file !== null && view !== null) {
      this.#drawFile(view);
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
    this.#code.drop(true);
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

      const tree = document.createElement('aside');
      const splitter = document.createElement('div');
      const bar = document.createElement('div');
      const host = document.createElement('div');

      tree.className = 'changes-tree';
      tree.setAttribute('aria-label', 'Files and commits');
      splitter.className = 'tree-splitter';
      splitter.setAttribute('role', 'separator');
      splitter.setAttribute('aria-orientation', 'vertical');
      splitter.setAttribute('aria-label', 'Resize the tree');
      this.#dragSplitter(view, splitter);
      bar.className = 'changes-bar';
      host.className = 'diff-host';
      view.append(tree, splitter, bar, host);
      pane.replaceChildren(view);
      this.drop();
    }

    this.#width = pane.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 0);

    const pinned = this.pinned;
    const width = Number(stored(TREE_WIDTH_KEY));

    view.classList.toggle('tree-pinned', pinned);
    view.classList.toggle('tree-open', !pinned && this.#flyout);

    if (Number.isFinite(width) && width >= 180) {
      view.style.setProperty('--tree-width', `${Math.round(width)}px`);
    }

    mount(view.querySelector(':scope > .changes-tree')!, <ChangesTreeView state={this.tree} list={this.view.list} shown={this.view.range} now={Date.now()} pinned={pinned} canPin={!this.#phone() && (this.#width === 0 || this.#width >= TREE_FLYOUT_MAX_WIDTH)} />);

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

    if (this.#file === null) {
      this.#drawFile(view);
    }

    for (const [path, element] of this.#metas) {
      mount(element, <DiffTools row={this.view.list?.rows.find((one) => one.path === path)} quote={this.#selection?.in === 'diff' && this.#selection.path === path} />);
    }

    for (const [path, element] of this.#prefixes) {
      mount(element, <Chevron path={path} collapsed={this.#collapsed.has(path)} />);
    }
  }

  /** Lets the pinned tree's splitter set its width, kept on this device. */
  #dragSplitter(view: HTMLElement, splitter: HTMLElement): void {
    splitter.addEventListener('pointerdown', (down) => {
      down.preventDefault();

      const left = view.getBoundingClientRect().left;
      const most = Math.max(240, view.clientWidth * 0.6);
      let width = 0;
      const move = (event: PointerEvent) => {
        width = Math.round(Math.min(most, Math.max(180, event.clientX - left)));
        view.style.setProperty('--tree-width', `${width}px`);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);

        if (width > 0) {
          keep(TREE_WIDTH_KEY, String(width));
          // The diffs' width changed with it, which can change Auto's layout.
          this.deps.draw();
        }
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
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

      const mount = module.mountChanges(host, rows, {
        layout: shown.layout,
        wrap: shown.wrap,
        loadSides: (path) => this.#loadSides(path),
        onLine: (path, side, line) => this.openFileView(path, side, line),
        headerMeta: (path) => this.#meta(path),
        headerPrefix: (path) => this.#prefix(path),
        onHeader: (path) => this.#headerClicked(path),
        onSelect: (path, range) => {
          // Lines selected across both sides of a change, from removed lines into added ones, are not one revision's text, so Quote is not offered.
          const across = range !== null && range.endSide !== undefined && range.endSide !== (range.side ?? 'additions');

          this.#selection = path === null || range === null || across ? null : { path, range, in: 'diff' };
          this.deps.draw();
        },
      });

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
   * Draws the file view under the bar while one is open, or takes it away. The file has no header of its own: the bar shows its name, the line
   * after it and its tools (`#fileBar`). Code goes through the diff viewer's file view; Markdown, pictures and PDFs are drawn by the page.
   */
  #drawFile(view: HTMLElement): void {
    let overlay = view.querySelector<HTMLElement>(':scope > .file-overlay');
    const file = this.#file;

    if (file === null) {
      if (overlay !== null) {
        overlay.remove();
        this.#code.drop();
      }

      return;
    }

    if (overlay === null) {
      overlay = document.createElement('div');
      overlay.className = 'file-overlay';
      view.append(overlay);
    }

    // The file view lies under the bar, which stays in reach: the tree's button, the way back and Wrap work from it while a file shows.
    const bar = view.querySelector<HTMLElement>(':scope > .changes-bar');

    overlay.style.top = `${bar?.offsetHeight ?? 0}px`;

    const place = `${file.side} ${file.path} ${file.range.from} ${file.range.to} ${file.line ?? ''}`;
    const note = fileNote(file.entry);
    const entry = file.entry;
    const wrap = this.#shownLayout(view.closest<HTMLElement>('.diff-pane') ?? view).wrap;

    if (note !== null || entry.state !== 'ok') {
      overlay.dataset['place'] = '';
      overlay.replaceChildren();
      this.#code.drop();

      const host = document.createElement('div');

      host.className = 'diff-host file-view';
      overlay.append(host);
      sayIn(host, note ?? 'Reading the file…');
      return;
    }

    const kind = fileKind(entry.data);

    if (kind === 'code' || (kind === 'markdown' && file.source)) {
      const onSelect = (range: LineRange | null) => {
        const was = this.#selection?.in === 'file';

        this.#selection = range === null ? (was ? null : this.#selection) : { path: file.path, range, in: 'file' };

        if (was !== (range !== null)) {
          this.deps.draw();
        }
      };

      this.#code.draw(overlay, { place: `${place} code`, version: entry.version, path: file.path, side: file.side, contents: entry.data.contents ?? '', line: file.line, wrap, header: false, onSelect }, null);
      return;
    }

    // Markdown's preview, a picture or a PDF, drawn by the page into a view of its own, kept across draws so it keeps where it is scrolled.
    let page = overlay.querySelector<HTMLElement>(':scope > .file-page');

    if (page === null || overlay.dataset['place'] !== place) {
      this.#code.drop(true);
      page = document.createElement('div');
      page.className = 'file-page';
      overlay.replaceChildren(page);
      overlay.dataset['place'] = place;
    }

    const key = this.deps.key() ?? '';
    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    const html = kind === 'markdown' ? this.#markdown(file, entry.data.contents ?? '', key) : undefined;
    const rawUrl = kind === 'markdown' ? undefined : `${this.#rawUrl(key, file, file.path)}&v=${encodeURIComponent(entry.version)}`;
    const drawn = page.dataset['version'] !== entry.version;

    mount(
      page,
      <FileBody kind={kind} name={name} html={html} rawUrl={rawUrl} />,
    );
    page.dataset['version'] = entry.version;

    if (kind === 'markdown' && drawn) {
      const doc = page.querySelector<HTMLElement>(':scope > .artifact-doc');

      if (doc !== null) {
        this.deps.drawDiagrams?.(doc);
      }
    }
  }

  /** `file-raw`'s address for a path of the file view's revision. */
  #rawUrl(key: string, file: FileOpen, path: string): string {
    return `/v1/conversation/file-raw?window=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}&side=${file.side}${this.#only(file.range)}`;
  }

  /** A Markdown file's preview, its links and pictures read only through the Changes routes (`worktreeMarkdown`). */
  #markdown(file: FileOpen, text: string, key: string): string {
    return worktreeMarkdown(file.path, text, (path) => this.#rawUrl(key, file, path));
  }

  /** Ends the viewers whose host has left the page. */
  drop(): void {
    if (this.#mount !== null && !this.#mount.host.isConnected) {
      this.#mount.mount.dispose();
      this.#mount = null;
    }

    this.#code.drop();
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

    // Ctrl+B pins or unpins the tree, Ctrl+P goes to its search box, from anywhere in the tab.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && target?.closest('.diff-view') != null && (event.key === 'b' || event.key === 'p')) {
      if (event.key === 'b') {
        this.togglePin();
      } else {
        if (!this.pinned) {
          this.#flyout = true;
          this.deps.draw();
        }

        target.closest('.diff-view')!.querySelector<HTMLInputElement>('.changes-tree input[data-tree-search]')?.focus();
      }

      return true;
    }

    if (target !== null && this.#treeKey(event, target)) {
      return true;
    }

    if (event.ctrlKey || event.metaKey || event.altKey || target === null || target.closest('.diff-view') === null || target.closest('input, textarea, select, [contenteditable="true"], .changes-menu, .changes-tree') !== null) {
      return false;
    }

    if (this.#file !== null) {
      if (event.key !== 'Escape') {
        return false;
      }

      // The focus was likely in the file view, which leaves the page: it goes back to the Changes view, so j, n and the other keys work on.
      const view = target.closest<HTMLElement>('.diff-view');

      this.#file = null;
      this.#selection = null;
      this.deps.draw();
      view?.focus();
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

  /**
   * The tree's keys, while the focus is in it: Up and Down go to the next and previous row, Right opens a row and Left closes it, Down in the
   * search box goes to the first row, Escape closes the search's options menu, else the flyout. In the open options menu or on its button, Up
   * and Down move along the menu's rows. Enter and Space act as a click does, on the row's own button.
   */
  #treeKey(event: KeyboardEvent, target: Element): boolean {
    const tree = target.closest<HTMLElement>('.changes-tree');

    if (tree === null || event.ctrlKey || event.metaKey || event.altKey) {
      return false;
    }

    const rows = [...tree.querySelectorAll<HTMLElement>('.tree-row')];
    const at = rows.indexOf(target.closest<HTMLElement>('.tree-row')!);

    if (this.tree.options && event.key === 'Escape') {
      this.tree.options = false;
      tree.querySelector<HTMLElement>('.tree-options-button')?.focus();
      this.deps.draw();
      return true;
    }

    if (this.tree.options && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && target.closest('.tree-options') !== null) {
      const items = [...tree.querySelectorAll<HTMLElement>('.tree-options-menu .menu-row')];
      const now = items.indexOf(target as HTMLElement);

      items[now === -1 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, now + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      return true;
    }

    if (event.key === 'Escape' && !this.pinned && this.#flyout) {
      this.#flyout = false;
      this.#focusTreeButton = true;
      this.deps.draw();
      return true;
    }

    if (target.matches('input[data-tree-search]')) {
      if (event.key === 'ArrowDown') {
        rows[0]?.focus();
        return true;
      }

      return false;
    }

    if (at === -1) {
      return false;
    }

    const row = rows[at]!;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      rows[at + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
      return true;
    }

    if ((event.key === 'ArrowRight' && row.getAttribute('aria-expanded') === 'false') || (event.key === 'ArrowLeft' && row.getAttribute('aria-expanded') === 'true')) {
      const index = at;

      row.click();
      tree.querySelectorAll<HTMLElement>('.tree-row')[index]?.focus();
      return true;
    }

    return event.key === 'ArrowRight' || event.key === 'ArrowLeft';
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

  /** The tree's search box or the Compare picker's filter changed; true when the field was one of them. */
  input(target: EventTarget | null): boolean {
    if (target instanceof HTMLInputElement && target.dataset['compareFilter'] !== undefined && this.view.compare !== null) {
      this.view.compare.query = target.value;
      this.deps.draw();
      return true;
    }

    if (target instanceof HTMLInputElement && target.dataset['treeSearch'] !== undefined) {
      this.tree.query = target.value;

      // The typed text filters what the tree has read at once; a text search waits for a pause in typing.
      if (this.tree.text) {
        if (this.#searchTimer !== null) {
          clearTimeout(this.#searchTimer);
        }

        this.#searchTimer = setTimeout(() => {
          this.#searchTimer = null;
          void this.#search();
        }, 250);
      }

      this.deps.draw();
      return true;
    }

    return false;
  }

  /** Closes the Files menu, the `⋯` menu, the Compare picker, a row's menu, the search's options menu or the tree's flyout on a press outside it and its button; true when one closed. */
  pointerDown(target: EventTarget | null): boolean {
    const inside = (selector: string) => target instanceof Element && target.closest(selector) !== null;
    let closed = false;

    if (this.tree.menu !== null && !inside('.tree-more')) {
      this.tree.menu = null;
      closed = true;
    }

    if (this.tree.options && !inside('.tree-options')) {
      this.tree.options = false;
      closed = true;
    }

    if (this.#flyout && !this.pinned && !inside('.changes-tree, .changes-tree-button')) {
      this.#flyout = false;
      closed = true;
    }

    // The picker opens from a row's menu, so a press there leaves it to the click.
    if (this.view.compare !== null && !inside('.compare-menu, .tree-more')) {
      this.view.compare = null;
      closed = true;
    }

    if ((!this.view.menu && !this.view.more) || inside('.changes-menu, .changes-files, .changes-more')) {
      return closed;
    }

    this.view.menu = false;
    this.view.more = false;
    return true;
  }

  /** Closes the search's options menu, the Compare picker, the Files menu, the `⋯` menu or a row's menu on Escape: which button takes the focus back, or null. */
  escape(): 'files' | 'more' | 'options' | null {
    if (this.tree.options) {
      this.tree.options = false;
      return 'options';
    }

    if (this.view.compare !== null) {
      this.view.compare = null;
      return 'files';
    }

    if (this.tree.menu !== null) {
      this.tree.menu = null;
      return 'more';
    }

    if (!this.view.menu && !this.view.more) {
      return null;
    }

    const closed = this.view.more ? 'more' : 'files';

    this.view.menu = false;
    this.view.more = false;
    return closed;
  }
}