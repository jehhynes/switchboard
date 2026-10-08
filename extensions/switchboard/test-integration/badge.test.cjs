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

describe('the activity bar badge (PRD R64)', () => {
  it('counts the Needs you work items on the resolved view, leaves out snoozed ones, and clears at 0', async () => {
    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const hubState = await until(() => extension.state(), 'the panel never received the hub state');
    const show = (workItems) => extension.show(JSON.stringify({ ...hubState, workItems }));

    try {
      // Shown before the view may be resolved, so resolving it shows the badge of the latest state.
      show([item(1, 'failed'), item(2, 'blocked', true), item(3, 'unstarted')]);
      await vscode.commands.executeCommand('switchboard.workItems.focus');
      await until(() => extension.badge() !== null, 'VS Code never resolved the view');
      assert.deepStrictEqual(extension.badge(), { value: 1, tooltip: '1 needs you' });

      show([item(1, 'failed'), item(4, 'awaiting-approval')]);
      assert.deepStrictEqual(extension.badge(), { value: 2, tooltip: '2 need you' });

      show([item(3, 'unstarted')]);
      assert.strictEqual(extension.badge(), undefined);
    } finally {
      // The hub sends state only on a change, so later tests see its state again only through this.
      extension.show(JSON.stringify(hubState));
    }
  });
});
