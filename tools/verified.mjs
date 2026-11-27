// The trees `npm run verify` passed on, so a merge of a branch already verified
// at the same tree runs nothing again, and a branch checks only what changed
// since its newest passed ancestor. See docs/testing.md.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanGitEnv } from './git-guard.mjs';

const KEEP = 200;

/**
 * The tree of a checkout with nothing changed or untracked, with a hash of the packages it has installed
 * (node_modules/.package-lock.json), or null when it has changes. A tree that passed in one worktree does not count
 * in another whose install is missing or differs.
 */
export function cleanTree(root) {
  if (git(root, 'status', '--porcelain') !== '') return null;

  return `${git(root, 'rev-parse', 'HEAD^{tree}')}-${installed(root)}`;
}

function installed(root) {
  try {
    return createHash('sha256').update(readFileSync(join(root, 'node_modules', '.package-lock.json'))).digest('hex').slice(0, 16);
  } catch {
    return 'none';
  }
}

function git(root, ...args) {
  return gitRaw(root, ...args).trim();
}

function gitRaw(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: cleanGitEnv() });
}

/**
 * The newest of HEAD's KEEP nearest ancestors, HEAD excluded, whose tree passed with the packages installed now, and the
 * files changed between it and HEAD; null when none passed.
 */
export function passedAncestor(root, path) {
  const trees = new Set(readTrees(path));
  const packages = installed(root);
  const commit = git(root, 'log', '--format=%H %T', `--max-count=${KEEP + 1}`, 'HEAD').split('\n').slice(1)
    .map((line) => line.split(' ')).find(([, tree]) => trees.has(`${tree}-${packages}`))?.[0];

  if (commit === undefined) return null;
  return { commit, changed: gitRaw(root, 'diff', '--name-only', '--no-renames', '-z', commit, 'HEAD').split('\0').filter(Boolean) };
}

function readTrees(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** The file in the repository's common git folder that lists the passed trees, shared by its worktrees. */
export function verifiedFile(root) {
  const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', env: cleanGitEnv() }).trim();

  return join(common, 'switchboard-verified');
}

export function passed(path, tree) {
  return readTrees(path).includes(tree);
}

/** Adds `tree` to the passed trees, keeping the newest KEEP. */
export function recordPass(path, tree) {
  writeFileSync(path, [...readTrees(path), tree].slice(-KEEP).map((t) => t + '\n').join(''));
}
