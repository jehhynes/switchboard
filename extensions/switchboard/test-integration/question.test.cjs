const assert = require('node:assert');
const { createServer } = require('node:http');
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

/** A work item whose task session waits on a question in its background process, or has ended once Open in Claude stopped it. */
function item(id, cwd, state = 'waiting') {
  return {
    id,
    ticketId: id,
    parentId: null,
    playbook: 'dev:develop',
    status: state === 'ended' ? 'blocked' : 'running',
    stage: null,
    stageAt: null,
    taskPrompt: null,
    warning: null,
    error: state === 'ended' ? 'Opened in Claude to answer.' : null,
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
    doneAt: null,
    doneReason: null,
    ticket: { id, source: 'github', sourceKey: String(id), ref: `#${id}`, sourceId: null, title: `Issue ${id}`, url: `https://github.com/o/r/issues/${id}`, assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 1_791_000_000_000, repoRoot: '' },
    triage: null,
    sessions: [
      {
        id: `s${id}`, workItemId: id, kind: 'task', provider: 'claude', nativeSessionId: `native-${id}`, shortId: `abcd000${id}`, cwd, state, stateAt: 1_791_000_000_000,
        stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 1_791_000_000_000, endedAt: state === 'ended' ? 1_791_000_000_000 : null, released: state === 'ended', reports: [],
      },
    ],
    worktree: null,
    links: [],
    pastes: [],
    waits: [],
    parent: null,
    returned: 0,
    approvalSends: false,
    question: state === 'ended' ? null : { text: 'Which tree?', options: [{ label: 'Oak', description: 'sturdy' }], parts: 1 },
  };
}

/** A test-owned stand-in for a hub that accepts every action, recording each body. */
async function acceptingHub() {
  const actions = [];
  const server = createServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      actions.push({ path: request.url, auth: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ done: true }));
    });
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));

  return { server, actions, port: server.address().port };
}

describe('Open in Claude (PRD R70)', () => {
  const realCreate = Object.getOwnPropertyDescriptor(vscode.window, 'createTerminal');
  const realWarning = vscode.window.showWarningMessage;
  const realError = vscode.window.showErrorMessage;
  const realExecute = vscode.commands.executeCommand;
  let extension;
  let hubState;
  let folder;
  let messages;
  let opened;
  let terminals;

  before(async () => {
    extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    hubState = await until(() => extension.state(), 'the panel never received the hub state');
    folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    // Stand-ins, so no Claude tab or process starts and no message waits for a click.
    vscode.commands.executeCommand = (command, ...args) => (command.startsWith('claude-vscode.') ? (opened.push([command, ...args]), Promise.resolve()) : realExecute.call(vscode.commands, command, ...args));
    Object.defineProperty(vscode.window, 'createTerminal', {
      configurable: true,
      value: (options) => (terminals.push(options.shellArgs), { exitStatus: undefined, show: () => {} }),
    });
    vscode.window.showWarningMessage = (...args) => (messages.push(args[0]), Promise.resolve(undefined));
    vscode.window.showErrorMessage = (...args) => (messages.push(args[0]), Promise.resolve(undefined));
  });

  after(() => {
    vscode.commands.executeCommand = realExecute;
    Object.defineProperty(vscode.window, 'createTerminal', realCreate);
    vscode.window.showWarningMessage = realWarning;
    vscode.window.showErrorMessage = realError;
    extension.show(JSON.stringify(hubState));
  });

  beforeEach(() => {
    messages = [];
    opened = [];
    terminals = [];
  });

  it("shows the hub's refusal and opens nothing", async () => {
    assert.strictEqual(await vscode.commands.executeCommand('switchboard.openQuestion', 999, 'native-999', folder), 'refused');
    assert.deepStrictEqual(messages, ['Switchboard: Unknown work item 999.']);
    assert.deepStrictEqual(opened, []);
  });

  it('opens the session in a Claude tab only once a state shows it ended', async () => {
    const hub = await acceptingHub();

    try {
      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder)] }));
      const pending = extension.openQuestion(7, 'native-7', folder, { hub: { ...extension.hub(), port: hub.port, token: 'stub-token' }, waitMs: 15_000 });

      await until(() => hub.actions.length === 1, 'the action never reached the hub');
      assert.deepStrictEqual(hub.actions, [{ path: '/action', auth: 'Bearer stub-token', body: { type: 'open-question', workItemId: 7, nativeSessionId: 'native-7' } }]);

      // A state in which the session still waits opens nothing.
      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder)] }));
      await new Promise((done) => setTimeout(done, 300));
      assert.deepStrictEqual(opened, []);

      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder, 'ended')] }));
      assert.strictEqual(await pending, 'opened');
      assert.deepStrictEqual(opened, [['claude-vscode.primaryEditor.open', 'native-7']]);
      assert.deepStrictEqual(messages, []);
    } finally {
      hub.server.close();
    }
  });

  it('warns and opens nothing when the session does not end in time', async () => {
    const hub = await acceptingHub();

    try {
      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder)] }));

      assert.strictEqual(await extension.openQuestion(7, 'native-7', folder, { hub: { ...extension.hub(), port: hub.port, token: 'stub-token' }, waitMs: 500 }), 'timeout');
      assert.deepStrictEqual(messages, ['Switchboard: the session did not stop within 0.5 seconds, so it was not opened in Claude.']);
      assert.deepStrictEqual(opened, []);
    } finally {
      hub.server.close();
    }
  });

  it("runs Open in Claude from the row's click action and its right-click menu, and Attach from the menu", async () => {
    extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder)] }));

    // The webview runs the row's click action, which asks the running hub, which has no such work item.
    assert.deepStrictEqual(await extension.openUri(vscode.Uri.parse(`vscode://switchboard.switchboard/open?url=${encodeURIComponent('https://github.com/o/r/issues/7')}`)), { workItemId: 7 });
    await until(() => messages.length === 1, 'the click action never reached the hub');
    assert.deepStrictEqual(messages, ['Switchboard: Unknown work item 7.']);

    await vscode.commands.executeCommand('switchboard.row.openQuestion', { actions: { openQuestion: { type: 'open-question', workItemId: 8, sessionId: 'native-8', cwd: folder } } });
    await until(() => messages.length === 2, 'the menu command never reached the hub');
    assert.strictEqual(messages[1], 'Switchboard: Unknown work item 8.');

    await vscode.commands.executeCommand('switchboard.row.attach', { actions: { attach: { type: 'attach', shortId: 'abcd0007', name: 'github 7' } } });
    assert.deepStrictEqual(terminals, [['attach', 'abcd0007']]);
    assert.deepStrictEqual(opened, []);
  });
});
