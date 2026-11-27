import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { changesPlan, MAX_ROWS } from '@switchboard/core';
import type { ChangedPath, ChangeKind, DiffRow } from '@switchboard/core';
import { hiddenPath, insideFolders } from './explorer.js';
import { outOfScope } from './windows.js';
import type { WindowScope } from './windows.js';

/**
 * The web page's Changes list (PRD R118, architecture.md § Web page): a worktree's changes from its merge base to disk, read with the git CLI
 * (PRD R57), committed, staged, unstaged, conflicted and untracked, each file once; or the range the page's
 * scope names: from HEAD, the base or a commit since the base, to disk or to one of those commits.
 */

/** A row's status letter, as VS Code's Source Control shows it: added, modified, deleted, renamed, untracked, or a conflict. */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'U' | 'C';
export type ChangeStage = 'committed' | 'staged' | 'working' | 'untracked';
export const CHANGE_STAGES: readonly ChangeStage[] = ['committed', 'staged', 'working', 'untracked'];

export interface ChangeRow {
  /** The path now, or a deleted file's path at the base, relative to the worktree with forward slashes. */
  path: string;
  /** A renamed file's path at the base. */
  from?: string;
  status: ChangeStatus;
  /** The stages whose changes this row folds together. */
  stages: ChangeStage[];
  /** Lines added and deleted from the base to disk; null for a binary file or one git paired otherwise. */
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** The file's content now, which a viewed tick is kept at: git's blob ID of the file on disk, or `deleted` for a deleted file. */
  hash: string;
  /** Whether the work item's operator ticked the file viewed at this content (`PageChanges.changes`). */
  viewed?: boolean;
}

/** What a list compares: from the merge base (`base`), HEAD or a commit since the base, to disk (`worktree`), HEAD or a commit since the base. */
export interface ChangeRange {
  from: string;
  to: string;
}

export const ALL_CHANGES: ChangeRange = { from: 'base', to: 'worktree' };

/** A commit since the merge base, for the page's scope menu: its first parent, subject, and author (`%at`) and committer (`%ct`) dates in seconds. */
export interface CommitInfo {
  sha: string;
  parent: string | null;
  subject: string;
  authored: number;
  committed: number;
  /** The committer date again, which a page of an earlier build reads until it reloads. */
  time: number;
}

/** The most commits since the base a list names; the oldest past it cannot be chosen. */
export const MAX_COMMITS = 200;

const SHA = /^[0-9a-f]{40,64}$/;

export interface ChangesView {
  /** The merge base, or null when the worktree shares no history with `origin/HEAD`, `origin/main` or `origin/master`: `base` then means HEAD. */
  base: string | null;
  head: string;
  /** The range the rows compare, as the page asked for it. */
  from: string;
  to: string;
  /** The commits from the base to HEAD, newest first, the first {@link MAX_COMMITS}; `commitsMore` when there are more. */
  commits: CommitInfo[];
  commitsMore: boolean;
  /** The rows sorted by path, the first {@link MAX_ROWS} of `total`. */
  rows: ChangeRow[];
  /** How many files each stage changes, since one row can fold changes from several stages. */
  stages: Record<ChangeStage, number>;
  shown: number;
  total: number;
}

/** A worktree's changes as read, with what the diff and file routes check a path against. */
export interface WorktreeChanges {
  /** The worktree's top folder, as git prints it. */
  root: string;
  /** The commit the rows compare from: the merge base, else HEAD, or the range's commit. */
  ref: string;
  /** The commit the rows compare to, or null for disk. */
  to: string | null;
  /** What the rows' viewed ticks are kept under: empty for a range to disk, whose hash is the file on disk, else `<from>..<to>`. */
  tickScope: string;
  view: ChangesView;
  /** Each shown row's two sides, by its `path`, and whether its file is untracked. */
  sides: Map<string, DiffRow & { untracked: boolean }>;
  /** HEAD, the base refs and the index file as read (`readStamp`): while they are the same, so are the base, the commits since it, the range's commits and the staged changes. */
  stamp: string;
  /** The index file's path, whose size and time are part of `stamp`. */
  index: string | null;
  /** How the working tree changes each path against the index, untracked included, keyed by `pathKey`; `PageChanges` checks a kept read's rows against it. */
  working: Map<string, ChangeKind | 'untracked'>;
}

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** The output passed `maxBytes`, so git was stopped. */
  tooLarge: boolean;
}

/** Runs git in a folder; `maxBytes` caps its output, and `magic` lets it read pathspec magic, for `check-ignore`, which refuses literal pathspecs. */
export type Git = (args: string[], cwd: string, options?: { maxBytes?: number; stdin?: string; magic?: true }) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 64 * 1024 * 1024;
/** Refs tried in order for the merge base. Nothing is fetched. */
export const BASE_REFS = ['origin/HEAD', 'origin/main', 'origin/master'];

/** The `GIT_*` variables git reads from the hub's environment; any other, such as `GIT_DIR` or `GIT_EXTERNAL_DIFF`, could point it elsewhere or change its output. */
const GIT_KEPT = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']);

/**
 * git without a shell, never taking the index lock a session's own git commands need (`GIT_OPTIONAL_LOCKS=0`), with paths as literal pathspecs,
 * paths printed unquoted, and no prompt. The hub's other `GIT_*` variables are left out.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_') || GIT_KEPT.has(name.toUpperCase())));

  return Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' });
}

/** Runs git with {@link gitEnv}, without a shell. */
export const nodeGit: Git = (args, cwd, options = {}) =>
  new Promise((resolve) => {
    const env = options.magic ? { ...gitEnv(), GIT_LITERAL_PATHSPECS: '0' } : gitEnv();

    const child = execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd, env, encoding: 'buffer', maxBuffer: options.maxBytes ?? GIT_MAX_BYTES, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : null;

        resolve({ code, stdout, stderr: stderr.toString('utf8') || (error?.message ?? ''), tooLarge: (error as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      },
    );

    child.stdin?.on('error', () => {});
    child.stdin?.end(options.stdin ?? '');
  });

/** The fields of git's `-z` output. */
export function fields(output: Buffer): string[] {
  const parts = output.toString('utf8').split('\0');

  if (parts.at(-1) === '') {
    parts.pop();
  }

  return parts;
}

/**
 * Parses `git diff -z --name-status`: a copy counts as an addition and a conflict or type change as a modification.
 */
export function parseNameStatus(output: Buffer): ChangedPath[] {
  const parts = fields(output);
  const changes: ChangedPath[] = [];

  for (let index = 0; index < parts.length; ) {
    const letter = parts[index++]![0];

    if (letter === 'R' || letter === 'C') {
      const from = parts[index++]!;
      const path = parts[index++]!;

      changes.push(letter === 'R' ? { path, kind: 'modified', from } : { path, kind: 'added' });
    } else {
      const path = parts[index++]!;

      changes.push({ path, kind: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified' });
    }
  }

  return changes;
}

/** Parses `git diff -z --numstat` into each file's counts by its path now; a binary file's are null. */
export function parseNumstat(output: Buffer): Map<string, { additions: number | null; deletions: number | null }> {
  const parts = fields(output);
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();

  for (let index = 0; index < parts.length; ) {
    const [added = '', deleted = '', path = ''] = parts[index++]!.split('\t');
    // A rename's entry has an empty path, then its old and new paths as fields of their own.
    const now = path === '' ? (index++, parts[index++] ?? '') : path;

    counts.set(now, added === '-' ? { additions: null, deletions: null } : { additions: Number(added), deletions: Number(deleted) });
  }

  return counts;
}

const IMAGES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml' };

/** Recordings and videos, by extension, sent as bytes beside pictures and PDFs. */
const MEDIA: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg' };

/** A picture's, a PDF's, a recording's or a video's media type by its extension, the only files sent as bytes; null for any other. */
export function rawMime(path: string): string | null {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();

  return ext === 'pdf' ? 'application/pdf' : (IMAGES[ext] ?? MEDIA[ext] ?? null);
}

/** An ISO media file's box at its start, as MP4, M4A and QuickTime files begin. */
const isoBox = (bytes: Buffer): boolean => ['ftyp', 'moov', 'wide', 'mdat', 'free', 'skip'].includes(bytes.subarray(4, 8).toString('latin1'));
const ogg = (bytes: Buffer): boolean => bytes.subarray(0, 4).toString('latin1') === 'OggS';

/** The bytes' leading marks each media type must have; an SVG must be text holding an `<svg` element. */
const MAGIC: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/gif': (bytes) => bytes.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (bytes) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/bmp': (bytes) => bytes.subarray(0, 2).toString('latin1') === 'BM',
  'image/x-icon': (bytes) => bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])),
  'image/avif': (bytes) => bytes.subarray(4, 12).toString('latin1') === 'ftypavif',
  'image/svg+xml': (bytes) => !looksBinary(bytes) && /<svg[\s>]/i.test(bytes.subarray(0, 64 * 1024).toString('utf8')),
  'application/pdf': (bytes) => bytes.subarray(0, 5).toString('latin1') === '%PDF-',
  'audio/mpeg': (bytes) => bytes.subarray(0, 3).toString('latin1') === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0),
  'audio/mp4': isoBox,
  'audio/wav': (bytes) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WAVE',
  'audio/ogg': ogg,
  'audio/flac': (bytes) => bytes.subarray(0, 4).toString('latin1') === 'fLaC',
  'video/mp4': isoBox,
  'video/quicktime': isoBox,
  'video/webm': (bytes) => bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  'video/ogg': ogg,
};

/** The media type of a file whose extension and leading bytes agree, else null, so a file named `.png` that holds text is not sent as a picture. */
export function mediaOf(path: string, bytes: Buffer): string | null {
  const mime = rawMime(path);

  return mime !== null && MAGIC[mime]!(bytes) ? mime : null;
}

/** Whether bytes look binary, as git decides: a NUL in the first 8,000. */
export function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** The most bytes of an untracked file read to count its lines, of all of them for one list, and how many are read at once. */
const COUNT_MAX_BYTES = 8 * 1024 * 1024;
const COUNT_TOTAL_BYTES = 64 * 1024 * 1024;
const COUNT_AT_ONCE = 8;

/**
 * A file under `root` by a path relative to it, resolved by real path, or null when it is not a file inside it: `..`, an absolute path, or a
 * link or junction out of it is refused, as an artifact's file is, and so is any link or junction on the way, even one inside the worktree,
 * since it could lead to git's own files or out of the worktree.
 */
export function fileInside(root: string, path: string): Promise<string | null> {
  return entryInside(root, path, 'file');
}

/** A file or folder under `root`, checked as {@link fileInside} checks a file. */
export async function entryInside(root: string, path: string, kind: 'file' | 'folder'): Promise<string | null> {
  if (!relativePath(path)) {
    return null;
  }

  try {
    const top = await realpath(root);
    const lexical = join(top, ...path.split('/'));
    const real = await realpath(lexical);
    const inside = relative(top, real);
    const direct = process.platform === 'win32' ? real.toLowerCase() === lexical.toLowerCase() : real === lexical;

    return direct && inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) && (kind === 'file' ? (await stat(real)).isFile() : (await stat(real)).isDirectory()) ? real : null;
  } catch {
    return null;
  }
}

/**
 * A file's bytes, at most `cap`: `large` when it holds more, read through one handle, so a file that grows while it is read is still cut at
 * the cap; null when it cannot be read.
 */
export async function readCapped(real: string, cap: number): Promise<Buffer | 'large' | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    handle = await open(real, 'r');

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
  } finally {
    await handle?.close();
  }
}

/** Whether a path is a plain relative path with forward slashes, as git prints one: no empty, `.` or `..` part, no backslash, colon at its start or NUL. */
export function relativePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 4096 &&
    !/[\\\0]/.test(path) &&
    !/^[a-zA-Z]:/.test(path) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/**
 * An untracked file's line count and whether it is binary, read from disk; null counts when it cannot be read or is too large to count, or
 * `budget`, the bytes left for this list, would be passed.
 */
async function untrackedCounts(root: string, path: string, budget: { bytes: number }): Promise<{ additions: number | null; binary: boolean }> {
  const real = await fileInside(root, path);

  try {
    const size = real === null ? Infinity : (await stat(real)).size;

    if (real === null || size > COUNT_MAX_BYTES || size > budget.bytes) {
      return { additions: null, binary: false };
    }

    budget.bytes -= size;

    const bytes = await readCapped(real, COUNT_MAX_BYTES);

    if (!(bytes instanceof Buffer)) {
      return { additions: null, binary: false };
    }

    if (looksBinary(bytes)) {
      return { additions: null, binary: true };
    }

    let lines = 0;

    for (const byte of bytes) {
      lines += byte === 10 ? 1 : 0;
    }

    return { additions: lines + (bytes.length > 0 && bytes.at(-1) !== 10 ? 1 : 0), binary: false };
  } catch {
    return { additions: null, binary: false };
  }
}

/** The key two paths compare by, as `changesPlan` compares them. */
function pathKey(path: string): string {
  return path.toLowerCase();
}

/**
 * The index file's identity, its file ID, size and change time to the nanosecond, or null when it cannot be read: git writes a new index and
 * renames it into place at each staging, commit or checkout.
 */
async function indexStamp(path: string | null): Promise<string | null> {
  try {
    const info = path === null ? null : await stat(path, { bigint: true });

    return info === null ? null : `${info.ino} ${info.size} ${info.mtimeNs}`;
  } catch {
    return null;
  }
}

/**
 * HEAD's commit, the commits of {@link BASE_REFS} and the index file (`indexStamp`), which decide the merge base, the commits since it, what a
 * range names and the staged changes with their renames (`WorktreeChanges.stamp`): `head` HEAD's commit, null when it has none, `stamp` null
 * when a read failed, `index` the index file's path, `bases` the base refs some ref of which exists, all of them when the refs could not be read.
 */
async function readStamp(folder: string, git: Git): Promise<{ head: string | null; stamp: string | null; index: string | null; bases: readonly string[] }> {
  const [read, refs] = await Promise.all([
    git(['rev-parse', '--path-format=absolute', '--git-path', 'index', '--verify', 'HEAD'], folder),
    git(['for-each-ref', '--format=%(refname) %(objectname)', ...BASE_REFS.flatMap(refsNamed)], folder),
  ]);
  const [index = '', head = ''] = read.stdout.toString('utf8').trim().split('\n').map((line) => line.trim());
  const ok = read.code === 0 && SHA.test(head) && index !== '';
  const lines = refs.stdout.toString('utf8').split('\n').filter((line) => line !== '');
  const listed = new Set(lines.map((line) => line.split(' ')[0]));
  const bases = refs.code === 0 ? BASE_REFS.filter((ref) => refsNamed(ref).some((name) => listed.has(name))) : BASE_REFS;
  // Every ref a base name could resolve to, as `stillHolds` reads them, so a local branch or tag that shadows a remote one counts.
  const remote = lines.map((line) => `${line}\n`).join('');

  const indexed = ok ? await indexStamp(index) : null;

  return { head: ok ? head : null, index: index || null, bases, stamp: ok && refs.code === 0 && indexed !== null ? `${head}\n${remote}\n${indexed}` : null };
}

/** The full refs git tries for a short name such as `origin/main`, in its order (gitrevisions § SPECIFYING REVISIONS). */
function refsNamed(ref: string): string[] {
  return [`refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`, `refs/remotes/${ref}`, `refs/remotes/${ref}/HEAD`];
}

/** The first of `bases`, the {@link BASE_REFS} that exist, that shares history with HEAD, or null. */
async function mergeBase(root: string, bases: readonly string[], git: Git): Promise<string | null> {
  for (const ref of bases) {
    const found = await git(['merge-base', 'HEAD', ref], root);
    const sha = found.stdout.toString('utf8').trim();

    if (found.code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) {
      return sha;
    }
  }

  return null;
}

/** The commits from `base` to HEAD, newest first, at most {@link MAX_COMMITS}; null when git cannot read them. */
async function readCommits(root: string, base: string, git: Git): Promise<{ commits: CommitInfo[]; more: boolean } | null> {
  const log = await git(['log', '-z', '--no-color', '--no-show-signature', '--format=%H%x1f%P%x1f%at%x1f%ct%x1f%s', `--max-count=${MAX_COMMITS + 1}`, `${base}..HEAD`, '--'], root);

  if (log.code !== 0) {
    return null;
  }

  const commits = fields(log.stdout).map((entry) => {
    const [sha = '', parents = '', authored = '0', committed = '0', ...subject] = entry.replace(/^\n/, '').split('\x1f');

    return { sha, parent: parents.split(' ')[0] || null, subject: subject.join('\x1f'), authored: Number(authored), committed: Number(committed), time: Number(committed) };
  });

  return { commits: commits.slice(0, MAX_COMMITS), more: commits.length > MAX_COMMITS };
}

/** Parses `git diff -z --raw --no-abbrev` into each file's blob ID at the range's end, by its path now. */
export function parseRaw(output: Buffer): Map<string, string> {
  const parts = fields(output);
  const blobs = new Map<string, string>();

  for (let index = 0; index < parts.length; ) {
    const [, , , blob = '', status = ''] = parts[index++]!.split(' ');
    const path = status.startsWith('R') || status.startsWith('C') ? (index++, parts[index++]!) : parts[index++]!;

    blobs.set(path, blob);
  }

  return blobs;
}

/**
 * The routes' `from` and `to`: from `base` (none), `HEAD` or a commit's full ID, to `worktree` (none), `HEAD`, which follows new commits, or a
 * commit's; from HEAD only to disk, and never a range from a point to itself. Null for anything else. Whether a commit is one since the base is checked when the changes are read.
 */
export function parseRange(from: unknown, to: unknown): ChangeRange | null {
  const start = from ?? 'base';
  const end = to ?? 'worktree';

  if (typeof start !== 'string' || typeof end !== 'string' || !(start === 'base' || start === 'HEAD' || SHA.test(start)) || !(end === 'worktree' || end === 'HEAD' || SHA.test(end))) {
    return null;
  }

  return start === end || (start === 'HEAD' && end !== 'worktree') ? null : { from: start, to: end };
}

export const COMMIT_GONE = 'The chosen commit is no longer on this branch.';

/**
 * A worktree's changes in a range read in `folder`'s repository, from its merge base to disk by default; why not when git cannot read it, and
 * `stale` when the range names a commit that is not one since the base, as after a rebase. A commit the range starts from may also be the first
 * parent of one since the base, so a commit's own changes can be asked for.
 */
export async function readChanges(
  folder: string,
  git: Git = nodeGit,
  withCounts = true,
  range: ChangeRange = ALL_CHANGES,
  withHashes = true,
): Promise<WorktreeChanges | { error: string; stale?: true }> {
  // Read side by side in the folder, which must be its repository's top, and checked in this order once both are back. HEAD and the base refs
  // are read before anything that depends on them, so a ref that moves later leaves a stamp that no longer matches, never one newer than the read.
  const [top, { head: headRead, stamp, index, bases }] = await Promise.all([git(['rev-parse', '--show-toplevel'], folder), readStamp(folder, git)]);
  const root = top.stdout.toString('utf8').trim();

  if (top.code !== 0 || root === '') {
    return { error: `${folder} is not in a git repository.` };
  }

  // Only the folder's own repository: a folder inside another repository, such as a scratch folder in a checkout, shows nothing of it, as the
  // item window's Open changes refuses a repository at another path.
  const [realRoot, realFolder] = await Promise.all([realpath(root).catch(() => root), realpath(folder).catch(() => folder)]);

  if (process.platform === 'win32' ? realRoot.toLowerCase() !== realFolder.toLowerCase() : realRoot !== realFolder) {
    return { error: `${folder} is not the top of its git repository, ${root}.` };
  }

  if (headRead === null) {
    return { error: 'The repository has no commit yet.' };
  }

  const head = headRead;

  const base = await mergeBase(root, bases, git);

  // A commit the range names must be one since the base, or a range's start the first parent of one, so only this branch's commits are read.
  // Every commit since the base counts, not only those the menu lists, so a commit chosen before more were made is still found.
  const commitsRead = Promise.all([base === null ? { commits: [], more: false } : readCommits(root, base, git), base === null ? '' : git(['rev-list', '--parents', `${base}..HEAD`, '--'], root)]);
  // A range that names a commit is checked before git reads anything at it; any other is read while the commits are.
  const named = SHA.test(range.from) || SHA.test(range.to);
  const checked = named ? await commitsRead : null;
  const ref = range.from === 'HEAD' ? head : range.from === 'base' ? (base ?? head) : range.from;
  const to = range.to === 'worktree' ? null : range.to === 'HEAD' ? head : range.to;
  const stale = ([log, listed]: Awaited<typeof commitsRead>): { error: string; stale?: true } | null => {
    if (log === null || (typeof listed !== 'string' && listed.code !== 0)) {
      return { error: 'git could not read the commits since the base.' };
    }

    const lines = typeof listed === 'string' ? [] : listed.stdout.toString('utf8').split('\n').filter((line) => line !== '').map((line) => line.split(' '));
    const commitIds = new Set(lines.map(([sha = '']) => sha));
    const starts = new Set([...(base === null ? [] : [base]), ...commitIds, ...lines.map(([, parent = '']) => parent)]);

    return (SHA.test(range.from) && !starts.has(range.from)) || (SHA.test(range.to) && !commitIds.has(range.to)) ? { error: COMMIT_GONE, stale: true } : null;
  };
  const refused = checked === null ? null : stale(checked);

  if (refused !== null) {
    return refused;
  }

  const diff = ['diff', '-z', '--no-ext-diff', '--no-textconv', '--no-color'];
  // To disk: the commits from `ref` to HEAD, then the index, the working tree and the untracked files; to a commit, that commit's tree alone.
  const onDisk = to === null;
  const [[committed, staged, working, untracked, conflicts, numstat, raw], commits] = await Promise.all([
    Promise.all([
      to !== null ? git([...diff, '--name-status', '-M', ref, to], root) : ref === head ? null : git([...diff, '--name-status', '-M', ref, 'HEAD'], root),
      onDisk ? git([...diff, '--cached', '--name-status', '-M'], root) : null,
      onDisk ? git([...diff, '--name-status'], root) : null,
      onDisk ? git(['ls-files', '-z', '--others', '--exclude-standard'], root) : null,
      onDisk ? git([...diff, '--name-only', '--diff-filter=U'], root) : null,
      git([...diff, '--numstat', '-M', ref, ...(to === null ? [] : [to])], root),
      to === null ? null : git([...diff, '--raw', '--no-abbrev', '-M', ref, to], root),
    ]),
    checked ?? commitsRead,
  ]);
  const unread = checked === null ? stale(commits) : null;

  if (unread !== null) {
    return unread;
  }

  const log = commits[0]!;
  const failed = [committed, staged, working, untracked, conflicts, numstat, raw].find((result) => result !== null && result.code !== 0);

  if (failed !== undefined) {
    return { error: `git could not read the changes: ${failed!.stderr.trim() || `exit ${String(failed!.code)}`}` };
  }

  const parsed = (result: GitResult | null): ChangedPath[] => (result === null ? [] : parseNameStatus(result.stdout));
  const stages: Record<ChangeStage, ChangedPath[]> = {
    committed: parsed(committed),
    staged: parsed(staged),
    working: parsed(working),
    untracked: untracked === null ? [] : fields(untracked.stdout).map((path) => ({ path, kind: 'added' as const })),
  };
  const plan = changesPlan({ label: '', base: committed === null ? null : ref, committed: stages.committed, staged: stages.staged, working: [...stages.working, ...stages.untracked] });
  // Each side read at the range's own ends: the start's commit, and the end's commit or disk.
  const planned = 'refusal' in plan ? { rows: [], shown: 0, total: 0 } : { ...plan, rows: plan.rows.map((row) => ({ original: row.original === null ? null : { ...row.original, ref }, modified: row.modified === null ? null : { ...row.modified, ref: to } })) };
  const untrackedKeys = new Set(stages.untracked.map((change) => pathKey(change.path)));
  const conflictKeys = new Set(conflicts === null ? [] : fields(conflicts.stdout).map(pathKey));
  const counts = parseNumstat(numstat.stdout);
  const sides = new Map<string, DiffRow & { untracked: boolean }>();
  // Each path's stages, by both its paths for a rename, read once for every row.
  const stagesOf = new Map<string, Set<ChangeStage>>();

  for (const stage of CHANGE_STAGES) {
    for (const change of stages[stage]) {
      for (const one of [change.path, ...(change.from === undefined ? [] : [change.from])]) {
        stagesOf.set(pathKey(one), (stagesOf.get(pathKey(one)) ?? new Set()).add(stage));
      }
    }
  }

  const budget = { bytes: COUNT_TOTAL_BYTES };
  const rowOf = async (row: DiffRow): Promise<ChangeRow> => {
    const path = row.modified?.path ?? row.original!.path;
    const from = row.original !== null && row.modified !== null && row.original.path !== row.modified.path ? row.original.path : undefined;
    const keys = [path, ...(from === undefined ? [] : [from])].map(pathKey);
    const isUntracked = row.original === null && untrackedKeys.has(pathKey(path));
    const status: ChangeStatus = conflictKeys.has(pathKey(path))
      ? 'C'
      : row.original === null
        ? isUntracked
          ? 'U'
          : 'A'
        : row.modified === null
          ? 'D'
          : from !== undefined
            ? 'R'
            : 'M';
    const touched = CHANGE_STAGES.filter((stage) => keys.some((key) => stagesOf.get(key)?.has(stage) === true));
    const counted = isUntracked && withCounts ? await untrackedCounts(root, path, budget).then(({ additions, binary }) => ({ additions, deletions: additions === null ? null : 0, binary })) : null;
    const numbers = counted ?? counts.get(path) ?? { additions: null, deletions: null };

    sides.set(path, { ...row, untracked: isUntracked });

    return {
      path,
      ...(from === undefined ? {} : { from }),
      status,
      stages: touched,
      additions: numbers.additions,
      deletions: numbers.deletions,
      binary: counted?.binary ?? (counts.has(path) && numbers.additions === null),
      hash: 'deleted',
    };
  };
  // A few files read at a time, in order, so a worktree with many untracked files does not open them all at once.
  const rows: ChangeRow[] = [];

  for (let start = 0; start < planned.rows.length; start += COUNT_AT_ONCE) {
    rows.push(...(await Promise.all(planned.rows.slice(start, start + COUNT_AT_ONCE).map(rowOf))));
  }

  if (raw !== null) {
    // To a commit, each file's content hash is its blob ID in that commit.
    const blobs = parseRaw(raw.stdout);

    rows.filter((row) => row.status !== 'D').forEach((row) => (row.hash = SHA.test(blobs.get(row.path) ?? '') ? blobs.get(row.path)! : 'unreadable'));
  }

  // Each file's content hash on disk: its blob ID, without running the repository's filters, for a file inside the worktree only (`fileInside`),
  // in one git process; a file that went meanwhile fails that process, so each is then hashed on its own.
  const present: ChangeRow[] = [];

  for (let start = 0; onDisk && withHashes && start < rows.length; start += COUNT_AT_ONCE) {
    const batch = rows.slice(start, start + COUNT_AT_ONCE).filter((row) => row.status !== 'D');
    const inside = await Promise.all(batch.map((row) => fileInside(root, row.path)));

    batch.forEach((row, index) => (inside[index] === null ? (row.hash = 'unreadable') : present.push(row)));
  }

  const hashOf = async (paths: string[]): Promise<string[] | null> => {
    const hashed = await git(['hash-object', '--no-filters', '--stdin-paths'], root, { stdin: paths.join('\n') + '\n' });
    const lines = hashed.stdout.toString('utf8').split('\n');

    return hashed.code === 0 && paths.every((_, index) => /^[0-9a-f]{40,64}$/.test(lines[index] ?? '')) ? lines.slice(0, paths.length) : null;
  };
  const all = present.length === 0 ? [] : await hashOf(present.map((row) => row.path));

  for (let start = 0; start < present.length; start += COUNT_AT_ONCE) {
    const batch = present.slice(start, start + COUNT_AT_ONCE);
    const hashes = all ?? (await Promise.all(batch.map(async (row) => (await hashOf([row.path]))?.[0] ?? 'unreadable')));

    batch.forEach((row, index) => (row.hash = all === null ? hashes[index]! : all[start + index]!));
  }

  return {
    root,
    ref,
    to,
    tickScope: to === null ? '' : `${ref}..${to}`,
    // No stamp read: one that never matches, so the read is never used again.
    stamp: stamp ?? '',
    index,
    working: new Map([...stages.working.map((change) => [pathKey(change.path), change.kind] as const), ...stages.untracked.map((change) => [pathKey(change.path), 'untracked'] as const)]),
    view: { base, head, from: range.from, to: range.to, commits: log.commits, commitsMore: log.more, rows, stages: { committed: stages.committed.length, staged: stages.staged.length, working: stages.working.length, untracked: stages.untracked.length }, shown: planned.shown, total: planned.total },
    sides,
  };
}

/** The most bytes of each side of a diff, and of its patch, the hub sends; past them a diff shows its patch alone, or nothing. */
export const SIDE_MAX_BYTES = 4 * 1024 * 1024;
export const PATCH_MAX_BYTES = 4 * 1024 * 1024;
/** The most bytes of a patch and both sides together; past it the sides are left out. */
export const DIFF_MAX_BYTES = 8 * 1024 * 1024;

/** The hub's `diff` answer for one change row (architecture.md § Web page). */
export interface DiffView {
  path: string;
  from?: string;
  status: ChangeStatus;
  /** git's patch from the base to disk, null for a binary file or one too large. */
  patch: string | null;
  /** The whole file at the base and on disk, null where it has none, or when either is too large. */
  old: string | null;
  new: string | null;
  binary: boolean;
  tooLarge: 'sides' | 'patch' | null;
  /** True when the sides were not asked for (`readDiff`'s `withSides` false): the patch alone, its unchanged lines read only on request. */
  partial?: true;
  /** Read ignoring whitespace (`ws=ignore`) and the file differs only in whitespace: the patch is empty. */
  same?: true;
}

const DIFF_ARGS = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/'];

/** A side of a diff read whole: a blob at one of the range's commits by `<ref>:<path>`, or the file on disk by real path inside the worktree; `large` past the cap. */
async function readSide(changes: WorktreeChanges, side: { path: string; ref: string | null }, git: Git): Promise<Buffer | 'large' | null> {
  if (side.ref !== null) {
    const blob = await git(['cat-file', 'blob', `${side.ref}:${side.path}`], changes.root, { maxBytes: SIDE_MAX_BYTES });

    return blob.tooLarge ? 'large' : blob.code === 0 ? blob.stdout : null;
  }

  const real = await fileInside(changes.root, side.path);

  if (real === null) {
    return null;
  }

  return readCapped(real, SIDE_MAX_BYTES);
}

/** git's line for a binary file in a patch, which it prints in place of hunks. */
const BINARY_PATCH = /^(Binary files .* differ|GIT binary patch)$/m;

/**
 * One change row's diff, `path` being its path now (a deleted file's at the base): git's patch, from `git diff --no-index` against nothing for
 * an untracked file and `git diff -M1% <from> [<to>]` limited to the row's paths otherwise, so a rename pairs as the row does, and, unless
 * `withSides` is false, both whole sides; null for a path that is not one of the rows. Only the rows' own paths are read: a git-side path as
 * `<commit>:<path>` at a commit of the range `readChanges` checked, and a disk-side path by real path inside the worktree. Without the sides no side is read:
 * a binary file is known by git's numstat or its patch's binary line.
 */
export async function readDiff(changes: WorktreeChanges, path: string, git: Git = nodeGit, withSides = true, ignoreSpace = false): Promise<DiffView | null> {
  const row = changes.view.rows.find((one) => one.path === path);
  const sides = changes.sides.get(path);

  if (row === undefined || sides === undefined) {
    return null;
  }

  const base: DiffView = { path, ...(row.from === undefined ? {} : { from: row.from }), status: row.status, patch: null, old: null, new: null, binary: false, tooLarge: null, ...(withSides ? {} : { partial: true as const }) };
  const paths = [...new Set([sides.original?.path, sides.modified?.path].filter((one): one is string => one !== undefined))];
  const args = ignoreSpace ? [...DIFF_ARGS, '-w'] : DIFF_ARGS;
  const patchRead = () =>
    sides.untracked
      ? git([...args, '--no-index', '--', '/dev/null', path], changes.root, { maxBytes: PATCH_MAX_BYTES })
      : git([...args, '-M1%', changes.ref, ...(changes.to === null ? [] : [changes.to]), '--', ...paths], changes.root, { maxBytes: PATCH_MAX_BYTES });
  // Ignoring whitespace, a file that differs only in whitespace has an empty patch, said so rather than shown as unreadable.
  const sameIgnoringSpace = (patch: GitResult) => ignoreSpace && (patch.code === 0 || (sides.untracked && patch.code === 1)) && patch.stdout.length === 0 && !patch.tooLarge;

  if (!withSides) {
    if (row.binary) {
      return { ...base, binary: true };
    }

    const patch = await patchRead();
    const patchOk = patch.code === 0 || (sides.untracked && patch.code === 1);

    if (patch.tooLarge) {
      return { ...base, tooLarge: 'patch' };
    }

    if (sameIgnoringSpace(patch)) {
      return { ...base, patch: '', same: true };
    }

    if (!patchOk || patch.stdout.length === 0) {
      return base;
    }

    const text = patch.stdout.toString('utf8');

    return BINARY_PATCH.test(text) ? { ...base, binary: true } : { ...base, patch: text };
  }

  const [old, now] = await Promise.all([sides.original === null ? null : readSide(changes, sides.original, git), sides.modified === null ? null : readSide(changes, sides.modified, git)]);

  // Known binary before git diff runs, so a binary file never waits on it.
  if ((old instanceof Buffer && looksBinary(old)) || (now instanceof Buffer && looksBinary(now)) || row.binary) {
    return { ...base, binary: true };
  }

  const patch = await patchRead();

  // `--no-index` exits 1 when the files differ, as they always do here.
  const patchOk = patch.code === 0 || (sides.untracked && patch.code === 1);

  if (patch.tooLarge) {
    return { ...base, tooLarge: 'patch' };
  }

  if (sameIgnoringSpace(patch)) {
    return { ...base, patch: '', same: true, old: old instanceof Buffer ? old.toString('utf8') : null, new: now instanceof Buffer ? now.toString('utf8') : null };
  }

  if (!patchOk || patch.stdout.length === 0) {
    return { ...base, tooLarge: null };
  }

  // A side the row has but that cannot be read, such as a link, leaves the patch alone too.
  const unread = (sides.original !== null && old === null) || (sides.modified !== null && now === null);

  if (unread || old === 'large' || now === 'large' || patch.stdout.length + (old?.length ?? 0) + (now?.length ?? 0) > DIFF_MAX_BYTES) {
    return { ...base, patch: patch.stdout.toString('utf8'), tooLarge: 'sides' };
  }

  return { ...base, patch: patch.stdout.toString('utf8'), old: old?.toString('utf8') ?? null, new: now?.toString('utf8') ?? null };
}

export type ChangesReply = { status: number; body: unknown; etag?: string };

export interface PageChangesDeps {
  isPage(key: string): boolean;
  scope(key: string): WindowScope | null;
  git?: Git;
  /** The work items' viewed ticks (the store's `viewedFiles`), by tick scope (`WorktreeChanges.tickScope`); without them no file shows as viewed. */
  viewed?: { list(workItemId: number, scope: string): Map<string, string>; set(workItemId: number, scope: string, path: string, hash: string | null): void };
  /** Tells the other pages showing a work item that a tick changed, as a `viewed` event. */
  viewedChanged?(workItemId: number, from: string, payload: { path: string; hash: string; viewed: boolean; scope: string }): void;
  /** The ignored folders Explore shows for a scope (`explorerFolders`), whose files the file view reads too; without it, none. */
  folders?(scope: WindowScope): Promise<string[]>;
}

/** The hub's `file` answer: a file read whole, on disk or at the base, for the page's file view. */
export interface FileView {
  path: string;
  side: 'disk' | 'base';
  contents: string | null;
  binary: boolean;
  tooLarge: boolean;
  /** The file's size, null when it could not be read. */
  bytes: number | null;
  /** A picture's, a PDF's, a recording's or a video's media type, when its extension and leading bytes agree (`mediaOf`); `file-raw` sends its bytes. */
  media: string | null;
  /** A hash of the bytes read (past the cap, of the leading bytes, size, and the file's identity and time), so the answer's ETag changes with a file whose contents it does not carry. */
  digest: string;
}

/** The most bytes `file-raw` sends of a picture or PDF. */
export const RAW_MAX_BYTES = 32 * 1024 * 1024;
/** The leading bytes read to tell a large file's media type. */
const HEAD_BYTES = 64 * 1024;

/** A file of the worktree at a commit (`ref`) or on disk (null), read whole up to `cap`: its bytes or `large`, and its size; null when it is not there. */
async function readAt(root: string, path: string, ref: string | null, git: Git, cap: number): Promise<{ bytes: Buffer | 'large'; size: number; head: Buffer; stamp: string } | null> {
  if (ref !== null) {
    const [size, blob] = await Promise.all([git(['cat-file', '-s', `${ref}:${path}`], root), git(['cat-file', 'blob', `${ref}:${path}`], root, { maxBytes: cap })]);
    const bytes = Number(size.stdout.toString('utf8').trim());

    if (size.code !== 0 || !Number.isSafeInteger(bytes) || (blob.code !== 0 && !blob.tooLarge)) {
      return null;
    }

    // A blob at a commit never changes.
    return { bytes: blob.tooLarge ? 'large' : blob.stdout, size: bytes, head: blob.stdout.subarray(0, HEAD_BYTES), stamp: `${ref}:${path}` };
  }

  const real = await fileInside(root, path);

  if (real === null) {
    return null;
  }

  const [read, info] = await Promise.all([readCapped(real, cap), stat(real, { bigint: true }).catch(() => null)]);

  if (read === null || info === null) {
    return null;
  }

  const head = read === 'large' ? await headOf(real).catch(() => null) : read.subarray(0, HEAD_BYTES);

  return head === null ? null : { bytes: read, size: Number(info.size), head, stamp: `${info.ino} ${info.mtimeNs}` };
}

/** A file's first {@link HEAD_BYTES}, read through one handle. */
async function headOf(real: string): Promise<Buffer> {
  const handle = await open(real, 'r');

  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);

    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function viewOf(path: string, side: 'disk' | 'base', read: { bytes: Buffer | 'large'; size: number; head: Buffer; stamp: string }): FileView {
  const media = mediaOf(path, read.head);
  const digest = createHash('sha256')
    // Past the cap, the file's identity and modification time stand for the bytes not read.
    .update(read.bytes === 'large' ? Buffer.concat([read.head, Buffer.from(` ${read.size} ${read.stamp}`)]) : read.bytes)
    .digest('hex')
    .slice(0, 32);
  const facts = { path, side, bytes: read.size, media, digest };

  if (read.bytes === 'large') {
    return { ...facts, contents: null, binary: looksBinary(read.head), tooLarge: true };
  }

  return looksBinary(read.bytes) ? { ...facts, contents: null, binary: true, tooLarge: false } : { ...facts, contents: read.bytes.toString('utf8'), binary: false, tooLarge: false };
}

/** Whether a path has a `.git` folder in it, which no change route reads. */
export function inGitFolder(path: string): boolean {
  return path.split('/').some((part) => part.toLowerCase() === '.git');
}

/**
 * Whether `path` is a file of the worktree at `root` the file view reads: one git lists, tracked or untracked, or one it ignores inside a folder
 * Explore shows (`folders`); never one under `.git` or node_modules, which Explore hides.
 */
async function listed(root: string, path: string, git: Git, folders: readonly string[]): Promise<boolean> {
  if (inGitFolder(path) || hiddenPath(path)) {
    return false;
  }

  const found = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', path], root);

  if (found.code === 0 && fields(found.stdout).includes(path)) {
    return true;
  }

  return insideFolders(folders, path) && ignoredByGit(root, path, git);
}

/**
 * Whether git ignores a plain relative path (a folder as `<path>/`). `check-ignore` refuses literal pathspecs, so it reads magic, and a path
 * that starts with `:`, which would be magic, is never ignored.
 */
export async function ignoredByGit(root: string, path: string, git: Git = nodeGit): Promise<boolean> {
  return !path.startsWith(':') && (await git(['check-ignore', '-q', '--', path], root, { magic: true })).code === 0;
}

/** Where a file view's side is read: the row's commit, or for a disk side to disk, a commit or null. */
function sideOf(changes: WorktreeChanges, path: string, side: 'disk' | 'base'): { path: string; ref: string | null } | 'disk' | null {
  if (side === 'base') {
    return [...changes.sides.values()].find((one) => one.original?.path === path)?.original ?? null;
  }

  return changes.to !== null ? ([...changes.sides.values()].find((one) => one.modified?.path === path)?.modified ?? null) : 'disk';
}

/**
 * A file of the worktree for the file view (`side` disk): one git tracks or would track, or ignores inside a folder Explore shows (`folders`),
 * never one under `.git`, read by real
 * path inside the worktree; or (`side` base) a change row's file at the range's start, read as `<from>:<path>` for the row's own path there only;
 * for a range to a commit, `disk` is a change row's file in that commit. Null for any other path.
 */
export async function readFileView(changes: WorktreeChanges, path: string, side: 'disk' | 'base', git: Git = nodeGit, folders: readonly string[] = []): Promise<FileView | null> {
  const at = sideOf(changes, path, side);

  if (at === 'disk') {
    return readDiskFile(changes.root, path, git, folders);
  }

  const read = at === null ? null : await readAt(changes.root, at.path, at.ref, git, SIDE_MAX_BYTES);

  return read === null ? null : viewOf(path, side, read);
}

/** A file on disk for the file view, checked as {@link readFileView} checks one, without reading the change list. */
export async function readDiskFile(root: string, path: string, git: Git = nodeGit, folders: readonly string[] = []): Promise<FileView | null> {
  const read = (await listed(root, path, git, folders)) ? await readAt(root, path, null, git, SIDE_MAX_BYTES) : null;

  return read === null ? null : viewOf(path, 'disk', read);
}

/** A picture's, a PDF's, a recording's or a video's bytes for `file-raw`, read as {@link readFileView} reads the side, up to {@link RAW_MAX_BYTES}; null for any other file. */
async function readRaw(root: string, at: { path: string; ref: string | null }, git: Git, folders: readonly string[] = []): Promise<{ mime: string; bytes: Buffer } | null> {
  if (at.ref === null && !(await listed(root, at.path, git, folders))) {
    return null;
  }

  const read = await readAt(root, at.path, at.ref, git, RAW_MAX_BYTES);
  const mime = read === null || read.bytes === 'large' ? null : mediaOf(at.path, read.bytes);

  return mime === null ? null : { mime, bytes: read!.bytes as Buffer };
}

const RANGE_REFUSED = { status: 400, body: { error: 'Expected from base, HEAD or a commit, and to worktree or a commit.' } };

/** Why a page key gets no changes: not a page's, or no selected conversation with a folder yet. */
export function unscoped(deps: PageChangesDeps, key: string): ChangesReply | WindowScope {
  const known = deps.isPage(key);
  const scope = known ? deps.scope(key) : null;

  if (scope === null) {
    return outOfScope(known, scope);
  }

  return scope.cwd === null ? { status: 409, body: { error: 'This conversation has no folder yet.' } } : scope;
}

/** The folder's real path when it is its repository's top, as `readChanges` requires; why not otherwise. */
async function topOf(folder: string, git: Git): Promise<{ root: string } | { error: string }> {
  const top = await git(['rev-parse', '--show-toplevel'], folder);
  const root = top.stdout.toString('utf8').trim();

  if (top.code !== 0 || root === '') {
    return { error: `${folder} is not in a git repository.` };
  }

  const [realRoot, realFolder] = await Promise.all([realpath(root).catch(() => root), realpath(folder).catch(() => folder)]);

  return (process.platform === 'win32' ? realRoot.toLowerCase() === realFolder.toLowerCase() : realRoot === realFolder) ? { root } : { error: `${folder} is not the top of its git repository, ${root}.` };
}

/** Whether the page still shows the conversation it asked for, after the reads. */
export function same(deps: PageChangesDeps, key: string, scope: WindowScope): boolean {
  const now = deps.scope(key);

  return now !== null && now.scopeGen === scope.scopeGen && now.cwd === scope.cwd && now.workItemId === scope.workItemId;
}

export const CONVERSATION_MOVED = "The window's conversation changed.";
export const VIEWED_REFUSED = 'Expected {window, scopeGen, opId, path, hash, viewed[, from, to]}.';

/** How many pages' reads of their changes are kept (`PageChanges`). */
const KEPT_READS = 16;

/** How many `viewed` answers a page's retried `opId` can find. */
const TICKED_KEPT = 100;

/** An answer's `ETag`: a hash of its JSON, so an unchanged answer is answered 304. */
export function etagOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
}

/**
 * HEAD and how the working tree changes each path against the index, keyed by `pathKey`, from `git status --porcelain=v2 -z --branch`, as
 * `readChanges` reads them with `git diff --name-status` and `ls-files --others`: added, modified or deleted, a conflict as modified, or untracked.
 */
export function parseStatusWorking(output: Buffer): { head: string | null; working: Map<string, ChangeKind | 'untracked'> } {
  const working = new Map<string, ChangeKind | 'untracked'>();
  let head: string | null = null;

  for (const entry of fields(output)) {
    const kind = entry[0];

    if (entry.startsWith('# branch.oid ')) {
      head = SHA.test(entry.slice('# branch.oid '.length)) ? entry.slice('# branch.oid '.length) : null;
    } else if (kind === '?') {
      working.set(pathKey(entry.slice(2)), 'untracked');
    } else if (kind === '1' || kind === 'u') {
      // The path follows 8 fields for a changed entry and 10 for an unmerged one, and may hold spaces.
      const parts = entry.split(' ');
      const path = parts.slice(kind === '1' ? 8 : 10).join(' ');
      const y = (parts[1] ?? '..')[1];

      if (kind === 'u' || (y !== undefined && y !== '.')) {
        working.set(pathKey(path), kind === 'u' ? 'modified' : y === 'D' ? 'deleted' : y === 'A' ? 'added' : 'modified');
      }
    }
  }

  return { head, working };
}

/**
 * Whether a kept read still answers for `paths`: HEAD, the base refs and the index file are as it read them (`stamp`), so the commits and the
 * staged changes, renames included, are too; and, for a range to disk, each path changes in the working tree as it did then, read now by
 * `git status` for those paths alone. A file ignored, deleted, put back or made again since fails it; an edit that leaves it modified does not,
 * since the patch and the sides are read at each request.
 */
async function stillHolds(read: WorktreeChanges, paths: string[], git: Git): Promise<boolean> {
  const onDisk = read.to === null && paths.length > 0;
  const [head, refs, index] = await Promise.all([
    onDisk ? git(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--no-renames', '--', ...paths], read.root) : git(['rev-parse', '--verify', 'HEAD'], read.root),
    git(['for-each-ref', '--format=%(refname) %(objectname)', ...BASE_REFS.flatMap(refsNamed)], read.root),
    indexStamp(read.index),
  ]);

  // A list at its row limit can lose a row to a new one that sorts before it, so it is read again.
  if (head.code !== 0 || refs.code !== 0 || index === null || read.view.total >= MAX_ROWS) {
    return false;
  }

  const status = onDisk ? parseStatusWorking(head.stdout) : null;
  const now = status === null ? head.stdout.toString('utf8').trim() : status.head;

  if (`${now}\n${refs.stdout.toString('utf8')}\n${index}` !== read.stamp) {
    return false;
  }

  return status === null || paths.every((path) => read.working.get(pathKey(path)) === status.working.get(pathKey(path)));
}

/** The page's change routes, scoped by the window scope rule to the page's selected conversation's folder (architecture.md § Web page). */
export class PageChanges {
  constructor(private readonly deps: PageChangesDeps) {}

  async #folders(scope: WindowScope): Promise<string[]> {
    return (await this.deps.folders?.(scope)) ?? [];
  }

  /**
   * Each page's last read of its changes, by page key, with the scope and range it was read for: the list the page shows, which its diff and
   * file reads use rather than read every change again for each file (mechanics M158). A read on its way is shared.
   */
  readonly #reads = new Map<string, { scopeGen: number; cwd: string; workItemId: number | null; range: string; read: Promise<WorktreeChanges | { error: string; stale?: true }> }>();

  #keep(key: string, scope: WindowScope, range: ChangeRange, read: Promise<WorktreeChanges | { error: string; stale?: true }>): void {
    this.#reads.delete(key);
    this.#reads.set(key, { scopeGen: scope.scopeGen, cwd: scope.cwd!, workItemId: scope.workItemId, range: `${range.from} ${range.to}`, read });

    if (this.#reads.size > KEPT_READS) {
      this.#reads.delete(this.#reads.keys().next().value!);
    }
  }

  /**
   * `use`'s answer from the page's kept read when it has one for this scope and range that still holds (`stillHolds`), else from a fresh read,
   * kept unless a newer read was kept meanwhile; the fresh read leaves out the content hashes, which only the list and a tick need. `rows` names
   * the paths whose stages the answer relies on. `use` answers null for a path the kept read does not answer, and the fresh read answers it.
   */
  async #fromRead<T>(
    key: string,
    scope: WindowScope,
    range: ChangeRange,
    use: (read: WorktreeChanges, kept: boolean) => Promise<T | null>,
    rows: (read: WorktreeChanges) => string[] = () => [],
  ): Promise<{ read: WorktreeChanges | { error: string; stale?: true }; value: T | null }> {
    const kept = this.#reads.get(key);

    if (kept !== undefined && kept.scopeGen === scope.scopeGen && kept.cwd === scope.cwd && kept.workItemId === scope.workItemId && kept.range === `${range.from} ${range.to}`) {
      const read = await kept.read;
      const value = !('error' in read) && (await stillHolds(read, rows(read), this.deps.git ?? nodeGit)) ? await use(read, true) : null;

      if (value !== null) {
        return { read: read as WorktreeChanges, value };
      }
    }

    const fresh = readChanges(scope.cwd!, this.deps.git, false, range, false);

    // A list read since this request started is the page's newer one; this read only answers this request.
    if (this.#reads.get(key) === kept) {
      this.#keep(key, scope, range, fresh);
    }

    const read = await fresh;

    return { read, value: 'error' in read ? null : await use(read, false) };
  }

  /**
   * `GET /v1/conversation/changes?window=<page key>[&from=<point>][&to=<point>]`: the selected conversation's worktree's `ChangesView` for the range
   * (`parseRange`), every change since the base by default; 400 for another `from` or `to`, 409 with `stale` for a commit no longer on the branch.
   */
  async changes(key: string, from: unknown = null, to: unknown = null): Promise<ChangesReply> {
    const range = parseRange(from, to);

    if (range === null) {
      return RANGE_REFUSED;
    }

    const scope = unscoped(this.deps, key);

    if ('status' in scope) {
      return scope;
    }

    const reading = readChanges(scope.cwd!, this.deps.git, true, range);

    this.#keep(key, scope, range, reading);

    const read = await reading;

    if (!same(this.deps, key, scope)) {
      return { status: 409, body: { error: CONVERSATION_MOVED } };
    }

    if ('error' in read) {
      return { status: 409, body: read };
    }

    const ticked = scope.workItemId === null ? new Map<string, string>() : (this.deps.viewed?.list(scope.workItemId, read.tickScope) ?? new Map<string, string>());
    const body = { scopeGen: scope.scopeGen, ...read.view, rows: read.view.rows.map((row) => ({ ...row, viewed: row.hash !== 'unreadable' && ticked.get(row.path) === row.hash })) };

    return { status: 200, body, etag: etagOf(body) };
  }

  /**
   * `GET /v1/conversation/diff?window=<page key>&path=<path>[&sides=0][&from=<point>][&to=<point>][&ws=ignore]`: one change row's `DiffView`, for a path
   * that is one of the selected conversation's change rows in the range now, with both sides, or with `sides` `0` the patch alone. 400 for a
   * path that is not a plain relative one or another `sides`, `from` or `to`, 404 for one that is no row.
   */
  async diff(key: string, path: unknown, sides: unknown = null, from: unknown = null, to: unknown = null, ws: unknown = null): Promise<ChangesReply> {
    if (!relativePath(path) || (sides !== null && sides !== '0' && sides !== '1') || (ws !== null && ws !== 'ignore')) {
      return { status: 400, body: { error: 'Expected a path relative to the worktree, sides 0 or 1, and ws ignore or none.' } };
    }

    const range = parseRange(from, to);

    if (range === null) {
      return RANGE_REFUSED;
    }

    const scope = unscoped(this.deps, key);

    if ('status' in scope) {
      return scope;
    }

    // A kept read's binary row, known binary only from the list, and a row whose patch is now empty are answered by a fresh read.
    const { read, value: diff } = await this.#fromRead(
      key,
      scope,
      range,
      async (changes, kept) => {
        if (kept && changes.view.rows.find((row) => row.path === path)?.binary === true) {
          return null;
        }

        const view = await readDiff(changes, path, this.deps.git, sides !== '0', ws === 'ignore');

        return kept && view !== null && view.patch === null && !view.binary && view.tooLarge === null ? null : view;
      },
      (changes) => {
        const row = changes.sides.get(path);

        return row === undefined ? [] : [...new Set([row.original?.path, row.modified?.path].filter((one): one is string => one !== undefined))];
      },
    );

    if (!same(this.deps, key, scope)) {
      return { status: 409, body: { error: CONVERSATION_MOVED } };
    }

    if ('error' in read) {
      return { status: 409, body: read };
    }

    return diff === null ? { status: 404, body: { error: `${path} is not one of the changes now.` } } : { status: 200, body: diff, etag: etagOf(diff) };
  }

  /**
   * `GET /v1/conversation/file?window=<page key>&path=<path>&side=disk|base[&from=<point>][&to=<point>]`: a file of the selected conversation's
   * worktree read whole (`readFileView`), `base` at the range's start and `disk` at its end; 400 for a path that is not plain and relative or
   * another side, `from` or `to`, 404 for one it does not answer.
   */
  async file(key: string, path: unknown, side: unknown, from: unknown = null, to: unknown = null): Promise<ChangesReply> {
    if (!relativePath(path) || (side !== 'disk' && side !== 'base')) {
      return { status: 400, body: { error: 'Expected a path relative to the worktree and a side, disk or base.' } };
    }

    const range = parseRange(from, to);

    if (range === null) {
      return RANGE_REFUSED;
    }

    const scope = unscoped(this.deps, key);

    if ('status' in scope) {
      return scope;
    }

    // A file on disk is read without the change list, so reading it again while it shows costs one listing and one read.
    if (side === 'disk' && range.to === 'worktree') {
      const root = await topOf(scope.cwd!, this.deps.git ?? nodeGit);
      const view = 'error' in root ? null : await readDiskFile(root.root, path, this.deps.git, await this.#folders(scope));

      if (!same(this.deps, key, scope)) {
        return { status: 409, body: { error: CONVERSATION_MOVED } };
      }

      if ('error' in root) {
        return { status: 409, body: root };
      }

      return view === null ? { status: 404, body: { error: `${path} is not a file of this worktree.` } } : { status: 200, body: view, etag: etagOf(view) };
    }

    // The base side is a row's: its paths are checked as a diff's are.
    const { read, value: view } = await this.#fromRead(
      key,
      scope,
      range,
      async (changes) => readFileView(changes, path, side, this.deps.git, await this.#folders(scope)),
      (changes) => {
        const row = side === 'base' ? [...changes.sides.values()].find((one) => one.original?.path === path) : undefined;

        return row === undefined ? [] : [...new Set([row.original?.path, row.modified?.path].filter((one): one is string => one !== undefined))];
      },
    );

    if (!same(this.deps, key, scope)) {
      return { status: 409, body: { error: CONVERSATION_MOVED } };
    }

    if ('error' in read) {
      return { status: 409, body: read };
    }

    return view === null ? { status: 404, body: { error: `${path} is not a file of this worktree.` } } : { status: 200, body: view, etag: etagOf(view) };
  }

  /**
   * `GET /v1/conversation/file-raw?window=<page key>&path=<path>&side=disk|base[&from=<point>][&to=<point>]`: a picture's or a PDF's bytes,
   * for a file `file` would read (`readFileView`'s checks), whose extension and leading bytes agree (`mediaOf`), up to {@link RAW_MAX_BYTES}.
   */
  async fileRaw(key: string, path: unknown, side: unknown, from: unknown = null, to: unknown = null): Promise<ChangesReply | { status: 200; raw: { mime: string; bytes: Buffer } }> {
    if (!relativePath(path) || (side !== 'disk' && side !== 'base')) {
      return { status: 400, body: { error: 'Expected a path relative to the worktree and a side, disk or base.' } };
    }

    const range = parseRange(from, to);

    if (range === null) {
      return RANGE_REFUSED;
    }

    const scope = unscoped(this.deps, key);

    if ('status' in scope) {
      return scope;
    }

    const git = this.deps.git ?? nodeGit;
    let raw: { mime: string; bytes: Buffer } | null;

    if (side === 'disk' && range.to === 'worktree') {
      const root = await topOf(scope.cwd!, git);

      raw = 'error' in root ? null : await readRaw(root.root, { path, ref: null }, git, await this.#folders(scope));
    } else {
      const { read, value } = await this.#fromRead(key, scope, range, async (changes) => {
        const at = sideOf(changes, path, side);

        return at === null || at === 'disk' ? null : readRaw(changes.root, at, git);
      });

      raw = 'error' in read ? null : value;
    }

    if (!same(this.deps, key, scope)) {
      return { status: 409, body: { error: CONVERSATION_MOVED } };
    }

    return raw === null ? { status: 404, body: { error: 'Only a picture or a PDF of this worktree is sent as a file.' } } : { status: 200, raw };
  }

  /**
   * `viewed {window, scopeGen, opId, path, hash, viewed[, from, to]}`: ticks a change row viewed at the content hash the page showed, or clears
   * its tick, for the selected conversation's work item, and tells the other pages showing it; `from` and `to` name the range the page listed
   * the row in (`parseRange`), and a range to a commit keeps its ticks apart from those of a range to disk. 409 when the file's content changed
   * since, so a tick is never kept for content the operator did not see, or for a stale `scopeGen`; 404 for a path that is no row.
   */
  async viewedCommand(body: Record<string, unknown>): Promise<ChangesReply> {
    const { window, scopeGen, opId, path, hash, viewed } = body;
    const range = parseRange(body['from'], body['to']);

    if (typeof window !== 'string' || !Number.isInteger(scopeGen) || typeof opId !== 'string' || opId === '' || opId.length > 100 || !relativePath(path) || typeof hash !== 'string' || hash.length > 100 || typeof viewed !== 'boolean' || range === null) {
      return { status: 400, body: { error: VIEWED_REFUSED } };
    }

    // A retried `opId` answers as the first did, so a lost answer never sets a tick again after a later one.
    const done = this.#ticked.get(`${window} ${opId}`);

    if (done !== undefined) {
      return done;
    }

    const reply = await this.#tick(window, scopeGen as number, path, hash, viewed, range);

    this.#ticked.set(`${window} ${opId}`, reply);

    if (this.#ticked.size > TICKED_KEPT) {
      this.#ticked.delete(this.#ticked.keys().next().value!);
    }

    return reply;
  }

  /** Each `viewed`'s answer by page key and `opId`, the last {@link TICKED_KEPT}. */
  readonly #ticked = new Map<string, ChangesReply>();

  async #tick(window: string, scopeGen: number, path: string, hash: string, viewed: boolean, range: ChangeRange): Promise<ChangesReply> {
    const scope = unscoped(this.deps, window);

    if ('status' in scope) {
      return scope;
    }

    if (scope.scopeGen !== scopeGen || scope.workItemId === null) {
      return { status: 409, body: { error: CONVERSATION_MOVED } };
    }

    if (this.deps.viewed === undefined) {
      return { status: 409, body: { error: 'This hub keeps no viewed ticks.' } };
    }

    const read = await readChanges(scope.cwd!, this.deps.git, false, range);

    if (!same(this.deps, window, scope)) {
      return { status: 409, body: { error: CONVERSATION_MOVED } };
    }

    if ('error' in read) {
      return { status: 409, body: read };
    }

    const row = read.view.rows.find((one) => one.path === path);

    if (row === undefined) {
      return { status: 404, body: { error: `${path} is not one of the changes now.` } };
    }

    if (row.hash !== hash || row.hash === 'unreadable') {
      return { status: 409, body: { error: `${path} changed since it was shown; read it again.`, hash: row.hash } };
    }

    this.deps.viewed.set(scope.workItemId, read.tickScope, path, viewed ? hash : null);
    this.deps.viewedChanged?.(scope.workItemId, window, { path, hash, viewed, scope: read.tickScope });
    return { status: 200, body: { path, hash, viewed } };
  }
}
