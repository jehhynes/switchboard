import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { looksBinary } from './changes.js';

/** The most bytes of a text, code or Markdown file the page is sent. */
export const LOCAL_TEXT_MAX_BYTES = 4 * 1024 * 1024;
/** The most bytes of a picture or PDF the page is sent. */
export const LOCAL_RAW_MAX_BYTES = 32 * 1024 * 1024;
/** The most entries a folder's listing holds. */
export const LOCAL_DIR_MAX = 500;
/** Why a paired device gets no folder and no file outside its session's working folder and work item's checkouts (architecture.md § Remote access). */
export const LOCAL_FILES_PAIRED_ONLY = 'On a paired device, only files in the session’s working folder and its work item’s worktree and repository open, not folders or files elsewhere.';

const IMAGES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml' };
const MARKDOWN = new Set(['md', 'markdown']);

/**
 * Where a page's local file links may read (architecture.md § Web page): the selected conversation's folder and every working folder of its work
 * item's sessions, which hold its `.wip` and artifact folders, and the Claude scratchpad of each of those sessions, found by its Claude session
 * ID under `<temp>/claude/<project>/<session ID>/scratchpad`.
 */
export interface LocalRoots {
  /** Relative links resolve against this folder: the current session's working folder. */
  cwd: string | null;
  folders: string[];
  /** The Claude session IDs whose scratchpads may be read. */
  sessionIds: string[];
  /** Single files that may be read wherever they are, such as the selected work item's approval draft, except inside `never`. */
  files?: string[];
  /** Folders nothing is read from, through `files` or any root, such as the Switchboard home, which holds the hub's keys and sign-ins. */
  never?: string[];
  /** Whether a folder's entries may be listed; false for a paired device. */
  listFolders?: boolean;
  /** The temporary folder Claude Code keeps its own folder in ({@link claudeTempName}); the system's by default. */
  temp?: string;
}

/** The name of Claude Code's folder in the temporary folder: `claude` on Windows, `claude-<user ID>` elsewhere. */
export function claudeTempName(platform: NodeJS.Platform = process.platform, uid: number | undefined = process.getuid?.()): string {
  return platform === 'win32' || uid === undefined ? 'claude' : `claude-${uid}`;
}

/**
 * The roots of a page's selected conversation: relative links against its current session's working folder; its own folders, each of its
 * work item's sessions' working folders and its work item's checkouts (`checkouts`: its ticket's worktree and the repository root it belongs
 * to); and those sessions' Claude session IDs, earlier ones a fork or a clear replaced included. For a paired device (`paired`), only the
 * working folder the current session runs in, or the checkout before its first session, and the work item's checkouts, with no scratchpad and
 * no folder listing (architecture.md § Remote access).
 */
export function localRoots(
  scope: { folder: string | null; cwd: string | null },
  sessions: ReadonlyArray<{ id: string; cwd: string; nativeSessionId: string | null; retiredIds: readonly string[] }>,
  currentId: string | null,
  paired = false,
  checkouts: ReadonlyArray<string | null> = [],
): LocalRoots {
  const current = sessions.find((one) => one.id === currentId);
  const named = (one: string | null | undefined): one is string => typeof one === 'string' && one !== '';
  const cwd = current?.cwd || scope.cwd || scope.folder;

  if (paired) {
    // One folder only, even should the scope's folder ever differ from the session's.
    return { cwd, folders: [current?.cwd || scope.cwd, ...checkouts].filter(named), sessionIds: [], listFolders: false };
  }

  return {
    cwd,
    folders: [scope.folder, scope.cwd, ...sessions.map((one) => one.cwd), ...checkouts].filter(named),
    sessionIds: sessions.flatMap((one) => [one.nativeSessionId, ...one.retiredIds]).filter(named),
  };
}

/**
 * The main checkout a git worktree belongs to, read from its `.git` file (`gitdir: <main>/.git/worktrees/<name>`) and that folder's
 * `commondir`; the folder itself when its `.git` is a folder; null when it is no checkout or its repository is bare. Runs no git process.
 */
export async function mainCheckout(worktree: string): Promise<string | null> {
  const dotGit = join(worktree, '.git');
  const info = await stat(dotGit).catch(() => null);

  if (info === null) {
    return null;
  }

  if (info.isDirectory()) {
    return worktree;
  }

  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8').catch(() => ''));

  if (pointer === null) {
    return null;
  }

  const gitDir = resolve(worktree, pointer[1]!);
  const common = (await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => null))?.trim();
  const commonDir = common === undefined || common === '' ? null : resolve(gitDir, common);

  if (commonDir === null || basename(commonDir).toLowerCase() !== '.git') {
    return null;
  }

  // The repository must list this worktree as its own: its `worktrees/<name>` folder, whose `gitdir` file names this worktree's `.git`, so a
  // `.git` file pointed at another repository gains no root.
  const back = (await readFile(join(gitDir, 'gitdir'), 'utf8').catch(() => null))?.trim();
  const [listed, own, entry, entries, realCommon] = await Promise.all([
    back === undefined || back === '' ? null : realpath(resolve(gitDir, back)).catch(() => null),
    realpath(dotGit).catch(() => null),
    realpath(gitDir).catch(() => null),
    realpath(join(commonDir, 'worktrees')).catch(() => null),
    realpath(commonDir).catch(() => null),
  ]);

  // The real repository's folder, never the folder of a link that leads to its .git.
  const owned = listed !== null && listed === own && entry !== null && entries !== null && dirname(entry) === entries;

  return owned && realCommon !== null && basename(realCommon).toLowerCase() === '.git' ? dirname(realCommon) : null;
}

export type LocalKind = 'text' | 'markdown' | 'image' | 'pdf' | 'binary' | 'dir';

export interface LocalEntry {
  name: string;
  dir: boolean;
}

/** A local file or folder as the page shows it. `path` is its real path with forward slashes. */
export interface LocalFileView {
  path: string;
  name: string;
  kind: LocalKind;
  contents: string | null;
  tooLarge: boolean;
  size: number | null;
  entries: LocalEntry[] | null;
  /** The folder had more entries than the listing holds. */
  more: boolean;
  /** A picture's or PDF's modification time in epoch milliseconds, whose bytes the view does not carry, so a change to it changes the view; null otherwise. */
  modified: number | null;
  /** The work item's artifact this file is, by real path (`openPageFile`), so the page shows that artifact's tab in place of a file tab. */
  artifact?: string;
}

/**
 * A link's target as an absolute path, or null for one that names no local path: a `file:` URI, an absolute path, or a path relative to
 * `cwd`. Any other scheme, a NUL, or a relative path with no `cwd` is refused. A drive letter is a path, not a scheme.
 */
export function localTarget(target: string, cwd: string | null): string | null {
  if (target.length === 0 || target.length > 4096 || target.includes('\0')) {
    return null;
  }

  let path = target;

  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(new URL(path));
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
    return null;
  } else if (/^[\\/][a-z]:[\\/]/i.test(path)) {
    // A drive path written with a leading slash, as a file URI's path is ("/D:/git/…"), names that drive, not a folder "D:" on the current one.
    path = path.slice(1);
  }

  if (isAbsolute(path)) {
    return resolve(path);
  }

  return cwd === null ? null : resolve(cwd, path);
}

/** Whether `real` is one of the roots' single files: a regular file, by real path, outside every `never` folder. */
async function singleFile(roots: LocalRoots, real: string): Promise<boolean> {
  const named = await Promise.all((roots.files ?? []).map((one) => realpath(one).catch(() => null)));

  if (!named.includes(real) || !(await stat(real).catch(() => null))?.isFile()) {
    return false;
  }

  for (const folder of roots.never ?? []) {
    const top = await realpath(folder).catch(() => null);

    // A folder that cannot be resolved may still hold the file under another spelling, so it refuses.
    if (top === null || under(top, real)) {
      return false;
    }
  }

  return true;
}

/** Whether `real` is `root` or lies under it. */
function under(root: string, real: string): boolean {
  const inside = relative(root, real);

  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

/**
 * The real path of a link's target when it lies in one of the roots, or null: resolved by real path, so a link or junction out of a root is
 * refused, a `.git` folder is never read, and a root that is a drive or filesystem root is no root.
 */
export async function allowedPath(roots: LocalRoots, target: string): Promise<string | null> {
  const wanted = localTarget(target, roots.cwd);
  const real = wanted === null ? null : await realpath(wanted).catch(() => null);

  // Nothing in or of a .git folder, wherever it is, a root that is one included.
  if (real === null || real.split(sep).some((part) => part.toLowerCase() === '.git')) {
    return null;
  }

  // Nothing in a never folder, such as the Switchboard home a session's home folder holds, through any root.
  for (const folder of roots.never ?? []) {
    const top = await realpath(folder).catch(() => null);

    if (top !== null && under(top, real)) {
      return null;
    }
  }

  if ((roots.files ?? []).length > 0 && (await singleFile(roots, real))) {
    return real;
  }

  for (const folder of new Set(roots.folders)) {
    const top = await realpath(folder).catch(() => null);

    if (top !== null && parse(top).root !== top && under(top, real)) {
      return real;
    }
  }

  const claude = await realpath(join(roots.temp ?? tmpdir(), claudeTempName())).catch(() => null);
  const inside = claude === null ? null : relative(claude, real);

  if (claude === null || inside === null || inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return null;
  }

  // <project>/<session ID>/scratchpad/...
  const [project, sessionId, scratchpad] = inside.split(sep);

  if (project === undefined || sessionId === undefined || scratchpad !== 'scratchpad' || !roots.sessionIds.includes(sessionId)) {
    return null;
  }

  return under(join(claude, project, sessionId, scratchpad), real) ? real : null;
}

const slashed = (path: string): string => path.split(sep).join('/');
const extOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  const dot = name.lastIndexOf('.');

  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/** A picture's or a PDF's media type, the only files sent as bytes; null for any other. */
export function rawMime(path: string): string | null {
  const ext = extOf(path);

  return ext === 'pdf' ? 'application/pdf' : (IMAGES[ext] ?? null);
}

/** A local file or folder as read: its view, and for a picture or PDF the open handle its bytes are sent from, which the caller closes. */
export interface LocalOpened {
  real: string;
  view: LocalFileView;
  handle: FileHandle | null;
}

/** Whether the path still passes {@link allowedPath} as the same real path, and still names the file or folder `info` describes. */
async function unchanged(roots: LocalRoots, real: string, info: BigIntStats): Promise<boolean> {
  const again = await allowedPath(roots, real);
  const now = again === real ? await stat(real, { bigint: true }).catch(() => null) : null;

  return now !== null && now.ino === info.ino && now.dev === info.dev;
}

/** At most `cap` bytes from an open file: `large` when it holds more, so a file that grows while it is read is still cut there. */
async function readHandle(handle: FileHandle, cap: number): Promise<Buffer | 'large' | null> {
  try {
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;

    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);

      length += bytesRead;

      if (bytesRead === 0 || length > cap) {
        break;
      }
    }

    return length > cap ? 'large' : buffer.subarray(0, length);
  } catch {
    return null;
  }
}

/**
 * {@link openLocalFile} for a page: a file read that is one of the work item's artifacts, as `artifactAt` names by its real path, carries that
 * artifact's name (architecture.md § Web page). A refused read is never named, so naming one tells a page nothing it may not read.
 */
export async function openPageFile(roots: LocalRoots, target: string, artifactAt: (real: string) => string | null): Promise<LocalOpened | null> {
  const opened = await openLocalFile(roots, target);
  const artifact = opened === null || opened.view.kind === 'dir' ? null : artifactAt(opened.real);

  return opened === null || artifact === null ? opened : { ...opened, view: { ...opened.view, artifact } };
}

/**
 * Reads a link's target when {@link allowedPath} allows it: a folder's entries, unless `listFolders` is false, a text file's text, or what a picture or PDF is, with its open
 * handle. A file is read through the handle opened after the check, and only when the checked path still leads to that same file, so a file
 * swapped for a link out of the roots between the check and the read is refused. `checked` runs between the two, for tests.
 */
export async function openLocalFile(roots: LocalRoots, target: string, checked?: () => Promise<void>): Promise<LocalOpened | null> {
  const real = await allowedPath(roots, target);
  const first = real === null ? null : await stat(real, { bigint: true }).catch(() => null);

  if (real === null || first === null) {
    return null;
  }

  await checked?.();

  const name = parse(real).base || real;
  const base = { path: slashed(real), name, contents: null, tooLarge: false, size: null, entries: null, more: false, modified: null };

  if (first.isDirectory()) {
    if (roots.listFolders === false) {
      return null;
    }

    const read = await readdir(real, { withFileTypes: true }).catch(() => null);

    if (read === null || !(await unchanged(roots, real, first))) {
      return null;
    }

    const entries = read
      .filter((entry) => entry.name.toLowerCase() !== '.git')
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    return { real, handle: null, view: { ...base, kind: 'dir', entries: entries.slice(0, LOCAL_DIR_MAX), more: entries.length > LOCAL_DIR_MAX } };
  }

  const handle = first.isFile() ? await open(real, 'r').catch(() => null) : null;
  const info = handle === null ? null : await handle.stat({ bigint: true }).catch(() => null);

  // The file opened must be the one stat named before it was opened, and the path must still lead to it.
  if (handle === null || info === null || !info.isFile() || info.ino !== first.ino || info.dev !== first.dev || !(await unchanged(roots, real, info))) {
    await handle?.close();
    return null;
  }

  const size = Number(info.size);
  const ext = extOf(real);

  if (rawMime(real) !== null) {
    return { real, handle, view: { ...base, kind: ext === 'pdf' ? 'pdf' : 'image', size, tooLarge: size > LOCAL_RAW_MAX_BYTES, modified: Number(info.mtimeMs) } };
  }

  const kind = MARKDOWN.has(ext) ? 'markdown' : 'text';
  const bytes = await readHandle(handle, LOCAL_TEXT_MAX_BYTES);

  await handle.close();

  if (bytes === null) {
    return null;
  }

  const view: LocalFileView = bytes === 'large' ? { ...base, kind, size, tooLarge: true } : looksBinary(bytes) ? { ...base, kind: 'binary', size } : { ...base, kind, size, contents: bytes.toString('utf8') };

  return { real, handle: null, view };
}
