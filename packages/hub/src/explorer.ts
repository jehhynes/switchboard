import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { artifactsDir } from '@switchboard/core';
import type { Settings, Store } from '@switchboard/core';
import { ignoredByGit, nodeGit } from './changes.js';
import type { Git } from './changes.js';
import type { WindowScope } from './windows.js';

/**
 * Which folders git ignores the Changes tree's Explore shows (operator decision 2026-11-27; architecture.md § Web page, Changes): `.wip`, which
 * holds the work item's artifact folder, the folders its source's `explorerFolders` names, and the folders the hub learned from artifact tags
 * that named a file in them. Everything else git ignores stays hidden, and `.git` and node_modules always do.
 */
export const DEFAULT_EXPLORER_FOLDERS: readonly string[] = ['.wip'];

/** Names Explore never shows, at any depth, as VS Code's `files.exclude` hides `.git` (and, the operator's choice of 2026-11-27, node_modules). */
export const HIDDEN_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/** Whether a path has a name Explore hides in it. */
export function hiddenPath(path: string): boolean {
  return path.split('/').some((part) => part !== '' && HIDDEN_NAMES.has(part.toLowerCase()));
}

const fold = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);

/** Whether a path is one of `folders` or inside one. */
export function insideFolders(folders: readonly string[], path: string): boolean {
  const own = fold(path);

  return folders.some((folder) => own === fold(folder) || own.startsWith(`${fold(folder)}/`));
}

/**
 * Whether Explore shows an ignored entry of the tree, a folder written `<path>/`: one inside a shown folder, or a folder on the way to one,
 * such as `out/` for a shown `out/reports`.
 */
export function shownIgnored(folders: readonly string[], entry: string): boolean {
  const folder = entry.endsWith('/');
  const path = entry.replace(/\/$/, '');

  return insideFolders(folders, path) || (folder && folders.some((one) => fold(one).startsWith(`${fold(path)}/`)));
}

/** A path relative to `top` with forward slashes, or null when it is `top` itself or outside it. */
function inside(top: string, real: string): string | null {
  const rel = relative(top, real);

  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel.split(sep).join('/');
}

export interface ExplorerDeps {
  store: Pick<Store, 'explorerFolders' | 'addExplorerFolder' | 'workItem' | 'ticket'>;
  settings(): Settings;
  git?: Git;
  now(): number;
}

/** The folders git ignores that Explore shows in the selected conversation's folder: the defaults, the work item's artifact folder, its source's and the learned ones. */
export async function explorerFolders(deps: ExplorerDeps, scope: WindowScope): Promise<string[]> {
  if (scope.cwd == null) {
    return [...DEFAULT_EXPLORER_FOLDERS];
  }

  const top = await realpath(scope.cwd).catch(() => null);
  const item = scope.workItemId == null ? null : deps.store.workItem(scope.workItemId);
  const source = item == null ? null : (deps.store.ticket(item.ticketId)?.source ?? null);
  const artifacts = top === null || scope.workItemId == null ? null : inside(top, artifactsDir(top, scope.workItemId));
  const folders = [...DEFAULT_EXPLORER_FOLDERS, ...(artifacts === null ? [] : [artifacts]), ...((source === null ? undefined : deps.settings().sources[source]?.explorerFolders) ?? []), ...(top === null ? [] : deps.store.explorerFolders(top))];

  return [...new Set(folders)].filter((folder) => !hiddenPath(folder));
}

/**
 * Learns the folder of a file an artifact tag named, when the file is inside the session's worktree (its git top), git ignores the file, and
 * Explore does not show its folder already: Explore then shows it in that worktree from now on. Whether it learned one.
 */
export async function learnExplorerFolder(deps: ExplorerDeps, cwd: string, real: string): Promise<boolean> {
  const git = deps.git ?? nodeGit;
  const shown = await git(['rev-parse', '--show-toplevel'], cwd);
  const top = shown.code === 0 ? await realpath(shown.stdout.toString('utf8').trim()).catch(() => null) : null;
  const folder = top === null ? null : inside(top, dirname(real));

  if (top === null || folder === null || hiddenPath(folder) || insideFolders([...DEFAULT_EXPLORER_FOLDERS, ...deps.store.explorerFolders(top)], folder)) {
    return false;
  }

  // The file itself: a folder git does not ignore can hold one it does, as *.log ignores a log beside the code.
  if (!(await ignoredByGit(top, inside(top, real)!, git))) {
    return false;
  }

  return deps.store.addExplorerFolder(top, folder, deps.now());
}
