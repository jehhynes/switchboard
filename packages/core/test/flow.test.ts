import { describe, expect, it } from 'vitest';
import type { FlowAction, PolledTicket } from '../src/flow.js';
import { MESSAGES, nothingNew, UNCONFIRMED_DONE } from '../src/flow.js';
import { HOUR, Harness, MINUTE, REPORT, T0, issue, playbooks, settings } from './flowHarness.js';
import { heldSlots } from '../src/queue.js';

/** The report contract offering `reports`, written out so a change to the contract shows here. */
const CONTRACT = (id: string, reports: string[] = ['stage', 'worktree', 'done', 'approval', 'link', 'task']) => {
  const lines: Record<string, string[]> = {
    stage: [`- ${REPORT} stage ${id} <stage>, when you start a new phase of the work.`, `  - The stage states the work now running and what it acts on as an -ing phrase of at most four words with no ending punctuation, optionally after a step count, such as 2/5 fixing tests.`],
    worktree: [`- ${REPORT} worktree ${id} <path>, when you create a worktree.`],
    done: [`- ${REPORT} done ${id}, when the entire work item is done: every part of the task is complete, and this session has nothing left to do and can be retired.`],
    approval: [
      `- ${REPORT} approval ${id} --prompt <prompt> --summary <text> --report <absolute path>, when the work is ready but posting or publishing it needs the operator's approval, then end your turn.`,
      `  - The prompt runs in a new session with no memory of this one, so it names what it acts on, such as /review-pr pr:123 publish.`,
      `  - The summary is one phrase of at most 8 words saying what Approve publishes, without counts.`,
      `  - The report is the file holding the text Approve publishes, such as a drafted comment; leave out --report when nothing is drafted.`,
    ],
    link: [`- ${REPORT} link ${id} --label <text> --target <url>, for each GitHub issue or pull request that tracks or delivers this work, such as one you create, but not a related, base or parent one.`],
    playbook: [`- ${REPORT} playbook ${id} <name>, when you hand the work to the skill of another playbook, such as dev:review-pr.`],
    paste: [
      `- ${REPORT} paste ${id} --label <text> --file <absolute path>, for each drafted text the operator pastes into the ticket by hand, such as --label "Customer reply".`,
      `  - The file holds only the text to paste. A later paste with the same label replaces the earlier one.`,
    ],
  };
  const finish = reports.includes('done') || reports.includes('approval') ? [] : ['', 'When the work is finished, end your turn; the operator reviews it.'];

  return [
    `Report to Switchboard with these commands:`,
    ...Object.keys(lines).filter((kind) => reports.includes(kind)).flatMap((kind) => lines[kind]!),
    `- ${REPORT} handled ${id} <ticket url> [--release <assignment key>], only when a skill directs it: register another ticket's current assignment as already handled before publishing it to the work queue; save the returned assignment key for an explicit release.`,
    ...finish,
    ``,
    `When you need the operator's answer or choice, or cannot continue without them, ask with AskUserQuestion and wait for the answer. Do not report or write a file for a question.`,
  ].join('\n');
};

const QUESTION_REPORTS = ['stage', 'approval', 'link', 'task'];
/** A playbook whose session may report done. */
const FINISH = { 'dev:finish': { description: 'Finish it', reports: ['done'], template: 'Finish {{ticket.sourceKey}}.' } };
/** A playbook whose session may report approval and done. */
const BOTH = { 'dev:both': { description: 'Both', reports: ['done', 'approval'], template: 'Do {{ticket.sourceKey}}.' } };
const FINISHING_REPORTS = ['stage', 'worktree', 'done', 'link', 'task'];

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
      ticket: { id: 1, source: 'github', sourceKey: '1', ref: '#1', sourceId: null, title: 'Issue 1', url: 'https://github.com/acme/widgets/issues/1', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: T0, lastPolledAt: T0, repoRoot: '', adhocKey: null, inQueue: false, assigneeId: null, handledAssignmentKey: null },
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
    });
    expect(h.item(1)).toMatchObject({ status: 'running', taskPrompt: start.prompt });
    expect(h.store.session('s1')).toMatchObject({ kind: 'task', state: 'starting', cwd: 'D:/git/widgets', provider: 'claude' });
  });

  it('fails on a classifier error and triages again on Triage again', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));

    h.act({ type: 'triage-failed', triageId: (triage as Extract<FlowAction, { type: 'triage' }>).triageId, error: 'Timed out after 180 seconds.', context: 'ctx' });
    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'Timed out after 180 seconds.' });
    expect(h.store.triage(1)).toMatchObject({ endedAt: T0, error: 'Timed out after 180 seconds.', context: 'ctx' });

    const again = only(h.act({ type: 'retriage', workItemId: 1 }), 'triage');
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

  it('fails on configuration errors', () => {
    const variable = new Harness({ playbooks: playbooks(undefined, { 'triage:github': { description: 'Triage', kind: 'triage', template: '{{ticket.title}}\n' } }) });
    variable.poll(issue('1'));
    expect(variable.item(1)).toMatchObject({ status: 'failed', error: 'Triage playbook triage:github: Unknown template variable: ticket.title.' });

    const missing = new Harness({ playbooks: playbooks(['dev:question']) });
    missing.poll(issue('1'));
    expect(missing.item(1)).toMatchObject({ status: 'failed', error: 'Triage playbook triage:github is not loaded.' });

    const none = new Harness({ playbooks: playbooks(['triage:github']) });
    none.poll(issue('1'));
    expect(none.item(1)).toMatchObject({ status: 'failed', error: 'No task playbooks to choose from.' });

    const unset = new Harness();
    unset.settings.sources['github']!.triagePlaybook = '';
    unset.poll(issue('1'));
    expect(unset.item(1)).toMatchObject({ status: 'failed', error: 'sources.github.triagePlaybook is not set.' });
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

describe('sessions', () => {
  function running(h: Harness, key = '1', playbook = 'dev:question'): { item: number; session: string } {
    const [triage] = h.poll(...[...h.store.tickets('github').filter((t) => t.assigned).map((t) => issue(t.sourceKey)), issue(key)]);
    const item = (triage as Extract<FlowAction, { type: 'triage' }>).workItemId!;
    h.triaged(triage, playbook);
    const session = h.started(h.act({ type: 'start', workItemId: item })[0]);

    return { item, session };
  }

  it('finishes the work item on a done report and releases the session once its turn ends', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { item, session } = running(h, '1', 'dev:finish');

    expect(h.report(session, { kind: 'done' }).actions).toEqual([]);
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'session', warning: null });

    expect(h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null })).toEqual([]);
    expect(h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12345', reason: 'release' }]);
    expect(h.act({ type: 'marker', sessionId: session, state: 'running', detail: null })).toEqual([]);
    expect(h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null })).toEqual([]);

    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', outcome: 'done', outcomeDetail: null, endedAt: T0 });
    expect(h.item(item).status).toBe('done');
  });

  it('keeps a done report whose ticket is still assigned open until the recheck, which blocks it while the ticket stays assigned (PRD R10)', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { item, session } = running(h, '1', 'dev:finish');

    expect(h.report(session, { kind: 'done', assigned: true })).toEqual({ actions: [], refused: null });
    expect(h.item(item)).toMatchObject({ status: 'running', error: null, doneAt: null });
    expect(h.store.session(session)?.outcome).toBe('done');

    expect(h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12345', reason: 'release' }]);
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });
    expect(h.item(item).status).toBe('running');

    h.act({ type: 'done-checked', sessionId: session, token: h.store.session(session)?.outcomeDetail ?? '', assigned: true });
    expect(h.item(item)).toMatchObject({ status: 'blocked', error: MESSAGES.doneStillAssigned, doneAt: null });

    h.poll();
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'unassigned' });
  });

  it('finishes a done report on a recheck that lists the ticket unassigned', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { item, session } = running(h, '1', 'dev:finish');

    h.report(session, { kind: 'done', assigned: true });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'done-checked', sessionId: session, token: h.store.session(session)?.outcomeDetail ?? '', assigned: false });
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'session', error: null });
  });

  it('finishes an unconfirmed or blocked done report when the ticket leaves while its session is still active (PRD R10)', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const a = running(h, '1', 'dev:finish');
    h.report(a.session, { kind: 'done', assigned: true });
    h.act({ type: 'marker', sessionId: a.session, state: 'idle', detail: null });
    expect(h.store.session(a.session)?.state).toBe('idle');

    const b = running(h, '2', 'dev:finish');
    h.report(b.session, { kind: 'done', assigned: true });
    h.act({ type: 'done-checked', sessionId: b.session, token: h.store.session(b.session)?.outcomeDetail ?? '', assigned: true });
    expect(h.item(b.item).status).toBe('blocked');

    h.poll();
    expect(h.item(a.item)).toMatchObject({ status: 'done', doneReason: 'unassigned' });
    expect(h.item(b.item)).toMatchObject({ status: 'done', doneReason: 'unassigned' });

    // The recheck arriving after the ticket left changes nothing.
    h.act({ type: 'done-checked', sessionId: a.session, token: h.store.session(a.session)?.outcomeDetail ?? '', assigned: true });
    expect(h.item(a.item)).toMatchObject({ status: 'done', doneReason: 'unassigned' });
  });

  it('keeps an approval reported after an unconfirmed done report open when the ticket leaves or the recheck arrives', () => {
    const h = new Harness({ playbooks: playbooks(undefined, BOTH) });
    const { item, session } = running(h, '1', 'dev:both');

    h.report(session, { kind: 'done', assigned: true });
    const token = h.store.session(session)!.outcomeDetail!;
    h.report(session, { kind: 'approval', prompt: '/review-pr pr:1 publish', summary: 'post the review', report: null });
    expect(h.item(item).status).toBe('awaiting-approval');

    h.act({ type: 'done-checked', sessionId: session, token, assigned: false });
    expect(h.item(item).status).toBe('awaiting-approval');

    h.poll();
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', unassignedAt: T0 });
  });

  it('drops an unconfirmed done report when the operator resumes its session, and settles only the later report', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { item, session } = running(h, '1', 'dev:finish');

    h.report(session, { kind: 'done', assigned: true });
    const first = h.store.session(session)!.outcomeDetail!;
    expect(first).toBe(`${UNCONFIRMED_DONE}; it was still assigned at ${new Date(T0).toISOString()}.`);
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.store.session(session)).toMatchObject({ outcome: null, outcomeDetail: null });

    h.act({ type: 'done-checked', sessionId: session, token: first, assigned: false });
    expect(h.item(item).status).toBe('running');

    h.now += 1_000;
    h.report(session, { kind: 'done', assigned: true });
    h.act({ type: 'done-checked', sessionId: session, token: first, assigned: true });
    expect(h.item(item).status).toBe('running');

    h.act({ type: 'done-checked', sessionId: session, token: h.store.session(session)!.outcomeDetail!, assigned: true });
    expect(h.item(item)).toMatchObject({ status: 'blocked', error: MESSAGES.doneStillAssigned });
    expect(h.store.session(session)?.outcomeDetail).toBeNull();
  });

  it('ignores a recheck after the operator resumes an ended session into a question, after an approval and a done report', () => {
    const both = { 'dev:both': { description: 'Both', reports: ['done', 'approval'], template: 'Do {{ticket.sourceKey}}.' } };
    const h = new Harness({ playbooks: playbooks(undefined, both) });
    const { item, session } = running(h, '1', 'dev:both');

    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: null });
    h.report(session, { kind: 'done', assigned: true });
    const token = h.store.session(session)!.outcomeDetail!;
    h.act({ type: 'roster', sessions: [] });
    expect(h.store.session(session)?.state).toBe('ended');

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'waiting', detail: null }] });
    expect(h.store.session(session)).toMatchObject({ state: 'waiting', outcome: null, outcomeDetail: null });

    h.act({ type: 'done-checked', sessionId: session, token, assigned: false });
    expect(h.item(item).status).toBe('awaiting-approval');
  });

  it('ignores a recheck after Triage again', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { item, session } = running(h, '1', 'dev:finish');

    h.report(session, { kind: 'done', assigned: true });
    const token = h.store.session(session)!.outcomeDetail!;
    h.act({ type: 'roster', sessions: [] });
    h.act({ type: 'retriage', workItemId: item });
    expect(h.item(item).status).toBe('triaging');

    h.act({ type: 'done-checked', sessionId: session, token, assigned: true });
    expect(h.item(item)).toMatchObject({ status: 'triaging', error: null });
  });

  it('settles a done report that follows an approval in the same turn, keeping the approval when it blocks', () => {
    const both = { 'dev:both': { description: 'Both', reports: ['done', 'approval'], template: 'Do {{ticket.sourceKey}}.' } };
    const h = new Harness({ playbooks: playbooks(undefined, both) });
    const a = running(h, '1', 'dev:both');
    const b = running(h, '2', 'dev:both');

    for (const { session } of [a, b]) {
      h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: null });
      h.report(session, { kind: 'done', assigned: true });
    }

    expect(h.item(a.item).status).toBe('awaiting-approval');
    h.act({ type: 'done-checked', sessionId: a.session, token: h.store.session(a.session)!.outcomeDetail!, assigned: false });
    expect(h.item(a.item)).toMatchObject({ status: 'done', doneReason: 'session' });

    h.act({ type: 'done-checked', sessionId: b.session, token: h.store.session(b.session)!.outcomeDetail!, assigned: true });
    expect(h.item(b.item)).toMatchObject({ status: 'blocked', approvalPrompt: '/publish' });
  });
  it('blocks on a turn that ends without a report, a failed turn, or a session that ends, but not while it waits on the operator', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const a = running(h, '1', 'dev:finish');
    h.act({ type: 'marker', sessionId: a.session, state: 'waiting', detail: null });
    expect(h.item(a.item)).toMatchObject({ status: 'running', error: null });

    const b = running(h, '2', 'dev:finish');
    h.act({ type: 'marker', sessionId: b.session, state: 'idle', detail: null });
    expect(h.item(b.item)).toMatchObject({ status: 'blocked', error: 'The turn ended without a done report.' });

    h.act({ type: 'marker', sessionId: b.session, state: 'running', detail: null });
    expect(h.item(b.item)).toMatchObject({ status: 'running', error: null });

    h.act({ type: 'marker', sessionId: b.session, state: 'failed', detail: 'rate_limit' });
    expect(h.item(b.item)).toMatchObject({ status: 'blocked', error: 'The turn failed: rate_limit.' });

    const c = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const d = running(c, '3', 'dev:finish');
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

  it("fails a start with Claude's message, and a start after Triage again renders the prompt for the new session", () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const first = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    h.act({ type: 'session-start-failed', sessionId: first.sessionId, message: 'Workspace not trusted' });

    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'Workspace not trusted' });
    expect(h.store.session(first.sessionId)).toMatchObject({ state: 'ended', outcome: 'failed', outcomeDetail: 'Workspace not trusted' });

    expect(h.triaged(only(h.act({ type: 'retriage', workItemId: 1 }), 'triage'), 'dev:question')).toEqual([]);
    const second = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    expect(second.sessionId).toBe('s2');
    expect(second).toMatchObject({ prompt: 'Answer Issue 1.\nContext 1', contract: CONTRACT('s2', QUESTION_REPORTS) });

  });

  it('applies only reports from the latest session', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { item, session } = running(h, '1', 'dev:finish');

    h.now += 10;
    h.report(session, { kind: 'stage', stage: 'Planning' });
    expect(h.item(item)).toMatchObject({ stage: 'Planning', stageAt: T0 + 10 });

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'roster', sessions: [] });
    h.triaged(only(h.act({ type: 'retriage', workItemId: item }), 'triage'), 'dev:finish');
    const retry = h.started(only(h.act({ type: 'start', workItemId: item }), 'start-session'));

    h.report(session, { kind: 'done' });
    expect(h.item(item).status).toBe('running');
    expect(h.store.session(session)?.outcome).toBe('done');

    h.report(session, { kind: 'stage', stage: 'Old session' });
    expect(h.item(item).stage).toBe('Planning');

    h.report(retry, { kind: 'done' });
    expect(h.item(item).status).toBe('done');
  });

  it('hands a work item to another task playbook in its namespace, and refuses any other', () => {
    const h = new Harness({
      playbooks: playbooks(undefined, { 'dev:other': { description: 'Route it', reports: ['done', 'playbook'], template: 'Route {{ticket.sourceKey}}.' }, 'dev:triage': { description: 'Dev triage', kind: 'triage', template: 'Classify it.' } }),
    });
    const { item, session } = running(h, '1', 'dev:other');

    expect(h.store.session(session)?.reports).toEqual(['stage', 'done', 'link', 'playbook', 'task']);
    expect(h.item(item).taskPrompt).toBe('Route 1.');

    for (const name of ['dev:missing', 'support:defect', 'triage:github', 'dev:triage']) {
      expect(h.report(session, { kind: 'playbook', playbook: name }).refused).toBe(`${name} is not a task playbook in the dev namespace.`);
    }

    expect(h.item(item).playbook).toBe('dev:other');
    expect(h.report(session, { kind: 'playbook', playbook: 'dev:question' }).refused).toBeNull();
    expect(h.item(item)).toMatchObject({ playbook: 'dev:question', status: 'running' });
    expect(h.store.session(session)?.reports).toEqual(['stage', 'done', 'link', 'playbook', 'task']);

    // A session whose playbook does not list it, and an ad-hoc prompt, cannot change the playbook.
    const other = running(h, '2');
    expect(h.report(other.session, { kind: 'playbook', playbook: 'dev:develop' }).refused).toBe("This session's report contract does not offer the playbook report.");
  });

  it('refuses a report the session was not offered, and ends a session that cannot report done or approval as finished, for review', () => {
    const h = new Harness();
    const a = running(h, '1');

    expect(h.store.session(a.session)?.reports).toEqual(QUESTION_REPORTS);
    expect(h.report(a.session, { kind: 'done' })).toEqual({ actions: [], refused: "This session's report contract does not offer the done report." });
    expect(h.report(a.session, { kind: 'worktree', path: 'D:/wt/1', branch: null }).refused).toBe("This session's report contract does not offer the worktree report.");
    expect(h.item(a.item)).toMatchObject({ status: 'running', doneAt: null });
    expect(h.store.session(a.session)?.outcome).toBeNull();
    expect(h.store.worktreeFor(h.item(a.item).ticketId)).toBeNull();

    h.act({ type: 'marker', sessionId: a.session, state: 'idle', detail: null });
    expect(h.item(a.item)).toMatchObject({ status: 'blocked', error: 'The turn ended without an approval report.' });

    expect(h.item(a.item).readyAt).toBeNull();

    // A playbook with no reports: its turn ending is the normal finish, ready for review.
    const read = () => new Harness({ playbooks: playbooks(undefined, { 'dev:read': { description: 'Read it', template: 'Read {{ticket.sourceKey}}.' } }) });
    const g = read();
    const b = running(g, '2', 'dev:read');

    expect(g.store.session(b.session)?.reports).toEqual(['stage', 'link', 'task']);
    g.now += 1000;
    g.act({ type: 'marker', sessionId: b.session, state: 'idle', detail: null });
    expect(g.item(b.item)).toMatchObject({ status: 'finished', error: null, readyAt: g.now });

    // Resumed in VS Code, it runs again and finishes again, keeping when it first became ready.
    const readyAt = g.now;
    g.now += 1000;
    g.act({ type: 'marker', sessionId: b.session, state: 'running', detail: null });
    expect(g.item(b.item)).toMatchObject({ status: 'running', readyAt });
    g.now += 1000;
    g.act({ type: 'marker', sessionId: b.session, state: 'idle', detail: null });
    expect(g.item(b.item)).toMatchObject({ status: 'finished', readyAt });

    const k = read();
    const c = running(k, '3', 'dev:read');
    k.act({ type: 'roster', sessions: [] });
    expect(k.item(c.item)).toMatchObject({ status: 'finished', error: null, readyAt: k.now });

    // A failed turn is a block, not a finish.
    const f = read();
    const d = running(f, '4', 'dev:read');
    f.act({ type: 'marker', sessionId: d.session, state: 'failed', detail: 'overloaded' });
    expect(f.item(d.item)).toMatchObject({ status: 'blocked', error: 'The turn failed: overloaded.', readyAt: null });
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

    expect(h.act({ type: 'stop', workItemId: item })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12345', reason: 'operator' }]);
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'operator', error: null });
    expect(h.store.session(session)?.state).toBe('ended');
  });

  it('reopens a work item whose session reported done mid-turn as running, so the turn end without a done report blocks it', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { item, session } = running(h, '1', 'dev:finish');
    h.report(session, { kind: 'done' });
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'session' });

    h.now += 1000;
    expect(h.send({ type: 'reopen', workItemId: item })).toEqual({ actions: [], refused: null });
    expect(h.item(item)).toMatchObject({ status: 'running', doneAt: null, doneReason: null, scopeAt: null, statusAt: h.now });
    expect(h.store.session(session)).toMatchObject({ outcome: null, outcomeDetail: null });

    h.report(session, { kind: 'stage', stage: 'fixing the rest' });
    expect(h.item(item).stage).toBe('fixing the rest');

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'blocked', error: MESSAGES.turnEnded });
  });

  it('reopens a work item whose session turn ended as finished, and a resume runs it again', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { item, session } = running(h, '1', 'dev:finish');
    h.report(session, { kind: 'done' });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });

    h.now += 1000;
    h.act({ type: 'reopen', workItemId: item });
    expect(h.item(item)).toMatchObject({ status: 'finished', readyAt: h.now, error: null });

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.item(item).status).toBe('running');
    h.report(session, { kind: 'done' });
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'session' });

    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', outcome: 'done' });
    h.act({ type: 'reopen', workItemId: item });
    expect(h.item(item).status).toBe('finished');
  });

  it('reopens a work item marked done before it started as unstarted', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    h.act({ type: 'mark-done', workItemId: 1 });

    h.act({ type: 'reopen', workItemId: 1 });
    expect(h.item(1)).toMatchObject({ status: 'unstarted', playbook: 'dev:question', doneAt: null });
  });

  it('clears a stopped outcome on reopen, so the resumed turn settles the work item and frees its slot', () => {
    const h = new Harness();
    const { item, session } = running(h);
    h.act({ type: 'stop', workItemId: item });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    h.act({ type: 'mark-done', workItemId: item });
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'running', detail: null, interactive: true }] });

    h.act({ type: 'reopen', workItemId: item });
    expect(h.item(item).status).toBe('running');
    expect(h.store.session(session)?.outcome).toBeNull();

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item).status).toBe('blocked');
    expect(heldSlots(h.store)).toBe(0);
  });

  it('refuses to reopen a work item whose ticket another session handles', () => {
    const h = new Harness();
    h.triaged(h.poll(issue('7'))[0], 'dev:question');
    h.act({ type: 'mark-done', workItemId: 1 });
    const sessionId = h.started(h.act({ type: 'adhoc', prompt: 'Publish the prepared fix', repoRoot: 'D:/repo', start: true })[0]);
    h.act({ type: 'handled', sessionId, source: 'github', sourceKey: '7', ref: '#7', title: 'Fix', url: 'https://github.com/acme/widgets/issues/7', key: 'issue:assignment-1', release: false, assigned: true });

    expect(h.send({ type: 'reopen', workItemId: 1 }).refused).toBe("Another session handles the ticket's assignment.");
    expect(h.status(1)).toBe('done');
  });

  it('reopens a work item whose approval was never approved as awaiting it, holding it through a turn', () => {
    const h = new Harness();
    const { item, session } = running(h);
    h.report(session, { kind: 'approval', prompt: '/support-release #1', summary: 'release', report: null });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });

    // As zoho 444953 did: the operator asks the session more, and a poll that omits the ticket ends the work item when the turn ends.
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    h.poll();
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'unassigned', approvalPrompt: '/support-release #1' });

    h.act({ type: 'reopen', workItemId: item });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalHeld: false });

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'running', approvalHeld: true });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item).status).toBe('awaiting-approval');

    // Reopened mid-turn, the work item runs holding the approval, which its turn end restores.
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    h.act({ type: 'mark-done', workItemId: item });
    h.act({ type: 'reopen', workItemId: item });
    expect(h.item(item)).toMatchObject({ status: 'running', approvalHeld: true });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item).status).toBe('awaiting-approval');
  });

  it('reopens an approved run that reported done as finished, so Approve is not offered again', () => {
    const h = new Harness();
    const { item, session } = running(h);
    h.report(session, { kind: 'approval', prompt: '/publish', summary: null, report: null });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });
    const approved = h.started(only(h.act({ type: 'approve', workItemId: item }), 'start-session'));
    h.report(approved, { kind: 'done' });
    h.act({ type: 'marker', sessionId: approved, state: 'idle', detail: null });

    h.act({ type: 'reopen', workItemId: item });
    expect(h.item(item)).toMatchObject({ status: 'finished', approvalHeld: false, approvalPrompt: '/publish' });
  });

  it('reopens a session that reported approval and then done as finished, because its done report covers the publication', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'dev:both': { description: 'Both', reports: ['done', 'approval'], template: 'Do {{ticket.sourceKey}}.' } }) });
    const { item, session } = running(h, '1', 'dev:both');
    expect(h.report(session, { kind: 'approval', prompt: '/publish', summary: null, report: null }).refused).toBeNull();
    expect(h.item(item).status).toBe('awaiting-approval');
    expect(h.report(session, { kind: 'done' }).refused).toBeNull();
    expect(h.item(item)).toMatchObject({ status: 'done', approvalHeld: false });

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'reopen', workItemId: item });
    expect(h.item(item).status).toBe('finished');
  });

  it('reopens as finished when a done report after an approval is settled by the ticket leaving', () => {
    const h = new Harness({ playbooks: playbooks(undefined, BOTH) });
    const { item, session } = running(h, '1', 'dev:both');
    h.report(session, { kind: 'approval', prompt: '/publish', summary: null, report: null });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'running', approvalHeld: true });

    // The resumed session reports done while the read still lists the ticket, and the next poll settles it.
    h.report(session, { kind: 'done', assigned: true });
    h.poll();
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'unassigned', approvalHeld: false });

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'reopen', workItemId: item });
    expect(h.item(item).status).toBe('finished');
  });

  it('reopens an approved run marked done before it started as awaiting approval', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 } }) });
    const { item, session } = running(h);
    h.report(session, { kind: 'approval', prompt: '/publish', summary: null, report: null });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });
    // Another work item holds the only slot, so the approved run waits.
    running(h, '2');
    expect(h.act({ type: 'approve', workItemId: item })).toEqual([]);
    expect(h.item(item).status).toBe('queued');

    h.act({ type: 'mark-done', workItemId: item });
    expect(h.item(item)).toMatchObject({ status: 'done', approvalHeld: true });
    h.act({ type: 'reopen', workItemId: item });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalHeld: false });
  });

  it('refuses to reopen an open work item or one its ticket has moved past', () => {
    const h = new Harness();
    const { item } = running(h);

    expect(h.send({ type: 'reopen', workItemId: item }).refused).toBe('The work item is not done.');
    expect(h.send({ type: 'reopen', workItemId: 99 }).refused).toBe('Unknown work item 99.');

    h.act({ type: 'mark-done', workItemId: item });
    h.poll();
    const [triage] = h.poll(issue('1'));
    const next = (triage as Extract<FlowAction, { type: 'triage' }>).workItemId!;
    expect(next).not.toBe(item);

    const refused = 'Only the latest work item of a ticket with no open work item can be reopened.';
    expect(h.send({ type: 'reopen', workItemId: item }).refused).toBe(refused);
    expect(h.item(item).status).toBe('done');

    h.act({ type: 'mark-done', workItemId: next });
    expect(h.send({ type: 'reopen', workItemId: item }).refused).toBe(refused);
    expect(h.send({ type: 'reopen', workItemId: next }).refused).toBeNull();
  });
});

describe('stop', () => {
  it('blocks the work item once the stop succeeds, and keeps the session stoppable when it fails', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);

    expect(h.act({ type: 'stop', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12345', reason: 'operator' }]);
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

    expect(h.act({ type: 'marker', sessionId: setup, state: 'idle', detail: null })).toEqual([{ type: 'stop-session', sessionId: setup, provider: 'claude', shortId: 'abc12345', reason: 'release' }]);

    const task = only(h.act({ type: 'stop-succeeded', sessionId: setup, reason: 'release' }), 'start-session');

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

  it('fails when the setup session ends without a worktree, and Triage again starts a new setup', () => {
    const h = new Harness();
    const setup = toSetup(h);

    h.act({ type: 'roster', sessions: [] });
    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'Setup ended without a worktree.' });

    const again = only(h.triaged(only(h.act({ type: 'retriage', workItemId: 1 }), 'triage'), 'dev:develop'), 'start-session');
    expect(again).toMatchObject({ kind: 'setup', sessionId: 's2' });
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

    const again = h.started(only(h.triaged(only(h.act({ type: 'retriage', workItemId: 1 }), 'triage'), 'dev:develop'), 'start-session'));
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

    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'sources.github.setupPrompt is not set.' });

    h.settings.sources['github']!.setupPrompt = '/init {{worktree}}';
    h.triaged(only(h.act({ type: 'retriage', workItemId: 1 }), 'triage'), 'dev:develop');
    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'sources.github.setupPrompt: Unknown template variable: worktree.' });
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

describe('limits and the one-session-in-a-turn rule', () => {
  it('ends only the sessions a roster read looked for, so a start confirmed during the read survives it', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const session = h.started(only(h.triaged(triage, 'support:defect'), 'start-session'));

    expect(h.act({ type: 'roster', sessions: [], checked: [] })).toEqual([]);
    expect(h.store.session(session)!.state).toBe('running');

    h.act({ type: 'roster', sessions: [], checked: [session] });
    expect(h.store.session(session)!.state).toBe('ended');
  });

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

  it('frees the slot of a task session whose turn ended while the operator keeps it open, and takes it back when it runs again', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'), issue('3'));
    const first = h.started(only(h.triaged(triages[0], 'support:defect'), 'start-session'));
    h.triaged(triages[1], 'support:defect');
    h.triaged(triages[2], 'support:defect');

    const interactive = [{ sessionId: first, state: 'idle' as const, detail: null, interactive: true }];
    const second = only(h.act({ type: 'roster', sessions: interactive }), 'start-session');
    expect(second.workItemId).toBe(2);
    h.started(second);

    // The operator resumes the first session, so it takes a slot again while the second session ends.
    h.act({ type: 'marker', sessionId: first, state: 'running', detail: null });
    expect(h.act({ type: 'roster', sessions: [{ sessionId: first, state: 'running', detail: null, interactive: true }] })).toEqual([]);
    expect([1, 2, 3].map((id) => h.status(id))).toEqual(['running', 'blocked', 'queued']);

    const third = only(h.act({ type: 'marker', sessionId: first, state: 'failed', detail: 'api' }), 'start-session');
    expect(third.workItemId).toBe(3);
  });

  it('frees the slot of a live session whose work item is done or whose ticket is snoozed', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'), issue('3'));
    const first = h.started(only(h.triaged(triages[0], 'support:defect'), 'start-session'));
    h.triaged(triages[1], 'support:defect');
    h.triaged(triages[2], 'support:defect');

    const second = h.started(only(h.report(first, { kind: 'done' }).actions, 'start-session'));
    expect(h.status(1)).toBe('done');
    expect(h.store.session(first)!.state).not.toBe('ended');

    expect(only(h.act({ type: 'snooze', ticketId: 2, until: null }), 'start-session').workItemId).toBe(3);
    expect(h.store.session(second)!.state).not.toBe('ended');
  });

  it('frees the slot when an approval report moves the work item to Ready for review while its session stays live', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'));
    h.triaged(triages[0], 'dev:question');
    const first = h.started(h.act({ type: 'start', workItemId: 1 })[0]);
    h.triaged(triages[1], 'support:defect');

    expect(h.status(2)).toBe('queued');
    const report = h.send({ type: 'report', sessionId: first, report: { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: null } });
    expect(only(report.actions, 'start-session').workItemId).toBe(2);
    expect(h.status(1)).toBe('awaiting-approval');
  });

  it('keeps the slot of a setup session whose turn ended until its task starts', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'));
    const setup = h.started(only(h.triaged(triages[0], 'dev:develop'), 'start-session'));
    h.triaged(triages[1], 'support:defect');

    h.report(setup, { kind: 'worktree', path: 'D:/wt/1', branch: null });
    h.report(setup, { kind: 'done' });
    expect(only(h.act({ type: 'marker', sessionId: setup, state: 'idle', detail: null }), 'stop-session').sessionId).toBe(setup);

    const task = only(h.act({ type: 'stop-succeeded', sessionId: setup, reason: 'release' }), 'start-session');
    expect(task).toMatchObject({ workItemId: 1, kind: 'task' });
    expect(h.status(2)).toBe('queued');
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

  it('holds a reassigned ticket’s new work item while the done work item’s session is still in its turn', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const session = h.started(only(h.triaged(triage, 'support:defect'), 'start-session'));

    h.report(session, { kind: 'done' });
    h.poll();
    const [again] = h.poll(issue('1'));
    expect(h.triaged(again, 'support:defect')).toEqual([]);
    expect(h.status(2)).toBe('queued');

    // The turn's end starts it, before the release stops the earlier session.
    const actions = h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(actions.find((action) => action.type === 'start-session')).toMatchObject({ workItemId: 2 });
  });

  it('finishes a deferred unassignment without a warning when the session ends its turn, fails to start, or is stopped', () => {
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

      expect({ name, ...h.item(1) }).toMatchObject({ name, status: 'done', doneReason: 'unassigned', warning: null });
    }
  });

  it('finishes a deferred unassignment without a warning when a setup session ends', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const setup = h.started(only(h.triaged(triage, 'dev:develop'), 'start-session'));

    h.report(setup, { kind: 'worktree', path: 'D:/wt/1', branch: null });
    h.poll();
    expect(h.act({ type: 'roster', sessions: [] })).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'done', doneReason: 'unassigned', warning: null });
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
    expect(h.send({ type: 'approve', workItemId: 7 }).refused).toBe('Unknown work item 7.');
  });

  it('fails a start whose playbook is no longer loaded or does not render', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'dev:bad': { description: 'Bad', template: 'Use {{nope}}.' } }) });
    const triages = h.poll(issue('1'), issue('2'));
    h.triaged(triages[0], 'dev:question');
    h.triaged(triages[1], 'dev:bad');

    h.playbooks.delete('dev:question');
    h.act({ type: 'start', workItemId: 1 });
    h.act({ type: 'start', workItemId: 2 });

    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'Playbook dev:question is not loaded.' });
    expect(h.item(2)).toMatchObject({ status: 'failed', error: 'Playbook dev:bad: Unknown template variable: nope.' });
  });
});

describe('ad-hoc', () => {
  it('starts the typed prompt in the chosen repo as the operator when asked to, numbering tickets locally', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 } }) });
    const start = only(h.act({ type: 'adhoc', prompt: '  Write hello.txt\nthen report done', repoRoot: 'D:/scratch', start: true }), 'start-session');

    expect(start).toEqual({
      type: 'start-session',
      provider: 'claude',
      sessionId: 's1',
      workItemId: 1,
      kind: 'task',
      cwd: 'D:/scratch',
      prompt: '  Write hello.txt\nthen report done',
      contract: CONTRACT('s1', ['stage', 'worktree', 'done', 'approval', 'link', 'paste', 'task']),
      name: 'switchboard · ad-hoc · adhoc 1',
      permissionMode: 'auto',
      model: null,
    });
    expect(h.store.ticket(1)).toMatchObject({ source: 'adhoc', sourceKey: '1', title: 'Write hello.txt', repoRoot: 'D:/scratch' });
    expect(h.item(1)).toMatchObject({ playbook: null, taskPrompt: '  Write hello.txt\nthen report done', status: 'running' });

    h.act({ type: 'adhoc', prompt: 'Second', repoRoot: 'D:/scratch', start: true });
    expect(h.store.ticket(2)).toMatchObject({ sourceKey: '2', ref: '#2' });
    expect(h.status(2)).toBe('queued');

    expect(h.send({ type: 'retriage', workItemId: 1 }).refused).toBe('The work item has an active session.');
    expect(h.send({ type: 'retriage', workItemId: 2 }).refused).toBe('An ad-hoc work item is not triaged.');
  });

  it('leaves the work item unstarted until Start when not asked to start', () => {
    const h = new Harness();

    expect(h.act({ type: 'adhoc', prompt: 'Write hello.txt', repoRoot: 'D:/scratch' })).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'unstarted', queuedAt: null, runStartedAt: null, taskPrompt: 'Write hello.txt' });

    const start = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    expect(start).toMatchObject({ workItemId: 1, kind: 'task', cwd: 'D:/scratch', prompt: 'Write hello.txt' });
    expect(h.status(1)).toBe('running');
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

    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'sources.github.repoRoot is not set.' });
  });
});

describe('task reports (PRD R68)', () => {
  /** Runs GitHub issue 18941 under dev:question, whose playbook lists no task report. */
  function parent(h: Harness): { item: number; session: string } {
    const [triage] = h.poll(issue('18941'));
    h.triaged(triage, 'dev:question');
    const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);

    return { item: 1, session };
  }

  it('creates an unstarted ad-hoc work item in the reporting ticket repo, titled by the first line, and Start runs the prompt there', () => {
    const h = new Harness();
    const { item, session } = parent(h);
    const prompt = '  Fix the flaky CartTests\nin D:/git/widgets/Test/CartTests.cs';

    h.now += MINUTE;
    expect(h.report(session, { kind: 'task', prompt, repo: null, title: null })).toEqual({ actions: [], refused: null });
    expect(h.store.ticket(2)).toMatchObject({ source: 'adhoc', sourceKey: '1', ref: '#1', title: 'Fix the flaky CartTests', url: '', assigned: true, repoRoot: 'D:/git/widgets', scopeAt: T0 + MINUTE });
    expect(h.item(2)).toMatchObject({ ticketId: 2, playbook: null, status: 'unstarted', taskPrompt: prompt, parentId: item, queuedAt: null, runStartedAt: null, statusAt: T0 + MINUTE });
    expect(h.item(item)).toMatchObject({ status: 'running', parentId: null });

    const start = only(h.act({ type: 'start', workItemId: 2 }), 'start-session');

    expect(start).toEqual({
      type: 'start-session',
      provider: 'claude',
      sessionId: 's2',
      workItemId: 2,
      kind: 'task',
      cwd: 'D:/git/widgets',
      prompt,
      contract: CONTRACT('s2', ['stage', 'worktree', 'done', 'approval', 'link', 'paste', 'task']),
      name: 'switchboard · ad-hoc · adhoc 1',
      permissionMode: 'auto',
      model: null,
    });
    expect(h.item(2)).toMatchObject({ status: 'running', runStartedAt: T0 + MINUTE });
  });

  it('takes a configured repo in any spelling and a title, adds nothing for a repeat while the first is open, and accepts a report after the parent is done', () => {
    const h = new Harness();
    const { item, session } = parent(h);
    const report = { kind: 'task', prompt: 'Write the Support runbook', repo: 'd:\\GIT\\support\\', title: ' Runbook ' } as const;

    h.report(session, report);
    expect(h.store.ticket(2)).toMatchObject({ title: 'Runbook', repoRoot: 'D:/git/support' });

    h.report(session, report);
    expect(h.store.tickets('adhoc')).toHaveLength(1);

    h.act({ type: 'mark-done', workItemId: 2 });
    h.act({ type: 'mark-done', workItemId: item });
    h.report(session, { ...report, title: '' });
    expect(h.store.ticket(3)).toMatchObject({ title: 'Write the Support runbook', repoRoot: 'D:/git/support' });
    expect(h.item(3)).toMatchObject({ status: 'unstarted', parentId: item });
  });

  it('refuses an empty prompt and a repo that is not a configured repo root', () => {
    const h = new Harness();
    const { session } = parent(h);

    expect(h.report(session, { kind: 'task', prompt: ' \n ', repo: null, title: 'x' }).refused).toBe('The prompt is empty.');
    expect(h.report(session, { kind: 'task', prompt: 'Do it', repo: 'D:/git/other', title: null }).refused).toBe('D:/git/other is not a configured repo root. Repo roots: D:/git/widgets, D:/git/support.');

    h.settings.sources['github']!.repoRoot = '';
    expect(h.report(session, { kind: 'task', prompt: 'Do it', repo: null, title: null }).refused).toBe('Name a repo with --repo. Repo roots: D:/git/support.');
    expect(h.store.tickets('adhoc')).toEqual([]);
  });
});

describe('registered sessions (PRD R81)', () => {
  const NATIVE = '9273f594-1111-4222-8333-444455556666';
  const register = (h: Harness, title = ' Fix the badge ') => h.send({ type: 'register', nativeSessionId: NATIVE, shortId: '9273f594', cwd: 'D:/git/widgets.worktrees/18941', title });

  it('creates a running ad-hoc work item in the session directory, whose session is released, external and offered the ad-hoc reports', () => {
    const h = new Harness();

    expect(register(h)).toEqual({ actions: [], refused: null });
    expect(h.store.ticket(1)).toMatchObject({ source: 'adhoc', sourceKey: '1', ref: '#1', title: 'Fix the badge', url: '', assigned: true, repoRoot: 'D:/git/widgets.worktrees/18941', scopeAt: T0 });
    expect(h.item(1)).toMatchObject({ ticketId: 1, playbook: null, status: 'running', taskPrompt: null, queuedAt: null, runStartedAt: T0, statusAt: T0, parentId: null });
    expect(h.store.sessionsFor(1)).toEqual([
      expect.objectContaining({ id: 's1', kind: 'task', provider: 'claude', nativeSessionId: NATIVE, shortId: '9273f594', cwd: 'D:/git/widgets.worktrees/18941', state: 'running', released: true, releasing: false, external: true, reports: ['stage', 'worktree', 'done', 'approval', 'link', 'paste', 'task'] }),
    ]);
    expect(h.store.ticketHistory(1)!.events.map((event) => [event.type, event.actor, event.detail])).toEqual([['register', 'operator', { cwd: 'D:/git/widgets.worktrees/18941' }]]);
  });

  it('ends a turn without a done report as an ad-hoc session does, with no release stop, and stays external until its process ends', () => {
    const h = new Harness();
    register(h);

    expect(h.act({ type: 'roster', sessions: [{ sessionId: 's1', state: 'idle', detail: null, interactive: true }] })).toEqual([]);
    expect(h.item(1)).toMatchObject({ status: 'blocked', error: MESSAGES.turnEnded });
    expect(h.store.session('s1')).toMatchObject({ state: 'idle', external: true });

    h.act({ type: 'roster', sessions: [] });
    expect(h.store.session('s1')).toMatchObject({ state: 'ended', external: false });
  });

  it('refuses Stop, because the session runs in the operator window', () => {
    const h = new Harness();
    register(h);

    expect(h.send({ type: 'stop', workItemId: 1 })).toEqual({ actions: [], refused: 'The session runs in your own window; stop it there.' });
  });

  it('is done by its done report', () => {
    const h = new Harness();
    register(h);

    expect(h.report('s1', { kind: 'done' }).refused).toBeNull();
    expect(h.item(1)).toMatchObject({ status: 'done', doneReason: 'session' });
  });

  it('refuses an empty title, a session already registered, and a copy a fork retired', () => {
    const h = new Harness();

    expect(register(h, ' ').refused).toBe('The title is empty.');
    expect(h.store.tickets('adhoc')).toEqual([]);

    register(h);
    expect(register(h).refused).toBe('This session is already in Switchboard as adhoc 1.');

    h.store.updateSession('s1', { nativeSessionId: 'aa2285b2-0000-4000-8000-000000000000', retiredIds: [NATIVE] });
    expect(register(h).refused).toBe('This session is already in Switchboard as adhoc 1.');
    expect(h.store.tickets('adhoc')).toHaveLength(1);
  });
});

describe('ticket reports (PRD R83)', () => {
  const NATIVE = '9273f594-1111-4222-8333-444455556666';
  const URL = 'https://github.com/acme/widgets/issues/115';
  const AD_HOC_REPORTS = ['stage', 'worktree', 'done', 'approval', 'link', 'paste', 'task'];
  const register = (h: Harness) => h.send({ type: 'register', nativeSessionId: NATIVE, shortId: '9273f594', cwd: 'D:/git/widgets.worktrees/115', title: 'Explore snapshots' });
  const move = (h: Harness, playbook: string | null = 'dev:develop', sessionId = 's1') => h.send({ type: 'ticket', sessionId, source: 'github', sourceKey: '115', ref: '#115', title: 'Issue 115', url: URL, playbook });
  const harness = () => {
    const h = new Harness();
    h.settings.sources['github']!.namespace = 'dev';
    return h;
  };
  /** The ad-hoc ticket as it stands, to show a refusal changed nothing. */
  const unmoved = { source: 'adhoc', sourceKey: '1', ref: '#1', title: 'Explore snapshots', url: '', assigned: true, adhocKey: null };

  it("moves a registered session's work item onto the issue in place, out of the assigned state, and gives the session the playbook's reports", () => {
    const h = harness();
    register(h);

    expect(move(h)).toEqual({ actions: [], refused: null });
    expect(h.store.ticket(1)).toMatchObject({ source: 'github', sourceKey: '115', ref: '#115', sourceId: null, title: 'Issue 115', url: URL, assigned: false, pool: false, repoRoot: 'D:/git/widgets.worktrees/115', adhocKey: '1', scopeAt: T0 });
    expect(h.store.findTicket('adhoc', '1')).toBeNull();
    expect(h.item(1)).toMatchObject({ ticketId: 1, playbook: 'dev:develop', status: 'running' });
    expect(h.store.session('s1')!.reports).toEqual(FINISHING_REPORTS);
    expect(h.store.ticketHistory(1)!.events.map((event) => [event.type, event.actor, event.detail])).toEqual([
      ['register', 'operator', { cwd: 'D:/git/widgets.worktrees/115' }],
      ['ticket', 'session', { source: 'github', sourceKey: '115', playbook: 'dev:develop', adhocKey: '1' }],
    ]);
  });

  it('creates no second work item when the issue enters the assigned state, and a retry changes nothing', () => {
    const h = harness();
    register(h);
    move(h);

    expect(h.poll(issue('115'))).toEqual([]);
    expect(h.store.ticket(1)).toMatchObject({ assigned: true, adhocKey: '1' });
    expect(h.store.workItemsForTicket(1)).toHaveLength(1);
    expect(move(h, 'dev:question')).toEqual({ actions: [], refused: null });
    expect(h.store.workItemsForTicket(1)).toHaveLength(1);
    expect(h.store.ticket(1)).toMatchObject({ source: 'github', sourceKey: '115', assigned: true, adhocKey: '1' });
    expect(h.item(1)).toMatchObject({ playbook: 'dev:develop' });
    expect(h.store.session('s1')!.reports).toEqual(FINISHING_REPORTS);
  });

  it("keeps a started session's reports, because its contract is in its system prompt, and keeps the ad-hoc work item unplaybooked without --playbook", () => {
    const h = harness();
    h.act({ type: 'adhoc', prompt: 'Explore snapshots', repoRoot: 'D:/git/widgets', start: true });

    expect(move(h).refused).toBeNull();
    expect(h.item(1)).toMatchObject({ playbook: 'dev:develop', taskPrompt: 'Explore snapshots' });
    expect(h.store.session('s1')!.reports).toEqual(AD_HOC_REPORTS);

    const g = harness();
    register(g);
    expect(move(g, null).refused).toBeNull();
    expect(g.item(1)).toMatchObject({ playbook: null });
    expect(g.store.session('s1')!.reports).toEqual(AD_HOC_REPORTS);
  });

  it('takes the place of a ticket a poll stored with nothing on it, and refuses one with a work item', () => {
    const h = harness();
    // The issue is assigned on a status outside scope, so the poll stores a ticket with no work item.
    h.poll(issue('115', false));
    register(h);

    expect(move(h).refused).toBeNull();
    expect(h.store.findTicket('github', '115')).toMatchObject({ id: 2, adhocKey: '1' });
    expect(h.store.ticket(1)).toBeNull();

    const g = harness();
    g.poll(issue('115'));
    register(g);
    expect(move(g).refused).toBe('Switchboard already has github 115.');
    expect(g.store.ticket(2)).toMatchObject(unmoved);
  });

  it('refuses an unknown playbook, one outside the namespace, a work item that is not ad-hoc, a done one, and an earlier session, changing nothing', () => {
    const h = harness();
    register(h);

    expect(move(h, 'dev:gone').refused).toBe('dev:gone is not a task playbook in the dev namespace.');
    expect(move(h, 'support:defect').refused).toBe('support:defect is not a task playbook in the dev namespace.');
    expect(move(h, 'triage:github').refused).toBe('triage:github is not a task playbook in the dev namespace.');
    expect(h.store.ticket(1)).toMatchObject(unmoved);
    expect(h.store.session('s1')!.reports).toEqual(AD_HOC_REPORTS);

    h.report('s1', { kind: 'done' });
    expect(move(h).refused).toBe('The work item is done.');

    const g = harness();
    const [triage] = g.poll(issue('20'));
    g.triaged(triage, 'dev:question');
    const session = g.started(g.act({ type: 'start', workItemId: 1 })[0]);
    expect(move(g, null, session).refused).toBe('Only an ad-hoc or registered work item can move to a ticket.');

    const k = harness();
    const first = k.started(only(k.act({ type: 'adhoc', prompt: 'Explore snapshots', repoRoot: 'D:/git/widgets', start: true }), 'start-session'));
    // Approve starts a second session, the work item's latest.
    k.report(first, { kind: 'approval', prompt: '/ship', summary: null, report: null });
    k.act({ type: 'marker', sessionId: first, state: 'idle', detail: null });
    k.act({ type: 'stop-succeeded', sessionId: first, reason: 'release' });
    k.started(only(k.act({ type: 'approve', workItemId: 1 }), 'start-session'));
    expect(k.store.sessionsFor(1)).toHaveLength(2);
    expect(move(k, null, first).refused).toBe("Only the work item's latest session can move it to a ticket.");
  });

  it('never gives a moved ad-hoc key to a new ad-hoc ticket, and offers Triage again once the session ends', () => {
    const h = harness();
    register(h);
    move(h);
    h.act({ type: 'adhoc', prompt: 'Second', repoRoot: 'D:/git/widgets' });

    expect(h.store.ticket(2)).toMatchObject({ source: 'adhoc', sourceKey: '2' });

    h.act({ type: 'roster', sessions: [] });
    expect(h.send({ type: 'retriage', workItemId: 1 }).refused).toBeNull();
    expect(h.item(1)).toMatchObject({ status: 'triaging' });
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
    h.act({ type: 'mark-done', workItemId: 1 });
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
    h.triaged(only(h.act({ type: 'retriage', workItemId: 1 }), 'triage'), 'dev:question');
    expect(h.item(1)).toMatchObject({ status: 'unstarted', statusAt: T0 + 5_000, runStartedAt: T0 + 2_000 });

    h.now = T0 + 6_000;
    h.act({ type: 'start', workItemId: 1 });
    expect(h.item(1)).toMatchObject({ status: 'running', statusAt: T0 + 6_000, runStartedAt: T0 + 6_000 });
  });

  it('starts the run clock when a queued work item starts, not when it was queued', () => {
    const h = new Harness({ settings: settings({ sessions: { concurrency: 1 }, triage: { concurrency: 4 } }) });
    const triages = h.poll(issue('1'), issue('2'));
    h.started(only(h.triaged(triages[0], 'support:defect'), 'start-session'));
    h.triaged(triages[1], 'support:defect');
    expect(h.status(2)).toBe('queued');

    h.now = T0 + 9_000;
    only(h.act({ type: 'roster', sessions: [] }), 'start-session');
    expect(h.item(2)).toMatchObject({ status: 'running', runStartedAt: T0 + 9_000 });
  });
});

describe('agents (PRD R22)', () => {
  it("runs a Codex playbook's sessions in Codex, with Codex's defaults and contract, and its stops name Codex", () => {
    const h = new Harness({ settings: settings({ sessions: { codex: { permissionMode: 'dontAsk', model: 'gpt-6' } } }), playbooks: playbooks(['triage:github'], { 'dev:codex': { description: 'Build it in Codex', provider: 'codex', template: '/sb-plan {{ticket.sourceKey}}' } }) });
    const [triage] = h.poll(issue('1'));

    h.triaged(triage, 'dev:codex');
    const start = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    expect(start).toMatchObject({ provider: 'codex', permissionMode: 'dontAsk', model: 'gpt-6', prompt: '/sb-plan 1' });
    expect(start.contract).toContain('report question s1 --text <question>');
    expect(start.contract).not.toContain('AskUserQuestion');
    expect(h.store.session('s1')).toMatchObject({ provider: 'codex' });

    h.started(start);
    expect(h.act({ type: 'stop', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: 's1', provider: 'codex', shortId: 'abc12345', reason: 'operator' }]);
  });

  it("takes sessions.provider for a playbook that names none and for an ad-hoc prompt, and a playbook's own mode and model over the provider's", () => {
    const h = new Harness({ settings: settings({ sessions: { provider: 'codex' } }), playbooks: playbooks(['triage:github', 'dev:question']) });

    const adhoc = only(h.act({ type: 'adhoc', prompt: 'Fix it', repoRoot: 'D:/git/widgets', start: true }), 'start-session');

    expect(adhoc).toMatchObject({ provider: 'codex', permissionMode: 'bypassPermissions', model: null });

    const [triage] = h.poll(issue('2'));

    h.triaged(triage, 'dev:question');
    expect(only(h.act({ type: 'start', workItemId: 2 }), 'start-session')).toMatchObject({ provider: 'codex', permissionMode: 'plan', model: 'opus' });
  });

  it("runs a Codex playbook's setup session in Codex too, and a Claude playbook stays in Claude when the default is Codex", () => {
    const h = new Harness({
      settings: settings({ sessions: { provider: 'codex' } }),
      playbooks: playbooks(['triage:github'], {
        'dev:build': { description: 'Build', provider: 'codex', autoStart: true, requiresWorktree: true, template: 'Build.' },
        'dev:claude': { description: 'Claude work', provider: 'claude', autoStart: true, template: 'Work.' },
      }),
    });
    const [first, second] = h.poll(issue('1'), issue('2'));

    expect(only(h.triaged(first, 'dev:build'), 'start-session')).toMatchObject({ kind: 'setup', provider: 'codex', prompt: '/init-worktree 1' });
    expect(only(h.triaged(second, 'dev:claude'), 'start-session')).toMatchObject({ kind: 'task', provider: 'claude', permissionMode: 'auto' });
  });
});

describe('release in progress (PRD R39)', () => {
  it('marks a session releasing until its release stop finishes, fails, or the operator is seen running it', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const session = h.started(only(h.triaged(triage, 'support:defect'), 'start-session'));

    expect(h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12345', reason: 'release' }]);
    expect(h.store.session(session)).toMatchObject({ released: true, releasing: true });

    h.act({ type: 'stop-failed', sessionId: session, reason: 'release', message: 'busy' });
    expect(h.store.session(session)).toMatchObject({ releasing: true });

    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'running', detail: null, interactive: true }] });
    expect(h.store.session(session)).toMatchObject({ released: true, releasing: false, state: 'running' });
  });

  it('lets the operator stop or delete a session whose release stop failed, which ends its background process', () => {
    const h = new Harness();
    const [first, second] = h.poll(issue('1'), issue('2'));
    const one = h.started(only(h.triaged(first, 'support:defect'), 'start-session'), 'abc00001');
    const two = h.started(only(h.triaged(second, 'support:defect'), 'start-session'), 'abc00002');

    for (const session of [one, two]) {
      h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
      h.act({ type: 'stop-failed', sessionId: session, reason: 'release', message: 'busy' });
    }

    expect(h.act({ type: 'stop', workItemId: 1 })).toEqual([{ type: 'stop-session', sessionId: one, provider: 'claude', shortId: 'abc00001', reason: 'operator' }]);
    h.act({ type: 'stop-succeeded', sessionId: one, reason: 'operator' });
    expect(h.store.session(one)).toMatchObject({ state: 'ended', releasing: false });
    expect(h.act({ type: 'delete', workItemId: 2 })).toEqual([{ type: 'stop-session', sessionId: two, provider: 'claude', shortId: 'abc00002', reason: 'operator' }]);
  });

  it('clears releasing when the release stop succeeds', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const session = h.started(only(h.triaged(triage, 'support:defect'), 'start-session'));

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });
    expect(h.store.session(session)).toMatchObject({ state: 'ended', releasing: false });
  });
});
