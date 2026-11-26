import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const ROOT_NAME = 'switchboard-tests';
/** Claude's and Codex's test homes, which every run shares. */
const HOMES = ['claude-home', 'codex-home'];
/** A folder no run owns, or one a crashed run left, is removed this long after it last changed. */
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Put test temp files, and those of processes tests start, in a folder of this run's own under one folder that can be excluded from
 * antivirus scans. The run's folder is removed when the run ends, so a test that leaves its temp folders leaves nothing behind, and
 * each run removes the folders older runs left when they crashed. Claude's and Codex's homes point at shared folders there too, so a
 * test that forgets to isolate them cannot install hooks in the operator's.
 *
 * It also drops every GIT_* variable from the environment the test workers inherit, and stops git's repository search at the shared
 * folder: a commit hook sets GIT_DIR to the checkout being committed to, and `git init` or `git config` run with it writes to the
 * repository's shared config, as tools/git-guard.mjs explains.
 *
 * The folder is given by its real path, so a test comparing a path it made with one the code resolved agrees even where the OS temp
 * folder is a short 8.3 name, as on GitHub's Windows runners (C:\Users\RUNNER~1), or reached through a link.
 */
export function testTemp(given = tmpdir()): Record<string, string> {
  const base = realPath(given);

  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith('GIT_')) delete process.env[name];
  }

  const homes = (root: string) => ({ CLAUDE_CONFIG_DIR: join(root, HOMES[0]!), CODEX_HOME: join(root, HOMES[1]!), GIT_CEILING_DIRECTORIES: root });

  // A run started by a test, such as a spawned build that runs vitest, inherits the starting run's folder as its temp folder and keeps it.
  if (basename(base) === ROOT_NAME) return { TEMP: base, TMP: base, TMPDIR: base, ...homes(base) };
  if (basename(dirname(base)) === ROOT_NAME && basename(base).startsWith('run-')) return { TEMP: base, TMP: base, TMPDIR: base, ...homes(dirname(base)) };

  const root = join(base, ROOT_NAME);

  mkdirSync(root, { recursive: true });
  removeStale(root);

  const run = mkdtempSync(join(root, `run-${process.pid}-`));

  process.on('exit', () => remove(run));
  return { TEMP: run, TMP: run, TMPDIR: run, ...homes(root) };
}

/** Removes each folder in `root` that is not a shared home and not a live run's, once it is older than STALE_MS. */
export function removeStale(root: string, now = Date.now(), alive = processAlive): void {
  for (const name of readdirSync(root)) {
    if (HOMES.includes(name)) continue;

    const pid = /^run-(\d+)-/.exec(name)?.[1];

    if (pid !== undefined && alive(Number(pid))) continue;

    try {
      if (now - statSync(join(root, name)).mtimeMs > STALE_MS) remove(join(root, name));
    } catch {
      // Gone already, or another run is removing it.
    }
  }
}

function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // A file a process the tests started still holds; a later run removes the folder once it is stale.
  }
}
