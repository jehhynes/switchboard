import { open, readdir, realpath, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { looksBinary } from './changes.js';

/** The most bytes of a text, code or Markdown file the page is sent. */
export const LOCAL_TEXT_MAX_BYTES = 4 * 1024 * 1024;
/** The most bytes of a picture or PDF the page is sent. */
export const LOCAL_RAW_MAX_BYTES = 32 * 1024 * 1024;
/** The most entries a folder's listing holds. */
export const LOCAL_DIR_MAX = 500;
/** Why a paired device gets no local file (architecture.md § Remote access). */
export const LOCAL_FILES_COMPUTER_ONLY = 'Local files open only on the computer that runs Switchboard.';

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
  /** The temporary folder Claude Code keeps its `claude` folder in; the system's by default. */
  temp?: string;
}

/**
 * The roots of a page's selected conversation: relative links against its current session's working folder; its own folders and each of its
 * work item's sessions' working folders; and those sessions' Claude session IDs, earlier ones a fork or a clear replaced included.
 */
export function localRoots(scope: { folder: string | null; cwd: string | null }, sessions: ReadonlyArray<{ id: string; cwd: string; nativeSessionId: string | null; retiredIds: readonly string[] }>, currentId: string | null): LocalRoots {
  const current = sessions.find((one) => one.id === currentId);
  const named = (one: string | null | undefined): one is string => typeof one === 'string' && one !== '';

  return {
    cwd: current?.cwd || scope.cwd || scope.folder,
    folders: [scope.folder, scope.cwd, ...sessions.map((one) => one.cwd)].filter(named),
    sessionIds: sessions.flatMap((one) => [one.nativeSessionId, ...one.retiredIds]).filter(named),
  };
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
  }

  if (isAbsolute(path)) {
    return resolve(path);
  }

  return cwd === null ? null : resolve(cwd, path);
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

  for (const folder of new Set(roots.folders)) {
    const top = await realpath(folder).catch(() => null);

    if (top !== null && parse(top).root !== top && under(top, real)) {
      return real;
    }
  }

  const claude = await realpath(join(roots.temp ?? tmpdir(), 'claude')).catch(() => null);
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
 * Reads a link's target when {@link allowedPath} allows it: a folder's entries, a text file's text, or what a picture or PDF is, with its open
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
  const base = { path: slashed(real), name, contents: null, tooLarge: false, size: null, entries: null, more: false };

  if (first.isDirectory()) {
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
    return { real, handle, view: { ...base, kind: ext === 'pdf' ? 'pdf' : 'image', size, tooLarge: size > LOCAL_RAW_MAX_BYTES } };
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
