import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileInside, nodeGit, parseNameStatus, parseNumstat, parseStatusWorking, readChanges, relativePath } from '../src/changes.js';
import type { ChangesView, Git, WorktreeChanges } from '../src/changes.js';
import { busyRepo, isolateGit, lines, makeRepo, removeRepos } from './gitFixture.js';

beforeAll(() => isolateGit());
afterAll(() => removeRepos());

// Git-backed suites create commits and run several reads; Windows process startup can exceed Vitest's five-second default.
const gitTimeout = { timeout: process.platform === 'win32' ? 15_000 : 5_000 };

describe('readChanges', gitTimeout, () => {
  it('lists every change from the merge base to disk once, with its status, stages and counts', async () => {
    const repo = busyRepo();
    const read = (await readChanges(repo.root)) as WorktreeChanges;
    const view: ChangesView = read.view;

    expect(view.base).toBe(repo.git('rev-parse', 'origin/main').trim());
    expect(view.head).toBe(repo.git('rev-parse', 'HEAD').trim());
    expect(view.rows.map(({ path, from, status, stages, additions, deletions, binary }) => ({ path, from, status, stages, additions, deletions, binary }))).toEqual([
      { path: '.gitignore', from: undefined, status: 'U', stages: ['untracked'], additions: 1, deletions: 0, binary: false },
      { path: 'added-in-commit.ts', from: undefined, status: 'A', stages: ['committed'], additions: 1, deletions: 0, binary: false },
      { path: 'committed.ts', from: undefined, status: 'M', stages: ['committed'], additions: 2, deletions: 0, binary: false },
      { path: 'edited.md', from: undefined, status: 'M', stages: ['working'], additions: 1, deletions: 1, binary: false },
      { path: 'gone.txt', from: undefined, status: 'D', stages: ['working'], additions: 0, deletions: 1, binary: false },
      { path: 'image.bin', from: undefined, status: 'U', stages: ['untracked'], additions: null, deletions: null, binary: true },
      { path: 'notes/new.txt', from: undefined, status: 'U', stages: ['untracked'], additions: 3, deletions: 0, binary: false },
      { path: 'src/new-name.ts', from: 'src/old-name.ts', status: 'R', stages: ['staged'], additions: 0, deletions: 0, binary: false },
    ]);
    expect(view.stages).toEqual({ committed: 2, staged: 1, working: 2, untracked: 3 });
    expect(view.shown).toBe(8);
    expect(view.total).toBe(8);
    expect(read.ref).toBe(view.base);
    expect(read.sides.get('src/new-name.ts')).toMatchObject({ original: { path: 'src/old-name.ts' }, modified: { path: 'src/new-name.ts', ref: null }, untracked: false });
    expect(read.sides.get('notes/new.txt')).toMatchObject({ original: null, untracked: true });
  });

  it("refuses a folder inside a repository rather than show the repository's changes", async () => {
    const repo = busyRepo();

    expect(await readChanges(join(repo.root, 'src'))).toEqual({ error: expect.stringContaining('is not the top of its git repository') });
  });

  it('lists uncommitted changes against HEAD when no base ref shares its history', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });

    repo.git('update-ref', '-d', 'refs/remotes/origin/main');
    repo.write('a.txt', 'b\n');

    const read = (await readChanges(repo.root)) as WorktreeChanges;

    expect(read.view.base).toBeNull();
    expect(read.ref).toBe(read.view.head);
    expect(read.view.rows.map((row) => [row.path, row.status])).toEqual([['a.txt', 'M']]);
  });

  it('ReadChanges_AbsentBaseRefs_AsksGitForTheMergeBaseOfOnlyTheRefsThatExist', async () => {
    const mergeBases = (calls: string[][]) => calls.filter((args) => args[0] === 'merge-base').map((args) => args.slice(1));
    const recording = (refsFail = false) => {
      const calls: string[][] = [];
      const git: Git = (args, cwd, options) => {
        calls.push(args);

        return refsFail && args[0] === 'for-each-ref' ? Promise.resolve({ code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: refs unreadable', tooLarge: false }) : nodeGit(args, cwd, options);
      };

      return { calls, git };
    };
    const repo = makeRepo({ 'a.txt': 'a\n' });
    const base = repo.git('rev-parse', 'origin/main').trim();

    // Only origin/main exists: origin/HEAD and origin/master are never asked for.
    const one = recording();

    expect(((await readChanges(repo.root, one.git)) as WorktreeChanges).view.base).toBe(base);
    expect(mergeBases(one.calls)).toEqual([['HEAD', 'origin/main']]);

    // Refs that cannot be listed are all tried, in order, until one shares HEAD's history.
    const unlisted = recording(true);

    expect(((await readChanges(repo.root, unlisted.git)) as WorktreeChanges).view.base).toBe(base);
    expect(mergeBases(unlisted.calls)).toEqual([['HEAD', 'origin/HEAD'], ['HEAD', 'origin/main']]);

    // origin/master alone is found after the two that are missing, which git is not asked about.
    repo.git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    repo.git('update-ref', '-d', 'refs/remotes/origin/main');

    const master = recording();

    expect(((await readChanges(repo.root, master.git)) as WorktreeChanges).view.base).toBe(base);
    expect(mergeBases(master.calls)).toEqual([['HEAD', 'origin/master']]);

    // A local branch git takes for the short name counts too, as git merge-base HEAD origin/main would find it.
    repo.git('update-ref', '-d', 'refs/remotes/origin/master');
    repo.git('update-ref', 'refs/heads/origin/main', 'HEAD');

    const local = recording();

    expect(((await readChanges(repo.root, local.git)) as WorktreeChanges).view.base).toBe(base);
    expect(mergeBases(local.calls)).toEqual([['HEAD', 'origin/main']]);

    // No base ref: no merge-base at all, and the changes are read against HEAD.
    repo.git('update-ref', '-d', 'refs/heads/origin/main');

    const none = recording();
    const read = (await readChanges(repo.root, none.git)) as WorktreeChanges;

    expect(read.view.base).toBeNull();
    expect(read.ref).toBe(read.view.head);
    expect(mergeBases(none.calls)).toEqual([]);
  });

  it('ReadChanges_Uncommitted_ListsOnlyChangesFromHeadToDisk', async () => {
    const repo = busyRepo();

    // Committed after the base, then changed again on disk: the uncommitted list has only the change since HEAD.
    repo.write('committed.ts', lines(5));

    const read = (await readChanges(repo.root, nodeGit, true, { from: 'HEAD', to: 'worktree' })) as WorktreeChanges;

    expect(read.view).toMatchObject({ base: repo.git('rev-parse', 'origin/main').trim(), head: repo.git('rev-parse', 'HEAD').trim(), from: 'HEAD', to: 'worktree', stages: { committed: 0, staged: 1, working: 3, untracked: 3 } });
    expect(read.ref).toBe(read.view.head);
    expect(read.view.rows.map(({ path, status, stages, additions, deletions }) => [path, status, stages.join(), additions, deletions])).toEqual([
      ['.gitignore', 'U', 'untracked', 1, 0],
      ['committed.ts', 'M', 'working', 1, 0],
      ['edited.md', 'M', 'working', 1, 1],
      ['gone.txt', 'D', 'working', 0, 1],
      ['image.bin', 'U', 'untracked', null, null],
      ['notes/new.txt', 'U', 'untracked', 3, 0],
      ['src/new-name.ts', 'R', 'staged', 0, 0],
    ]);
    expect(((await readChanges(repo.root)) as WorktreeChanges).view).toMatchObject({ from: 'base', to: 'worktree', stages: { committed: 2 } });
  });

  it('answers no rows for a worktree that matches its base', async () => {
    const read = (await readChanges(makeRepo({ 'a.txt': 'a\n' }).root)) as WorktreeChanges;

    expect(read.view).toMatchObject({ rows: [], shown: 0, total: 0 });
  });

  it('marks a conflicted file C', async () => {
    const repo = makeRepo({ 'a.txt': 'base\n' });

    repo.git('checkout', '-qb', 'other');
    repo.write('a.txt', 'theirs\n');
    repo.git('commit', '-qam', 'theirs');
    repo.git('checkout', '-q', 'work');
    repo.write('a.txt', 'ours\n');
    repo.git('commit', '-qam', 'ours');

    try {
      repo.git('merge', '-q', 'other');
    } catch {
      // The conflict is the point.
    }

    const read = (await readChanges(repo.root)) as WorktreeChanges;

    expect(read.view.rows.find((row) => row.path === 'a.txt')?.status).toBe('C');
  });

  it('marks a file both sides added C, not A', async () => {
    const repo = makeRepo({ 'base.txt': 'base\n' });

    repo.git('checkout', '-qb', 'other');
    repo.write('both.txt', 'theirs\n');
    repo.git('add', 'both.txt');
    repo.git('commit', '-qm', 'theirs');
    repo.git('checkout', '-q', 'work');
    repo.write('both.txt', 'ours\n');
    repo.git('add', 'both.txt');
    repo.git('commit', '-qm', 'ours');

    try {
      repo.git('merge', '-q', 'other');
    } catch {
      // The conflict is the point.
    }

    const read = (await readChanges(repo.root)) as WorktreeChanges;

    expect(read.view.rows.find((row) => row.path === 'both.txt')?.status).toBe('C');
  });

  it('counts many untracked files, read a few at a time', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });

    for (let index = 0; index < 20; index++) {
      repo.write(`many/${String(index).padStart(2, '0')}.txt`, 'x\n');
    }

    const read = (await readChanges(repo.root)) as WorktreeChanges;

    expect(read.view.rows).toHaveLength(20);
    expect(read.view.rows.every((row) => row.status === 'U' && row.additions === 1)).toBe(true);
  });

  it("reads the session's repository even when the hub's environment names another, as a commit hook's does", async () => {
    const decoy = makeRepo({ 'decoy.txt': 'decoy\n' });
    const repo = makeRepo({ 'a.txt': 'a\n' });

    repo.write('a.txt', 'b\n');
    process.env['GIT_DIR'] = join(decoy.root, '.git');
    process.env['GIT_INDEX_FILE'] = join(decoy.root, '.git', 'index');

    try {
      const read = (await readChanges(repo.root)) as WorktreeChanges;

      expect(read.view.rows.map((row) => row.path)).toEqual(['a.txt']);
    } finally {
      delete process.env['GIT_DIR'];
      delete process.env['GIT_INDEX_FILE'];
    }
  });

  it('hashes no file a junction leads to, and still hashes the rest', async () => {
    const repo = makeRepo({ 'dir/a.txt': 'a\n', 'b.txt': 'b\n' });
    const outside = mkdtempSync(join(tmpdir(), 'sb-hash-out-'));

    writeFileSync(join(outside, 'a.txt'), 'outside\n');
    rmSync(join(repo.root, 'dir'), { recursive: true });
    symlinkSync(outside, join(repo.root, 'dir'), 'junction');
    repo.write('b.txt', 'changed\n');

    const rows = ((await readChanges(repo.root)) as WorktreeChanges).view.rows;

    expect(rows.find((row) => row.path === 'b.txt')!.hash).toBe(repo.git('hash-object', '--no-filters', 'b.txt').trim());
    expect(rows.some((row) => row.path.startsWith('dir'))).toBe(true);
    expect(rows.filter((row) => row.path.startsWith('dir')).every((row) => row.hash === 'unreadable' || row.hash === 'deleted')).toBe(true);
  });

  it('says why for a folder outside any repository', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sb-no-repo-'));

    expect(await readChanges(folder)).toEqual({ error: `${folder} is not in a git repository.` });
  });
});

describe('git output parsing', () => {
  it('ParseStatusWorking_PorcelainV2_ReadsHeadAndEachPathsWorkingTreeChange', () => {
    const sha = 'a'.repeat(40);
    const entry = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 ${sha} ${sha} ${path}`;
    const output = Buffer.from(
      [
        `# branch.oid ${sha}`,
        '# branch.head main',
        entry('M.', 'staged.ts'),
        entry('.D', 'Gone.txt'),
        entry('MM', 'with space.ts'),
        entry('.A', 'intent.ts'),
        `u UU N... 100644 100644 100644 100644 ${sha} ${sha} ${sha} both.ts`,
        '? new.txt',
        '',
      ].join('\0'),
    );
    const { head, working } = parseStatusWorking(output);

    // A change staged alone is no working tree change; the index's own stamp covers it.
    expect(head).toBe(sha);
    expect(Object.fromEntries(working)).toEqual({ 'gone.txt': 'deleted', 'with space.ts': 'modified', 'intent.ts': 'added', 'both.ts': 'modified', 'new.txt': 'untracked' });
    expect(parseStatusWorking(Buffer.from('# branch.oid (initial)\0')).head).toBeNull();
  });

  it('reads renames, copies and plain changes from name-status', () => {
    expect(parseNameStatus(Buffer.from('M\0a.ts\0R090\0old.ts\0new.ts\0C100\0src.ts\0copy.ts\0D\0gone.ts\0A\0new file.ts\0'))).toEqual([
      { path: 'a.ts', kind: 'modified' },
      { path: 'new.ts', kind: 'modified', from: 'old.ts' },
      { path: 'copy.ts', kind: 'added' },
      { path: 'gone.ts', kind: 'deleted' },
      { path: 'new file.ts', kind: 'added' },
    ]);
  });

  it('reads a rename and a binary file from numstat by the path now', () => {
    const counts = parseNumstat(Buffer.from('3\t1\ta.ts\0-\t-\tlogo.png\0' + '2\t0\t\0old.ts\0new.ts\0'));

    expect(Object.fromEntries(counts)).toEqual({ 'a.ts': { additions: 3, deletions: 1 }, 'logo.png': { additions: null, deletions: null }, 'new.ts': { additions: 2, deletions: 0 } });
  });
});

describe('paths the page names', () => {
  it('takes only plain relative paths with forward slashes', () => {
    for (const ok of ['a.ts', 'src/a b.ts', 'src/.hidden/x', 'weird:name.ts']) {
      expect(relativePath(ok)).toBe(true);
    }

    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', './a', 'a\\b', 'C:/Windows/win.ini', 'c:x', 'a\0b', 42, null, 'x'.repeat(4097)]) {
      expect(relativePath(bad)).toBe(false);
    }
  });

  it('resolves a file inside the worktree and refuses one a link or junction leads out of', async () => {
    const repo = makeRepo({ 'in.txt': 'in\n' });
    const outside = mkdtempSync(join(tmpdir(), 'sb-outside-'));

    expect(await fileInside(repo.root, 'in.txt')).not.toBeNull();
    expect(await fileInside(repo.root, 'missing.txt')).toBeNull();
    expect(await fileInside(repo.root, '../in.txt')).toBeNull();
    symlinkSync(outside, join(repo.root, 'out'), 'junction');
    repo.write('../' + outside.split(/[\\/]/).pop() + '/secret.txt', 'secret\n');
    expect(await fileInside(repo.root, 'out/secret.txt')).toBeNull();
  });

  it('refuses a link or junction that stays inside the worktree too, as to git\'s own files or an ignored folder', async () => {
    const repo = makeRepo({ 'in.txt': 'in\n' });

    symlinkSync(join(repo.root, '.git'), join(repo.root, 'gitdir'), 'junction');
    expect(await fileInside(repo.root, 'gitdir/config')).toBeNull();
    expect(await fileInside(repo.root, 'in.txt')).not.toBeNull();
  });
});
