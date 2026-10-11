import { describe, expect, it } from 'vitest';
import type { FlowAction, PolledTicket } from '../src/flow.js';
import { HOUR, Harness, REPORT, T0, issue, playbooks } from './flowHarness.js';

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions).toHaveLength(1);
  expect(actions[0]?.type).toBe(type);
  return actions[0] as Extract<FlowAction, { type: T }>;
}

function running(h: Harness): { item: number; session: string } {
  const [triage] = h.poll(issue('1'));
  h.triaged(triage, 'dev:question');
  const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);

  return { item: 1, session };
}

describe('approval reports (PRD R23, R31)', () => {
  it('waits for approval with the prompt, summary and report, and Approve runs that prompt in a new task session', () => {
    const h = new Harness();
    const { item, session } = running(h);

    h.report(session, { kind: 'approval', prompt: '/review-pr pr:123 publish', summary: 'Review ready to post.', report: 'D:\\wt\\review.md' });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalPrompt: '/review-pr pr:123 publish', approvalSummary: 'Review ready to post.', approvalReport: 'D:\\wt\\review.md' });

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item).status).toBe('awaiting-approval');
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });

    const start = only(h.act({ type: 'approve', workItemId: item }), 'start-session');
    expect(start).toMatchObject({ kind: 'task', sessionId: 's2' });
    expect(start.prompt).toBe('/review-pr pr:123 publish');
    expect(start.contract).toMatch(/^Report to Switchboard with these commands:\n- .* stage s2 </);
    expect(h.item(item)).toMatchObject({ status: 'running', approvalPrompt: '/review-pr pr:123 publish' });

    // The playbook offers no done report, but the approved prompt's session finishes the work item with one.
    expect(start.contract).toContain(' done s2, when the work is finished.');
    expect(start.contract).not.toContain(' approval ');
    h.started(start);
    expect(h.report('s2', { kind: 'approval', prompt: '/again', summary: null, report: null }).refused).toBe("This session's report contract does not offer the approval report.");
    expect(h.report('s2', { kind: 'done' }).refused).toBeNull();
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'session' });
  });

  it('drops the pending approval when the work item is triaged again', () => {
    const h = new Harness();
    const { item, session } = running(h);

    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: 'D:\\wt\\review.md' });
    h.act({ type: 'roster', sessions: [] });
    h.act({ type: 'retriage', workItemId: item });
    expect(h.item(item)).toMatchObject({ status: 'triaging', approvalPrompt: null, approvalSummary: null, approvalReport: null });
  });
});

describe('a resumed session after an approval report (PRD R34)', () => {
  const APPROVAL = { approvalPrompt: '/publish', approvalSummary: 'Ready.', approvalReport: 'D:\\wt\\review.md' };
  // dev:question offers approval and done, so a held run can finish either way.
  const harness = () => new Harness({ playbooks: playbooks(undefined, { 'dev:question': '---\ndescription: Answer a question\nreports: approval, done\n---\nAnswer {{ticket.title}}.' }) });

  function awaitingApproval(h: Harness): { item: number; session: string } {
    const run = running(h);

    h.report(run.session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: 'D:\\wt\\review.md' });
    h.act({ type: 'marker', sessionId: run.session, state: 'idle', detail: null });
    h.act({ type: 'stop-succeeded', sessionId: run.session, reason: 'release' });

    return run;
  }

  function resume(h: Harness, session: string): void {
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'running', detail: null, interactive: true }] });
  }

  it('runs in Ready for review with the approval held and Approve refused, then waits for approval again when the turn ends', () => {
    const h = harness();
    const { item, session } = awaitingApproval(h);

    resume(h, session);
    expect(h.item(item)).toMatchObject({ status: 'running', approvalHeld: true, ...APPROVAL });
    expect(h.send({ type: 'approve', workItemId: item }).refused).toBe('The work item is not awaiting approval.');

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalHeld: false, error: null, ...APPROVAL });

    // The resumed session stays open idle in VS Code; Approve runs the held prompt without waiting for it to close (PRD R17).
    expect(only(h.act({ type: 'approve', workItemId: item }), 'start-session').prompt).toBe('/publish');
  });

  it('runs again when the operator answers a question the session asked after its approval report', () => {
    const h = harness();
    const { item, session } = running(h);

    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: 'D:\\wt\\review.md' });
    // The approval turn itself goes on running; an unchanged state does not hold the approval.
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalHeld: false });

    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalHeld: false });

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'running', approvalHeld: true });

    // A permission prompt during the held run keeps the approval held.
    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'running', approvalHeld: true });

    h.act({ type: 'roster', sessions: [] });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalHeld: false, error: null, ...APPROVAL });
  });

  it('waits for approval again with the cause when the held turn fails or the operator stops it', () => {
    const h = harness();
    const { item, session } = awaitingApproval(h);

    resume(h, session);
    h.act({ type: 'marker', sessionId: session, state: 'failed', detail: 'rate_limit' });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', error: 'The turn failed: rate_limit.', ...APPROVAL });

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'running', approvalHeld: true, error: null });
    h.act({ type: 'marker', sessionId: session, state: 'failed', detail: null });
    expect(h.item(item).error).toBe('The turn failed: unknown error.');

    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    h.act({ type: 'stop', workItemId: item });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', error: 'Stopped by you.', ...APPROVAL });
  });

  it('keeps the approval when a background session is stopped after its turn ends', () => {
    const h = harness();
    const { item, session } = running(h);

    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: 'D:\\wt\\review.md' });
    h.act({ type: 'marker', sessionId: session, state: 'waiting', detail: null });
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    h.act({ type: 'stop', workItemId: item });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });

    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', error: 'Stopped by you.', ...APPROVAL });
  });

  it('keeps the approval when the operator stops the session that reported it', () => {
    const h = harness();
    const { item, session } = running(h);

    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: 'D:\\wt\\review.md' });
    h.act({ type: 'stop', workItemId: item });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'operator' });

    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', error: 'Stopped by you.', ...APPROVAL });
  });

  it('takes a new approval or done report from the held run', () => {
    const h = harness();
    const { item, session } = awaitingApproval(h);

    resume(h, session);
    h.report(session, { kind: 'approval', prompt: '/publish v2', summary: 'Revised.', report: null });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', approvalHeld: false, approvalPrompt: '/publish v2', approvalSummary: 'Revised.', approvalReport: null });

    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'marker', sessionId: session, state: 'running', detail: null });
    h.report(session, { kind: 'done' });
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'session' });
  });

  it('keeps a held approval that a done report leaves blocked, never starts it without Approve, and clears it on Triage again', () => {
    const h = harness();
    const { item, session } = awaitingApproval(h);

    resume(h, session);
    h.report(session, { kind: 'done', assigned: true });
    expect(h.item(item)).toMatchObject({ status: 'blocked', approvalHeld: false, ...APPROVAL });
    expect(h.send({ type: 'approve', workItemId: item }).refused).toBe('The work item is not awaiting approval.');

    h.act({ type: 'roster', sessions: [] });
    h.triaged(only(h.act({ type: 'retriage', workItemId: item }), 'triage'), 'dev:question');
    expect(h.item(item)).toMatchObject({ status: 'unstarted', approvalPrompt: null, approvalSummary: null, approvalReport: null });
    expect(only(h.act({ type: 'start', workItemId: item }), 'start-session').prompt).toMatch(/^Answer Issue 1\./);
  });

  it('clears an earlier done outcome, so a held run that ends returns to approval', () => {
    const h = harness();
    const { item, session } = running(h);

    h.report(session, { kind: 'done', assigned: true });
    h.report(session, { kind: 'approval', prompt: '/publish', summary: 'Ready.', report: 'D:\\wt\\review.md' });
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    h.act({ type: 'stop-succeeded', sessionId: session, reason: 'release' });

    resume(h, session);
    expect(h.store.session(session)?.outcome).toBeNull();
    h.act({ type: 'roster', sessions: [] });
    expect(h.item(item)).toMatchObject({ status: 'awaiting-approval', ...APPROVAL });
  });

  it('finishes as unassigned when the ticket leaves during the held run', () => {
    const h = harness();
    const { item, session } = awaitingApproval(h);

    resume(h, session);
    h.poll();
    h.act({ type: 'marker', sessionId: session, state: 'idle', detail: null });
    expect(h.item(item)).toMatchObject({ status: 'done', doneReason: 'unassigned' });
  });

  it('never holds an approval for a blocked work item resumed after Approve', () => {
    const h = harness();
    const { item, session } = awaitingApproval(h);
    const start = only(h.act({ type: 'approve', workItemId: item }), 'start-session');

    h.started(start);
    h.act({ type: 'marker', sessionId: start.sessionId, state: 'idle', detail: null });
    expect(h.item(item).status).toBe('blocked');
    h.act({ type: 'stop-succeeded', sessionId: start.sessionId, reason: 'release' });

    h.act({ type: 'roster', sessions: [{ sessionId: start.sessionId, state: 'running', detail: null }] });
    expect(h.item(item)).toMatchObject({ status: 'running', approvalHeld: false });
    h.act({ type: 'marker', sessionId: start.sessionId, state: 'idle', detail: null });
    expect(h.item(item).status).toBe('blocked');

    // The older approval session is not the latest, so its resume changes nothing.
    h.act({ type: 'roster', sessions: [{ sessionId: session, state: 'running', detail: null }] });
    expect(h.item(item)).toMatchObject({ status: 'blocked', approvalHeld: false });
  });
});

describe('paste reports (PRD R60)', () => {
  const withPaste = () => new Harness({ playbooks: playbooks(undefined, { 'dev:reply': '---\ndescription: Draft a reply\nreports: approval, paste\n---\nDraft the reply.' }) });

  it('offers paste only from a playbook that lists it, and keeps the latest file per label on the work item', () => {
    const h = withPaste();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:reply');
    const start = only(h.act({ type: 'start', workItemId: 1 }), 'start-session');
    const session = h.started(start);

    expect(start.contract).toContain(`- ${REPORT} paste ${session} --label <text> --file <absolute path>, for each drafted text`);
    expect(h.report(session, { kind: 'paste', label: 'Customer reply', file: 'D:\\case\\draft-reply.md' }).refused).toBeNull();
    h.report(session, { kind: 'paste', label: 'Private note', file: 'D:\\case\\private-note.md' });
    h.report(session, { kind: 'paste', label: 'Customer reply', file: 'D:\\case\\draft-reply-2.md' });
    h.report(session, { kind: 'approval', prompt: '/support-release #1', summary: 'Release the case', report: 'D:\\case\\draft-reply-2.md' });

    expect(h.store.pastesFor(1).map(({ label, file }) => [label, file])).toEqual([
      ['Customer reply', 'D:\\case\\draft-reply-2.md'],
      ['Private note', 'D:\\case\\private-note.md'],
    ]);
    expect(h.item(1).status).toBe('awaiting-approval');

    // The approved prompt's session is not offered paste.
    h.act({ type: 'roster', sessions: [] });
    const approved = h.started(h.act({ type: 'approve', workItemId: 1 })[0]);
    expect(h.report(approved, { kind: 'paste', label: 'Customer reply', file: 'D:\\case\\late.md' }).refused).toBe("This session's report contract does not offer the paste report.");

    // An earlier session's paste is not applied, as for its other reports (PRD R45).
    expect(h.report(session, { kind: 'paste', label: 'Customer reply', file: 'D:\\case\\stale.md' }).refused).toBeNull();
    expect(h.store.pastesFor(1)[0]?.file).toBe('D:\\case\\draft-reply-2.md');
  });

  it('refuses paste from a playbook that does not list it', () => {
    const h = withPaste();
    const { session } = running(h);

    expect(h.report(session, { kind: 'paste', label: 'Customer reply', file: 'D:\\case\\draft-reply.md' }).refused).toBe("This session's report contract does not offer the paste report.");
    expect(h.store.pastesFor(1)).toEqual([]);
  });
});

describe('Snoozed (PRD R49)', () => {
  const pool = (key: string): PolledTicket => ({ sourceKey: key, ref: `#${key}`, sourceId: key, title: key, url: '', assigned: false, pool: true, sortAt: 1, enteredAt: null });
  const snoozedTicket = (patch: { source?: string; sourceKey?: string; pool?: boolean; snoozedUntil?: number | null; title?: string; url?: string } = {}) => ({
    source: 'github',
    sourceKey: '1',
    ref: '#1',
    sourceId: null,
    title: 't',
    url: '',
    assigned: false,
    pool: false,
    snoozed: true,
    snoozedUntil: null,
    sortAt: patch.pool ? 1 : null,
    scopeAt: null,
    lastPolledAt: null,
    repoRoot: '',
    ...patch,
  });

  it('holds a snoozed pool ticket from triage until restored', () => {
    const h = new Harness();
    expect(h.send({ type: 'snooze', ticketId: 1, until: null }).refused).toBe('Unknown ticket 1.');
    expect(h.send({ type: 'restore', ticketId: 1 }).refused).toBe('Unknown ticket 1.');
    expect(h.act({ type: 'poll', source: 'zoho', tickets: [pool('500')] })).toHaveLength(1);

    const h2 = new Harness();
    h2.store.insertTicket(snoozedTicket({ source: 'zoho', sourceKey: '501', pool: true }));

    expect(h2.act({ type: 'tick' })).toEqual([]);
    expect(only(h2.act({ type: 'restore', ticketId: 1 }), 'triage').ticket.sourceKey).toBe('501');
    expect(h2.store.ticket(1)).toMatchObject({ snoozed: false, snoozedUntil: null });
  });

  it('holds a snoozed work item from triage and start until restored', () => {
    const h = new Harness();
    h.store.insertTicket(snoozedTicket({ title: 'Issue 1', url: 'u' }));

    expect(h.poll(issue('1'))).toEqual([]);
    expect(h.item(1).status).toBe('triaging');

    const triage = only(h.act({ type: 'restore', ticketId: 1 }), 'triage');
    h.triaged(triage, 'support:defect');
    expect(h.item(1).status).toBe('running');

    h.act({ type: 'snooze', ticketId: 1, until: null });
    expect(h.store.ticket(1)).toMatchObject({ snoozed: true, snoozedUntil: null });
  });

  it('wakes a snoozed pool ticket when its wake time passes, on any event', () => {
    const h = new Harness();
    h.store.insertTicket(snoozedTicket({ source: 'zoho', sourceKey: '501', pool: true, snoozedUntil: T0 + HOUR }));

    h.now = T0 + HOUR - 1;
    expect(h.act({ type: 'tick' })).toEqual([]);
    expect(h.store.ticket(1)).toMatchObject({ snoozed: true, snoozedUntil: T0 + HOUR });

    h.now = T0 + HOUR;
    expect(only(h.act({ type: 'tick' }), 'triage').ticket.sourceKey).toBe('501');
    expect(h.store.ticket(1)).toMatchObject({ snoozed: false, snoozedUntil: null });
  });

  it('wakes a snoozed work item into its queued start when its wake time passes; a second snooze replaces the wake time', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    h.act({ type: 'snooze', ticketId: 1, until: T0 + 2 * HOUR });
    h.act({ type: 'snooze', ticketId: 1, until: T0 + HOUR });
    expect(h.store.ticket(1)).toMatchObject({ snoozed: true, snoozedUntil: T0 + HOUR });

    expect(h.act({ type: 'start', workItemId: 1 })).toEqual([]);
    expect(h.item(1).status).toBe('queued');

    h.now = T0 + HOUR;
    expect(only(h.poll(issue('1')), 'start-session').workItemId).toBe(1);
    expect(h.store.ticket(1)).toMatchObject({ snoozed: false, snoozedUntil: null });
  });

  it('refuses a wake time that has passed and leaves the ticket as it was', () => {
    const h = new Harness();
    h.poll(issue('1'));

    expect(h.send({ type: 'snooze', ticketId: 1, until: T0 }).refused).toBe('The snooze time has passed.');
    expect(h.send({ type: 'snooze', ticketId: 1, until: T0 - 1 }).refused).toBe('The snooze time has passed.');
    expect(h.store.ticket(1)).toMatchObject({ snoozed: false, snoozedUntil: null });
    expect(h.send({ type: 'snooze', ticketId: 1, until: T0 + 1 }).refused).toBeNull();
    expect(h.store.ticket(1)).toMatchObject({ snoozed: true, snoozedUntil: T0 + 1 });
  });

  it('queues the task after setup when the ticket was snoozed meanwhile', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('15619'));
    const setup = h.started(only(h.triaged(triage, 'dev:develop'), 'start-session'));

    h.act({ type: 'snooze', ticketId: 1, until: null });
    h.report(setup, { kind: 'worktree', path: 'D:/wt/1', branch: null });
    expect(h.act({ type: 'roster', sessions: [] })).toEqual([]);
    expect(h.item(1).status).toBe('queued');
    expect(only(h.act({ type: 'restore', ticketId: 1 }), 'start-session').kind).toBe('task');
  });

  it('keeps the work items of a snoozed ticket listed however long ago they were done', () => {
    const h = new Harness();
    h.poll(issue('1'), issue('2'));
    h.act({ type: 'mark-done', workItemId: 1 });
    h.act({ type: 'mark-done', workItemId: 2 });
    h.act({ type: 'snooze', ticketId: 1, until: null });

    expect(h.store.workItems(h.now + 1).map((item) => item.id)).toEqual([1]);
  });

  it('ends the snooze when the ticket leaves the assigned state or the pool, and keeps it while the ticket stays in scope', () => {
    const h = new Harness();
    h.poll(issue('1'), issue('2'), issue('3'));
    h.act({ type: 'poll', source: 'zoho', tickets: [pool('500')] });
    for (const ticketId of [1, 2, 3, 4]) {
      h.act({ type: 'snooze', ticketId, until: T0 + HOUR });
    }

    h.poll(issue('1'), issue('2', false));
    h.act({ type: 'poll', source: 'zoho', tickets: [] });

    expect(h.store.ticket(1)).toMatchObject({ snoozed: true, snoozedUntil: T0 + HOUR });
    for (const ticketId of [2, 3, 4]) {
      expect(h.store.ticket(ticketId)).toMatchObject({ snoozed: false, snoozedUntil: null });
    }
    // Item 2's triage is still running, so its deletion waits for the triage to end; item 3 waited for a triage slot (PRD R10).
    expect(h.item(2)).toMatchObject({ status: 'triaging', unassignedAt: T0 });
    expect(h.store.workItem(3)).toBeNull();
  });

  it('does not start a queued work item of a snoozed ticket', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    h.act({ type: 'snooze', ticketId: 1, until: null });

    expect(h.act({ type: 'start', workItemId: 1 })).toEqual([]);
    expect(h.item(1).status).toBe('queued');
    expect(only(h.act({ type: 'restore', ticketId: 1 }), 'start-session').workItemId).toBe(1);
  });
});
