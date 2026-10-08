const assert = require('node:assert');
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
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

  it('sends its state to the panel and refuses an action that does not apply', async () => {
    const extension = await api();
    const state = await until(() => extension.state(), 'the panel never received the hub state');

    assert.deepStrictEqual(state.workItems, []);
    assert.deepStrictEqual(state.errors, { settings: null, playbooks: [], hooks: null, sources: {} });

    await vscode.commands.executeCommand('switchboard.workItems.focus');

    const hub = await until(() => extension.hub(), 'not connected');
    const refused = await call(hub.port, '/action', hub.token, 'POST', { type: 'approve', workItemId: 1 });

    assert.strictEqual(refused.status, 409);
    assert.strictEqual(JSON.parse(refused.body).error, 'Unknown work item 1.');
  });

  it('routes panel commands: actions to the hub, and Open of a session in this folder to the Claude tab', async () => {
    const extension = await api();
    await until(() => extension.hub(), 'not connected');

    const reply = await vscode.commands.executeCommand('switchboard.action', { type: 'retry', workItemId: 5 });

    assert.deepStrictEqual([reply.status, reply.error], [409, 'Unknown work item 5.']);

    // The test host has no Claude extension; this stand-in records the session each call opens.
    const opened = [];
    const fake = vscode.commands.registerCommand('claude-vscode.primaryEditor.open', (sessionId) => opened.push(sessionId));

    try {
      const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;

      assert.strictEqual(await vscode.commands.executeCommand('switchboard.open', 'here-native', folder), 'opened');

      // Another window's Open leaves a pending open for this folder; this window claims it.
      const hub = extension.hub();
      const recorded = await call(hub.port, '/open', hub.token, 'POST', { sessionId: 'there-native', cwd: folder });

      assert.strictEqual(recorded.status, 200);
      assert.strictEqual(await vscode.commands.executeCommand('switchboard.claim'), 'there-native');
      assert.strictEqual(await vscode.commands.executeCommand('switchboard.claim'), null);
      assert.deepStrictEqual(opened, ['here-native', 'there-native']);
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

      assert.strictEqual(await vscode.commands.executeCommand('switchboard.open', 'side-native', folder), 'opened');

      const hub = extension.hub();
      await call(hub.port, '/open', hub.token, 'POST', { sessionId: 'claimed-native', cwd: folder });
      assert.strictEqual(await vscode.commands.executeCommand('switchboard.claim'), 'claimed-native');

      const honor = [undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' }];
      assert.deepStrictEqual(sidebar, [['side-native', ...honor], ['claimed-native', ...honor]]);
      assert.deepStrictEqual(tabs, []);
    } finally {
      rmSync(dirname(settings), { recursive: true, force: true });
      await until(() => vscode.workspace.getConfiguration('claudeCode').get('preferredLocation') === undefined, 'setting not cleared');
      fakes.forEach((fake) => fake.dispose());
    }
  });

  it('puts New Ad-hoc Session, Open Settings and an on or off toggle per source in the title bar, and refuses to toggle an unknown source', async () => {
    await api();
    const commands = await vscode.commands.getCommands(true);
    const menu = vscode.extensions.getExtension('switchboard.switchboard').packageJSON.contributes.menus['view/title'];
    const shown = (command) => menu.find((entry) => entry.command === command)?.when;

    assert.strictEqual(shown('switchboard.newAdhoc'), 'view == switchboard.workItems');
    assert.strictEqual(shown('switchboard.openSettings'), 'view == switchboard.workItems');
    assert.deepStrictEqual(
      menu.map((entry) => [entry.command, entry.group]).slice(-4),
      [
        ['switchboard.separator', 'navigation@8'],
        ['switchboard.goTo', 'navigation@9'],
        ['switchboard.newAdhoc', 'navigation@10'],
        ['switchboard.openSettings', 'navigation@11'],
      ],
      'the separator sits before Go to Work Item, New Ad-hoc Session and Open Settings',
    );
    for (const name of ['github', 'zoho', 'forum']) {
      for (const state of ['on', 'off']) {
        assert.ok(commands.includes(`switchboard.source.${name}.${state}`), `switchboard.source.${name}.${state} is not registered`);
        assert.strictEqual(shown(`switchboard.source.${name}.${state}`), `view == switchboard.workItems && switchboard.source.${name} == ${state}`);
      }
    }
    assert.ok(!commands.includes('switchboard.chooseSources'));

    const reply = await vscode.commands.executeCommand('switchboard.setSource', 'nosuch', true);
    assert.strictEqual(reply.status, 409);
  });

  it('shows each row command in the row right-click menu only when the row sets its key, and sends the row action', async () => {
    await api();
    const commands = await vscode.commands.getCommands(true);
    const menu = vscode.extensions.getExtension('switchboard.switchboard').packageJSON.contributes.menus['webview/context'];

    assert.strictEqual(menu.length, 12);
    for (const entry of menu) {
      assert.ok(commands.includes(entry.command), `${entry.command} is not registered`);
      assert.strictEqual(entry.when, `webviewId == 'switchboard.workItems' && webviewSection == 'row' && ${entry.command}`);
    }

    // Each command sends the action under its own key in the row's context.
    const actions = { markDone: { type: 'mark-done', workItemId: 41 }, retry: { type: 'retry', workItemId: 42 } };
    const markDone = await vscode.commands.executeCommand('switchboard.row.markDone', { actions });
    const retry = await vscode.commands.executeCommand('switchboard.row.retry', { actions });

    assert.deepStrictEqual([markDone.status, markDone.error], [409, 'Unknown work item 41.']);
    assert.deepStrictEqual([retry.status, retry.error], [409, 'Unknown work item 42.']);
  });

  it('asks how long to snooze before sending the action, and sends nothing when the pick is dismissed (PRD R49)', async () => {
    await api();
    const actions = { snooze: { type: 'snooze', ticketId: 43 } };
    // Either entry point reaches the picker: the row's menu command and the panel's action command.
    for (const run of [() => vscode.commands.executeCommand('switchboard.row.snooze', { actions }), () => vscode.commands.executeCommand('switchboard.action', actions.snooze)]) {
      let reply = 'pending';
      const picking = run().then((answer) => (reply = answer));

      // The quick pick is open once accepting its selected item settles the command; the first item is Tomorrow.
      await until(async () => {
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        await new Promise((done) => setTimeout(done, 100));
        return reply !== 'pending';
      }, 'the snooze pick never settled');
      await picking;
      assert.deepStrictEqual([reply.status, reply.error], [409, 'Unknown ticket 43.'], 'a chosen wake time reaches the hub, which refuses the unknown ticket');
    }

    let reply = 'pending';
    const dismissed = vscode.commands.executeCommand('switchboard.row.snooze', { actions }).then((answer) => (reply = answer));

    await until(async () => {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await new Promise((done) => setTimeout(done, 100));
      return reply !== 'pending';
    }, 'the dismissed snooze pick never settled');
    await dismissed;
    assert.strictEqual(reply, null, 'a dismissed pick sends no action');
  });

  it('opens Go to Work Item from the title bar or the Command Palette as a quick pick, and resolves to null when dismissed (PRD R63)', async () => {
    await api();
    const contributes = vscode.extensions.getExtension('switchboard.switchboard').packageJSON.contributes;
    const command = contributes.commands.find((entry) => entry.command === 'switchboard.goTo');

    assert.deepStrictEqual([command.title, command.icon], ['Go to Work Item…', '$(search)']);
    assert.ok(!contributes.menus.commandPalette.some((entry) => entry.command === 'switchboard.goTo'), 'a commandPalette entry hides Go to Work Item');
    assert.ok((await vscode.commands.getCommands(true)).includes('switchboard.goTo'));

    let reply = 'pending';
    const picking = vscode.commands.executeCommand('switchboard.goTo').then((answer) => (reply = answer));

    // The quick pick is open once closing it settles the command.
    await until(async () => {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await new Promise((done) => setTimeout(done, 100));
      return reply !== 'pending';
    }, 'the Go to Work Item pick never settled');
    await picking;
    assert.strictEqual(reply, null);
  });

  it('turns a source off with its on toggle and on with its off toggle, in settings.json', async () => {
    await api();
    const settings = join(configDir, 'settings.json');
    const fs = require('node:fs');
    const enabled = () => JSON.parse(fs.readFileSync(settings, 'utf8')).sources.github.enabled;

    // The unknown key makes the settings invalid, so the hub keeps its defaults and never polls GitHub.
    fs.writeFileSync(settings, JSON.stringify({ unknownKey: true, sources: { github: { enabled: false } } }));
    try {
      assert.strictEqual((await vscode.commands.executeCommand('switchboard.source.github.off')).status, 200);
      assert.strictEqual(enabled(), true);
      assert.strictEqual((await vscode.commands.executeCommand('switchboard.source.github.on')).status, 200);
      assert.strictEqual(enabled(), false);
    } finally {
      fs.rmSync(settings, { force: true });
    }
  });

  it('opens the settings editor in one tab', async () => {
    await api();
    const settingsTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('switchboard.settings'));

    await vscode.commands.executeCommand('switchboard.openSettings');
    await until(() => settingsTabs().length === 1, 'the settings editor did not open');
    await vscode.commands.executeCommand('switchboard.openSettings');
    await new Promise((done) => setTimeout(done, 500));

    assert.strictEqual(settingsTabs().length, 1);
    assert.strictEqual(settingsTabs()[0].label, 'Switchboard Settings');
    await vscode.window.tabGroups.close(settingsTabs());
  });

  it('resumes a session in a terminal, shows that terminal again while it runs, and opens a session active elsewhere in its Claude tab', async () => {
    await api();
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const realCreate = Object.getOwnPropertyDescriptor(vscode.window, 'createTerminal');
    const realTerminals = Object.getOwnPropertyDescriptor(vscode.window, 'terminals');
    // Stand-ins, so no Claude process starts: each terminal records its options and stays listed until a step removes it.
    let listed = [];
    const created = [];
    const shown = [];
    const opened = [];
    const fake = vscode.commands.registerCommand('claude-vscode.primaryEditor.open', (sessionId) => opened.push(sessionId));
    const resume = (sessionId, name, active) => vscode.commands.executeCommand('switchboard.resume', sessionId, folder, name, active);

    try {
      Object.defineProperty(vscode.window, 'createTerminal', {
        configurable: true,
        value: (options) => {
          const terminal = { options, exitStatus: undefined, show: () => shown.push(options.shellArgs[1]) };
          created.push(terminal);
          listed.push(terminal);
          return terminal;
        },
      });
      Object.defineProperty(vscode.window, 'terminals', { configurable: true, get: () => listed });

      await resume('a-native', 'github 1', false);
      await resume('a-native', 'github 1', false);
      // This window's open terminal is shown again even when the roster sees the session as active.
      await resume('a-native', 'github 1', true);
      assert.deepStrictEqual(created.map((terminal) => terminal.options), [{ name: 'Switchboard · github 1', shellPath: 'claude', shellArgs: ['--resume', 'a-native'], cwd: folder }]);

      // A terminal whose process exited, or that was closed, is not reused.
      created[0].exitStatus = { code: 0 };
      await resume('a-native', 'github 1', false);
      listed = listed.filter((terminal) => terminal !== created[1]);
      await resume('a-native', 'github 1', false);
      assert.strictEqual(created.length, 3);

      await resume('b-native', 'github 2', true);
      assert.deepStrictEqual(shown, ['a-native', 'a-native', 'a-native', 'a-native', 'a-native']);
      assert.deepStrictEqual(opened, ['b-native']);
    } finally {
      for (const [name, descriptor] of [['createTerminal', realCreate], ['terminals', realTerminals]]) {
        if (descriptor === undefined) {
          delete vscode.window[name];
        } else {
          Object.defineProperty(vscode.window, name, descriptor);
        }
      }
      fake.dispose();
    }
  });

  it("opens an approval's report file in an editor", async () => {
    await api();
    const file = join(process.env.SWITCHBOARD_TEST_HOME, 'case.md');
    require('node:fs').writeFileSync(file, '# Case\n');

    await vscode.commands.executeCommand('switchboard.openLink', file);

    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase(), file.toLowerCase());
  });

  it('replaces the hub with one on the new folder when switchboard.configDir changes, the panel follows it, and the settings editor closes', async () => {
    const extension = await api();
    const before = await until(() => record(), 'no hub is running');
    const moved = join(process.env.SWITCHBOARD_TEST_HOME, 'moved');
    const config = vscode.workspace.getConfiguration('switchboard');
    const settingsTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('switchboard.settings'));

    await vscode.commands.executeCommand('switchboard.openSettings');
    await until(() => settingsTabs().length === 1, 'the settings editor did not open');
    await config.update('configDir', moved, vscode.ConfigurationTarget.Global);
    try {
      // Its drafts belong to the old folder, so the settings editor closes rather than saving them into the new one.
      await until(() => settingsTabs().length === 0, 'the settings editor stayed open on the old folder');
      const after = await until(() => {
        const now = record();

        return now && now.pid !== before.pid && now.configDir === moved ? now : null;
      }, 'the hub was not replaced on the new config folder');

      await until(() => extension.hub()?.pid === after.pid, 'the window did not reconnect to the new hub');
      await until(() => extension.state()?.configDir === moved, 'the panel state does not name the new config folder');
    } finally {
      await config.update('configDir', '~/repo/switchboard', vscode.ConfigurationTarget.Global);
    }

    await until(() => record()?.configDir === configDir, 'the hub did not return to the configured folder');
  });
});

// After the hub process tests, which expect a store with no work items. The decisions are tested in test/toast.test.ts.
describe('the Needs you toast (PRD R65)', () => {
  // An ad-hoc prompt for a folder that does not exist fails at spawn, so no Claude process starts and the item enters Needs you.
  const missingRepo = join(process.env.SWITCHBOARD_TEST_HOME, 'no-such-repo');
  const originalMessage = vscode.window.showInformationMessage;
  const originalState = Object.getOwnPropertyDescriptor(vscode.window, 'state');
  const created = [];
  let extension;
  let focused = true;
  let shown = [];

  /** Sends an ad-hoc prompt that fails to start, and waits until this window's panel shows it failed. */
  async function failAdhoc(title) {
    const hub = extension.hub();

    assert.strictEqual((await call(hub.port, '/action', hub.token, 'POST', { type: 'adhoc', prompt: title, repoRoot: missingRepo })).status, 200);

    const item = await until(() => extension.state()?.workItems.find((entry) => entry.ticket.title === title && entry.status === 'failed'), `${title} never reached the panel as failed`);

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

    // A failed ad-hoc start has no session or URL to open, so the toast has no Open button.
    assert.deepStrictEqual(shown, [['Switchboard: Toast check — Failed']]);
  });

  it('shows nothing when switchboard.notifyNeedsYou is off', async () => {
    await vscode.workspace.getConfiguration('switchboard').update('notifyNeedsYou', false, vscode.ConfigurationTarget.Global);
    await failAdhoc('Toast while off');

    assert.deepStrictEqual(shown, []);
  });
});
