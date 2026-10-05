import { describe, expect, it } from 'vitest';
import type { FlowAction, PolledTicket } from '../src/flow.js';
import { Harness, MINUTE, REPORT, T0, issue, playbooks, settings } from './flowHarness.js';

const CONTRACT = (id: string) =>
  [
    '',
    '',
    `Report to Switchboard with these commands:`,
    `- ${REPORT} stage ${id} <stage>, when you start a new phase of the work.`,
    `  - The stage is one or two words, such as Reviewing or Fixing tests.`,
    `- ${REPORT} worktree ${id} <path>, when you create a worktree.`,
    `- ${REPORT} done ${id}, when the work is finished.`,
    `- ${REPORT} approval ${id} --prompt <prompt> --summary <text> --report <absolute path>, when the work is ready but posting or publishing it needs the operator's approval, then end your turn.`,
    `  - The prompt runs in a new session with no memory of this one, so it names what it acts on, such as /review-pr pr:123 publish.`,
    `  - The summary is one phrase of at most 8 words saying what Approve publishes, without counts.`,
    `  - The report is the file holding the text Approve publishes, such as a drafted comment; leave out --report when nothing is drafted.`,
    `- ${REPORT} link ${id} --label <text> --target <url>, for each GitHub issue or pull request you create or find for this work.`,
    ``,
    `When you need the operator's answer or choice, or cannot continue without them, ask with AskUserQuestion and wait for the answer. Do not report or write a file for a question.`,
  ].join('\n');

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions).toHaveLength(1);
  expect(actions[0]?.type).toBe(type);
  return actions[0] as Extract<FlowAction, { type: T }>;
}

describe('assigned-state transitions', () => {
  it('gives every assigned ticket a work item on the first poll and triages up to the concurrency limit', () => {
    const h = new Harness();
    const actions = h.poll(issue('1'), issue('2'), issue('3'), issue('4', false));

    expect(actions.map((action) => action.type === 'triage' && action.workItemId)).toEqual([1, 2]);
    expect(actions[0]).toEqual({
      type: 'triage',
      triageId: 1,
      workItemId: 1,
      ticket: { id: 1, source: 'github', sourceKey: '1', ref: '#1', sourceId: null, title: 'Issue 1', url: 'https://github.com/acme/widgets/issues/1', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: T0, lastPolledAt: T0, repoRoot: '' },
      systemPrompt: 'Classify the GitHub issue.\n\nChoose one playbook:\n- dev:develop: Plan and build the change\n- dev:question: Answer a question\n- support:defect: Research a defect',
      choices: [
        { name: 'dev:develop', description: 'Plan and build the change' },
        { name: 'dev:question', description: 'Answer a question' },
        { name: 'support:defect', description: 'Research a defect' },
      ],
      model: null,
      timeoutSeconds: 180,
    });
    expect([1, 2, 3].map((id) => h.status(id))).toEqual(['triaging', 'triaging', 'triaging']);
    expect(h.store.workItem(4)).toBeNull();
    expect(h.store.findTicket('github', '4')?.assigned).toBe(false);

    const next = h.triaged(actions[0], 'dev:question');

    expect(next.map((action) => action.type === 'triage' && action.workItemId)).toEqual([3]);
  });

  it('changes nothing on a failed poll', () => {
    const h = new Harness();
    h.poll(issue('1'));

    expect(h.send({ type: 'poll-failed', source: 'github', error: 'timeout' })).toEqual({ actions: [], refused: null });
    expect(h.store.findTicket('github', '1')?.assigned).toBe(true);
    expect(h.status(1)).toBe('triaging');
  });

  it('finishes a work item with a warning when its ticket leaves with no active session, and creates a new one when it returns', () => {
    const h = new Harness();
    h.poll(issue('1'));
    h.now += MINUTE;
    h.poll();

    expect(h.item(1)).toMatchObject({ status: 'done', doneReason: 'unassigned', doneAt: T0 + MINUTE, warning: 'The ticket left the assigned state without a done report.' });
    expect(h.store.findTicket('github', '1')?.assigned).toBe(false);

    h.poll(issue('1', false));
    expect(h.store.workItem(2)).toBeNull();


    const actions = h.poll(issue('1'));

    expect(h.item(2)).toMatchObject({ ticketId: 1, status: 'triaging' });
    expect(only(actions, 'triage').workItemId).toBe(2);
  });

  it('treats a ticket the poll reports as not assigned like one missing from the poll', () => {
    const h = new Harness();
    h.poll(issue('1'));
    h.poll(issue('1', false));

    expect(h.item(1)).toMatchObject({ status: 'done', doneReason: 'unassigned' });
  });

  it('records a late triage result for a work item that is already done without changing it, and ignores a repeated result', () => {
    const h = new Harness();
    const [first, second] = h.poll(issue('1'), issue('2'));
    h.poll();

    expect(h.triaged(first, 'dev:question')).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'done', playbook: null });
    expect(h.store.triage(1)).toMatchObject({ playbook: 'dev:question', summary: 'A summary.' });

    h.act({ type: 'triage-failed', triageId: 2, error: 'late', context: null });
    expect(h.item(2)).toMatchObject({ status: 'done', error: null });

    expect(h.triaged(first, 'support:defect')).toEqual([]);
    expect(h.act({ type: 'triage-failed', triageId: 1, error: 'x', context: null })).toEqual([]);
    expect(h.store.triage(1)).toMatchObject({ playbook: 'dev:question', error: null });
    expect(second).toBeDefined();
  });

  it('updates the title and source ID of a known ticket', () => {
    const h = new Harness();
    h.poll(issue('1'));
    h.poll({ ...issue('1'), title: 'Renamed', sourceId: 'z-9' });

    expect(h.store.findTicket('github', '1')).toMatchObject({ title: 'Renamed', sourceId: 'z-9' });
    expect(h.store.workItem(2)).toBeNull();
  });
});

describe('triage', () => {
  it('leaves the work item unstarted when the playbook does not auto-start, then Start runs the task in the repo root', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));

    expect(h.triaged(triage, 'dev:question', 'Asks about fees.')).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'unstarted', playbook: 'dev:question' });
    expect(h.send({ type: 'approve', workItemId: 1 }).refused).toBe('The work item is not awaiting approval.');

    const start = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    expect(start).toEqual({
      type: 'start-session',
      sessionId: 's1',
      workItemId: 1,
      kind: 'task',
      cwd: 'D:/git/widgets',
      prompt: 'Answer Issue 1.\nAsks about fees.' + CONTRACT('s1'),
      name: 'switchboard · dev:question · github 1',
      permissionMode: 'plan',
      model: 'opus',
    });
    expect(h.item(1)).toMatchObject({ status: 'running', taskPrompt: start.prompt });
    expect(h.store.session('s1')).toMatchObject({ kind: 'task', state: 'starting', cwd: 'D:/git/widgets', provider: 'claude' });
  });

  it('fails on a classifier error and triages again on Retry', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));

    h.act({ type: 'triage-failed', triageId: (triage as Extract<FlowAction, { type: 'triage' }>).triageId, error: 'Timed out after 180 seconds.', context: 'ctx' });
    expect(h.item(1)).toMatchObject({ status: 'failed', failedStep: 'triage', error: 'Timed out after 180 seconds.' });
    expect(h.store.triage(1)).toMatchObject({ endedAt: T0, error: 'Timed out after 180 seconds.', context: 'ctx' });

    const retry = only(h.act({ type: 'retry', workItemId: 1 }), 'triage');
    expect(retry).toMatchObject({ triageId: 2, workItemId: 1 });
    expect(h.item(1)).toMatchObject({ status: 'triaging', error: null, failedStep: null });
  });

  it('triages a cancelled work item again', () => {
    const h = new Harness();
    h.poll(issue('1'));

    expect(only(h.act({ type: 'triage-cancelled', triageId: 1 }), 'triage').triageId).toBe(2);
    expect(h.store.triage(1)).toMatchObject({ endedAt: T0, error: 'Cancelled.' });
    expect(h.act({ type: 'triage-cancelled', triageId: 1 })).toEqual([]);
  });

  it('fails on a playbook outside the loaded task playbooks', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));

    h.triaged(triage, 'triage:github');

    expect(h.item(1)).toMatchObject({ status: 'failed', failedStep: 'triage', error: 'Triage chose an unknown playbook: triage:github.' });
    expect(h.store.triage(1)).toMatchObject({ endedAt: T0, playbook: null, error: 'Triage chose an unknown playbook: triage:github.', context: 'Context 1' });
  });

  it('renders {{playbooks}} into the classifier instructions in place of the appended list', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'triage:github': '---\ndescription: Triage\nkind: triage\n---\nPick one:\n{{playbooks}}\nThen summarize.\n' }) });
    const [triage] = h.poll(issue('1'));

    expect(triage).toMatchObject({ type: 'triage', systemPrompt: 'Pick one:\n- dev:develop: Plan and build the change\n- dev:question: Answer a question\n- support:defect: Research a defect\nThen summarize.\n' });
  });

  it('fails on configuration errors', () => {
    const variable = new Harness({ playbooks: playbooks(undefined, { 'triage:github': '---\ndescription: Triage\nkind: triage\n---\n{{ticket.title}}\n' }) });
    variable.poll(issue('1'));
    expect(variable.item(1)).toMatchObject({ status: 'failed', failedStep: 'triage', error: 'Triage playbook triage:github: Unknown template variable: ticket.title.' });

    const missing = new Harness({ playbooks: playbooks(['dev:question']) });
    missing.poll(issue('1'));
    expect(missing.item(1)).toMatchObject({ status: 'failed', failedStep: 'triage', error: 'Triage playbook triage:github is not loaded.' });

    const none = new Harness({ playbooks: playbooks(['triage:github']) });
    none.poll(issue('1'));
    expect(none.item(1)).toMatchObject({ status: 'failed', error: 'No task playbooks to choose from.' });

    const unset = new Harness();
    unset.settings.sources['github']!.triagePlaybook = '';
    unset.poll(issue('1'));
    expect(unset.item(1)).toMatchObject({ status: 'failed', error: 'sources.github.triagePlaybook is not set.' });
  });

});

describe('sessions', () => {
  function running(h: Harness, key = '1', playbook = 'dev:question'): { item: number; session: string } {
    const [triage] = h.poll(...[...h.store.tickets('github').filter((t) => t.assigned).map((t) => issue(t.sourceKey)), issue(key)]);
    const item = (triage as Extract<FlowAction, { type: 'triage' }>).workItemId!;
    h.triaged(triage, playbook);
    const session = h.started(h.act({ type: 'start', workItemId: item })[0]);

    return { item, session };
  }

  it('finishes the work item on a done report and releases the session once its turn ends', () => {
    const h = new Harness();
    const { item, session } = running(h);

    expect(h.report(session, { kind: 'done' }).actions).toEqual([]);
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'session', warning: null });

    expect(h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null })).toEqual([]);
    expect(h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null })).toEqual([{ type: 'stop-session', sessionId: session, shortId: 'abc12345', reason: 'release' }]);
    expect(h.act({ type: 'marker', sessionId: session, state: 'running', detail: null })).toEqual([]);
    expect(h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null })).toEqual([]);

    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', outcome: 'done', outcomeDetail: null, endedAt: T0 });
    expect(h.item(item).status).toBe('done');
  });

  it('blocks on a turn that ends without a report, a failed turn, or a session that ends, but not while it waits on the operator', () => {
    const h = new Harness();
    const a = running(h, '1');
    h.act({ type: 'marker', sessionId: a.session, state: 'waiting', detail: null });
    expect(h.item(a.item)).toMatchObject({ status: 'running', error: null });

    const b = running(h, '2');
    h.act({ type: 'marker', sessionId: b.session, state: 'idle', detail: null });
    expect(h.item(b.item)).toMatchObject({ status: 'blocked', error: 'The turn ended without a done report.' });

    h.act({ type: 'marker', sessionId: b.session, state: 'running', detail: null });
    expect(h.item(b.item)).toMatchObject({ status: 'running', error: null });

    h.act({ type: 'marker', sessionId: b.session, state: 'failed', detail: 'rate_limit' });
    expect(h.item(b.item)).toMatchObject({ status: 'blocked', error: 'The turn failed: rate_limit.' });

    const c = new Harness();
    const d = running(c, '3');
    c.act({ type: 'roster', sessions: [] });
    expect(c.item(d.item)).toMatchObject({ status: 'blocked', error: 'The session ended without a done report.' });
    expect(c.store.session(d.session)).toMatchObject({ state: 'ended', endedAt: T0 });
  });

  it('takes liveness from the roster: markers never revive an ended session, the roster does', () => {
    const h = new Harness();
    const { item, session } = running(h);

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null }] });
    expect(h.store.session(session)?.state).toBe('waiting');

    h.act({ type: 'roster', sessions: [] });
    expect(h.store.session(session)?.state).toBe('ended');

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.store.session(session)?.state).toBe('ended');

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'running', detail: null }] });
    expect(h.store.session(session)).toMatchObject({ state: 'running', endedAt: null });
    expect(h.item(item).status).toBe('running');
  });

  it('returns a blocked work item to running when its session is resumed after release', () => {
    const h = new Harness();
    const { item, session } = running(h);

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item).status).toBe('blocked');
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'running', detail: null }] });

    expect(h.item(item)).toMatchObject({ status: 'running', error: null });
    expect(h.store.session(session)).toMatchObject({ outcome: null, outcomeDetail: null });
  });

  it('never releases a session resumed after its process ended, such as in a VS Code tab', () => {
    const h = new Harness();
    const { item, session } = running(h);

    h.act({ type: 'stop', workItemId: item });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    expect(h.store.session(session)?.released).toBe(true);

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'running', detail: null }] });
    expect(h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'idle', detail: null }] })).toEqual([]);
    expect(h.store.session(session)?.state).toBe('idle');
  });

  it('never releases a session the roster lists as interactive, even if its end was not observed', () => {
    const h = new Harness();
    const { session } = running(h);

    expect(h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'idle', detail: null, interactive: true }] })).toEqual([]);
    expect(h.store.session(session)).toMatchObject({ state: 'idle', released: true });
  });

  it('leaves a starting session alone until its start is confirmed', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const start = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    h.act({ type: 'roster', sessions: [] });
    h.act({ type: 'marker', sessionId: start.sessionId, state: 'idle', detail: null });

    expect(h.store.session(start.sessionId)?.state).toBe('starting');
  });

  it("fails a start with Claude's message, and Retry starts a new session with a re-rendered prompt", () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const first = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    h.act({ type: 'session-start-failed', sessionId: first.sessionId, message: 'Workspace not trusted' });

    expect(h.item(1)).toMatchObject({ status: 'failed', failedStep: 'task', error: 'Workspace not trusted' });
    expect(h.store.session(first.sessionId)).toMatchObject({ state: 'ended', outcome: 'failed', outcomeDetail: 'Workspace not trusted' });

    const second = only(h.act({ type: 'retry', workItemId: 1 }), 'start-session');

    expect(second.sessionId).toBe('s2');
    expect(second.prompt).toBe('Answer Issue 1.\nA summary.' + CONTRACT('s2'));

  });

  it('applies only reports from the latest session', () => {
    const h = new Harness();
    const { item, session } = running(h);

    h.now += 10;
    h.report(session, { kind: 'stage', stage: 'Planning' });
    expect(h.item(item)).toMatchObject({ stage: 'Planning', stageAt: T0 + 10 });

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.act({ type: 'retry', workItemId: item })).toEqual([]);
    expect(h.status(item)).toBe('queued');
    const retry = h.started(h.act({ type: 'roster', sessions: [] })[0]);

    h.report(session, { kind: 'done' });
    expect(h.item(item).status).toBe('running');
    expect(h.store.session(session)?.outcome).toBe('done');

    h.report(session, { kind: 'stage', stage: 'Old session' });
    expect(h.item(item).stage).toBe('Planning');

    h.report(retry, { kind: 'done' });
    expect(h.item(item).status).toBe('done');
  });

  it('refuses a report for an unknown session', () => {
    const h = new Harness();

    expect(h.report('s9', { kind: 'stage', stage: 'x' })).toEqual({ actions: [], refused: 'Unknown session s9.' });
  });

  it('keeps reports after the operator marks a work item done from reopening it', () => {
    const h = new Harness();
    const { item, session } = running(h);

    h.act({ type: 'mark-done', workItemId: item });
    h.report(session, { kind: 'approval', prompt: '/publish', summary: null, report: null });

    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'operator' });
    expect(h.send({ type: 'mark-done', workItemId: item }).refused).toBe('The work item is done.');

    expect(h.act({ type: 'stop', workItemId: item })).toEqual([{ type: 'stop-session', sessionId: session, shortId: 'abc12345', reason: 'operator' }]);
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'operator', error: null });
    expect(h.store.session(session)?.state).toBe('ended');
  });
});

describe('stop', () => {
  it('blocks the work item once the stop succeeds, and keeps the session stoppable when it fails', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);

    expect(h.act({ type: 'stop', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: session, shortId: 'abc12345', reason: 'operator' }]);
    expect(h.status(1)).toBe('running');

    h.act({ type: 'stop-failed', sessionId: session, reason: 'operator', message: 'timed out' });
    expect(h.item(1)).toMatchObject({ status: 'running', error: 'Stop failed: timed out' });
    expect(h.act({ type: 'stop', workItemId: 1 })).toHaveLength(1);

    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    expect(h.item(1)).toMatchObject({ status: 'blocked', failedStep: 'task', error: 'Stopped by you.' });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', outcome: 'stopped', outcomeDetail: 'Stopped by you.' });
    expect(h.send({ type: 'stop', workItemId: 1 }).refused).toBe('The work item has no active session.');
    expect(h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' })).toEqual([]);
  });

  it('notes a failed release on the work item', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'stop-failed', sessionId: session, reason: 'release', message: 'exit 1' });

    expect(h.item(1)).toMatchObject({ status: 'blocked', error: 'Release failed: exit 1' });
  });
});

describe('setup', () => {
  function toSetup(h: Harness): string {
    const [triage] = h.poll(issue('15619'));
    const start = only(h.triaged(triage, 'dev:develop'), 'start-session');

    expect(start).toMatchObject({ kind: 'setup', cwd: 'D:/git/widgets', name: 'switchboard · setup · github 15619', permissionMode: 'auto', model: null });
    expect(start.prompt).toBe('/init-worktree 15619' + CONTRACT(start.sessionId));
    expect(h.item(1)).toMatchObject({ status: 'setup', taskPrompt: null });

    return h.started(start);
  }

  it('starts the task in the reported worktree once the setup session ends, in the same slot', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 } }) });
    const setup = toSetup(h);

    h.report(setup, { kind: 'worktree', path: 'D:/git/widgets-wt/15619', branch: '15619-fix' });
    h.report(setup, { kind: 'done' });
    expect(h.status(1)).toBe('setup');

    expect(h.act({ type: 'marker', sessionId: setup, state: 'idle', detail: null })).toEqual([{ type: 'stop-session', sessionId: setup, shortId: 'abc12345', reason: 'release' }]);

    const task = only(h.act({ type: 'stop-succeeded', sessionId: setup, reason: 'release' }), 'start-session');

    expect(task).toMatchObject({ kind: 'task', cwd: 'D:/git/widgets-wt/15619', prompt: '/gc-plan 15619' + CONTRACT(task.sessionId), name: 'switchboard · dev:develop · github 15619' });
    expect(h.status(1)).toBe('running');
  });

  it('accepts a worktree found by branch convention, and a report replaces it', () => {
    const h = new Harness();
    const setup = toSetup(h);

    h.act({ type: 'worktree-found', source: 'github', sourceKey: '15619', path: 'D:/wt/conv', branch: '15619-x' });
    h.act({ type: 'worktree-found', source: 'github', sourceKey: '15619', path: 'D:/wt/other', branch: '15619-y' });
    expect(h.store.worktreeFor(1)).toMatchObject({ path: 'D:/wt/conv', linkedBy: 'convention' });

    h.report(setup, { kind: 'worktree', path: 'D:/wt/new', branch: null });
    expect(h.store.worktreeFor(1)).toMatchObject({ path: 'D:/wt/new', linkedBy: 'report' });

    const task = only(h.act({ type: 'roster', sessions: [] }), 'start-session');
    expect(task.cwd).toBe('D:/wt/new');
  });

  it('fails when the setup session ends without a worktree, and Retry starts a new setup', () => {
    const h = new Harness();
    const setup = toSetup(h);

    h.act({ type: 'roster', sessions: [] });
    expect(h.item(1)).toMatchObject({ status: 'failed', failedStep: 'setup', error: 'Setup ended without a worktree.' });

    const again = only(h.act({ type: 'retry', workItemId: 1 }), 'start-session');
    expect(again.kind).toBe('setup');
    expect(setup).toBe('s1');
  });

  it('blocks when the operator stops setup, and starts the task when setup had already reported done', () => {
    const h = new Harness();
    const setup = toSetup(h);
    h.act({ type: 'stop', workItemId: 1 });
    h.act({ type: 'stop-succeeded', sessionId: setup, reason: 'operator' });
    expect(h.item(1)).toMatchObject({ status: 'blocked', failedStep: 'setup', error: 'Stopped by you.' });

    const again = h.started(only(h.act({ type: 'retry', workItemId: 1 }), 'start-session'));
    h.report(again, { kind: 'worktree', path: 'D:/wt/1', branch: null });
    h.report(again, { kind: 'done' });
    const task = only(h.act({ type: 'stop-succeeded', sessionId: again, reason: 'operator' }), 'start-session');
    expect(task).toMatchObject({ kind: 'task', cwd: 'D:/wt/1' });
  });

  it('fails when the source has no setup prompt', () => {
    const h = new Harness();
    h.settings.sources['github']!.setupPrompt = '';
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:develop');

    expect(h.item(1)).toMatchObject({ status: 'failed', failedStep: 'setup', error: 'sources.github.setupPrompt is not set.' });

    h.settings.sources['github']!.setupPrompt = '/init {{worktree}}';
    h.act({ type: 'retry', workItemId: 1 });
    expect(h.item(1).error).toBe('sources.github.setupPrompt: Unknown template variable: worktree.');
  });

  it('skips setup when the ticket already has a worktree, and workdir repoRoot ignores the worktree', () => {
    const h = new Harness();
    h.poll(issue('1'), issue('2'));
    h.act({ type: 'worktree-found', source: 'github', sourceKey: '1', path: 'D:/wt/1', branch: '1-x' });
    h.act({ type: 'worktree-found', source: 'github', sourceKey: '2', path: 'D:/wt/2', branch: '2-x' });
    h.act({ type: 'worktree-found', source: 'github', sourceKey: 'unknown', path: 'D:/wt/3', branch: '3-x' });

    const develop = only(h.triaged({ type: 'triage', triageId: 1, workItemId: 1, ticket: h.store.ticket(1)! } as FlowAction, 'dev:develop'), 'start-session');
    const defect = only(h.triaged({ type: 'triage', triageId: 2, workItemId: 2, ticket: h.store.ticket(2)! } as FlowAction, 'support:defect'), 'start-session');

    expect(develop).toMatchObject({ kind: 'task', cwd: 'D:/wt/1' });
    expect(defect).toMatchObject({ kind: 'task', cwd: 'D:/git/widgets', prompt: 'Research 2 in https://github.com/acme/widgets/issues/2.' + CONTRACT(defect.sessionId) });
  });
});

describe('limits and the one-active-session rule', () => {
  it('queues starts beyond the concurrency limit and starts them in order as slots free', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'), issue('3'));

    const first = only(h.triaged(triages[0], 'support:defect'), 'start-session');
    expect(h.triaged(triages[1], 'support:defect')).toEqual([]);
    expect(h.triaged(triages[2], 'support:defect')).toEqual([]);
    expect([1, 2, 3].map((id) => h.status(id))).toEqual(['running', 'queued', 'queued']);

    h.started(first);
    const next = only(h.act({ type: 'roster', sessions: [] }), 'start-session');

    expect(next.workItemId).toBe(2);
    expect(h.status(3)).toBe('queued');
  });

  it('frees the slot of a session waiting on the operator, and takes it back only for new starts once it runs again', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'), issue('3'));
    const first = h.started(only(h.triaged(triages[0], 'support:defect'), 'start-session'));
    h.triaged(triages[1], 'support:defect');
    h.triaged(triages[2], 'support:defect');

    expect(h.act({ type: 'marker', sessionId: first, state: 'running', detail: null })).toEqual([]);

    const second = only(h.act({ type: 'marker', sessionId: first, state: 'waiting', detail: null }), 'start-session');
    expect(second.workItemId).toBe(2);
    h.started(second);

    expect(h.act({ type: 'marker', sessionId: first, state: 'running', detail: null })).toEqual([]);
    expect(h.act({ type: 'roster', sessions: [{ sessionId: first, state: 'running', detail: null }] })).toEqual([]);
    expect([1, 2, 3].map((id) => h.status(id))).toEqual(['running', 'blocked', 'queued']);

    const third = only(h.act({ type: 'roster', sessions: [] }), 'start-session');
    expect(third.workItemId).toBe(3);
  });

  it('keeps one work item when its ticket is assigned again while the work item is open', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const session = h.started(only(h.triaged(triage, 'support:defect'), 'start-session'));

    h.poll();
    expect(h.item(1)).toMatchObject({ status: 'running', unassignedAt: T0 });

    expect(h.poll(issue('1'))).toEqual([]);
    expect(h.store.workItem(2)).toBeNull();
    expect(h.item(1).unassignedAt).toBeNull();

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: 'The turn ended without a done report.', warning: null });
  });

  it('holds a reassigned ticket’s new work item while the done work item’s session is still active', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const session = h.started(only(h.triaged(triage, 'support:defect'), 'start-session'));

    h.report(session, { kind: 'done' });
    h.poll();
    const [again] = h.poll(issue('1'));
    expect(h.triaged(again, 'support:defect')).toEqual([]);
    expect(h.status(2)).toBe('queued');

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    const next = only(h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' }), 'start-session');
    expect(next.workItemId).toBe(2);
  });

  it('finishes a deferred unassignment with a warning when the session ends its turn, fails to start, or is stopped', () => {
    const cases: [string, (h: Harness, session: string) => void][] = [
      ['idle', (h, s) => h.act({ type: 'marker', sessionId: s, state: 'idle', detail: null })],
      ['ended', (h) => h.act({ type: 'roster', sessions: [] })],
      ['start failed', (h, s) => h.act({ type: 'session-start-failed', sessionId: s, message: 'x' })],
      ['stopped', (h, s) => h.act({ type: 'stop-succeeded', sessionId: s, reason: 'operator' })],
    ];

    for (const [name, end] of cases) {
      const h = new Harness();
      const [triage] = h.poll(issue('1'));
      const start = only(h.triaged(triage, 'support:defect'), 'start-session');

      if (name !== 'start failed') {
        h.started(start);
      }

      h.poll();
      end(h, start.sessionId);

      expect({ name, ...h.item(1) }).toMatchObject({ name, status: 'done', doneReason: 'unassigned', warning: 'The ticket left the assigned state without a done report.' });
    }
  });

  it('finishes a deferred unassignment with a warning when a setup session ends', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const setup = h.started(only(h.triaged(triage, 'dev:develop'), 'start-session'));

    h.report(setup, { kind: 'worktree', path: 'D:/wt/1', branch: null });
    h.poll();
    expect(h.act({ type: 'roster', sessions: [] })).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'done', doneReason: 'unassigned', warning: 'The ticket left the assigned state without a done report.' });
  });
});

describe('operator actions', () => {
  it('refuses Triage again with an active session', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');

    h.started(h.act({ type: 'start', workItemId: 1 })[0]);
    expect(h.send({ type: 'retriage', workItemId: 1 }).refused).toBe('The work item has an active session.');
  });

  it('triages again, refusing while triage runs', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));

    expect(h.send({ type: 'retriage', workItemId: 1 }).refused).toBe('Triage is already running.');
    h.triaged(triage, 'dev:question');

    const again = only(h.act({ type: 'retriage', workItemId: 1 }), 'triage');
    expect(h.store.triage(again.triageId)).toMatchObject({ workItemId: 1, endedAt: null });
    h.triaged(again, 'support:defect');
    expect(h.item(1).playbook).toBe('support:defect');
  });

  it('refuses actions that do not apply', () => {
    const h = new Harness();
    h.poll(issue('1'));

    expect(h.send({ type: 'approve', workItemId: 1 }).refused).toBe('The work item is not awaiting approval.');
    expect(h.send({ type: 'start', workItemId: 1 }).refused).toBe('The work item is not unstarted.');
    expect(h.send({ type: 'retry', workItemId: 1 }).refused).toBe('Only a failed or blocked work item can be retried.');
    expect(h.send({ type: 'approve', workItemId: 7 }).refused).toBe('Unknown work item 7.');
  });

  it('fails a start whose playbook is no longer loaded or does not render', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'dev:bad': '---\ndescription: Bad\n---\nUse {{nope}}.' }) });
    const triages = h.poll(issue('1'), issue('2'));
    h.triaged(triages[0], 'dev:question');
    h.triaged(triages[1], 'dev:bad');

    h.playbooks.delete('dev:question');
    h.act({ type: 'start', workItemId: 1 });
    h.act({ type: 'start', workItemId: 2 });

    expect(h.item(1)).toMatchObject({ status: 'failed', failedStep: 'task', error: 'Playbook dev:question is not loaded.' });
    expect(h.item(2)).toMatchObject({ status: 'failed', error: 'Playbook dev:bad: Unknown template variable: nope.' });
  });
});

describe('ad-hoc', () => {
  it('starts the typed prompt in the chosen repo as the operator, numbering tickets locally', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 } }) });
    const start = only(h.act({ type: 'adhoc', prompt: '  Write hello.txt\nthen report done', repoRoot: 'D:/scratch' }), 'start-session');

    expect(start).toEqual({
      type: 'start-session',
      sessionId: 's1',
      workItemId: 1,
      kind: 'task',
      cwd: 'D:/scratch',
      prompt: '  Write hello.txt\nthen report done' + CONTRACT('s1'),
      name: 'switchboard · ad-hoc · adhoc 1',
      permissionMode: 'auto',
      model: null,
    });
    expect(h.store.ticket(1)).toMatchObject({ source: 'adhoc', sourceKey: '1', title: 'Write hello.txt', repoRoot: 'D:/scratch' });
    expect(h.item(1)).toMatchObject({ playbook: null, taskPrompt: '  Write hello.txt\nthen report done', status: 'running' });

    h.act({ type: 'adhoc', prompt: 'Second', repoRoot: 'D:/scratch' });
    expect(h.store.ticket(2)).toMatchObject({ sourceKey: '2', ref: '#2' });
    expect(h.status(2)).toBe('queued');

    expect(h.send({ type: 'retriage', workItemId: 1 }).refused).toBe('The work item has an active session.');
    expect(h.send({ type: 'retriage', workItemId: 2 }).refused).toBe('An ad-hoc work item is not triaged.');
  });

  it('refuses an empty prompt or no repo', () => {
    const h = new Harness();

    expect(h.send({ type: 'adhoc', prompt: ' \n', repoRoot: 'D:/x' }).refused).toBe('The prompt is empty.');
    expect(h.send({ type: 'adhoc', prompt: 'Hi', repoRoot: '' }).refused).toBe('Choose a repo for the prompt.');
    expect(h.store.tickets('adhoc')).toEqual([]);
  });

  it('fails a start with no repo root configured', () => {
    const h = new Harness();
    h.settings.sources['github']!.repoRoot = '';
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'support:defect');

    expect(h.item(1)).toMatchObject({ status: 'failed', failedStep: 'task', error: 'sources.github.repoRoot is not set.' });
  });
});

describe('in-queue times (PRD R27)', () => {
  const entered = (key: string, enteredAt: number | null, assigned = true): PolledTicket => ({ ...issue(key, assigned), enteredAt });

  it("takes the source's scope entry whenever it has one, even across a status outside the assigned ones", () => {
    const h = new Harness();
    h.poll(entered('1', T0 - 5_000), entered('2', T0 - 1_000, false));
    expect(['1', '2'].map((key) => h.store.findTicket('github', key)?.scopeAt)).toEqual([T0 - 5_000, T0 - 1_000]);

    // Out of the assigned statuses and back with the same assignment: the clock does not restart.
    h.now = T0 + 1_000;
    h.poll(entered('1', T0 - 5_000, false), entered('2', T0 - 1_000));
    h.now = T0 + 2_000;
    h.poll(entered('1', T0 - 5_000), entered('2', T0 - 1_000));
    expect(['1', '2'].map((key) => h.store.findTicket('github', key)?.scopeAt)).toEqual([T0 - 5_000, T0 - 1_000]);

    // A new assignment moves it.
    h.now = T0 + 3_000;
    h.poll(entered('1', T0 + 2_500), entered('2', T0 - 1_000));
    expect(h.store.findTicket('github', '1')?.scopeAt).toBe(T0 + 2_500);
  });

  it("without a source time, takes the poll's time once and keeps it, also across a status outside the assigned ones", () => {
    const h = new Harness();
    h.poll(entered('1', null), entered('2', null, false));
    expect(['1', '2'].map((key) => h.store.findTicket('github', key)?.scopeAt)).toEqual([T0, null]);

    h.now = T0 + 1_000;
    h.poll(entered('1', null, false), entered('2', null));
    h.now = T0 + 2_000;
    h.poll(entered('1', null), entered('2', null));
    expect(['1', '2'].map((key) => h.store.findTicket('github', key)?.scopeAt)).toEqual([T0, T0 + 1_000]);
  });

  it('keeps the scope entry on a work item when it is done, so a later return does not move it', () => {
    const h = new Harness();
    h.poll(entered('1', T0 - 5_000));
    h.now = T0 + 1_000;
    h.poll();
    expect(h.item(1)).toMatchObject({ status: 'done', scopeAt: T0 - 5_000, doneAt: T0 + 1_000 });

    h.now = T0 + 2_000;
    h.poll(entered('1', T0 + 1_500));
    expect(h.store.findTicket('github', '1')?.scopeAt).toBe(T0 + 1_500);
    expect(h.item(1).scopeAt).toBe(T0 - 5_000);

    // A ticket with no scope entry, such as one done before migration 6 polled it, keeps the work item's creation.
    const g = new Harness();
    g.store.insertTicket({ source: 'github', sourceKey: '9', ref: '#9', sourceId: null, title: 't', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
    g.store.insertWorkItem({ ...h.item(1), ticketId: 1, status: 'unstarted', createdAt: T0 - 7_000, scopeAt: null, doneAt: null, doneReason: null });
    g.now = T0 + 9_000;
    g.act({ type: 'mark-done', workItemId: 1 });
    expect(g.item(1)).toMatchObject({ status: 'done', scopeAt: T0 - 7_000 });
  });

  it('moves statusAt on each status change, and runStartedAt only when a run starts from another status', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    expect(h.item(1)).toMatchObject({ status: 'triaging', statusAt: T0, runStartedAt: T0 });

    h.now = T0 + 1_000;
    h.triaged(triage, 'dev:question');
    expect(h.item(1)).toMatchObject({ status: 'unstarted', statusAt: T0 + 1_000, runStartedAt: T0 });

    h.now = T0 + 2_000;
    const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);
    expect(h.item(1)).toMatchObject({ status: 'running', statusAt: T0 + 2_000, runStartedAt: T0 + 2_000 });

    // A status that stays the same keeps its time.
    h.now = T0 + 3_000;
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.item(1)).toMatchObject({ statusAt: T0 + 2_000, runStartedAt: T0 + 2_000 });

    h.now = T0 + 4_000;
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(1)).toMatchObject({ status: 'blocked', statusAt: T0 + 4_000, runStartedAt: T0 + 2_000 });

    h.now = T0 + 5_000;
    h.act({ type: 'roster', sessions: [] });
    h.act({ type: 'retry', workItemId: 1 });
    expect(h.item(1)).toMatchObject({ statusAt: T0 + 5_000, runStartedAt: T0 + 5_000 });
  });
});
