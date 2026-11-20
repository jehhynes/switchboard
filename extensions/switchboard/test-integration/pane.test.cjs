const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
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

/** A work item whose session ran in `cwd`, with a pull request link, in `status`. */
function item(cwd, status, patch = {}) {
  return {
    id: 7,
    ticketId: 7,
    parentId: null,
    playbook: 'dev:develop',
    status,
    stage: null,
    stageAt: null,
    taskPrompt: null,
    warning: null,
    error: null,
    unassignedAt: null,
    queuedAt: null,
    approvalPrompt: '/send-reply',
    approvalSummary: 'send the reply',
    approvalReport: null,
    approvalHeld: false,
    createdAt: 1_791_000_000_000,
    statusAt: 1_791_000_000_000,
    readyAt: status === 'awaiting-approval' ? 1_791_000_000_000 : null,
    orderAt: null,
    runStartedAt: 1_791_000_000_000,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    ticket: { id: 7, source: 'github', sourceKey: '7', ref: '#7', sourceId: null, adhocKey: null, title: 'Issue 7', url: 'https://github.com/o/r/issues/7', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 1_791_000_000_000, repoRoot: '', blockers: [] },
    triage: null,
    focus: 'https://github.com/o/r/issues/7',
    sessions: [
      {
        id: 's7', workItemId: 7, kind: 'task', provider: 'claude', nativeSessionId: 'native-7', shortId: null, cwd, state: 'idle', stateAt: 1_791_000_000_000,
        stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 1_791_000_000_000, endedAt: null, released: true, reports: [],
      },
    ],
    worktree: null,
    links: [{ id: 1, ticketId: 7, label: 'PR', target: 'https://github.com/o/r/pull/19002', reportedAt: 1_791_000_000_000, mentioned: false }],
    pastes: [],
    comments: [],
    waits: [],
    parent: null,
    returned: 0,
    approvalSends: false,
    playbookChoices: [],
    reopenable: false,
    moved: false,
    ...patch,
  };
}

/** Opens an `/events` stream for `file` on the window's hub and resolves its window key, so the window can claim as that item window. */
function bindTo(extension, file) {
  const record = extension.hub();

  return new Promise((done, fail) => {
    const outbound = require('node:http').request({ host: '127.0.0.1', port: record.port, path: `/events?workspace=${encodeURIComponent(file)}&focused=0`, headers: { Authorization: `Bearer ${record.token}` } }, (response) => {
      let text = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;

        const hello = /event: hello\ndata: (.*)\n/.exec(text);

        if (hello !== null) {
          done({ key: JSON.parse(hello[1]).window, close: () => outbound.destroy() });
        }
      });
    });

    outbound.on('error', fail);
    outbound.end();
  });
}

describe('the Switchboard pane (PRD R92)', () => {
  const realExecute = vscode.commands.executeCommand;
  const realWarning = vscode.window.showWarningMessage;
  const realInput = vscode.window.showInputBox;
  const windows = join(process.env.SWITCHBOARD_TEST_HOME, '.switchboard', 'windows');
  let extension;
  let hubState;
  let folder;
  let file;
  let ran;
  let warned;

  const show = (workItems) => extension.show(JSON.stringify({ ...hubState, workItems }));
  const shown = (view) => extension.pane()[view];

  before(async () => {
    extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    hubState = await until(() => extension.state(), 'the window never received the hub state');
    folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    // The window's name as the dock view gives it: the ticket key, the folder's name, and a hash of the folder (PRD R71).
    const hash = createHash('sha256').update(folder.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 6);

    file = join(windows, `gh-7-workspace-${hash}.code-workspace`);
    // Opening a link or report is recorded instead, so no browser tab or editor opens.
    vscode.commands.executeCommand = (command, ...args) =>
      ['workbench.action.browser.open', 'vscode.openWith'].includes(command) ? (ran.push([command, args[0]]), Promise.resolve()) : realExecute.call(vscode.commands, command, ...args);
    vscode.window.showWarningMessage = (...args) => (warned.push(args[0]), Promise.resolve(undefined));
  });

  beforeEach(() => {
    ran = [];
    warned = [];
  });

  after(async () => {
    vscode.commands.executeCommand = realExecute;
    vscode.window.showWarningMessage = realWarning;
    vscode.window.showInputBox = realInput;
    extension.itemWindow(null);
    extension.show(JSON.stringify(hubState));
  });

  it('shows in the Explorer and Source Control, with no work item and no count of other work in a window that is not an item window', async () => {
    await vscode.commands.executeCommand('switchboard.pane.focus');
    await until(() => shown('switchboard.pane'), 'the Explorer pane never rendered');
    await vscode.commands.executeCommand('switchboard.paneScm.focus');
    await until(() => shown('switchboard.paneScm'), 'the Source Control pane never rendered');

    // A window's state holds its own work item only, so the hub counts the others without naming them (architecture.md § Window scope).
    extension.show(JSON.stringify({ ...hubState, workItems: [item(folder, 'awaiting-approval')], needsCount: 3 }));

    for (const view of ['switchboard.pane', 'switchboard.paneScm']) {
      assert.deepStrictEqual(shown(view), { items: [], voice: null });
    }
  });

  it("shows the item window's pills, report and Approve, and opens links and the report in VS Code", async () => {
    const report = join(mkdtempSync(join(tmpdir(), 'switchboard-pane-')), 'reply.md');

    writeFileSync(report, '# Reply\n');
    extension.itemWindow(file);
    show([item(folder, 'awaiting-approval', { approvalReport: report })]);

    const model = shown('switchboard.paneScm');

    assert.strictEqual(model.items.length, 1);
    assert.deepStrictEqual(model.items[0].links.map((link) => [link.text, link.url]), [
      ['gh 7', 'https://github.com/o/r/issues/7'],
      ['19002', 'https://github.com/o/r/pull/19002'],
    ]);
    assert.strictEqual(model.items[0].report, report);
    assert.strictEqual(model.items[0].main.title, 'Approve: runs /send-reply');
    assert.deepStrictEqual(shown('switchboard.pane'), model);

    await extension.paneClick({ type: 'open', target: 'https://github.com/o/r/pull/19002' });
    await extension.paneClick({ type: 'open', target: report });
    assert.deepStrictEqual(ran.map(([command, arg]) => [command, command === 'vscode.openWith' ? arg.fsPath : arg.url]), [
      ['workbench.action.browser.open', 'https://github.com/o/r/pull/19002'],
      ['vscode.openWith', vscode.Uri.file(report).fsPath],
    ]);
  });

  it("posts the main control's action to the hub and shows its refusal", async () => {
    extension.itemWindow(file);
    show([item(folder, 'awaiting-approval')]);

    await extension.paneClick({ type: 'main', key: shown('switchboard.pane').items[0].key });

    // The hub has no work item 7, so it refuses the Approve it received for it.
    assert.deepStrictEqual(warned, ['Switchboard: Unknown work item 7.']);
  });

  it('asks for the text a main control needs, and posts nothing when the operator cancels', async () => {
    const asked = [];
    let answer;

    vscode.window.showInputBox = (options) => (asked.push(options), Promise.resolve(answer));
    after(() => (vscode.window.showInputBox = realInput));
    extension.itemWindow(file);
    show([item(folder, 'unstarted', { playbook: null, taskPrompt: 'Fix the badge' })]);

    const key = shown('switchboard.pane').items[0].key;

    assert.strictEqual(shown('switchboard.pane').items[0].main.label, 'Start with prompt…');

    answer = undefined;
    await extension.paneClick({ type: 'main', key });
    assert.strictEqual(asked[0].value, 'Fix the badge');
    // A blank prompt is refused in the box, as in the dock.
    assert.strictEqual(asked[0].validateInput('  '), 'Start needs a text.');
    assert.strictEqual(asked[0].validateInput('Fix it'), null);
    assert.deepStrictEqual(warned, []);

    answer = 'Fix the badge and its test';
    await extension.paneClick({ type: 'main', key });
    assert.deepStrictEqual(warned, ['Switchboard: Unknown work item 7.'], 'the hub never received the Start');
  });

  it("opens Open in terminal in this window with the agent's CLI from the hub's sessions.claudePath", async () => {
    const settingsFile = join(process.env.SWITCHBOARD_TEST_HOME, 'repo', 'switchboard', 'settings.json');
    const saved = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null;
    const realCreate = Object.getOwnPropertyDescriptor(vscode.window, 'createTerminal');
    const created = [];
    const waiting = { ...item(folder, 'running').sessions[0], state: 'waiting', stateDetail: 'permission-prompt', shortId: 'ab12', released: false };

    // A stand-in, so no Claude process starts.
    Object.defineProperty(vscode.window, 'createTerminal', { configurable: true, value: (options) => (created.push(options), { options, exitStatus: undefined, show: () => {} }) });
    // The hub reads settings.json again when it changes.
    writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(saved ?? '{}'), sessions: { ...JSON.parse(saved ?? '{}').sessions, claudePath: '/opt/pane-test/claude' } }));

    const cleanups = [];

    try {
      extension.itemWindow(file);
      show([item(folder, 'running', { sessions: [waiting] })]);
      assert.strictEqual(shown('switchboard.pane').items[0].main.label, 'Open in terminal');

      const key = shown('switchboard.pane').items[0].key;
      // The terminal command is left for the item window, which only a window whose key binds its file claims.
      const bound = await bindTo(extension, file);
      const ownKey = extension.windowKey();

      extension.useWindowKey(bound.key);
      cleanups.push(() => (extension.useWindowKey(ownKey), bound.close()));

      await until(async () => {
        created.length = 0;
        // The reload sends the hub's own state, which has no work item 7.
        show([item(folder, 'running', { sessions: [waiting] })]);
        await extension.paneClick({ type: 'main', key });
        return created.some((options) => options.shellPath === '/opt/pane-test/claude');
      }, 'the terminal never ran the configured CLI', 10_000);
      assert.deepStrictEqual(created.map(({ name, shellArgs, cwd }) => ({ name, shellArgs, cwd })), [{ name: 'Switchboard · gh 7', shellArgs: ['attach', 'ab12'], cwd: folder }]);
    } finally {
      cleanups.forEach((cleanup) => cleanup());
      Object.defineProperty(vscode.window, 'createTerminal', realCreate);
      if (saved === null) {
        rmSync(settingsFile, { force: true });
      } else {
        writeFileSync(settingsFile, saved);
      }
    }
  });

  it("opens a Code Mode session waiting on a question in its attach terminal, with the hub's sessions.nodePath and hub.js, where Open in Claude would be (PRD R95)", async () => {
    const settingsFile = join(process.env.SWITCHBOARD_TEST_HOME, 'repo', 'switchboard', 'settings.json');
    const saved = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null;
    const realCreate = Object.getOwnPropertyDescriptor(vscode.window, 'createTerminal');
    const created = [];
    const question = { ...item(folder, 'running').sessions[0], state: 'waiting', stateDetail: 'Which branch?', shortId: 'ab12', released: false };
    const held = { ...question, codeMode: true };
    const hubJs = join(process.env.SWITCHBOARD_TEST_HOME, '.switchboard', 'hub.js');

    Object.defineProperty(vscode.window, 'createTerminal', { configurable: true, value: (options) => (created.push(options), { options, exitStatus: undefined, show: () => {} }) });
    writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(saved ?? '{}'), sessions: { ...JSON.parse(saved ?? '{}').sessions, nodePath: '/opt/pane-test/node' } }));

    const cleanups = [];

    try {
      extension.itemWindow(file);
      show([item(folder, 'running', { sessions: [question] })]);
      assert.strictEqual(shown('switchboard.pane').items[0].main.label, 'Open in Claude');

      show([item(folder, 'running', { sessions: [held] })]);
      assert.strictEqual(shown('switchboard.pane').items[0].main.label, 'Open in terminal');
      assert.strictEqual(shown('switchboard.pane').items[0].main.title, 'Open in terminal: attaches to the Code Mode session');

      const key = shown('switchboard.pane').items[0].key;
      // The terminal command is left for the item window, which only a window whose key binds its file claims.
      const bound = await bindTo(extension, file);
      const ownKey = extension.windowKey();

      extension.useWindowKey(bound.key);
      cleanups.push(() => (extension.useWindowKey(ownKey), bound.close()));

      await until(async () => {
        created.length = 0;
        show([item(folder, 'running', { sessions: [held] })]);
        await extension.paneClick({ type: 'main', key });
        return created.some((options) => options.shellPath === '/opt/pane-test/node');
      }, 'the terminal never ran the configured Node.js', 10_000);
      assert.deepStrictEqual(created.map(({ name, shellArgs, cwd }) => ({ name, shellArgs, cwd })), [{ name: 'Switchboard · gh 7', shellArgs: [hubJs, 'attach', 's7'], cwd: folder }]);
      // No Open in Claude stop reached the hub, which would refuse it for work item 7.
      assert.deepStrictEqual(warned, []);
    } finally {
      cleanups.forEach((cleanup) => cleanup());
      Object.defineProperty(vscode.window, 'createTerminal', realCreate);
      if (saved === null) {
        rmSync(settingsFile, { force: true });
      } else {
        writeFileSync(settingsFile, saved);
      }
    }
  });

  it('runs nothing for a row that has left the window', async () => {
    extension.itemWindow(file);
    show([item(folder, 'awaiting-approval')]);

    const key = shown('switchboard.pane').items[0].key;

    show([]);
    await extension.paneClick({ type: 'main', key });
    assert.deepStrictEqual(warned, []);
  });
});
