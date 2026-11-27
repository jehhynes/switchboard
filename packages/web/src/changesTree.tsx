// The Changes tab's tree (PRD R118, R128; architecture.md § Web page, Changes), modelled on VS Code's Source Control: the repository and worktree,
// a search box, FILES (the uncommitted files with their Viewed ticks, or the whole worktree), and COMMITS (this branch's commits, then each
// branch it is stacked on, collapsed, then the remote default branch). Rows toggle; links choose what the diffs compare. Pinned beside the
// diffs or opened as a flyout from the bar. Read-only: nothing here writes to git or GitHub.
import type { ComponentChildren, VNode } from 'preact';
import type { ChangeRow, ChangesList, CommitInfo, SearchData, StackData, StackLink, TreeData } from '@switchboard/protocol';
import { fullTime } from '@switchboard/conversation/messageMeta';
import { FileIcon } from './fileIcons.js';
import { ago } from './render.js';

/** A range of the change routes: from `base`, `HEAD` or a commit, to `worktree`, `HEAD` or a commit. */
export interface TreeRange {
  from: string;
  to: string;
}

export interface TreeState {
  stack: StackData | null;
  stackError: string | null;
  tree: TreeData | null;
  /** Each opened ignored folder's entries, read when it is first opened, as `<path>` or `<path>/` for a folder; kept by the folder's path. */
  ignored: Map<string, string[] | { error: string } | 'loading'>;
  /** The uncommitted changes, HEAD to disk: FILES · Changed, and the status letters of FILES · All. */
  uncommitted: ChangesList | null;
  /** Each expanded commit's own changes, read without making them the list shown, the last {@link PEEKS_KEPT}. */
  peeks: Map<string, ChangesList | { error: string } | 'loading'>;
  /** The rows open: `files`, `commits`, `branch`, `commit:<sha>`, `link:<name>`, `dir:<path>`; and those closed that start open. */
  open: Set<string>;
  closed: Set<string>;
  /** FILES shows the uncommitted files or every file; null until chosen, when it shows the uncommitted files. */
  files: 'changed' | 'all' | null;
  query: string;
  /** Text search: the search route's results replace the tree. */
  text: boolean;
  matchCase: boolean;
  word: boolean;
  regex: boolean;
  search: SearchData | 'running' | null;
  searchError: string | null;
  /** The row whose `…` menu is open. */
  menu: string | null;
  /** Whether the search box's options menu is open. */
  options: boolean;
}

export const PEEKS_KEPT = 20;

export const newTree = (): TreeState => ({ stack: null, stackError: null, tree: null, ignored: new Map(), uncommitted: null, peeks: new Map(), open: new Set(), closed: new Set(), files: null, query: '', text: false, matchCase: false, word: false, regex: false, search: null, searchError: null, menu: null, options: false });

const short = (sha: string): string => sha.slice(0, 7);
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirName = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const STATUS_TITLES: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', U: 'Untracked', C: 'Conflict' };

/** Whether a tree row starts open: FILES, COMMITS and this branch do; a base, a commit and a folder do not. */
const startsOpen = (key: string): boolean => key === 'files' || key === 'commits' || key === 'branch';

export function isOpen(state: TreeState, key: string): boolean {
  return startsOpen(key) ? !state.closed.has(key) : state.open.has(key);
}

/** Which FILES list shows: the one chosen, else the uncommitted files, even when there are none. */
export function filesShown(state: TreeState): 'changed' | 'all' {
  return state.files ?? 'changed';
}

/** Whether a row's text has the typed filter in it, ignoring case unless Aa is on. */
function matches(state: TreeState, ...texts: string[]): boolean {
  const query = state.text ? '' : state.query.trim();

  if (query === '') {
    return true;
  }

  return texts.some((text) => (state.matchCase ? text.includes(query) : text.toLowerCase().includes(query.toLowerCase())));
}

/** Whether a commit shows under the typed filter: by its subject, its ID, or a path it changes. */
export function commitMatches(state: TreeState, sha: string, info: (CommitInfo & { files?: string[] }) | undefined): boolean {
  return matches(state, info?.subject ?? '', sha, ...(info?.files ?? []));
}

/** Whether the typed filter is on, so a base with a matching commit opens to show it. */
const filtering = (state: TreeState): boolean => !state.text && state.query.trim() !== '';

/** The folders and files under a folder, folders first, each sorted by name; a path ending in `/` is a folder. */
export function folderEntries(paths: readonly string[], dir: string): { dirs: string[]; files: string[] } {
  const prefix = dir === '' ? '' : `${dir}/`;
  const dirs = new Set<string>();
  const files: string[] = [];

  for (const path of paths) {
    if (!path.startsWith(prefix)) {
      continue;
    }

    const rest = path.slice(prefix.length);

    if (rest === '') {
      continue;
    }
    const slash = rest.indexOf('/');

    if (slash === -1) {
      files.push(path);
    } else {
      dirs.add(prefix + rest.slice(0, slash));
    }
  }

  return { dirs: [...dirs].sort(), files: [...new Set(files)].sort() };
}

/** What git ignores, read so far: its files, and its folders, under whose paths everything is ignored. */
export interface IgnoredSet {
  files: Set<string>;
  dirs: Set<string>;
}

/** The ignored files and folders the tree has read: the worktree's, and those of every ignored folder opened. */
export function ignoredSet(state: TreeState): IgnoredSet {
  const files = new Set<string>();
  const dirs = new Set<string>();

  for (const path of [...(state.tree?.ignored ?? []), ...[...state.ignored.values()].flatMap((one) => (Array.isArray(one) ? one : []))]) {
    path.endsWith('/') ? dirs.add(path.slice(0, -1)) : files.add(path);
  }

  return { files, dirs };
}

/** Whether git ignores a path: an ignored file, an ignored folder, or anything inside one. */
export function isIgnored(ignored: IgnoredSet, path: string): boolean {
  if (ignored.files.has(path) || ignored.dirs.has(path)) {
    return true;
  }

  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
    if (ignored.dirs.has(path.slice(0, at))) {
      return true;
    }
  }

  return false;
}

/** A tree row: a button for the row's own action, and any links and controls after it as targets of their own. */
function TreeRow({ depth, action, data, open, label, sub, title, status, selected, children, before, icon, className = '' }: { depth: number; action: string; data?: Record<string, string>; open?: boolean; label: ComponentChildren; sub?: string | undefined; title?: string | undefined; status?: string | undefined; selected?: boolean; children?: ComponentChildren; before?: ComponentChildren; icon?: ComponentChildren; className?: string }): VNode {
  const attrs = Object.fromEntries(Object.entries(data ?? {}).map(([name, value]) => [`data-${name}`, value]));

  return (
    <div class={`tree-item ${className}${selected === true ? ' selected' : ''}`} style={`--depth: ${depth}`}>
      {/* A row that does not open keeps the twisty's room: a file's icon sits in it, level with a folder's chevron, so a file's name starts
          where a sibling folder's does; any other row leaves it empty, so its icon lines up with an openable sibling's. */}
      {open === undefined ? (
        <span class="tree-twisty" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {open === undefined ? before : null}
      <button class="tree-row" type="button" data-action={action} {...attrs} aria-expanded={open} title={title}>
        {open === undefined ? null : <span class={`tree-twisty codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true"></span>}
        {/* A row that opens has its chevron first, then its icon, as VS Code's do. */}
        {open === undefined ? null : before}
        <span class="tree-label">{label}</span>
        {sub === undefined || sub === '' ? null : <span class="tree-sub">{sub}</span>}
        {status === undefined ? null : (
          <span class={`tree-status status-${status}`} aria-label={STATUS_TITLES[status] ?? status}>
            {status}
          </span>
        )}
      </button>
      {children}
    </div>
  );
}

/** A link at the end of a row that sets what the diffs compare. */
/** The diff icon that sets what the diffs compare, the same on every row that has one. */
function RangeLink({ range, title, disabled }: { range: TreeRange; title: string; disabled?: boolean }): VNode {
  return (
    <button class="tree-link icon" type="button" data-action="tree-range" data-from={range.from} data-to={range.to} title={title} aria-label={title} disabled={disabled}>
      <span class="codicon codicon-diff" aria-hidden="true"></span>
    </button>
  );
}

function BranchIcon(): VNode {
  return <span class="codicon codicon-git-branch tree-branch-icon" aria-hidden="true"></span>;
}

/** A row's `…` menu: what the diffs compare from this point, or with another chosen in the picker under the bar. */
function PointMenu({ point }: { point: string }): VNode {
  return (
    <div class="glass tree-menu" role="menu">
      <button type="button" role="menuitem" data-action="tree-range" data-from={point} data-to="worktree">
        Changes since this
      </button>
      <button type="button" role="menuitem" data-action="tree-compare" data-point={point}>
        Compare with…
      </button>
    </div>
  );
}

function MenuButton({ point, state, label }: { point: string; state: TreeState; label: string }): VNode {
  const open = state.menu === point;

  return (
    <span class="tree-more">
      <button class="tree-link icon" type="button" data-action="tree-menu" data-point={point} aria-expanded={open} aria-label={`More for ${label}`} title="More">
        <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
      </button>
      {open ? <PointMenu point={point} /> : null}
    </span>
  );
}

/** A commit's row: subject, age and the diff icon, which shows its whole diff; open, its files, each showing its diff in the commit. */
function CommitRow({ sha, info, depth, state, now, shown }: { sha: string; info: CommitInfo | undefined; depth: number; state: TreeState; now: number; shown: TreeRange }): VNode | null {
  const subject = info?.subject ?? short(sha);

  if (!commitMatches(state, sha, info)) {
    return null;
  }

  const open = state.open.has(`commit:${sha}`);
  // A commit found by a path it changes lists only the paths that match; one found by its subject or ID lists them all.
  const byName = matches(state, info?.subject ?? '', sha);
  const range = { from: info?.parent ?? 'base', to: sha };
  const peek = state.peeks.get(sha);
  const chosen = shown.to === sha && shown.from === range.from;

  return (
    <>
      <TreeRow depth={depth} action="tree-toggle" data={{ key: `commit:${sha}`, sha }} open={open} label={subject} sub={info === undefined ? '' : ago(info.time * 1000, now)} title={info === undefined ? sha : `${sha}\n${subject}\n${fullTime(info.time * 1000)}`} selected={chosen} className="commit">
        <RangeLink range={range} title={`Show the whole diff of ${short(sha)}`} />
        <MenuButton point={sha} state={state} label={short(sha)} />
      </TreeRow>
      {!open ? null : peek === undefined || peek === 'loading' ? (
        <p class="tree-note" style={`--depth: ${depth + 1}`}>
          Reading the commit…
        </p>
      ) : 'error' in peek ? (
        <p class="tree-note error" style={`--depth: ${depth + 1}`}>
          {peek.error}
        </p>
      ) : (
        peek.rows.filter((row) => byName || matches(state, row.path)).map((row) => (
          <TreeRow depth={depth + 1} action="tree-file-diff" data={{ path: row.path, from: range.from, to: range.to }} label={baseName(row.path)} sub={dirName(row.path)} status={row.status} title={row.path} className={`file status-${row.status}`} icon={<FileIcon path={row.path} />} />
        ))
      )}
    </>
  );
}

/** What a base's header says after its name: its commits, how far this branch is behind it, its pull request and why it is not measured. */
export function linkInfo(link: StackLink): string {
  const parts: string[] = [];

  if (link.relation === 'above') {
    parts.push(link.lacks == null ? 'not measured' : `lacks ${link.lacks} of this branch's commits`);
  } else {
    parts.push(`${link.commitIds.length}${link.more ? '+' : ''} ${link.commitIds.length === 1 && !link.more ? 'commit' : 'commits'}`);

    if (link.behind !== null && link.behind > 0) {
      parts.push(`behind ${link.behind}`);
    }
  }

  if (link.pr !== undefined) {
    parts.push(`#${link.pr.number}${link.pr.state === 'open' ? '' : ` ${link.pr.state}`}`);
  }

  if (link.workItem !== undefined) {
    parts.push(link.workItem.title);
  }

  if (link.notInClone) {
    parts.push('not in this clone');
  } else if (link.branchDeleted) {
    parts.push('branch deleted');
  }

  if (link.localDiffers) {
    parts.push('local branch differs');
  }

  if (link.upstreamMissing) {
    parts.push('upstream missing');
  }

  if (link.source === 'reflog') {
    parts.push('from local history');
  }

  return parts.join(' · ');
}

/** The tree's sections drawn from what has been read; `list` is the list the diffs show. */
export function ChangesTreeView({ state, list, shown, now, pinned, canPin }: { state: TreeState; list: ChangesList | null; shown: TreeRange; now: number; pinned: boolean; canPin: boolean }): VNode {
  const stack = state.stack;
  // The stack names every commit it groups, past the list's 200 too.
  const commits = new Map<string, CommitInfo & { files?: string[] }>([...(list?.commits ?? []), ...(stack?.infos ?? [])].map((commit) => [commit.sha, commit]));
  const pinLabel = pinned ? 'Unpin the tree' : 'Pin the tree beside the diffs';
  const root = stack?.root ?? '';

  return (
    <div class="changes-tree-inner">
      <div class="tree-head">
        <div class="tree-names">
          <div class="tree-repo">
            <span class="tree-repo-name">{stack?.repo ?? 'Changes'}</span>
            <span class="tree-sub">repo</span>
          </div>
          {root === '' ? null : (
            <div class="tree-worktree" title={root}>
              <span>{baseName(root)}</span>
              <span class="tree-sub">worktree · {root}</span>
            </div>
          )}
        </div>
        {canPin ? (
          <button class="tree-pin" type="button" data-action="tree-pin" aria-pressed={pinned} aria-label={pinLabel} title={`${pinLabel} (Ctrl+B)`}>
            <span class={`codicon codicon-${pinned ? 'pinned' : 'pin'}`} aria-hidden="true"></span>
          </button>
        ) : null}
      </div>
      <SearchBox state={state} />
      {/* The header and search stay put; everything under them scrolls as one. */}
      <div class="tree-scroll">{state.text && state.query.trim() !== '' ? <SearchResults state={state} /> : <Sections state={state} list={list} shown={shown} now={now} commits={commits} />}</div>
    </div>
  );
}

/** The search box's options, as its menu lists them: the option, its label and the glyph VS Code's search box shows for it. */
const SEARCH_OPTIONS: ReadonlyArray<{ name: 'matchCase' | 'word' | 'regex' | 'text'; label: string; glyph: string | null }> = [
  { name: 'matchCase', label: 'Match case', glyph: 'Aa' },
  { name: 'word', label: 'Whole word', glyph: 'ab' },
  { name: 'regex', label: 'Regular expression', glyph: '.*' },
  { name: 'text', label: 'Search the text of every file', glyph: null },
];

/**
 * The search box: the text, then one options button at its right end that opens a menu of Match case, Whole word, Regular expression and
 * text search, so the text keeps the box's width at any width (the operator's decision, 2026-11-26). The button's badge counts the options on
 * without changing its width; choosing an option keeps the menu open.
 */
function SearchBox({ state }: { state: TreeState }): VNode {
  const on = SEARCH_OPTIONS.filter(({ name }) => state[name]).length;
  const label = on === 0 ? 'Search options' : `Search options, ${on} on`;

  return (
    <div class="tree-search">
      <span class="codicon codicon-search" aria-hidden="true"></span>
      <input type="search" data-tree-search="1" value={state.query} placeholder="Search files and commits" aria-label="Search files and commits" />
      <div class="menu-anchor tree-options">
        <button class={`tree-options-button${on > 0 ? ' active' : ''}`} type="button" data-action="tree-options" aria-haspopup="menu" aria-expanded={state.options} title={label} aria-label={label}>
          <span class="codicon codicon-filter" aria-hidden="true"></span>
          {on > 0 ? (
            <span class="tree-options-count" aria-hidden="true">
              {on}
            </span>
          ) : null}
        </button>
        {state.options ? (
          <ul class="glass menu tree-options-menu" role="menu" aria-label="Search options">
            {SEARCH_OPTIONS.map(({ name, label: text, glyph }) => (
              <li role="none">
                <button type="button" class="menu-row" role="menuitemcheckbox" aria-checked={state[name]} data-action="tree-option" data-option={name}>
                  <span class="menu-gutter" aria-hidden="true">
                    {state[name] ? <span class="codicon codicon-check"></span> : null}
                  </span>
                  <span class="title">{text}</span>
                  {glyph === null ? null : (
                    <span class="menu-note" aria-hidden="true">
                      {glyph}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function SearchResults({ state }: { state: TreeState }): VNode {
  const search = state.search;

  if (state.searchError !== null) {
    return <p class="tree-note error">{state.searchError}</p>;
  }

  if (search === null || search === 'running') {
    return <p class="tree-note">Searching…</p>;
  }

  if (search.files.length === 0) {
    return <p class="tree-note">No matches. Try other words, or turn off Match case or Whole word.</p>;
  }

  return (
    <div class="tree-section" role="group" aria-label="Search results">
      {search.files.map((file) => (
        <>
          <TreeRow depth={0} action="tree-disk" data={{ path: file.path }} label={baseName(file.path)} sub={dirName(file.path)} title={file.path} className="file" icon={<FileIcon path={file.path} />} />
          {file.matches.map((match) => (
            <TreeRow depth={1} action="tree-disk" data={{ path: file.path, line: String(match.line) }} label={match.text.trim()} sub={String(match.line)} title={`${file.path}:${match.line}`} className="match" />
          ))}
        </>
      ))}
      {search.more ? <p class="tree-note">Only the first matches are shown. Narrow the search to see the rest.</p> : null}
    </div>
  );
}

function Sections({ state, list, shown, now, commits }: { state: TreeState; list: ChangesList | null; shown: TreeRange; now: number; commits: Map<string, CommitInfo & { files?: string[] }> }): VNode {
  const stack = state.stack;
  const uncommitted = state.uncommitted;
  const mode = filesShown(state);
  const filesOpen = isOpen(state, 'files');
  const commitsOpen = isOpen(state, 'commits');
  const changed = uncommitted?.rows.length ?? 0;
  const own = stack?.commitIds ?? list?.commits.map((one) => one.sha) ?? [];
  const below = stack?.links.filter((link) => link.relation === 'below') ?? [];
  const above = stack?.links.filter((link) => link.relation === 'above') ?? [];
  // A branch on no other: its name and the default branch say nothing COMMITS does not, so its commits sit under COMMITS alone.
  const stacked = below.length > 0 || above.length > 0;
  const ownDepth = stacked ? 2 : 1;

  return (
    <>
      <div class="tree-section-head">
        <TreeRow depth={0} action="tree-toggle" data={{ key: 'files' }} open={filesOpen} label="FILES" className="section">
          <RangeLink range={{ from: 'HEAD', to: 'worktree' }} title="Show the uncommitted changes" />
          <span class="tree-toggle" role="group" aria-label="Files shown">
            <button type="button" data-action="tree-files" data-mode="changed" aria-pressed={mode === 'changed'}>
              {changed} Changed
            </button>
            <button type="button" data-action="tree-files" data-mode="all" aria-pressed={mode === 'all'} title="Every file of the worktree, as folders">
              Explore
            </button>
          </span>
        </TreeRow>
      </div>
      {!filesOpen ? null : mode === 'changed' ? <ChangedFiles state={state} /> : <AllFiles state={state} dir="" depth={1} />}
      <div class="tree-section-head">
        <TreeRow depth={0} action="tree-toggle" data={{ key: 'commits' }} open={commitsOpen} label="COMMITS" className="section" />
      </div>
      {!commitsOpen ? null : (
        <div class="tree-section" role="group" aria-label="Commits">
          {state.stackError !== null ? <p style="--depth: 1" class="tree-note error">{state.stackError}</p> : null}
          {above.map((link) => (
            <UpperRow link={link} />
          ))}
          {!stacked ? null : <TreeRow depth={1} action="tree-toggle" data={{ key: 'branch' }} open={isOpen(state, 'branch')} label={stack?.branch ?? (stack === null ? 'This branch' : 'Detached HEAD')} sub={`this branch · ${own.length}${stack?.more === true ? '+' : ''} ${own.length === 1 ? 'commit' : 'commits'}${stack?.pr === undefined ? '' : ` · #${stack.pr.number} ${stack.pr.state}`}`} className="branch current" before={<BranchIcon />} />}
          {stacked && !isOpen(state, 'branch') ? null : own.length === 0 ? (
            <p class="tree-note" style={`--depth: ${ownDepth}`}>
              No commits on this branch yet. They appear here when the session commits.
            </p>
          ) : (
            own.map((sha) => <CommitRow sha={sha} info={commits.get(sha)} depth={ownDepth} state={state} now={now} shown={shown} />)
          )}
          {below.map((link) => (
            <LinkRows link={link} state={state} now={now} shown={shown} commits={commits} />
          ))}
          {stack?.incomplete === true ? <p style="--depth: 1" class="tree-note">The stack is incomplete: a base could not be found or measured, so it ends at the default branch.</p> : null}
          {stack?.github.state === 'stale' || stack?.github.state === 'unavailable' ? (
            <p style="--depth: 1" class="tree-note" title={stack.github.reason}>
              {stack.github.state === 'stale' ? `GitHub could not be read, so its stack is from ${ago(stack.github.observedAt ?? 0, now)}.` : `GitHub could not be read: ${stack.github.reason ?? 'no reason given'}.`}
            </p>
          ) : null}
          {!stacked || stack?.main.ref == null ? null : (
            <TreeRow depth={1} action="tree-noop" label={stack.main.ref.slice(stack.main.ref.indexOf('/') + 1)} sub={[stack.main.behind === null ? null : `behind ${stack.main.behind}`, stack.main.fetchedAt === null ? 'never fetched here' : `last fetch here ${ago(stack.main.fetchedAt, now)}`].filter((one) => one !== null).join(' · ')} className="branch default-branch" before={<BranchIcon />}>
              <RangeLink range={{ from: 'base', to: 'worktree' }} title="Show every change since the default branch" />
            </TreeRow>
          )}
        </div>
      )}
    </>
  );
}

function ChangedFiles({ state }: { state: TreeState }): VNode {
  const rows = (state.uncommitted?.rows ?? []).filter((row) => matches(state, row.path));

  if (state.uncommitted === null) {
    return <p class="tree-note">Reading the changes…</p>;
  }

  if (state.uncommitted.rows.length === 0) {
    return <p class="tree-note">No uncommitted changes.</p>;
  }

  return (
    <div class="tree-section" role="group" aria-label="Uncommitted files">
      {rows.map((row: ChangeRow) => (
        <TreeRow
          depth={1}
          action="tree-file-change"
          data={{ path: row.path }}
          label={baseName(row.path)}
          sub={dirName(row.path)}
          status={row.status}
          title={row.path}
          className={`file status-${row.status}${row.viewed === true ? ' viewed' : ''}`}
          before={
            <label class="tree-viewed" title={row.viewed === true ? 'Viewed; untick to read it again' : 'Mark viewed'}>
              <input type="checkbox" data-action="tree-viewed" data-path={row.path} checked={row.viewed === true} aria-label={`Viewed ${row.path}`} />
            </label>
          }
        />
      ))}
    </div>
  );
}

function AllFiles({ state, dir, depth, all, ignored }: { state: TreeState; dir: string; depth: number; all?: readonly string[]; ignored?: IgnoredSet }): VNode {
  const tree = state.tree;

  if (tree === null) {
    return <p class="tree-note">Reading the files…</p>;
  }

  const status = new Map((state.uncommitted?.rows ?? []).map((row) => [row.path, row.status]));
  // Filtering by name shows every matching file flat, as the tree's folders would hide them; as VS Code's file search does, it leaves out what git ignores.
  const query = state.text ? '' : state.query.trim();

  if (query !== '' && dir === '') {
    const found = tree.paths.filter((path) => matches(state, path)).slice(0, 500);

    return (
      <div class="tree-section" role="group" aria-label="Files">
        {found.map((path) => (
          <TreeRow depth={1} action="tree-disk" data={{ path }} label={baseName(path)} sub={dirName(path)} status={status.get(path)} title={path} className={`file status-${status.get(path) ?? ''}`} icon={<FileIcon path={path} />} />
        ))}
        {found.length === 0 ? <p class="tree-note">No file names match.</p> : null}
      </div>
    );
  }

  // What git ignores is listed with the rest, drawn muted as VS Code draws it; an ignored folder's entries are read when it is opened.
  const known = ignored ?? ignoredSet(state);
  const paths = all ?? [...tree.paths, ...(tree.ignored ?? []), ...[...state.ignored.values()].flatMap((one) => (Array.isArray(one) ? one : []))];
  const { dirs, files } = folderEntries(paths, dir);
  const read = state.ignored.get(dir);
  const muted = (path: string) => (isIgnored(known, path) ? ' ignored' : '');

  return (
    <div class="tree-section" role="group" aria-label={dir === '' ? 'Files' : `Files in ${dir}`}>
      {read === 'loading' ? (
        <p class="tree-note" style={`--depth: ${depth}`}>
          Reading the folder…
        </p>
      ) : read !== undefined && !Array.isArray(read) ? (
        <p class="tree-note error" style={`--depth: ${depth}`}>
          {read.error}
        </p>
      ) : null}
      {dirs.map((one) => {
        const open = state.open.has(`dir:${one}`);

        return (
          <>
            <TreeRow depth={depth} action="tree-toggle" data={{ key: `dir:${one}` }} open={open} label={baseName(one)} title={one} className={`folder${muted(one)}`} />
            {open ? <AllFiles state={state} dir={one} depth={depth + 1} all={paths} ignored={known} /> : null}
          </>
        );
      })}
      {files.map((path) => (
        <TreeRow depth={depth} action="tree-disk" data={{ path }} label={baseName(path)} status={status.get(path)} title={path} className={`file status-${status.get(path) ?? ''}${muted(path)}`} icon={<FileIcon path={path} />} />
      ))}
      {dir === '' && tree.more ? <p class="tree-note">Only the first {tree.paths.length} files are listed.</p> : null}
      {Array.isArray(read) && read.length === 0 ? (
        <p class="tree-note" style={`--depth: ${depth}`}>
          Empty folder.
        </p>
      ) : null}
    </div>
  );
}

function LinkRows({ link, state, now, shown, commits }: { link: StackLink; state: TreeState; now: number; shown: TreeRange; commits: Map<string, CommitInfo & { files?: string[] }> }): VNode {
  const key = `link:${link.name}`;
  // While filtering, a base opens to show its commits that match, as their branch's do.
  const open = link.actions.expand && (state.open.has(key) || (filtering(state) && link.commitIds.some((sha) => commitMatches(state, sha, commits.get(sha)))));

  return (
    <>
      <TreeRow depth={1} action={link.actions.expand ? 'tree-toggle' : 'tree-noop'} data={{ key }} {...(link.actions.expand ? { open } : {})} label={link.name} sub={linkInfo(link)} title={link.tip ?? link.name} className="branch base" before={<BranchIcon />}>
        {link.forkPoint === null ? null : <RangeLink range={{ from: link.forkPoint, to: 'worktree' }} title={`Show every change since ${link.name}`} disabled={!link.actions.diffSince} />}
        {link.forkPoint === null ? null : <MenuButton point={link.forkPoint} state={state} label={link.name} />}
        {link.pr === undefined ? null : (
          <a class="tree-link" href={link.pr.url} target="_blank" rel="noopener noreferrer" title={`Pull request #${link.pr.number}, ${link.pr.state}`}>
            #{link.pr.number}
          </a>
        )}
      </TreeRow>
      {open ? link.commitIds.map((sha) => <CommitRow sha={sha} info={commits.get(sha)} depth={2} state={state} now={now} shown={shown} />) : null}
      {open && link.more ? (
        <p class="tree-note" style="--depth: 2">
          Only the latest {link.commitIds.length} commits are listed.
        </p>
      ) : null}
    </>
  );
}

/** A branch stacked on this one in a GitHub stack: a summary that links out, with no comparison, since its commits are not on this branch. */
function UpperRow({ link }: { link: StackLink }): VNode {
  return (
    <TreeRow depth={1} action="tree-noop" label={link.name} sub={linkInfo(link)} title={`${link.name}, stacked on this branch`} className="branch above" before={<BranchIcon />}>
      {link.pr === undefined ? null : (
        <a class="tree-link" href={link.pr.url} target="_blank" rel="noopener noreferrer" title={`Pull request #${link.pr.number}, ${link.pr.state}`}>
          #{link.pr.number}
        </a>
      )}
    </TreeRow>
  );
}
