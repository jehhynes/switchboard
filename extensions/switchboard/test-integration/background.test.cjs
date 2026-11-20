const assert = require('node:assert');
const { createServer } = require('node:http');
const vscode = require('vscode');

const LABEL = 'switchboard · dev:develop · github 7';

/**
 * A test-owned stand-in hub that records each Continue in Background request and answers `reply`, after `hold` when set, and records each last
 * check before the window closes, answering `check`.
 */
async function stubHub() {
  const hub = { requests: [], reply: { status: 200, body: { pid: 4242 } }, hold: null, checks: [], check: { status: 200, body: { alone: true } } };
  const server = createServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', async () => {
      const checking = request.url === '/background/check';

      (checking ? hub.checks : hub.requests).push({ path: request.url, body: JSON.parse(body) });

      await (checking ? hub.checkHold : hub.hold)?.();

      const answer = checking ? hub.check : hub.reply;

      response.writeHead(answer.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  hub.server = server;
  hub.record = { pid: process.pid, port: server.address().port, token: 'test', build: 'test', startedAt: 0 };

  return hub;
}

const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs);
/** The Claude Code extension's tab is a webview of view type `claudeVSCodePanel`; the test host has no Claude extension, so this panel stands in. */
const claudeTab = (title = LABEL) => vscode.window.createWebviewPanel('claudeVSCodePanel', title, vscode.ViewColumn.One, {});
/** Waits until the tab in front is the Claude tab titled `title`, since a new or revealed panel becomes the active tab a moment later. */
async function inFront(title = LABEL) {
  for (const deadline = Date.now() + 5000; ; await new Promise((done) => setTimeout(done, 50))) {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;

    if (tab?.input instanceof vscode.TabInputWebview && tab.label === title) {
      return;
    }

    assert.ok(Date.now() < deadline, `the Claude tab ${title} did not come to the front`);
  }
}

/** Whether the panel's tab is open; a disposed panel's tab is not, and it can no longer be asked its title. */
const open = (panel) => {
  try {
    return tabs().some((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('claudeVSCodePanel') && tab.label === panel.title);
  } catch {
    return false;
  }
};

describe('Continue in Background (PRD R89)', () => {
  const realExecute = vscode.commands.executeCommand;
  const realWarning = vscode.window.showWarningMessage;
  const realError = vscode.window.showErrorMessage;
  let extension;
  let hub;
  let messages;
  /** Each window close, with whether the Claude tab was still open then. */
  let closes;
  let panels;

  before(async () => {
    extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    hub = await stubHub();
  });

  after(() => {
    hub.server.close();
  });

  beforeEach(async () => {
    await realExecute.call(vscode.commands, 'workbench.action.closeAllEditors');
    messages = [];
    closes = [];
    panels = [];
    hub.requests = [];
    hub.reply = { status: 200, body: { pid: 4242 } };
    hub.checks = [];
    hub.check = { status: 200, body: { alone: true } };
    hub.checkHold = null;
    hub.hold = null;
    vscode.window.showWarningMessage = (text) => (messages.push(text), Promise.resolve(undefined));
    vscode.window.showErrorMessage = (text) => (messages.push(text), Promise.resolve(undefined));
    // A stand-in, so the suite's own window stays open.
    vscode.commands.executeCommand = (command, ...args) =>
      command === 'workbench.action.closeWindow' ? (closes.push(panels.some(open)), Promise.resolve()) : realExecute.call(vscode.commands, command, ...args);
  });

  afterEach(async () => {
    vscode.commands.executeCommand = realExecute;
    vscode.window.showWarningMessage = realWarning;
    vscode.window.showErrorMessage = realError;
    panels.forEach((panel) => panel.dispose());

    // Each test's unsaved draft is discarded, so the next test starts with nothing dirty.
    for (const document of vscode.workspace.textDocuments.filter((entry) => entry.isDirty)) {
      await vscode.window.showTextDocument(document);
      await realExecute.call(vscode.commands, 'workbench.action.revertAndCloseActiveEditor');
    }

    await realExecute.call(vscode.commands, 'workbench.action.closeAllEditors');
  });

  it('asks the hub to move the active Claude tab’s session, then closes that tab and the window', async () => {
    panels.push(claudeTab());
    await inFront();

    await extension.background(hub.record, [7]);

    assert.deepStrictEqual(hub.requests, [{ path: '/background', body: { label: LABEL, hostPid: process.pid, workItemIds: [7] } }]);
    assert.strictEqual(open(panels[0]), false);
    assert.deepStrictEqual(closes, [false]);
    assert.deepStrictEqual(messages, []);
  });

  it('puts its button in the editor title bar of a Claude tab', () => {
    const { commands, menus } = vscode.extensions.getExtension('switchboard.switchboard').packageJSON.contributes;

    assert.ok(menus['editor/title'].some((item) => item.command === 'switchboard.continueInBackground' && item.when === "activeWebviewPanelId == 'claudeVSCodePanel'" && item.group === 'navigation'));
    assert.ok(commands.some((command) => command.command === 'switchboard.continueInBackground' && command.title === 'Continue in Background'));
  });

  it('refuses with another Claude tab open, unsaved changes, or no Claude tab in front, and asks the hub nothing', async () => {
    panels.push(claudeTab(), claudeTab('Another session'));
    panels[0].reveal();
    await inFront();
    await extension.background(hub.record, [7]);
    panels[1].dispose();

    const unsaved = await vscode.workspace.openTextDocument({ content: '' });
    const editor = await vscode.window.showTextDocument(unsaved, vscode.ViewColumn.Two, true);
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'draft'));
    panels[0].reveal(vscode.ViewColumn.One);
    await inFront();
    await extension.background(hub.record, [7]);

    await vscode.window.showTextDocument(unsaved, vscode.ViewColumn.Two, false);
    await extension.background(hub.record, [7]);

    assert.deepStrictEqual(messages, [
      'Switchboard: Close the other Claude tabs first; closing the window would end their sessions.',
      'Switchboard: Save or discard your changes first, so the window can close.',
      'Switchboard: Open the Claude tab to continue its session in the background.',
    ]);
    assert.deepStrictEqual(hub.requests, []);
    assert.deepStrictEqual(closes, []);
    assert.strictEqual(open(panels[0]), true);
  });

  it('shows the hub’s refusal and closes nothing', async () => {
    panels.push(claudeTab());
    await inFront();
    hub.reply = { status: 409, body: { error: 'Continue in Background works while the session is running.' } };

    await extension.background(hub.record, [7]);
    await extension.background(null, [7]);
    await extension.background(hub.record, null);

    assert.deepStrictEqual(messages, [
      'Switchboard: Continue in Background works while the session is running.',
      'Switchboard: the hub did not answer, so the session stays where it is.',
      "Switchboard: This session is not one of Switchboard's work items.",
    ]);
    assert.strictEqual(hub.requests.length, 1);
    assert.strictEqual(open(panels[0]), true);
    assert.deepStrictEqual(closes, []);
  });

  it('closes nothing when another Claude tab opened while the hub answered', async () => {
    panels.push(claudeTab());
    await inFront();
    hub.hold = async () => {
      panels.push(claudeTab('Another session'));
      await inFront('Another session');
      panels[0].reveal(vscode.ViewColumn.One);
      await inFront();
    };

    await extension.background(hub.record, [7]);

    assert.deepStrictEqual(messages, ['Switchboard: Close the other Claude tabs first; closing the window would end their sessions. The session stays where it is.']);
    assert.strictEqual(open(panels[0]), true);
    assert.deepStrictEqual(closes, []);
  });

  it('closes the Claude tab, not the editor in front, when focus moved while the hub answered', async () => {
    panels.push(claudeTab());
    await inFront();
    // A saved file, so nothing in the window is dirty.
    const note = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, '.keep'));
    hub.hold = async () => {
      await vscode.window.showTextDocument(note, vscode.ViewColumn.Two, false);
    };

    await extension.background(hub.record, [7]);

    assert.deepStrictEqual(messages, []);
    assert.strictEqual(open(panels[0]), false);
    assert.ok(tabs().some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === note.uri.toString()));
    assert.deepStrictEqual(closes, [false]);
  });

  it('closes nothing when a change was left unsaved while the hub answered', async () => {
    panels.push(claudeTab());
    await inFront();
    hub.hold = async () => {
      const draft = await vscode.workspace.openTextDocument({ content: '' });
      const editor = await vscode.window.showTextDocument(draft, vscode.ViewColumn.Two, true);
      await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'draft'));
    };

    await extension.background(hub.record, [7]);

    assert.deepStrictEqual(messages, ['Switchboard: Save or discard your changes first, so the window can close. The session stays where it is.']);
    assert.strictEqual(open(panels[0]), true);
    assert.deepStrictEqual(closes, []);
  });

  it("is the Claude tab title bar's button only, never in the command palette", () => {
    const { menus } = vscode.extensions.getExtension('switchboard.switchboard').packageJSON.contributes;

    assert.ok(menus.commandPalette.some((item) => item.command === 'switchboard.continueInBackground' && item.when === 'false'));
    assert.ok(menus['editor/title'].some((item) => item.command === 'switchboard.continueInBackground' && item.when === "activeWebviewPanelId == 'claudeVSCodePanel'"));
  });

  it('does not close a replacement Claude tab with the same label opened while the hub answered (review round 1, extension-1)', async () => {
    panels.push(claudeTab());
    await inFront();
    hub.hold = async () => {
      panels[0].dispose();

      // A disposed panel cannot be asked its title, so the tabs are counted instead.
      for (const deadline = Date.now() + 5000; tabs().some((tab) => tab.input instanceof vscode.TabInputWebview); await new Promise((done) => setTimeout(done, 50))) {
        assert.ok(Date.now() < deadline, 'the original tab did not close');
      }

      // A cut label can name another session too.
      panels.push(claudeTab());
      await inFront();
    };

    await extension.background(hub.record, [7]);

    assert.deepStrictEqual(messages, ['Switchboard: The Claude tab closed while Switchboard answered, so nothing else closes; its session continues in the background.']);
    assert.strictEqual(open(panels[1]), true);
    assert.deepStrictEqual(closes, []);
  });

  it('refuses while a Switchboard terminal is open, whose session the window would end (review round 1, goal-3)', async () => {
    panels.push(claudeTab());
    const terminal = vscode.window.createTerminal({ name: 'Switchboard · gh 7' });

    try {
      await inFront();
      await extension.background(hub.record, [7]);
    } finally {
      terminal.dispose();
    }

    assert.deepStrictEqual(messages, ["Switchboard: Close Switchboard's terminal first; closing the window would end its session."]);
    assert.deepStrictEqual(hub.requests, []);
    assert.deepStrictEqual(closes, []);
  });

  it('moves the Claude sidebar\'s session, which has no tab, and closes the window', async () => {
    await extension.background(hub.record, [7], 'sidebar');

    assert.deepStrictEqual(hub.requests, [{ path: '/background', body: { label: null, hostPid: process.pid, workItemIds: [7] } }]);
    assert.deepStrictEqual(closes, [false]);
    assert.deepStrictEqual(messages, []);
  });

  it('refuses the sidebar\'s move while a Claude tab is open, whose session the window would end', async () => {
    panels.push(claudeTab());
    await inFront();

    await extension.background(hub.record, [7], 'sidebar');

    assert.deepStrictEqual(messages, ['Switchboard: Close the Claude tabs first; closing the window would end their sessions.']);
    assert.deepStrictEqual(hub.requests, []);
    assert.deepStrictEqual(closes, []);
  });

  it('puts the sidebar\'s button in the Claude sidebar\'s title bar and keeps it out of the command palette', () => {
    const { commands, menus } = vscode.extensions.getExtension('switchboard.switchboard').packageJSON.contributes;

    assert.ok(commands.some((command) => command.command === 'switchboard.continueSidebarInBackground' && command.title === 'Continue in Background'));
    assert.ok(menus['view/title'].some((item) => item.command === 'switchboard.continueSidebarInBackground' && item.when === 'view == claudeVSCodeSidebar || view == claudeVSCodeSidebarSecondary'));
    assert.ok(menus.commandPalette.some((item) => item.command === 'switchboard.continueSidebarInBackground' && item.when === 'false'));
  });

  it('keeps the window open when another Claude session started in it while the hub answered, from the sidebar or a tab', async () => {
    hub.check = { status: 200, body: { alone: false } };
    await extension.background(hub.record, [7], 'sidebar');

    panels.push(claudeTab());
    await inFront();
    await extension.background(hub.record, [7]);

    assert.deepStrictEqual(hub.checks.map((check) => check.body), [{ hostPid: process.pid, pid: 4242 }, { hostPid: process.pid, pid: 4242 }]);
    assert.deepStrictEqual(messages, [
      'Switchboard: Another Claude session started in this window while Switchboard answered, so the window stays open.',
      'Switchboard: Another Claude session started in this window while Switchboard answered, so the window stays open.',
    ]);
    assert.strictEqual(open(panels[0]), true);
    assert.deepStrictEqual(closes, []);
  });

  it('keeps the window open when the last check fails', async () => {
    hub.check = { status: 409, body: { error: 'claude agents timed out' } };
    await extension.background(hub.record, [7], 'sidebar');

    assert.deepStrictEqual(messages, ["Switchboard: the window's sessions could not be checked, so the window stays open: claude agents timed out."]);
    assert.deepStrictEqual(closes, []);
  });

  it('checks the window again after the last check, so a Switchboard terminal opened during it keeps the window open', async () => {
    let terminal;
    hub.checkHold = async () => {
      terminal = vscode.window.createTerminal({ name: 'Switchboard · gh 7' });
    };

    try {
      await extension.background(hub.record, [7], 'sidebar');
    } finally {
      terminal?.dispose();
    }

    assert.deepStrictEqual(messages, ["Switchboard: Close Switchboard's terminal first; closing the window would end its session. The session stays where it is."]);
    assert.strictEqual(hub.checks.length, 1);
    assert.deepStrictEqual(closes, []);
  });
});
