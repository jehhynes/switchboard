#!/usr/bin/env node
// Pre-commit checks for the staged files. See docs/testing.md.
//
// Builds, then typechecks and runs the unit tests of, the workspaces the staged
// files touch and the workspaces that depend on them, or only the test files
// `narrow` lists for a dependent; dependencies of those are built first, because
// tests run built bundles. It waits for a machine-wide check slot first
// (tools/check-lock.mjs). A staged file outside every workspace runs `npm run
// verify`. Markdown and text files need no checks. Integration tests and
// coverage run in GitHub Actions, not here. Every staged file, these included,
// fails on a name tools/blocked-names.txt lists.
import { execFileSync, spawnSync } from 'node:child_process';
import { blockedNames, LIST, STAGED_ONLY } from './blocked-names.mjs';
import { takeSlot } from './check-lock.mjs';
import { lowPriority } from './low-priority.mjs';
import { checkPlan, loadWorkspaces, touchedWorkspaces, unchecked } from './check-plan.mjs';
import { runAll, unitTests, workspaceJobs } from './run-tests.mjs';
import { cleanGitEnv, guardRepo } from './git-guard.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const guard = guardRepo(root, { checkout: true });
const workspaces = loadWorkspaces(root);

// Files no workspace's checks cover: documentation, and the hook itself, which
// a commit that changes it exercises.
const exempt = (file) => unchecked(file, workspaces) || file.startsWith('.githooks/') || file === 'tools/precommit.mjs';

const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMRDTU', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean).filter((f) => !exempt(f));

// The checks run without the hook's GIT_* variables (tools/git-guard.mjs), and
// fail if they changed the repository's shared git config, or this checkout's
// HEAD, branch or index, anyway.
function run(args) {
  console.log(`pre-commit: npm ${args.join(' ')}`);
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...cleanGitEnv(), [STAGED_ONLY]: '1' } });
  const changed = guard.check();
  if (changed) {
    console.error('');
    console.error(`pre-commit: npm ${args.join(' ')} ${changed}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error('');
    console.error(`pre-commit: npm ${args.join(' ')} failed. Fix it, or use --no-verify only for a WIP commit.`);
    process.exit(1);
  }
}

// Every staged file, documentation included, against the blocked names.
const blocked = blockedNames(root, { staged: true });
if (blocked.length > 0) {
  console.error(`pre-commit: staged files hold names ${LIST} blocks; use the examples in AGENTS.md § Example data:\n${blocked.join('\n')}`);
  process.exit(1);
}

const full = process.env.SWITCHBOARD_VERIFY === 'full';
if (staged.length === 0 && !full) process.exit(0);

const { touched, outside } = touchedWorkspaces(workspaces, staged);

if (full || outside.length > 0) {
  if (outside.length > 0) console.log(`pre-commit: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', ...' : ''} outside every workspace; running the full verify.`);
  // SWITCHBOARD_VERIFY=full runs it even for a tree that already passed.
  run(['run', 'verify', ...(full ? ['--', '--force'] : [])]);
  process.exit(0);
}

// A dependent whose tests mostly do not use a dependency: a change to that
// dependency runs only these test files of the dependent, and its own dependents
// run no tests for it unless listed here too. The full verify runs the rest.
const narrow = {
  '@switchboard/hub': { '@switchboard/web': ['test/page.test.ts', 'test/pageAssets.test.ts'] },
};

const { affected, partial, checked, toBuild } = checkPlan(workspaces, touched, narrow);

lowPriority();

// One session's checks at a time across the machine (tools/check-lock.mjs).
takeSlot();

const byName = new Map(workspaces.map((w) => [w.name, w]));
console.log(`pre-commit: checking ${[...affected].join(', ')}${partial.size > 0 ? `; for them, ${[...partial].map(([name, files]) => `${name} ${files.join(' ')}`).join('; ')}` : ''}`);
const build = workspaces.filter((w) => toBuild.has(w.name) && w.scripts.build).flatMap((w) => ['--workspace', w.name]);
if (build.length > 0) run(['run', 'build', ...build]);

// Typechecks and unit tests at once, the tests in one vitest run without coverage
// or integration tests (tools/run-tests.mjs); the full suite runs in GitHub Actions.
const jobs = workspaceJobs('typecheck', workspaces.filter((w) => checked.has(w.name)), root);
const testing = workspaces.filter((w) => affected.has(w.name) && w.scripts.test).map((w) => w.name);
if (testing.length > 0) jobs.push(unitTests({ projects: testing }));
for (const [name, files] of partial) {
  if (byName.get(name).scripts.test) jobs.push(unitTests({ projects: [name], files: files.map((f) => `${byName.get(name).dir}/${f}`), label: `${name} unit tests ${files.join(' ')}` }));
}
if (jobs.length > 0) {
  const failed = await runAll(jobs, { cwd: root, env: cleanGitEnv() });
  const changed = guard.check();
  if (changed) {
    console.error('');
    console.error(`pre-commit: checks ${changed}`);
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error('');
    console.error(`pre-commit: ${failed.join(', ')} failed. Fix it, or use --no-verify only for a WIP commit.`);
    process.exit(1);
  }
}
