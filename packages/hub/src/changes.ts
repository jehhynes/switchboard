import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { changesPlan } from '@switchboard/core';
import type { ChangedPath, DiffRow } from '@switchboard/core';
import type { WindowScope } from './windows.js';

/**
 * The web page's Changes list (PRD R118, architecture.md § Web page): a worktree's changes from its merge base to disk, read with the git CLI as
 * VS Code's Open changes shows them (PRD R57), committed, staged, unstaged, conflicted and untracked, each file once.
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
}

export interface ChangesView {
  /** The merge base, or null when the worktree shares no history with `origin/HEAD`, `origin/main` or `origin/master`: the rows are then uncommitted changes against HEAD. */
  base: string | null;
  head: string;
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
  /** The ref the rows compare disk with: the merge base, else HEAD. */
  ref: string;
  view: ChangesView;
  /** Each shown row's two sides, by its `path`, and whether its file is untracked. */
  sides: Map<string, DiffRow & { untracked: boolean }>;
}

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** The output passed `maxBytes`, so git was stopped. */
  tooLarge: boolean;
}

/** Runs git in a folder; `maxBytes` caps its output. */
export type Git = (args: string[], cwd: string, options?: { maxBytes?: number; stdin?: string }) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 64 * 1024 * 1024;
/** Refs tried in order for the merge base, as the VS Code window's Open changes tries them. Nothing is fetched. */
export const BASE_REFS = ['origin/HEAD', 'origin/main', 'origin/master'];

/** The `GIT_*` variables git reads from the hub's environment; any other, such as `GIT_DIR` or `GIT_EXTERNAL_DIFF`, could point it elsewhere or change its output. */
const GIT_KEPT = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']);

/**
 * git without a shell, never taking the index lock a session's own git commands need (`GIT_OPTIONAL_LOCKS=0`), with paths as literal pathspecs,
 * paths printed unquoted, and no prompt. The hub's other `GIT_*` variables are left out.
 */
export const nodeGit: Git = (args, cwd, options = {}) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_') || GIT_KEPT.has(name.toUpperCase())));

    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' });

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
function fields(output: Buffer): string[] {
  const parts = output.toString('utf8').split('\0');

  if (parts.at(-1) === '') {
    parts.pop();
  }

  return parts;
}

/**
 * Parses `git diff -z --name-status`: a copy counts as an addition and a conflict or type change as a modification, as the VS Code window's
 * Open changes reads them.
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
 * since it could lead to a file git ignores or to git's own files.
 */
export async function fileInside(root: string, path: string): Promise<string | null> {
  if (!relativePath(path)) {
    return null;
  }

  try {
    const top = await realpath(root);
    const lexical = join(top, ...path.split('/'));
    const real = await realpath(lexical);
    const inside = relative(top, real);
    const direct = process.platform === 'win32' ? real.toLowerCase() === lexical.toLowerCase() : real === lexical;

    return direct && inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) && (await stat(real)).isFile() ? real : null;
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

/** The first of {@link BASE_REFS} that shares history with HEAD, or null. */
async function mergeBase(root: string, git: Git): Promise<string | null> {
  for (const ref of BASE_REFS) {
    const found = await git(['merge-base', 'HEAD', ref], root);
    const sha = found.stdout.toString('utf8').trim();

    if (found.code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) {
      return sha;
    }
  }

  return null;
}

/** A worktree's changes from its merge base to disk, read in `folder`'s repository; why not when git cannot read it. */
export async function readChanges(folder: string, git: Git = nodeGit, withCounts = true): Promise<WorktreeChanges | { error: string }> {
  const top = await git(['rev-parse', '--show-toplevel'], folder);
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

  const headRead = await git(['rev-parse', '--verify', 'HEAD'], root);
  const head = headRead.stdout.toString('utf8').trim();

  if (headRead.code !== 0) {
    return { error: 'The repository has no commit yet.' };
  }

  const base = await mergeBase(root, git);
  const ref = base ?? head;
  const diff = ['diff', '-z', '--no-ext-diff', '--no-textconv', '--no-color'];
  const [committed, staged, working, untracked, conflicts, numstat] = await Promise.all([
    base === null ? null : git([...diff, '--name-status', '-M', base, 'HEAD'], root),
    git([...diff, '--cached', '--name-status', '-M'], root),
    git([...diff, '--name-status'], root),
    git(['ls-files', '-z', '--others', '--exclude-standard'], root),
    git([...diff, '--name-only', '--diff-filter=U'], root),
    git([...diff, '--numstat', '-M', ref], root),
  ]);
  const failed = [committed, staged, working, untracked, conflicts, numstat].find((result) => result !== null && result.code !== 0);

  if (failed !== undefined) {
    return { error: `git could not read the changes: ${failed!.stderr.trim() || `exit ${String(failed!.code)}`}` };
  }

  const stages: Record<ChangeStage, ChangedPath[]> = {
    committed: committed === null ? [] : parseNameStatus(committed.stdout),
    staged: parseNameStatus(staged.stdout),
    working: parseNameStatus(working.stdout),
    untracked: fields(untracked.stdout).map((path) => ({ path, kind: 'added' as const })),
  };
  const plan = changesPlan({ label: '', base, committed: stages.committed, staged: stages.staged, working: [...stages.working, ...stages.untracked] });
  const planned = 'refusal' in plan ? { rows: [], shown: 0, total: 0 } : plan;
  const untrackedKeys = new Set(stages.untracked.map((change) => pathKey(change.path)));
  const conflictKeys = new Set(fields(conflicts.stdout).map(pathKey));
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
    };
  };
  // A few files read at a time, in order, so a worktree with many untracked files does not open them all at once.
  const rows: ChangeRow[] = [];

  for (let start = 0; start < planned.rows.length; start += COUNT_AT_ONCE) {
    rows.push(...(await Promise.all(planned.rows.slice(start, start + COUNT_AT_ONCE).map(rowOf))));
  }

  return {
    root,
    ref,
    view: { base, head, rows, stages: { committed: stages.committed.length, staged: stages.staged.length, working: stages.working.length, untracked: stages.untracked.length }, shown: planned.shown, total: planned.total },
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
}

const DIFF_ARGS = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/'];

/** A side of a diff read whole: a blob at the base by `<ref>:<path>`, or the file on disk by real path inside the worktree; `large` past the cap. */
async function readSide(changes: WorktreeChanges, side: { path: string; ref: string | null }, git: Git): Promise<Buffer | 'large' | null> {
  if (side.ref !== null) {
    const blob = await git(['cat-file', 'blob', `${changes.ref}:${side.path}`], changes.root, { maxBytes: SIDE_MAX_BYTES });

    return blob.tooLarge ? 'large' : blob.code === 0 ? blob.stdout : null;
  }

  const real = await fileInside(changes.root, side.path);

  if (real === null) {
    return null;
  }

  return readCapped(real, SIDE_MAX_BYTES);
}

/**
 * One change row's diff, `path` being its path now (a deleted file's at the base): git's patch, from `git diff --no-index` against nothing for
 * an untracked file and `git diff -M1% <base>` limited to the row's paths otherwise, so a rename pairs as the row does, and both whole sides;
 * null for a path that is not one of the rows. Only the rows' own paths are read: a git-side path as `<base>:<path>`, never a ref the
 * caller names, and a disk-side path by real path inside the worktree.
 */
export async function readDiff(changes: WorktreeChanges, path: string, git: Git = nodeGit): Promise<DiffView | null> {
  const row = changes.view.rows.find((one) => one.path === path);
  const sides = changes.sides.get(path);

  if (row === undefined || sides === undefined) {
    return null;
  }

  const base: DiffView = { path, ...(row.from === undefined ? {} : { from: row.from }), status: row.status, patch: null, old: null, new: null, binary: false, tooLarge: null };
  const [old, now] = await Promise.all([sides.original === null ? null : readSide(changes, sides.original, git), sides.modified === null ? null : readSide(changes, sides.modified, git)]);

  if ((old instanceof Buffer && looksBinary(old)) || (now instanceof Buffer && looksBinary(now)) || row.binary) {
    return { ...base, binary: true };
  }

  const paths = [...new Set([sides.original?.path, sides.modified?.path].filter((one): one is string => one !== undefined))];
  const patch = sides.untracked
    ? await git([...DIFF_ARGS, '--no-index', '--', '/dev/null', path], changes.root, { maxBytes: PATCH_MAX_BYTES })
    : await git([...DIFF_ARGS, '-M1%', changes.ref, '--', ...paths], changes.root, { maxBytes: PATCH_MAX_BYTES });
  // `--no-index` exits 1 when the files differ, as they always do here.
  const patchOk = patch.code === 0 || (sides.untracked && patch.code === 1);

  if (patch.tooLarge) {
    return { ...base, tooLarge: 'patch' };
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
  /** Opens a file at a line in the work item's VS Code window, opening the window when it is closed: why not, or null. */
  openFile?(workItemId: number, path: string, line: number): string | null;
}

/** The hub's `file` answer: a file read whole, on disk or at the base, for the page's file view. */
export interface FileView {
  path: string;
  side: 'disk' | 'base';
  contents: string | null;
  binary: boolean;
  tooLarge: boolean;
}

/**
 * A file of the worktree for the file view (`side` disk): one git tracks or would track, never an ignored one or one under `.git`, read by real
 * path inside the worktree; or (`side` base) a change row's file at the base, read as `<base>:<path>` for the row's own base path only. Null for
 * any other path.
 */
export async function readFileView(changes: WorktreeChanges, path: string, side: 'disk' | 'base', git: Git = nodeGit): Promise<FileView | null> {
  let bytes: Buffer | 'large' | null;

  if (side === 'base') {
    const row = [...changes.sides.values()].find((one) => one.original?.path === path);

    bytes = row?.original == null ? null : await readSide(changes, row.original, git);
  } else {
    const listed = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', path], changes.root);

    bytes = listed.code === 0 && fields(listed.stdout).includes(path) ? await readSide(changes, { path, ref: null }, git) : null;
  }

  if (bytes === null) {
    return null;
  }

  if (bytes === 'large') {
    return { path, side, contents: null, binary: false, tooLarge: true };
  }

  return looksBinary(bytes) ? { path, side, contents: null, binary: true, tooLarge: false } : { path, side, contents: bytes.toString('utf8'), binary: false, tooLarge: false };
}

/** Why a page key gets no changes: not a page's, or no selected conversation with a folder yet. */
function unscoped(deps: PageChangesDeps, key: string): ChangesReply | WindowScope {
  const scope = deps.isPage(key) ? deps.scope(key) : null;

  if (scope === null) {
    return { status: 403, body: { error: 'Not in this window.' } };
  }

  return scope.cwd === null ? { status: 409, body: { error: 'This conversation has no folder yet.' } } : scope;
}

/** Whether the page still shows the conversation it asked for, after the reads. */
function same(deps: PageChangesDeps, key: string, scope: WindowScope): boolean {
  const now = deps.scope(key);

  return now !== null && now.scopeGen === scope.scopeGen && now.cwd === scope.cwd && now.workItemId === scope.workItemId;
}

export const CONVERSATION_MOVED = "The window's conversation changed.";

/** How many `open-file` answers a page's retried `opId` can find. */
const OPENED_KEPT = 100;

/** An answer's `ETag`: a hash of its JSON, so an unchanged answer is answered 304. */
export function etagOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
}

/** The page's change routes, scoped by the window scope rule to the page's selected conversation's folder (architecture.md § Web page). */
export class PageChanges {
  constructor(private readonly deps: PageChangesDeps) {}

  /** `GET /v1/conversation/changes?window=<page key>`: the selected conversation's worktree's `ChangesView`. */
  async changes(key: string): Promise<ChangesReply> {
    const scope = unscoped(this.deps, key);

    if ('status' in scope) {
      return scope;
    }

    const read = await readChanges(scope.cwd!, this.deps.git);

    if (!same(this.deps, key, scope)) {
      return { status: 409, body: { error: CONVERSATION_MOVED } };
    }

    if ('error' in read) {
      return { status: 409, body: read };
    }

    const body = { scopeGen: scope.scopeGen, ...read.view };

    return { status: 200, body, etag: etagOf(body) };
  }

  /**
   * `GET /v1/conversation/diff?window=<page key>&path=<path>`: one change row's `DiffView`, for a path that is one of the selected conversation's
   * change rows now; 400 for a path that is not a plain relative one, 404 for one that is no row.
   */
  async diff(key: string, path: unknown): Promise<ChangesReply> {
    if (!relativePath(path)) {
      return { status: 400, body: { error: 'Expected a path relative to the worktree.' } };
    }

    const scope = unscoped(this.deps, key);

    if ('status' in scope) {
      return scope;
    }

    const read = await readChanges(scope.cwd!, this.deps.git, false);
    const diff = 'error' in read ? null : await readDiff(read, path, this.deps.git);

    if (!same(this.deps, key, scope)) {
      return { status: 409, body: { error: CONVERSATION_MOVED } };
    }

    if ('error' in read) {
      return { status: 409, body: read };
    }

    return diff === null ? { status: 404, body: { error: `${path} is not one of the changes now.` } } : { status: 200, body: diff, etag: etagOf(diff) };
  }

  /**
   * `GET /v1/conversation/file?window=<page key>&path=<path>&side=disk|base`: a file of the selected conversation's worktree read whole
   * (`readFileView`); 400 for a path that is not plain and relative or another side, 404 for one it does not answer.
   */
  async file(key: string, path: unknown, side: unknown): Promise<ChangesReply> {
    if (!relativePath(path) || (side !== 'disk' && side !== 'base')) {
      return { status: 400, body: { error: 'Expected a path relative to the worktree and a side, disk or base.' } };
    }

    const scope = unscoped(this.deps, key);

    if ('status' in scope) {
      return scope;
    }

    const read = await readChanges(scope.cwd!, this.deps.git, false);
    const view = 'error' in read ? null : await readFileView(read, path, side, this.deps.git);

    if (!same(this.deps, key, scope)) {
      return { status: 409, body: { error: CONVERSATION_MOVED } };
    }

    if ('error' in read) {
      return { status: 409, body: read };
    }

    return view === null ? { status: 404, body: { error: `${path} is not a file of this worktree.` } } : { status: 200, body: view, etag: etagOf(view) };
  }

  /**
   * `open-file {window, scopeGen, opId, path, line}`: opens a file of the selected conversation's worktree at a line in its work item's VS Code
   * window, as Open in VS Code does; 403 for a key that is not a page's, 409 for a stale `scopeGen` or a refusal, 404 for a path that is no file
   * inside the worktree.
   */
  async openFileCommand(body: Record<string, unknown>): Promise<ChangesReply> {
    const { window, scopeGen, opId, path, line } = body;

    if (typeof window !== 'string' || !Number.isInteger(scopeGen) || typeof opId !== 'string' || opId === '' || opId.length > 100 || !relativePath(path) || !Number.isInteger(line) || (line as number) < 1) {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, path, line}.' } };
    }

    // A retried `opId` answers as the first did, so a lost answer never opens the file twice.
    const done = this.#opened.get(`${window} ${opId}`);

    if (done !== undefined) {
      return done;
    }

    const reply = await this.#openFile(window, scopeGen as number, path, line as number);

    this.#opened.set(`${window} ${opId}`, reply);

    if (this.#opened.size > OPENED_KEPT) {
      this.#opened.delete(this.#opened.keys().next().value!);
    }

    return reply;
  }

  /** Each `open-file`'s answer by page key and `opId`, the last {@link OPENED_KEPT}. */
  readonly #opened = new Map<string, ChangesReply>();

  async #openFile(window: string, scopeGen: number, path: string, line: number): Promise<ChangesReply> {
    const scope = unscoped(this.deps, window);

    if ('status' in scope) {
      return scope;
    }

    if (scope.scopeGen !== scopeGen || scope.workItemId === null) {
      return { status: 409, body: { error: CONVERSATION_MOVED } };
    }

    const real = await fileInside(scope.cwd!, path);

    if (real === null) {
      return { status: 404, body: { error: `${path} is not a file of this worktree.` } };
    }

    if (!same(this.deps, window, scope)) {
      return { status: 409, body: { error: CONVERSATION_MOVED } };
    }

    const why = this.deps.openFile === undefined ? 'This hub cannot open files in VS Code.' : this.deps.openFile(scope.workItemId, real, line);

    return why === null ? { status: 200, body: { opened: path } } : { status: 409, body: { error: why } };
  }
}
