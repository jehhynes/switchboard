import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMIT_GONE, MAX_COMMITS, nodeGit, PageChanges, parseRange, readChanges, readDiff, readFileView } from '../src/changes.js';
import type { ChangesView, WorktreeChanges } from '../src/changes.js';
import type { WindowScope } from '../src/windows.js';
import { busyRepo, isolateGit, lines, makeRepo, removeRepos, twoCommits } from './gitFixture.js';

beforeAll(() => isolateGit());
afterAll(() => removeRepos());

// Git-backed suites create commits and run several reads; Windows process startup can exceed Vitest's five-second default.
const gitTimeout = { timeout: process.platform === 'win32' ? 15_000 : 5_000 };

describe('readChanges with a range', gitTimeout, () => {
  it('ReadChanges_CommitsSinceTheBase_ListsThemNewestFirstWithParentSubjectAndDates', async () => {
    const { repo, base, first, second } = twoCommits();
    const view = ((await readChanges(repo.root)) as WorktreeChanges).view;
    const date = (format: string, sha: string) => Number(repo.git('log', '-1', `--format=${format}`, sha).trim());

    expect(view.commits).toEqual([
      { sha: second, parent: first, subject: 'second: more lines', authored: date('%at', second), committed: date('%ct', second), time: date('%ct', second) },
      { sha: first, parent: base, subject: 'work', authored: date('%at', first), committed: date('%ct', first), time: date('%ct', first) },
    ]);
    expect(view.commitsMore).toBe(false);
  });

  it('ReadChanges_AmendedCommit_KeepsTheAuthorDateApartFromTheCommitterDate', async () => {
    const repo = makeRepo({ 'a.txt': 'a\n' });
    const at = (date: number, ...args: string[]) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: `${date} +0000`, GIT_COMMITTER_DATE: `${date} +0000` } });

    repo.write('a.txt', 'b\n');
    at(1_800_000_000, 'commit', '-qam', 'work: first try');
    // An amend, as a rebase does, keeps the author date and writes a new committer date.
    at(1_800_005_400, 'commit', '-q', '--amend', '-m', 'work: amended');

    const view = ((await readChanges(repo.root)) as WorktreeChanges).view;

    expect(view.commits).toEqual([{ sha: repo.git('rev-parse', 'HEAD').trim(), parent: repo.git('rev-parse', 'origin/main').trim(), subject: 'work: amended', authored: 1_800_000_000, committed: 1_800_005_400, time: 1_800_005_400 }]);
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

    execFileSync('git', ['-C', repo.root, 'fast-import', '--quiet'], { input: stream });
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
