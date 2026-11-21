#!/usr/bin/env node
// npm run verify: build, typecheck and test every workspace, without the
// caller's GIT_* variables, failing if the run changed the repository's shared
// git config (tools/git-guard.mjs). See docs/testing.md.
import { spawnSync } from 'node:child_process';
import { cleanGitEnv, guardRepo } from './git-guard.mjs';

const guard = guardRepo(process.cwd());

for (const script of ['build', 'typecheck', 'test']) {
  const result = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32', env: cleanGitEnv() });
  const changed = guard.check();

  if (changed) {
    console.error(`verify: npm run ${script} ${changed}`);
    process.exit(1);
  }

  if (result.status !== 0) process.exit(result.status ?? 1);
}
