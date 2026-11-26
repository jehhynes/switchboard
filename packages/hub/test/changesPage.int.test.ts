import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMIT_GONE, nodeGit, PageChanges } from '../src/changes.js';
import type { ChangesView, Git } from '../src/changes.js';
import type { WindowScope } from '../src/windows.js';
import { busyRepo, isolateGit, lines, removeRepos, twoCommits } from './gitFixture.js';

beforeAll(() => isolateGit());
afterAll(() => removeRepos());

// Git-backed suites create commits and run several reads; Windows process startup can exceed Vitest's five-second default.
const gitTimeout = { timeout: process.platform === 'win32' ? 15_000 : 5_000 };

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

  it('PageChangesDiff_ATagShadowingABaseRefSinceTheList_ReadsAgain', { timeout: 60_000 }, async () => {
    const repo = busyRepo();
    const { git, reads } = recording();
    const changes = new PageChanges({ isPage: () => true, scope: () => scope(repo.root), git });

    expect((await changes.changes('p1')).status).toBe(200);
    // Git resolves origin/main to this tag before any remote ref, so the merge base may differ.
    repo.git('tag', 'origin/main', 'HEAD');
    expect((await changes.diff('p1', 'edited.md', '0')).status).toBe(200);
    expect(reads()).toBe(2);
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
