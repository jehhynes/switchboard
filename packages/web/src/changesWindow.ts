// Which files' diffs the Changes tab reads and holds (architecture.md § Web page, Changes tab): the files on screen and the next one, three
// reads at a time, nothing before the view has a size, and at most DIFF_BUDGET characters of patch and side text held, the furthest from the
// view given up first.

/** The most diff reads on their way at once. */
export const MAX_IN_FLIGHT = 3;
/** How many rows past the last on screen, and before the first, are read ahead. */
export const READ_AHEAD = 1;
export const READ_BEHIND = 0;
/** The most characters of patch and side text the page holds for the Changes tab, about 24 MB. */
export const DIFF_BUDGET = 24 * 1024 * 1024;

/**
 * What a held diff was read for: the base, the row's paths, its status and its content's hash, since the hash alone is the file on disk and is
 * `deleted` for every deleted file, so a moved merge base would otherwise go unnoticed.
 */
export function rowKey(base: string | null, row: { path: string; from?: string; status: string; hash: string }): string {
  return JSON.stringify([base, row.path, row.from ?? null, row.status, row.hash]);
}

/** The rows to read, by index, in the order to read them: those on screen, then the next one. */
export function wantedIndexes(visible: { first: number; last: number } | null, count: number): number[] {
  if (visible === null || count === 0) {
    return [];
  }

  const wanted: number[] = [];
  const last = Math.min(visible.last, count - 1);

  for (let index = visible.first; index <= last; index++) {
    wanted.push(index);
  }

  for (let index = last + 1; index <= Math.min(count - 1, last + READ_AHEAD); index++) {
    wanted.push(index);
  }

  for (let index = visible.first - 1; index >= Math.max(0, visible.first - READ_BEHIND); index--) {
    wanted.push(index);
  }

  return wanted;
}

export interface HeldDiff {
  path: string;
  /** Its index among the rows shown, -1 when it is no longer shown. */
  index: number;
  chars: number;
  /** Whether its sides were read too, for an expanded region. */
  hydrated: boolean;
}

/**
 * The held diffs to give up so what is held fits `budget`: never one in `wanted`; those whose sides were read first, then the furthest from
 * the view (`visible`), a row no longer shown first of all.
 */
export function evictions(held: HeldDiff[], wanted: ReadonlySet<string>, visible: { first: number; last: number } | null, budget = DIFF_BUDGET): string[] {
  let total = held.reduce((sum, one) => sum + one.chars, 0);

  if (total <= budget) {
    return [];
  }

  const distance = (one: HeldDiff): number =>
    one.index === -1 ? Infinity : visible === null ? one.index : one.index < visible.first ? visible.first - one.index : Math.max(0, one.index - visible.last);
  const order = held.filter((one) => !wanted.has(one.path)).sort((a, b) => Number(b.hydrated) - Number(a.hydrated) || distance(b) - distance(a));
  const out: string[] = [];

  for (const one of order) {
    if (total <= budget) {
      break;
    }

    out.push(one.path);
    total -= one.chars;
  }

  return out;
}
/** The most changed lines a file's diff shows on its own; past it the file starts collapsed and is read only when expanded. */
export const LARGE_LINES = 1500;
/** Lock files, minified files, snapshots and build output: generated, so they start collapsed. */
const GENERATED = /(^|\/)(package-lock\.json|[^/]*\.lock|[^/]*\.min\.[^/]+|[^/]*\.snap)$|(^|\/)dist\//;

/**
 * Why a row starts collapsed and is read only when expanded: a binary file, a generated one, or one with more than {@link LARGE_LINES} changed
 * lines or too large for the hub to count; null for any other.
 */
export function largeReason(row: { path: string; additions: number | null; deletions: number | null; binary: boolean }): 'binary' | 'generated' | 'large' | null {
  if (row.binary) {
    return 'binary';
  }

  if (GENERATED.test(row.path)) {
    return 'generated';
  }

  // No counts for a file that is not binary: the hub left it uncounted, as it does past its size caps.
  if (row.additions === null && row.deletions === null) {
    return 'large';
  }

  return (row.additions ?? 0) + (row.deletions ?? 0) > LARGE_LINES ? 'large' : null;
}
