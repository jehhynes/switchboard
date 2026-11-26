import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { MESSAGES, UNCONFIRMED_DONE } from '../src/flow.js';
import { failedAtTriage } from '../src/group.js';
import { heldSlots } from '../src/queue.js';
import { Harness, T0, issue, playbooks, settings } from './flowHarness.js';
import { CONTRACT, QUESTION_REPORTS, FINISH, BOTH, only } from './flowFixtures.js';

describe('sessions', () => {
  it.each([true, false])('sets a pending-start warning and clears only its own warning on failure: %s', matching => {
    const h = new Harness();
    const start = only(h.act({ type: 'adhoc', prompt: 'Do it', repoRoot: 'D:/scratch', start: true }), 'start-session');
    h.act({ type: 'session-start-pending', sessionId: start.sessionId, message: 'Unconfirmed start' });
    expect(h.store.session(start.sessionId)?.stateDetail).toBe('Unconfirmed start');
    expect(h.item(start.workItemId).warning).toBe('Unconfirmed start');
    if (!matching) h.store.updateWorkItem(start.workItemId, { warning: 'Keep this warning' });
    h.act({ type: 'session-start-failed', sessionId: start.sessionId, message: 'Cleared by operator' });
    expect(h.item(start.workItemId).warning).toBe(matching ? null : 'Keep this warning');
    expect(h.store.session(start.sessionId)?.stateDetail).toBeNull();
    h.act({ type: 'session-start-pending', sessionId: start.sessionId, message: 'Stale warning' });
    expect(h.store.session(start.sessionId)?.stateDetail).toBeNull();
    expect(h.item(start.workItemId).warning).toBe(matching ? null : 'Keep this warning');
  });

  function running(h: Harness, key = '1', playbook = 'dev:question'): { item: number; session: string } {
    const [triage] = h.poll(...[...h.store.tickets('github').filter((t) => t.assigned).map((t) => issue(t.sourceKey)), issue(key)]);
    const item = (triage as Extract<FlowAction, { type: 'triage' }>).workItemId!;
    h.triaged(triage, playbook);
    const session = h.started(h.act({ type: 'start', workItemId: item })[0]);

    return { item, session };
  }

  it('finishes the work item on a done report, and keeps the held session between turns until its idle end', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { item, session } = running(h, '1', 'dev:finish');

    expect(h.report(session, { kind: 'done' }).actions).toEqual([]);
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'session', warning: null });

    expect(h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null })).toEqual([]);
    expect(h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null })).toEqual([]);
    expect(h.act({ type: 'marker', sessionId: session, state: 'running', detail: null })).toEqual([]);
    expect(h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null })).toEqual([]);
    expect(h.act({ type: 'held-idle', sessionId: session })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12345', reason: 'release', codeMode: true }]);

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

    expect(h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null })).toEqual([]);
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

  it('ignores a recheck after Mark done', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { item, session } = running(h, '1', 'dev:finish');

    h.report(session, { kind: 'done', assigned: true });
    const token = h.store.session(session)!.outcomeDetail!;
    h.act({ type: 'roster', sessions: [] });
    expect(h.send({ type: 'retry', workItemId: item }).refused).toBe('The work item has not failed.');
    h.act({ type: 'mark-done', workItemId: item });

    h.act({ type: 'done-checked', sessionId: session, token, assigned: true });
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'operator', error: null });
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

    h.act({ type: 'marker', sessionId: b.session, state: 'failed', detail: 'server_error' });
    expect(h.item(b.item)).toMatchObject({ status: 'blocked', error: 'The turn failed: server_error.' });

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

  it('leaves a starting session alone until its start is confirmed', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const start = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    h.act({ type: 'roster', sessions: [] });
    h.act({ type: 'marker', sessionId: start.sessionId, state: 'idle', detail: null });

    expect(h.store.session(start.sessionId)?.state).toBe('starting');
  });

  it("fails a start with Claude's message, and Retry starts a new session with the prompt rendered for it", () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const first = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');

    h.act({ type: 'session-start-failed', sessionId: first.sessionId, message: 'Workspace not trusted' });

    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'Workspace not trusted' });
    expect(h.store.session(first.sessionId)).toMatchObject({ state: 'ended', outcome: 'failed', outcomeDetail: 'Workspace not trusted' });
    expect(h.report(first.sessionId, { kind: 'done' }).refused).toBe('The session failed to start; retry the work item before reporting.');
    expect(h.item(1)).toMatchObject({ status: 'failed', error: 'Workspace not trusted' });

    expect(failedAtTriage({ ...h.item(1), triage: h.store.triagesFor(1).at(-1)! })).toBe(false);
    const second = only(h.act({ type: 'retry', workItemId: 1 }), 'start-session');

    expect(second.sessionId).toBe('s2');
    expect(second).toMatchObject({ prompt: 'Answer Issue 1.\nContext 1', contract: CONTRACT('s2', QUESTION_REPORTS) });

  });

  it('applies only reports from the latest session', () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { item, session } = running(h, '1', 'dev:finish');

    h.now += 10;
    h.report(session, { kind: 'stage', stage: ' Planning ' });
    // A stage report is a headline-only state of the session, seen, and current while its turn runs.
    expect(h.store.workItemState(item)).toMatchObject({ sessionId: session, workItemId: item, replyId: null, headline: 'Planning', body: null, at: T0 + 10, seenAt: T0 + 10, turnEnded: false });
    expect(h.store.session(session)?.turnAt).toBe(h.store.session(session)?.startedAt);
    // An empty one sets nothing.
    h.report(session, { kind: 'stage', stage: '  ' });
    expect(h.store.workItemState(item)?.headline).toBe('Planning');

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'roster', sessions: [] });
    // A failed start that Retry retries gives the work item a new latest session.
    h.store.updateWorkItem(item, { status: 'failed', error: 'The start failed.' });
    const retry = h.started(only(h.act({ type: 'retry', workItemId: item }), 'start-session'));

    h.report(session, { kind: 'done' });
    expect(h.item(item).status).toBe('running');
    expect(h.store.session(session)?.outcome).toBe('done');

    h.report(session, { kind: 'stage', stage: 'Old session' });
    expect(h.store.workItemState(item)?.headline).toBe('Planning');
    // Its turn ended when the session went idle.
    expect(h.store.workItemState(item)?.turnEnded).toBe(true);

    h.report(retry, { kind: 'done' });
    expect(h.item(item).status).toBe('done');
  });

  it("starts a session's turn when it runs again after a turn ended, not when it waits mid-turn", () => {
    const h = new Harness({ playbooks: playbooks(undefined, FINISH) });
    const { session } = running(h, '1', 'dev:finish');
    const started = h.store.session(session)!.turnAt;

    h.now += 10;
    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.store.session(session)?.turnAt).toBe(started);

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.now += 10;
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.store.session(session)?.turnAt).toBe(h.now);
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

    expect(h.act({ type: 'stop', workItemId: item })).toEqual([{ type: 'stop-session', sessionId: session, provider: 'claude', shortId: 'abc12345', reason: 'operator', codeMode: true }]);
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
    expect(h.store.workItemState(item)?.headline).toBe('fixing the rest');

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
    h.act({ type: 'handled', sessionId, source: 'github', sourceKey: '7', ref: '#7', repo: '', title: 'Fix', url: 'https://github.com/acme/widgets/issues/7', key: 'issue:assignment-1', release: false, assigned: true });

    expect(h.send({ type: 'reopen', workItemId: 1 }).refused).toBe("Another session handles the ticket's assignment.");
    expect(h.status(1)).toBe('done');
  });

  it('reopens a work item whose approval was never approved as awaiting it, holding it through a turn', () => {
    const h = new Harness();
    const { item, session } = running(h);
    h.report(session, { kind: 'approval', prompt: '/release-case #1', summary: 'release', report: null });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });

    // As zoho 444953 did: the operator asks the session more, and a poll that omits the ticket ends the work item when the turn ends.
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    h.poll();
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'unassigned', approvalPrompt: '/release-case #1' });

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
