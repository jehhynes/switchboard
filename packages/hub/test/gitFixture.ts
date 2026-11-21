import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Shuts the operator's git out of the tests: every `GIT_*` variable goes, since a commit hook that runs the tests sets `GIT_DIR` and
 * `GIT_INDEX_FILE`, which would point the tests' git commands at the repository being committed to, and the global and system config are
 * replaced by an empty file, so autocrlf and other settings do not change what git prints.
 */
export function isolateGit(): void {
  const home = mkdtempSync(join(tmpdir(), 'sb-git-home-'));

  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith('GIT_')) {
      delete process.env[name];
    }
  }

  writeFileSync(join(home, '.gitconfig'), '');
  process.env['GIT_CONFIG_GLOBAL'] = join(home, '.gitconfig');
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
}

export interface Repo {
  root: string;
  git(...args: string[]): string;
  write(path: string, text: string | Buffer): void;
}

/** A repository with one commit that `origin/main` names, so it is the merge base, holding `files`. */
export function makeRepo(files: Record<string, string | Buffer>): Repo {
  if (Object.keys(process.env).some((name) => /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY)$/i.test(name))) {
    throw new Error('Call isolateGit() before makeRepo().');
  }

  const root = mkdtempSync(join(tmpdir(), 'sb-changes-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const write = (path: string, text: string | Buffer): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  git('init', '-q', '-b', 'work');

  // Every command below writes to this repository only.
  if (resolve(git('rev-parse', '--absolute-git-dir').trim()).toLowerCase() !== resolve(root, '.git').toLowerCase()) {
    throw new Error(`git does not run in the scratch repository ${root}; check the GIT_* variables.`);
  }

  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');

  for (const [path, text] of Object.entries(files)) {
    write(path, text);
  }

  git('add', '-A');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  return { root, git, write };
}
