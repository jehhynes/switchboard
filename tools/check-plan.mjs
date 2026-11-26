// Which workspaces the pre-commit hook builds, typechecks and tests (tools/precommit.mjs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Dependencies the manifests do not declare: apps/hub's standalone build carries
// the browser extension's build (apps/hub/carried.cjs).
const UNDECLARED = { '@switchboard/hub-app': ['@switchboard/chrome'] };

/** The workspaces under `root` as `{ dir, name, deps, scripts }`, in package.json order, which is dependency order. */
export function loadWorkspaces(root) {
  const read = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const workspaces = read('.').workspaces.map((dir) => {
    const pkg = read(dir);
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });

    return { dir, name: pkg.name, deps: [...deps, ...(UNDECLARED[pkg.name] ?? [])], scripts: pkg.scripts ?? {} };
  });
  const names = new Set(workspaces.map((w) => w.name));

  for (const w of workspaces) w.deps = w.deps.filter((d) => names.has(d));
  return workspaces;
}

/**
 * `workspaces` are `{ name, deps }` in dependency order; `touched` names the workspaces the staged files are in.
 * `narrow[dependent][dependency]` lists the only test files of `dependent` to run when `dependency` changes.
 *
 * Returns `affected`, the touched workspaces and their dependents, whose tests all run, except a dependent `narrow`
 * names for each changed dependency it has; `partial`, each such dependent with the test files to run, whose own
 * dependents run no tests for it unless `narrow` lists them too; `checked`, both, to typecheck; and `toBuild`,
 * those and their dependencies.
 */
export function checkPlan(workspaces, touched, narrow = {}) {
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const dependsOn = (name, dep, seen = new Set()) => byName.get(name).deps.some((d) => d === dep || (!seen.has(d) && seen.add(d) && dependsOn(d, dep, seen)));

  const affected = new Set(touched);
  for (let grew = true; grew; ) {
    grew = false;
    for (const w of workspaces) {
      if (!affected.has(w.name) && w.deps.some((d) => affected.has(d) && !narrow[w.name]?.[d])) { affected.add(w.name); grew = true; }
    }
  }

  const partial = new Map();
  for (const w of workspaces) {
    if (affected.has(w.name)) continue;
    const files = Object.entries(narrow[w.name] ?? {}).filter(([dep]) => affected.has(dep) && dependsOn(w.name, dep)).flatMap(([, list]) => list);
    if (files.length > 0) partial.set(w.name, [...new Set(files)]);
  }

  const checked = new Set([...affected, ...partial.keys()]);
  const toBuild = new Set(checked);
  for (let grew = true; grew; ) {
    grew = false;
    for (const name of [...toBuild]) for (const d of byName.get(name).deps) if (!toBuild.has(d)) { toBuild.add(d); grew = true; }
  }

  return { affected, partial, checked, toBuild };
}
