const assert = require('node:assert');
const vscode = require('vscode');

/** A row's Open in terminal (PRD R28), run as the command the dock leaves for the item window. */
describe("a row's Open in terminal", () => {
  const realCreate = Object.getOwnPropertyDescriptor(vscode.window, 'createTerminal');
  const realTerminals = Object.getOwnPropertyDescriptor(vscode.window, 'terminals');
  const realExecute = vscode.commands.executeCommand;
  let listed;
  let created;
  let shown;
  let opened;
  let run;

  before(async () => {
    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();

    run = (command) => extension.run({ type: 'terminal', name: 'gh 7', cwd: 'D:/git/widgets-wt/7-fix', active: false, ...command });
    // Stand-ins, so no Claude process starts: each terminal records its options and stays listed until a step removes it.
    Object.defineProperty(vscode.window, 'createTerminal', {
      configurable: true,
      value: (options) => {
        const terminal = { options, exitStatus: undefined, show: () => shown.push(options.shellArgs) };

        created.push(terminal);
        listed.push(terminal);
        return terminal;
      },
    });
    Object.defineProperty(vscode.window, 'terminals', { configurable: true, get: () => listed });
    // Records Claude's open commands, so no Claude tab opens.
    vscode.commands.executeCommand = (command, ...args) => (command.startsWith('claude-vscode.') ? (opened.push(args[0]), Promise.resolve()) : realExecute.call(vscode.commands, command, ...args));
  });

  after(() => {
    vscode.commands.executeCommand = realExecute;
    for (const [name, descriptor] of [['createTerminal', realCreate], ['terminals', realTerminals]]) {
      if (descriptor === undefined) {
        delete vscode.window[name];
      } else {
        Object.defineProperty(vscode.window, name, descriptor);
      }
    }
  });

  beforeEach(() => {
    listed = [];
    created = [];
    shown = [];
    opened = [];
  });

  it('attaches to a background session by its short ID and resumes an ended one in its directory', async () => {
    await run({ sessionId: 'a-native', shortId: 'abcd0007' });
    await run({ sessionId: 'b-native', shortId: null });

    assert.deepStrictEqual(
      created.map((terminal) => terminal.options),
      [
        { name: 'Switchboard · gh 7', shellPath: 'claude', shellArgs: ['attach', 'abcd0007'], cwd: 'D:/git/widgets-wt/7-fix' },
        { name: 'Switchboard · gh 7', shellPath: 'claude', shellArgs: ['--resume', 'b-native'], cwd: 'D:/git/widgets-wt/7-fix' },
      ],
    );
    assert.deepStrictEqual(shown, [['attach', 'abcd0007'], ['--resume', 'b-native']]);
  });

  it('shows the terminal it opened for a session while it runs, and opens another after it exits or closes', async () => {
    await run({ sessionId: 'c-native', shortId: null });
    await run({ sessionId: 'c-native', shortId: null });
    assert.strictEqual(created.length, 1);

    created[0].exitStatus = { code: 0 };
    await run({ sessionId: 'c-native', shortId: null });
    assert.strictEqual(created.length, 2);

    listed = listed.filter((terminal) => terminal !== created[1]);
    await run({ sessionId: 'c-native', shortId: null });
    assert.strictEqual(created.length, 3);
    assert.strictEqual(shown.length, 4);
  });

  it('keeps an attach terminal apart from a resume of the same session', async () => {
    await run({ sessionId: 'd-native', shortId: 'abcd0008' });
    await run({ sessionId: 'd-native', shortId: null });

    assert.deepStrictEqual(created.map((terminal) => terminal.options.shellArgs), [['attach', 'abcd0008'], ['--resume', 'd-native']]);
  });

  it('shows its own terminal for a session the roster lists as active, and opens one active elsewhere in Claude instead of resuming it again', async () => {
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;

    await run({ sessionId: 'e-native', shortId: null, cwd: folder });
    await run({ sessionId: 'e-native', shortId: null, cwd: folder, active: true });
    assert.strictEqual(created.length, 1);
    assert.deepStrictEqual(opened, []);

    await run({ sessionId: 'f-native', shortId: null, cwd: folder, active: true });
    assert.strictEqual(created.length, 1);
    assert.deepStrictEqual(opened, ['f-native']);
  });

  it('resumes an ended Codex session with codex resume in its directory', async () => {
    await run({ sessionId: 'thread-9', shortId: null, provider: 'codex' });

    assert.deepStrictEqual(created.map((terminal) => terminal.options), [{ name: 'Switchboard · gh 7', shellPath: 'codex', shellArgs: ['resume', 'thread-9'], cwd: 'D:/git/widgets-wt/7-fix' }]);
  });
});