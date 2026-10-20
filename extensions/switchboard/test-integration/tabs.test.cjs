const assert = require('node:assert');
const { createServer } = require('node:http');
const { mkdtempSync, writeFileSync } = require('node:fs');
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

const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs);

describe("Item window tabs (PRD R72)", () => {
  let server;
  let base;
  const requests = [];

  before(async () => {
    // A test-owned loopback page per path, titled by its path, so each browser tab is named by the page it shows.
    server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(200, { 'Content-Type': 'text/html' });

      // As Zoho Desk does, a ticket link's page replaces itself with the ticket's agent page, named by the bookmark's ID.
      if (request.url === '/support/acme/ShowHomePage.do') {
        response.end(`<!doctype html><script>location.replace('/agent/acme/acme-inc/tickets/details/' + location.hash.split('/').pop())</script>`);
        return;
      }

      // A page reports the bookmark it loaded with, which the browser does not send, as /hash?<bookmark>.
      response.end(`<!doctype html><title>page${request.url.replaceAll('/', '-')}</title><p>${request.url}</p><script>fetch('/hash?' + location.hash.slice(1))</script>`);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    server.close();
  });

  it('opens each URL in its own pinned integrated browser tab, reusing the tab of a URL opened again, a Markdown report in its preview and another file in a pinned editor', async function () {
    this.timeout(120_000);

    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const folder = mkdtempSync(join(tmpdir(), 'switchboard-tabs-'));
    const report = join(folder, 'reply.md');
    const second = join(folder, 'second.md');
    const other = join(folder, 'note.txt');

    writeFileSync(report, '# Reply\n');
    writeFileSync(second, '# Second\n');
    writeFileSync(other, 'Note\n');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    await extension.openTab(`${base}/issue`);
    await extension.openTab(`${base}/pull`);
    await extension.openTab(`${base}/issue`);
    await extension.openTab(report);
    await extension.openTab(second);
    await extension.openTab(report);
    await extension.openTab(other);

    await until(() => requests.includes('/issue') && requests.includes('/pull'), `the browser never loaded both pages: ${JSON.stringify(requests)}`);

    const browserTabs = await until(() => {
      const found = tabs().filter((tab) => tab.input === undefined);

      return found.length >= 2 && found;
    }, `two browser tabs never opened: ${JSON.stringify(tabs().map((tab) => tab.label))}`);
    const texts = tabs().filter((tab) => tab.input instanceof vscode.TabInputText);
    const previews = tabs().filter((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'vscode.markdown.preview.editor');

    assert.strictEqual(browserTabs.length, 2, `tabs: ${JSON.stringify(tabs().map((tab) => tab.label))}`);
    assert.deepStrictEqual(browserTabs.map((tab) => tab.isPreview), [false, false]);
    assert.deepStrictEqual(texts.map((tab) => tab.input.uri.fsPath.toLowerCase()), [other.toLowerCase()]);
    assert.strictEqual(texts[0].isPreview, false);
    // Each report keeps its own preview tab, and opening one again does not add another.
    assert.strictEqual(previews.length, 2, `tabs: ${JSON.stringify(tabs().map((tab) => tab.label))}`);
    assert.ok(previews.some((tab) => tab.label.includes('reply.md')) && previews.some((tab) => tab.label.includes('second.md')), JSON.stringify(previews.map((tab) => tab.label)));
    assert.deepStrictEqual(previews.map((tab) => tab.isPreview), [false, false]);
  });

  it("opens a focus URL with its comment's bookmark, reusing its tab when opened again (PRD R79)", async function () {
    this.timeout(120_000);

    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    requests.length = 0;
    await extension.openTab(`${base}/focus#issuecomment-5`);
    await until(() => requests.includes('/hash?issuecomment-5'), `the page never loaded with its bookmark: ${JSON.stringify(requests)}`);
    await extension.openTab(`${base}/focus#issuecomment-5`);

    const browserTabs = tabs().filter((tab) => tab.input === undefined);

    assert.strictEqual(browserTabs.length, 1, `tabs: ${JSON.stringify(tabs().map((tab) => tab.label))}`);
    assert.deepStrictEqual(requests.filter((url) => url === '/focus'), ['/focus']);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it("reuses the tab of a Zoho Desk ticket link that the page redirected to the ticket's agent page", async function () {
    this.timeout(120_000);

    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const ticket = `${base}/support/acme/ShowHomePage.do#Cases/dv/1019`;

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    requests.length = 0;
    await extension.openTab(ticket);
    // The tab's title shows the redirected page, so its URL has changed before the second open.
    await until(() => tabs().some((tab) => tab.input === undefined && tab.label.startsWith('page-agent')), `the tab never showed the redirected page: ${JSON.stringify(tabs().map((tab) => tab.label))}`);
    await extension.openTab(ticket);
    await until(() => requests.filter((url) => url === '/agent/acme/acme-inc/tickets/details/1019').length === 2, `the tab never loaded the link again: ${JSON.stringify(requests)}`);

    const browserTabs = tabs().filter((tab) => tab.input === undefined);

    assert.strictEqual(browserTabs.length, 1, `tabs: ${JSON.stringify(tabs().map((tab) => tab.label))}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('turns a Markdown report into its text editor in the same tab with Toggle Preview, so editing adds no tab', async () => {
    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const report = join(mkdtempSync(join(tmpdir(), 'switchboard-tabs-')), 'draft.md');

    writeFileSync(report, '# Draft\n');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await extension.openTab(report);
    await vscode.commands.executeCommand('markdown.togglePreview');

    const text = await until(() => tabs().find((tab) => tab.input instanceof vscode.TabInputText), `the report never became a text editor: ${JSON.stringify(tabs().map((tab) => tab.label))}`);

    assert.strictEqual(text.input.uri.fsPath.toLowerCase(), report.toLowerCase());
    assert.strictEqual(tabs().length, 1, JSON.stringify(tabs().map((tab) => tab.label)));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('says which URL did not open when the integrated browser is missing', async () => {
    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const execute = vscode.commands.executeCommand;

    vscode.commands.executeCommand = (command, ...args) => (command === 'workbench.action.browser.open' ? Promise.reject(new Error("command 'workbench.action.browser.open' not found")) : execute(command, ...args));

    try {
      await assert.rejects(extension.openTab(`${base}/missing`), { message: `VS Code's integrated browser did not open ${base}/missing: command 'workbench.action.browser.open' not found` });
    } finally {
      vscode.commands.executeCommand = execute;
    }
  });
});
