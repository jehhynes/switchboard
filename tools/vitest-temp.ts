import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Put test temp files, and those of processes tests start, in one folder that can be excluded from antivirus scans.
 * Claude's and Codex's homes point there too, so a test that forgets to isolate them cannot install hooks in the operator's.
 *
 * It also drops every GIT_* variable from the environment the test workers inherit, and stops git's repository search at
 * that folder: a commit hook sets GIT_DIR to the checkout being committed to, and `git init` or `git config` run with it
 * writes to the repository's shared config, as tools/git-guard.mjs explains.
 */
export function testTemp(): Record<string, string> {
  const base = tmpdir();
  const dir = basename(base) === 'switchboard-tests' ? base : join(base, 'switchboard-tests');

  mkdirSync(dir, { recursive: true });

  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith('GIT_')) delete process.env[name];
  }

  return { TEMP: dir, TMP: dir, TMPDIR: dir, CLAUDE_CONFIG_DIR: join(dir, 'claude-home'), CODEX_HOME: join(dir, 'codex-home'), GIT_CEILING_DIRECTORIES: dir };
}
