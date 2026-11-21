export { changesPlan, MAX_ROWS } from '@switchboard/core';
export type { ChangedPath, ChangeKind, ChangesPlan, ChangesRequest, DiffRow, DiffSide } from '@switchboard/core';

/** Paths compare without case or separator differences, as on Windows. */
function pathKey(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

export function noRepository(wanted: string): string {
  return `VS Code has no repository at ${wanted}. Check that the worktree still exists and that Git is enabled.`;
}

/** VS Code can answer with a prefix match or the window's only repository, such as the main clone for a worktree (GC M30). */
export function repositoryRefusal(wanted: string, answered: string): string | null {
  return pathKey(answered) === pathKey(wanted) ? null : `VS Code selected ${answered} instead of ${wanted}.`;
}
