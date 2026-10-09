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
      response.end(`<!doctype html><title>page${request.url.replaceAll('/', '-')}</title><p>${request.url}</p>`);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    server.close();
  });

  it('opens each URL in its own pinned integrated browser tab, reusing the tab of a URL opened again, and a file in a pinned editor', async function () {
    this.timeout(120_000);

    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const report = join(mkdtempSync(join(tmpdir(), 'switchboard-tabs-')), 'reply.md');

    writeFileSync(report, '# Reply\n');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    await extension.openTab(`${base}/issue`);
    await extension.openTab(`${base}/pull`);
    await extension.openTab(`${base}/issue`);
    await extension.openTab(report);

    await until(() => requests.includes('/issue') && requests.includes('/pull'), `the browser never loaded both pages: ${JSON.stringify(requests)}`);

    const browserTabs = await until(() => {
      const found = tabs().filter((tab) => tab.input === undefined);

      return found.length >= 2 && found;
    }, `two browser tabs never opened: ${JSON.stringify(tabs().map((tab) => tab.label))}`);
    const file = tabs().find((tab) => tab.input instanceof vscode.TabInputText);

    assert.strictEqual(browserTabs.length, 2, `tabs: ${JSON.stringify(tabs().map((tab) => tab.label))}`);
    assert.deepStrictEqual(browserTabs.map((tab) => tab.isPreview), [false, false]);
    assert.strictEqual(file?.input.uri.fsPath.toLowerCase(), report.toLowerCase());
    assert.strictEqual(file.isPreview, false);
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
