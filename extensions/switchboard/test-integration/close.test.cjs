const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const vscode = require('vscode');

/** A work item whose task session runs in `cwd`, or that is done with its session's turn ended. */
function item(cwd, done) {
  return {
    id: 7,
    ticketId: 7,
    parentId: null,
    playbook: 'dev:develop',
    status: done ? 'done' : 'running',
    stage: null,
    stageAt: null,
    taskPrompt: null,
    warning: null,
    error: null,
    unassignedAt: null,
    queuedAt: null,
    approvalPrompt: null,
    approvalSummary: null,
    approvalReport: null,
    approvalHeld: false,
    createdAt: 1_791_000_000_000,
    statusAt: 1_791_000_000_000,
    runStartedAt: 1_791_000_000_000,
    scopeAt: null,
    doneAt: done ? 1_791_000_000_000 : null,
    doneReason: done ? 'session' : null,
    ticket: { id: 7, source: 'github', sourceKey: '7', ref: '#7', sourceId: null, title: 'Issue 7', url: 'https://github.com/o/r/issues/7', assigned: !done, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 1_791_000_000_000, repoRoot: '' },
    triage: null,
    sessions: [
      {
        id: 's7', workItemId: 7, kind: 'task', provider: 'claude', nativeSessionId: 'native-7', shortId: null, cwd, state: done ? 'idle' : 'running', stateAt: 1_791_000_000_000,
        stateDetail: null, outcome: done ? 'done' : null, outcomeDetail: null, startedAt: 1_791_000_000_000, endedAt: null, released: true, reports: ['done'],
      },
    ],
    worktree: null,
    links: [],
    pastes: [],
    waits: [],
    parent: null,
    returned: 0,
    approvalSends: false,
    question: null,
  };
}

describe('Closing done item windows (PRD R76)', () => {
  const realExecute = vscode.commands.executeCommand;
  const realError = vscode.window.showErrorMessage;
  const windows = join(process.env.SWITCHBOARD_TEST_HOME, '.switchboard', 'windows');
  let extension;
  let hubState;
  let running;
  let done;
  let file;
  let closed;
  let failClose;
  let errors;

  /** Sends the window's work item running, then done, then a focus loss, as the hub and VS Code would. */
  async function finish(window) {
    extension.itemWindow(window);
    await extension.receive(running);
    await extension.receive(done);
    await extension.windowStateChanged(false);
  }

  before(async () => {
    extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    hubState = extension.state();
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    // The window's name as the dock view gives it: the ticket key, the folder's name, and a hash of the folder (PRD R71).
    const hash = createHash('sha256').update(folder.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 6);

    file = join(windows, `gh-7-workspace-${hash}.code-workspace`);
    [running, done] = [item(folder, false), item(folder, true)].map((workItem) => JSON.stringify({ ...hubState, workItems: [workItem] }));
    // Stand-ins, so the suite's own window stays open and no message waits for a click.
    vscode.commands.executeCommand = (command, ...args) =>
      command === 'workbench.action.closeWindow' ? (closed.push(command), failClose ? Promise.reject(new Error('no window')) : Promise.resolve()) : realExecute.call(vscode.commands, command, ...args);
    vscode.window.showErrorMessage = (...args) => (errors.push(args[0]), Promise.resolve(undefined));
  });

  after(() => {
    vscode.commands.executeCommand = realExecute;
    vscode.window.showErrorMessage = realError;
    extension.itemWindow(null);
    extension.show(JSON.stringify(hubState));
  });

  beforeEach(() => {
    closed = [];
    errors = [];
    failClose = false;
  });

  it("runs VS Code's close window command once when the window's work became done", async () => {
    assert.ok((await vscode.commands.getCommands(true)).includes('workbench.action.closeWindow'));
    await finish(file);
    await extension.windowStateChanged(false);
    assert.deepStrictEqual(closed, ['workbench.action.closeWindow']);
    assert.deepStrictEqual(errors, []);
  });

  it('stays open for work that was already done, or for another window', async () => {
    extension.itemWindow(file);
    await extension.receive(done);
    await extension.windowStateChanged(false);
    await finish(join(windows, 'gh-8-workspace-aaaaaa.code-workspace'));
    assert.deepStrictEqual(closed, []);
  });

  it('stays open with switchboard.closeDoneWindows off', async () => {
    const settings = vscode.workspace.getConfiguration('switchboard');

    await settings.update('closeDoneWindows', false, vscode.ConfigurationTarget.Global);

    try {
      await finish(file);
      assert.deepStrictEqual(closed, []);
    } finally {
      await settings.update('closeDoneWindows', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('stays open while a document has unsaved changes, and closes on the next focus loss after they are saved', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'switchboard-close-')), 'note.txt');

    writeFileSync(path, 'Note\n');

    const document = await vscode.workspace.openTextDocument(path);
    const edit = new vscode.WorkspaceEdit();

    edit.insert(document.uri, new vscode.Position(0, 0), 'Unsaved ');
    await vscode.workspace.applyEdit(edit);
    assert.strictEqual(document.isDirty, true);

    try {
      await finish(file);
      assert.deepStrictEqual(closed, []);
    } finally {
      await document.save();
    }

    await extension.windowStateChanged(false);
    assert.deepStrictEqual(closed, ['workbench.action.closeWindow']);
  });

  it('shows a close that fails', async () => {
    failClose = true;
    await finish(file);
    assert.deepStrictEqual(closed, ['workbench.action.closeWindow']);
    assert.deepStrictEqual(errors, ['Switchboard: the window did not close: Error: no window']);
  });
});
