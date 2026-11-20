const assert = require('node:assert');
const vscode = require('vscode');

async function until(what, why, within = 30_000) {
  const deadline = Date.now() + within;

  for (;;) {
    const answer = await what();

    if (answer) {
      return answer;
    }

    assert.ok(Date.now() < deadline, why);
    await new Promise((done) => setTimeout(done, 200));
  }
}

/**
 * The Conversation view (architecture.md § Conversation view): contributed to the secondary side bar, as Claude Code's panel is, on a VS Code
 * from 1.106, with an activity bar container for an older one. The page's drawing is tested in test/conversation.test.ts; here, that this VS
 * Code accepts the container, resolves the view in it and that the view follows this window's conversation stream.
 */
describe('the Conversation view', () => {
  it("is in the secondary side bar on this VS Code, resolves there, and shows this folder window's empty folder scope", async () => {
    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const [major, minor] = vscode.version.split('.').map(Number);

    assert.ok(major > 1 || minor >= 106, `VS Code ${vscode.version} has no secondary side bar for extensions`);

    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('workbench.view.extension.switchboard-conversation'), 'VS Code registered no command for the secondary side bar container');
    assert.ok(commands.includes('switchboard.conversation.focus'), 'VS Code registered no focus command for the view');
    assert.ok(commands.includes('switchboard.newSession'), 'the extension registered no Switchboard: New Session command');
    await vscode.commands.executeCommand('switchboard.conversation.focus');
    // The suite's window is a folder window: the hub binds it to its folder's real path, with no work item and no conversation yet.
    await until(() => extension.conversation().connected, 'the view never received its hello');

    const own = extension.conversation().scope;
    const folder = require('node:fs').realpathSync.native(vscode.workspace.workspaceFolders[0].uri.fsPath);

    assert.deepStrictEqual({ ...extension.conversation(), scope: null }, { scope: null, session: null, items: [], more: false, connected: true, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: { enabled: false, here: false, mic: 'off', speaking: null, speakReplies: true, error: null }, settings: { expandReplies: false } });
    assert.deepStrictEqual({ ...own, key: 'k' }, { kind: 'folder', key: 'k', folder, title: require('node:path').basename(folder), scopeGen: 0, conversations: [], workItemId: null, cwd: null, sessionId: null });
    assert.strictEqual(extension.conversationBadge(), undefined);

    // The badge is every conversation's unread count together, gone at 0 (architecture.md § Unread).
    // The window may have connected earlier in the suite, before the focus command resolved the view, so the badge shows once it has.
    const entry = (workItemId, primary) => ({ workItemId, title: `Conversation ${workItemId}`, primary, sessionId: `s${workItemId}`, state: 'idle', conversation: 'full', unread: 0 });
    const scope = { kind: 'item', key: 'k', folder: 'D:/w', title: 'Conversation 5', scopeGen: 1, conversations: [entry(5, true), entry(6, false)], workItemId: 5, cwd: 'D:/w', sessionId: 's5' };

    extension.receiveConversation({ type: 'hello', scope, sessions: [], items: [], more: false, status: null, artifactsDir: null, artifacts: [], unread: 0 });
    extension.receiveConversation({ type: 'unread', workItemId: 5, count: 2 });
    await until(() => extension.conversationBadge() !== undefined, 'the view never showed its badge');
    assert.deepStrictEqual(extension.conversationBadge(), { value: 2, tooltip: '2 unread replies and statuses' });
    extension.receiveConversation({ type: 'unread', workItemId: 6, count: 1 });
    assert.deepStrictEqual(extension.conversationBadge(), { value: 3, tooltip: '3 unread replies and statuses' });
    extension.receiveConversation({ type: 'unread', workItemId: 5, count: 0 });
    extension.receiveConversation({ type: 'unread', workItemId: 6, count: 0 });
    assert.strictEqual(extension.conversationBadge(), undefined);
    // Back to this window's own state, its empty folder scope, for the tests after it.
    extension.receiveConversation({ type: 'hello', scope: own, sessions: [], items: [], more: false, status: null, artifactsDir: null, artifacts: [], unread: 0 });
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  });

  it("lists the composer's files under the window's folder without case, leaving out excluded folders, with the folders above them", async () => {
    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const folder = vscode.workspace.workspaceFolders[0].uri;
    const made = ['pick-test/Alpha One.ts', 'pick-test/deep/alphabet.md', 'node_modules/pick-test/alpha.js', 'pick-test/beta.ts'];

    try {
      for (const path of made) {
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, path), new Uint8Array());
      }

      // The window has no session, so the picker searches the window's folder.
      assert.deepStrictEqual(await extension.conversationFiles('ALPH'), [
        { path: 'pick-test/Alpha One.ts', dir: false },
        { path: 'pick-test/deep/alphabet.md', dir: false },
      ]);
      assert.deepStrictEqual(await extension.conversationFiles('pick-test/de'), [
        { path: 'pick-test/deep/', dir: true },
        { path: 'pick-test/deep/alphabet.md', dir: false },
      ]);
      assert.deepStrictEqual(await extension.conversationFiles('[x]'), []);
    } finally {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, 'pick-test'), { recursive: true });
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, 'node_modules'), { recursive: true });
    }
  });

  it('serves a status as a Markdown document under switchboard-status:, which the Markdown preview opens', async () => {
    await vscode.extensions.getExtension('switchboard.switchboard').activate();

    // This window was sent no status, so the document says so rather than show another window's.
    const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'switchboard-status', path: '/st-r-1/Status 2026-11-19 13.46.md' }));

    assert.strictEqual(document.languageId, 'markdown');
    assert.match(document.getText(), /no longer available in this window/);
    await vscode.commands.executeCommand('markdown.showPreview', document.uri);
    await until(() => vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.label.includes('Status 2026-11-19 13.46'))), 'the Markdown preview never opened the status');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
});
