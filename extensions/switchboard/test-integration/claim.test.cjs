const assert = require('node:assert');
const { createServer } = require('node:http');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const vscode = require('vscode');

/** A test-owned stand-in hub that answers each claim with the given commands, recording each claim's body. */
async function claimingHub(commands, sessionId = null) {
  const claims = [];
  const server = createServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      claims.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ sessionId, commands }));
    });
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));

  return { server, claims, port: server.address().port };
}

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

    try {
      await extension.claim({ ...extension.hub(), port: hub.port, token: 'stub-token' });

      assert.deepStrictEqual(hub.claims, [{ path: '/claim', body: { folder: vscode.workspace.workspaceFolders[0].uri.fsPath, workspace: null, focused: vscode.window.state.focused } }]);
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase(), report.toLowerCase());
      assert.deepStrictEqual(errors, []);
    } finally {
      hub.server.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  it('shows a command that fails and runs the rest', async () => {
    const report = join(mkdtempSync(join(tmpdir(), 'switchboard-claim-')), 'note.md');

    writeFileSync(report, 'Note');

    const hub = await claimingHub([{ type: 'openUrl', url: join(tmpdir(), 'cannot-open.md') }, { type: 'openUrl', url: report }]);

    try {
      await extension.claim({ ...extension.hub(), port: hub.port, token: 'stub-token' });

      assert.deepStrictEqual(errors, ['Switchboard: Error: The file cannot be opened.']);
      assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase(), report.toLowerCase());
    } finally {
      hub.server.close();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  it('runs the claimed commands when the claimed session fails to open', async () => {
    const report = join(mkdtempSync(join(tmpdir(), 'switchboard-claim-')), 'after.md');

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
});
