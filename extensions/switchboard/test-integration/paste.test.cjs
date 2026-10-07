const assert = require('node:assert');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const vscode = require('vscode');

/** A row's Copy (PRD R60): the extension reads the paste's file and writes the clipboard. Rendering is tested in test/webview.test.ts. */
describe("an approval row's Copy", () => {
  let scratch;
  let clipboard;
  let reply;
  let note;
  let warned = [];
  let status = [];
  let picks = [];
  let choose = (items) => items[0];
  const originals = {};

  const copy = (pastes) => vscode.commands.executeCommand('switchboard.row.copy', { actions: { copy: { type: 'copy', pastes } } });

  before(async function () {
    this.timeout(60_000);
    await vscode.extensions.getExtension('switchboard.switchboard').activate();
    clipboard = await vscode.env.clipboard.readText();

    scratch = mkdtempSync(join(tmpdir(), 'switchboard-paste-'));
    reply = join(scratch, 'draft-reply.md');
    note = join(scratch, 'private-note.md');
    writeFileSync(reply, '﻿Alece,\r\n\r\nThis issue has been fixed.\r\n\r\n');
    writeFileSync(note, 'Bug: totals skip refunds\nGH: https://github.com/example-org/example-repo/issues/1\n');

    originals.showWarningMessage = vscode.window.showWarningMessage;
    originals.setStatusBarMessage = vscode.window.setStatusBarMessage;
    originals.showQuickPick = vscode.window.showQuickPick;
    vscode.window.showWarningMessage = (message) => (warned.push(message), Promise.resolve(undefined));
    vscode.window.setStatusBarMessage = (message) => (status.push(message), { dispose() {} });
    vscode.window.showQuickPick = (items) => (picks.push(items.map((item) => item.label)), Promise.resolve(choose(items)));
  });

  after(async () => {
    Object.assign(vscode.window, originals);
    // The clipboard is the machine's, so the developer's text is put back.
    await vscode.env.clipboard.writeText(clipboard);
    rmSync(scratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    warned = [];
    status = [];
    picks = [];
    choose = (items) => items[0];
    await vscode.env.clipboard.writeText('before');
  });

  it('copies the only paste without asking, without its BOM and trailing whitespace, and says so in the status bar', async () => {
    assert.strictEqual(await copy([{ label: 'Customer reply', file: reply }]), 'Customer reply');

    assert.strictEqual(await vscode.env.clipboard.readText(), 'Alece,\r\n\r\nThis issue has been fixed.');
    assert.deepStrictEqual(picks, []);
    assert.deepStrictEqual(status, ['Copied Customer reply']);
    assert.deepStrictEqual(warned, []);
  });

  it('asks which paste to copy when there are several, and copies nothing when the pick is dismissed', async () => {
    const pastes = [
      { label: 'Customer reply', file: reply },
      { label: 'Private note', file: note },
    ];

    choose = (items) => items[1];
    assert.strictEqual(await copy(pastes), 'Private note');
    assert.deepStrictEqual(picks, [['Customer reply', 'Private note']]);
    assert.strictEqual(await vscode.env.clipboard.readText(), 'Bug: totals skip refunds\nGH: https://github.com/example-org/example-repo/issues/1');

    choose = () => undefined;
    await vscode.env.clipboard.writeText('before');
    assert.strictEqual(await copy(pastes), null);
    assert.strictEqual(await vscode.env.clipboard.readText(), 'before');
    assert.deepStrictEqual(status, ['Copied Private note']);
  });

  it('warns about a missing file and leaves the clipboard alone', async () => {
    const missing = join(scratch, 'gone.md');

    assert.strictEqual(await copy([{ label: 'Customer reply', file: missing }]), null);

    assert.deepStrictEqual(warned, [`Switchboard: Customer reply was not copied: ${missing} does not exist.`]);
    assert.strictEqual(await vscode.env.clipboard.readText(), 'before');
    assert.deepStrictEqual(status, []);
  });
});
