const assert = require('node:assert');
const vscode = require('vscode');

describe('New Claude Session in Editor Tab (PRD R75)', () => {
  const realError = vscode.window.showErrorMessage;
  let errors;

  before(async () => {
    await vscode.extensions.getExtension('switchboard.switchboard').activate();
  });

  beforeEach(() => {
    errors = [];
    vscode.window.showErrorMessage = (...args) => (errors.push(args[0]), Promise.resolve(undefined));
  });

  afterEach(() => {
    vscode.window.showErrorMessage = realError;
  });

  it('opens a new session in a tab and leaves claudeCode.preferredLocation alone', async () => {
    // The test host has no Claude extension; this stand-in records each call.
    const calls = [];
    const fake = vscode.commands.registerCommand('claude-vscode.editor.open', (...args) => calls.push(args));

    try {
      await vscode.commands.executeCommand('switchboard.newClaudeTab');
    } finally {
      fake.dispose();
    }

    assert.deepStrictEqual(calls, [[undefined, undefined, undefined, undefined, undefined, { programmatic: 'pin-to-panel' }]]);
    assert.deepStrictEqual(errors, []);
  });

  it('shows an error when Claude cannot open the tab', async () => {
    const fake = vscode.commands.registerCommand('claude-vscode.editor.open', () => {
      throw new Error('No Claude tab in this test.');
    });

    try {
      await vscode.commands.executeCommand('switchboard.newClaudeTab');
    } finally {
      fake.dispose();
    }

    assert.deepStrictEqual(errors, ['Switchboard: could not open a Claude tab: No Claude tab in this test.']);
  });

  it('puts its button in the editor title bar and the Claude sidebar', () => {
    const menus = vscode.extensions.getExtension('switchboard.switchboard').packageJSON.contributes.menus;

    const shown = (items) => items.map((item) => [item.command, item.when, item.group]);

    assert.deepStrictEqual(shown(menus['editor/title']), [
      ['switchboard.newClaudeTab', '!config.claudeCode.useTerminal', 'navigation'],
      ['switchboard.continueInBackground', "activeWebviewPanelId == 'claudeVSCodePanel'", 'navigation'],
    ]);
    assert.deepStrictEqual(shown(menus['view/title']), [
      ['switchboard.newClaudeTab', 'view == claudeVSCodeSidebar || view == claudeVSCodeSidebarSecondary', 'navigation'],
      ['switchboard.continueSidebarInBackground', 'view == claudeVSCodeSidebar || view == claudeVSCodeSidebarSecondary', 'navigation'],
      ['switchboard.showMessageDetails', '(view == switchboard.conversation || view == switchboard.conversationActivity) && !switchboard.messageDetails', '1_view'],
      ['switchboard.hideMessageDetails', '(view == switchboard.conversation || view == switchboard.conversationActivity) && switchboard.messageDetails', '1_view'],
    ]);
  });
});
