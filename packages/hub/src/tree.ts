import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { entryInside, etagOf, fields, gitEnv, ignoredByGit, nodeGit, relativePath, same, unscoped } from './changes.js';
import type { ChangesReply, Git, PageChangesDeps } from './changes.js';
import type { WindowScope } from './windows.js';
import { DEFAULT_EXPLORER_FOLDERS, HIDDEN_NAMES, hiddenPath, shownIgnored } from './explorer.js';

/**
 * The Changes tree's whole worktree and its text search (PRD R118, architecture.md § Web page, Changes): the files git lists, tracked or
 * untracked, and of what it ignores only what is in the folders Explore shows (`explorerFolders`): an ignored folder by itself, its entries read
 * only when it is opened. The search reads only the files git lists, as VS Code's search leaves ignored files out by default.
 */

/** The most paths the tree lists, and the most ignored entries it lists at the top or in one folder. */
export const MAX_TREE_PATHS = 20_000;

/** The paths `git status --porcelain=v1 -z` marks ignored (`!!`): a folder as `<path>/`, never descended into with `--ignored=matching`. */
export function ignoredOf(output: Buffer): string[] {
  const parts = fields(output);
  const found: string[] = [];

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const code = part.slice(0, 2);

    if (code === '!!') {
      found.push(part.slice(3));
    } else if (/[RC]/.test(code)) {
      // A rename or copy carries its source in the next field.
      index++;
    }
  }

  return found;
}
/** A search's limits over all its files: lines, files and bytes of output read, and its time. */
export const SEARCH_MAX_LINES = 2_000;
export const SEARCH_MAX_FILES = 200;
export const SEARCH_MAX_BYTES = 1024 * 1024;
export const SEARCH_TIMEOUT_MS = 10_000;
/** The most characters of a matching line sent. */
const LINE_MAX_CHARS = 400;

export interface TreeView {
  paths: string[];
  /** What git ignores: files, and folders as `<path>/`; within `dir` when one was asked for. */
  ignored: string[];
  more: boolean;
  dir?: string;
}

export interface SearchFile {
  path: string;
  matches: { line: number; text: string }[];
}

export interface SearchView {
  gen: number;
  files: SearchFile[];
  /** A limit was reached, so there may be more matches. */
  more: boolean;
}

/** A `*`, `**` and `?` pattern as a regular expression over a path; one without a `/` matches a file name at any depth. Null for an empty one. */
export function globPattern(glob: string): RegExp | null {
  const text = glob.trim();

  if (text === '' || text.length > 500) {
    return null;
  }

  let source = '';

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;

    if (char === '*' && text[index + 1] === '*') {
      source += '.*';
      index += text[index + 2] === '/' ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(text.includes('/') ? `^${source}$` : `(^|/)${source}$`, 'i');
}

const SEARCH_REFUSED = 'Expected q, and case, word and regex as 0 or 1, and gen as a number.';

export interface PageTreeDeps extends Pick<PageChangesDeps, 'isPage' | 'scope'> {
  git?: Git;
  /** The ignored folders Explore shows for the scope (`explorerFolders`); without it, the defaults. */
  folders?: (scope: WindowScope) => Promise<string[]>;
  /** Starts `git grep`; tests replace it. */
  spawnGit?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export class PageTree {
  constructor(private readonly deps: PageTreeDeps) {}

  /** The newest search `gen` each page key sent, and the search running for it. */
  readonly #searches = new Map<string, { gen: number; stop: (() => void) | null }>();

  /**
   * `GET /v1/conversation/tree?window=<page key>[&dir=<folder>]`: the paths git lists in the selected conversation's worktree, sorted, at most
   * {@link MAX_TREE_PATHS}, and what it ignores in the folders Explore shows, an ignored folder as itself. With `dir`, a shown ignored folder's
   * own entries, read from disk: 400 for a path that is not plain and relative or names `.git` or node_modules, 404 for one that is not a
   * shown ignored folder inside the worktree by real path, as a learned folder deleted since is. Links and junctions are left out, as the file routes refuse them; so are {@link HIDDEN_NAMES}.
   */
  async tree(key: string, dir: string | null = null): Promise<ChangesReply> {
    if (dir !== null && (!relativePath(dir) || hiddenPath(dir))) {
      return { status: 400, body: { error: 'Expected dir as a plain relative path of a folder.' } };
    }

    const scope = unscoped(this.deps, key);

    if ('status' in scope) {
      return scope;
    }

    return dir === null ? this.#top(key, scope) : this.#folder(key, scope, dir);
  }

  #folders(scope: WindowScope): Promise<string[]> {
    return this.deps.folders?.(scope) ?? Promise.resolve([...DEFAULT_EXPLORER_FOLDERS]);
  }

  async #top(key: string, scope: WindowScope): Promise<ChangesReply> {
    const git = this.deps.git ?? nodeGit;
    const [listed, status] = await Promise.all([
      git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], scope.cwd!),
      git(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal'], scope.cwd!),
    ]);

    if (!same(this.deps, key, scope)) {
      return { status: 409, body: { error: "The window's conversation changed." } };
    }

    const failed = listed.code !== 0 ? listed : status.code !== 0 ? status : null;

    if (failed !== null) {
      return { status: 409, body: { error: `git could not list the files: ${failed.stderr.trim() || `exit ${String(failed.code)}`}` } };
    }

    const all = [...new Set(listed.stdout.toString('utf8').split('\0').filter((path) => path !== '' && !hiddenPath(path)))].sort();
    const folders = await this.#folders(scope);
    const ignored = ignoredOf(status.stdout).filter((path) => !hiddenPath(path) && shownIgnored(folders, path)).sort();
    const body = { scopeGen: scope.scopeGen, paths: all.slice(0, MAX_TREE_PATHS), ignored: ignored.slice(0, MAX_TREE_PATHS), more: all.length > MAX_TREE_PATHS || ignored.length > MAX_TREE_PATHS };

    return { status: 200, body, etag: etagOf(body) };
  }

  async #folder(key: string, scope: WindowScope, dir: string): Promise<ChangesReply> {
    const git = this.deps.git ?? nodeGit;
    const folders = await this.#folders(scope);
    const real = shownIgnored(folders, `${dir}/`) ? await entryInside(scope.cwd!, dir, 'folder') : null;
    if (real === null || !(await ignoredByGit(scope.cwd!, `${dir}/`, git))) {
      return { status: 404, body: { error: `${dir} is not an ignored folder Explore shows in this worktree.` } };
    }

    let entries: string[];

    try {
      entries = (await readdir(real, { withFileTypes: true }))
        .filter((entry) => (entry.isFile() || entry.isDirectory()) && !HIDDEN_NAMES.has(entry.name.toLowerCase()))
        .map((entry) => `${dir}/${entry.name}${entry.isDirectory() ? '/' : ''}`)
        .filter((entry) => shownIgnored(folders, entry))
        .sort();
    } catch (error) {
      return { status: 409, body: { error: `Could not read ${dir}: ${(error as Error).message}` } };
    }

    if (!same(this.deps, key, scope)) {
      return { status: 409, body: { error: "The window's conversation changed." } };
    }

    const body = { scopeGen: scope.scopeGen, dir, paths: [], ignored: entries.slice(0, MAX_TREE_PATHS), more: entries.length > MAX_TREE_PATHS };

    return { status: 200, body, etag: etagOf(body) };
  }

  /**
   * `GET /v1/conversation/search?window=<page key>&gen=<n>&q=<text>[&case=1][&word=1][&regex=1][&glob=<pattern>]`: matching lines of the files
   * git lists, literal unless `regex`, ignoring case unless `case`. A search with an older `gen` than the page's newest is refused (409) and
   * cancels nothing; a newer one stops the one running.
   */
  async search(key: string, query: URLSearchParams): Promise<ChangesReply> {
    const q = query.get('q') ?? '';
    const flag = (name: string) => query.get(name) ?? '0';
    const gen = /^\d{1,15}$/.test(query.get('gen') ?? '') ? Number(query.get('gen')) : NaN;
    const glob = query.get('glob') ?? '';

    if (q === '' || q.length > 1000 || !Number.isSafeInteger(gen) || gen < 0 || !['case', 'word', 'regex'].every((name) => flag(name) === '0' || flag(name) === '1') || glob.length > 500) {
      return { status: 400, body: { error: SEARCH_REFUSED } };
    }

    const scope = unscoped(this.deps, key);

    if ('status' in scope) {
      return scope;
    }

    const running = this.#searches.get(key);

    if (running !== undefined && gen < running.gen) {
      return { status: 409, body: { error: 'A newer search replaced this one.', gen: running.gen } };
    }

    running?.stop?.();

    const own = { gen, stop: null as (() => void) | null };

    this.#searches.set(key, own);

    const pattern = globPattern(glob);
    const args = ['-c', 'core.quotepath=off', 'grep', '-z', '-n', '-I', '--untracked', '--exclude-standard', '--no-color', flag('regex') === '1' ? '-E' : '-F', ...(flag('case') === '1' ? [] : ['-i']), ...(flag('word') === '1' ? ['-w'] : []), '-e', q, '--'];
    const result = await new Promise<{ files: SearchFile[]; more: boolean; error?: string; stopped?: true }>((resolve) => {
      const child = (this.deps.spawnGit ?? spawn)('git', args, { cwd: scope.cwd!, env: gitEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const files: SearchFile[] = [];
      let lines = 0;
      let bytes = 0;
      let rest = '';
      let stderr = '';
      let more = false;
      let stopped = false;
      const stop = (why: 'limit' | 'stopped') => {
        more ||= why === 'limit';
        stopped ||= why === 'stopped';
        child.kill();
      };
      const timer = setTimeout(() => stop('limit'), SEARCH_TIMEOUT_MS);

      own.stop = () => stop('stopped');

      const take = (line: string) => {
        const [path = '', number = '', ...text] = line.split('\0');

        if (path === '' || (pattern !== null && !pattern.test(path))) {
          return;
        }

        let file = files.at(-1);

        if (file?.path !== path) {
          if (files.length >= SEARCH_MAX_FILES) {
            stop('limit');
            return;
          }

          file = { path, matches: [] };
          files.push(file);
        }

        file.matches.push({ line: Number(number), text: text.join('\0').slice(0, LINE_MAX_CHARS) });

        if (++lines >= SEARCH_MAX_LINES) {
          stop('limit');
        }
      };

      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        if (more || stopped) {
          return;
        }

        bytes += Buffer.byteLength(chunk);
        rest += chunk;

        const parts = rest.split('\n');

        rest = parts.pop()!;

        for (const line of parts) {
          if (!more) {
            take(line);
          }
        }

        if (bytes >= SEARCH_MAX_BYTES) {
          stop('limit');
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString('utf8')).slice(0, 2000)));
      child.on('error', (error) => resolve({ files, more, error: error.message }));
      child.on('close', (code) => {
        clearTimeout(timer);

        if (!more && !stopped && rest !== '') {
          take(rest);
        }

        resolve(stopped ? { files, more, stopped: true } : code === 0 || code === 1 || more ? { files, more } : { files, more, error: stderr.trim() || `git grep exited with code ${String(code)}.` });
      });
    });

    // Only the newest search for the key clears its record.
    if (this.#searches.get(key) === own) {
      own.stop = null;
    }

    if (result.stopped === true) {
      return { status: 409, body: { error: 'A newer search replaced this one.' } };
    }

    if (!same(this.deps, key, scope)) {
      return { status: 409, body: { error: "The window's conversation changed." } };
    }

    if (result.error !== undefined) {
      return { status: 400, body: { error: result.error.replace(/^fatal: /, '') } };
    }

    const body = { scopeGen: scope.scopeGen, gen, files: result.files, more: result.more };

    return { status: 200, body, etag: etagOf(body) };
  }
}
