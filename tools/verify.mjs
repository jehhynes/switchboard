#!/usr/bin/env node
// npm run verify: build every workspace, then typecheck each and run every
// unit test (all but *.int.test.ts) in one vitest run, at the same time, without
// coverage. A clean checkout whose tree already passed runs nothing; one with a
// passed ancestor checks only the workspaces changed since it and their
// dependents, unless a file outside every workspace changed. `--force` checks
// everything. `--full`, which GitHub Actions runs, builds, typechecks and runs
// every workspace's tests, integration tests included, with coverage thresholds.
//
// Checks run without the caller's GIT_* variables and fail if they changed the
// repository's shared git config (tools/git-guard.mjs). See docs/testing.md.
import { spawnSync } from 'node:child_process';
import { takeSlot } from './check-lock.mjs';
import { lowPriority } from './low-priority.mjs';
import { checkPlan, loadWorkspaces, touchedWorkspaces, unchecked } from './check-plan.mjs';
import { cleanGitEnv, guardRepo } from './git-guard.mjs';
import { runAll, unitTests, workspaceJobs } from './run-tests.mjs';
import { cleanTree, passed, passedAncestor, recordPass, verifiedFile } from './verified.mjs';

const root = process.cwd();
const full = process.argv.includes('--full');
const force = process.argv.includes('--force');
const tree = full ? null : cleanTree(root);
const verified = verifiedFile(root);

if (tree !== null && !force && passed(verified, tree)) {
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

function npm(script, ...args) {
  const result = spawnSync('npm', ['run', script, ...args], { stdio: 'inherit', shell: process.platform === 'win32', env: cleanGitEnv() });

  stop(`npm run ${script}`, result.status !== 0);
}

/** The checks for what changed since the newest passed ancestor, or null to check everything. */
function changedPlan() {
  const base = passedAncestor(root, verified);

  if (base === null) return null;

  const { touched, outside } = touchedWorkspaces(workspaces, base.changed.filter((f) => !unchecked(f, workspaces)));

  if (outside.length > 0) {
    console.log(`verify: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', ...' : ''} changed outside every workspace since passed ${base.commit.slice(0, 12)}; checking everything.`);
    return null;
  }

  const plan = checkPlan(workspaces, touched);

  console.log(`verify: since passed ${base.commit.slice(0, 12)}, checking ${plan.checked.size > 0 ? [...plan.checked].join(', ') : 'nothing'}.`);
  return plan;
}

lowPriority();
takeSlot();

if (full) {
  for (const script of ['build', 'typecheck', 'test']) npm(script);
  process.exit(0);
}

const workspaces = loadWorkspaces(root);
const plan = tree !== null && !force ? changedPlan() : null;
let jobs;

if (plan === null) {
  npm('build');
  jobs = [...workspaceJobs('typecheck', workspaces, root), unitTests()];
} else {
  const build = workspaces.filter((w) => plan.toBuild.has(w.name) && w.scripts.build).flatMap((w) => ['--workspace', w.name]);
  const testing = workspaces.filter((w) => plan.affected.has(w.name) && w.scripts.test).map((w) => w.name);

  if (build.length > 0) npm('build', ...build);
  jobs = workspaceJobs('typecheck', workspaces.filter((w) => plan.checked.has(w.name)), root);
  if (testing.length > 0) jobs.push(unitTests({ projects: testing }));
}

const failed = await runAll(jobs, { cwd: root, env: cleanGitEnv() });

stop(failed.length > 0 ? failed.join(', ') : 'typecheck and unit tests', failed.length > 0);

// Recorded only when the checkout had the same tree when the run ended.
if (tree !== null && cleanTree(root) === tree) recordPass(verified, tree);
