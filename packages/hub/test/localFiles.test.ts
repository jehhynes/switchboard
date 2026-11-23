import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renameSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { allowedPath, LOCAL_DIR_MAX, LOCAL_TEXT_MAX_BYTES, localRoots, localTarget, mainCheckout, openLocalFile, rawMime } from '../src/localFiles.js';
import type { LocalRoots } from '../src/localFiles.js';

let dir: string;
let work: string;
let temp: string;
let roots: LocalRoots;
const SESSION = '0f1e2d3c-aaaa-bbbb-cccc-000000000001';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-local-'));
  work = join(dir, 'work');
  temp = join(dir, 'temp');
  mkdirSync(join(work, '.wip', 'artifacts', 'w1'), { recursive: true });
  mkdirSync(join(work, '.git'), { recursive: true });
  mkdirSync(join(work, 'src'), { recursive: true });
  mkdirSync(join(dir, 'outside'), { recursive: true });
  mkdirSync(join(temp, 'claude', 'proj', SESSION, 'scratchpad'), { recursive: true });
  mkdirSync(join(temp, 'claude', 'proj', 'another-session', 'scratchpad'), { recursive: true });
  writeFileSync(join(work, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(work, '.wip', 'notes.md'), '# Notes\n');
  writeFileSync(join(work, '.git', 'config'), '[remote]\n');
  writeFileSync(join(dir, 'outside', 'secret.txt'), 'secret');
  writeFileSync(join(temp, 'claude', 'proj', SESSION, 'scratchpad', 'out.txt'), 'mine');
  writeFileSync(join(temp, 'claude', 'proj', SESSION, 'other.txt'), 'not the scratchpad');
  writeFileSync(join(temp, 'claude', 'proj', 'another-session', 'scratchpad', 'out.txt'), 'theirs');
  roots = { cwd: work, folders: [work], sessionIds: [SESSION], temp };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('localTarget', () => {
  it('reads a file URI, an absolute path and a path relative to the working folder', () => {
    expect(localTarget(pathToFileURL(join(work, 'src', 'a.ts')).href, null)).toBe(join(work, 'src', 'a.ts'));
    expect(localTarget(join(work, 'src', 'a.ts'), null)).toBe(join(work, 'src', 'a.ts'));
    expect(localTarget('src/a.ts', work)).toBe(join(work, 'src', 'a.ts'));
    expect(localTarget('./src/../src/a.ts', work)).toBe(join(work, 'src', 'a.ts'));
  });

  it('refuses another scheme, a NUL, an empty target and a relative path with no working folder', () => {
    expect(localTarget('https://example.com/a.ts', work)).toBeNull();
    expect(localTarget('javascript:alert(1)', work)).toBeNull();
    expect(localTarget('vscode://file/a.ts', work)).toBeNull();
    expect(localTarget('src/a.ts\0.png', work)).toBeNull();
    expect(localTarget('', work)).toBeNull();
    expect(localTarget('src/a.ts', null)).toBeNull();
    expect(localTarget('file://%zz', work)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('reads a drive letter as a path, not a scheme', () => {
    expect(localTarget('C:/Windows/win.ini', null)).toBe(resolve('C:/Windows/win.ini'));
  });

  it.runIf(process.platform === 'win32')('reads a drive path written with a leading slash as that drive', () => {
    expect(localTarget('/D:/git/a/.wip/review.md', null)).toBe(resolve('D:/git/a/.wip/review.md'));
    expect(localTarget('\\C:\\Windows\\win.ini', null)).toBe(resolve('C:/Windows/win.ini'));
  });
});

describe('localRoots', () => {
  it("names the conversation's folders, its work item's sessions' folders and Claude session IDs, and resolves against the current session's folder", () => {
    const sessions = [
      { id: 's1', cwd: 'D:/repo', nativeSessionId: 'n1', retiredIds: ['old1'] },
      { id: 's2', cwd: 'D:/worktree', nativeSessionId: null, retiredIds: [] },
    ];

    expect(localRoots({ folder: 'D:/worktree', cwd: 'D:/worktree' }, sessions, 's1')).toEqual({ cwd: 'D:/repo', folders: ['D:/worktree', 'D:/worktree', 'D:/repo', 'D:/worktree'], sessionIds: ['n1', 'old1'] });
    expect(localRoots({ folder: 'D:/f', cwd: null }, [], null)).toEqual({ cwd: 'D:/f', folders: ['D:/f'], sessionIds: [] });
    expect(localRoots({ folder: null, cwd: null }, [], null)).toEqual({ cwd: null, folders: [], sessionIds: [] });
    // The work item's worktree and repository root, when it has them.
    expect(localRoots({ folder: 'D:/f', cwd: null }, [], null, false, ['D:/wt', null, 'D:/repo'])).toEqual({ cwd: 'D:/f', folders: ['D:/f', 'D:/wt', 'D:/repo'], sessionIds: [] });
  });

  it("names for a paired device only the current session's working folder, with no scratchpad and no folder listing", () => {
    const sessions = [
      { id: 's1', cwd: 'D:/repo', nativeSessionId: 'n1', retiredIds: ['old1'] },
      { id: 's2', cwd: 'D:/worktree', nativeSessionId: 'n2', retiredIds: [] },
    ];

    expect(localRoots({ folder: 'D:/host', cwd: 'D:/worktree' }, sessions, 's2', true)).toEqual({ cwd: 'D:/worktree', folders: ['D:/worktree'], sessionIds: [], listFolders: false });
    // A scope whose folder differs from the current session's gives only the session's.
    expect(localRoots({ folder: 'D:/host', cwd: 'D:/other' }, sessions, 's1', true)).toEqual({ cwd: 'D:/repo', folders: ['D:/repo'], sessionIds: [], listFolders: false });
    // Before its first session, the checkout it will run in.
    expect(localRoots({ folder: 'D:/host', cwd: 'D:/repo' }, [], null, true)).toEqual({ cwd: 'D:/repo', folders: ['D:/repo'], sessionIds: [], listFolders: false });
    // The work item's worktree and repository root, but still no other session's folder, the host folder or a scratchpad.
    expect(localRoots({ folder: 'D:/host', cwd: 'D:/worktree' }, sessions, 's2', true, ['D:/wt', 'D:/main', null])).toEqual({ cwd: 'D:/worktree', folders: ['D:/worktree', 'D:/wt', 'D:/main'], sessionIds: [], listFolders: false });
  });
});

describe('allowedPath', () => {
  it("takes a file or folder inside the conversation's folders by its real path, its .wip and artifacts included", async () => {
    expect(await allowedPath(roots, 'src/a.ts')).toBe(join(work, 'src', 'a.ts'));
    expect(await allowedPath(roots, '.wip/notes.md')).toBe(join(work, '.wip', 'notes.md'));
    expect(await allowedPath(roots, join(work, '.wip', 'artifacts'))).toBe(join(work, '.wip', 'artifacts'));
    expect(await allowedPath(roots, '.')).toBe(work);
  });

  it('refuses a path out of the folders, by .. or by an absolute path, and one that does not exist', async () => {
    expect(await allowedPath(roots, '../outside/secret.txt')).toBeNull();
    expect(await allowedPath(roots, 'src/../../outside/secret.txt')).toBeNull();
    expect(await allowedPath(roots, join(dir, 'outside', 'secret.txt'))).toBeNull();
    expect(await allowedPath(roots, pathToFileURL(join(dir, 'outside', 'secret.txt')).href)).toBeNull();
    expect(await allowedPath(roots, 'src/missing.ts')).toBeNull();
  });

  it('takes a single file named in files, such as the approval draft, wherever it is, and nothing beside it or in .git', async () => {
    const secret = join(dir, 'outside', 'secret.txt');

    writeFileSync(join(dir, 'outside', 'other.txt'), 'other');
    expect(await allowedPath({ ...roots, files: [secret] }, secret)).toBe(await realpath(secret));
    expect(await allowedPath({ ...roots, files: [secret] }, join(dir, 'outside', 'other.txt'))).toBeNull();
    expect(await allowedPath({ ...roots, files: [secret] }, join(dir, 'outside'))).toBeNull();
    expect(await allowedPath({ ...roots, files: [join(work, '.git', 'config')] }, join(work, '.git', 'config'))).toBeNull();
    // A folder named as the file is no file, and a junction to one is not either.
    expect(await allowedPath({ ...roots, files: [join(dir, 'outside')] }, join(dir, 'outside'))).toBeNull();
    symlinkSync(join(dir, 'outside'), join(dir, 'to-outside'), 'junction');
    expect(await allowedPath({ ...roots, files: [join(dir, 'to-outside')] }, join(dir, 'to-outside'))).toBeNull();
  });

  it('never takes a single file inside a never folder, such as the Switchboard home, by any spelling or link', async () => {
    const keys = join(dir, 'home', 'hub.json');

    mkdirSync(join(dir, 'home'));
    writeFileSync(keys, '{"token":"fake"}');
    symlinkSync(join(dir, 'home'), join(dir, 'linked-home'), 'junction');
    expect(await allowedPath({ ...roots, files: [keys], never: [join(dir, 'home')] }, keys)).toBeNull();
    expect(await allowedPath({ ...roots, files: [join(dir, 'linked-home', 'hub.json')], never: [join(dir, 'home')] }, join(dir, 'linked-home', 'hub.json'))).toBeNull();
    expect(await allowedPath({ ...roots, files: [keys], never: [join(dir, 'missing')] }, keys)).toBeNull();
    expect(await allowedPath({ ...roots, files: [keys], never: [join(dir, 'outside')] }, keys)).toBe(await realpath(keys));
    // Nor through a root that holds it, as a session working in the home folder makes its .switchboard one.
    expect(await allowedPath({ ...roots, cwd: dir, folders: [dir], never: [join(dir, 'home')] }, keys)).toBeNull();
    expect(await allowedPath({ ...roots, cwd: dir, folders: [dir], never: [join(dir, 'home')] }, join(dir, 'outside', 'secret.txt'))).toBe(await realpath(join(dir, 'outside', 'secret.txt')));
  });

  it('refuses a link or junction that leads out of the folders, and anything in .git', async () => {
    symlinkSync(join(dir, 'outside'), join(work, 'linked'), 'junction');

    expect(await allowedPath(roots, 'linked/secret.txt')).toBeNull();
    expect(await allowedPath(roots, 'linked')).toBeNull();
    expect(await allowedPath(roots, '.git/config')).toBeNull();
    expect(await allowedPath(roots, '.git')).toBeNull();
    expect(await allowedPath(roots, '.GIT/config')).toBeNull();
  });

  it('refuses a .git folder that is itself a root, as a session working there would make it', async () => {
    expect(await allowedPath({ ...roots, cwd: join(work, '.git'), folders: [join(work, '.git')] }, 'config')).toBeNull();
    expect(await allowedPath({ ...roots, cwd: join(work, '.git'), folders: [join(work, '.git')] }, '.')).toBeNull();
  });

  it('never takes a drive or filesystem root as a folder', async () => {
    const top = resolve('/');

    expect(await allowedPath({ ...roots, folders: [top] }, join(dir, 'outside', 'secret.txt'))).toBeNull();
  });

  it("takes only the conversation's own sessions' scratchpads, and nothing else in Claude's temporary folder", async () => {
    const claude = join(temp, 'claude', 'proj');

    expect(await allowedPath(roots, join(claude, SESSION, 'scratchpad', 'out.txt'))).toBe(join(claude, SESSION, 'scratchpad', 'out.txt'));
    expect(await allowedPath(roots, join(claude, SESSION, 'scratchpad'))).toBe(join(claude, SESSION, 'scratchpad'));
    expect(await allowedPath(roots, join(claude, 'another-session', 'scratchpad', 'out.txt'))).toBeNull();
    expect(await allowedPath(roots, join(claude, SESSION, 'other.txt'))).toBeNull();
    expect(await allowedPath(roots, join(claude, SESSION))).toBeNull();
    expect(await allowedPath(roots, join(temp, 'claude'))).toBeNull();
    expect(await allowedPath({ ...roots, sessionIds: [] }, join(claude, SESSION, 'scratchpad', 'out.txt'))).toBeNull();
  });

  it('refuses a link in a scratchpad that leads out of it', async () => {
    symlinkSync(join(dir, 'outside'), join(temp, 'claude', 'proj', SESSION, 'scratchpad', 'linked'), 'junction');

    expect(await allowedPath(roots, join(temp, 'claude', 'proj', SESSION, 'scratchpad', 'linked', 'secret.txt'))).toBeNull();
  });
});

describe('openLocalFile', () => {
  const read = async (target: string, inRoots: LocalRoots = roots) => {
    const opened = await openLocalFile(inRoots, target);

    await opened?.handle?.close();
    return opened?.view ?? null;
  };

  it("lists a folder's entries, folders first, without .git", async () => {
    writeFileSync(join(work, 'b.txt'), 'b');
    writeFileSync(join(work, 'A.txt'), 'a');

    const view = await read('.');

    expect(view).toMatchObject({ kind: 'dir', name: 'work', more: false, contents: null });
    expect(view!.path).toBe(work.split('\\').join('/'));
    expect(view!.entries).toEqual([
      { name: '.wip', dir: true },
      { name: 'src', dir: true },
      { name: 'A.txt', dir: false },
      { name: 'b.txt', dir: false },
    ]);
  });

  it('cuts a long listing and says there is more', async () => {
    const many = join(work, 'many');

    mkdirSync(many);

    for (let index = 0; index <= LOCAL_DIR_MAX; index++) {
      writeFileSync(join(many, `f${index}.txt`), '');
    }

    const view = await read('many');

    expect(view!.entries).toHaveLength(LOCAL_DIR_MAX);
    expect(view!.more).toBe(true);
  });

  it('reads text and Markdown whole, says a binary file is one, and sends no text past the cap', async () => {
    writeFileSync(join(work, 'bin.dat'), Buffer.from([1, 0, 2]));
    writeFileSync(join(work, 'big.log'), Buffer.alloc(LOCAL_TEXT_MAX_BYTES + 1, 0x61));

    expect(await read('src/a.ts')).toMatchObject({ kind: 'text', name: 'a.ts', contents: 'export const a = 1;\n', tooLarge: false });
    expect(await read('.wip/notes.md')).toMatchObject({ kind: 'markdown', contents: '# Notes\n' });
    expect(await read('bin.dat')).toMatchObject({ kind: 'binary', contents: null });
    expect(await read('big.log')).toMatchObject({ kind: 'text', contents: null, tooLarge: true });
    expect(await read('missing')).toBeNull();
    expect(await read('../outside/secret.txt')).toBeNull();
  });

  it('names a picture or PDF by its kind and size and keeps it open to send, without its bytes in the view', async () => {
    writeFileSync(join(work, 'shot.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(work, 'doc.pdf'), '%PDF-1.4');

    const shot = await openLocalFile(roots, 'shot.PNG');

    expect(shot!.view).toMatchObject({ kind: 'image', size: 4, contents: null, tooLarge: false });
    expect((await shot!.handle!.readFile()).length).toBe(4);
    await shot!.handle!.close();
    expect(await read('doc.pdf')).toMatchObject({ kind: 'pdf', size: 8, contents: null });
    expect(rawMime(join(work, 'shot.PNG'))).toBe('image/png');
    expect(rawMime(join(work, 'x.svg'))).toBe('image/svg+xml');
    expect(rawMime(join(work, 'x.html'))).toBeNull();
    expect(rawMime(join(work, 'a.ts'))).toBeNull();
  });

  it('refuses a file whose path was swapped for a junction out of the roots between the check and the read', async () => {
    mkdirSync(join(dir, 'outside', 'src'));
    writeFileSync(join(dir, 'outside', 'src', 'a.ts'), 'secret');

    const swap = async () => {
      renameSync(join(work, 'src'), join(work, 'src-old'));
      symlinkSync(join(dir, 'outside', 'src'), join(work, 'src'), 'junction');
    };

    expect(await openLocalFile(roots, 'src/a.ts', swap)).toBeNull();
  });

  it('refuses a folder swapped the same way, so its entries are never listed', async () => {
    mkdirSync(join(dir, 'outside', 'src'));
    writeFileSync(join(dir, 'outside', 'src', 'secret.txt'), 'secret');

    const swap = async () => {
      renameSync(join(work, 'src'), join(work, 'src-old'));
      symlinkSync(join(dir, 'outside', 'src'), join(work, 'src'), 'junction');
    };

    expect(await openLocalFile(roots, 'src', swap)).toBeNull();
  });
});

describe('openLocalFile for a paired device', () => {
  let paired: LocalRoots;

  beforeEach(() => {
    paired = localRoots({ folder: dir, cwd: work }, [{ id: 's', cwd: work, nativeSessionId: SESSION, retiredIds: [] }], 's', true);
    paired.temp = temp;
  });

  const read = async (target: string) => {
    const opened = await openLocalFile(paired, target);

    await opened?.handle?.close();
    return opened?.view ?? null;
  };

  it("reads a file in the session's working folder, its .wip included", async () => {
    writeFileSync(join(work, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(await read('src/a.ts')).toMatchObject({ kind: 'text', contents: 'export const a = 1;\n' });
    expect(await read(join(work, '.wip', 'notes.md'))).toMatchObject({ kind: 'markdown', contents: '# Notes\n' });
    expect(await read(pathToFileURL(join(work, 'shot.png')).href)).toMatchObject({ kind: 'image', size: 4 });
  });

  it('lists no folder, the working folder itself included', async () => {
    expect(await read('.')).toBeNull();
    expect(await read('src')).toBeNull();
    expect(await read('.wip/artifacts')).toBeNull();
  });

  it('refuses a file outside the working folder, by .. or an absolute path, even in a folder the computer may read', async () => {
    writeFileSync(join(dir, 'host.txt'), 'host folder');

    expect(await read('../outside/secret.txt')).toBeNull();
    expect(await read('src/../../outside/secret.txt')).toBeNull();
    expect(await read(join(dir, 'outside', 'secret.txt'))).toBeNull();
    // The conversation's host folder holds the working folder, but is not it.
    expect(await read(join(dir, 'host.txt'))).toBeNull();
    expect(await read('.git/config')).toBeNull();
  });

  it("refuses the session's scratchpad, which only this computer's page reads", async () => {
    expect(await read(join(temp, 'claude', 'proj', SESSION, 'scratchpad', 'out.txt'))).toBeNull();
  });

  it('refuses a junction or link out of the working folder', async () => {
    symlinkSync(join(dir, 'outside'), join(work, 'linked'), 'junction');

    expect(await read('linked/secret.txt')).toBeNull();
    expect(await read(join(work, 'linked', 'secret.txt'))).toBeNull();
  });

  it('refuses a file symlink out of the working folder', async (context) => {
    try {
      symlinkSync(join(dir, 'outside', 'secret.txt'), join(work, 'secret-link.txt'), 'file');
    } catch {
      // Windows makes a file symlink only with Developer Mode or as an administrator.
      context.skip();
    }

    expect((await readFile(join(work, 'secret-link.txt'), 'utf8'))).toBe('secret');

    expect(await read('secret-link.txt')).toBeNull();
  });
});

describe("openLocalFile for a paired device, with the work item's checkouts", () => {
  let repo: string;
  let worktree: string;
  let paired: LocalRoots;

  beforeEach(() => {
    repo = join(dir, 'repo');
    worktree = join(dir, 'repo.worktrees', 'fix');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'main.ts'), 'main');
    writeFileSync(join(repo, '.git', 'config'), '[core]\n');
    writeFileSync(join(worktree, 'src', 'fix.ts'), 'fix');
    writeFileSync(join(worktree, '.git'), 'gitdir: ../../repo/.git/worktrees/fix\n');
    // The session runs in its own working folder; the ticket's worktree and repository lie outside it.
    paired = localRoots({ folder: dir, cwd: work }, [{ id: 's', cwd: work, nativeSessionId: SESSION, retiredIds: [] }], 's', true, [worktree, repo]);
    paired.temp = temp;
  });

  const read = async (target: string) => {
    const opened = await openLocalFile(paired, target);

    await opened?.handle?.close();
    return opened?.view ?? null;
  };

  it("reads a file in the ticket's worktree and in its repository root, by path or file: URI", async () => {
    expect(await read(join(worktree, 'src', 'fix.ts'))).toMatchObject({ kind: 'text', contents: 'fix' });
    expect(await read(pathToFileURL(join(repo, 'src', 'main.ts')).href)).toMatchObject({ kind: 'text', contents: 'main' });
    // The working folder still reads, relative links against it.
    expect(await read('src/a.ts')).toMatchObject({ contents: 'export const a = 1;\n' });
  });

  it('still lists no folder, reads nothing in .git and nothing beside the checkouts', async () => {
    writeFileSync(join(dir, 'repo.worktrees', 'beside.txt'), 'beside');

    expect(await read(worktree)).toBeNull();
    expect(await read(join(repo, 'src'))).toBeNull();
    expect(await read(join(repo, '.git', 'config'))).toBeNull();
    expect(await read(join(worktree, '.git'))).toBeNull();
    expect(await read(join(dir, 'repo.worktrees', 'beside.txt'))).toBeNull();
    expect(await read(join(worktree, '..', 'beside.txt'))).toBeNull();
    expect(await read(join(dir, 'outside', 'secret.txt'))).toBeNull();
  });

  it('refuses a junction out of a checkout', async () => {
    symlinkSync(join(dir, 'outside'), join(worktree, 'linked'), 'junction');

    expect(await read(join(worktree, 'linked', 'secret.txt'))).toBeNull();
  });

  it('reads no checkout the work item does not have', async () => {
    paired = localRoots({ folder: dir, cwd: work }, [{ id: 's', cwd: work, nativeSessionId: SESSION, retiredIds: [] }], 's', true, [null, null]);

    expect(await read(join(worktree, 'src', 'fix.ts'))).toBeNull();
    expect(await read(join(repo, 'src', 'main.ts'))).toBeNull();
  });
});

describe('mainCheckout', () => {
  it("finds a linked worktree's main checkout through its .git file and commondir, and a main checkout's own folder", async () => {
    const main = join(dir, 'other-repo');
    const linked = join(dir, 'elsewhere', 'wt');

    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'gitdir'), `${join(linked, '.git')}\n`);
    writeFileSync(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);

    expect(await mainCheckout(linked)).toBe(main);
    expect(await mainCheckout(main)).toBe(main);

    // Pointed through another folder whose .git is a link to the repository's, it still names the repository, not that folder.
    const alias = join(dir, 'alias');

    mkdirSync(alias);
    symlinkSync(join(main, '.git'), join(alias, '.git'), 'junction');
    writeFileSync(join(linked, '.git'), `gitdir: ${join(alias, '.git', 'worktrees', 'wt')}\n`);
    expect(await mainCheckout(linked)).toBe(main);
  });

  it("refuses a .git file pointed at a repository that does not list the worktree as its own", async () => {
    const main = join(dir, 'unrelated');
    const linked = join(dir, 'pretender');
    const real = join(dir, 'real-wt');

    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(join(main, '.git', 'objects'), { recursive: true });
    mkdirSync(linked, { recursive: true });
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, '.git'), 'gitdir: x\n');
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    // The repository lists another worktree under that name.
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'gitdir'), `${join(real, '.git')}\n`);
    writeFileSync(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    expect(await mainCheckout(linked)).toBeNull();

    // A gitdir that is no entry of its repository's worktrees folder, such as the .git folder itself with a commondir and gitdir planted in it.
    writeFileSync(join(main, '.git', 'commondir'), '.\n');
    writeFileSync(join(main, '.git', 'gitdir'), `${join(linked, '.git')}\n`);
    writeFileSync(join(linked, '.git'), `gitdir: ${join(main, '.git')}\n`);
    expect(await mainCheckout(linked)).toBeNull();
  });

  it('gives null for a folder that is no checkout, a .git file with no gitdir, and a bare repository', async () => {
    const bare = join(dir, 'bare.git');
    const linked = join(dir, 'bare-wt');

    mkdirSync(join(bare, 'worktrees', 'w'), { recursive: true });
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(bare, 'worktrees', 'w', 'commondir'), '../..\n');
    writeFileSync(join(linked, '.git'), `gitdir: ${join(bare, 'worktrees', 'w')}\n`);

    expect(await mainCheckout(join(dir, 'outside'))).toBeNull();
    expect(await mainCheckout(linked)).toBeNull();
    writeFileSync(join(linked, '.git'), 'nonsense');
    expect(await mainCheckout(linked)).toBeNull();
  });
});
