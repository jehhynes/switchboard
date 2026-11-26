// The trees `npm run verify` passed on, so a merge of a branch already verified
// at the same tree runs nothing again. See docs/testing.md.
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
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: cleanGitEnv() }).trim();

  if (git('status', '--porcelain') !== '') return null;

  let installed = 'none';

  try {
    installed = createHash('sha256').update(readFileSync(join(root, 'node_modules', '.package-lock.json'))).digest('hex').slice(0, 16);
  } catch { /* Nothing installed. */ }

  return `${git('rev-parse', 'HEAD^{tree}')}-${installed}`;
}

/** The file in the repository's common git folder that lists the passed trees, shared by its worktrees. */
export function verifiedFile(root) {
  const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', env: cleanGitEnv() }).trim();

  return join(common, 'switchboard-verified');
}

export function passed(path, tree) {
  try {
    return readFileSync(path, 'utf8').split('\n').includes(tree);
  } catch {
    return false;
  }
}

/** Adds `tree` to the passed trees, keeping the newest KEEP. */
export function recordPass(path, tree) {
  let trees = [];

  try {
    trees = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch { /* First pass. */ }

  writeFileSync(path, [...trees, tree].slice(-KEEP).map((t) => t + '\n').join(''));
}
