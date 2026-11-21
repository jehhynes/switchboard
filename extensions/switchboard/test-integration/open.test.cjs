const assert = require('node:assert');
const { join } = require('node:path');
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

/** A blocked work item whose session ended, so its click leaves the session for its item window and brings that window forward. */
function item(id, url, cwd) {
  return {
    id,
    ticketId: id,
    parentId: null,
    playbook: 'dev:develop',
    status: 'blocked',
    stage: null,
    stageAt: null,
    taskPrompt: null,
    warning: null,
    error: 'The session finished its turn.',
    unassignedAt: null,
    queuedAt: null,
    approvalPrompt: null,
    approvalSummary: null,
    approvalReport: null,
    createdAt: 1_791_000_000_000,
    statusAt: 1_791_000_000_000,
    readyAt: null,
    orderAt: null,
    runStartedAt: null,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    ticket: { id, source: 'github', sourceKey: String(id), ref: `#${id}`, sourceId: null, adhocKey: null, title: `Issue ${id}`, url, assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 1_791_000_000_000, repoRoot: '' },
    triage: null,
    focus: url,
    sessions: [
      {
        id: `s${id}`, workItemId: id, kind: 'task', provider: 'claude', nativeSessionId: `native-${id}`, shortId: null, cwd, state: 'ended', stateAt: 1_791_000_000_000,
        stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 1_791_000_000_000, endedAt: 1_791_000_000_000, released: true, reports: [],
      },
    ],
    worktree: null,
    links: [],
    pastes: [],
    comments: [],
    waits: [],
    parent: null,
    returned: 0,
    playbookChoices: [],
  };
}

const uri = (url) => vscode.Uri.parse(`vscode://switchboard.switchboard/open?url=${encodeURIComponent(url)}`);

describe('Open in Switchboard (PRD R69)', () => {
  const realExecute = vscode.commands.executeCommand;
  const realInformation = vscode.window.showInformationMessage;
  const realWarning = vscode.window.showWarningMessage;
  const realError = vscode.window.showErrorMessage;
  let extension;
  let hubState;
  let opened;
  let messages;

  before(async () => {
    extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    hubState = await until(() => extension.state(), 'the panel never received the hub state');
    // Stand-ins, so no window opens and no message waits for a click.
    vscode.commands.executeCommand = (command, ...args) => (command === 'vscode.openFolder' ? (opened.push(args[0].fsPath), Promise.resolve()) : realExecute.call(vscode.commands, command, ...args));
    vscode.window.showInformationMessage = (...args) => (messages.push(args[0]), Promise.resolve(undefined));
    vscode.window.showWarningMessage = (...args) => (messages.push(args[0]), Promise.resolve(undefined));
    vscode.window.showErrorMessage = (...args) => (messages.push(args[0]), Promise.resolve(undefined));
  });

  after(() => {
    vscode.commands.executeCommand = realExecute;
    vscode.window.showInformationMessage = realInformation;
    vscode.window.showWarningMessage = realWarning;
    vscode.window.showErrorMessage = realError;
    // The hub sends state only on a change, so later tests see its state again only through this.
    extension.show(JSON.stringify(hubState));
  });

  beforeEach(() => {
    opened = [];
    messages = [];
  });

  it('is activated by a vscode:// URI', () => {
    const events = vscode.extensions.getExtension('switchboard.switchboard').packageJSON.activationEvents;

    assert.ok(events.includes('onUri'), `activationEvents ${JSON.stringify(events)} lack onUri`);
  });

  it("asks the hub for the URI's row, which this window cannot see, and runs its click, bringing its item window forward", async () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(join(process.env.SWITCHBOARD_TEST_HOME, '.switchboard', 'switchboard.db'));
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;

    db.exec('PRAGMA busy_timeout = 5000');
    db.exec("INSERT INTO tickets (id, source, sourceKey, ref, title, url, assigned, repoRoot) VALUES (9101, 'github', '7', '#7', 'Seven', 'https://github.com/o/r/issues/7', 1, '')");
    db.exec("INSERT INTO workItems (id, ticketId, playbook, status, createdAt, statusAt, error) VALUES (9101, 9101, 'dev:develop', 'blocked', 1000, 2000, 'The session finished its turn.')");
    db.prepare("INSERT INTO sessions (id, workItemId, kind, provider, nativeSessionId, cwd, state, stateAt, startedAt, endedAt, released) VALUES ('open-1', 9101, 'task', 'claude', 'open-native', ?, 'ended', 1500, 1100, 1500, 1)").run(folder);

    try {
      // The hub reads the row from a view it builds after the change, so the first answers may still come from the earlier view.
      await until(async () => (await extension.openUri(uri('https://github.com/O/R/issues/7/files'))) === 'item:9101', 'the hub never found the row');
      await until(() => opened.length === 1, 'the click never ran');
      assert.match(opened[0], /gh-7-workspace-[0-9a-f]{6}\.code-workspace$/);
    } finally {
      db.exec("DELETE FROM sessions WHERE id = 'open-1'; DELETE FROM workItems WHERE id = 9101; DELETE FROM tickets WHERE id = 9101");
      db.close();
    }
  });

  it('says when no row has the URL, and refuses another URI', async () => {
    assert.strictEqual(await extension.openUri(uri('https://github.com/o/r/issues/999')), null);
    assert.strictEqual(await extension.openUri(vscode.Uri.parse('vscode://switchboard.switchboard/close?url=x')), null);
    assert.deepStrictEqual(messages, ['Switchboard: no work item has https://github.com/o/r/issues/999.', 'Switchboard: cannot open vscode://switchboard.switchboard/close?url=x.']);
    assert.deepStrictEqual(opened, []);
  });
});
