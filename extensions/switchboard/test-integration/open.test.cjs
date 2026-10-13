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
    ticket: { id, source: 'github', sourceKey: String(id), ref: `#${id}`, sourceId: null, title: `Issue ${id}`, url, assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 1_791_000_000_000, repoRoot: '' },
    triage: null,
    sessions: [
      {
        id: `s${id}`, workItemId: id, kind: 'task', provider: 'claude', nativeSessionId: `native-${id}`, shortId: null, cwd, state: 'ended', stateAt: 1_791_000_000_000,
        stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 1_791_000_000_000, endedAt: 1_791_000_000_000, released: true, reports: [],
      },
    ],
    worktree: null,
    links: [],
    pastes: [],
    waits: [],
    parent: null,
    returned: 0,
  };
}

const uri = (url) => vscode.Uri.parse(`vscode://switchboard.switchboard/open?url=${encodeURIComponent(url)}`);

describe('Open in Switchboard (PRD R69)', () => {
  const realExecute = vscode.commands.executeCommand;
  const realInformation = vscode.window.showInformationMessage;
  const realWarning = vscode.window.showWarningMessage;
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
  });

  after(() => {
    vscode.commands.executeCommand = realExecute;
    vscode.window.showInformationMessage = realInformation;
    vscode.window.showWarningMessage = realWarning;
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

  it("runs the click of the work item with the URI's ticket URL, bringing its item window forward", async () => {
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const desk = 'https://desk.example.test/t?id=5&x=1';

    extension.show(JSON.stringify({ ...hubState, workItems: [item(7, 'https://github.com/o/r/issues/7', folder), item(8, desk, folder)] }));

    assert.strictEqual(await extension.openUri(uri('https://github.com/O/R/issues/7/files')), 'item:7');
    await until(() => opened.length === 1, 'the click never ran');
    assert.match(opened[0], /gh-7-workspace-[0-9a-f]{6}\.code-workspace$/);

    // A ticket URL with its own query survives VS Code's decoding of the URI.
    assert.strictEqual(await extension.openUri(uri(desk)), 'item:8');
    await until(() => opened.length === 2, 'the second click never ran');
    assert.match(opened[1], /gh-8-workspace-[0-9a-f]{6}\.code-workspace$/);
    assert.deepStrictEqual(messages, []);
  });

  it('says when no row has the URL, and refuses another URI', async () => {
    extension.show(JSON.stringify({ ...hubState, workItems: [] }));

    assert.strictEqual(await extension.openUri(uri('https://github.com/o/r/issues/999')), null);
    assert.strictEqual(await extension.openUri(vscode.Uri.parse('vscode://switchboard.switchboard/close?url=x')), null);
    assert.deepStrictEqual(messages, ['Switchboard has no work item for https://github.com/o/r/issues/999', 'Switchboard cannot open vscode://switchboard.switchboard/close?url=x.']);
    assert.deepStrictEqual(opened, []);
  });
});
