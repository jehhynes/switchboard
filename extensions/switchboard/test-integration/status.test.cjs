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
    readyAt: null,
    orderAt: null,
    runStartedAt: null,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    ticket: { id, source: 'github', sourceKey: String(id), ref: `#${id}`, sourceId: null, adhocKey: null, title: `Issue ${id}`, url: `https://github.com/o/r/issues/${id}`, assigned: true, pool: false, snoozed, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: 1_791_000_000_000, repoRoot: '' },
    triage: null,
    focus: `https://github.com/o/r/issues/${id}`,
    sessions: [],
    worktree: null,
    links: [],
    returned: 0,
  };
}

describe('the status bar item (PRD R64, R71)', () => {
  it("shows the logo with no count, which the dock shows, whatever needs the operator", async () => {
    const extension = await vscode.extensions.getExtension('switchboard.switchboard').activate();
    const hubState = await until(() => extension.state(), 'the window never received the hub state');

    try {
      extension.show(JSON.stringify({ ...hubState, workItems: [item(1, 'failed'), item(4, 'awaiting-approval')], needsCount: 2 }));
      assert.deepStrictEqual(extension.status(), { text: '$(switchboard-logo)', tooltip: 'Switchboard: click to show the dock.', label: 'Switchboard, show the dock' });
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
      assert.match(warned[0], process.platform === 'win32' ? /^Switchboard: the dock is not installed at .*\\.switchboard\\dock\\Switchboard\.Dock\.exe\.$/ : /^Switchboard: the dock is not installed at .*\/\.switchboard\/dock\/Switchboard\.Dock\.$/);
    } finally {
      vscode.window.showWarningMessage = realWarning;
    }

    const contributes = vscode.extensions.getExtension('switchboard.switchboard').packageJSON.contributes;

    assert.deepStrictEqual(contributes.commands.map((entry) => entry.command), ['switchboard.showDock', 'switchboard.showHubLog', 'switchboard.openWebPage', 'switchboard.newClaudeTab', 'switchboard.forgetSideBarWidths', 'switchboard.continueInBackground', 'switchboard.continueSidebarInBackground', 'switchboard.openArtifact', 'switchboard.newSession', 'switchboard.talkHere', 'switchboard.stopSpeaking', 'switchboard.toggleSpeakReplies', 'switchboard.toggleMicrophone', 'switchboard.replayLastReply', 'switchboard.showVoiceLog']);
    // Stop Speaking and Toggle Microphone have keys, on while voice is (architecture.md § Voice).
    assert.deepStrictEqual(contributes.keybindings, [{ command: 'switchboard.stopSpeaking', key: 'ctrl+alt+.', mac: 'cmd+alt+.', when: 'switchboard.voiceEnabled' }, { command: 'switchboard.toggleMicrophone', key: 'ctrl+alt+m', mac: 'cmd+alt+m', when: 'switchboard.voiceEnabled' }]);
    // The palette offers only what no visible control does, the voice's only while voice is on (architecture.md § VS Code extension).
    const palette = Object.fromEntries(contributes.menus.commandPalette.map((entry) => [entry.command, entry.when]));
    const offered = contributes.commands.filter((entry) => palette[entry.command] !== 'false').map((entry) => `${entry.title}${palette[entry.command] === undefined ? '' : ` (${palette[entry.command]})`}`);

    assert.deepStrictEqual(offered, ['Show Hub Log', 'Open Web Page', 'Reset Side Bar Widths', 'Voice: Replay Last Reply (switchboard.voiceEnabled)', 'Voice: Show Log (switchboard.voiceEnabled)']);
    assert.ok(contributes.commands.filter((entry) => entry.command !== 'switchboard.replayLastReply' && entry.command !== 'switchboard.showVoiceLog' && /talkHere|Speaking|SpeakReplies|Microphone/.test(entry.command)).every((entry) => entry.title.startsWith('Voice: ')));
    // The views are the Switchboard pane's, in the Explorer and Source Control (PRD R92), and the Conversation view's, in the secondary side bar or,
    // before VS Code 1.106, its own activity bar container (PRD R96), whose tabs hold the status and the artifacts (PRD R98, R99); the list is in the
    // dock (PRD R71).
    assert.deepStrictEqual(Object.fromEntries(Object.entries(contributes.views).map(([container, views]) => [container, views.map((view) => view.id)])), {
      explorer: ['switchboard.pane'],
      scm: ['switchboard.paneScm'],
      'switchboard-conversation': ['switchboard.conversation'],
      'switchboard-conversation-activity': ['switchboard.conversationActivity'],
    });
  });
});
