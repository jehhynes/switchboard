#!/usr/bin/env node
// Pre-commit checks for the staged files. See docs/testing.md.
//
// Runs build, typecheck and tests, without coverage, only for the workspaces the
// staged files touch and the workspaces that depend on them, or only the test files
// `narrow` lists for a dependent; dependencies of those are built first, because
// tests run built bundles. It waits for a machine-wide check slot first
// (tools/check-lock.mjs). A staged file outside every
// workspace runs the full `npm run verify`. Markdown and text files need no
// checks. The full suite runs before a merge into main, not here.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeSlot } from './check-lock.mjs';
import { checkPlan } from './check-plan.mjs';
import { cleanGitEnv, guardRepo } from './git-guard.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const guard = guardRepo(root, { checkout: true });
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Workspaces in package.json order, which is dependency order.
const workspaces = rootPackage.workspaces.map((dir) => {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
  return { dir, name: pkg.name, deps, scripts: pkg.scripts ?? {} };
});
const byName = new Map(workspaces.map((w) => [w.name, w]));
// Dependencies the manifests do not declare: apps/hub's standalone build carries
// the browser extension's build (apps/hub/carried.cjs).
const undeclared = { '@switchboard/hub-app': ['@switchboard/chrome'] };
for (const w of workspaces) w.deps = [...w.deps, ...(undeclared[w.name] ?? [])].filter((d) => byName.has(d));

// Files no workspace's checks cover: documentation, and the hook itself, which
// a commit that changes it exercises.
const exempt = (file) => /\.(md|txt)$/i.test(file) || file.startsWith('.githooks/') || file === 'tools/precommit.mjs';

const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMRDTU', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean).filter((f) => !exempt(f));

// The checks run without the hook's GIT_* variables (tools/git-guard.mjs), and
// fail if they changed the repository's shared git config, or this checkout's
// HEAD, branch or index, anyway.
function run(args) {
  console.log(`pre-commit: npm ${args.join(' ')}`);
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: cleanGitEnv() });
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

const full = process.env.SWITCHBOARD_VERIFY === 'full';
if (staged.length === 0 && !full) process.exit(0);

const touched = new Set();
const outside = [];
for (const file of staged) {
  const w = workspaces.find((ws) => file.startsWith(ws.dir + '/'));
  if (w) touched.add(w.name);
  else outside.push(file);
}

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
  '@switchboard/hub-app': { '@switchboard/web': ['test/install.test.ts'], '@switchboard/chrome': ['test/install.test.ts'] },
};

const { affected, partial, checked, toBuild } = checkPlan(workspaces, touched, narrow);

// One session's checks at a time across the machine (tools/check-lock.mjs).
takeSlot();

const flags = (set, script) => workspaces.filter((w) => set.has(w.name) && w.scripts[script]).flatMap((w) => ['--workspace', w.name]);
console.log(`pre-commit: checking ${[...affected].join(', ')}${partial.size > 0 ? `; for them, ${[...partial].map(([name, files]) => `${name} ${files.join(' ')}`).join('; ')}` : ''}`);
// Tests run without coverage: its thresholds are checked by the full verify before a merge.
const noCoverage = '--coverage.enabled=false';
for (const [script, set, extra] of [['build', toBuild, []], ['typecheck', checked, []], ['test', affected, ['--', noCoverage]]]) {
  const f = flags(set, script);
  if (f.length > 0) run(['run', script, ...f, ...extra]);
}
for (const [name, files] of partial) run(['run', 'test', '--workspace', name, '--', noCoverage, ...files]);
