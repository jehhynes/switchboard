import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Shuts the operator's git out of the tests: every `GIT_*` variable goes, since a commit hook that runs the tests sets `GIT_DIR` and
 * `GIT_INDEX_FILE`, which would point the tests' git commands at the repository being committed to, and the global and system config are
 * replaced by an empty file, so autocrlf and other settings do not change what git prints.
 */
export function isolateGit(): void {
  const home = mkdtempSync(join(tmpdir(), 'sb-git-home-'));
  const ceiling = process.env['GIT_CEILING_DIRECTORIES'] || tmpdir();

  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase().startsWith('GIT_')) {
      delete process.env[name];
    }
  }

  writeFileSync(join(home, '.gitconfig'), '');
  process.env['GIT_CONFIG_GLOBAL'] = join(home, '.gitconfig');
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  // git's repository search stops at the test temp folder.
  process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
}

export interface Repo {
  root: string;
  git(...args: string[]): string;
  write(path: string, text: string | Buffer): void;
}

function refuseOuterGit(): void {
  if (Object.keys(process.env).some((name) => /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY)$/i.test(name))) {
    throw new Error('Call isolateGit() before makeRepo().');
  }
}

/** The repository at `root`, its git commands run there. */
function repoAt(root: string): Repo {
  return {
    root,
    git: (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }),
    write: (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    },
  };
}

/** Builds a repository with one commit, which `work` and `origin/main` name, holding `files`, in four git commands. */
function buildRepo(files: Record<string, string | Buffer>): Repo {
  const repo = repoAt(mkdtempSync(join(tmpdir(), 'sb-changes-')));

  made.push(repo.root);
  repo.git('init', '-q', '-b', 'work');

  // Every command below writes to this repository only.
  if (resolve(repo.git('rev-parse', '--absolute-git-dir').trim()).toLowerCase() !== resolve(repo.root, '.git').toLowerCase()) {
    throw new Error(`git does not run in the scratch repository ${repo.root}; check the GIT_* variables.`);
  }

  // The repository's own config, written as `git config` would.
  appendFileSync(join(repo.root, '.git', 'config'), '[user]\n\temail = test@example.com\n\tname = Test\n[core]\n\tautocrlf = false\n');

  // One fast-import writes the blobs, the commit and both refs; reset then fills the index from it.
  const entries = Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.isBuffer(text) ? text : Buffer.from(text) }));
  const stream = [
    Buffer.from(`commit refs/heads/work\ncommitter Test <test@example.com> ${Math.floor(Date.now() / 1000)} +0000\ndata 4\nbase\n`),
    ...entries.flatMap(({ path, bytes }) => [Buffer.from(`M 100644 inline ${path}\ndata ${bytes.length}\n`), bytes, Buffer.from('\n')]),
    Buffer.from('\nreset refs/remotes/origin/main\nfrom refs/heads/work\n\n'),
  ];

  execFileSync('git', ['-C', repo.root, 'fast-import', '--quiet'], { input: Buffer.concat(stream) });

  for (const { path, bytes } of entries) {
    repo.write(path, bytes);
  }

  repo.git('reset', '-q');

  return repo;
}

/** Each worker's built repositories, by what built them; a test gets a copy, so it may change it freely. */
const templates = new Map<string, Repo>();
/** Every folder this worker made a repository in. */
const made: string[] = [];

/** A copy of the repository `key` names, built by `build` the first time this worker asks for it. */
export function copyOf(key: string, build: () => Repo): Repo {
  refuseOuterGit();

  let template = templates.get(key);

  if (template === undefined) {
    template = build();
    templates.set(key, template);
  }

  const root = mkdtempSync(join(tmpdir(), 'sb-changes-'));

  made.push(root);
  cpSync(template.root, root, { recursive: true, preserveTimestamps: true });

  const repo = repoAt(root);

  // The copies' files have new IDs and change times, so git refreshes the index now rather than during the test, whose reads compare the
  // index file's stamp.
  repo.git('update-index', '-q', '--refresh');

  return repo;
}

/** A repository with one commit that `origin/main` names, so it is the merge base, holding `files`. */
export function makeRepo(files: Record<string, string | Buffer>): Repo {
  const key = JSON.stringify(Object.entries(files).map(([path, text]) => [path, Buffer.isBuffer(text) ? text.toString('base64') : text, Buffer.isBuffer(text)]));

  return copyOf(`files ${key}`, () => buildRepo(files));
}

/** Removes every repository this worker made; run it once its tests' git commands have ended. */
export function removeRepos(): void {
  for (const root of made.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }

  templates.clear();
}

export const lines = (count: number, word = 'line'): string => Array.from({ length: count }, (_, index) => `${word} ${index + 1}\n`).join('');

/** A worktree with a commit after the base, a staged rename, an unstaged edit and deletion, an untracked text and binary file. */
export function busyRepo(): Repo {
  return copyOf('busy', () => {
    const repo = buildRepo({ 'src/kept.ts': lines(5), 'src/old-name.ts': lines(8), 'gone.txt': 'bye\n', 'edited.md': lines(3), 'committed.ts': lines(2) });

    repo.write('committed.ts', lines(4));
    repo.write('added-in-commit.ts', 'export {};\n');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'work');
    repo.git('mv', 'src/old-name.ts', 'src/new-name.ts');
    repo.write('edited.md', 'line 1\nchanged\nline 3\n');
    rmSync(join(repo.root, 'gone.txt'));
    repo.write('notes/new.txt', 'one\ntwo\nthree');
    repo.write('image.bin', Buffer.from([0, 1, 2, 3]));
    repo.write('.gitignore', 'ignored.log\n');
    repo.write('ignored.log', 'not listed\n');

    return repo;
  });
}

let twoCommitIds: { base: string; first: string; second: string } | null = null;

/** busyRepo with a second commit after the first, which edits committed.ts again and deletes src/kept.ts: `first` and `second`, and the base. */
export function twoCommits(): { repo: Repo; base: string; first: string; second: string } {
  const repo = copyOf('two commits', () => {
    const built = busyRepo();

    // Only these two files, so the staged rename and the rest of the work stay uncommitted.
    built.write('committed.ts', lines(6));
    built.git('rm', '-q', 'src/kept.ts');
    built.git('commit', '-qm', 'second: more lines', '--', 'committed.ts', 'src/kept.ts');
    twoCommitIds = { base: built.git('rev-parse', 'origin/main').trim(), first: built.git('rev-parse', 'HEAD~1').trim(), second: built.git('rev-parse', 'HEAD').trim() };

    return built;
  });

  return { repo, ...twoCommitIds! };
}
