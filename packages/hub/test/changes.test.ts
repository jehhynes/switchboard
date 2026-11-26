import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { COMMIT_GONE, DIFF_MAX_BYTES, fileInside, MAX_COMMITS, nodeGit, PageChanges, parseNameStatus, parseNumstat, parseRange, parseStatusWorking, readCapped, readChanges, readDiff, readFileView, relativePath, SIDE_MAX_BYTES } from '../src/changes.js';
import type { ChangesView, Git, WorktreeChanges } from '../src/changes.js';
import type { WindowScope } from '../src/windows.js';
import { isolateGit, makeRepo } from './gitFixture.js';

beforeAll(() => isolateGit());

// Git-backed suites create commits and run several reads; Windows process startup can exceed Vitest's five-second default.
const gitTimeout = { timeout: process.platform === 'win32' ? 15_000 : 5_000 };

const lines = (count: number, word = 'line'): string => Array.from({ length: count }, (_, index) => `${word} ${index + 1}\n`).join('');

/** A worktree with a commit after the base, a staged rename, an unstaged edit and deletion, an untracked text and binary file. */
function busyRepo() {
  const repo = makeRepo({ 'src/kept.ts': lines(5), 'src/old-name.ts': lines(8), 'gone.txt': 'bye\n', 'edited.md': lines(3), 'committed.ts': lines(2) });

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
}

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

describe('PageChanges', gitTimeout, () => {
  const scope = (cwd: string | null, scopeGen = 1): WindowScope => ({ kind: 'page', key: 'p1', folder: cwd, title: 'T', scopeGen, conversations: [], workItemId: 7, cwd, sessionId: 's1' });

  it("answers the page's selected conversation's changes with the scope generation it read them for", async () => {
    const repo = busyRepo();
    const reply = await new PageChanges({ isPage: (key) => key === 'p1', scope: () => scope(repo.root) }).changes('p1');

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ scopeGen: 1, shown: 8 });

    // The same changes answer the same ETag, which a change on disk replaces.
    const again = await new PageChanges({ isPage: () => true, scope: () => scope(repo.root) }).changes('p1');

    expect(reply.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(again.etag).toBe(reply.etag);
    repo.write('edited.md', 'other\n');
    expect((await new PageChanges({ isPage: () => true, scope: () => scope(repo.root) }).changes('p1')).etag).not.toBe(reply.etag);
  });

  it('refuses a key that is not a page, a page with no selection, and one with no folder', async () => {
    const changes = (isPage: boolean, shown: WindowScope | null) => new PageChanges({ isPage: () => isPage, scope: () => shown }).changes('p1');

    expect(await changes(false, scope('x'))).toEqual({ status: 403, body: { error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." } });
    expect(await changes(true, null)).toEqual({ status: 403, body: { error: 'This page has no work item open, so that was not done. Open one and try again.' } });
    expect((await changes(true, scope(null))).status).toBe(409);
  });

  it('refuses the answer when the page moved to another conversation while git read', async () => {
    const repo = busyRepo();
    let gen = 1;
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root, gen++) });

    expect(await changes.changes('p1')).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
  });
});

describe('readDiff', gitTimeout, () => {
  const read = async (root: string) => (await readChanges(root)) as WorktreeChanges;

  it("answers git's patch and both whole sides for an edit, a rename, a deletion and an untracked file", async () => {
    const repo = busyRepo();
    const changes = await read(repo.root);
    const edited = await readDiff(changes, 'edited.md');

    expect(edited).toMatchObject({ path: 'edited.md', status: 'M', old: 'line 1\nline 2\nline 3\n', new: 'line 1\nchanged\nline 3\n', binary: false, tooLarge: null });
    expect(edited!.patch).toContain('--- a/edited.md\n+++ b/edited.md');
    expect(edited!.patch).toContain('-line 2\n+changed');

    const renamed = await readDiff(changes, 'src/new-name.ts');

    expect(renamed).toMatchObject({ from: 'src/old-name.ts', status: 'R', old: lines(8), new: lines(8) });
    expect(renamed!.patch).toContain('rename from src/old-name.ts\nrename to src/new-name.ts');

    expect(await readDiff(changes, 'gone.txt')).toMatchObject({ status: 'D', old: 'bye\n', new: null, patch: expect.stringContaining('deleted file mode') });
    expect(await readDiff(changes, 'notes/new.txt')).toMatchObject({ status: 'U', old: null, new: 'one\ntwo\nthree', patch: expect.stringContaining('+++ b/notes/new.txt') });
  });

  it('answers a binary file without its bytes, and null for a path that is no change row', async () => {
    const changes = await read(busyRepo().root);

    expect(await readDiff(changes, 'image.bin')).toMatchObject({ binary: true, patch: null, old: null, new: null });
    expect(await readDiff(changes, 'src/kept.ts')).toBeNull();
    expect(await readDiff(changes, '.git/config')).toBeNull();
  });

  it('sends the patch alone for a file whose side passes the cap', async () => {
    const big = lines(Math.ceil(SIDE_MAX_BYTES / 10));
    const repo = makeRepo({ 'big.txt': big });

    expect(big.length).toBeGreaterThan(SIDE_MAX_BYTES);
    repo.write('big.txt', big.replace('line 5\n', 'changed\n'));

    const diff = await readDiff(await read(repo.root), 'big.txt');

    expect(diff).toMatchObject({ tooLarge: 'sides', old: null, new: null });
    expect(diff!.patch).toContain('-line 5\n+changed');
  });

  it('leaves the sides out when the patch and both sides together pass the total cap', async () => {
    // Each side just under its own cap, and every hundredth line changed, so the patch is under its cap too.
    const side = Array.from({ length: Math.floor((SIDE_MAX_BYTES - 1000) / 12) }, (_, index) => `row ${String(index).padStart(7, '0')}\n`).join('');
    const repo = makeRepo({ 'big.txt': side });

    repo.write('big.txt', side.replace(/row (\d{5}00)\n/g, 'new $1\n'));
    expect(await readDiff(await read(repo.root), 'big.txt')).toMatchObject({ tooLarge: 'sides', old: null, new: null });
  });

  it('reads a file no further than its cap, however large it is when read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-capped-'));

    writeFileSync(join(dir, 'a'), 'x'.repeat(100));
    expect(await readCapped(join(dir, 'a'), 100)).toEqual(Buffer.from('x'.repeat(100)));
    expect(await readCapped(join(dir, 'a'), 99)).toBe('large');
    expect(await readCapped(join(dir, 'missing'), 99)).toBeNull();
  });

  it('sends nothing for a patch past its cap', async () => {
    const repo = makeRepo({ 'big.txt': 'a\n' });

    repo.write('big.txt', 'x'.repeat(SIDE_MAX_BYTES + 10) + '\n');
    expect(await readDiff(await read(repo.root), 'big.txt')).toMatchObject({ tooLarge: 'patch', patch: null, old: null, new: null });
  });
});

describe('readDiff without sides', gitTimeout, () => {
  const read = async (root: string) => (await readChanges(root, nodeGit, false)) as WorktreeChanges;
  /** nodeGit, recording each git command's arguments. */
  const recording = () => {
    const calls: string[][] = [];

    return { calls, git: ((args, cwd, options) => (calls.push(args), nodeGit(args, cwd, options))) as typeof nodeGit };
  };

  it('ReadDiff_WithoutSides_RunsOnlyGitDiffAndSendsThePatch', async () => {
    const changes = await read(busyRepo().root);
    const { calls, git } = recording();
    const edited = await readDiff(changes, 'edited.md', git, false);

    expect(edited).toEqual({ path: 'edited.md', status: 'M', patch: expect.stringContaining('-line 2\n+changed'), old: null, new: null, binary: false, tooLarge: null, partial: true });
    expect(calls.map((args) => args[0])).toEqual(['diff']);
  });

  it('ReadDiff_WithoutSides_KeepsRenameDeletionAndUntrackedPatches', async () => {
    const changes = await read(busyRepo().root);

    expect(await readDiff(changes, 'src/new-name.ts', nodeGit, false)).toMatchObject({ from: 'src/old-name.ts', status: 'R', old: null, new: null, partial: true, patch: expect.stringContaining('rename from src/old-name.ts\nrename to src/new-name.ts') });
    expect(await readDiff(changes, 'gone.txt', nodeGit, false)).toMatchObject({ status: 'D', old: null, new: null, patch: expect.stringContaining('deleted file mode') });
    expect(await readDiff(changes, 'notes/new.txt', nodeGit, false)).toMatchObject({ status: 'U', old: null, new: null, patch: expect.stringContaining('+++ b/notes/new.txt') });
  });

  it('ReadDiff_WithoutSidesForBinaryFiles_SendsBinaryWithoutBytes', async () => {
    const repo = busyRepo();

    repo.write('tracked.bin', Buffer.from([0, 1, 2]));
    repo.git('add', 'tracked.bin');
    repo.git('commit', '-qm', 'bin');
    repo.write('tracked.bin', Buffer.from([0, 9, 9, 9]));

    const changes = await read(repo.root);

    // An untracked file has no numstat count, so its patch's binary line tells.
    expect(await readDiff(changes, 'image.bin', nodeGit, false)).toEqual({ path: 'image.bin', status: 'U', patch: null, old: null, new: null, binary: true, tooLarge: null, partial: true });
    expect(await readDiff(changes, 'tracked.bin', nodeGit, false)).toMatchObject({ binary: true, patch: null });
  });

  it('ReadDiff_WithoutSidesForASideOverItsCap_SendsThePatchUnmarked', async () => {
    const big = lines(Math.ceil(SIDE_MAX_BYTES / 10));
    const repo = makeRepo({ 'big.txt': big });

    repo.write('big.txt', big.replace('line 5\n', 'changed\n'));

    const changes = await read(repo.root);

    // With the sides it would say they were left out; without them no side is read, so nothing is too large.
    expect(await readDiff(changes, 'big.txt')).toMatchObject({ tooLarge: 'sides' });
    expect(await readDiff(changes, 'big.txt', nodeGit, false)).toMatchObject({ tooLarge: null, partial: true, patch: expect.stringContaining('-line 5\n+changed') });
  });

  it('ReadDiff_WithoutSidesForAPatchOverItsCap_SendsNothing', async () => {
    const repo = makeRepo({ 'big.txt': 'a\n' });

    repo.write('big.txt', 'x'.repeat(SIDE_MAX_BYTES + 10) + '\n');
    expect(await readDiff(await read(repo.root), 'big.txt', nodeGit, false)).toMatchObject({ tooLarge: 'patch', patch: null, partial: true });
  });
});

describe('PageChanges.diff', gitTimeout, () => {
  const scope = (cwd: string): WindowScope => ({ kind: 'page', key: 'p1', folder: cwd, title: 'T', scopeGen: 1, conversations: [], workItemId: 7, cwd, sessionId: 's1' });

  it('answers a change row with an ETag, and refuses a path that is not plain or not a change', async () => {
    const repo = busyRepo();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });
    const reply = await changes.diff('p1', 'edited.md');

    expect(reply).toMatchObject({ status: 200, body: { path: 'edited.md' }, etag: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect((await changes.diff('p1', '../outside.txt')).status).toBe(400);
    expect((await changes.diff('p1', 'C:/Windows/win.ini')).status).toBe(400);
    expect((await changes.diff('p1', null)).status).toBe(400);
    expect(await changes.diff('p1', 'src/kept.ts')).toEqual({ status: 404, body: { error: 'src/kept.ts is not one of the changes now.' } });
    expect((await new PageChanges({ isPage: () => false, scope: () => scope(repo.root) }).diff('p1', 'edited.md')).status).toBe(403);
  });

  it('ignores whitespace when asked, answering same for a file that differs only in whitespace', async () => {
    const repo = busyRepo();

    repo.write('src/kept.ts', lines(5).replace('line 2', 'line   2'));
    repo.write('edited.md', 'line 1\nchanged  \nline 3\n');

    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });

    for (const sides of [null, '0']) {
      expect(await changes.diff('p1', 'src/kept.ts', sides, null, null, 'ignore')).toMatchObject({ status: 200, body: { patch: '', same: true } });
      expect((await changes.diff('p1', 'src/kept.ts', sides)).body).toMatchObject({ patch: expect.stringContaining('line   2') });
      expect((await changes.diff('p1', 'src/kept.ts', sides)).body).not.toHaveProperty('same');
    }

    const real = await changes.diff('p1', 'edited.md', null, null, null, 'ignore');

    expect(real.body).toMatchObject({ patch: expect.stringContaining('+changed') });
    expect(real.body).not.toHaveProperty('same');
    expect((await changes.diff('p1', 'edited.md', null, null, null, 'all')).status).toBe(400);
  });

  it('Diff_WithSidesZero_AnswersThePatchAloneWithItsOwnETag', async () => {
    const repo = busyRepo();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });
    const full = await changes.diff('p1', 'edited.md');
    const alone = await changes.diff('p1', 'edited.md', '0');

    expect(alone).toMatchObject({ status: 200, body: { path: 'edited.md', old: null, new: null, partial: true }, etag: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(alone.etag).not.toBe(full.etag);
    expect(full.body).not.toHaveProperty('partial');
    expect(await changes.diff('p1', 'edited.md', '1')).toEqual(full);
    expect((await changes.diff('p1', 'edited.md', 'no')).status).toBe(400);
  });
});

describe('PageChanges reuses the list read', gitTimeout, () => {
  const scope = (cwd: string, scopeGen = 1): WindowScope => ({ kind: 'page', key: 'p1', folder: cwd, title: 'T', scopeGen, conversations: [], workItemId: 7, cwd, sessionId: 's1' });
  /** nodeGit, recording each invocation's arguments. */
  const recording = () => {
    const calls: string[][] = [];
    const git: Git = (args, cwd, options) => (calls.push(args), nodeGit(args, cwd, options));

    return { git, calls, reads: () => calls.filter((args) => args[0] === 'rev-parse' && args[1] === '--show-toplevel').length };
  };

  it('PageChangesDiff_AfterTheList_ChecksTheRefsAndThePathsAndReadsOnlyThePatch', { timeout: 60_000 }, async () => {
    const repo = busyRepo();
    const { git, calls, reads } = recording();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root), git });

    expect((await changes.changes('p1')).status).toBe(200);
    calls.length = 0;
    repo.write('edited.md', 'line 1\nedited after the list\nline 3\n');

    const reply = await changes.diff('p1', 'edited.md', '0');

    // The patch is read now, so it has what is on disk now; the list's read is checked for the refs and this path's stages alone.
    expect((reply.body as { patch: string }).patch).toContain('+edited after the list');
    expect(reads()).toBe(0);
    expect(calls.map((args) => args.slice(0, 2).join(' ')).sort()).toEqual(['diff --no-ext-diff', 'for-each-ref --format=%(refname) %(objectname)', 'status --porcelain=v2']);
    expect(calls.find((args) => args[0] === 'status')!.slice(-2)).toEqual(['--', 'edited.md']);

    // A rename is checked at both its paths; an untracked file, a side and a deleted file reuse the read too, and so does the file route.
    calls.length = 0;
    expect((await changes.diff('p1', 'src/new-name.ts', '0')).status).toBe(200);
    expect(calls.find((args) => args[0] === 'status')!.slice(-3)).toEqual(['--', 'src/old-name.ts', 'src/new-name.ts']);
    expect((await changes.diff('p1', 'notes/new.txt', '0')).status).toBe(200);
    expect((await changes.diff('p1', 'edited.md', '1')).status).toBe(200);
    expect((await changes.diff('p1', 'gone.txt', '1')).status).toBe(200);
    expect(await changes.file('p1', 'committed.ts', 'base')).toMatchObject({ status: 200, body: { contents: lines(2) } });
    expect(reads()).toBe(0);
  });

  it('PageChangesDiff_ThreeAtOnceWithNoList_ReadTheChangesOnceWithoutHashes', { timeout: 60_000 }, async () => {
    const repo = busyRepo();
    const { git, calls, reads } = recording();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root), git });
    const replies = await Promise.all(['edited.md', 'committed.ts', 'notes/new.txt'].map((path) => changes.diff('p1', path, '0')));

    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200]);
    expect(reads()).toBe(1);
    expect(calls.some((args) => args[0] === 'hash-object')).toBe(false);
  });

  it('PageChangesDiff_ChangesSinceTheList_AnswersAsAFreshReadWould', { timeout: 120_000 }, async () => {
    const repo = busyRepo();
    const { git, reads } = recording();
    let gen = 1;
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root, gen), git });
    const listed = async () => expect((await changes.changes('p1')).status).toBe(200);

    // An untracked file ignored since: no row any more, and its contents are never sent.
    await listed();
    repo.write('.gitignore', 'ignored.log\nnotes/\n');
    expect(await changes.diff('p1', 'notes/new.txt', '0')).toEqual({ status: 404, body: { error: 'notes/new.txt is not one of the changes now.' } });
    expect(reads()).toBe(2);

    // An untracked file staged since: its row is now an added file.
    repo.write('.gitignore', 'ignored.log\n');
    await listed();
    repo.git('add', 'notes/new.txt');
    expect(await changes.diff('p1', 'notes/new.txt', '0')).toMatchObject({ status: 200, body: { status: 'A', patch: expect.stringContaining('new file mode') } });

    // A deleted file made again as it was, and a binary file gone: no change any more.
    await listed();
    repo.write('gone.txt', 'bye\n');
    expect((await changes.diff('p1', 'gone.txt', '0')).status).toBe(404);
    await listed();
    rmSync(join(repo.root, 'image.bin'));
    expect((await changes.diff('p1', 'image.bin', '0')).status).toBe(404);

    // An edited file deleted since, and a deleted file edited back: the row's kind changed.
    await listed();
    rmSync(join(repo.root, 'edited.md'));
    expect(await changes.diff('p1', 'edited.md', '0')).toMatchObject({ status: 200, body: { status: 'D' } });
    await listed();
    repo.write('edited.md', 'back again\n');
    expect(await changes.diff('p1', 'edited.md', '0')).toMatchObject({ status: 200, body: { status: 'M' } });

    // A staged rename whose new file changes past the rename's likeness: the index changed, so its two paths are rows of their own.
    await listed();
    repo.write('src/new-name.ts', 'nothing like it\n');
    repo.git('add', 'src/new-name.ts');
    expect(await changes.diff('p1', 'src/new-name.ts', '0')).toMatchObject({ status: 200, body: { status: 'A' } });
    expect(await changes.file('p1', 'src/old-name.ts', 'base')).toMatchObject({ status: 200, body: { contents: lines(8) } });

    // A file put back as it was since: no row, through the file route too.
    await listed();
    repo.git('checkout', '--', 'edited.md');
    expect((await changes.file('p1', 'edited.md', 'base')).status).toBe(404);
    repo.write('edited.md', 'changed once more\n');
    await listed();
    repo.write('edited.md', lines(3));
    expect((await changes.diff('p1', 'edited.md', '0')).status).toBe(404);

    // A file changed since the list, which the list does not have.
    await listed();
    repo.write('src/kept.ts', 'changed\n');
    expect(await changes.diff('p1', 'src/kept.ts', '0')).toMatchObject({ status: 200, body: { path: 'src/kept.ts', patch: expect.stringContaining('+changed') } });

    // A commit since the list moves HEAD: the uncommitted changes are read again from the new HEAD.
    repo.write('committed.ts', lines(7));
    expect((await changes.changes('p1', 'HEAD', 'worktree')).status).toBe(200);
    repo.git('commit', '-qm', 'more', '--', 'committed.ts');
    expect((await changes.diff('p1', 'committed.ts', '0', 'HEAD')).status).toBe(404);

    // Another conversation, or another scope generation, reads again.
    await listed();
    const before = reads();

    gen = 2;
    expect((await changes.diff('p1', 'committed.ts', '0')).status).toBe(200);
    expect(reads()).toBe(before + 1);
  });

  it('PageChangesDiff_AListAtItsRowLimit_ReadsAgain', { timeout: 120_000 }, async () => {
    const repo = busyRepo();

    // As many rows as a list shows, so a file added before the last one would push it out.
    for (let index = 0; index < 392; index++) {
      repo.write(`many/f${String(index).padStart(3, '0')}.txt`, 'x\n');
    }

    const { git, reads } = recording();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root), git });

    expect((await changes.changes('p1')).body).toMatchObject({ shown: 400, total: 400 });
    expect((await changes.diff('p1', 'many/f001.txt', '0')).status).toBe(200);
    expect(reads()).toBe(2);
  });

  it('PageChangesDiff_ACommitRewrittenSinceTheList_AnswersStaleAndNeverReadsAtIt', { timeout: 60_000 }, async () => {
    const { repo, first, second } = twoCommits();
    const { git, calls } = recording();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root), git });

    expect((await changes.changes('p1', first, second)).status).toBe(200);
    repo.git('commit', '-q', '--amend', '-m', 'second, reworded');
    calls.length = 0;
    expect(await changes.diff('p1', 'committed.ts', '0', first, second)).toEqual({ status: 409, body: { error: COMMIT_GONE, stale: true } });
    expect(await changes.file('p1', 'committed.ts', 'disk', first, second)).toEqual({ status: 409, body: { error: COMMIT_GONE, stale: true } });
    // The commit no longer on the branch reaches no git diff, cat-file or ls-tree.
    expect(calls.filter((args) => args.some((arg) => arg.includes(second))).map((args) => args[0])).toEqual([]);
  });
});

/** busyRepo with a second commit after the first, which edits committed.ts again and deletes src/kept.ts: `first` and `second`, and the base. */
function twoCommits() {
  const repo = busyRepo();

  // Only these two files, so the staged rename and the rest of the work stay uncommitted.
  repo.write('committed.ts', lines(6));
  repo.git('rm', '-q', 'src/kept.ts');
  repo.git('commit', '-qm', 'second: more lines', '--', 'committed.ts', 'src/kept.ts');

  return { repo, base: repo.git('rev-parse', 'origin/main').trim(), first: repo.git('rev-parse', 'HEAD~1').trim(), second: repo.git('rev-parse', 'HEAD').trim() };
}

describe('readChanges with a range', gitTimeout, () => {
  it('ReadChanges_CommitsSinceTheBase_ListsThemNewestFirstWithParentSubjectAndTime', async () => {
    const { repo, base, first, second } = twoCommits();
    const view = ((await readChanges(repo.root)) as WorktreeChanges).view;

    expect(view.commits).toEqual([
      { sha: second, parent: first, subject: 'second: more lines', time: Number(repo.git('log', '-1', '--format=%ct', second).trim()) },
      { sha: first, parent: base, subject: 'work', time: Number(repo.git('log', '-1', '--format=%ct', first).trim()) },
    ]);
    expect(view.commitsMore).toBe(false);
  });

  it('ReadChanges_OneCommit_ListsOnlyItsFilesHashedInTheCommitAndReadsItsSides', async () => {
    const { repo, first, second } = twoCommits();
    const read = (await readChanges(repo.root, nodeGit, true, { from: first, to: second })) as WorktreeChanges;

    expect(read.view).toMatchObject({ from: first, to: second, stages: { committed: 2, staged: 0, working: 0, untracked: 0 }, total: 2 });
    expect(read.view.rows.map(({ path, status, stages, additions, deletions, hash }) => [path, status, stages.join(), additions, deletions, hash])).toEqual([
      ['committed.ts', 'M', 'committed', 2, 0, repo.git('rev-parse', `${second}:committed.ts`).trim()],
      ['src/kept.ts', 'D', 'committed', 0, 5, 'deleted'],
    ]);
    expect(read.ref).toBe(first);
    expect(read.to).toBe(second);
    expect(read.tickScope).toBe(`${first}..${second}`);

    // The diff is the commit's own, its new side the file in the commit, not on disk.
    repo.write('committed.ts', 'on disk\n');

    const diff = (await readDiff(read, 'committed.ts'))!;

    expect(diff.patch!.match(/^\+line \d+$/gm)).toEqual(['+line 5', '+line 6']);
    expect([diff.old, diff.new]).toEqual([lines(4), lines(6)]);
    expect(await readFileView(read, 'committed.ts', 'disk')).toMatchObject({ contents: lines(6) });
    expect(await readFileView(read, 'committed.ts', 'base')).toMatchObject({ contents: lines(4) });
    expect(await readFileView(read, 'src/kept.ts', 'base')).toMatchObject({ contents: lines(5) });
    // Only a row's own file: no file outside the commit, on disk or in it.
    expect(await readFileView(read, 'edited.md', 'disk')).toBeNull();
    expect(await readFileView(read, 'src/kept.ts', 'disk')).toBeNull();
  });

  it('ReadChanges_TwoPoints_ComparesThemAndACommitToDiskAddsTheUncommittedWork', async () => {
    const { repo, base, first, second } = twoCommits();
    const both = (await readChanges(repo.root, nodeGit, true, { from: 'base', to: second })) as WorktreeChanges;

    expect(both.ref).toBe(base);
    expect(both.tickScope).toBe(`${base}..${second}`);
    expect(both.view.rows.map((row) => [row.path, row.status, row.additions])).toEqual([
      ['added-in-commit.ts', 'A', 1],
      ['committed.ts', 'M', 4],
      ['src/kept.ts', 'D', 0],
    ]);

    // To HEAD reads HEAD's commit now, and keeps its ticks under that commit.
    const toHead = (await readChanges(repo.root, nodeGit, true, { from: 'base', to: 'HEAD' })) as WorktreeChanges;

    expect(toHead.to).toBe(second);
    expect(toHead.tickScope).toBe(`${base}..${second}`);
    expect(toHead.view.rows).toEqual(both.view.rows);

    const toDisk = (await readChanges(repo.root, nodeGit, true, { from: second, to: 'worktree' })) as WorktreeChanges;

    // From HEAD's own commit to disk: the uncommitted work alone, its ticks shared with every list to disk.
    expect(toDisk.view.rows.map((row) => row.path)).toEqual(['.gitignore', 'edited.md', 'gone.txt', 'image.bin', 'notes/new.txt', 'src/new-name.ts']);
    expect(toDisk.tickScope).toBe('');

    const fromFirst = (await readChanges(repo.root, nodeGit, true, { from: first, to: 'worktree' })) as WorktreeChanges;

    expect(fromFirst.view.rows.find((row) => row.path === 'committed.ts')).toMatchObject({ status: 'M', stages: ['committed'], additions: 2 });
    expect(fromFirst.view.rows.find((row) => row.path === 'src/kept.ts')).toMatchObject({ status: 'D' });
  });

  it('ReadChanges_ACommitNotSinceTheBase_IsRefusedAsStale', async () => {
    const { repo, base, first, second } = twoCommits();
    const before = repo.git('rev-parse', 'HEAD~2').trim();

    // The base itself and a commit before it, an unknown ID, and a range to the base.
    expect(before).toBe(base);
    for (const range of [{ from: base, to: base.replace(/^./, base[0] === 'a' ? 'b' : 'a') }, { from: 'f'.repeat(40), to: second }, { from: 'base', to: base }]) {
      expect(await readChanges(repo.root, nodeGit, false, range)).toEqual({ error: COMMIT_GONE, stale: true });
    }

    // After a rebase onto a new base, the first commit is no longer one since the base.
    repo.git('reset', '-q', '--hard', first);
    repo.git('commit', '-q', '--allow-empty', '-m', 'rewritten');
    expect(await readChanges(repo.root, nodeGit, false, { from: base, to: second })).toEqual({ error: COMMIT_GONE, stale: true });
  });

  it('ParseRange_EachValue_TakesTheBaseHeadOrACommitAndRefusesTheRest', () => {
    const sha = 'a'.repeat(40);

    expect(parseRange(null, null)).toEqual({ from: 'base', to: 'worktree' });
    expect(parseRange('HEAD', 'worktree')).toEqual({ from: 'HEAD', to: 'worktree' });
    expect(parseRange(sha, 'b'.repeat(64))).toEqual({ from: sha, to: 'b'.repeat(64) });
    expect(parseRange('base', sha)).toEqual({ from: 'base', to: sha });
    expect(parseRange(sha, 'HEAD')).toEqual({ from: sha, to: 'HEAD' });

    for (const [from, to] of [['HEAD', sha], [sha, sha], ['main', null], ['HEAD~1', null], ['HEAD', 'HEAD'], [sha.slice(0, 7), null], [`${sha}:x`, null], [1, null], [null, 'base']]) {
      expect(parseRange(from, to)).toBeNull();
    }
  });

  it('ReadChanges_MoreCommitsThanItLists_SaysSo', { timeout: 60_000 }, async () => {
    const repo = makeRepo({ 'a.txt': '0\n' });

    // The commits in one fast-import, each on the last.
    const stream = Array.from({ length: MAX_COMMITS + 1 }, (_, index) => `commit refs/heads/work\ncommitter T <t@example.com> ${1_700_000_000 + index} +0000\ndata ${`c${index + 1}`.length}\nc${index + 1}\n${index === 0 ? 'from refs/heads/work^0\n' : ''}\n`).join('');

    execFileSync('git', ['fast-import', '--quiet'], { cwd: repo.root, input: stream });
    repo.git('reset', '-q', '--hard');

    const view = ((await readChanges(repo.root, nodeGit, false)) as WorktreeChanges).view;

    expect(view.commits).toHaveLength(MAX_COMMITS);
    expect(view.commits[0]!.subject).toBe(`c${MAX_COMMITS + 1}`);
    expect(view.commitsMore).toBe(true);

    // A commit past the listed ones can still be read, as one chosen before more were made.
    const oldest = repo.git('rev-parse', `HEAD~${MAX_COMMITS}`).trim();

    expect(view.commits.some((commit) => commit.sha === oldest)).toBe(false);
    expect(await readChanges(repo.root, nodeGit, false, { from: 'base', to: oldest })).toMatchObject({ to: oldest });
  });
});

describe('PageChanges with a range', gitTimeout, () => {
  const scope = (cwd: string): WindowScope => ({ kind: 'page', key: 'p1', folder: cwd, title: 'T', scopeGen: 1, conversations: [], workItemId: 7, cwd, sessionId: 's1' });

  it('PageChanges_Uncommitted_AnswersTheListDiffsAndFilesAgainstHead', { timeout: 30_000 }, async () => {
    const repo = busyRepo();

    repo.write('committed.ts', lines(5));

    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });
    const all = await changes.changes('p1');
    const only = await changes.changes('p1', 'HEAD', 'worktree');

    expect(only).toMatchObject({ status: 200, body: { scopeGen: 1, from: 'HEAD', to: 'worktree', shown: 7 } });
    expect(all).toMatchObject({ status: 200, body: { from: 'base', to: 'worktree', shown: 8 } });
    expect(only.etag).not.toBe(all.etag);
    expect(await changes.changes('p1', 'base', 'worktree')).toEqual(all);

    // The patch from HEAD has the one line added since the commit; from the base it has every line the work added.
    const patch = (reply: { body: unknown }) => (reply.body as { patch: string }).patch;
    const fromHead = patch(await changes.diff('p1', 'committed.ts', '0', 'HEAD'));
    const fromBase = patch(await changes.diff('p1', 'committed.ts', '0'));

    expect(fromHead.match(/^\+line \d+$/gm)).toEqual(['+line 5']);
    expect(fromBase.match(/^\+line \d+$/gm)).toEqual(['+line 3', '+line 4', '+line 5']);
    expect(await changes.diff('p1', 'added-in-commit.ts', '0', 'HEAD')).toEqual({ status: 404, body: { error: 'added-in-commit.ts is not one of the changes now.' } });
    expect((await changes.diff('p1', 'added-in-commit.ts', '0')).status).toBe(200);

    // The base side is the file at HEAD.
    expect(await changes.file('p1', 'committed.ts', 'base', 'HEAD')).toMatchObject({ status: 200, body: { contents: lines(4) } });
    expect(await changes.file('p1', 'committed.ts', 'base')).toMatchObject({ status: 200, body: { contents: lines(2) } });

    for (const reply of [await changes.changes('p1', 'main'), await changes.diff('p1', 'edited.md', '0', 'HEAD', 'HEAD'), await changes.file('p1', 'edited.md', 'disk', 'HEAD~1')]) {
      expect(reply).toEqual({ status: 400, body: { error: 'Expected from base, HEAD or a commit, and to worktree or a commit.' } });
    }
  });

  it('PageChanges_CommitRange_AnswersItAndAStaleCommitWithStale', async () => {
    const { repo, first, second } = twoCommits();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });

    expect(await changes.changes('p1', first, second)).toMatchObject({ status: 200, body: { from: first, to: second, total: 2 } });
    expect(await changes.diff('p1', 'committed.ts', '0', first, second)).toMatchObject({ status: 200, body: { path: 'committed.ts', partial: true } });
    expect(await changes.file('p1', 'committed.ts', 'disk', first, second)).toMatchObject({ status: 200, body: { contents: lines(6) } });

    for (const reply of [await changes.changes('p1', 'base', 'e'.repeat(40)), await changes.diff('p1', 'committed.ts', '0', 'e'.repeat(40), second), await changes.file('p1', 'committed.ts', 'disk', 'base', 'e'.repeat(40))]) {
      expect(reply).toEqual({ status: 409, body: { error: COMMIT_GONE, stale: true } });
    }
  });

  it('ViewedCommand_ByRange_KeepsACommitsTicksApartFromTheChangesToDisk', async () => {
    const { repo, first, second } = twoCommits();
    const ticks = new Map<string, string>();
    const told: unknown[] = [];
    const changes = new PageChanges({
      isPage: () => true,
      scope: () => scope(repo.root),
      viewed: { list: (_id, at) => new Map([...ticks].filter(([key]) => key.startsWith(`${at} `)).map(([key, hash]) => [key.slice(at.length + 1), hash])), set: (_id, at, path, hash) => (hash === null ? ticks.delete(`${at} ${path}`) : ticks.set(`${at} ${path}`, hash)) },
      viewedChanged: (_id, _from, payload) => told.push(payload),
    });
    const row = async (from?: string, to?: string) => ((await changes.changes('p1', from, to)).body as ChangesView).rows.find((one) => one.path === 'committed.ts')!;
    const inCommit = await row(first, second);
    const tick = (opId: string, extra: Record<string, unknown>) => changes.viewedCommand({ window: 'p1', scopeGen: 1, opId, path: 'committed.ts', hash: inCommit.hash, viewed: true, ...extra });

    expect((await tick('a', { from: 'main' })).status).toBe(400);
    expect(await tick('b', { from: first, to: second })).toEqual({ status: 200, body: { path: 'committed.ts', hash: inCommit.hash, viewed: true } });
    expect(told).toEqual([{ path: 'committed.ts', hash: inCommit.hash, viewed: true, scope: `${first}..${second}` }]);
    expect((await row(first, second)).viewed).toBe(true);
    // The same file's tick in the commit is not one in the changes to disk, nor in another range to a commit.
    expect((await row()).viewed).toBe(false);
    expect((await row('base', second)).viewed).toBe(false);
    // The commit's content is the one in the commit, so a later change on disk keeps its tick.
    repo.write('committed.ts', 'on disk\n');
    expect((await row(first, second)).viewed).toBe(true);
  });
});

describe('the file view', gitTimeout, () => {
  const scope = (cwd: string): WindowScope => ({ kind: 'page', key: 'p1', folder: cwd, title: 'T', scopeGen: 1, conversations: [], workItemId: 7, cwd, sessionId: 's1' });

  it("reads a file git tracks or would track on disk, and a change row's file at the base, and nothing else", async () => {
    const repo = busyRepo();
    const changes = (await readChanges(repo.root)) as WorktreeChanges;

    expect(await readFileView(changes, 'src/kept.ts', 'disk')).toEqual({ path: 'src/kept.ts', side: 'disk', contents: lines(5), binary: false, tooLarge: false, bytes: lines(5).length, media: null, digest: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(await readFileView(changes, 'notes/new.txt', 'disk')).toMatchObject({ contents: 'one\ntwo\nthree' });
    expect(await readFileView(changes, 'image.bin', 'disk')).toMatchObject({ contents: null, binary: true });
    expect(await readFileView(changes, 'src/old-name.ts', 'base')).toMatchObject({ side: 'base', contents: lines(8) });
    expect(await readFileView(changes, 'gone.txt', 'base')).toMatchObject({ contents: 'bye\n' });

    // An ignored file, git's own files, a base file that is no change row, and a file that is not there.
    for (const [path, side] of [['ignored.log', 'disk'], ['.git/config', 'disk'], ['src/kept.ts', 'base'], ['gone.txt', 'disk']] as const) {
      expect(await readFileView(changes, path, side)).toBeNull();
    }
  });

  it("answers the route with an ETag and refuses another side, a path that is not plain, and one it does not answer", async () => {
    const repo = busyRepo();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });

    expect(await changes.file('p1', 'src/kept.ts', 'disk')).toMatchObject({ status: 200, etag: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect((await changes.file('p1', 'src/kept.ts', 'index')).status).toBe(400);
    expect((await changes.file('p1', '../x', 'disk')).status).toBe(400);
    expect(await changes.file('p1', 'ignored.log', 'disk')).toEqual({ status: 404, body: { error: 'ignored.log is not a file of this worktree.' } });
  });

  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

  it("gives a file's size and, when its extension and leading bytes agree, its media type", async () => {
    const repo = busyRepo();

    repo.write('shot.png', PNG);
    repo.write('fake.png', 'just text\n');
    repo.write('doc.pdf', '%PDF-1.7\n');
    repo.write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');

    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });
    const body = async (path: string) => (await changes.file('p1', path, 'disk')).body;

    expect(await body('shot.png')).toMatchObject({ media: 'image/png', binary: true, bytes: PNG.length, contents: null });
    expect(await body('fake.png')).toMatchObject({ media: null, binary: false, contents: 'just text\n' });
    expect(await body('doc.pdf')).toMatchObject({ media: 'application/pdf' });
    expect(await body('icon.svg')).toMatchObject({ media: 'image/svg+xml', contents: expect.stringContaining('<svg') });
  });

  it("changes its ETag when a picture's bytes change at the same size", async () => {
    const repo = busyRepo();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });

    repo.write('shot.png', PNG);

    const before = await changes.file('p1', 'shot.png', 'disk');

    repo.write('shot.png', Buffer.concat([PNG.subarray(0, PNG.length - 1), Buffer.from([9])]));

    const after = await changes.file('p1', 'shot.png', 'disk');

    expect((after.body as { bytes: number }).bytes).toBe((before.body as { bytes: number }).bytes);
    expect(after.etag).not.toBe(before.etag);
  });

  it("changes its ETag when a picture past the text cap changes at the same size", async () => {
    const repo = busyRepo();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });
    const big = Buffer.concat([PNG, Buffer.alloc(SIDE_MAX_BYTES + 1024)]);

    repo.write('big.png', big);

    const before = await changes.file('p1', 'big.png', 'disk');

    big[big.length - 1] = 7;
    repo.write('big.png', big);
    utimesSync(join(repo.root, 'big.png'), new Date(), new Date(Date.now() + 5_000));

    const after = await changes.file('p1', 'big.png', 'disk');

    expect(before.body).toMatchObject({ tooLarge: true, media: 'image/png' });
    expect(after.etag).not.toBe(before.etag);
  });

  it('reads a file on disk without reading the change list, whatever range is chosen', async () => {
    const repo = busyRepo();
    const calls: string[][] = [];
    const git: Git = (args, cwd, options) => (calls.push(args), nodeGit(args, cwd, options));
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root), git });
    const head = repo.git('rev-parse', 'HEAD').trim();

    expect(await changes.file('p1', 'src/kept.ts', 'disk', 'HEAD', 'worktree')).toMatchObject({ status: 200, body: { contents: lines(5) } });
    expect(await changes.file('p1', 'edited.md', 'disk', head, 'worktree')).toMatchObject({ status: 200, body: { contents: 'line 1\nchanged\nline 3\n' } });
    expect(calls.map((args) => args[0])).toEqual(['rev-parse', 'ls-files', 'rev-parse', 'ls-files']);

    const again = await changes.file('p1', 'src/kept.ts', 'disk');

    expect((await changes.file('p1', 'src/kept.ts', 'disk')).etag).toBe(again.etag);
    expect(await changes.file('p1', 'ignored.log', 'disk')).toMatchObject({ status: 404 });
    expect(await new PageChanges({ isPage: () => true, scope: () => scope(join(repo.root, 'src')) }).file('p1', 'kept.ts', 'disk')).toMatchObject({ status: 409, body: { error: expect.stringContaining('is not the top') } });
  });

  it('refuses a link or a junction on the file-only path', async () => {
    const repo = busyRepo();
    const outside = mkdtempSync(join(tmpdir(), 'sb-out-'));

    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(join(outside, 'secret.txt'), join(repo.root, 'link.txt'));
    symlinkSync(outside, join(repo.root, 'dir'), 'junction');

    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });

    expect((await changes.file('p1', 'link.txt', 'disk')).status).toBe(404);
    expect((await changes.file('p1', 'dir/secret.txt', 'disk')).status).toBe(404);
  });

  it("sends a picture's or PDF's bytes on disk and at a commit, and refuses an ignored file, a link, a mislabelled file and any other", async () => {
    const repo = busyRepo();

    repo.write('shot.png', PNG);
    repo.git('add', 'shot.png');
    repo.git('commit', '-qm', 'picture');
    repo.write('shot.png', Buffer.concat([PNG, Buffer.from([2])]));
    repo.write('.gitignore', 'ignored.log\nhidden.png\n');
    repo.write('hidden.png', PNG);
    repo.write('fake.png', 'text\n');
    symlinkSync(join(repo.root, 'shot.png'), join(repo.root, 'linked.png'));

    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });
    const head = repo.git('rev-parse', 'HEAD').trim();
    const disk = await changes.fileRaw('p1', 'shot.png', 'disk');

    expect(disk).toMatchObject({ status: 200, raw: { mime: 'image/png' } });
    expect('raw' in disk && disk.raw.bytes.length).toBe(PNG.length + 1);

    const base = await changes.fileRaw('p1', 'shot.png', 'base', head, 'worktree');

    expect('raw' in base && base.raw.bytes.length).toBe(PNG.length);

    for (const path of ['hidden.png', 'fake.png', 'linked.png', 'src/kept.ts', 'missing.png']) {
      expect((await changes.fileRaw('p1', path, 'disk')).status).toBe(404);
    }

    expect((await changes.fileRaw('p1', '../x.png', 'disk')).status).toBe(400);
  });
});

describe('viewed ticks', gitTimeout, () => {
  const scope = (cwd: string, scopeGen = 1): WindowScope => ({ kind: 'page', key: 'p1', folder: cwd, title: 'T', scopeGen, conversations: [], workItemId: 7, cwd, sessionId: 's1' });

  it("gives each row its content's blob ID, or deleted, and marks a row viewed only at the hash it was ticked at", { timeout: 30_000 }, async () => {
    const repo = busyRepo();
    const ticks = new Map<string, string>();
    const told: unknown[] = [];
    const changes = new PageChanges({
      isPage: () => true,
      scope: () => scope(repo.root),
      viewed: { list: () => new Map(ticks), set: (_id, _scope, path, hash) => (hash === null ? ticks.delete(path) : ticks.set(path, hash)) },
      viewedChanged: (id, from, payload) => told.push([id, from, payload]),
    });
    const rows = async () => ((await changes.changes('p1')).body as ChangesView).rows;
    const edited = (await rows()).find((row) => row.path === 'edited.md')!;

    expect(edited.hash).toBe(repo.git('hash-object', '--no-filters', 'edited.md').trim());
    expect((await rows()).find((row) => row.path === 'gone.txt')!.hash).toBe('deleted');
    expect(edited.viewed).toBe(false);

    expect(await changes.viewedCommand({ window: 'p1', scopeGen: 1, opId: 'v1', path: 'edited.md', hash: edited.hash, viewed: true })).toEqual({ status: 200, body: { path: 'edited.md', hash: edited.hash, viewed: true } });
    expect(told).toEqual([[7, 'p1', { path: 'edited.md', hash: edited.hash, viewed: true, scope: '' }]]);
    // A retried opId answers as the first did and tells no one again.
    expect((await changes.viewedCommand({ window: 'p1', scopeGen: 1, opId: 'v1', path: 'edited.md', hash: edited.hash, viewed: true })).status).toBe(200);
    expect(told).toHaveLength(1);
    expect((await changes.viewedCommand({ window: 'p1', scopeGen: 1, path: 'edited.md', hash: edited.hash, viewed: true })).status).toBe(400);
    expect((await rows()).find((row) => row.path === 'edited.md')!.viewed).toBe(true);

    // The file changes: its tick no longer shows, and a tick at the old hash is refused.
    repo.write('edited.md', 'changed again\n');
    expect((await rows()).find((row) => row.path === 'edited.md')!.viewed).toBe(false);
    expect((await changes.viewedCommand({ window: 'p1', scopeGen: 1, opId: 'o-old', path: 'edited.md', hash: edited.hash, viewed: true })).status).toBe(409);

    // A tick cleared, and refusals of a stale scope generation, a path that is no row, and a malformed body.
    const now = (await rows()).find((row) => row.path === 'edited.md')!;

    await changes.viewedCommand({ window: 'p1', scopeGen: 1, opId: 'v2', path: 'edited.md', hash: now.hash, viewed: true });
    await changes.viewedCommand({ window: 'p1', scopeGen: 1, opId: 'v3', path: 'edited.md', hash: now.hash, viewed: false });
    expect(ticks.has('edited.md')).toBe(false);
    expect((await changes.viewedCommand({ window: 'p1', scopeGen: 2, opId: 'v4', path: 'edited.md', hash: now.hash, viewed: true })).status).toBe(409);
    expect((await changes.viewedCommand({ window: 'p1', scopeGen: 1, opId: 'v5', path: 'src/kept.ts', hash: 'x', viewed: true })).status).toBe(404);
    expect((await changes.viewedCommand({ window: 'p1', scopeGen: 1, opId: 'v6', path: '../x', hash: 'x', viewed: true })).status).toBe(400);
    expect((await changes.viewedCommand({ window: 'p1', scopeGen: 1, opId: 'v7', path: 'edited.md', hash: now.hash, viewed: 'yes' })).status).toBe(400);
  });
});
