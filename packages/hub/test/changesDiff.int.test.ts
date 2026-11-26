import { mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeGit, PageChanges, readCapped, readChanges, readDiff, readFileView, SIDE_MAX_BYTES } from '../src/changes.js';
import type { Git, WorktreeChanges } from '../src/changes.js';
import type { WindowScope } from '../src/windows.js';
import { busyRepo, isolateGit, lines, makeRepo, removeRepos } from './gitFixture.js';

beforeAll(() => isolateGit());
afterAll(() => removeRepos());

// Git-backed suites create commits and run several reads; Windows process startup can exceed Vitest's five-second default.
const gitTimeout = { timeout: process.platform === 'win32' ? 15_000 : 5_000 };

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
