import { readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { hostKey, isFolderHost } from '@switchboard/core';
import type { Store } from '@switchboard/core';
import { SKIPPED } from './page.js';

/**
 * A folder as the hub records it: its real path, which resolves links and, on Windows, the case of each name, so every spelling of one folder
 * gives one path; null for a path that is not a readable folder, or one whose name ends in `.code-workspace`, which `windowOf` would read as a
 * workspace file (`isFolderHost`).
 */
export function canonicalFolder(path: string): string | null {
  try {
    const real = realpathSync.native(path);

    return statSync(real).isDirectory() && isFolderHost(real) ? real : null;
  } catch {
    return null;
  }
}

/** The most subfolders `listFolder` answers. */
export const FOLDERS_LISTED = 500;

/** The folders the New session form offers first (PRD R122), which also bound a paired device's folders (architecture.md § Remote access). */
export interface FolderRoots {
  /** The folders new work was last created in, newest first. */
  recent: string[];
  repoRoots: string[];
  /** The worktrees of work items that are not done. */
  worktrees: string[];
}

/** The starting places of the New session form's folder list and the page's folder browser. */
export interface FolderPlaces extends FolderRoots {
  /** On this computer's page only: the home folder, then each drive or the file system's root. */
  computer: string[];
}

/** A folder's subfolders as the page's folder browser lists them. */
export interface FolderListing {
  /** The folder's canonical path. */
  path: string;
  /** Its parent, or null at a drive's root or, on a paired device, at the top of an allowed folder. */
  parent: string | null;
  folders: { name: string; path: string }[];
  /** Whether more than `FOLDERS_LISTED` subfolders were left out. */
  more: boolean;
}

/** Whether canonical `folder` is canonical `root` or inside it, in any spelling `hostKey` treats as one. */
function within(folder: string, root: string): boolean {
  const inner = hostKey(folder);
  const outer = hostKey(root).replace(/\/+$/, '');

  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * The hub's folder check for new work (PRD R122): `path` as a canonical folder, which resolves links, when it is an absolute path to a readable
 * folder and, for a paired device (`roots` given), when it is one of `roots` or inside one, so no link leads a paired device out of them;
 * else why not.
 */
export function allowedFolder(path: string, roots: readonly string[] | null): { folder: string } | { error: string } {
  const typed = path.trim();
  const folder = typed !== '' && isAbsolute(typed) ? canonicalFolder(typed) : null;

  if (folder === null) {
    return { error: `${typed === '' ? 'The folder' : typed} is not a folder a session can run in.` };
  }

  if (roots !== null && !roots.some((root) => {
    const real = canonicalFolder(root);

    return real !== null && within(folder, real);
  })) {
    return { error: `${typed} is not in a recent folder, a repo root or a worktree. Choose it on the computer that runs Switchboard first.` };
  }

  return { folder };
}

/** Every folder of `roots`, recent ones first. */
export function rootList(roots: FolderRoots): string[] {
  return [...roots.recent, ...roots.repoRoots, ...roots.worktrees];
}

/**
 * The form's starting places: the recent folders, repo roots and worktrees that are still folders, each once in its first group, and on this
 * computer's page (`local`) the home folder and the drives.
 */
export async function folderPlaces(roots: FolderRoots, local: boolean, platform: NodeJS.Platform = process.platform): Promise<FolderPlaces> {
  const seen = new Set<string>();
  const group = (folders: readonly string[]): string[] =>
    folders.filter((folder) => {
      const key = hostKey(folder);

      if (seen.has(key) || canonicalFolder(folder) === null) {
        return false;
      }

      seen.add(key);
      return true;
    });
  const recent = group(roots.recent);
  const repoRoots = group(roots.repoRoots);
  const worktrees = group(roots.worktrees);

  return { recent, repoRoots, worktrees, computer: local ? [homedir(), ...(await drives(platform))] : [] };
}

/** The drives that answer, C: to Z:, on Windows; the file system's root elsewhere. */
async function drives(platform: NodeJS.Platform): Promise<string[]> {
  if (platform !== 'win32') {
    return ['/'];
  }

  const letters = [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:\\`);
  const found = await Promise.all(letters.map((drive) => stat(drive).then((info) => info.isDirectory(), () => false)));

  return letters.filter((_, index) => found[index]);
}

/**
 * The page's folder browser (PRD R122): the subfolders of `path`, names only, sorted, leaving out dot folders, build output (`SKIPPED`) and,
 * for a paired device, links that lead out of `roots`; at most `FOLDERS_LISTED`. A path `allowedFolder` refuses answers why.
 */
export async function listFolder(path: string, roots: readonly string[] | null): Promise<FolderListing | { error: string }> {
  const allowed = allowedFolder(path, roots);

  if ('error' in allowed) {
    return allowed;
  }

  const folder = allowed.folder;
  let entries;

  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return { error: `${folder} cannot be read.` };
  }

  const names = entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.') && !entry.name.startsWith('$') && !SKIPPED.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  const folders: FolderListing['folders'] = [];
  let more = false;

  for (const entry of names) {
    const child = join(folder, entry.name);

    // A link or junction is listed only where it leads to a folder this device may use.
    if (entry.isSymbolicLink() && 'error' in allowedFolder(child, roots)) {
      continue;
    }

    if (folders.length === FOLDERS_LISTED) {
      more = true;
      break;
    }

    folders.push({ name: entry.name, path: child });
  }

  const up = dirname(folder);
  const parent = up === folder || 'error' in allowedFolder(up, roots) ? null : up;

  return { path: folder, parent, folders, more };
}

/** The `pagePrefs` entry set once the dock's recent folders were imported. */
const DOCK_FOLDERS_IMPORTED = 'dockFoldersImported';

/**
 * Adds the folders the dock kept in `<home>/dock.json` (`recentFolders`) to the store's recent folders, once: the dock and every page share the
 * store's since PRD R122. A missing or unreadable file imports nothing.
 */
export function importDockFolders(store: Pick<Store, 'pagePref' | 'setPagePref' | 'rememberFolders' | 'recentFolders'>, home: string, same: (a: string, b: string) => boolean): void {
  if (store.pagePref(DOCK_FOLDERS_IMPORTED) !== null) {
    return;
  }

  let folders: string[] = [];

  try {
    const kept = (JSON.parse(readFileSync(join(home, 'dock.json'), 'utf8')) as { recentFolders?: unknown }).recentFolders;

    folders = Array.isArray(kept) ? kept.filter((one): one is string => typeof one === 'string' && one.trim() !== '') : [];
  } catch {
    // No dock.json, or none the dock wrote.
  }

  // After the hub's own, which are newer.
  store.rememberFolders([...store.recentFolders(), ...folders], same);
  store.setPagePref(DOCK_FOLDERS_IMPORTED, '1');
}
