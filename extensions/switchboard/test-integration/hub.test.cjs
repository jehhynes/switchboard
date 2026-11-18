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

  it('claims a session left for this folder once, and opens it in the Claude tab', async () => {
    const extension = await api();
    await until(() => extension.hub(), 'not connected');

    // The test host has no Claude extension; this stand-in records the session each call opens.
    const opened = [];
    const fake = vscode.commands.registerCommand('claude-vscode.primaryEditor.open', (sessionId) => opened.push(sessionId));

    try {
      const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;

      // Another window's Open leaves a pending open for this folder; this window claims it.
      const hub = extension.hub();
      const recorded = await call(hub.port, '/open', hub.token, 'POST', { sessionId: 'there-native', cwd: folder });

      assert.strictEqual(recorded.status, 200);
      assert.strictEqual(await vscode.commands.executeCommand('switchboard.claim'), 'there-native');
      assert.strictEqual(await vscode.commands.executeCommand('switchboard.claim'), null);
      assert.deepStrictEqual(opened, ['there-native']);
    } finally {
      fake.dispose();
    }
  });

  it('opens a session in the Claude sidebar when claudeCode.preferredLocation is sidebar', async () => {
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

    try {
      mkdirSync(dirname(settings), { recursive: true });
      writeFileSync(settings, JSON.stringify({ 'claudeCode.preferredLocation': 'sidebar' }));
      await until(() => vscode.workspace.getConfiguration('claudeCode').get('preferredLocation') === 'sidebar', 'setting not read');

      const hub = extension.hub();
      await call(hub.port, '/open', hub.token, 'POST', { sessionId: 'claimed-native', cwd: folder });
      assert.strictEqual(await vscode.commands.executeCommand('switchboard.claim'), 'claimed-native');

      const honor = [undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' }];
      assert.deepStrictEqual(sidebar, [['claimed-native', ...honor]]);
      assert.deepStrictEqual(tabs, []);
    } finally {
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

// After the hub process tests, which expect a store with no work items. The decisions are tested in test/toast.test.ts.
describe("the notification of work on the operator's turn (PRD R65)", () => {
  // An ad-hoc prompt for a folder that does not exist fails at spawn, so no Claude process starts and the item enters Blocked on you.
  const missingRepo = join(process.env.SWITCHBOARD_TEST_HOME, 'no-such-repo');
  const originalMessage = vscode.window.showInformationMessage;
  const originalState = Object.getOwnPropertyDescriptor(vscode.window, 'state');
  const created = [];
  let extension;
  let focused = true;
  let shown = [];

  /** Sends an ad-hoc prompt that fails to start, and waits until this window's state shows it failed. */
  async function failAdhoc(title) {
    const hub = extension.hub();

    assert.strictEqual((await call(hub.port, '/action', hub.token, 'POST', { type: 'adhoc', prompt: title, repoRoot: missingRepo, start: true })).status, 200);

    const item = await until(() => extension.state()?.workItems.find((entry) => entry.ticket.title === title && entry.status === 'failed'), `${title} never reached the window as failed`);

    created.push(item.id);
  }

  before(async () => {
    extension = await api();
    await until(() => extension.hub() && extension.state(), 'the extension never received the hub state');
    vscode.window.showInformationMessage = (...args) => (shown.push(args), Promise.resolve(undefined));
    Object.defineProperty(vscode.window, 'state', { configurable: true, get: () => ({ focused, active: focused }) });
  });

  after(async () => {
    vscode.window.showInformationMessage = originalMessage;
    Object.defineProperty(vscode.window, 'state', originalState);
    await vscode.workspace.getConfiguration('switchboard').update('notifyNeedsYou', undefined, vscode.ConfigurationTarget.Global);

    const hub = extension.hub();

    for (const id of created) {
      await call(hub.port, '/action', hub.token, 'POST', { type: 'mark-done', workItemId: id });
    }
  });

  beforeEach(() => {
    shown = [];
    focused = true;
  });

  it('shows nothing in a window that is not focused', async () => {
    focused = false;
    await failAdhoc('Toast while unfocused');

    assert.deepStrictEqual(shown, []);
  });

  it('shows one toast naming the ticket and the mark in the focused window', async () => {
    await failAdhoc('Toast check');

    // A failed ad-hoc start has a session in its repo, so Open brings that item window forward.
    assert.deepStrictEqual(shown, [['Switchboard: Toast check — Failed', 'Open']]);
  });

  it('shows nothing when switchboard.notifyNeedsYou is off', async () => {
    await vscode.workspace.getConfiguration('switchboard').update('notifyNeedsYou', false, vscode.ConfigurationTarget.Global);
    await failAdhoc('Toast while off');

    assert.deepStrictEqual(shown, []);
  });
});
