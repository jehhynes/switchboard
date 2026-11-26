import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { MESSAGES, nothingNew } from '../src/flow.js';
import { failedAtTriage } from '../src/group.js';
import { HOUR, Harness, MINUTE, T0, issue, playbooks, settings } from './flowHarness.js';
import { CONTRACT, QUESTION_REPORTS, FINISHING_REPORTS, only } from './flowFixtures.js';

describe('assigned-state transitions', () => {
  it('gives every assigned ticket a work item on the first poll and triages up to the concurrency limit', () => {
    const h = new Harness();
    const actions = h.poll(issue('1'), issue('2'), issue('3'), issue('4', false));

    expect(actions.map((action) => action.type === 'triage' && action.workItemId)).toEqual([1, 2]);
    expect(actions[0]).toEqual({
      type: 'triage',
      triageId: 1,
      workItemId: 1,
      ticket: { id: 1, source: 'github', sourceKey: '1', ref: '#1', repo: '', sourceId: null, title: 'Issue 1', url: 'https://github.com/acme/widgets/issues/1', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: T0, lastPolledAt: T0, repoRoot: '', adhocKey: null, hostWindow: null, handledAssignmentKey: null, snoozeComment: null, blockers: [] },
      systemPrompt: 'Classify the GitHub issue.\n\nChoose one playbook:\n- dev:develop: Plan and build the change\n- dev:question: Answer a question\n- support:defect: Research a defect',
      choices: [
        { name: 'dev:develop', description: 'Plan and build the change', focus: null },
        { name: 'dev:question', description: 'Answer a question', focus: null },
        { name: 'support:defect', description: 'Research a defect', focus: null },
      ],
      rates: false,
      model: null,
      timeoutSeconds: 180,
      handled: null,
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

  it('deletes a work item that never had a session, with its triage, when its ticket leaves, and creates a new one when it returns', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    expect(h.status(1)).toBe('unstarted');
    h.poll();

    expect(h.store.workItem(1)).toBeNull();
    expect(h.store.triage(1)).toBeNull();
    expect(h.store.findTicket('github', '1')?.assigned).toBe(false);

    h.poll(issue('1', false));
    expect(h.store.workItem(2)).toBeNull();

    const actions = h.poll(issue('1'));

    expect(h.item(2)).toMatchObject({ ticketId: 1, status: 'triaging' });
    expect(only(actions, 'triage').workItemId).toBe(2);
  });

  it('deletes a work item whose ticket left during its triage only when the triage succeeds, fails or is cancelled, so the triage keeps its slot', () => {
    const h = new Harness({ settings: settings({ triage: { concurrency: 3 } }) });
    const [a] = h.poll(issue('1'), issue('2'), issue('3'), issue('4'));

    expect(h.poll(issue('4'))).toEqual([]);
    expect([1, 2, 3].map((id) => h.item(id))).toMatchObject([1, 2, 3].map(() => ({ status: 'triaging', unassignedAt: T0 })));

    expect(only(h.triaged(a, 'dev:question'), 'triage').workItemId).toBe(4);
    h.act({ type: 'triage-failed', triageId: 2, error: 'late', context: null });
    h.act({ type: 'triage-cancelled', triageId: 3 });

    for (const id of [1, 2, 3]) {
      expect(h.store.workItem(id)).toBeNull();
      expect(h.store.triage(id)).toBeNull();
    }
    expect(h.status(4)).toBe('triaging');
  });

  it('keeps a work item whose ticket left during its triage and returned before the triage ended', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.poll();
    h.poll(issue('1'));

    expect(h.item(1)).toMatchObject({ status: 'triaging', unassignedAt: null });
    h.triaged(triage, 'dev:question');
    expect(h.item(1).status).toBe('unstarted');
  });

  it('ignores a late triage result for a deleted work item', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.act({ type: 'triage-failed', triageId: 1, error: 'first', context: null });
    expect(h.status(1)).toBe('failed');
    h.poll();
    expect(h.store.workItem(1)).toBeNull();

    expect(h.triaged(triage, 'dev:question')).toEqual([]);
    expect(h.act({ type: 'triage-failed', triageId: 1, error: 'late', context: null })).toEqual([]);
    expect(h.store.triage(1)).toBeNull();
  });

  it('treats a ticket the poll reports as not assigned like one missing from the poll', () => {
    const h = new Harness();
    h.triaged(h.poll(issue('1'))[0], 'dev:question');
    h.poll(issue('1', false));

    expect(h.store.workItem(1)).toBeNull();
  });

  it('records a late triage result for a work item that is already done without changing it, and ignores a repeated result', () => {
    const h = new Harness();
    const [first, second] = h.poll(issue('1'), issue('2'));
    h.act({ type: 'mark-done', workItemId: 1 });
    h.act({ type: 'mark-done', workItemId: 2 });

    expect(h.triaged(first, 'dev:question')).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'done', playbook: null });
    expect(h.store.triage(1)).toMatchObject({ playbook: 'dev:question' });

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

    expect(h.triaged(triage, 'dev:question')).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'unstarted', playbook: 'dev:question' });
    expect(h.send({ type: 'approve', workItemId: 1 }).refused).toBe('The work item is not awaiting approval.');

    const start = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    expect(start).toEqual({
      type: 'start-session',
      provider: 'claude',
      sessionId: 's1',
      workItemId: 1,
      kind: 'task',
      cwd: 'D:/git/widgets',
      prompt: 'Answer Issue 1.\nContext 1',
      contract: CONTRACT('s1', QUESTION_REPORTS),
      name: 'switchboard · dev:question · github 1',
      permissionMode: 'plan',
      model: 'opus',
      codeMode: true,
      withoutCodeMode: true,
      nativeSessionId: 'uuid-1',
      launchId: 'uuid-2',
    });
    expect(h.item(1)).toMatchObject({ status: 'running', taskPrompt: start.prompt });
    expect(h.store.session('s1')).toMatchObject({ kind: 'task', state: 'starting', cwd: 'D:/git/widgets', provider: 'claude' });
  });

  it('fails on a classifier error and triages again on Retry', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));

    h.act({ type: 'triage-failed', triageId: (triage as Extract<FlowAction, { type: 'triage' }>).triageId, error: 'Timed out after 180 seconds.', context: 'ctx' });
    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'Timed out after 180 seconds.' });
    expect(h.store.triage(1)).toMatchObject({ endedAt: T0, error: 'Timed out after 180 seconds.', context: 'ctx' });

    expect(failedAtTriage({ ...h.item(1), triage: h.store.triagesFor(1).at(-1)! })).toBe(true);
    const again = only(h.act({ type: 'retry', workItemId: 1 }), 'triage');
    expect(again).toMatchObject({ triageId: 2, workItemId: 1 });
    expect(h.item(1)).toMatchObject({ status: 'triaging', error: null });
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

    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'Triage chose an unknown playbook: triage:github.' });
    expect(h.store.triage(1)).toMatchObject({ endedAt: T0, playbook: null, error: 'Triage chose an unknown playbook: triage:github.', context: 'Context 1' });
  });

  it('renders {{playbooks}} into the classifier instructions in place of the appended list', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'triage:github': { description: 'Triage', kind: 'triage', template: 'Pick one:\n{{playbooks}}\nThen summarize.\n' } }) });
    const [triage] = h.poll(issue('1'));

    expect(triage).toMatchObject({ type: 'triage', systemPrompt: 'Pick one:\n- dev:develop: Plan and build the change\n- dev:question: Answer a question\n- support:defect: Research a defect\nThen summarize.\n' });
  });

  it('fails on configuration errors with a failed triage, so the work item failed at triage', () => {
    const failedTriage = (h: Harness, error: string) => {
      expect(h.item(1)).toMatchObject({ status: 'failed', error });
      expect(h.store.triagesFor(1)).toMatchObject([{ workItemId: 1, startedAt: T0, endedAt: T0, playbook: null, error }]);
      expect(failedAtTriage({ ...h.item(1), triage: h.store.triagesFor(1).at(-1)! })).toBe(true);
    };

    const variable = new Harness({ playbooks: playbooks(undefined, { 'triage:github': { description: 'Triage', kind: 'triage', template: '{{ticket.title}}\n' } }) });
    variable.poll(issue('1'));
    failedTriage(variable, 'Triage playbook triage:github: Unknown template variable: ticket.title.');

    const missing = new Harness({ playbooks: playbooks(['dev:question']) });
    missing.poll(issue('1'));
    failedTriage(missing, 'Triage playbook triage:github is not loaded.');

    const none = new Harness({ playbooks: playbooks(['triage:github']) });
    none.poll(issue('1'));
    failedTriage(none, 'No task playbooks to choose from.');

    const unset = new Harness();
    unset.settings.sources['github']!.triagePlaybook = '';
    unset.poll(issue('1'));
    failedTriage(unset, 'sources.github.triagePlaybook is not set.');

    // Retry after the fix triages it again.
    unset.settings.sources['github']!.triagePlaybook = 'triage:github';
    expect(only(unset.act({ type: 'retry', workItemId: 1 }), 'triage')).toMatchObject({ triageId: 2, workItemId: 1 });
    expect(unset.item(1)).toMatchObject({ status: 'triaging', error: null });
  });

  it('leaves an auto-starting playbook unstarted when the triage found nothing newer than the earlier work item, and logs why (PRD R80)', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'), issue('2'));
    const succeeded = (triageId: number, stale?: boolean) => h.act({ type: 'triage-succeeded', triageId, context: 'c', playbook: 'support:defect', immediacy: null, severity: null, model: null, ...(stale === undefined ? {} : { stale }) });

    expect(succeeded((triage as Extract<FlowAction, { type: 'triage' }>).triageId, true)).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'unstarted', playbook: 'support:defect', error: MESSAGES.nothingNew });
    expect(only(h.act({ type: 'start', workItemId: 1 }), 'start-session').workItemId).toBe(1);
    expect(h.item(1).error).toBeNull();
    expect(h.store.ticketHistory(1)?.events.find((event) => event.type === 'triage-succeeded')?.detail).toMatchObject({ playbook: 'support:defect', stale: true });

    expect(only(succeeded(2, false), 'start-session').workItemId).toBe(2);
    expect(h.store.ticketHistory(2)?.events.find((event) => event.type === 'triage-succeeded')?.detail).not.toHaveProperty('stale');
  });

  it('finds nothing new only after an earlier work item, when the source reports no later activity (PRD R80)', () => {
    const handled = { at: T0, playbook: 'dev:develop' };

    expect([null, T0 - 1, T0, T0 + 1, undefined].map((activityAt) => nothingNew(handled, activityAt))).toEqual([true, true, true, false, false]);
    expect(nothingNew(null, null)).toBe(false);
  });

  it('keeps the first started task session as the cutoff after an approval starts another (PRD R80)', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const first = h.started(only(h.act({ type: 'start', workItemId: 1 }), 'start-session'));

    h.report(first, { kind: 'approval', prompt: '/publish', summary: 'Post it', report: null });
    h.act({ type: 'marker', sessionId: first, state: 'idle', detail: null });
    h.act({ type: 'stop-succeeded', sessionId: first, reason: 'release' });
    h.now = T0 + 10 * MINUTE;
    h.started(only(h.act({ type: 'approve', workItemId: 1 }), 'start-session'));
    expect(h.store.sessionsFor(1).filter((session) => session.kind === 'task').map((session) => session.startedAt)).toEqual([T0, T0 + 10 * MINUTE]);

    h.act({ type: 'mark-done', workItemId: 1 });
    h.poll();
    h.now = T0 + HOUR;
    const again = h.poll(issue('1')).find((action) => action.type === 'triage');

    expect(again).toMatchObject({ handled: { at: T0, playbook: 'dev:question' } });
  });
  it("gives triage the latest earlier work item's first task session start, or the operator's Mark done without a session, and skips a setup-only one and a task session that failed to start (PRD R80)", () => {
    const h = new Harness();
    const triageOf = (actions: FlowAction[]) => actions.find((action): action is Extract<FlowAction, { type: 'triage' }> => action.type === 'triage');
    const returned = (at: number) => {
      h.poll();
      h.now = at;
      return triageOf(h.poll(issue('1')))!;
    };

    const first = triageOf(h.poll(issue('1')))!;
    expect(first.handled).toBeNull();
    const session = h.started(only(h.triaged(first, 'support:defect'), 'start-session'));
    h.now = T0 + MINUTE;
    h.report(session, { kind: 'done' });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });

    const second = returned(T0 + HOUR);
    expect(second.handled).toEqual({ at: T0, playbook: 'support:defect' });
    h.act({ type: 'mark-done', workItemId: second.workItemId! });

    const third = returned(T0 + 2 * HOUR);
    expect(third.handled).toEqual({ at: T0 + HOUR, playbook: null });
    h.started(only(h.triaged(third, 'dev:develop'), 'start-session'));
    h.poll();
    h.act({ type: 'roster', sessions: [] });
    expect(h.item(third.workItemId!)).toMatchObject({ status: 'done', doneReason: 'unassigned' });

    const fourth = returned(T0 + 3 * HOUR);
    expect(fourth.handled).toEqual({ at: T0 + HOUR, playbook: null });
    const failed = only(h.triaged(fourth, 'support:defect'), 'start-session');
    h.act({ type: 'session-start-failed', sessionId: failed.sessionId, message: 'Untrusted folder.' });
    h.now = T0 + 3 * HOUR + 30 * MINUTE;
    h.act({ type: 'mark-done', workItemId: fourth.workItemId! });

    expect(returned(T0 + 4 * HOUR).handled).toEqual({ at: T0 + 3 * HOUR + 30 * MINUTE, playbook: 'support:defect' });
  });

});

describe('stop', () => {
  it('blocks the work item once the stop succeeds, and keeps the session stoppable when it fails', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);

    expect(h.act({ type: 'stop', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12345', reason: 'operator', codeMode: true }]);
    expect(h.status(1)).toBe('running');

    h.act({ type: 'stop-failed', sessionId: session, reason: 'operator', message: 'timed out' });
    expect(h.item(1)).toMatchObject({ status: 'running', error: 'Stop failed: timed out' });
    expect(h.act({ type: 'stop', workItemId: 1 })).toHaveLength(1);

    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });
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
    expect(start).toMatchObject({ prompt: '/init-worktree 15619', contract: CONTRACT(start.sessionId, FINISHING_REPORTS) });
    expect(h.item(1)).toMatchObject({ status: 'setup', taskPrompt: null });

    return h.started(start);
  }

  it('keeps a setup session that reported done when the ticket leaves and returns before it ends', () => {
    const h = new Harness();
    const setup = toSetup(h);

    h.report(setup, { kind: 'worktree', path: 'D:/git/widgets-wt/15619', branch: '15619-fix' });
    h.report(setup, { kind: 'done' });
    h.poll();
    expect(h.item(1)).toMatchObject({ status: 'setup', unassignedAt: T0 });

    h.poll(issue('15619'));
    expect(h.store.workItemsForTicket(1)).toHaveLength(1);
    expect(h.item(1)).toMatchObject({ status: 'setup', unassignedAt: null });
  });

  it('starts the task in the reported worktree once the setup session ends, in the same slot', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 } }) });
    const setup = toSetup(h);

    h.report(setup, { kind: 'worktree', path: 'D:/git/widgets-wt/15619', branch: '15619-fix' });
    h.report(setup, { kind: 'done' });
    expect(h.status(1)).toBe('setup');

    // The held setup session's turn end starts the task; the setup session keeps running until its idle end (PRD R95).
    const task = only(h.act({ type: 'marker', sessionId: setup, state: 'idle', detail: null }), 'start-session');

    expect(task).toMatchObject({ kind: 'task', cwd: 'D:/git/widgets-wt/15619', prompt: '/sb-plan 15619', contract: CONTRACT(task.sessionId, FINISHING_REPORTS), name: 'switchboard · dev:develop · github 15619' });
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
    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'Setup ended without a worktree.' });

    const again = only(h.act({ type: 'retry', workItemId: 1 }), 'start-session');
    expect(again).toMatchObject({ kind: 'setup', sessionId: 's2', prompt: '/init-worktree 15619' });
    expect(h.item(1)).toMatchObject({ status: 'setup', playbook: 'dev:develop', error: null });
    expect(setup).toBe('s1');
  });

  it('starts the task when a setup session the operator answers in a tab ends its turn with a worktree, though its process stays', () => {
    const h = new Harness();
    const setup = toSetup(h);
    const tab = (state: 'running' | 'idle') => h.act({ type: 'roster', sessions: [{ sessionId: setup, state, detail: null, interactive: true }] });

    h.act({ type: 'marker', sessionId: setup, state: 'waiting', detail: null });
    tab('running');
    expect(tab('idle')).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'setup' });

    tab('running');
    h.report(setup, { kind: 'worktree', path: 'D:/wt/1', branch: '15619-fix' });
    h.report(setup, { kind: 'done' });
    expect(h.status(1)).toBe('setup');

    const task = only(tab('idle'), 'start-session');
    expect(task).toMatchObject({ kind: 'task', cwd: 'D:/wt/1', prompt: '/sb-plan 15619' });
    expect(h.store.session(setup)).toMatchObject({ state: 'idle', outcome: 'done' });

    expect(h.act({ type: 'roster', sessions: [] })).toEqual([]);
    expect(h.status(1)).toBe('running');
  });

  it('retries setup when its session resumes after failing because its process was gone, and only then', () => {
    const h = new Harness();
    const setup = toSetup(h);
    const tab = (state: 'running' | 'idle') => h.act({ type: 'roster', sessions: [{ sessionId: setup, state, detail: null, interactive: true }] });

    h.act({ type: 'marker', sessionId: setup, state: 'waiting', detail: null });
    h.act({ type: 'roster', sessions: [] });
    expect(h.item(1)).toMatchObject({ status: 'failed', error: MESSAGES.setupWithoutWorktree });

    // Listed idle, the reopened tab has run no turn.
    expect(tab('idle')).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'failed', error: MESSAGES.setupWithoutWorktree });

    tab('running');
    expect(h.item(1)).toMatchObject({ status: 'setup', error: null });

    h.report(setup, { kind: 'worktree', path: 'D:/wt/1', branch: '15619-fix' });
    expect(only(tab('idle'), 'start-session')).toMatchObject({ kind: 'task', cwd: 'D:/wt/1' });
    expect(h.status(1)).toBe('running');
  });

  it('leaves a work item that failed for another cause failed when its setup session resumes', () => {
    const h = new Harness();
    const setup = toSetup(h);
    h.act({ type: 'roster', sessions: [] });
    h.store.updateWorkItem(1, { error: 'The start failed.' });

    h.act({ type: 'roster', sessions: [{ sessionId: setup, state: 'running', detail: null, interactive: true }] });
    expect(h.store.session(setup)?.state).toBe('running');
    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'The start failed.' });
  });

  it('blocks when the operator stops setup, and starts the task when setup had already reported done', () => {
    const h = new Harness();
    const setup = toSetup(h);
    h.act({ type: 'stop', workItemId: 1 });
    h.act({ type: 'stop-succeeded', sessionId: setup, reason: 'operator' });
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });

    const g = new Harness();
    const again = toSetup(g);
    g.report(again, { kind: 'worktree', path: 'D:/wt/1', branch: null });
    g.report(again, { kind: 'done' });
    g.act({ type: 'stop', workItemId: 1 });
    const task = only(g.act({ type: 'stop-succeeded', sessionId: again, reason: 'operator' }), 'start-session');
    expect(task).toMatchObject({ kind: 'task', cwd: 'D:/wt/1' });
  });

  it('fails when the source has no setup prompt', () => {
    const h = new Harness();
    h.settings.sources['github']!.setupPrompt = '';
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:develop');

    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'sources.github.setupPrompt is not set.' });

    h.settings.sources['github']!.setupPrompt = '/init {{worktree}}';
    expect(h.act({ type: 'retry', workItemId: 1 })).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'sources.github.setupPrompt: Unknown template variable: worktree.' });

    h.settings.sources['github']!.setupPrompt = '/init-worktree {{ticket.sourceKey}}';
    expect(only(h.act({ type: 'retry', workItemId: 1 }), 'start-session')).toMatchObject({ kind: 'setup', prompt: '/init-worktree 1' });
    expect(h.store.triagesFor(1)).toHaveLength(1);
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
    expect(defect).toMatchObject({ kind: 'task', cwd: 'D:/git/widgets', prompt: 'Research 2 in https://github.com/acme/widgets/issues/2.', contract: CONTRACT(defect.sessionId, ['stage', 'done', 'link', 'task']) });
  });
});
