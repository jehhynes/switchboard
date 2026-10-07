const assert = require('node:assert');
const { join } = require('node:path');
const vscode = require('vscode');

/**
 * A row's History (PRD R59): the command reads the hub's /history and opens a read-only Markdown document. The rows are written
 * straight into the test hub's store, done and long ago, so the hub neither shows nor acts on them. historyMarkdown's text is
 * tested in test/history.test.ts.
 */
describe('a row\'s History', () => {
  const TICKET = 9001;
  let db;
  let warned = [];
  const original = vscode.window.showWarningMessage;

  const history = (ticketId) => vscode.commands.executeCommand('switchboard.row.history', { actions: { history: { type: 'history', ticketId, key: 'gh 77' } } });

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

  before(async function () {
    this.timeout(60_000);
    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();

    await until(() => extension.hub(), 'the extension never connected to the hub');

    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

    db = new DatabaseSync(join(process.env.SWITCHBOARD_TEST_HOME, '.switchboard', 'switchboard.db'));
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`INSERT INTO tickets (id, source, sourceKey, ref, title, url, assigned, repoRoot) VALUES (${TICKET}, 'github', '77', '#77', 'Inbox badge', 'https://github.com/o/r/issues/77', 0, '')`);
    db.exec(`INSERT INTO workItems (id, ticketId, playbook, status, createdAt, statusAt, doneAt, doneReason) VALUES (${TICKET}, ${TICKET}, 'dev:review-pr', 'done', 1000, 2000, 2000, 'session')`);
    db.exec(`INSERT INTO sessions (id, workItemId, kind, provider, cwd, state, stateAt, outcome, startedAt, endedAt, released) VALUES ('hist-1', ${TICKET}, 'task', 'claude', 'C:/r', 'ended', 1500, 'done', 1100, 1500, 1)`);
    vscode.window.showWarningMessage = (message) => (warned.push(message), Promise.resolve(undefined));
  });

  after(async () => {
    vscode.window.showWarningMessage = original;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    if (db !== undefined) {
      db.exec(`DELETE FROM sessions WHERE workItemId >= ${TICKET}; DELETE FROM triages WHERE ticketId >= ${TICKET}; DELETE FROM workItems WHERE ticketId >= ${TICKET}; DELETE FROM tickets WHERE id >= ${TICKET}`);
      db.close();
    }
  });

  beforeEach(() => {
    warned = [];
  });

  it('opens the ticket\'s history as a read-only Markdown document, and shows the current history when opened again', async function () {
    this.timeout(30_000);

    const editor = await history(TICKET);

    assert.deepStrictEqual(warned, []);
    assert.strictEqual(vscode.window.activeTextEditor?.document, editor.document);
    assert.strictEqual(editor.document.uri.scheme, 'switchboard-history');
    assert.strictEqual(editor.document.languageId, 'markdown');
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'gh 77 History.md');
    assert.match(editor.document.getText(), /^# gh 77 Inbox badge\n/);
    assert.match(editor.document.getText(), /\n## dev:review-pr · done, finished by the session\n/);
    assert.match(editor.document.getText(), /\n- task, .+: done\n/);

    db.exec(`INSERT INTO triages (ticketId, workItemId, playbook, startedAt, endedAt, error) VALUES (${TICKET}, NULL, NULL, 3000, 3001, 'Classifier timed out.')`);

    const again = await history(TICKET);

    assert.strictEqual(again.document, editor.document, 'a second open reuses the ticket\'s document');
    await until(() => again.document.getText().includes(': failed, Classifier timed out.'), 'the document did not show the new triage');

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.label === 'gh 77 History.md');

    assert.strictEqual(tabs.length, 1);
  });

  it('reads a restored document from the hub, and again once the window reconnects when the first read failed', async function () {
    this.timeout(90_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const before = extension.hub();
    const restored = vscode.Uri.from({ scheme: 'switchboard-history', path: '/gh 77 restored History.md', query: String(TICKET) });

    // No hub answers between the shutdown and the restart, as for a tab VS Code restores before the window connects.
    await new Promise((done) => {
      const outbound = require('node:http').request({ host: '127.0.0.1', port: before.port, method: 'POST', path: '/shutdown', headers: { Authorization: `Bearer ${before.token}` } }, (response) => {
        response.resume();
        response.on('end', done);
      });

      outbound.on('error', done);
      outbound.end();
    });
    const refused = () =>
      new Promise((done) => {
        const probe = require('node:http').get({ host: '127.0.0.1', port: before.port, path: '/hub' }, (response) => (response.resume(), done(false)));

        probe.on('error', () => done(true));
      });

    await until(refused, 'the hub kept listening after its shutdown');

    const { document } = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(restored));

    assert.match(document.getText(), /^Switchboard: /);
    await until(() => extension.hub() !== null && extension.hub().pid !== before.pid, 'the window did not reconnect to a new hub', 60_000);
    await until(() => document.getText().startsWith('# gh 77 Inbox badge\n'), `the restored document was not read again: ${document.getText()}`);
  });

  it('warns, and opens nothing, for a ticket the hub does not know', async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    assert.strictEqual(await history(TICKET + 1), null);
    assert.deepStrictEqual(warned, [`Switchboard: Unknown ticket ${TICKET + 1}.`]);
    assert.strictEqual(vscode.window.activeTextEditor, undefined);
  });
});
