const assert = require('node:assert');
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

describe('side bar widths (PRD R91)', () => {
  let extension;

  before(async () => {
    extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    await vscode.commands.executeCommand('switchboard.forgetSideBarWidths');
  });

  after(async () => {
    await vscode.commands.executeCommand('switchboard.forgetSideBarWidths');
  });

  it("reads the primary side bar's width and the window's from the visible pane, and none from a hidden one", async () => {
    await vscode.commands.executeCommand('switchboard.pane.focus');

    const size = await until(() => extension.paneSize(), 'the visible pane never reported its size');

    assert.ok(size.inner >= 160 && size.outer > size.inner && size.dpr > 0, JSON.stringify(size));

    await vscode.commands.executeCommand('workbench.view.search');
    await until(() => extension.paneSize() === null, 'a hidden pane still counted');
    await vscode.commands.executeCommand('switchboard.pane.focus');
    await until(() => extension.paneSize(), 'the pane shown again never reported');
  });

  it('keeps a point for each side bar at the first look, and forgets them', async () => {
    await vscode.commands.executeCommand('switchboard.pane.focus');
    await until(() => extension.paneSize(), 'the pane never reported');

    const outcomes = [];

    await until(async () => {
      outcomes.push(await extension.pollSideBars());
      return extension.sideBarWidths().points.primary !== undefined;
    }, `no width was kept: ${outcomes.join(', ')}`, 15_000);

    // The primary's point: its width at the window's width less 74 pixels of frame, activity bar and sashes.
    const [point] = extension.sideBarWidths().points.primary;

    assert.strictEqual(point.width, extension.paneSize().inner);
    assert.ok(Math.abs(point.room - (extension.paneSize().outer - 74)) <= 1, JSON.stringify(point));

    await vscode.commands.executeCommand('switchboard.forgetSideBarWidths');
    assert.deepStrictEqual(extension.sideBarWidths(), { points: {} });
  });

  it('expands a pane that has not loaded once per workspace, not one that loaded, and not while the widths are off', async () => {
    const settings = vscode.workspace.getConfiguration('switchboard');

    // Both panes removed, so neither has loaded.
    await vscode.commands.executeCommand('switchboard.pane.removeView');
    await vscode.commands.executeCommand('switchboard.paneScm.removeView');
    await until(() => extension.paneSize() === null, 'the removed pane still counted');
    assert.strictEqual(await extension.expandPaneOnce(), false, 'expanded with the widths off');

    await settings.update('rememberSideBarWidths', true, vscode.ConfigurationTarget.Global);

    try {
      // A pane that loaded marks the workspace, so it stays collapsed or removed after.
      await vscode.commands.executeCommand('switchboard.pane.focus');
      await until(() => extension.paneSize(), 'the pane never reported');
      assert.strictEqual(await extension.expandPaneOnce(), false, 'expanded a pane that had loaded');
      await vscode.commands.executeCommand('switchboard.pane.removeView');
      await until(() => extension.paneSize() === null, 'the removed pane still counted');
      assert.strictEqual(await extension.expandPaneOnce(), false, 'expanded a pane that had loaded in this workspace');

      await vscode.commands.executeCommand('switchboard.forgetSideBarWidths');
      assert.strictEqual(await extension.expandPaneOnce(), true);
      await until(() => extension.paneSize(), 'the expanded pane never reported');

      await vscode.commands.executeCommand('switchboard.pane.removeView');
      await until(() => extension.paneSize() === null, 'the removed pane still counted');
      assert.strictEqual(await extension.expandPaneOnce(), false, 'expanded twice in one workspace');
    } finally {
      await settings.update('rememberSideBarWidths', false, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('switchboard.forgetSideBarWidths');
      await vscode.commands.executeCommand('switchboard.pane.focus');
    }
  });
});
