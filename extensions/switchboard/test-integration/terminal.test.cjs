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

  describe('for a Code Mode session (PRD R95)', () => {
    const node = 'C:/Program Files/nodejs/node.exe';
    const attach = (sessionId, command = {}) => run({ sessionId, shortId: 'abcd0010', codeMode: true, provider: 'claude', executable: node, args: ['C:/Users/me/.switchboard/hub.js', 'attach', sessionId], ...command });

    it('runs the attach command as the executable and its arguments, named by the ticket key, and never opens the Claude view', async () => {
      const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;

      await attach('cm-1', { cwd: folder, active: true });

      assert.deepStrictEqual(
        created.map(({ options }) => ({ name: options.name, shellPath: options.shellPath, shellArgs: options.shellArgs, cwd: options.cwd })),
        [{ name: 'Switchboard · gh 7', shellPath: node, shellArgs: ['C:/Users/me/.switchboard/hub.js', 'attach', 'cm-1'], cwd: folder }],
      );
      assert.deepStrictEqual(shown, [['C:/Users/me/.switchboard/hub.js', 'attach', 'cm-1']]);
      assert.deepStrictEqual(opened, []);
    });

    it('shows its retained attach terminal after the Claude ID changes or the session ends, and opens another once the client exits or closes', async () => {
      await attach('cm-2');
      // `/clear` gives the session a new short ID; an ended session's client keeps running, offering Enter to resume it.
      await attach('cm-2', { shortId: 'abcd0011' });
      await attach('cm-2', { shortId: null });
      assert.strictEqual(created.length, 1);
      assert.strictEqual(shown.length, 3);

      created[0].exitStatus = { code: 0 };
      await attach('cm-2');
      assert.strictEqual(created.length, 2);

      listed = listed.filter((terminal) => terminal !== created[1]);
      await attach('cm-2');
      assert.strictEqual(created.length, 3);
    });

    it('keeps it apart from a background attach of another session and from its own resume command', async () => {
      await attach('cm-3');
      await run({ sessionId: 'cm-3', shortId: 'abcd0012' });
      await run({ sessionId: 'cm-3', shortId: null });

      assert.deepStrictEqual(created.map((terminal) => terminal.options.shellArgs), [['C:/Users/me/.switchboard/hub.js', 'attach', 'cm-3'], ['attach', 'abcd0012'], ['--resume', 'cm-3']]);
    });

    it('refuses a command without the attach command, opening nothing', async () => {
      await assert.rejects(attach('cm-6', { executable: undefined }), /The hub sent no attach command for Code Mode session cm-6\./);
      await assert.rejects(attach('cm-6', { args: undefined }), /The hub sent no attach command for Code Mode session cm-6\./);
      assert.deepStrictEqual([created.length, opened.length], [0, 0]);
    });
  });

  it("runs the agent's CLI the hub names from sessions.claudePath or sessions.codexPath, and the bare name for an empty one", async () => {
    await run({ sessionId: 'g-native', shortId: null, executable: '/opt/claude/bin/claude' });
    await run({ sessionId: 'thread-10', shortId: null, provider: 'codex', executable: '/home/me/.nvm/versions/node/v24/bin/codex' });
    await run({ sessionId: 'h-native', shortId: null, executable: '' });

    assert.deepStrictEqual(
      created.map((terminal) => terminal.options.shellPath),
      ['/opt/claude/bin/claude', '/home/me/.nvm/versions/node/v24/bin/codex', 'claude'],
    );
    // npm's launcher finds the node an nvm install keeps beside it; a bare name changes no environment.
    const pathOf = (env) => env[Object.keys(env).find((name) => name.toUpperCase() === 'PATH')];
    assert.strictEqual(pathOf(created[1].options.env).split(require('node:path').delimiter)[0], '/home/me/.nvm/versions/node/v24/bin');
    assert.strictEqual(created[2].options.env, undefined);
  });
});