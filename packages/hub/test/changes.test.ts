import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DIFF_MAX_BYTES, fileInside, nodeGit, PageChanges, parseNameStatus, parseNumstat, readCapped, readChanges, readDiff, readFileView, relativePath, SIDE_MAX_BYTES } from '../src/changes.js';
import type { ChangesView, WorktreeChanges } from '../src/changes.js';
import type { WindowScope } from '../src/windows.js';
import { isolateGit, makeRepo } from './gitFixture.js';

beforeAll(() => isolateGit());

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

describe('readChanges', () => {
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

    const read = (await readChanges(repo.root, nodeGit, true, true)) as WorktreeChanges;

    expect(read.view).toMatchObject({ base: null, head: repo.git('rev-parse', 'HEAD').trim(), uncommitted: true, stages: { committed: 0, staged: 1, working: 3, untracked: 3 } });
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
    expect(((await readChanges(repo.root)) as WorktreeChanges).view).toMatchObject({ uncommitted: false, stages: { committed: 2 } });
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

describe('PageChanges', () => {
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

    expect(await changes(false, scope('x'))).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect(await changes(true, null)).toEqual({ status: 403, body: { error: 'Not in this window.' } });
    expect((await changes(true, scope(null))).status).toBe(409);
  });

  it('refuses the answer when the page moved to another conversation while git read', async () => {
    const repo = busyRepo();
    let gen = 1;
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root, gen++) });

    expect(await changes.changes('p1')).toEqual({ status: 409, body: { error: "The window's conversation changed." } });
  });
});

describe('readDiff', () => {
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

describe('readDiff without sides', () => {
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

describe('PageChanges.diff', () => {
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

describe('PageChanges with uncommitted', () => {
  const scope = (cwd: string): WindowScope => ({ kind: 'page', key: 'p1', folder: cwd, title: 'T', scopeGen: 1, conversations: [], workItemId: 7, cwd, sessionId: 's1' });

  it('PageChanges_Uncommitted_AnswersTheListDiffsAndFilesAgainstHead', { timeout: 30_000 }, async () => {
    const repo = busyRepo();

    repo.write('committed.ts', lines(5));

    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root) });
    const all = await changes.changes('p1');
    const only = await changes.changes('p1', '1');

    expect(only).toMatchObject({ status: 200, body: { scopeGen: 1, uncommitted: true, base: null, shown: 7 } });
    expect(all).toMatchObject({ status: 200, body: { uncommitted: false, shown: 8 } });
    expect(only.etag).not.toBe(all.etag);
    expect(await changes.changes('p1', '0')).toEqual(all);

    // The patch from HEAD has the one line added since the commit; from the base it has every line the work added.
    const patch = (reply: { body: unknown }) => (reply.body as { patch: string }).patch;
    const fromHead = patch(await changes.diff('p1', 'committed.ts', '0', '1'));
    const fromBase = patch(await changes.diff('p1', 'committed.ts', '0'));

    expect(fromHead.match(/^\+line \d+$/gm)).toEqual(['+line 5']);
    expect(fromBase.match(/^\+line \d+$/gm)).toEqual(['+line 3', '+line 4', '+line 5']);
    expect(await changes.diff('p1', 'added-in-commit.ts', '0', '1')).toEqual({ status: 404, body: { error: 'added-in-commit.ts is not one of the changes now.' } });
    expect((await changes.diff('p1', 'added-in-commit.ts', '0')).status).toBe(200);

    // The base side is the file at HEAD.
    expect(await changes.file('p1', 'committed.ts', 'base', '1')).toMatchObject({ status: 200, body: { contents: lines(4) } });
    expect(await changes.file('p1', 'committed.ts', 'base')).toMatchObject({ status: 200, body: { contents: lines(2) } });

    for (const reply of [await changes.changes('p1', 'yes'), await changes.diff('p1', 'edited.md', '0', 'true'), await changes.file('p1', 'edited.md', 'disk', '2')]) {
      expect(reply).toEqual({ status: 400, body: { error: 'Expected uncommitted 0 or 1.' } });
    }
  });

  it('ViewedCommand_Uncommitted_TicksARowOfTheUncommittedList', async () => {
    const repo = busyRepo();

    repo.write('committed.ts', lines(5));

    const ticks = new Map<string, string>();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root), viewed: { list: () => new Map(ticks), set: (_id, path, hash) => (hash === null ? ticks.delete(path) : ticks.set(path, hash)) } });
    const row = ((await changes.changes('p1', '1')).body as ChangesView).rows.find((one) => one.path === 'committed.ts')!;
    const tick = (opId: string, uncommitted?: unknown) => changes.viewedCommand({ window: 'p1', scopeGen: 1, opId, path: 'committed.ts', hash: row.hash, viewed: true, ...(uncommitted === undefined ? {} : { uncommitted }) });

    expect((await tick('b', 'yes')).status).toBe(400);
    expect(await tick('c', true)).toEqual({ status: 200, body: { path: 'committed.ts', hash: row.hash, viewed: true } });
    expect(((await changes.changes('p1', '1')).body as ChangesView).rows.find((one) => one.path === 'committed.ts')!.viewed).toBe(true);
  });
});

describe('the file view', () => {
  const scope = (cwd: string, scopeGen = 1): WindowScope => ({ kind: 'page', key: 'p1', folder: cwd, title: 'T', scopeGen, conversations: [], workItemId: 7, cwd, sessionId: 's1' });

  it("reads a file git tracks or would track on disk, and a change row's file at the base, and nothing else", async () => {
    const repo = busyRepo();
    const changes = (await readChanges(repo.root)) as WorktreeChanges;

    expect(await readFileView(changes, 'src/kept.ts', 'disk')).toEqual({ path: 'src/kept.ts', side: 'disk', contents: lines(5), binary: false, tooLarge: false });
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

  it("opens a file of the worktree at a line in the work item's window, by its real path, only at the page's scope generation", async () => {
    const repo = busyRepo();
    const opened: Array<[number, string, number]> = [];
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root, 4), openFile: (id, path, line) => (opened.push([id, path, line]), null) });

    expect(await changes.openFileCommand({ window: 'p1', scopeGen: 4, opId: 'o', path: 'src/kept.ts', line: 3 })).toEqual({ status: 200, body: { opened: 'src/kept.ts' } });
    // A retried opId answers as the first did and opens nothing more; one without an opId is refused.
    expect(await changes.openFileCommand({ window: 'p1', scopeGen: 4, opId: 'o', path: 'src/kept.ts', line: 3 })).toEqual({ status: 200, body: { opened: 'src/kept.ts' } });
    expect((await changes.openFileCommand({ window: 'p1', scopeGen: 4, path: 'src/kept.ts', line: 3 })).status).toBe(400);
    expect(opened).toEqual([[7, realpathSync.native(join(repo.root, 'src', 'kept.ts')), 3]]);
    expect((await changes.openFileCommand({ window: 'p1', scopeGen: 3, opId: 'o3', path: 'src/kept.ts', line: 3 })).status).toBe(409);
    expect((await changes.openFileCommand({ window: 'p1', scopeGen: 4, opId: 'o4', path: 'missing.ts', line: 3 })).status).toBe(404);
    expect((await changes.openFileCommand({ window: 'p1', scopeGen: 4, opId: 'o5', path: '../x', line: 3 })).status).toBe(400);
    expect((await changes.openFileCommand({ window: 'p1', scopeGen: 4, opId: 'o6', path: 'src/kept.ts', line: 0 })).status).toBe(400);
    expect(await new PageChanges({ isPage: () => true, scope: () => scope(repo.root, 4), openFile: () => 'The work item is gone.' }).openFileCommand({ window: 'p1', scopeGen: 4, opId: 'o2', path: 'src/kept.ts', line: 1 })).toEqual({ status: 409, body: { error: 'The work item is gone.' } });
    expect(opened).toHaveLength(1);
  });
});

describe('viewed ticks', () => {
  const scope = (cwd: string, scopeGen = 1): WindowScope => ({ kind: 'page', key: 'p1', folder: cwd, title: 'T', scopeGen, conversations: [], workItemId: 7, cwd, sessionId: 's1' });

  it("gives each row its content's blob ID, or deleted, and marks a row viewed only at the hash it was ticked at", { timeout: 30_000 }, async () => {
    const repo = busyRepo();
    const ticks = new Map<string, string>();
    const told: unknown[] = [];
    const changes = new PageChanges({
      isPage: () => true,
      scope: () => scope(repo.root),
      viewed: { list: () => new Map(ticks), set: (_id, path, hash) => (hash === null ? ticks.delete(path) : ticks.set(path, hash)) },
      viewedChanged: (id, from, payload) => told.push([id, from, payload]),
    });
    const rows = async () => ((await changes.changes('p1')).body as ChangesView).rows;
    const edited = (await rows()).find((row) => row.path === 'edited.md')!;

    expect(edited.hash).toBe(repo.git('hash-object', '--no-filters', 'edited.md').trim());
    expect((await rows()).find((row) => row.path === 'gone.txt')!.hash).toBe('deleted');
    expect(edited.viewed).toBe(false);

    expect(await changes.viewedCommand({ window: 'p1', scopeGen: 1, opId: 'v1', path: 'edited.md', hash: edited.hash, viewed: true })).toEqual({ status: 200, body: { path: 'edited.md', hash: edited.hash, viewed: true } });
    expect(told).toEqual([[7, 'p1', { path: 'edited.md', hash: edited.hash, viewed: true }]]);
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
