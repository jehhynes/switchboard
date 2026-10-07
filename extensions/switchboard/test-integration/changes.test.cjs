const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const vscode = require('vscode');

/**
 * The private Git and workbench calls behind a row's Open Changes and Show in Source Control (PRD R57, mechanics M21), against a
 * scratch clone and worktree. changesPlan's decisions are tested in test/changes.test.ts.
 */
describe('a worktree row\'s Open Changes and Show in Source Control', () => {
  let scratch;
  let clone;
  let worktree;
  let base;
  let warned = [];
  const originals = {};

  function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  }

  const row = (key, message) => ({ actions: { [key]: message } });
  const changes = (path, title = 'Inbox badge') => vscode.commands.executeCommand('switchboard.row.changes', row('changes', { type: 'changes', path, key: 'gh 18941', title }));
  const repositories = () => vscode.extensions.getExtension('vscode.git').exports.getAPI(1).repositories.map((repository) => repository.rootUri.fsPath.toLowerCase());

  before(async function () {
    this.timeout(60_000);
    await vscode.extensions.getExtension('switchboard.switchboard').activate();

    scratch = mkdtempSync(join(tmpdir(), 'switchboard-changes-'));
    clone = join(scratch, 'repo');

    worktree = join(scratch, 'repo.worktrees', '18941-inbox-badge');
    mkdirSync(clone, { recursive: true });
    git(clone, 'init', '--initial-branch=main');
    git(clone, 'config', 'user.email', 'test@example.invalid');
    git(clone, 'config', 'user.name', 'Test');
    // A remote, so `origin/main` exists as a base ref; nothing is fetched from it.
    git(clone, 'remote', 'add', 'origin', 'https://github.com/example-org/example-repo.git');
    writeFileSync(join(clone, 'kept.txt'), 'one\n');
    writeFileSync(join(clone, 'removed.txt'), 'gone soon\n');
    writeFileSync(join(clone, 'staged.txt'), 'staged\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'base');
    git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    git(clone, 'worktree', 'add', '-b', '18941-inbox-badge', worktree);
    writeFileSync(join(worktree, 'kept.txt'), 'one\ntwo\n');
    writeFileSync(join(worktree, 'added.txt'), 'new file\n');
    rmSync(join(worktree, 'removed.txt'));
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'committed work');
    writeFileSync(join(worktree, 'dirty.txt'), 'not committed\n');
    // A staged edit then deleted on disk is a deletion, which only reading the index and working tree separately shows.
    writeFileSync(join(worktree, 'staged.txt'), 'staged and edited\n');
    git(worktree, 'add', 'staged.txt');
    rmSync(join(worktree, 'staged.txt'));
    // A committed file renamed in the index is one row from its old name at the base to its new name on disk.
    git(worktree, 'mv', 'kept.txt', 'renamed.txt');

    base = git(worktree, 'merge-base', 'HEAD', 'origin/main');

    for (const name of ['showWarningMessage', 'showInformationMessage', 'showErrorMessage']) {
      originals[name] = vscode.window[name];
      vscode.window[name] = (message) => (warned.push(message), Promise.resolve(undefined));
    }
  });

  after(async () => {
    Object.assign(vscode.window, originals);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Git can still hold a handle on Windows; the OS temp cleanup removes it later.
    }
  });

  beforeEach(() => {
    warned = [];
  });

  it('adds the worktree to Source Control and shows the view', async function () {
    this.timeout(60_000);

    assert.ok(!repositories().includes(worktree.toLowerCase()), 'the worktree was already open');

    await vscode.commands.executeCommand('switchboard.row.sourceControl', row('sourceControl', { type: 'sourceControl', path: worktree }));

    assert.deepStrictEqual(warned, []);
    assert.ok(repositories().includes(worktree.toLowerCase()), `the worktree is not in Source Control: ${repositories().join(', ')}`);
  });

  it('opens one editor with the committed and uncommitted changes since the merge base', async function () {
    this.timeout(60_000);

    await changes(worktree);

    assert.deepStrictEqual(warned, []);

    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;

    // added, removed, dirty, staged, and the kept → renamed rename; the editor appends the count.
    assert.strictEqual(tab?.label, `gh 18941 Inbox badge — since ${base.slice(0, 7)} (5 files)`);

    // textDiffs lists only two-sided rows (GC M30): the rename.
    const pairs = (tab.input.textDiffs ?? []).map((diff) => [diff.original, diff.modified]);

    assert.strictEqual(pairs.length, 1);

    const [original, modified] = pairs[0];

    assert.strictEqual(original.scheme, 'git');
    assert.strictEqual(JSON.parse(original.query).ref, base);
    assert.ok(original.fsPath.endsWith('kept.txt'), original.fsPath);
    assert.strictEqual(modified.scheme, 'file');
    assert.ok(modified.fsPath.endsWith('renamed.txt'), modified.fsPath);

    for (const uri of [original, modified]) {
      assert.ok(uri.fsPath.toLowerCase().startsWith(worktree.toLowerCase()), `${uri.fsPath} is outside ${worktree}`);
    }
  });

  const ticketTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).map((tab) => tab.label).filter((label) => label.startsWith('gh 18941 '));

  it('replaces the ticket\'s open editor with the current changes when opened again, after the ticket\'s title changed', async function () {
    this.timeout(60_000);
    writeFileSync(join(worktree, 'later.txt'), 'written after the first open\n');

    await changes(worktree, 'Inbox badge, renamed');

    assert.deepStrictEqual(warned, []);
    assert.deepStrictEqual(ticketTabs(), [`gh 18941 Inbox badge, renamed — since ${base.slice(0, 7)} (6 files)`]);
  });

  it('closes the ticket\'s open editor and says so when there are no changes now', async function () {
    this.timeout(60_000);

    const clean = join(scratch, 'repo.worktrees', '18941-clean');

    git(clone, 'worktree', 'add', '-b', '18941-clean', clean);
    await changes(clean);

    assert.deepStrictEqual(warned, ['Switchboard: gh 18941 Inbox badge: no changes since the merge base.']);
    assert.deepStrictEqual(ticketTabs(), []);
  });

  it('warns, and opens nothing, for a folder that is not a git checkout', async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const plain = join(scratch, 'plain');

    mkdirSync(plain);
    await changes(plain);

    assert.strictEqual(warned.length, 1, warned.join(' | '));
    assert.match(warned[0], /^Switchboard: VS Code has no repository at /);
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, undefined);
  });
});
