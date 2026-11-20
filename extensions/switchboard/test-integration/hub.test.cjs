const assert = require('node:assert');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { request } = require('node:http');
const { dirname, join } = require('node:path');
const vscode = require('vscode');

const hubJson = join(process.env.SWITCHBOARD_TEST_HOME, '.switchboard', 'hub.json');
const configDir = join(process.env.SWITCHBOARD_TEST_HOME, 'repo', 'switchboard');

function record() {
  try {
    return JSON.parse(readFileSync(hubJson, 'utf8'));
  } catch {
    return null;
  }
}

function call(port, path, token, method = 'GET', body) {
  return new Promise((resolve) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const outbound = request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });

    outbound.on('error', () => resolve(null));
    outbound.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

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

const api = () => vscode.extensions.getExtension('switchboard.switchboard').activate();

describe('the hub process', () => {
  it('is started by the extension in a separate process and connected', async () => {
    const extension = await api();
    const started = await until(() => record(), 'no hub.json was written');

    assert.notStrictEqual(started.pid, process.pid, 'the hub runs inside the extension host');
    assert.strictEqual(started.configDir, configDir);

    const status = await call(started.port, '/status', started.token);

    assert.strictEqual(status.status, 200);
    assert.strictEqual(JSON.parse(status.body).hub, 'switchboard');

    const connected = await until(() => extension.hub(), 'the extension never connected to the hub');

    assert.strictEqual(connected.pid, started.pid);
  });

  it('installs the terminal holder build in the home at activation', async () => {
    await api();

    const holder = join(process.env.SWITCHBOARD_TEST_HOME, '.switchboard', 'holder');
    const current = await until(() => (existsSync(join(holder, 'current.json')) ? JSON.parse(readFileSync(join(holder, 'current.json'), 'utf8')) : null), 'no holder build was named current');

    assert.match(current.build, /^[0-9a-f]{16}$/);
    assert.ok(existsSync(join(holder, current.build, 'holder.js')), 'holder.js is missing');
    assert.ok(existsSync(join(holder, current.build, 'node_modules', 'node-pty', 'package.json')), 'node-pty is missing');
  });

  it('refuses requests without the token', async () => {
    const started = await until(() => record(), 'no hub is running');

    assert.strictEqual((await call(started.port, '/status', null)).status, 401);
    assert.strictEqual((await call(started.port, '/status', 'wrong')).status, 401);
  });

  it('is started again when the running hub stops', async () => {
    const before = await until(() => record(), 'no hub is running');

    await call(before.port, '/shutdown', before.token, 'POST');

    const after = await until(
      () => {
        const now = record();

        return now && now.pid !== before.pid ? now : null;
      },
      'no new hub was started after the first stopped',
      60_000,
    );

    assert.strictEqual((await call(after.port, '/status', after.token)).status, 200);

    const extension = await api();

    await until(() => extension.hub()?.pid === after.pid, 'the extension did not reconnect to the new hub');
  });

  it('sends its state to the window and refuses an action that does not apply', async () => {
    const extension = await api();
    const state = await until(() => extension.state(), 'the window never received the hub state');

    assert.deepStrictEqual(state.workItems, []);
    assert.deepStrictEqual(state.errors, { settings: null, playbooks: [], hooks: null, sources: {} });

    const hub = await until(() => extension.hub(), 'not connected');
    const refused = await call(hub.port, '/action', hub.token, 'POST', { type: 'approve', workItemId: 1 });

    assert.strictEqual(refused.status, 409);
    assert.strictEqual(JSON.parse(refused.body).error, 'Unknown work item 1.');
  });

  it("claims no open left for an item window or for none, since a folder window claims only its own folder's (architecture.md § Window scope)", async () => {
    const extension = await api();
    await until(() => extension.hub(), 'not connected');

    // The test host has no Claude extension; this stand-in records the session each call opens.
    const opened = [];
    const fake = vscode.commands.registerCommand('claude-vscode.primaryEditor.open', (sessionId) => opened.push(sessionId));

    try {
      const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const hub = extension.hub();
      // An open names its destination window; one the hub cannot place is refused, and a folder window claims none left for an item window.
      const nowhere = await call(hub.port, '/open', hub.token, 'POST', { sessionId: 'there-native', cwd: folder });

      assert.strictEqual(nowhere.status, 409);
      assert.strictEqual(JSON.parse(nowhere.body).error, 'The session has no window to open it in.');
      assert.strictEqual((await call(hub.port, '/open', hub.token, 'POST', { sessionId: 'there-native', cwd: folder, workspace: join(process.env.SWITCHBOARD_TEST_HOME, 'other.code-workspace') })).status, 200);
      assert.strictEqual(await vscode.commands.executeCommand('switchboard.claim'), null);
      assert.deepStrictEqual(opened, []);
    } finally {
      fake.dispose();
    }
  });

  it('opens a claimed session in the Claude sidebar when claudeCode.preferredLocation is sidebar', async () => {
    const extension = await api();
    await until(() => extension.hub(), 'not connected');

    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const settings = join(folder, '.vscode', 'settings.json');
    const tabs = [];
    const sidebar = [];
    const fakes = [
      vscode.commands.registerCommand('claude-vscode.primaryEditor.open', (sessionId) => tabs.push(sessionId)),
      vscode.commands.registerCommand('claude-vscode.editor.open', (...args) => sidebar.push(args)),
    ];
    // A stand-in hub that hands this window the session, as the hub does for the window an open names.
    const stand = require('node:http').createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ sessionId: 'claimed-native', provider: 'claude', commands: [] }));
      });
    });

    await new Promise((done) => stand.listen(0, '127.0.0.1', done));

    try {
      mkdirSync(dirname(settings), { recursive: true });
      writeFileSync(settings, JSON.stringify({ 'claudeCode.preferredLocation': 'sidebar' }));
      await until(() => vscode.workspace.getConfiguration('claudeCode').get('preferredLocation') === 'sidebar', 'setting not read');

      assert.strictEqual(await extension.claim({ ...extension.hub(), port: stand.address().port, token: 'stub-token' }), 'claimed-native');

      const honor = [undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' }];
      assert.deepStrictEqual(sidebar, [['claimed-native', ...honor]]);
      assert.deepStrictEqual(tabs, []);
    } finally {
      stand.close();
      rmSync(dirname(settings), { recursive: true, force: true });
      await until(() => vscode.workspace.getConfiguration('claudeCode').get('preferredLocation') === undefined, 'setting not cleared');
      fakes.forEach((fake) => fake.dispose());
    }
  });

  it("opens an approval's Markdown report in the Markdown preview", async () => {
    await api();
    const file = join(process.env.SWITCHBOARD_TEST_HOME, 'case.md');
    require('node:fs').writeFileSync(file, '# Case\n');

    await (await api()).run({ type: 'openUrl', url: file });

    const preview = () =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .find((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'vscode.markdown.preview.editor' && tab.input.uri.fsPath.toLowerCase() === file.toLowerCase());

    await until(preview, 'case.md never opened in the Markdown preview');
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase() === file.toLowerCase(), false);
  });

  it('replaces the hub with one on the new folder when switchboard.configDir changes, and the window follows it', async () => {
    const extension = await api();
    const before = await until(() => record(), 'no hub is running');
    const moved = join(process.env.SWITCHBOARD_TEST_HOME, 'moved');
    const config = vscode.workspace.getConfiguration('switchboard');

    await config.update('configDir', moved, vscode.ConfigurationTarget.Global);
    try {
      const after = await until(() => {
        const now = record();

        return now && now.pid !== before.pid && now.configDir === moved ? now : null;
      }, 'the hub was not replaced on the new config folder');

      await until(() => extension.hub()?.pid === after.pid, 'the window did not reconnect to the new hub');
      await until(() => extension.state()?.configDir === moved, 'the window state does not name the new config folder');
    } finally {
      await config.update('configDir', '~/repo/switchboard', vscode.ConfigurationTarget.Global);
    }

    await until(() => record()?.configDir === configDir, 'the hub did not return to the configured folder');
  });
});
