#!/usr/bin/env node
// npm run verify: build every workspace, then typecheck each and run every
// unit test (all but *.int.test.ts) in one vitest run, at the same time, without
// coverage. A clean checkout whose tree already passed runs nothing; `--force`
// runs it anyway. `--full`, which GitHub Actions runs, builds, typechecks and runs
// every workspace's tests, integration tests included, with coverage thresholds.
//
// Checks run without the caller's GIT_* variables and fail if they changed the
// repository's shared git config (tools/git-guard.mjs). See docs/testing.md.
import { spawnSync } from 'node:child_process';
import { takeSlot } from './check-lock.mjs';
import { loadWorkspaces } from './check-plan.mjs';
import { cleanGitEnv, guardRepo } from './git-guard.mjs';
import { runAll, unitTests, workspaceJobs } from './run-tests.mjs';
import { cleanTree, passed, recordPass, verifiedFile } from './verified.mjs';

const root = process.cwd();
const full = process.argv.includes('--full');
const tree = full ? null : cleanTree(root);
const verified = verifiedFile(root);

if (tree !== null && !process.argv.includes('--force') && passed(verified, tree)) {
  console.log(`verify: tree ${tree.slice(0, 12)} already passed; nothing to run. Use --force to run it again.`);
  process.exit(0);
}

const guard = guardRepo(root);

function stop(step, failed) {
  const changed = guard.check();

  if (changed) {
    console.error(`verify: ${step} ${changed}`);
    process.exit(1);
  }

  if (failed) {
    console.error(`verify: ${step} failed`);
    process.exit(1);
  }
}

function npm(script) {
  const result = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32', env: cleanGitEnv() });

  stop(`npm run ${script}`, result.status !== 0);
}

takeSlot();

if (full) {
  for (const script of ['build', 'typecheck', 'test']) npm(script);
  process.exit(0);
}

npm('build');

const failed = await runAll([...workspaceJobs('typecheck', loadWorkspaces(root), root), unitTests()], { cwd: root, env: cleanGitEnv() });

stop(failed.length > 0 ? failed.join(', ') : 'typecheck and unit tests', failed.length > 0);

// Recorded only when the checkout had the same tree when the run ended.
if (tree !== null && cleanTree(root) === tree) recordPass(verified, tree);
