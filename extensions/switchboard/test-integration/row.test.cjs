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

/** A work item whose task session, held in the terminal holder as every Claude session is (PRD R93), waits on a question, runs or has ended, or a ticket with no session. */
function item(id, cwd, state = 'waiting') {
  return {
    id,
    ticketId: id,
    parentId: null,
    playbook: 'dev:develop',
    status: state === 'none' ? 'unstarted' : 'running',
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
    readyAt: null,
    orderAt: null,
    runStartedAt: 1_791_000_000_000,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    ticket: { id, source: 'github', sourceKey: String(id), ref: `#${id}`, sourceId: null, adhocKey: null, title: `Issue ${id}`, url: `https://github.com/o/r/issues/${id}`, assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 1_791_000_000_000, repoRoot: '' },
    triage: null,
    focus: `https://github.com/o/r/issues/${id}#issuecomment-${id}00`,
    sessions: state === 'none' ? [] : [
      {
        id: `s${id}`, workItemId: id, kind: 'task', provider: 'claude', nativeSessionId: `native-${id}`, shortId: `abcd000${id}`, cwd, state, stateAt: 1_791_000_000_000,
        stateDetail: null, outcome: state === 'ended' ? 'opened' : null, outcomeDetail: null, startedAt: 1_791_000_000_000, endedAt: state === 'ended' ? 1_791_000_000_000 : null, released: state === 'ended', reports: [], codeMode: true,
      },
    ],
    worktree: null,
    links: [],
    pastes: [],
    comments: [],
    waits: [],
    parent: null,
    returned: 0,
    approvalSends: false,
    playbookChoices: [],
  };
}

/** A test-owned stand-in for a hub that accepts every request, recording each body. */
async function acceptingHub(answer = () => [200, { done: true }]) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push({ path: request.url, auth: request.headers.authorization, body: JSON.parse(body) });
      const [status, reply] = answer(request.url);

      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(reply));
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

  it("shows the hub's refusal to leave a held session for the item window, and opens nothing", async () => {
    const hub = await acceptingHub(() => [409, { error: 'Unknown work item 7.' }]);

    try {
      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder)] }));

      assert.strictEqual(await extension.openRow('item:7', { hub: { ...extension.hub(), port: hub.port, token: 'stub-token' } }), 'refused');
      assert.deepStrictEqual(hub.requests.map(({ path }) => path), ['/open']);
      assert.deepStrictEqual(messages, ['Switchboard: Unknown work item 7.']);
      assert.deepStrictEqual(commands, []);
    } finally {
      hub.server.close();
    }
  });

  it('leaves a waiting held session for the item window, with no stop first, and brings that window forward (PRD R93)', async () => {
    const hub = await acceptingHub();

    try {
      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder)] }));

      assert.strictEqual(await extension.openRow('item:7', { hub: { ...extension.hub(), port: hub.port, token: 'stub-token' } }), 'window');
      assert.strictEqual(hub.requests.length, 1);

      const open = hub.requests[0];
      const file = open.body.workspace;

      // A held session is left by its Switchboard session ID, which the attach terminal uses.
      assert.deepStrictEqual(open, { path: '/open', auth: 'Bearer stub-token', body: { sessionId: 's7', cwd: folder, workspace: file } });
      assert.match(file, /gh-7-workspace-[0-9a-f]{6}\.code-workspace$/);
      assert.strictEqual(file.toLowerCase().startsWith(windows.toLowerCase()), true, `${file} is not under ${windows}`);
      assert.match(JSON.parse(readFileSync(file, 'utf8')).settings['window.title'], /^Issue 7\$\{separator\}\$\{activeEditorShort\}\$\{separator\}sb:gh-7-workspace-[0-9a-f]{6}$/);
      assert.deepStrictEqual(commands.map(([command, uri, options]) => [command, uri.fsPath.toLowerCase(), options]), [['vscode.openFolder', file.toLowerCase(), { forceNewWindow: true }]]);
      assert.deepStrictEqual(messages, []);
    } finally {
      hub.server.close();
    }
  });

  it('lets a click on another row replace one the hub has not answered yet, and ignores a second click on the row being opened', async () => {
    let release;
    const held = new Promise((done) => (release = done));
    const requests = [];
    const server = createServer((request, response) => {
      let body = '';

      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', async () => {
        const parsed = JSON.parse(body);

        requests.push({ path: request.url, body: parsed });

        // The first row's answer waits until the test lets it go, so the second click arrives while the first is under way.
        if (parsed.sessionId === 's7') {
          await held;
        }

        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ done: true }));
      });
    });

    await new Promise((done) => server.listen(0, '127.0.0.1', done));

    try {
      extension.show(JSON.stringify({ ...hubState, workItems: [item(7, folder), item(10, folder, 'ended')] }));
      const options = { hub: { ...extension.hub(), port: server.address().port, token: 'stub-token' } };
      const first = extension.openRow('item:7', options);

      await until(() => requests.length === 1, 'the first row never reached the hub');
      assert.strictEqual(await extension.openRow('item:7', options), 'ignored');
      assert.strictEqual(await extension.openRow('item:10', options), 'window');

      release();
      assert.strictEqual(await first, 'replaced');
      assert.deepStrictEqual(requests.map((one) => [one.path, one.body.sessionId]), [['/open', 's7'], ['/open', 's10']]);
      assert.deepStrictEqual(commands.map(([, uri]) => /gh-(\d+)-workspace/.exec(uri.fsPath)[1]), ['10']);
      assert.deepStrictEqual(messages, []);
    } finally {
      release();
      server.close();
    }
  });

  it('opens the focus of a row with no item window, and does nothing for a row the state does not show (PRD R79)', async () => {
    extension.show(JSON.stringify({ ...hubState, workItems: [item(9, folder, 'none')] }));

    assert.strictEqual(await extension.openRow('item:9'), 'url');
    assert.deepStrictEqual(browsed, ['https://github.com/o/r/issues/9#issuecomment-900']);
    assert.strictEqual(await extension.openRow('item:404'), 'nothing');
    assert.deepStrictEqual(commands, []);
  });

  it('forwards the click of a row that opens a terminal to the dock with dock.openVSCode review, and opens no window (PRD R65, R71)', async () => {
    const hub = await acceptingHub((path) => (path === '/dock/click' ? [202, { sent: true }] : [404, { error: 'unexpected' }]));

    try {
      extension.show(JSON.stringify({ ...hubState, openVSCode: 'review', workItems: [item(7, folder, 'running')] }));

      assert.strictEqual(await extension.openRow('item:7', { hub: { ...extension.hub(), port: hub.port, token: 'stub-token' } }), 'dock');
      assert.deepStrictEqual(hub.requests.map(({ path, body }) => [path, body]), [['/dock/click', { rowKey: 'item:7' }]]);
      assert.deepStrictEqual(commands, []);
      assert.deepStrictEqual(messages, []);
    } finally {
      hub.server.close();
    }
  });

  it("shows the hub's answer when no dock runs a forwarded click, and opens nothing", async () => {
    const hub = await acceptingHub(() => [409, { error: 'The dock is not running.' }]);

    try {
      extension.show(JSON.stringify({ ...hubState, openVSCode: 'review', workItems: [item(7, folder, 'running')] }));

      assert.strictEqual(await extension.openRow('item:7', { hub: { ...extension.hub(), port: hub.port, token: 'stub-token' } }), 'refused');
      assert.deepStrictEqual(messages, ['Switchboard: The dock is not running.']);
      assert.deepStrictEqual(commands, []);
    } finally {
      hub.server.close();
    }
  });

  it('opens the focus of a row with an item window but no session while dock.openVSCode is review (PRD R79)', async () => {
    extension.show(JSON.stringify({ ...hubState, openVSCode: 'review', workItems: [{ ...item(9, folder, 'none'), worktree: { id: 1, ticketId: 9, path: folder, branch: '9-fix', linkedBy: 'report' } }] }));

    assert.strictEqual(await extension.openRow('item:9'), 'url');
    assert.deepStrictEqual(browsed, ['https://github.com/o/r/issues/9#issuecomment-900']);
    assert.deepStrictEqual(commands, []);
  });
});
