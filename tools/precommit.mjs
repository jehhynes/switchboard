#!/usr/bin/env node
// Pre-commit checks for the staged files. See docs/testing.md.
//
// Runs build, typecheck and tests only for the workspaces the staged files
// touch and the workspaces that depend on them; dependencies of those are
// built first, because tests run built bundles. A staged file outside every
// workspace runs the full `npm run verify`. Markdown and text files need no
// checks. The full suite runs before a merge into main, not here.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Workspaces in package.json order, which is dependency order.
const workspaces = rootPackage.workspaces.map((dir) => {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
  return { dir, name: pkg.name, deps, scripts: pkg.scripts ?? {} };
});
const byName = new Map(workspaces.map((w) => [w.name, w]));
// Dependencies the manifests do not declare: the extension bundles apps/hub's
// entry point directly (extensions/switchboard/esbuild.js).
const undeclared = { switchboard: ['@switchboard/hub-app'] };
for (const w of workspaces) w.deps = [...w.deps, ...(undeclared[w.name] ?? [])].filter((d) => byName.has(d));

// Files another workspace's tests read: the hub's dock contract test compares
// its output with the dock's recorded fixture (packages/hub/test/dock.test.ts).
const readBy = [{ prefix: 'apps/dock/test/fixtures/', workspace: '@switchboard/hub' }];

// Files no workspace's checks cover: documentation, and the hook itself, which
// a commit that changes it exercises.
const exempt = (file) => /\.(md|txt)$/i.test(file) || file.startsWith('.githooks/') || file === 'tools/precommit.mjs';

const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMRDTU', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean).filter((f) => !exempt(f));

function run(args) {
  console.log(`pre-commit: npm ${args.join(' ')}`);
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
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
  for (const r of readBy) if (file.startsWith(r.prefix)) touched.add(r.workspace);
}

if (full || outside.length > 0) {
  if (outside.length > 0) console.log(`pre-commit: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', ...' : ''} outside every workspace; running the full verify.`);
  run(['run', 'verify']);
  process.exit(0);
}

// Touched workspaces and everything that depends on them, transitively.
const affected = new Set(touched);
for (let grew = true; grew; ) {
  grew = false;
  for (const w of workspaces) {
    if (!affected.has(w.name) && w.deps.some((d) => affected.has(d))) { affected.add(w.name); grew = true; }
  }
}
// Affected workspaces and their dependencies, transitively, to build.
const toBuild = new Set(affected);
for (let grew = true; grew; ) {
  grew = false;
  for (const name of [...toBuild]) for (const d of byName.get(name).deps) if (!toBuild.has(d)) { toBuild.add(d); grew = true; }
}

const flags = (set, script) => workspaces.filter((w) => set.has(w.name) && w.scripts[script]).flatMap((w) => ['--workspace', w.name]);
console.log(`pre-commit: checking ${[...affected].join(', ')}`);
for (const [script, set] of [['build', toBuild], ['typecheck', affected], ['test', affected]]) {
  const f = flags(set, script);
  if (f.length > 0) run(['run', script, ...f]);
}
