const assert = require('node:assert');
const { createServer } = require('node:http');
const { appendFileSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const vscode = require('vscode');

/** A test-owned stand-in hub that answers each claim with the given commands, recording each claim's body. */
async function claimingHub(commands, sessionId = null, provider = sessionId === null ? null : 'claude') {
  const claims = [];
  const server = createServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      claims.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ sessionId, provider, commands }));
    });
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));

  return { server, claims, port: server.address().port };
}

async function until(what, why, within = 15_000) {
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

const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs);
const tabLabels = () => tabs().map((tab) => tab.label);

/** The Markdown preview tab of a file name, or undefined. */
const markdownPreview = (name) => tabs().find((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'vscode.markdown.preview.editor' && tab.input.uri.fsPath.endsWith(name));

describe('Commands the dock leaves for a window (PRD R71)', () => {
  const realError = vscode.window.showErrorMessage;
  const realExecute = vscode.commands.executeCommand;
  let extension;
  let errors;

  before(async () => {
    extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    vscode.window.showErrorMessage = (...args) => (errors.push(args[0]), Promise.resolve(undefined));
    // Stand-ins: a Claude tab that cannot open, and a file that cannot open, so each handler fails the same way every run.
    vscode.commands.executeCommand = (command, ...args) => {
      if (command.startsWith('claude-vscode.')) {
        return Promise.reject(new Error('No Claude tab in this test.'));
      }

      if (command === 'vscode.open' && String(args[0]?.fsPath).includes('cannot-open')) {
        return Promise.reject(new Error('The file cannot be opened.'));
      }

      return realExecute.call(vscode.commands, command, ...args);
    };
  });

  after(() => {
    vscode.window.showErrorMessage = realError;
    vscode.commands.executeCommand = realExecute;
  });

  beforeEach(() => {
    errors = [];
  });

  it('claims with its folder and no workspace file, and runs each claimed command, such as opening a report', async () => {
    const report = join(mkdtempSync(join(tmpdir(), 'switchboard-claim-')), 'reply.md');

    writeFileSync(report, 'Drafted reply');

    const hub = await claimingHub([{ type: 'openUrl', url: report }, { type: 'unknown' }]);

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    try {
      await extension.claim({ ...extension.hub(), port: hub.port, token: 'stub-token' });

      assert.deepStrictEqual(hub.claims, [{ path: '/claim', body: { folder: vscode.workspace.workspaceFolders[0].uri.fsPath, workspace: null, focused: vscode.window.state.focused } }]);
      // A Markdown report opens in the Markdown preview, not as text.
      await until(() => markdownPreview('reply.md'), `no Markdown preview of reply.md: ${JSON.stringify(tabLabels())}`);
      assert.strictEqual(vscode.window.activeTextEditor, undefined);
      assert.deepStrictEqual(errors, []);
    } finally {
      hub.server.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  it('shows the hub log in the Switchboard Hub output channel, which follows lines the hub adds', async () => {
    const hub = await claimingHub([{ type: 'log' }]);
    const log = join(process.env.SWITCHBOARD_TEST_HOME, '.switchboard', 'hub.log');
    const line = `${new Date().toISOString()} test line ${Date.now()}`;
    const shown = () => vscode.workspace.textDocuments.find((document) => document.uri.scheme === 'output' && document.getText().includes(line));

    try {
      await extension.claim({ ...extension.hub(), port: hub.port, token: 'stub-token' });
      appendFileSync(log, `${line}\n`);

      await until(shown, 'the output view never showed the line added to hub.log');
      assert.match(shown().getText(), / listening on 127\.0\.0\.1:\d+ as pid /);
      assert.deepStrictEqual(errors, []);
    } finally {
      hub.server.close();
      await vscode.commands.executeCommand('workbench.action.closePanel');
    }
  });

  it('shows a command that fails and runs the rest', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'switchboard-claim-'));
    const report = join(folder, 'note.txt');

    writeFileSync(report, 'Note');

    const hub = await claimingHub([
      { type: 'openUrl', url: join(tmpdir(), 'cannot-open.txt') },
      { type: 'openUrl', url: join(folder, 'missing.md') },
      { type: 'openUrl', url: report },
    ]);

    try {
      await extension.claim({ ...extension.hub(), port: hub.port, token: 'stub-token' });

      assert.strictEqual(errors.length, 2, JSON.stringify(errors));
      assert.strictEqual(errors[0], 'Switchboard: Error: The file cannot be opened.');
      assert.match(errors[1], /^Switchboard: .*missing\.md/);
      assert.strictEqual(markdownPreview('missing.md'), undefined);
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase(), report.toLowerCase());
    } finally {
      hub.server.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  it('runs the claimed commands when the claimed session fails to open', async () => {
    const report = join(mkdtempSync(join(tmpdir(), 'switchboard-claim-')), 'after.txt');

    writeFileSync(report, 'After');

    const hub = await claimingHub([{ type: 'openUrl', url: report }], 'native-1');

    try {
      assert.strictEqual(await extension.claim({ ...extension.hub(), port: hub.port, token: 'stub-token' }), 'native-1');
      assert.deepStrictEqual(errors, ['Switchboard: Error: No Claude tab in this test.']);
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase(), report.toLowerCase());
    } finally {
      hub.server.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  it("opens the window's tabs before the claimed session, so a session tab is in front, and the other commands after it (PRD R72)", async () => {
    const hub = await claimingHub([{ type: 'history', ticketId: 7, key: 'gh 7' }, { type: 'openTabs' }], 'native-2');
    const order = [];
    const execute = vscode.commands.executeCommand;

    vscode.commands.executeCommand = (command, ...args) => (command.startsWith('claude-vscode.') && order.push('session'), execute(command, ...args));

    try {
      await extension.claim({ ...extension.hub(), port: hub.port, token: 'stub-token' }, async (command) => order.push(command.type));

      assert.deepStrictEqual(order, ['openTabs', 'session', 'history']);
    } finally {
      vscode.commands.executeCommand = execute;
      hub.server.close();
    }
  });

  it("opens a claimed Code Mode session in its attach terminal, after the window's tabs and before the other commands, not in the Claude view (PRD R95)", async () => {
    const node = 'C:/Program Files/nodejs/node.exe';
    const args = ['C:/Users/me/.switchboard/hub.js', 'attach', 'sb-session-12'];
    // The hub sends a claimed open of a Code Mode session as this command, with no session to open in Claude.
    const hub = await claimingHub([
      { type: 'terminal', provider: 'claude', sessionId: 'sb-session-12', cwd: 'D:/git/widgets-wt/12-fix', name: 'gh 12', shortId: 'abcd0012', active: false, codeMode: true, executable: node, args },
      { type: 'history', ticketId: 12, key: 'gh 12' },
      { type: 'openTabs' },
    ]);
    const realCreate = Object.getOwnPropertyDescriptor(vscode.window, 'createTerminal');
    const created = [];
    const order = [];

    Object.defineProperty(vscode.window, 'createTerminal', { configurable: true, value: (options) => (created.push(options), order.push('terminal'), { options, exitStatus: undefined, show: () => {} }) });

    try {
      const run = (command) => (command.type === 'terminal' ? extension.run(command) : (order.push(command.type), Promise.resolve()));

      assert.strictEqual(await extension.claim({ ...extension.hub(), port: hub.port, token: 'stub-token' }, run), null);
      assert.deepStrictEqual(created.map(({ name, shellPath, shellArgs, cwd }) => ({ name, shellPath, shellArgs, cwd })), [{ name: 'Switchboard · gh 12', shellPath: node, shellArgs: args, cwd: 'D:/git/widgets-wt/12-fix' }]);
      assert.deepStrictEqual(order, ['openTabs', 'terminal', 'history']);
      // The stand-in Claude command fails, so an attempt to open the Claude view would show here.
      assert.deepStrictEqual(errors, []);
    } finally {
      Object.defineProperty(vscode.window, 'createTerminal', realCreate);
      hub.server.close();
    }
  });

  it("opens a claimed Codex session in this window's sidebar (PRD R29)", async () => {
    const calls = [];
    const execute = vscode.commands.executeCommand;
    const getExtension = vscode.extensions.getExtension;
    const asExternalUri = vscode.env.asExternalUri;
    const hub = await claimingHub([], 'thread-1', 'codex');
    const targeted = vscode.Uri.parse(`${vscode.env.uriScheme}://openai.chatgpt/local/thread-1?windowId=17`);

    vscode.extensions.getExtension = (id) => {
      assert.strictEqual(id, 'openai.chatgpt');
      return { activate: async () => { calls.push('activate'); } };
    };
    vscode.env.asExternalUri = async (uri) => {
      calls.push(uri.toString());
      return targeted;
    };
    vscode.commands.executeCommand = async (command, ...args) => {
      assert.strictEqual(command, 'vscode.open');
      assert.strictEqual(args[0], targeted);
      calls.push('open');
    };

    try {
      assert.strictEqual(await extension.claim({ ...extension.hub(), port: hub.port, token: 'stub-token' }), 'thread-1');
      assert.deepStrictEqual(calls, ['activate', `${vscode.env.uriScheme}://openai.chatgpt/local/thread-1`, 'open']);
      assert.deepStrictEqual(errors, []);
    } finally {
      vscode.commands.executeCommand = execute;
      vscode.extensions.getExtension = getExtension;
      vscode.env.asExternalUri = asExternalUri;
      hub.server.close();
    }
  });

  for (const failure of ['missing', 'activate', 'resolve', 'open']) {
    it(`reports Codex ${failure} failure and still runs claimed commands`, async () => {
      const execute = vscode.commands.executeCommand;
      const getExtension = vscode.extensions.getExtension;
      const asExternalUri = vscode.env.asExternalUri;
      const calls = [];
      const hub = await claimingHub([{ type: 'history' }], 'thread-1', 'codex');
      const step = (name) => {
        calls.push(name);
        if (failure === name) throw new Error(`${name} failed`);
      };

      vscode.extensions.getExtension = (id) => {
        assert.strictEqual(id, 'openai.chatgpt');
        return failure === 'missing' ? undefined : { activate: async () => step('activate') };
      };
      vscode.env.asExternalUri = async (uri) => { step('resolve'); return uri; };
      vscode.commands.executeCommand = async (command) => {
        assert.strictEqual(command, 'vscode.open');
        step('open');
      };

      try {
        await extension.claim({ ...extension.hub(), port: hub.port, token: 'stub-token' }, async (command) => calls.push(command.type));
        assert.deepStrictEqual(errors, [failure === 'missing'
          ? 'Switchboard: Error: Install or enable the Codex extension to open this session.'
          : `Switchboard: Error: ${failure} failed`]);
        const expected = {
          missing: ['history'],
          activate: ['activate', 'history'],
          resolve: ['activate', 'resolve', 'history'],
          open: ['activate', 'resolve', 'open', 'history'],
        };
        assert.deepStrictEqual(calls, expected[failure]);
      } finally {
        vscode.commands.executeCommand = execute;
        vscode.extensions.getExtension = getExtension;
        vscode.env.asExternalUri = asExternalUri;
        hub.server.close();
      }
    });
  }
});
