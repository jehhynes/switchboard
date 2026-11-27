// Finds blocked names, such as a real company's, in tracked files, so that `npm run verify` and the pre-commit hook
// fail on one (AGENTS.md § Example data). See docs/testing.md.
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cleanGitEnv } from './git-guard.mjs';

/** The list of blocked names, one per line; it is not searched itself. */
export const LIST = 'tools/blocked-names.txt';

/** Set by the pre-commit hook for the `npm run verify` it starts, which then leaves the names to the hook's search of the index. */
export const STAGED_ONLY = 'SWITCHBOARD_NAMES_STAGED';

/** The names in the list's text: one per line, with blank lines and `#` comments skipped. */
export function parseNames(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
}

/** Each line of `files`, [path, text] pairs, that holds one of `names` as a whole word in any case, as `path:line: name`. Files holding a NUL byte, and the list, are skipped. */
export function findBlocked(files, names) {
  if (names.length === 0) return [];

  const pattern = new RegExp(`\\b(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
  const found = [];

  for (const [path, text] of files) {
    if (path === LIST || text.includes('\0')) continue;

    text.split('\n').forEach((line, i) => {
      for (const match of line.matchAll(pattern)) found.push(`${path}:${i + 1}: ${match[0]}`);
    });
  }

  return found;
}

/** The index entries in `git ls-files -s -z` output as { mode, sha, path }, without submodules. */
export function parseIndex(text) {
  return text.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, sha] = entry.slice(0, tab).split(' ');

    return { mode, sha, path: entry.slice(tab + 1) };
  }).filter((entry) => entry.mode !== '160000');
}

/** The contents of `git cat-file --batch` output for blobs requested by object ID, in request order. */
export function parseBatch(data) {
  const blobs = [];
  let at = 0;

  while (at < data.length) {
    const end = data.indexOf(10, at);
    const [sha, type, size] = data.subarray(at, end).toString('utf8').split(' ');

    if (type !== 'blob') throw new Error(`git cat-file: ${sha} is ${type ?? 'unreadable'}`);
    blobs.push(data.subarray(end + 1, end + 1 + Number(size)));
    at = end + 1 + Number(size) + 1;
  }

  return blobs;
}

/**
 * The blocked names in the checkout's tracked files, or with `staged`, in the staged versions of the staged files, checked
 * against the staged list. The staged search keeps the caller's git environment, so a hook reads the index being committed.
 */
export function blockedNames(root, { staged = false } = {}) {
  const env = staged ? process.env : cleanGitEnv();
  const git = (args, input) => execFileSync('git', args, { cwd: root, env, input, maxBuffer: 1 << 30 });
  const entries = parseIndex(git(['ls-files', '-s', '-z']).toString('utf8'));

  if (!staged) return findBlocked(workingFiles(root, entries), parseNames(readFileSync(join(root, LIST), 'utf8')));

  const changed = new Set(git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMRT', '-z']).toString('utf8').split('\0').filter(Boolean));
  const wanted = entries.filter((entry) => changed.has(entry.path) || entry.path === LIST);
  const blobs = wanted.length > 0 ? parseBatch(git(['cat-file', '--batch'], wanted.map((entry) => entry.sha).join('\n') + '\n')) : [];
  const files = wanted.map((entry, i) => [entry.path, blobs[i].toString('utf8')]);
  const list = files.find(([path]) => path === LIST);

  return findBlocked(files.filter(([path]) => changed.has(path)), parseNames(list ? list[1] : readFileSync(join(root, LIST), 'utf8')));
}

/** Each tracked file's working copy, a symbolic link's target text as git stores it; a file deleted but not yet staged is skipped. */
function* workingFiles(root, entries) {
  for (const { mode, path } of entries) {
    try {
      yield [path, mode === '120000' ? readlinkSync(join(root, path)) : readFileSync(join(root, path), 'utf8')];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
