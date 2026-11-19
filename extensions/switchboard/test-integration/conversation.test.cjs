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
  it("is in the secondary side bar on this VS Code, resolves there, and shows that this window has no Switchboard session", async () => {
    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const [major, minor] = vscode.version.split('.').map(Number);

    assert.ok(major > 1 || minor >= 106, `VS Code ${vscode.version} has no secondary side bar for extensions`);

    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('workbench.view.extension.switchboard-conversation'), 'VS Code registered no command for the secondary side bar container');
    assert.ok(commands.includes('switchboard.conversation.focus'), 'VS Code registered no focus command for the view');
    await vscode.commands.executeCommand('switchboard.conversation.focus');
    // The suite's window is a folder window, which has no work item, so the hub's hello gives it no scope.
    await until(() => extension.conversation().connected, 'the view never received its hello');
    assert.deepStrictEqual(extension.conversation(), { scope: null, session: null, items: [], more: false, connected: true });
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  });
});
