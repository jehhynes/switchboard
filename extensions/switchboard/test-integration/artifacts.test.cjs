const assert = require('node:assert');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
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
const scope = { kind: 'item', workItemId: 2, key: 'k-artifacts', title: 'Artifacts', cwd: null, scopeGen: 1, sessionId: 's2' };
const session = { id: 's2', kind: 'task', title: 'Task session aaaa', state: 'idle', waitingFor: null, launch: 'l', current: true, conversation: 'full', reason: null };
const artifact = (path, type, updatedAt, title) => ({ path, owner: 'chat', kind: 'comparison', title, ext: path.split('.').pop(), type, updatedAt });

/**
 * The Artifacts view, native opening and Mermaid in the Markdown preview (architecture.md § Artifacts). The suite's window has no work item, so
 * the view is given a work item's conversation as the hub would send it, over a real artifact folder.
 */
describe('artifacts', () => {
  let root;
  let extension;

  before(async () => {
    extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    root = mkdtempSync(join(tmpdir(), 'switchboard-artifacts-'));
    mkdirSync(join(root, 'chat', 'comparison-pages', 'img'), { recursive: true });
    writeFileSync(join(root, 'chat', 'comparison-engines.md'), '---\nkind: comparison\ntitle: Engines\n---\n\n```mermaid\ngraph TD; A-->B\n```\n');
    writeFileSync(join(root, 'chat', 'comparison-pages.html'), '<!doctype html><title>Pages</title><img src="comparison-pages/img/a.png"><script src="https://x.test/a.js"></script>');
    writeFileSync(join(root, 'chat', 'comparison-pages', 'img', 'a.png'), 'png');
  });

  after(async () => {
    extension.receiveConversation({ type: 'hello', scope: null, sessions: [], items: [], more: false, status: null, artifactsDir: null, artifacts: [], unread: 0 });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // The closed preview and panel can hold the folder for a moment on Windows.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("lists the window's artifacts on the Conversation view's Artifacts tab, with a badge for new ones, and contributes no Artifacts view of its own", async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.ok(!commands.includes('switchboard.artifacts.focus'), 'VS Code still has an Artifacts view');
    await vscode.commands.executeCommand('switchboard.conversation.focus');

    extension.receiveConversation({ type: 'hello', scope, sessions: [session], items: [], more: false, status: null, artifactsDir: root, artifacts: [artifact('chat/comparison-engines.md', 'markdown', 1_000, 'Engines')] });
    // The first artifacts a workspace sees for a work item count as opened.
    await until(() => extension.artifacts().artifacts.length === 1 && extension.artifacts().badge === 0, 'the view never listed the artifact');
    extension.receiveConversation({ type: 'artifact', artifact: artifact('chat/comparison-pages.html', 'html', 2_000, 'Pages') });
    assert.deepStrictEqual(extension.artifacts().artifacts.map((one) => one.path), ['chat/comparison-pages.html', 'chat/comparison-engines.md']);
    assert.strictEqual(extension.artifacts().badge, 1);
  });

  it('opens an HTML artifact in its own panel, with its files from the folder beside it and no network', async () => {
    await vscode.commands.executeCommand('switchboard.openArtifact', 'chat/comparison-pages.html');

    const [panel] = extension.artifacts().panels;

    assert.strictEqual(panel.path, 'chat/comparison-pages.html');
    assert.match(panel.html, /^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' [^"]*form-action 'none'; base-uri 'none'">/);
    assert.doesNotMatch(panel.html, /connect-src/);
    assert.match(panel.html, /<img src="https:\/\/[^"]*comparison-pages\/img\/a\.png">/);
    assert.match(panel.html, /<script src=""><\/script>/);
    await until(() => tabs().some((tab) => tab.label === 'Pages' && tab.input instanceof vscode.TabInputWebview), 'the HTML artifact never opened in a panel');
    assert.strictEqual(extension.artifacts().badge, 0);
  });

  it('opens a Markdown artifact in the Markdown preview, whose markdown-it draws a mermaid fence as a diagram placeholder', async () => {
    await vscode.commands.executeCommand('switchboard.openArtifact', 'chat/comparison-engines.md');
    await until(() => tabs().some((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'vscode.markdown.preview.editor' && tab.input.uri.fsPath.endsWith('comparison-engines.md')), 'the Markdown artifact never opened in the preview');

    const html = await vscode.commands.executeCommand('markdown.api.render', '```mermaid\ngraph TD; A-->B\n```\n');

    assert.match(html, /<pre class="switchboard-mermaid"[^>]*>graph TD; A--&gt;B\n<\/pre>/);
  });

  it('refuses a path the window was not sent', async () => {
    const before = tabs().length;

    await vscode.commands.executeCommand('switchboard.openArtifact', '../../outside.md');
    assert.strictEqual(tabs().length, before);
  });
});
