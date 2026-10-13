const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
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

/** A work item whose task session waits on a question in its background process, or has ended once Open in Claude stopped it, or a ticket with no session. */
function item(id, cwd, state = 'waiting') {
  return {
    id,
    ticketId: id,
    parentId: null,
    playbook: 'dev:develop',
    status: state === 'ended' ? 'blocked' : state === 'none' ? 'unstarted' : 'running',
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
    sessions: state === 'none' ? [] : [
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
  };
}

/** A test-owned stand-in for a hub that accepts every request, recording each body. */
async function acceptingHub() {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push({ path: request.url, auth: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ done: true }));
    });
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));

  return { server, requests, port: server.address().port };
}

describe("A row's click from VS Code: a notification's Open (PRD R65, R70, R71)", () => {
  const realWarning = vscode.window.showWarningMessage;
  const realError = vscode.window.showErrorMessage;
  const realExecute = vscode.commands.executeCommand;
  const realOpenExternal = Object.getOwnPropertyDescriptor(vscode.env, 'openExternal');
  const windows = join(process.env.SWITCHBOARD_TEST_HOME, '.switchboard', 'windows');
  let extension;
  let hubState;
  let folder;
  let messages;
  let commands;
  let browsed;

  before(async () => {
    extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    hubState = await until(() => extension.state(), 'the extension never received the hub state');
    folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    // Stand-ins, so no Claude tab, window or browser opens and no message waits for a click.
    vscode.commands.executeCommand = (command, ...args) =>
      command.startsWith('claude-vscode.') || command === 'vscode.openFolder' ? (commands.push([command, ...args]), Promise.resolve()) : realExecute.call(vscode.commands, command, ...args);
    Object.defineProperty(vscode.env, 'openExternal', { configurable: true, value: (uri) => (browsed.push(uri.toString(true)), Promise.resolve(true)) });
    vscode.window.showWarningMessage = (...args) => (messages.push(args[0]), Promise.resolve(undefined));
    vscode.window.showErrorMessage = (...args) => (messages.push(args[0]), Promise.resolve(undefined));
  });

  after(() => {
    vscode.commands.executeCommand = realExecute;
    Object.defineProperty(vscode.env, 'openExternal', realOpenExternal);
    vscode.window.showWarningMessage = realWarning;
    vscode.window.showErrorMessage = realError;
    extension.show(JSON.stringify(hubState));
  });

  beforeEach(() => {
    messages = [];
    commands = [];
    browsed = [];
  });

  it("shows the hub's refusal of Open in Claude and opens nothing", async () => {
    extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder)] }));

    assert.strictEqual(await extension.openRow('item:7'), 'refused');
    assert.deepStrictEqual(messages, ['Switchboard: Unknown work item 7.']);
    assert.deepStrictEqual(commands, []);
  });

  it('stops a waiting session, leaves it for the item window once a state shows it ended, and brings that window forward', async () => {
    const hub = await acceptingHub();

    try {
      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder)] }));
      const pending = extension.openRow('item:7', { hub: { ...extension.hub(), port: hub.port, token: 'stub-token' }, waitMs: 15_000 });

      await until(() => hub.requests.length === 1, 'the action never reached the hub');
      assert.deepStrictEqual(hub.requests, [{ path: '/action', auth: 'Bearer stub-token', body: { type: 'open-question', workItemId: 7, nativeSessionId: 'native-7' } }]);

      // A state in which the session still waits opens nothing.
      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder)] }));
      await new Promise((done) => setTimeout(done, 300));
      assert.deepStrictEqual(commands, []);

      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder, 'ended')] }));
      assert.strictEqual(await pending, 'window');

      const open = hub.requests[1];
      const file = open.body.workspace;

      assert.deepStrictEqual(open, { path: '/open', auth: 'Bearer stub-token', body: { sessionId: 'native-7', cwd: folder, workspace: file } });
      assert.match(file, /gh-7-workspace-[0-9a-f]{6}\.code-workspace$/);
      assert.strictEqual(file.toLowerCase().startsWith(windows.toLowerCase()), true, `${file} is not under ${windows}`);
      assert.match(JSON.parse(readFileSync(file, 'utf8')).settings['window.title'], /^Issue 7\$\{separator\}\$\{activeEditorShort\}\$\{separator\}sb:gh-7-workspace-[0-9a-f]{6}$/);
      assert.deepStrictEqual(commands.map(([command, uri, options]) => [command, uri.fsPath.toLowerCase(), options]), [['vscode.openFolder', file.toLowerCase(), { forceNewWindow: true }]]);
      assert.deepStrictEqual(messages, []);
    } finally {
      hub.server.close();
    }
  });

  it('lets a click on another row replace one still waiting, ignores a second click on the row being opened, and never stops a question twice', async () => {
    const hub = await acceptingHub();

    try {
      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder), item(10, folder, 'ended')] }));
      const options = { hub: { ...extension.hub(), port: hub.port, token: 'stub-token' }, waitMs: 15_000 };
      const first = extension.openRow('item:7', options);

      await until(() => hub.requests.length === 1, 'the stop never reached the hub');
      assert.strictEqual(await extension.openRow('item:7', options), 'ignored');
      assert.strictEqual(await extension.openRow('item:10', options), 'window');

      // Back to the first row while its stop is still under way: it waits for that stop instead of sending another.
      const again = extension.openRow('item:7', options);

      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder, 'ended'), item(10, folder, 'ended')] }));
      assert.strictEqual(await first, 'replaced');
      assert.strictEqual(await again, 'window');
      assert.deepStrictEqual(hub.requests.map((request) => [request.path, request.body.sessionId ?? request.body.nativeSessionId]), [['/action', 'native-7'], ['/open', 'native-10'], ['/open', 'native-7']]);
      assert.deepStrictEqual(commands.map(([, uri]) => /gh-(\d+)-workspace/.exec(uri.fsPath)[1]), ['10', '7']);
    } finally {
      hub.server.close();
    }
  });

  it('says nothing about a stop that times out after another click replaced its click', async () => {
    const hub = await acceptingHub();

    try {
      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder), item(10, folder, 'ended')] }));
      const options = { hub: { ...extension.hub(), port: hub.port, token: 'stub-token' }, waitMs: 500 };
      const first = extension.openRow('item:7', options);

      await until(() => hub.requests.length === 1, 'the stop never reached the hub');
      assert.strictEqual(await extension.openRow('item:10', options), 'window');
      assert.strictEqual(await first, 'replaced');
      assert.deepStrictEqual(messages, []);
    } finally {
      hub.server.close();
    }
  });

  it('warns and opens nothing when the session does not end in time', async () => {
    const hub = await acceptingHub();

    try {
      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder)] }));

      assert.strictEqual(await extension.openRow('item:7', { hub: { ...extension.hub(), port: hub.port, token: 'stub-token' }, waitMs: 500 }), 'timeout');
      assert.deepStrictEqual(messages, ['Switchboard: the session did not stop within 0.5 seconds, so it was not opened in Claude.']);
      assert.deepStrictEqual(commands, []);
    } finally {
      hub.server.close();
    }
  });

  it('opens the ticket of a row with no item window, and does nothing for a row the state does not show', async () => {
    extension.show(JSON.stringify({ ...hubState, workItems: [item(9, folder, 'none')] }));

    assert.strictEqual(await extension.openRow('item:9'), 'url');
    assert.deepStrictEqual(browsed, ['https://github.com/o/r/issues/9']);
    assert.strictEqual(await extension.openRow('item:404'), 'nothing');
    assert.deepStrictEqual(commands, []);
  });
});
