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

function item(id, status, snoozed = false) {
  return {
    id,
    ticketId: id,
    playbook: 'dev:develop',
    status,
    stage: null,
    stageAt: null,
    taskPrompt: null,
    warning: null,
    error: status === 'failed' ? 'Triage failed.' : null,
    unassignedAt: null,
    queuedAt: null,
    approvalPrompt: null,
    approvalSummary: null,
    approvalReport: null,
    createdAt: 1_791_000_000_000,
    statusAt: 1_791_000_000_000,
    runStartedAt: null,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    ticket: { id, source: 'github', sourceKey: String(id), ref: `#${id}`, sourceId: null, title: `Issue ${id}`, url: `https://github.com/o/r/issues/${id}`, assigned: true, pool: false, snoozed, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 1_791_000_000_000, repoRoot: '' },
    triage: null,
    sessions: [],
    worktree: null,
    links: [],
    returned: 0,
  };
}

describe('the status bar item (PRD R64, R71)', () => {
  it("counts the work items on the operator's turn, leaving out snoozed ones, and shows no count at 0", async () => {
    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const hubState = await until(() => extension.state(), 'the window never received the hub state');
    const show = (workItems) => extension.show(JSON.stringify({ ...hubState, workItems }));

    try {
      show([item(1, 'failed'), item(2, 'blocked', true), item(3, 'unstarted')]);
      assert.deepStrictEqual(extension.status(), { text: '$(switchboard-logo) 1', tooltip: 'Switchboard: 1 needs you. Click to show the dock.' });

      show([item(1, 'failed'), item(4, 'awaiting-approval')]);
      assert.strictEqual(extension.status().text, '$(switchboard-logo) 2');

      show([item(3, 'unstarted')]);
      assert.strictEqual(extension.status().text, '$(switchboard-logo)');
    } finally {
      // The hub sends state only on a change, so later tests see its state again only through this.
      extension.show(JSON.stringify(hubState));
    }
  });

  it('shows the dock, and says it is not installed when the hub has no dock connected and the home has none', async () => {
    await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const realWarning = vscode.window.showWarningMessage;
    const warned = [];

    vscode.window.showWarningMessage = (...args) => (warned.push(args[0]), Promise.resolve(undefined));
    try {
      assert.strictEqual(await vscode.commands.executeCommand('switchboard.showDock'), 'missing');
      assert.match(warned[0], /^Switchboard: the dock is not installed at .*\\.switchboard\\dock\\Switchboard\.Dock\.exe\.$/);
    } finally {
      vscode.window.showWarningMessage = realWarning;
    }

    const contributes = vscode.extensions.getExtension('switchboard.switchboard').packageJSON.contributes;

    assert.deepStrictEqual(contributes.commands.map((entry) => entry.command), ['switchboard.showDock', 'switchboard.newClaudeTab']);
    assert.strictEqual(contributes.views, undefined, 'the panel view is gone');
  });
});
