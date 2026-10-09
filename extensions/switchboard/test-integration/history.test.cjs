const assert = require('node:assert');
const { request } = require('node:http');
const { join } = require('node:path');
const vscode = require('vscode');

/**
 * A row's History (PRD R59): a webview tab per ticket that reads the hub's /history when its page loads, follows the hub's changes while
 * visible, catches up when shown again, reads again once the window reconnects, and is restored from its saved state. The page's text is
 * tested in test/history.test.ts; here the revision the page reports after rendering proves that the hub's reply reached it. The rows are written straight into the test hub's store,
 * done and long ago, so the hub neither shows nor acts on them.
 */
describe('a row\'s History', () => {
  const TICKET = 9001;
  let db;
  let extension;
  let warned = [];
  const original = vscode.window.showWarningMessage;

  const history = (ticketId) => extension.run({ type: 'history', ticketId, key: 'gh 77' });
  const tabs = () => extension.historyTabs().filter((tab) => tab.ticketId === TICKET);
  const editorTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.label === 'gh 77 History');

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

  /** Posts to the window's hub as the extension does. */
  function post(path, body) {
    const record = extension.hub();

    return new Promise((done, fail) => {
      const outbound = request({ host: '127.0.0.1', port: record.port, method: 'POST', path, headers: { Authorization: `Bearer ${record.token}`, 'Content-Type': 'application/json' } }, (response) => {
        response.resume();
        response.on('end', () => done(response.statusCode));
      });

      outbound.on('error', fail);
      outbound.end(JSON.stringify(body));
    });
  }

  before(async function () {
    this.timeout(60_000);
    extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();

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
      db.exec(`DELETE FROM changes WHERE ticketId >= ${TICKET}; DELETE FROM events WHERE ticketId >= ${TICKET}; DELETE FROM historyRevisions WHERE ticketId >= ${TICKET}`);
      db.exec(`DELETE FROM sessions WHERE workItemId >= ${TICKET}; DELETE FROM triages WHERE ticketId >= ${TICKET}; DELETE FROM workItems WHERE ticketId >= ${TICKET}; DELETE FROM tickets WHERE id >= ${TICKET}`);
      db.close();
    }
  });

  beforeEach(() => {
    warned = [];
  });

  it('opens the ticket\'s History in one webview tab, whose page loads and shows the hub\'s history, and reuses the tab when opened again', async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const panel = await history(TICKET);

    assert.deepStrictEqual(warned, []);
    assert.strictEqual(panel.viewType, 'switchboard.history');
    await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'gh 77 History', 'the History tab is not active');
    // The page posts ready once its script runs, and the read it asks for stores the revision it was sent.
    await until(() => tabs()[0]?.shown === revision(), `the page never showed the history: ${JSON.stringify(tabs())}`);

    const again = await history(TICKET);

    assert.strictEqual(again, panel, 'a second open reuses the ticket\'s tab');
    assert.strictEqual(editorTabs().length, 1);
  });

  it('follows a logged change while visible, and catches up on one made while hidden when shown again', async function () {
    this.timeout(30_000);

    const panel = await history(TICKET);

    await until(() => tabs()[0]?.shown === revision(), 'the page never showed the history');

    const first = revision();

    assert.strictEqual(await post('/action', { type: 'snooze', ticketId: TICKET, until: null }), 200);
    assert.notStrictEqual(revision(), first);
    await until(() => tabs()[0].shown === revision(), `the visible tab did not follow the snooze: ${JSON.stringify(tabs())}`);

    // Another editor hides the History tab, so the restore reaches it only when it is shown again.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: 'other' }));
    assert.strictEqual(panel.visible, false);

    const hidden = tabs()[0].shown;

    assert.strictEqual(await post('/action', { type: 'restore', ticketId: TICKET }), 200);
    await new Promise((done) => setTimeout(done, 2_000));
    assert.strictEqual(tabs()[0].shown, hidden, 'a hidden tab read the hub');

    panel.reveal();
    await until(() => tabs()[0].shown === revision() && revision() !== hidden, `the shown tab did not catch up: ${JSON.stringify(tabs())}`);
  });

  it('opens a tab while no hub answers, says so, and reads the history once the window reconnects', async function () {
    this.timeout(90_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const before = extension.hub();

    // No hub answers between the shutdown and the restart, as for a tab VS Code restores before the window connects.
    await new Promise((done) => {
      const outbound = request({ host: '127.0.0.1', port: before.port, method: 'POST', path: '/shutdown', headers: { Authorization: `Bearer ${before.token}` } }, (response) => {
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
    await history(TICKET);
    await until(() => tabs()[0]?.error?.startsWith('Switchboard: '), `the tab did not report the missing hub: ${JSON.stringify(tabs())}`);
    await until(() => extension.hub() !== null && extension.hub().pid !== before.pid, 'the window did not reconnect to a new hub', 60_000);
    await until(() => tabs()[0]?.shown === revision() && tabs()[0].error === null, `the tab was not read again: ${JSON.stringify(tabs())}`);
  });

  it('restores a tab from the state its page saved, as after a reload, and drops one whose state names no ticket', async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await until(() => extension.historyTabs().length === 0, 'a tab stayed open');

    await extension.restoreHistory({ ticketId: TICKET, key: 'gh 77', ui: { hidden: ['you'], query: '', sections: {}, runs: [] } });
    await until(() => tabs()[0]?.shown === revision(), `the restored page never showed the history: ${JSON.stringify(tabs())}`);
    assert.strictEqual(tabs()[0].title, 'gh 77 History');

    await extension.restoreHistory({ key: 'gh 77' });
    assert.strictEqual(extension.historyTabs().length, 1);
  });

  it('warns, and leaves no tab, for a ticket the hub does not know', async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await history(TICKET + 1);

    await until(() => warned.length > 0, 'no warning');
    assert.deepStrictEqual(warned, [`Switchboard: Unknown ticket ${TICKET + 1}.`]);
    await until(() => extension.historyTabs().length === 0, 'the tab stayed open');
  });

  /** The ticket's history revision as the hub's store holds it. */
  function revision() {
    return String(db.prepare(`SELECT revision FROM historyRevisions WHERE ticketId = ${TICKET}`).get()?.revision ?? 0);
  }
});
