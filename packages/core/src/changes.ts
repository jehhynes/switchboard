// The rows of a worktree's changes from its merge base to disk (PRD R57, R118), for the web page's Changes list.
/** Change type within one stage. */
export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface ChangedPath {
  path: string;
  kind: ChangeKind;
  /** Previous path for a rename; absent for other changes. */
  from?: string;
}

/** A diff side's path and revision; a null ref is the file on disk. */
export interface DiffSide {
  path: string;
  ref: string | null;
}

/** A null original is an addition; a null modified is a deletion. */
export interface DiffRow {
  original: DiffSide | null;
  modified: DiffSide | null;
}

/** Committed, staged and working-tree changes stay separate, because a path can change differently in each, such as a staged edit then deleted on disk. */
export interface ChangesRequest {
  /** The editor tab title. */
  label: string;
  /** The merge base, or null to show uncommitted changes only. */
  base: string | null;
  /** `base...HEAD`, empty when there is no base. */
  committed: readonly ChangedPath[];
  /** The index against HEAD. */
  staged: readonly ChangedPath[];
  /** The working tree against the index, untracked files included. */
  working: readonly ChangedPath[];
}

export type ChangesPlan = { refusal: 'no-changes'; message: string } | { title: string; rows: DiffRow[]; shown: number; total: number };

/** Most diff resources sent to the editor; the title says when a branch has more. */
export const MAX_ROWS = 400;

/** Paths compare without case or separator differences, as on Windows. */
function pathKey(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

/** A file's path at the base and now. */
interface Chain {
  basePath: string;
  existedAtBase: boolean;
  /** Null after a deletion; a later file at the same path continues the chain. */
  nowPath: string | null;
}

/**
 * Applies changes by their previous path, so a rename continues its file's chain. A rename onto the path of a deleted file takes
 * that file's base when it has none of its own, and otherwise leaves the deleted file in `displaced`, so its deletion still shows.
 */
function advance(chains: Map<string, Chain>, displaced: Chain[], changes: readonly ChangedPath[]): void {
  for (const change of changes) {
    const before = change.from ?? change.path;
    const chain = chains.get(pathKey(before)) ?? { basePath: before, existedAtBase: change.kind !== 'added', nowPath: before };
    const previous = change.from === undefined ? undefined : chains.get(pathKey(change.path));

    chains.delete(pathKey(before));
    chain.nowPath = change.kind === 'deleted' ? null : change.path;

    if (previous !== undefined && previous !== chain) {
      if (!chain.existedAtBase && previous.existedAtBase) {
        chain.basePath = previous.basePath;
        chain.existedAtBase = true;
      } else {
        displaced.push(previous);
      }
    }

    chains.set(pathKey(change.path), chain);
  }
}

/** Combines the three stages into base-to-disk rows, following renames and leaving out files added then deleted. */
export function changesPlan(request: ChangesRequest): ChangesPlan {
  const chains = new Map<string, Chain>();
  const displaced: Chain[] = [];

  advance(chains, displaced, request.committed);
  advance(chains, displaced, request.staged);
  advance(chains, displaced, request.working);

  const ref = request.base ?? 'HEAD';
  const rows: DiffRow[] = [];

  for (const chain of [...chains.values(), ...displaced]) {
    if (chain.existedAtBase || chain.nowPath !== null) {
      rows.push({
        original: chain.existedAtBase ? { path: chain.basePath, ref } : null,
        modified: chain.nowPath === null ? null : { path: chain.nowPath, ref: null },
      });
    }
  }

  if (rows.length === 0) {
    return {
      refusal: 'no-changes',
      message: request.base === null ? `${request.label}: no uncommitted changes, and no merge base was found.` : `${request.label}: no changes since the merge base.`,
    };
  }

  const pathOf = (row: DiffRow) => row.modified?.path ?? row.original?.path ?? '';

  rows.sort((a, b) => (pathOf(a) < pathOf(b) ? -1 : pathOf(a) > pathOf(b) ? 1 : 0));

  const shown = rows.slice(0, MAX_ROWS);
  const scope = request.base === null ? 'uncommitted only, no merge base' : `since ${request.base.slice(0, 7)}`;
  const cut = shown.length === rows.length ? '' : `, first ${shown.length} of ${rows.length}`;

  // The editor appends the file count.
  return { title: `${request.label} — ${scope}${cut}`, rows: shown, shown: shown.length, total: rows.length };
}
