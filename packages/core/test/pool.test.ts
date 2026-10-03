import { describe, expect, it } from 'vitest';
import type { FlowAction, PolledTicket } from '../src/flow.js';
import { Harness, REPORT, T0, playbooks } from './flowHarness.js';

/** A Zoho ticket: in the pool, assigned to the operator, or neither. Its R ref shows that the source, not core, chooses the reference. */
function zoho(key: string, state: 'pool' | 'assigned' | 'neither', sortAt = Number(key)): PolledTicket {
  return { sourceKey: key, ref: `R${key}`, sourceId: `id-${key}`, title: `Case ${key}`, url: `https://desk.example.test/${key}`, assigned: state === 'assigned', pool: state === 'pool', sortAt };
}

function only<T extends FlowAction['type']>(actions: FlowAction[], type: T): Extract<FlowAction, { type: T }> {
  expect(actions).toHaveLength(1);
  expect(actions[0]?.type).toBe(type);
  return actions[0] as Extract<FlowAction, { type: T }>;
}

const pollZoho = (h: Harness, ...tickets: PolledTicket[]) => h.act({ type: 'poll', source: 'zoho', tickets });

const ZOHO_PLAYBOOKS = playbooks(undefined, { 'support:case': '---\ndescription: A Support case\nautoStart: true\nworkdir: repoRoot\n---\n/support-process {{ticket.ref}}' });

describe('pool triage (PRD R47, R50)', () => {
  it('triages a ticket entering the pool, offering only its namespace, stores its rating, and creates no work item', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    const triage = only(pollZoho(h, zoho('500', 'pool'), zoho('501', 'neither')), 'triage');

    expect(triage).toMatchObject({ workItemId: null, systemPrompt: 'Triage the Support case.', choices: [{ name: 'support:defect', description: 'Research a defect' }, { name: 'support:case', description: 'A Support case' }] });
    expect(h.store.workItem(1)).toBeNull();

    h.act({ type: 'triage-succeeded', triageId: triage.triageId, context: 'ctx', playbook: 'support:case', summary: 'Fix the sync — defect', immediacy: 'BLOCKING', severity: 'MED', model: null });

    expect(h.store.poolTriages(1)).toMatchObject([{ ticketId: 1, workItemId: null, playbook: 'support:case', summary: 'Fix the sync — defect', immediacy: 'BLOCKING', severity: 'MED' }]);
    expect(h.store.workItem(1)).toBeNull();
    expect(pollZoho(h, zoho('500', 'pool'))).toEqual([]);
  });

  it('keeps a failed pool triage until Triage again, and runs a cancelled one again', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    const first = only(pollZoho(h, zoho('500', 'pool')), 'triage');

    h.act({ type: 'triage-failed', triageId: first.triageId, error: 'Timed out.', context: null });
    expect(h.store.poolTriages(1)).toMatchObject([{ error: 'Timed out.' }]);
    expect(h.act({ type: 'tick' })).toEqual([]);

    const again = only(h.act({ type: 'retriage-pool', ticketId: 1 }), 'triage');
    expect(h.send({ type: 'retriage-pool', ticketId: 1 }).refused).toBe('Triage is already running.');

    const third = only(h.act({ type: 'triage-cancelled', triageId: again.triageId }), 'triage');
    expect(third.triageId).not.toBe(again.triageId);
  });

  it('fails a pool triage at once when the namespace has no task playbooks', () => {
    const h = new Harness({ playbooks: playbooks(['triage:zoho', 'dev:question']) });

    expect(pollZoho(h, zoho('500', 'pool'))).toEqual([]);
    expect(h.store.poolTriages(1)).toMatchObject([{ error: 'No task playbooks in the support namespace.', endedAt: T0 }]);
  });

  it('drops the pool triage of a ticket that leaves the pool, and triages it again if it returns', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    const triage = only(pollZoho(h, zoho('500', 'pool')), 'triage');
    h.act({ type: 'triage-succeeded', triageId: triage.triageId, context: 'ctx', playbook: 'support:case', summary: 's', immediacy: null, severity: null, model: null });

    pollZoho(h);
    expect(h.store.ticket(1)).toMatchObject({ pool: false, assigned: false });
    expect(h.store.poolTriages(1)).toEqual([]);

    expect(only(pollZoho(h, zoho('500', 'pool')), 'triage').ticket.sourceKey).toBe('500');
  });

  it('lists pool tickets oldest first', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    pollZoho(h, zoho('502', 'pool', 3), zoho('500', 'pool', 1), zoho('501', 'pool', 2), zoho('503', 'neither'));

    expect(h.store.poolTickets().map((ticket) => ticket.sourceKey)).toEqual(['500', '501', '502']);
  });
});

describe('pick (PRD R48)', () => {
  function pooled(h: Harness, key = '500', playbook: string | null = 'support:case'): number {
    const triage = only(pollZoho(h, zoho(key, 'pool')), 'triage');

    if (playbook !== null) {
      h.act({ type: 'triage-succeeded', triageId: triage.triageId, context: 'ctx', playbook, summary: 'A summary.', immediacy: null, severity: null, model: null });
    } else {
      h.act({ type: 'triage-failed', triageId: triage.triageId, error: 'x', context: null });
    }

    return h.store.findTicket('zoho', key)!.id;
  }

  it('creates a work item with the pool triage and runs the pick prompt in the repo root', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    const ticketId = pooled(h);
    const start = only(h.act({ type: 'pick', ticketId }), 'start-session');

    expect(start).toMatchObject({ kind: 'pick', cwd: 'D:/git/support', name: 'switchboard · pick · zoho 500', permissionMode: 'auto', model: null });
    expect(start.prompt.startsWith('Claim case #500, then stop.\n\nSwitchboard session s1 tracks this work.')).toBe(true);
    expect(h.item(1)).toMatchObject({ ticketId, status: 'setup', playbook: 'support:case', needsPick: true });
    expect(h.store.triagesFor(1)).toMatchObject([{ ticketId, workItemId: 1, summary: 'A summary.' }]);
    expect(h.send({ type: 'pick', ticketId }).refused).toBe('The ticket already has a work item.');
  });

  it('continues with the playbook once the pick session reports done and ends, and the claim makes no second work item', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    const ticketId = pooled(h);
    const pick = h.started(only(h.act({ type: 'pick', ticketId }), 'start-session'));

    h.report(pick, { kind: 'done', summary: 'Claimed.' });
    expect(h.item(1).status).toBe('setup');
    expect(pollZoho(h, zoho('500', 'assigned'))).toEqual([]);
    expect(h.store.workItem(2)).toBeNull();

    h.act({ type: 'marker', sessionId: pick, state: 'idle', detail: null });
    const task = only(h.act({ type: 'stop-succeeded', sessionId: pick, reason: 'release' }), 'start-session');

    expect(task).toMatchObject({ kind: 'task', cwd: 'D:/git/support', name: 'switchboard · support:case · zoho 500' });
    expect(task.prompt.startsWith('/support-process R500\n\n')).toBe(true);
    expect(h.item(1)).toMatchObject({ status: 'running', needsPick: false });
  });

  it('starts the task after the pick without Approve, even when the playbook does not auto-start', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'support:case': '---\ndescription: A Support case\nworkdir: repoRoot\n---\n/support-process #{{ticket.sourceKey}}' }) });
    const pick = h.started(only(h.act({ type: 'pick', ticketId: pooled(h) }), 'start-session'));

    h.report(pick, { kind: 'done', summary: null });
    const task = only(h.act({ type: 'roster', sessions: [] }), 'start-session');

    expect(task).toMatchObject({ kind: 'task', name: 'switchboard · support:case · zoho 500' });
    expect(h.item(1)).toMatchObject({ status: 'running', needsPick: false });
  });

  it('starts a picked work item after its triage, and a reopened assigned ticket waits for approval', () => {
    const manual = playbooks(undefined, { 'support:case': '---\ndescription: A Support case\nworkdir: repoRoot\n---\n/support-process #{{ticket.sourceKey}}' });
    const h = new Harness({ playbooks: manual });
    const pick = h.started(only(h.act({ type: 'pick', ticketId: pooled(h, '500', null) }), 'start-session'));

    h.report(pick, { kind: 'done', summary: null });
    const triage = only(h.act({ type: 'roster', sessions: [] }), 'triage');
    const task = only(h.act({ type: 'triage-succeeded', triageId: triage.triageId, context: 'c', playbook: 'support:case', summary: 's', immediacy: null, severity: null, model: null }), 'start-session');
    expect(task.kind).toBe('task');

    const reopened = only(pollZoho(h, zoho('600', 'assigned')), 'triage');
    expect(h.act({ type: 'triage-succeeded', triageId: reopened.triageId, context: 'c', playbook: 'support:case', summary: 's', immediacy: null, severity: null, model: null })).toEqual([]);
    expect(h.item(2).status).toBe('unstarted');
  });

  it('lets a resumed blocked pick finish the claim', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    const pick = h.started(only(h.act({ type: 'pick', ticketId: pooled(h) }), 'start-session'));

    h.report(pick, { kind: 'blocked', reason: 'Needs a hand.' });
    h.act({ type: 'roster', sessions: [{ sessionId: pick, state: 'idle', detail: null }] });
    h.act({ type: 'roster', sessions: [{ sessionId: pick, state: 'running', detail: null }] });
    expect(h.item(1)).toMatchObject({ status: 'setup', error: null });

    h.report(pick, { kind: 'done', summary: null });
    expect(only(h.act({ type: 'roster', sessions: [] }), 'start-session').kind).toBe('task');
  });

  it('triages the work item after the pick when the pool triage has no result', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    const pick = h.started(only(h.act({ type: 'pick', ticketId: pooled(h, '500', null) }), 'start-session'));

    h.report(pick, { kind: 'done', summary: null });
    const triage = only(h.act({ type: 'roster', sessions: [] }), 'triage');

    expect(triage).toMatchObject({ workItemId: 1 });
    expect(h.item(1)).toMatchObject({ status: 'triaging', playbook: null });
  });

  it('blocks on a blocked report or an end without done, and Retry starts a new pick session', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    const first = h.started(only(h.act({ type: 'pick', ticketId: pooled(h) }), 'start-session'));

    h.report(first, { kind: 'blocked', reason: 'Someone else holds the case.' });
    expect(h.item(1)).toMatchObject({ status: 'blocked', failedStep: 'pick', error: 'Someone else holds the case.' });

    h.act({ type: 'roster', sessions: [] });
    const second = only(h.act({ type: 'retry', workItemId: 1 }), 'start-session');
    expect(second).toMatchObject({ kind: 'pick', sessionId: 's2' });

    h.started(second);
    h.act({ type: 'roster', sessions: [] });
    expect(h.item(1)).toMatchObject({ status: 'blocked', failedStep: 'pick', error: 'The pick session ended without a done report.' });
  });

  it('refuses a pick of a ticket not in the pool, and fails a pick without a pick prompt', () => {
    const h = new Harness({ playbooks: ZOHO_PLAYBOOKS });
    pollZoho(h, zoho('501', 'neither'));

    expect(h.send({ type: 'pick', ticketId: 1 }).refused).toBe('The ticket is not in the pool.');
    expect(h.send({ type: 'pick', ticketId: 99 }).refused).toBe('The ticket is not in the pool.');

    h.settings.sources['zoho']!.pickPrompt = '';
    h.act({ type: 'pick', ticketId: pooled(h, '502') });
    expect(h.item(1)).toMatchObject({ status: 'failed', failedStep: 'pick', error: 'sources.zoho.pickPrompt is not set.' });
    expect(REPORT).toContain('hub.js');
  });
});
