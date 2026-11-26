#!/usr/bin/env node
// npm run verify: build, typecheck and test every workspace, without the
// caller's GIT_* variables, failing if the run changed the repository's shared
// git config (tools/git-guard.mjs). A clean checkout whose tree already passed
// runs nothing; `npm run verify -- --force` runs it anyway. See docs/testing.md.
import { spawnSync } from 'node:child_process';
import { takeSlot } from './check-lock.mjs';
import { cleanGitEnv, guardRepo } from './git-guard.mjs';
import { cleanTree, passed, recordPass, verifiedFile } from './verified.mjs';

const root = process.cwd();
const tree = cleanTree(root);
const verified = verifiedFile(root);

if (tree !== null && !process.argv.includes('--force') && passed(verified, tree)) {
  console.log(`verify: tree ${tree.slice(0, 12)} already passed; nothing to run. Use --force to run it again.`);
  process.exit(0);
}

const guard = guardRepo(root);

takeSlot();

for (const script of ['build', 'typecheck', 'test']) {
  const result = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32', env: cleanGitEnv() });
  const changed = guard.check();

  if (changed) {
    console.error(`verify: npm run ${script} ${changed}`);
    process.exit(1);
  }

  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Recorded only when the checkout did not change during the run.
if (tree !== null && cleanTree(root) === tree) recordPass(verified, tree);
