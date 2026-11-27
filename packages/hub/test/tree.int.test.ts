import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_TREE_PATHS, PageTree, SEARCH_MAX_FILES, SEARCH_MAX_LINES } from '../src/tree.js';
import type { PageTreeDeps, SearchView, TreeView } from '../src/tree.js';
import type { Git } from '../src/changes.js';
import { nodeGit, readDiskFile } from '../src/changes.js';
import type { WindowScope } from '../src/windows.js';
import { isolateGit, makeRepo } from './gitFixture.js';

beforeAll(() => isolateGit());

const gitTimeout = { timeout: process.platform === 'win32' ? 30_000 : 10_000 };

function page(cwd: string, patch: Partial<PageTreeDeps> = {}) {
  let current: WindowScope = { kind: 'page', key: 'p', folder: cwd, title: '', scopeGen: 1, conversations: [], workItemId: 7, cwd, sessionId: null };

  return { tree: new PageTree({ isPage: (key) => key === 'p', scope: () => current, ...patch }), move: (next: Partial<WindowScope>) => (current = { ...current, ...next }) };
}

function repo() {
  const made = makeRepo({ 'src/a.ts': 'const Alpha = 1;\nconst alphabet = 2;\n', 'src/b.md': 'alpha beta\n', 'README.md': 'Read me\n', '.gitignore': 'secret.log\n' });

  made.write('secret.log', 'alpha in an ignored file\n');
  made.write('new/untracked.ts', 'alpha untracked\n');
  return made;
}

const search = (tree: PageTree, q: string, more: Record<string, string> = {}, gen = 1) => tree.search('p', new URLSearchParams({ q, gen: String(gen), ...more }));
const found = async (reply: ReturnType<typeof search>) => {
  const answer = await reply;

  expect(answer.status).toBe(200);
  return (answer.body as SearchView).files.map((file) => [file.path, file.matches.map((match) => match.line)]);
};

describe('PageTree.tree', gitTimeout, () => {
  it('lists tracked and untracked files, never ignored ones, with an ETag', async () => {
    const made = repo();
    const reply = await page(made.root).tree.tree('p');

    expect(reply.status).toBe(200);
    expect((reply.body as TreeView).paths).toEqual(['.gitignore', 'README.md', 'new/untracked.ts', 'src/a.ts', 'src/b.md']);
    expect((reply.body as TreeView).more).toBe(false);
    expect(reply.etag).toMatch(/^[0-9a-f]{32}$/);
    expect((await page(made.root).tree.tree('p')).etag).toBe(reply.etag);
  });

  it(`lists at most ${MAX_TREE_PATHS} paths, saying there are more`, async () => {
    const many = Array.from({ length: MAX_TREE_PATHS + 5 }, (_, index) => `f${index}`).join('\0') + '\0';
    const git: Git = async () => ({ code: 0, stdout: Buffer.from(many), stderr: '', tooLarge: false });
    const reply = await page('/x', { git }).tree.tree('p');

    expect((reply.body as TreeView).paths).toHaveLength(MAX_TREE_PATHS);
    expect((reply.body as TreeView).more).toBe(true);
  });

  it('refuses another page and a conversation that changed meanwhile', async () => {
    const made = repo();
    const { tree, move } = page(made.root, { git: async (args, cwd) => (move({ scopeGen: 2 }), nodeGit(args, cwd)) });

    expect((await tree.tree('other')).status).toBe(403);
    expect(await tree.tree('p')).toMatchObject({ status: 409 });
  });
});

/** A repository whose git ignores .wip, out, dist, node_modules and *.log, with something in each. */
function ignoring() {
  const made = makeRepo({ 'src/a.ts': 'a\n', '.gitignore': '.wip/\nout/\ndist/\nnode_modules/\n*.log\n' });

  for (const path of ['.wip/notes.md', '.wip/artifacts/w7/plan.md', '.wip/node_modules/x/i.js', 'out/reports/r.md', 'out/other.txt', 'dist/b.js', 'node_modules/m/i.js', 'src/node_modules/n.js', 'secret.log', 'src/debug.log']) {
    made.write(path, 'ignored\n');
  }

  // A file git tracks inside node_modules is hidden too, at any depth.
  made.write('lib/node_modules/kept.js', 'tracked\n');
  made.git('add', '-f', 'lib/node_modules/kept.js');
  return made;
}

describe('PageTree.tree, ignored entries', gitTimeout, () => {
  const shown = (folders: string[]) => ({ folders: async () => folders });

  it('lists only the ignored entries in or on the way to a shown folder, a folder as itself, and never .git or node_modules', async () => {
    const made = ignoring();
    const reply = await page(made.root, shown(['.wip', 'out/reports'])).tree.tree('p');
    const body = reply.body as TreeView;

    expect(reply.status).toBe(200);
    expect(body.paths).toEqual(['.gitignore', 'src/a.ts']);
    expect(body.ignored).toEqual(['.wip/', 'out/']);
    expect(reply.etag).toMatch(/^[0-9a-f]{32}$/);
  });

  it('shows .wip alone without folders from the hub', async () => {
    const made = ignoring();

    expect(((await page(made.root).tree.tree('p')).body as TreeView).ignored).toEqual(['.wip/']);
  });

  it("lists a shown ignored folder's entries when asked, only those on the way to or inside a shown folder, without node_modules", async () => {
    const made = ignoring();
    const { tree } = page(made.root, shown(['.wip', 'out/reports']));

    expect((await tree.tree('p', '.wip')).body).toMatchObject({ dir: '.wip', paths: [], ignored: ['.wip/artifacts/', '.wip/notes.md'], more: false });
    expect(((await tree.tree('p', '.wip/artifacts/w7')).body as TreeView).ignored).toEqual(['.wip/artifacts/w7/plan.md']);
    expect(((await tree.tree('p', 'out')).body as TreeView).ignored).toEqual(['out/reports/']);
    expect(((await tree.tree('p', 'out/reports')).body as TreeView).ignored).toEqual(['out/reports/r.md']);
  });

  it('refuses a folder path that is not plain, names .git or node_modules, is hidden, not ignored, gone, or reached through a link', async () => {
    const made = ignoring();
    const outside = makeRepo({ 'x.md': 'x\n' });

    mkdirSync(join(made.root, '.wip', 'links'), { recursive: true });
    symlinkSync(outside.root, join(made.root, '.wip', 'links', 'out'), 'junction');

    const { tree } = page(made.root, shown(['.wip', 'out/reports', 'gone', 'src']));
    const status = async (dir: string) => (await tree.tree('p', dir)).status;

    expect(await Promise.all(['../x', '/etc', 'C:/Windows', '.', 'a//b', '.git', '.wip/node_modules', 'node_modules', 'a\\b'].map(status))).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 400]);
    // dist is ignored but not shown, src is shown but not ignored, gone was learned and deleted since, and a link leads out of the worktree.
    expect(await Promise.all(['dist', 'src', 'gone', 'out/other.txt', '.wip/links/out'].map(status))).toEqual([404, 404, 404, 404, 404]);
    // A link inside a shown folder is left out of its listing.
    expect(((await tree.tree('p', '.wip/links')).body as TreeView).ignored).toEqual([]);
    expect((await tree.tree('other', '.wip')).status).toBe(403);
  });
});

describe('readDiskFile, ignored files', gitTimeout, () => {
  it('reads an ignored file only inside a shown folder, and never a file under .git', async () => {
    const made = ignoring();
    const read = (path: string, folders: string[]) => readDiskFile(made.root, path, nodeGit, folders);

    expect((await read('.wip/notes.md', ['.wip']))?.contents).toBe('ignored\n');
    expect(await read('.wip/notes.md', [])).toBeNull();
    expect(await read('secret.log', ['.wip'])).toBeNull();
    expect(await read('dist/b.js', ['.wip'])).toBeNull();
    expect(await read('.git/config', ['.git', '.wip'])).toBeNull();
    expect((await read('src/a.ts', []))?.contents).toBe('a\n');
    // node_modules stays hidden from the file view too, tracked or ignored inside a shown folder.
    expect(await read('lib/node_modules/kept.js', [])).toBeNull();
    expect(await read('.wip/node_modules/x/i.js', ['.wip'])).toBeNull();
  });
});

describe('PageTree.search', gitTimeout, () => {
  it('finds literal text ignoring case in tracked and untracked files, never ignored ones', async () => {
    const { tree } = page(repo().root);

    expect(await found(search(tree, 'alpha'))).toEqual([
      ['new/untracked.ts', [1]],
      ['src/a.ts', [1, 2]],
      ['src/b.md', [1]],
    ]);
  });

  it('matches case, whole words and regular expressions when asked, and literal text otherwise', async () => {
    const { tree } = page(repo().root);

    expect(await found(search(tree, 'Alpha', { case: '1' }))).toEqual([['src/a.ts', [1]]]);
    expect(await found(search(tree, 'alpha', { word: '1' }))).toEqual([
      ['new/untracked.ts', [1]],
      ['src/a.ts', [1]],
      ['src/b.md', [1]],
    ]);
    expect(await found(search(tree, 'alph.b', { regex: '1' }))).toEqual([['src/a.ts', [2]]]);
    expect(await found(search(tree, 'alph.b'))).toEqual([]);
  });

  it('keeps only files the glob matches', async () => {
    const { tree } = page(repo().root);

    expect(await found(search(tree, 'alpha', { glob: '*.md' }))).toEqual([['src/b.md', [1]]]);
  });

  it("answers 400 with git's message for a regular expression it refuses, and for a bad request", async () => {
    const { tree } = page(repo().root);
    const refused = await search(tree, '(', { regex: '1' });

    expect(refused.status).toBe(400);
    expect((refused.body as { error: string }).error).toMatch(/\(/);
    expect((await tree.search('p', new URLSearchParams({ q: 'a' }))).status).toBe(400);
    expect((await search(tree, '')).status).toBe(400);
    expect((await search(tree, 'a', { case: 'yes' })).status).toBe(400);
  });

  it(`stops at ${SEARCH_MAX_LINES} lines and at ${SEARCH_MAX_FILES} files, saying there are more`, async () => {
    const many = makeRepo({ 'one.txt': 'hit\n'.repeat(SEARCH_MAX_LINES + 50) });
    const lines = await search(page(many.root).tree, 'hit');

    expect((lines.body as SearchView).files[0]!.matches).toHaveLength(SEARCH_MAX_LINES);
    expect((lines.body as SearchView).more).toBe(true);

    const files = makeRepo(Object.fromEntries(Array.from({ length: SEARCH_MAX_FILES + 10 }, (_, index) => [`f${String(index).padStart(4, '0')}.txt`, 'hit\n'])));
    const reply = await search(page(files.root).tree, 'hit');

    expect((reply.body as SearchView).files).toHaveLength(SEARCH_MAX_FILES);
    expect((reply.body as SearchView).more).toBe(true);
  });

  it('stops the running search when a newer one starts, and refuses an older one without stopping the newer', async () => {
    const made = repo();
    const children: ChildProcess[] = [];
    const spawnGit = vi.fn((command: string, args: string[], options: SpawnOptions) => {
      // The first search waits on a git that never answers until it is stopped.
      const child = children.length === 0 ? spawn('sleep', ['30'], options) : spawn(command, args, options);

      children.push(child);
      return child;
    });
    const { tree } = page(made.root, { spawnGit });
    const first = search(tree, 'alpha', {}, 5);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const older = await search(tree, 'alpha', {}, 4);

    expect(older).toMatchObject({ status: 409, body: { gen: 5 } });
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(false);

    const newer = search(tree, 'alpha', {}, 6);

    expect(await first).toMatchObject({ status: 409 });
    expect(children[0]!.killed).toBe(true);
    expect((await newer).status).toBe(200);
    expect(((await newer).body as SearchView).gen).toBe(6);
  });

  it('refuses a search for a conversation that changed while git read, and another page', async () => {
    const made = repo();
    const { tree, move } = page(made.root, { spawnGit: (command, args, options) => (move({ scopeGen: 2 }), spawn(command, args, options)) });

    expect(await search(tree, 'alpha')).toMatchObject({ status: 409, body: { error: "The window's conversation changed." } });
    expect((await tree.search('other', new URLSearchParams({ q: 'a', gen: '1' }))).status).toBe(403);
  });

  it("leaves a newer search's record when an older search's git ends", async () => {
    const made = repo();
    const { tree } = page(made.root);

    await Promise.all([search(tree, 'alpha', {}, 1), search(tree, 'alpha', {}, 2)]);
    expect((await search(tree, 'alpha', {}, 1)).status).toBe(409);
  });
});
