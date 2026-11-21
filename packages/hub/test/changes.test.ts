import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fileInside, PageChanges, parseNameStatus, parseNumstat, readChanges, relativePath } from '../src/changes.js';
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
